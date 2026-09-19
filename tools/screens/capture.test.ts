import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// Imported so vitest's dependency graph RELATES this file to `capture.mjs`. Without it the
// mutation harness refuses an entry pointing here -- correctly: a mutation whose declared
// tests cannot reach the file it changes can only ever report SURVIVES, which is
// indistinguishable from genuinely uncaught. The symbols are not exercised below; what this
// file guards is a mechanism that only runs in a real browser.
import { serve, launchBrowser, captureState } from './capture.mjs';

describe('capture.mjs: the seams no vitest run can execute (issue #841)', () => {
  it('exports the three entry points the runners bind to', () => {
    for (const fn of [serve, launchBrowser, captureState]) expect(typeof fn).toBe('function');
  });

  it('holds the module AND commits the navigation, which are one mechanism in two halves', () => {
    // A STRUCTURAL guard, and it says so. What it protects happens only in a real browser:
    // `boot: 'holding'` stalls the module request so `#boot-loading` survives to be
    // photographed, and the navigation is awaited at `commit` because a deferred module that
    // never arrives means `load` never fires. The two are one mechanism -- route without the
    // commit hangs the navigation, commit without the route photographs a booted page.
    //
    // MEASURED: before this existed, deleting the route line left the entire suite green.
    // Reading the source is the weakest kind of assertion and is used for the same reason
    // the GL seams live in their own harness -- the alternative here was no guard at all.
    const src = readFileSync(new URL('./capture.mjs', import.meta.url), 'utf8');
    expect(src, 'the module is no longer held').toMatch(/state\.boot === 'holding'[\s\S]{0,120}page\.route\(/);
    expect(src, 'the navigation no longer commits early').toMatch(/waitUntil:[^\n]*state\.boot === 'holding'[^\n]*'commit'/);
  });
});
