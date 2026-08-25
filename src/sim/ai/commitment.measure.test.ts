/// <reference types="vite/client" />
import { describe, it } from 'vitest';
import { ARENAS, createWorldFor } from '../arena';
import { step } from '../world';
import { decideAi } from './index';
import {
  lineOfSight,
  dangerAvoidMove,
  incomingThreats,
  estimationError,
  profileHazardSpread,
} from './targeting';
import { roundPhase } from '../round';
import { configFor } from '../config';
import { AI_JITTER_TICKS, AI_MINE_FLEE_RADIUS, DANGER_CORRIDOR } from '../constants';
import { detHypot } from '../math/hypot';
import type { Vec2, Tank } from '../types';
import type { World } from '../world';

// ---------------------------------------------------------------------------
// MEASUREMENT HARNESS, skipped in CI on purpose: per-kind DECISION STABILITY --
// how often an AI's movement intent reverses between adjacent ticks, and how far
// its aim target jumps between adjacent aiming ticks. Issue #222's two headline
// defects ("alternates movement direction on adjacent ticks"; "aim error changes
// read as a stepwise target jump") are exactly these two columns, so this is the
// before/after vehicle for that work.
//
// Deliberately a SIBLING of engagement.measure.test.ts rather than new columns on
// it: that harness's own comment pins its method ("keep stable across sweeps; the
// tables in constants.ts assume it") because its numbers are cited in constants.ts.
// Adding per-tick sampling there would change its cost and invite editing it.
//
// Usage: set VITE_RUN_MEASURE=1, run
//   VITE_RUN_MEASURE=1 npx vitest run src/sim/ai/commitment.measure.test.ts --testTimeout=3600000
// and read the table off the console. No skip to flip back and no risk of a flipped
// skip landing in a commit -- the harness stays gated behind the env var by default,
// and CI's measure.yml workflow sets it deliberately for a chosen harness on demand.
// The pinned CI gates for AI health remain pacifist.test.ts and the golden trace, not
// this.
//
// Read via `import.meta.env`, NOT `process.env`: this file lives under src/sim/, and
// purity.test.ts's FORBIDDEN_GLOBALS bans the bare token "process" anywhere in src/sim/
// (it scans every .ts file there, test files included, for a real host clock that
// walked past the guard once already -- see that file's header). `VITE_` is Vite's
// required prefix for a shell env var to reach `import.meta.env` at all.
//
// Method (keep stable across sweeps):
// 60 fixed seeds per (arena, player policy), the same wandering player as
// pacifist.test.ts on an RNG independent of the sim's, 3-minute cap. Sampled
// EVERY tick (not every 10th, unlike the engagement harness): reversal is a
// per-tick-pair property and decimating it would hide the thing being measured.
// Only 'live' ticks count -- during countdown the dispatcher zeroes desiredMove,
// so an intent sampled there is suppressed, not acted on.
//
// TWO player policies, because the pacifist alone cannot reach the defect: a
// player who never fires produces almost no incoming shells, and the bullet-dodge
// branch of dangerAvoidMove is where the tick-to-tick flipping is expected to
// live. 'pacifist' keeps continuity with the engagement harness's method;
// 'shooter' fires at the nearest enemy whenever its cooldown allows.
// ---------------------------------------------------------------------------

