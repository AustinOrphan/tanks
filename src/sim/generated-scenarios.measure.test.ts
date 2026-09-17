/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import {
  describeDivergence,
  describeFailure,
  digest,
  firstDivergence,
  generateScenario,
  parseSeedList,
  runScenario,
} from './scenarios';

// ---------------------------------------------------------------------------
// ON-DEMAND SWEEP, skipped by default: the generated-scenario invariants (issue #760) over
// many more seeds and ticks than required CI pays for.
//
// Required CI runs the small fixed corpus in generated-scenarios.test.ts. This runs the same
// generator, driver and checks -- `scenarios.ts`, the one implementation -- over a seed list
// from the environment, runs EVERY seed twice for the repeat check, and fails on any
// violation or divergence, printing each case's reproduction.
//
// Usage (defaults: seeds 1-200, 3600 ticks = 60 s of play each):
//   VITE_RUN_MEASURE=1 npx vitest run src/sim/generated-scenarios.measure.test.ts
//   VITE_RUN_MEASURE=1 VITE_SCENARIO_SEEDS=1-50,900 VITE_SCENARIO_TICKS=1800 \
//     npx vitest run src/sim/generated-scenarios.measure.test.ts
//
// A reported seed reruns alone with the `rerun:` line of its failure, which is this command
// with that one seed and its tick budget. Runtime budgets are in
// docs/agent/commands-and-operations.md; on GitHub, the Measurement harness workflow runs it
// as `generated-scenarios`.
//
// The closing `corpus digest` line hashes every run's per-tick digests in seed order. Two
// sweeps of the same seed list and tick budget on the same code must print the same line;
// that is how the sweep itself is checked for repeatability across separate invocations.
//
// Read via `import.meta.env`: purity.test.ts bans the other environment global's bare token
// anywhere in src/sim/, test files included, and only a VITE_-prefixed shell variable reaches
// `import.meta.env` at all.
// ---------------------------------------------------------------------------

const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

const SEEDS = parseSeedList(import.meta.env.VITE_SCENARIO_SEEDS ?? '1-200');
const TICKS = Number(import.meta.env.VITE_SCENARIO_TICKS ?? '3600');

measure('generated scenarios: on-demand sweep (set VITE_RUN_MEASURE=1 to run)', () => {
  it('holds every invariant on every tick, and repeats exactly, for every seed', () => {
    if (!Number.isInteger(TICKS) || TICKS < 1) throw new Error(`VITE_SCENARIO_TICKS must be a positive integer, got '${TICKS}'`);
    const failures: string[] = [];
    const byMode: Record<string, number> = {};
    const events: Record<string, number> = {};
    const runDigests: number[] = [];
    let ticks = 0;
    let terminal = 0;
    for (const seed of SEEDS) {
      const cfg = generateScenario(seed, TICKS);
      const first = runScenario(cfg);
      const second = runScenario(cfg);
      if (first.violations.length > 0) failures.push(describeFailure(first));
      else if (firstDivergence(first.digests, second.digests) !== -1) failures.push(describeDivergence(cfg, first, second));
      byMode[cfg.mode] = (byMode[cfg.mode] ?? 0) + 1;
      for (const [type, n] of Object.entries(first.eventCounts)) events[type] = (events[type] ?? 0) + n;
      ticks += first.digests.length;
      if (first.terminalTick !== undefined) terminal++;
      runDigests.push(digest(first.digests.join(',')));
    }
    console.log([
      `seeds: ${SEEDS.length} (${SEEDS[0]}..${SEEDS[SEEDS.length - 1]}), tick budget ${TICKS}, each run twice`,
      `scenarios by mode: ${JSON.stringify(byMode)}`,
      `simulated ticks checked (first runs): ${ticks}; runs that reached an ending: ${terminal} of ${SEEDS.length}`,
      `events (first runs): ${JSON.stringify(events)}`,
      `failures: ${failures.length} of ${SEEDS.length} seeds`,
      `corpus digest: ${digest(runDigests.join(','))}`,
    ].join('\n'));
    expect(failures.join('\n\n')).toBe('');
  });
});
