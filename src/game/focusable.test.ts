// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { focusableControls } from './focusable';

/**
 * ONE case, and it is here because it is the only one the `createHud` tests cannot reach
 * (issue #556).
 *
 * The rest of this module is covered where it always was. Measured by mutation against
 * `hud.navigation.test.ts`, `hud.surfaces.test.ts` and `hud.controls.test.ts`: making
 * `isHiddenWithin` ignore ancestors fails 3 cases, keeping disabled buttons fails 2, keeping
 * hidden ones fails 8, removing `captureFocus`'s no-op fails 1, and dropping its same-row
 * fallback fails 1. Re-testing any of those here would duplicate a real test with a fixture.
 *
 * The negative-`tabindex` filter is different: **nothing in the HUD carries one**, which the
 * line's own comment says ("none today, but future-proof"), so no panel can exercise it and the
 * mutation survives the whole suite. It could not be tested at all while the function lived
 * inside `createHud` -- reaching it meant building a panel that contains the attribute, and no
 * panel does. That is the testability the move buys, demonstrated rather than claimed.
 */
describe('focusableControls: the branch no panel can reach (issue #556)', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  const container = (html: string): HTMLElement => {
    const el = document.createElement('div');
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  };

  it('excludes a negative tabindex, and keeps the controls either side of it', () => {
    const el = container(`
      <button id="a" type="button">A</button>
      <span id="skipped" tabindex="-1">not sequentially focusable</span>
      <button id="b" type="button">B</button>
    `);
    // The positive half matters as much as the negative one: an assertion that only counted
    // the exclusion would pass just as well if the query matched nothing at all.
    expect(focusableControls(el).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('keeps a zero tabindex, which is the value that means "focusable, not in the tab order"', () => {
    // `< 0` and not `!== 0`: 0 is exactly how a container opts into being focusable by script,
    // and the HUD's own panels carry `tabindex="-1"`... on the CONTAINER, which is never inside
    // itself. A filter written as `!== 0` would drop every scripted target in the UI.
    const el = container('<div id="pane" tabindex="0">pane</div><button id="c" type="button">C</button>');
    expect(focusableControls(el).map((c) => c.id)).toEqual(['pane', 'c']);
  });
});
