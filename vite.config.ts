// From 'vitest/config', not 'vite': since vitest 3 / vite 8, vite's own defineConfig no
// longer accepts a `test` block and tsc rejects it. Runtime behaviour is unchanged.
import { defineConfig } from 'vitest/config';

// Opt-in escape hatches for constrained machines. BOTH DEFAULT TO VITEST'S OWN BEHAVIOUR:
// unset, this file changes nothing about how the suite runs, here or in CI.
//
// They exist because an unbounded fork pool on a 4-core/4GB box starves itself under this
// repo's own heavy tests -- running versus-catalog-rules.test.ts, versus-variants.test.ts,
// tools/baseline/safari.test.ts and tools/mutate/orchestrate.test.ts together produced five
// "Test timed out in 5000ms" failures in files the change under test never touched, all
// passing in isolation.
//
// Deliberately NOT repo defaults. Measured on that same box with no contention, the
// heaviest individual tests (versus-catalog-rules' two catalog sweeps) finish in 2335ms and
// 2598ms against the 5000ms default -- roughly half the budget, on the slowest hardware in
// play. So 5000ms is not too thin for this suite; it is too thin only while the box is
// oversubscribed. Baking a higher timeout into the repo would ship that machine's problem
// to everyone and, worse, to CI, where a hung test would take four times as long to fail
// and a real performance regression would stop tripping the timeout at all. Likewise a
// cores/2 fork cap would halve local parallelism for a contributor whose machine was never
// the problem.
//
// Set them per-machine instead (shell profile, direnv, or the command itself):
//   TANKS_TEST_MAX_FORKS=2 TANKS_TEST_TIMEOUT=20000 npm test
const maxForks = Number(process.env.TANKS_TEST_MAX_FORKS);
const testTimeout = Number(process.env.TANKS_TEST_TIMEOUT);
const capForks = Number.isFinite(maxForks) && maxForks > 0;
const overrideTimeout = Number.isFinite(testTimeout) && testTimeout > 0;

export default defineConfig({
  // Relative base, so the built bundle carries no assumption about where it is
  // served from. With the default '/', dist/index.html references
  // /assets/index-*.js absolutely and the whole game is a blank page on any
  // host that isn't a domain root -- a GitHub Pages project page, a CDN
  // subdirectory, a preview deploy. './' is correct for every target this game
  // has: it has no client-side router, which is the one case an absolute base
  // handles better.
  base: './',
  test: {
    globals: true,
    // Vitest stubs CSS imports by default, which makes `import css from './x.css?raw'`
    // return an EMPTY STRING rather than failing -- so a stylesheet guard written against
    // it passes vacuously. Processing CSS costs a little startup and makes the text real.
    css: true,
    environment: 'node',
    // tools/ is included so the gallery runner's argument handling is covered by the
    // normal gate. tools/gl/ has no *.test.ts of its own -- its browser checks run under
    // "npm run test:gl", which vitest cannot host because they need a GL context.
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
    // Spread rather than assigned, so an unset variable leaves the key absent entirely and
    // vitest applies its own default. Assigning `undefined` would not be equivalent for
    // every option vitest reads with a presence check rather than a nullish one.
    ...(capForks ? { poolOptions: { forks: { maxForks } } } : {}),
    ...(overrideTimeout ? { testTimeout } : {}),
  },
});
