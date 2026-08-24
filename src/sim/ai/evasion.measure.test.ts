/// <reference types="vite/client" />
import { describe, it } from 'vitest';
import { ARENAS, createWorldFor } from '../arena';
import { step } from '../world';
import {
  lineOfSight,
  dangerAvoidMove,
  estimationError,
  profileHazardSpread,
} from './targeting';
import { roundPhase } from '../round';
import { configFor } from '../config';
import { DT, AI_MINE_FLEE_RADIUS, DANGER_CORRIDOR } from '../constants';
import { detHypot } from '../math/hypot';
import { angleDelta } from '../types';
import type { Vec2 } from '../types';

// ---------------------------------------------------------------------------
// MEASUREMENT HARNESS, skipped in CI on purpose. Two EXECUTION questions about AI
// tanks -- what they actually achieved on live ticks, as opposed to
// commitment.measure.test.ts's DECISION-stability numbers for the same tick:
//
// 1. Wall-pinning: how often an AI tank DRIVES INTO A WALL -- asks for movement
//    and gets little or none of it -- and how long it stays stuck when it does.
//    Issue #224's first acceptance criterion ("in corner, corridor, and dead-end
//    fixtures, the AI does not repeatedly drive into a wall when a navigable
//    alternative exists") is the two run-length columns here.
// 2. Turret execution (issue #330): per-tick turret rotation, independent of hull
//    movement -- so brown (never moves its hull) is still fully represented. The
//    columns exist to weigh the AI_TURRET_DEADBAND sweep both ways: how much
//    sub-perceptible shimmer a deadband removes, AND whether it converts that
//    shimmer into fewer but more visible periodic jumps instead of removing it.
//
// Usage: set VITE_RUN_MEASURE=1, run
//   VITE_RUN_MEASURE=1 npx vitest run src/sim/ai/evasion.measure.test.ts --testTimeout=3600000
// and read the table off the console. No skip to flip back and no risk of a flipped
// skip landing in a commit -- the harness stays gated behind the env var by default,
// and CI's measure.yml workflow sets it deliberately for a chosen harness on demand.
//
// Read via `import.meta.env`, NOT `process.env`: this file lives under src/sim/, and
// purity.test.ts's FORBIDDEN_GLOBALS bans the bare token "process" anywhere in src/sim/
// (it scans every .ts file there, test files included, for a real host clock that
// walked past the guard once already -- see that file's header). `VITE_` is Vite's
// required prefix for a shell env var to reach `import.meta.env` at all.
//
// Method (keep stable across sweeps): the same 60 seeds, 3-minute cap, two arenas
// and two player policies as commitment.measure.test.ts, so rows line up with that
// harness's. Sampled every live tick.
//
// PINNED is measured against what moveTank could have delivered, not against zero.
// `resolveWalls` SLIDES a blocked tank along the surface it hit rather than
// stopping it dead, so a wall-driving tank often still moves -- just barely, and
// not where it asked. Comparing achieved displacement to `movementSpeed * DT`
// catches that; a bare `displacement === 0` test would score almost none of it.
//
// The ratio is deliberately NOT a "did it go where it asked" test: moveTank turns
// the hull toward the request and drives along the HULL, so a tank mid-turn
// legitimately moves somewhere other than its desiredMove for a few ticks. That is
// steering, not pinning. Distance achieved is the honest signal.
//
// TURRET columns, sampled every live tick regardless of hull movement:
//   subThreshold%  -- fraction of live ticks whose rotation is under 1.15 degrees
//                     (the issue's original, pre-deadband metric: includes BOTH
//                     exactly-zero ticks (frozen by the deadband) and nonzero
//                     sub-1.15-degree ticks, so it is comparable to the issue's
//                     baseline table but does NOT by itself distinguish "motion
//                     eliminated" from "motion just got smaller".)
//   zero%          -- of subThreshold%, the ticks with EXACTLY zero rotation:
//                     the deadband actually firing.
//   microNonzero%  -- of subThreshold%, ticks that still rotated a NONZERO amount
//                     under 1.15 degrees: shimmer the deadband did NOT catch,
//                     because the closing tick can land anywhere between the
//                     deadband and the full per-tick slew budget.
//   avgDeg/tick    -- total rotation summed over all live ticks, divided by live
//                     ticks: the (a) "how much motion, in total" signal.
//   nonzero step (deg) med/p95/max -- distribution of rotation SIZE on ticks that
//                     moved at all: the (b) signal for whether remaining motion
//                     reads as fine tracking or as periodic jumps.
//   postFreeze n/med/p95/max (deg) -- of the nonzero ticks, the subset that
//                     immediately follow one or more zero-rotation ticks: the
//                     deadband's classic risk, a visible jump after a freeze,
//                     isolated from ordinary continuous tracking.
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
/** Below this fraction of the tick's maximum travel, the tank is driving into something. */
const PINNED_FRACTION = 0.25;
/** Issue #330's own micro-nudge threshold: rotations under this read as shimmer, not aim. */
const MICRO_DEG = 1.15;
const MICRO_RAD = (MICRO_DEG * Math.PI) / 180;
/** turretSlew (ai/index.ts) either leaves the angle byte-identical or reassigns it via
 * slewAngle; a frozen tick's rotation is exactly 0, so this is a noise margin, not a
 * real tolerance. */
