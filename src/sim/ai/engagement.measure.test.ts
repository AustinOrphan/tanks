import { describe, it } from 'vitest';
import { ARENAS, createWorldFor } from '../arena';
import { step } from '../world';
import { vdist } from '../types';

// ---------------------------------------------------------------------------
// MEASUREMENT HARNESS, skipped in CI on purpose: per-kind engagement distances
// over the pacifist seeds. This produced the SEEK_APPROACH_BIAS sweep table
// (constants.ts) and exists so future sweeps -- the promised aimAccuracy pass,
// any band retune -- re-measure with the SAME method instead of rewriting it
// and eating method drift. (Shipped at review's insistence: the first version
// was deleted after use, and the reviewer who re-derived it from the PR's
// method description measured +/-0.05 residuals traceable purely to rebuild
// differences. CLAUDE.md: re-measure headline numbers yourself.)
//
// Usage: flip describe.skip to describe, run
//   npx vitest run src/sim/ai/engagement.measure.test.ts
// and read the table off the console. Flip back before committing; the pinned
// CI gate for AI health is pacifist.test.ts, not this.
//
// Method (keep stable across sweeps; the tables in constants.ts assume it):
// 60 fixed seeds per arena, the same wandering never-firing player as
// pacifist.test.ts on an RNG independent of the sim's, 3-minute cap, distance
// sampled every 10 ticks (6Hz) while player and enemy are both alive.
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

function run(arenaIdx: number): string {
  const samples = new Map<string, number[]>();
  let losses = 0, timeouts = 0, freeWins = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    let w = createWorldFor(ARENAS[arenaIdx], seed);
    const rnd = mulberry(seed * 7919 + 13);
    let heading = rnd() * Math.PI * 2;
    let ticks = 0;
    while (w.status === 'playing' && ticks < TICK_CAP) {
      if (ticks % 45 === 0) heading += (rnd() - 0.5) * 2.4;
      const dir = { x: Math.cos(heading), y: Math.sin(heading) };
      w = step(w, { move: dir, aim: dir, fire: false, mine: false }).world;
      const player = w.tanks.find((t) => t.kind === 'player');
      if (player?.alive && ticks % 10 === 0) {
        for (const t of w.tanks) {
          if (t.kind === 'player' || !t.alive) continue;
          if (!samples.has(t.kind)) samples.set(t.kind, []);
          samples.get(t.kind)!.push(vdist(t.pos, player.pos));
        }
      }
      ticks++;
    }
    if (w.status === 'lose') losses++;
    else if (w.status === 'win') freeWins++;
    else timeouts++;
  }
  const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
  const rows = [...samples.entries()].map(([k, v]) =>
    `${k}: median=${q(v, 0.5).toFixed(2)} p25=${q(v, 0.25).toFixed(2)} p75=${q(v, 0.75).toFixed(2)} n=${v.length}`);
  return `arena${arenaIdx + 1}: losses=${losses}/${SEEDS} freeWins=${freeWins} timeouts=${timeouts}\n  ${rows.join('\n  ')}`;
}

describe.skip('engagement-distance measurement (flip skip off to run locally)', () => {
  it('reports per-kind distances, levels 1 and 3', () => {
    console.log('\n' + run(0) + '\n' + run(2));
  });
});
