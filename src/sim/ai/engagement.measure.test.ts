/// <reference types="vite/client" />
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
// Usage: set VITE_RUN_MEASURE=1, run
//   VITE_RUN_MEASURE=1 npx vitest run src/sim/ai/engagement.measure.test.ts --testTimeout=3600000
// and read the table off the console. No skip to flip back and no risk of a flipped
// skip landing in a commit -- the harness stays gated behind the env var by default,
// and CI's measure.yml workflow sets it deliberately for a chosen harness on demand.
// The pinned CI gate for AI health remains pacifist.test.ts, not this.
//
// Read via `import.meta.env`, NOT `process.env`: this file lives under src/sim/, and
// purity.test.ts's FORBIDDEN_GLOBALS bans the bare token "process" anywhere in src/sim/
// (it scans every .ts file there, test files included, for a real host clock that
// walked past the guard once already -- see that file's header). `VITE_` is Vite's
// required prefix for a shell env var to reach `import.meta.env` at all.
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
  const gameTicks: number[] = [];
  let losses = 0, timeouts = 0, freeWins = 0, mines = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    let w = createWorldFor(ARENAS[arenaIdx], seed);
    const rnd = mulberry(seed * 7919 + 13);
    let heading = rnd() * Math.PI * 2;
    let ticks = 0;
    while (w.status === 'playing' && ticks < TICK_CAP) {
      if (ticks % 45 === 0) heading += (rnd() - 0.5) * 2.4;
      const dir = { x: Math.cos(heading), y: Math.sin(heading) };
      const r = step(w, { move: dir, aim: dir, fire: false, mine: false });
      w = r.world;
      mines += r.events.filter((e) => e.type === 'mine-dropped').length;
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
    gameTicks.push(ticks);
  }
  const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
  const rows = [...samples.entries()].map(([k, v]) =>
    `${k}: median=${q(v, 0.5).toFixed(2)} p25=${q(v, 0.25).toFixed(2)} p75=${q(v, 0.75).toFixed(2)} n=${v.length}`);
  // Median game length = the lethality axis (added for the aimAccuracy sweep):
  // more AI jitter -> slower kills -> longer games. Population: all SEEDS games.
  return `arena${arenaIdx + 1}: losses=${losses}/${SEEDS} freeWins=${freeWins} timeouts=${timeouts} medianTicks=${q(gameTicks, 0.5)} minesPerGame=${(mines / SEEDS).toFixed(2)}\n  ${rows.join('\n  ')}`;
}

// Gate on an env var instead of describe.skip: hand-flipping the skip has nearly been
// committed several times, since it is a one-word diff easy to miss in review.
const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

measure('engagement-distance measurement (set VITE_RUN_MEASURE=1 to run)', () => {
  it('reports per-kind distances, levels 1 and 3', () => {
    console.log('\n' + run(0) + '\n' + run(2));
  });
});
