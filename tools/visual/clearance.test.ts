import { describe, expect, it } from 'vitest';

import { clearanceFailures } from './clearance.mjs';

/**
 * The verdict `verify.mjs` applies to what it measures under the topbar (issue #687). The
 * browser half cannot run here, so these cases are the verdict's negative controls: each
 * one is a measurement shape that must fail, beside the passing shape it departs from.
 *
 * The passing fixture is a real reading, from Chromium at 390x844 with a 47px top inset on
 * the fixed tree: topbar padding-top 47px, bottom 77, both overlays positioned from that
 * bottom edge.
 */
const box = (top: number, bottom: number, extra: Record<string, string> = {}) => ({
  top,
  bottom,
  display: 'block',
  paddingTop: '0px',
  ...extra,
});

function holding() {
  return {
    viewport: '390x844',
    inset: 47,
    height: 844,
    menu: { topbar: box(0, 0, { display: 'none' }), toasts: box(47, 47) },
    match: {
      topbar: box(0, 77, { display: 'flex', paddingTop: '47px' }),
      toasts: box(89, 89),
      capacity: box(81, 81),
    },
  };
}

describe('topbar clearance verdict (issue #687)', () => {
  it('passes a measurement where both overlays start at or below the bar', () => {
    expect(clearanceFailures(holding())).toEqual([]);
    const touching = holding();
    touching.match.capacity = box(77, 77);
    expect(clearanceFailures(touching), 'touching the edge is not overlapping it').toEqual([]);
  });

  it('fails the toast rail starting inside the bar -- the shipped 64px under a 77px bar', () => {
    const m = holding();
    m.match.toasts = box(64, 64);
    expect(clearanceFailures(m)).toEqual([
      '390x844 inset=47: toast rail top 64 overlaps the topbar, whose bottom is 77',
    ]);
  });

  it('fails the capacity flash starting inside the bar -- the shipped 56px under a 77px bar', () => {
    const m = holding();
    m.match.capacity = box(56, 56);
    expect(clearanceFailures(m)).toEqual([
      '390x844 inset=47: capacity flash top 56 overlaps the topbar, whose bottom is 77',
    ]);
  });

  it('fails a capacity flash pushed down into the arena centre', () => {
    const m = holding();
    m.match.capacity = box(422, 442);
    expect(clearanceFailures(m)).toEqual([
      '390x844 inset=47: capacity flash top 422 is not above the centre of a 844px viewport',
    ]);
  });

  it('fails an inset the page never applied, rather than passing a 0px inset as 47', () => {
    const m = holding();
    m.match.topbar = box(0, 38, { display: 'flex', paddingTop: '8px' });
    expect(clearanceFailures(m)).toEqual([
      '390x844 inset=47: topbar padding-top 8px ignores the 47px inset',
    ]);
    const noInset = holding();
    noInset.inset = 0;
    noInset.menu.toasts = box(14, 14);
    noInset.match.topbar = box(0, 38, { display: 'flex', paddingTop: '8px' });
    expect(clearanceFailures(noInset), 'no inset asked for, none required').toEqual([]);
  });

  it('fails a match whose topbar never showed, instead of clearing nothing', () => {
    const m = holding();
    m.match.topbar = box(0, 0, { display: 'none' });
    m.match.toasts = box(12, 12);
    expect(clearanceFailures(m)).toEqual([
      '390x844 inset=47: the match topbar is not shown, so nothing was cleared',
    ]);
  });

  it('fails a menu toast rail inside the inset once no topbar is there to clear it', () => {
    const m = holding();
    m.menu.toasts = box(14, 14);
    expect(clearanceFailures(m)).toEqual([
      '390x844 inset=47: menu toast rail top 14 is inside the 47px inset',
    ]);
  });

  it('fails a menu measured with the topbar shown, which is not the no-topbar case', () => {
    const m = holding();
    m.menu.topbar = box(0, 77, { display: 'flex', paddingTop: '47px' });
    expect(clearanceFailures(m)).toEqual([
      '390x844 inset=47: the menu topbar is shown, so the no-topbar case was not measured',
    ]);
  });
});