const ROT_EPS = 1e-12;

type PlayerPolicy = 'pacifist' | 'shooter';

interface TurretStats {
  /** Every live tick the tank was alive for, regardless of hull movement. */
  liveTicks: number;
  /** Ticks whose rotation was exactly 0 -- the deadband holding. */
  zero: number;
  /** Ticks whose rotation was nonzero but under MICRO_RAD -- shimmer the deadband missed. */
  microNonzero: number;
  /** Sum of |rotation| (radians) across all live ticks -- the total-motion signal. */
  totalRotation: number;
  /** Magnitudes (radians) of every nonzero-rotation tick, for the step-size distribution. */
  nonzeroSteps: number[];
  /** Magnitudes (radians) of nonzero ticks that immediately follow >=1 zero-rotation
   * tick -- a deadband trading shimmer for a visible periodic jump would show up here. */
  postFreezeJumps: number[];
}

function emptyTurretStats(): TurretStats {
  return {
    liveTicks: 0, zero: 0, microNonzero: 0, totalRotation: 0,
    nonzeroSteps: [], postFreezeJumps: [],
  };
}

interface KindStats {
  /** Live ticks where the tank asked to move at all. */
  moving: number;
  /** Of those, ticks that achieved less than PINNED_FRACTION of the possible travel. */
  pinned: number;
  /** Of the pinned ticks, those taken while an escape was live (the #224 subset). */
  pinnedWhileEvading: number;
  /** Lengths of consecutive-pinned runs, in ticks. */
  runs: number[];
  /** Issue #330: turret execution, independent of the hull stats above. */
  turret: TurretStats;
}

function emptyStats(): KindStats {
  return { moving: 0, pinned: 0, pinnedWhileEvading: 0, runs: [], turret: emptyTurretStats() };
}

