// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { arrivalTarget, focusableControls, focusInView } from './focusable';

/**
 * ONE case, and it is here because it is the only one the `createHud` tests cannot reach
 * (issue #556).
 *
 * The rest of this module is covered where it always was. Measured by mutation against
 * `hud.navigation.test.ts` (split since, issue #1093, into the files its header names),
 * `hud.surfaces.test.ts` and `hud.controls.test.ts`: making `isHiddenWithin` ignore ancestors
 * fails 3 cases, keeping disabled buttons fails 2, keeping hidden ones fails 8, removing
 * `captureFocus`'s no-op fails 1, and dropping its same-row fallback fails 1. Re-testing any of
 * those here would duplicate a real test with a fixture.
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

/**
 * Where an arriving surface puts focus (issue #919): its primary action, in the order declared,
 * when that control can take focus, else the container. Every `hud.ts` surface passes through
 * here, but no shipped surface declares a candidate outside itself, so that fallback is pinned
 * only by this fixture.
 */
describe('arrivalTarget (issue #919)', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  const pane = (html: string): HTMLElement => {
    const el = document.createElement('div');
    el.tabIndex = -1;
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  };
  const byId = (root: HTMLElement, id: string): HTMLElement => root.querySelector(`#${id}`) as HTMLElement;

  it('takes the first candidate in the order DECLARED, not the order of the markup', () => {
    const el = pane('<button id="a" type="button">A</button><button id="b" type="button">B</button>');
    expect(arrivalTarget(el, [byId(el, 'b'), byId(el, 'a')])).toBe(byId(el, 'b'));
  });

  it('passes over a candidate that is hidden, inside a hidden wrapper, or disabled', () => {
    const el = pane(`
      <button id="hidden" type="button" style="display:none">Hidden</button>
      <div style="display:none"><button id="wrapped" type="button">Wrapped</button></div>
      <button id="off" type="button" disabled>Off</button>
      <button id="on" type="button">On</button>
    `);
    const candidates = ['hidden', 'wrapped', 'off', 'on'].map((id) => byId(el, id));
    expect(arrivalTarget(el, candidates)).toBe(byId(el, 'on'));
    // NEGATIVE CONTROL: with the one focusable candidate gone, nothing in the list qualifies.
    expect(arrivalTarget(el, candidates.slice(0, 3))).toBe(el);
  });

  it('falls back to the container for no candidates, and for a candidate outside it', () => {
    const el = pane('<button id="inside" type="button">Inside</button>');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    expect(arrivalTarget(el, [])).toBe(el);
    expect(arrivalTarget(el, [outside]), 'focus left the surface that arrived').toBe(el);
    // NEGATIVE CONTROL: the same container with a candidate inside it lands there.
    expect(arrivalTarget(el, [byId(el, 'inside')])).toBe(byId(el, 'inside'));
  });
});

/**
 * How an arrival puts focus on its target (issue #919): without the browser's focus scroll,
 * scrolling the target's scroller only when the target is out of its view.
 *
 * jsdom lays nothing out, so each case states the geometry Chromium reports -- `offsetTop` up
 * the offset-parent chain, the scroller's `clientHeight` -- and records every write to the
 * scroller's `scrollTop`. The numbers are Versus Setup's at 1280x800: an 800px pane, a 49px
 * Start, its sticky bar stuck at 715 with Start 24px inside it.
 */
describe('focusInView (issue #919)', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const set = (el: HTMLElement, props: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(props)) {
      Object.defineProperty(el, key, { configurable: true, value });
    }
  };
  /** An 800px scroller at `scrollTop`, and the record of every `scrollTop` written to it. */
  const scroller = (scrollTop: number): { el: HTMLElement; writes: number[] } => {
    const el = document.createElement('div');
    el.style.overflowY = 'auto';
    document.body.appendChild(el);
    const writes: number[] = [];
    let current = scrollTop;
    set(el, { clientHeight: 800 });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => current,
      set: (v: number) => {
        writes.push(v);
        current = v;
      },
    });
    return { el, writes };
  };
  /** A 49px button at `offsetTop` inside `parent`, which is its offset parent. */
  const control = (parent: HTMLElement, offsetTop: number): HTMLButtonElement => {
    const btn = document.createElement('button');
    parent.appendChild(btn);
    set(btn, { offsetParent: parent, offsetTop, offsetHeight: 49 });
    return btn;
  };

  it('focuses without the browser\'s focus scroll, and leaves a control already in view alone', () => {
    // Start inside its sticky bar, which Chromium reports at its STUCK offset: 715 + 24 = 739,
    // so 739..788 of an 800px view. The browser's focus scroll judged the entrance's transformed
    // box, 16px lower and 4px out, and scrolled.
    const { el: pane, writes } = scroller(0);
    const bar = document.createElement('div');
    pane.appendChild(bar);
    set(bar, { offsetParent: pane, offsetTop: 715, clientTop: 0 });
    const start = control(bar, 24);
    const focus = vi.spyOn(start, 'focus');
    focusInView(start);
    expect(document.activeElement).toBe(start);
    expect(focus.mock.calls, 'focus took the browser\'s scroll').toEqual([[{ preventScroll: true }]]);
    expect(writes, 'a control already in view scrolled its pane').toEqual([]);
  });

  it('scrolls just far enough to show a control below the view, measured through every offset parent', () => {
    // A card 1000px down, with a 2px border, holds the control 300px in: its top is 1302 and
    // its bottom 1351, 551px past an 800px view.
    const { el: pane, writes } = scroller(0);
    const card = document.createElement('div');
    pane.appendChild(card);
    set(card, { offsetParent: pane, offsetTop: 1000, clientTop: 2 });
    const start = control(card, 300);
    focusInView(start);
    expect(document.activeElement).toBe(start);
    expect(writes, 'the pane did not bring the control\'s bottom edge to its own').toEqual([551]);
    // NEGATIVE CONTROL: the first case, where a control in view writes nothing.
  });

  it('scrolls back just far enough to show a control above the view', () => {
    const { el: pane, writes } = scroller(500);
    const start = control(pane, 100);
    focusInView(start);
    expect(writes, 'the pane did not bring the control\'s top edge to its own').toEqual([100]);
    // NEGATIVE CONTROL: the first case, where a control in view writes nothing.
  });
});
