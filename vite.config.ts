// From 'vitest/config', not 'vite': since vitest 3 / vite 8, vite's own defineConfig no
// longer accepts a `test` block and tsc rejects it. Runtime behaviour is unchanged.
import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';

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
    // Vitest's default pool is 'forks' (confirmed in node_modules/vitest/dist/chunks/
    // defaults.*.js -- the ThreadsOptions doc comment claiming threads is the default is
    // stale), one child process per core with no cap. On a 4-core/4GB dev box that
    // starved the CPU under its own heavy tests: running versus-catalog-rules.test.ts,
    // versus-variants.test.ts, tools/baseline/safari.test.ts and
    // tools/mutate/orchestrate.test.ts together produced FIVE "Test timed out in 5000ms"
    // failures in files the change under test never touched, all of them passing in
    // isolation. CI runners get dedicated cores and no local dev work competing for them,
    // so only cap outside CI -- halving available cores leaves headroom for the OS and
    // the main vitest process without serializing the suite.
    poolOptions: process.env.CI
      ? undefined
      : { forks: { maxForks: Math.max(1, Math.floor(availableParallelism() / 2)) } },
    // vitest's own default is 5000ms. Measured on this same 4-core box: the heaviest
    // individual tests here (versus-catalog-rules' full-catalog sweep, orchestrate's
    // real-subprocess probe) take ~2-4s in isolation and ~6s when several heavy files
    // run concurrently under the pre-cap unbounded pool above -- that's what produced
    // the five timeouts cited above. 20000ms clears that measured worst case with
    // margin while the pool cap (above) removes most of the contention that caused it;
    // it is NOT raised to the minutes-long budget the measurement harnesses need for
    // their own multi-seed sweeps -- those pass --testTimeout explicitly (see
    // src/sim/ai/*.measure.test.ts) so a global bump here can't hide an actual hang in
    // the hundreds of ordinary unit tests that normally finish in single-digit ms.
    testTimeout: 20000,
  },
});