function run(arenaIdx: number, policy: PlayerPolicy): string {
  const stats = new Map<string, KindStats>();
  const statsFor = (kind: string): KindStats => {
    let s = stats.get(kind);
    if (!s) { s = emptyStats(); stats.set(kind, s); }
    return s;
  };
  const gameTicks: number[] = [];

  for (let seed = 1; seed <= SEEDS; seed++) {
    let w = createWorldFor(ARENAS[arenaIdx], seed);
    const rnd = mulberry(seed * 7919 + 13);
    let heading = rnd() * Math.PI * 2;
    let ticks = 0;
    const runLen = new Map<number, number>();
    // Consecutive zero-rotation tick count, PER TANK ID (not per kind: arena3 spawns two
    // brown and two olive tanks -- see arenas.json's arena-03 grid -- so a per-kind
    // counter would interleave one tank's freeze with another's release and mislabel the
    // postFreezeJumps population. Same shape as runLen above, for the same reason.
    const turretFreezeStreak = new Map<number, number>();

    while (w.status === 'playing' && ticks < TICK_CAP) {
      if (ticks % 45 === 0) heading += (rnd() - 0.5) * 2.4;
      const dir = { x: Math.cos(heading), y: Math.sin(heading) };
      const player = w.tanks.find((t) => t.kind === 'player');
      const live = roundPhase(w) === 'live';

      // Positions, turret angles and intents BEFORE the step, so the displacement/rotation
      // compared below is exactly what this tick's decision produced.
      const before = new Map<number, { pos: Vec2; turretAngle: number; evading: boolean }>();
      if (live) {
        for (const t of w.tanks) {
          if (t.kind === 'player' || !t.alive) continue;
          const cfg = configFor(t.kind);
          const off = estimationError(w, t, profileHazardSpread(cfg));
          const evading =
            dangerAvoidMove(w, t, AI_MINE_FLEE_RADIUS + off, DANGER_CORRIDOR + off) !== null;
          before.set(t.id, { pos: { x: t.pos.x, y: t.pos.y }, turretAngle: t.turretAngle, evading });
        }
      }

      let fire = false;
      let aim = dir;
      if (policy === 'shooter' && player?.alive) {
        // Line-of-sight gated, same as commitment.measure.test.ts: firing blind at a
        // target behind an adjacent wall rebounds into the player's own muzzle and ends
        // the game in a handful of ticks, which measures nothing.
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

      w = step(w, { move: dir, aim, fire, mine: false }).world;
      ticks++;

      if (!live) continue;
      for (const t of w.tanks) {
        if (t.kind === 'player' || !t.alive) continue;
        const prev = before.get(t.id);
        if (!prev) continue;

        // --- turret execution (issue #330): every live tick, independent of hull
        // movement below, so brown (never moves its hull) is fully represented. The
        // freeze-streak counter is keyed by TANK ID (turretFreezeStreak, above), not by
        // kind: arena3 spawns two brown and two olive tanks.
        const turret = statsFor(t.kind).turret;
        const rotation = Math.abs(angleDelta(prev.turretAngle, t.turretAngle));
        turret.liveTicks++;
        turret.totalRotation += rotation;
        if (rotation < ROT_EPS) {
          turret.zero++;
          turretFreezeStreak.set(t.id, (turretFreezeStreak.get(t.id) ?? 0) + 1);
        } else {
          turret.nonzeroSteps.push(rotation);
          if (rotation < MICRO_RAD) turret.microNonzero++;
          if ((turretFreezeStreak.get(t.id) ?? 0) > 0) turret.postFreezeJumps.push(rotation);
          turretFreezeStreak.set(t.id, 0);
        }

        // --- wall-pinning (issue #224, unchanged) ---
        // `desiredMove` is what the dispatcher actually wrote for this tick (already
        // zeroed during countdown, which the `live` gate above excludes anyway).
        if (detHypot(t.desiredMove.x, t.desiredMove.y) < VEC_EPS) { runLen.delete(t.id); continue; }
        const s = statsFor(t.kind);
        s.moving++;
        const moved = detHypot(t.pos.x - prev.pos.x, t.pos.y - prev.pos.y);
        const possible = configFor(t.kind).movementSpeed * DT;
        if (moved < possible * PINNED_FRACTION) {
          s.pinned++;
          if (prev.evading) s.pinnedWhileEvading++;
          runLen.set(t.id, (runLen.get(t.id) ?? 0) + 1);
        } else {
          const r = runLen.get(t.id);
          if (r) { s.runs.push(r); runLen.delete(t.id); }
        }
      }
    }
    // Runs still open when the game ended still happened; dropping them would bias the
    // distribution against exactly the longest ones.
    for (const [id, r] of runLen) {
      const t = w.tanks.find((k) => k.id === id);
      if (t) statsFor(t.kind).runs.push(r);
    }
    gameTicks.push(ticks);
  }

  const q = (a: number[], p: number): number =>
    a.length === 0 ? NaN : [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
  const toDeg = (rad: number): number => (rad * 180) / Math.PI;
  const rows = [...stats.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, s]) => {
      const pct = s.moving === 0 ? NaN : (100 * s.pinned) / s.moving;
      const ev = s.pinned === 0 ? NaN : (100 * s.pinnedWhileEvading) / s.pinned;
      const pinLine = `${kind}: pinned=${pct.toFixed(2)}% (${s.pinned}/${s.moving} moving ticks)`
        + ` ofWhichEvading=${ev.toFixed(1)}%`
        + ` runs n=${s.runs.length} med=${q(s.runs, 0.5)} p95=${q(s.runs, 0.95)} max=${s.runs.length ? Math.max(...s.runs) : NaN}`;

      const tt = s.turret;
      const subPct = tt.liveTicks === 0 ? NaN : (100 * (tt.zero + tt.microNonzero)) / tt.liveTicks;
      const zeroPct = tt.liveTicks === 0 ? NaN : (100 * tt.zero) / tt.liveTicks;
      const microPct = tt.liveTicks === 0 ? NaN : (100 * tt.microNonzero) / tt.liveTicks;
      const avgDeg = tt.liveTicks === 0 ? NaN : toDeg(tt.totalRotation / tt.liveTicks);
      const steps = tt.nonzeroSteps.map(toDeg);
      const jumps = tt.postFreezeJumps.map(toDeg);
      const jumpPct = tt.liveTicks === 0 ? NaN : (100 * jumps.length) / tt.liveTicks;
      const turretLine =
        `    turret: subThreshold(<${MICRO_DEG}deg)=${subPct.toFixed(2)}%`
        + ` (zero=${zeroPct.toFixed(2)}% microNonzero=${microPct.toFixed(2)}%) of ${tt.liveTicks} live ticks`
        + ` avg=${avgDeg.toFixed(3)}deg/tick`
        + ` | nonzero step(deg) n=${steps.length} med=${q(steps, 0.5).toFixed(3)}`
        + ` p95=${q(steps, 0.95).toFixed(3)} max=${steps.length ? Math.max(...steps).toFixed(3) : 'NaN'}`
        + ` | postFreezeJump n=${jumps.length} (${jumpPct.toFixed(2)}% of live ticks)`
        + ` med=${q(jumps, 0.5).toFixed(3)} p95=${q(jumps, 0.95).toFixed(3)}`
        + ` max=${jumps.length ? Math.max(...jumps).toFixed(3) : 'NaN'}`;

      return `${pinLine}\n${turretLine}`;
    });
  return `arena${arenaIdx + 1}/${policy}: medianGameTicks=${q(gameTicks, 0.5)} games=${gameTicks.length}\n  ${rows.join('\n  ')}`;
}

// Gate on an env var instead of describe.skip: hand-flipping the skip has nearly been
// committed several times, since it is a one-word diff easy to miss in review.
const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

measure('wall-pinning measurement (set VITE_RUN_MEASURE=1 to run)', () => {
  it('reports how often and how long AI tanks drive into walls', () => {
    const out: string[] = [];
    for (const arena of [0, 2]) {
      for (const policy of ['pacifist', 'shooter'] as PlayerPolicy[]) {
        out.push(run(arena, policy));
      }
    }
    console.log('\n' + out.join('\n'));
  });
});