function mulberry(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TICK_CAP = 60 * 60 * 3;
const SEEDS = 60;
const VEC_EPS = 1e-9;

/** Shortest signed angular difference, wrapped to [-PI, PI]. */
function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const deg = (r: number): number => (r * 180) / Math.PI;

interface KindStats {
  /** Adjacent live-tick pairs where both intents were non-zero. */
  pairs: number;
  /** Of those, pairs whose intents point more than 90 degrees apart. */
  reversals: number;
  /** |heading change| per pair, degrees. */
  turns: number[];
  /**
   * |aim-target change| between adjacent ticks that BOTH computed a real solution,
   * split by whether the pair CROSSED an AI_JITTER_TICKS boundary. That split is the
   * point: `aimJitter` redraws only at a boundary, so the contrast between these two
   * columns IS the stepwise-jump defect AC2 names. A single blended percentile cannot
   * show it -- boundaries are 1-in-AI_JITTER_TICKS of all pairs, so they hide at
   * exactly the P95 an unsplit column would report.
   */
  aimStep: number[];
  aimHold: number[];
  /**
   * Reversals bucketed by `prevSource->currSource`, where the source is which branch
   * of decideAi's `avoid ?? seekMove` produced that tick's intent. Without this the
   * reversal percentage says a problem exists but not which mechanism to fix, and the
   * three mechanisms want different remedies: a `bullet->bullet` flip is the dodge
   * perpendicular swapping sides as the tank crosses the shell's axis (hysteresis),
   * while `seek->bullet`/`bullet->seek` is a dodge starting or ending (a hold).
   */
  transitions: Map<string, number>;
  /**
   * Moving-tick OCCUPANCY per source branch -- how much of a tank's moving life is spent
   * dodging bullets, escaping mines, or seeking. Distinct from `transitions`, which counts
   * only the flips: occupancy answers "where does the AI spend its time", which is what
   * attributes a balance shift (e.g. a change in mines laid per game, since the mine gate
   * keys off whether an escape is live) to a mechanism rather than leaving two candidates.
   */
  occupancy: Map<MoveSource, number>;
}

function emptyStats(): KindStats {
  return { pairs: 0, reversals: 0, turns: [], aimStep: [], aimHold: [], transitions: new Map(), occupancy: new Map() };
}

type PlayerPolicy = 'pacifist' | 'shooter';
type MoveSource = 'bullet' | 'mine' | 'seek';

/**
 * Which branch decideAi's `avoid ?? seekMove` took this tick, reproduced with the same
 * exported helpers and the same PERCEIVED radii the decision functions themselves
 * derive (estimationError/profileHazardSpread). A label, never an input to the sim.
 */
function moveSource(w: World, t: Tank): MoveSource {
  const cfg = configFor(t.kind);
  const off = estimationError(w, t, profileHazardSpread(cfg));
  if (dangerAvoidMove(w, t, AI_MINE_FLEE_RADIUS + off, DANGER_CORRIDOR + off) === null) return 'seek';
  return incomingThreats(w, t, DANGER_CORRIDOR + off).length > 0 ? 'bullet' : 'mine';
}

function run(arenaIdx: number, policy: PlayerPolicy): string {
  const stats = new Map<string, KindStats>();
  // Reported so a degenerate policy is visible rather than silent: a row whose games
  // all end in a handful of ticks has too few pairs to mean anything, and that has
  // already happened once here (see the line-of-sight gate below).
  const gameTicks: number[] = [];
  const statsFor = (kind: string): KindStats => {
    let s = stats.get(kind);
    if (!s) { s = emptyStats(); stats.set(kind, s); }
    return s;
  };

  for (let seed = 1; seed <= SEEDS; seed++) {
    let w = createWorldFor(ARENAS[arenaIdx], seed);
    const rnd = mulberry(seed * 7919 + 13);
    let heading = rnd() * Math.PI * 2;
    let ticks = 0;
    // Per-tank carry-over from the previous LIVE tick: the intent, and the aim
    // target if that tick computed a real one (null when the decision merely
    // passed the held turret angle through -- see the aimJumps comment below).
    const prevMove = new Map<number, Vec2 & { src: MoveSource }>();
    const prevAim = new Map<number, number | null>();

    while (w.status === 'playing' && ticks < TICK_CAP) {
      if (ticks % 45 === 0) heading += (rnd() - 0.5) * 2.4;
      const dir = { x: Math.cos(heading), y: Math.sin(heading) };
      const player = w.tanks.find((t) => t.kind === 'player');

      // Sample every enemy's decision for THIS tick, off the pre-step world.
      // decideAi is pure (it reads world/tank and returns a decision; only stepAi
      // writes back), so this observes exactly what stepAi is about to compute.
      if (roundPhase(w) === 'live') {
        for (const t of w.tanks) {
          if (t.kind === 'player' || !t.alive) continue;
          const d = decideAi(w, t);
          const m = d.desiredMove;
          const moving = detHypot(m.x, m.y) > VEC_EPS;
          const pm = prevMove.get(t.id);
          const s = statsFor(t.kind);
          const src = moving ? moveSource(w, t) : null;
          if (src) s.occupancy.set(src, (s.occupancy.get(src) ?? 0) + 1);
          if (moving && pm) {
            s.pairs++;
            const dot = m.x * pm.x + m.y * pm.y;
            // Both are unit-ish headings, so dot < 0 IS "more than 90 degrees
            // apart" -- the reversal AC1 names, not merely a course correction.
            if (dot < 0) {
              s.reversals++;
              const key = `${pm.src}->${src}`;
              s.transitions.set(key, (s.transitions.get(key) ?? 0) + 1);
            }
            s.turns.push(Math.abs(deg(angleDelta(Math.atan2(m.y, m.x), Math.atan2(pm.y, pm.x)))));
          }
          if (moving && src) prevMove.set(t.id, { x: m.x, y: m.y, src });
          else prevMove.delete(t.id);

          // A decision that returns the tank's CURRENT turret angle is a
          // passthrough/hold (brown/grey/teal all do this when they have no
          // solution, and grey also while its dodge patience suppresses fire),
          // not a computed target. Counting those as aim samples would bury the
          // real jumps under a pile of exact zeros.
          const aimed = d.turretAngle !== t.turretAngle ? d.turretAngle : null;
          const pa = prevAim.get(t.id);
          if (aimed !== null && pa !== null && pa !== undefined) {
            const jump = Math.abs(deg(angleDelta(aimed, pa)));
            const crossed =
              Math.floor(w.tick / AI_JITTER_TICKS) !== Math.floor((w.tick - 1) / AI_JITTER_TICKS);
            (crossed ? s.aimStep : s.aimHold).push(jump);
          }
          prevAim.set(t.id, aimed);
        }
      }

      let fire = false;
      let aim = dir;
      if (policy === 'shooter' && player?.alive) {
        // Nearest living enemy WITH LINE OF SIGHT, and fire only then. The
        // line-of-sight gate is not politeness, it is what keeps the policy from
        // measuring itself: firing blind at a target behind an adjacent wall puts
        // the shell into that wall at point-blank range, and a standard shell that
        // rebounds into its own muzzle kills the player on the spot. Without the
        // gate, arena3 ended 60/60 games inside ~16 live ticks and the whole
        // arena3/shooter row was measuring the player's suicide rather than any
        // AI behaviour.
        let best: number | null = null;
        let bestD = Infinity;
        for (const t of w.tanks) {
          if (t.kind === 'player' || !t.alive) continue;
          if (!lineOfSight(player.pos, t.pos, w.walls)) continue;
          const dd = detHypot(t.pos.x - player.pos.x, t.pos.y - player.pos.y);
          if (dd < bestD) { bestD = dd; best = t.id; }
        }
        if (best !== null) {
          const target = w.tanks.find((t) => t.id === best)!;
          aim = { x: target.pos.x, y: target.pos.y };
          fire = true;
        }
      }
      const r = step(w, { move: dir, aim, fire, mine: false });
      w = r.world;
      ticks++;
    }
    gameTicks.push(ticks);
  }

  const q = (a: number[], p: number): number =>
    a.length === 0 ? NaN : [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
  const rows = [...stats.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, s]) => {
      const rev = s.pairs === 0 ? NaN : (100 * s.reversals) / s.pairs;
      return `${kind}: reversals=${rev.toFixed(2)}% (${s.reversals}/${s.pairs} pairs)`
        + ` turnMed=${q(s.turns, 0.5).toFixed(1)}deg turnP95=${q(s.turns, 0.95).toFixed(1)}deg`
        + ` | aimStepMed=${q(s.aimStep, 0.5).toFixed(2)}deg aimStepP95=${q(s.aimStep, 0.95).toFixed(2)}deg (n=${s.aimStep.length})`
        + ` aimHoldMed=${q(s.aimHold, 0.5).toFixed(2)}deg aimHoldP95=${q(s.aimHold, 0.95).toFixed(2)}deg`
        + ` (n=${s.aimHold.length})`;
    });
  const trans = new Map<string, number>();
  for (const s of stats.values()) {
    for (const [k, v] of s.transitions) trans.set(k, (trans.get(k) ?? 0) + v);
  }
  const transTotal = [...trans.values()].reduce((a, b) => a + b, 0);
  const occ = new Map<MoveSource, number>();
  for (const st of stats.values()) {
    for (const [k, v] of st.occupancy) occ.set(k, (occ.get(k) ?? 0) + v);
  }
  const occTotal = [...occ.values()].reduce((a, b) => a + b, 0);
  const occRow = (['seek', 'mine', 'bullet'] as MoveSource[])
    .map((k) => `${k}=${occ.get(k) ?? 0} (${((100 * (occ.get(k) ?? 0)) / occTotal).toFixed(1)}%)`)
    .join(' ');
  const transRow = [...trans.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${((100 * v) / transTotal).toFixed(1)}%`)
    .join(' ');
  return `arena${arenaIdx + 1}/${policy}: medianGameTicks=${q(gameTicks, 0.5)} games=${gameTicks.length}\n  ${rows.join('\n  ')}`
    + `\n  reversal sources (all kinds, n=${transTotal}): ${transRow}`
    + `\n  moving-tick occupancy (all kinds, n=${occTotal}): ${occRow}`;
}

// Gate on an env var instead of describe.skip: hand-flipping the skip has nearly been
// committed several times, since it is a one-word diff easy to miss in review.
const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

measure('decision-stability measurement (set VITE_RUN_MEASURE=1 to run)', () => {
  it('reports per-kind movement reversal and aim-jump distributions', () => {
    const out: string[] = [];
    for (const arena of [0, 2]) {
      for (const policy of ['pacifist', 'shooter'] as PlayerPolicy[]) {
        out.push(run(arena, policy));
      }
    }
    console.log('\n' + out.join('\n'));
  });
});
