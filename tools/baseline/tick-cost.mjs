/**
 * Measures what one src/sim `step(world, input)` call costs, in ns/tick. A tool, not a
 * gate -- prints a number and exits 0, same convention as tools/gl/idle-cost.mjs: the
 * absolute figure is hardware-dependent, so the only thing worth trusting across runs is
 * the RATIO between two measurements taken on the same machine, same command.
 *
 * Written for issue #133 (vendored deterministic math): run once on the commit
 * immediately before the call-site migration and once immediately after, same box, same
 * `npx vite-node tools/baseline/tick-cost.mjs` invocation, and report the ratio (JS-
 * fdlibm vs native Math.*) rather than either bare absolute number.
 *
 * Needs vite-node (not plain `node`) because src/sim's relative imports are
 * extensionless (`from './world'`), which is valid TypeScript module resolution but not
 * valid Node ESM resolution without a resolver -- vite-node is already a transitive
 * dependency of vitest (see node_modules/.bin/vite-node), so this adds nothing new.
 *
 * The world/input construction deliberately mirrors trace.ts's own loop (same varying
 * `{cos(t/37), sin(t/41)}` move/aim, same fire/mine cadence) so the benchmark exercises
 * the real mix of collision, AI and bullet code the golden trace does -- not a
 * degenerate all-idle or all-firing tick. When a world stops being 'playing' (win/lose),
 * `stepInputs` skips most of the pipeline (world.ts:304), so a benchmark that let the
 * world sit dead would silently start measuring a cheap no-op path instead of real
 * per-tick cost -- this resets to a fresh (arena, seed) the same way trace.ts's own
 * bound (`t < TRACE_TICKS && w.status === 'playing'`) does, just cycling indefinitely
 * instead of stopping.
 */
import { ARENAS, createWorldFor } from '../../src/sim/arena';
import { step } from '../../src/sim/world';

const TICKS = 100_000;
const WARMUP = 5_000; // let the JIT settle before the timed window starts

function runTicks(ticks, warmup) {
  let seed = 1;
  let arenaIdx = 0;
  let w = createWorldFor(ARENAS[arenaIdx], seed);
  let t = 0;
  let executed = 0;
  const total = ticks + warmup;
  let start = 0;
  while (executed < total) {
    if (w.status !== 'playing') {
      seed = (seed % 6) + 1;
      if (seed === 1) arenaIdx = (arenaIdx + 1) % ARENAS.length;
      w = createWorldFor(ARENAS[arenaIdx], seed);
      t = 0;
    }
    const d = { x: Math.cos(t / 37), y: Math.sin(t / 41) };
    const input = { move: d, aim: d, fire: t % 23 === 0, mine: t % 311 === 0 };
    if (executed === warmup) start = performance.now();
    w = step(w, input).world;
    t++;
    executed++;
  }
  const end = performance.now();
  return { ms: end - start, ticks };
}

const { ms, ticks } = runTicks(TICKS, WARMUP);
const nsPerTick = (ms / ticks) * 1e6;
console.log(`node ${process.version}`);
console.log(`ticks=${ticks} warmup=${WARMUP} total_ms=${ms.toFixed(2)} ns/tick=${nsPerTick.toFixed(1)}`);
