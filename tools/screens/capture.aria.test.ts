// @vitest-environment jsdom
//
// WHAT A CAPTURE RECORDS ABOUT ROLES AND ACCESSIBLE NAMES (issue #937).
//
// `measureInPage` is the function Playwright runs inside the page, and it closes over nothing,
// so jsdom can run the SAME function here. jsdom lays nothing out -- every box is zeros -- so
// this file asserts the `aria` object and the entry's shape, never geometry. The real browser
// run is `npm run screens:check`, against the committed baselines.
import { describe, it, expect, beforeEach } from 'vitest';

import { measure, measureInPage } from './capture.mjs';
import { ARIA_ATTRIBUTES } from './baseline.mjs';

// Each of the nine attributes appears on at least one element, and `.bare` carries only
// attributes the list does not name, which is the negative control for what is NOT recorded.
const PAGE = `
  <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="t" aria-describedby="b">
    <h2 id="t">Title</h2><p id="b">Body</p>
  </div>
  <button class="toggle" aria-pressed="false" aria-label="">Mute</button>
  <nav><a class="here" aria-current="page" href="#">Home</a></nav>
  <div class="live" aria-live="polite" aria-expanded="true">News</div>
  <span class="bare" aria-hidden="true" aria-busy="true" aria-controls="t" title="x">plain</span>
`;
const SELECTORS = ['.dialog', '.toggle', '.here', '.live', '.bare', '.missing'];

type Entry = { selector: string, present: boolean, aria?: Record<string, string>, style?: Record<string, string> };
const run = (): Entry[] => measureInPage([SELECTORS, ['display'], [...ARIA_ATTRIBUTES]]);
const bySelector = (list: Entry[]) => new Map(list.map((e) => [e.selector, e]));

describe('capture.mjs: the aria object each measured element carries (issue #937)', () => {
  beforeEach(() => { document.body.innerHTML = PAGE; });

  it('records each listed attribute the element carries, as its raw string', () => {
    const got = bySelector(run());
    expect(got.get('.dialog')?.aria).toEqual({
      role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 't', 'aria-describedby': 'b',
    });
    expect(got.get('.here')?.aria).toEqual({ 'aria-current': 'page' });
    expect(got.get('.live')?.aria).toEqual({ 'aria-live': 'polite', 'aria-expanded': 'true' });
  });

  it('records an EMPTY attribute as an empty string, distinct from no attribute', () => {
    // `aria-label=""` is a real (and usually wrong) name; dropping it would hide exactly the
    // state a reviewer needs to see. `aria-pressed="false"` is a value, not an absence.
    expect(bySelector(run()).get('.toggle')?.aria).toEqual({ 'aria-label': '', 'aria-pressed': 'false' });
  });

  it('omits the aria object for an element with none of the nine, and records nothing unlisted', () => {
    // `.bare` carries aria-hidden, aria-busy and aria-controls: real attributes the ruling did
    // not name. Neither they nor a null for each of the nine may appear.
    const bare = bySelector(run()).get('.bare');
    expect(bare?.present).toBe(true);
    expect(bare, 'an element with none of the nine wrote an aria key').not.toHaveProperty('aria');
  });

  it('writes the keys in the list\'s order and puts aria before style', () => {
    // Deterministic serialisation, so a re-accept that changes nothing writes the same bytes;
    // and `aria` before `style`, so adding it to a baseline inserts lines rather than editing one.
    const dialog = bySelector(run()).get('.dialog');
    expect(Object.keys(dialog?.aria ?? {})).toEqual(['role', 'aria-labelledby', 'aria-describedby', 'aria-modal']);
    expect(Object.keys(dialog ?? {})).toEqual(['selector', 'present', 'visible', 'box', 'text', 'aria', 'style']);
    expect(Object.keys(bySelector(run()).get('.bare') ?? {}))
      .toEqual(['selector', 'present', 'visible', 'box', 'text', 'style']);
  });

  it('leaves an unmatched selector as it was: present false, and nothing else', () => {
    expect(bySelector(run()).get('.missing')).toEqual({ selector: '.missing', present: false });
  });

  it('is handed the nine names by measure, which is the call a real capture makes', async () => {
    // A page whose evaluate runs the function in place, so what `measure` passes into the
    // browser is what reaches `measureInPage` here.
    const page = { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) };
    const out: Entry[] = await measure(page, ['.dialog', '.toggle'], []);
    expect(out.map((e) => e.aria)).toEqual([
      { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 't', 'aria-describedby': 'b' },
      { 'aria-label': '', 'aria-pressed': 'false' },
    ]);
    // And the watched properties still arrive in the slot before them.
    expect(out[0].style).toHaveProperty('display');
  });
});
