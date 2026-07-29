// From 'vitest/config', not 'vite': since vitest 3 / vite 8, vite's own defineConfig no
// longer accepts a `test` block and tsc rejects it. Runtime behaviour is unchanged.
import { defineConfig } from 'vitest/config';

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
  },
});
