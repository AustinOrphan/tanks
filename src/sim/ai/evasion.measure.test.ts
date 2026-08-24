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
import type { Vec2 } from '../types';

// ---------------------------------------------------------------------------
// MEASUREMENT HARNESS, skipped in CI on purpose: how often an AI tank DRIVES INTO
// A WALL -- asks for movement and gets little or none of it -- and how long it
// stays stuck when it does. Issue #224's first acceptance criterion ("in corner,
// corridor, and dead-end fixtures, the AI does not repeatedly drive into a wall
// when a navigable alternative exists") is the two run-length columns here.
//
// A third sibling alongside engagement.measure.test.ts (per-kind distances) and
// commitment.measure.test.ts (decision stability). Kept separate because this one
// measures EXECUTION -- what the tank achieved -- where commitment.measure.test.ts
// measures the DECISION. The two answer different questions about the same tick
// and a shared file would invite reading one number for the other.
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

type PlayerPolicy = 'pacifist' | 'shooter';

interface KindStats {
  /** Live ticks where the tank asked to move at all. */
  moving: number;
  /** Of those, ticks that achieved less than PINNED_FRACTION of the possible travel. */
  pinned: number;
  /** Of the pinned ticks, those taken while an escape was live (the #224 subset). */
  pinnedWhileEvading: number;
  /** Lengths of consecutive-pinned runs, in ticks. */
  runs: number[];
}

function emptyStats(): KindStats {
  return { moving: 0, pinned: 0, pinnedWhileEvading: 0, runs: [] };
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

    while (w.status === 'playing' && ticks < TICK_CAP) {
      if (ticks % 45 === 0) heading += (rnd() - 0.5) * 2.4;
      const dir = { x: Math.cos(heading), y: Math.sin(heading) };
      const player = w.tanks.find((t) => t.kind === 'player');
      const live = roundPhase(w) === 'live';

      // Positions and intents BEFORE the step, so the displacement compared below is
      // exactly the one this tick's decision produced.
      const before = new Map<number, { pos: Vec2; evading: boolean }>();
      if (live) {
        for (const t of w.tanks) {
          if (t.kind === 'player' || !t.alive) continue;
          const cfg = configFor(t.kind);
          const off = estimationError(w, t, profileHazardSpread(cfg));
          const evading =
            dangerAvoidMove(w, t, AI_MINE_FLEE_RADIUS + off, DANGER_CORRIDOR + off) !== null;
          before.set(t.id, { pos: { x: t.pos.x, y: t.pos.y }, evading });
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
  const rows = [...stats.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, s]) => {
      const pct = s.moving === 0 ? NaN : (100 * s.pinned) / s.moving;
      const ev = s.pinned === 0 ? NaN : (100 * s.pinnedWhileEvading) / s.pinned;
      return `${kind}: pinned=${pct.toFixed(2)}% (${s.pinned}/${s.moving} moving ticks)`
        + ` ofWhichEvading=${ev.toFixed(1)}%`
        + ` runs n=${s.runs.length} med=${q(s.runs, 0.5)} p95=${q(s.runs, 0.95)} max=${s.runs.length ? Math.max(...s.runs) : NaN}`;
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
