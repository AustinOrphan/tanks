// @vitest-environment jsdom
//
// The in-page half of the clearance check (issue #1068). `MEASURE_CLEARANCE` runs inside the
// page through `page.evaluate`, so before this file nothing but the required `visual` job ever
// executed it, and a selector it could not find was a browser-run failure only. Here it runs
// against a page built by hand, whose elements have names of their own, and against the HUD's
// real markup.
//
// jsdom has no layout, so every element is given a box: `data-rect="left,top,right,bottom"`
// where a case needs particular edges, 0,0 to 10,10 otherwise. Which chips are shown is then
// decided by `display` alone, which jsdom does resolve, from hud.css for the real HUD.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHud, type Hud } from '../../src/game/hud';
import { CLEARANCE_SELECTORS } from './clearance.mjs';
import { MEASURE_CLEARANCE } from './verify.mjs';

function layout() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const [left, top, right, bottom] = (this.getAttribute('data-rect') ?? '0,0,10,10').split(',').map(Number);
    return { left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) };
  });
}

/** Selectors no HUD element carries, so a measurement that ignores its argument finds nothing. */
const PROBE = { topbar: '.probe-bar', toasts: '.probe-rail', capacity: '.probe-flash' };

/**
 * A bar of four children: a hidden first child, the way Practice leads the real bar outside
 * Level Select; a shown chip; a zero-width one; and a second shown chip. So the shown chips are
 * the 2nd and 4th children, and the 1st and 2nd of those shown.
 */
function probePage() {
  document.body.innerHTML = `
    <div class="probe-bar" data-rect="0,0,390,77" style="display: flex">
      <div style="display: none">Practice</div>
      <div data-rect="10,52,87,72">Lives</div>
      <div data-rect="95,52,95,72"></div>
      <div data-rect="95,52,140,72">Level</div>
    </div>
    <div class="probe-rail" data-rect="374,89,374,89"></div>
    <div class="probe-flash" data-rect="156,81,234,107"></div>`;
}

let hud: Hud | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

describe('clearance measurement in the page (issue #1068)', () => {
  it("names each shown chip by its place among all of the bar's children, through the selectors it is handed", () => {
    probePage();
    layout();
    expect(MEASURE_CLEARANCE({ stage: true, selectors: PROBE }).chips).toEqual([
      { selector: '.probe-bar > :nth-child(2)', top: 52, bottom: 72, left: 10, right: 87 },
      { selector: '.probe-bar > :nth-child(4)', top: 52, bottom: 72, left: 95, right: 140 },
    ]);
    // Control: the same page through the shipped selectors finds none of its elements, so the
    // measurement above found them through the selectors it was handed.
    expect(() => MEASURE_CLEARANCE({ stage: true, selectors: CLEARANCE_SELECTORS })).toThrow(
      /^clearance: \.hud-\w+ matches 0 elements, not 1$/,
    );
  });

  it('throws, naming the selector, rather than measure one that matches several elements or none', () => {
    probePage();
    layout();
    // A second bar makes every chip's `:nth-child` selector match a chip in each.
    document.body.append(document.querySelector('.probe-bar')!.cloneNode(true));
    expect(() => MEASURE_CLEARANCE({ stage: false, selectors: PROBE })).toThrow(
      'clearance: .probe-bar > :nth-child(2) matches 2 elements, not 1',
    );
    probePage();
    document.body.append(document.querySelector('.probe-flash')!.cloneNode(true));
    expect(() => MEASURE_CLEARANCE({ stage: false, selectors: PROBE })).toThrow(
      'clearance: .probe-flash matches 2 elements, not 1',
    );
    probePage();
    document.querySelector('.probe-rail')!.remove();
    expect(() => MEASURE_CLEARANCE({ stage: false, selectors: PROBE })).toThrow(
      'clearance: .probe-rail matches 0 elements, not 1',
    );
  });

  it("measures the HUD's own markup through CLEARANCE_SELECTORS, every selector naming one element", () => {
    const root = document.createElement('div');
    document.body.append(root);
    hud = createHud(root);
    layout();
    // Throws in the page if any of the three selectors, or any shown chip's, matches other
    // than one element of the real HUD.
    const m = MEASURE_CLEARANCE({ stage: true, selectors: CLEARANCE_SELECTORS });
    expect(m.chips.length, 'no chip is shown, so no chip selector was checked').toBeGreaterThan(0);
    // Control: a selector renamed in one place, here the argument, matches nothing in the HUD.
    const renamed = { ...CLEARANCE_SELECTORS, toasts: '.hud-toast' };
    expect(() => MEASURE_CLEARANCE({ stage: true, selectors: renamed })).toThrow(
      'clearance: .hud-toast matches 0 elements, not 1',
    );
  });
});
