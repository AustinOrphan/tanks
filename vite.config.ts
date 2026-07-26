import { defineConfig } from 'vite';

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
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
