/// <reference types="vite/client" />
import { afterAll, describe, it, expect } from 'vitest';
import {
  describeDivergence,
  describeFailure,
  digest,
  firstDivergence,
  generateScenario,
  parseSeedList,
  runScenario,
} from '../../src/sim/scenarios';

// ---------------------------------------------------------------------------
// ON-DEMAND SWEEP, skipped by default: the generated-scenario invariants (issue #760) over
// many more seeds and ticks than required CI pays for.
//
// Required CI runs the small fixed corpus in src/sim/generated-scenarios.test.ts. This runs
// the same generator, drivers and checks -- src/sim/scenarios.ts, the one implementation --
// over a seed list from the environment, runs EVERY seed twice for the repeat check, and
// fails a seed on any violation or divergence, printing its reproduction.
//
// Usage (defaults: seeds 1-200, 3600 ticks = 60 s of play each):
//   VITE_RUN_MEASURE=1 npx vitest run tools/scenarios/generated-scenarios.measure.test.ts
//   VITE_RUN_MEASURE=1 VITE_SCENARIO_SEEDS=1-50,900 VITE_SCENARIO_TICKS=1800 \
//     npx vitest run tools/scenarios/generated-scenarios.measure.test.ts
//
// A reported seed reruns alone with the `rerun:` line of its failure, which is this command
// with that one seed and its tick budget. Runtime budgets are in
// docs/agent/commands-and-operations.md; on GitHub, the "Generated-scenario sweep" workflow
// (scenario-sweep.yml) runs it with the seed list and tick budget as dispatch inputs.
//
// WHY THIS LIVES IN tools/ AND YIELDS BETWEEN SEEDS. Vitest's worker answers its runner over
// RPC, and a reply can only be read when the event loop turns. Minutes of synchronous
// simulation never turn it, so the RPC's own timeout fires first and the run exits 1 with
// "Timeout calling onTaskUpdate" after every seed passed. Measured twice before this shape:
// once as one 197 s test, and again as 200 synchronous per-seed tests (195 s). Each test here
// awaits a zero-delay timer first. src/sim/purity.test.ts bans timers anywhere under src/sim/,
// test files included, which is right for the simulation and why the sweep is tooling here.
//
// The closing `corpus digest` line hashes every seed's per-tick digests in seed order. Two
// sweeps of the same seed list and tick budget on the same code must print the same line;
// that is how the sweep itself is checked for repeatability across separate invocations.
// ---------------------------------------------------------------------------

const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

const SEEDS = parseSeedList(import.meta.env.VITE_SCENARIO_SEEDS ?? '1-200');
const TICKS = Number(import.meta.env.VITE_SCENARIO_TICKS ?? '3600');
if (!Number.isInteger(TICKS) || TICKS < 1) {
  throw new Error(`VITE_SCENARIO_TICKS must be a positive integer, got '${import.meta.env.VITE_SCENARIO_TICKS}'`);
}

measure('generated scenarios: on-demand sweep (set VITE_RUN_MEASURE=1 to run)', () => {
  const failures: number[] = [];
  const byMode: Record<string, number> = {};
  const events: Record<string, number> = {};
  const seedDigests = new Map<number, number>();
  let ticks = 0;
  let endings = 0;

  for (const seed of SEEDS) {
    it(`seed ${seed} holds every invariant on every tick, and repeats exactly`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const cfg = generateScenario(seed, TICKS);
      const first = runScenario(cfg);
      const second = runScenario(cfg);
      byMode[cfg.mode] = (byMode[cfg.mode] ?? 0) + 1;
      for (const [type, n] of Object.entries(first.eventCounts)) events[type] = (events[type] ?? 0) + n;
      ticks += first.digests.length;
      if (first.terminalTick !== undefined) endings++;
      seedDigests.set(seed, digest(first.digests.join(',')));
      const report = first.violations.length > 0
        ? describeFailure(first)
        : firstDivergence(first.digests, second.digests) !== -1 ? describeDivergence(cfg, first, second) : '';
      if (report) failures.push(seed);
      expect(report).toBe('');
    });
  }

  afterAll(() => {
    const ran = seedDigests.size;
    console.log([
      `seeds: ${ran} run of ${SEEDS.length} listed (${SEEDS[0]}..${SEEDS[SEEDS.length - 1]}), tick budget ${TICKS}, each run twice`,
      `scenarios by mode: ${JSON.stringify(byMode)}`,
      `simulated ticks checked (first runs): ${ticks}; runs that reached an ending: ${endings} of ${ran}`,
      `events (first runs): ${JSON.stringify(events)}`,
      `failing seeds: ${failures.length} of ${ran}${failures.length ? ` (${failures.join(', ')})` : ''}`,
      `corpus digest: ${digest([...seedDigests.entries()].sort((a, b) => a[0] - b[0]).map(([, d]) => d).join(','))}`,
    ].join('\n'));
  });
});
