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

  it('removes the AudioContext constructor for every state, not just the ones that ask', () => {
    // STRUCTURAL, same reason as the guard below: what it protects happens only in a real
    // browser. Issue #860 -- the constructor blocks for ~20 s per call on a host whose audio
    // service never connects, twice per boot, which is longer than the navigation budget.
    //
    // The assertion that earns its place is the UNCONDITIONAL one. Gating this on an
    // environment variable or a state field would let one machine photograph a page with an
    // audio stack and another photograph a page without, and the measurements the gate
    // compares would carry that difference as a false regression.
    const src = readFileSync(new URL('./capture.mjs', import.meta.url), 'utf8');
    // Exactly four spaces: the body's own indentation. `\s*` would have accepted the call
    // nested inside an `if`, which is the one shape this test exists to reject -- it passed
    // with the guard wrapped in an environment check until the indent was pinned.
    const call = /^ {4}await page\.addInitScript\(audioContextOverrideSource\(\)\);$/m;
    expect(src, 'the override is gone, conditional, or no longer on its own line').toMatch(call);
    // Ordering, node-wise rather than by eye: the override has to be installed before the
    // navigation that boots the app, or the constructor it removes has already been called.
    const at = src.search(call);
    const firstGoto = src.indexOf('page.goto(');
    expect(at, 'the override call was not found').toBeGreaterThan(-1);
    expect(firstGoto, 'no navigation was found').toBeGreaterThan(-1);
    expect(at, 'the override is installed after the first navigation').toBeLessThan(firstGoto);
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
