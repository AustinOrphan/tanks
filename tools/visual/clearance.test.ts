import { describe, expect, it } from 'vitest';

import { clearanceFailures, insetLabel } from './clearance.mjs';

/**
 * The verdict `verify.mjs` applies to what it measures around the topbar (issue #687). The
 * browser half cannot run here, so these cases are the verdict's negative controls: each one
 * is a measurement shape that must fail, beside the passing shape it departs from.
 *
 * Two passing fixtures, one per placement of the capacity flash:
 * - `portrait()` is shaped on Chromium at 390x844 with a 47px top inset: topbar padding-top
 *   47px, bottom 77, the flash just under the bar, and the board starting at y 303.
 * - `landscape()` is shaped on 844x390 with a 59px left and a 21px right inset: the flash at
 *   the right-hand end of the bar's own row, and the board's top edge at y 48, above the
 *   bar's 52px bottom. That overlap is why the flash cannot sit under the bar there.
 */
const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
const box = (r: ReturnType<typeof rect>, extra: Record<string, string> = {}) => ({
  ...r,
  display: 'block',
  paddingTop: '0px',
  paddingLeft: '0px',
  paddingRight: '0px',
  ...extra,
});

function portrait() {
  const chips = [rect(10, 52, 87, 72), rect(95, 52, 140, 72), rect(148, 52, 193, 72)];
  return {
    viewport: '390x844',
    inset: { top: 47, left: 0, right: 0 },
    width: 390,
    height: 844,
    menu: { topbar: box(rect(0, 0, 0, 0), { display: 'none' }), toasts: box(rect(374, 47, 374, 47)) },
    match: {
      topbar: box(rect(0, 0, 390, 77), { display: 'flex', paddingTop: '47px', paddingLeft: '10px', paddingRight: '10px' }),
      toasts: box(rect(374, 89, 374, 89)),
      capacity: box(rect(156, 81, 234, 107)),
      chips,
      chipsStaged: chips.map((c) => ({ ...c })),
    },
    board: rect(24, 303, 365, 700),
  };
}

function landscape() {
  const chips = [rect(59, 13, 168, 39), rect(184, 13, 249, 39), rect(265, 13, 332, 39)];
  return {
    viewport: '844x390',
    inset: { top: 0, left: 59, right: 21 },
    width: 844,
    height: 390,
    menu: { topbar: box(rect(0, 0, 0, 0), { display: 'none' }), toasts: box(rect(828, 14, 828, 14)) },
    match: {
      topbar: box(rect(0, 0, 844, 52), { display: 'flex', paddingTop: '12px', paddingLeft: '59px', paddingRight: '21px' }),
      toasts: box(rect(828, 64, 828, 64)),
      capacity: box(rect(746, 13, 823, 39)),
      chips,
      chipsStaged: chips.map((c) => ({ ...c })),
    },
    board: rect(208, 48, 635, 390),
  };
}

describe('topbar clearance verdict (issue #687)', () => {
  it('passes both placements: under the bar in portrait, in the bar row in landscape', () => {
    expect(clearanceFailures(portrait())).toEqual([]);
    expect(clearanceFailures(landscape())).toEqual([]);
  });

  it('passes a flash that only shares an edge with a chip or the board', () => {
    const chipEdge = landscape();
    chipEdge.match.capacity = box(rect(332, 13, 409, 39));
    expect(clearanceFailures(chipEdge), 'touching a chip is not overlapping it').toEqual([]);
    const boardEdge = portrait();
    boardEdge.match.capacity = box(rect(156, 277, 234, 303));
    expect(clearanceFailures(boardEdge), 'touching the board is not overlapping it').toEqual([]);
  });

  it('names the insets a case applied', () => {
    expect(insetLabel({ top: 0, left: 0, right: 0 })).toBe('0');
    expect(insetLabel({ top: 59, left: 0, right: 0 })).toBe('top 59');
    expect(insetLabel({ top: 0, left: 59, right: 21 })).toBe('left 59, right 21');
  });

  it('fails the toast rail starting inside the bar -- the shipped 64px under a 77px bar', () => {
    const m = portrait();
    m.match.toasts = box(rect(374, 64, 374, 64));
    expect(clearanceFailures(m)).toEqual([
      '390x844 inset=top 47: toast rail top 64 overlaps the topbar, whose bottom is 77',
    ]);
  });

  it('fails the capacity flash drawn on the board -- 844x390 just under the bar, issue #702', () => {
    const m = landscape();
    m.match.capacity = box(rect(384, 56, 460, 83));
    expect(clearanceFailures(m)).toEqual([
      '844x390 inset=left 59, right 21: capacity flash 384,56 to 460,83 overlaps the drawn board at 208,48 to 635,390',
    ]);
  });

  it('fails the capacity flash inside the bar on top of a chip -- the shipped 56px under a 77px bar', () => {
    const m = portrait();
    m.match.capacity = box(rect(60, 56, 138, 82));
    expect(clearanceFailures(m)).toEqual([
      '390x844 inset=top 47: capacity flash 60,56 to 138,82 overlaps a topbar chip at 10,52 to 87,72',
      '390x844 inset=top 47: capacity flash 60,56 to 138,82 overlaps a topbar chip at 95,52 to 140,72',
    ]);
  });

  it('fails a flash that moves the chips when it shows, which is a chip claiming room in the bar', () => {
    const m = landscape();
    m.match.chipsStaged[2] = rect(265, 13, 255, 39);
    expect(clearanceFailures(m)).toEqual([
      "844x390 inset=left 59, right 21: showing the capacity flash moved the topbar's chips, so it claims room in the bar",
    ]);
    const extra = landscape();
    extra.match.chipsStaged.push(rect(348, 13, 425, 39));
    expect(clearanceFailures(extra), 'a chip that appears is a moved row too').toEqual([
      "844x390 inset=left 59, right 21: showing the capacity flash moved the topbar's chips, so it claims room in the bar",
    ]);
  });

  it('fails a flash with no box, instead of judging text that was never staged', () => {
    const m = landscape();
    m.match.capacity = box(rect(823, 26, 823, 26));
    expect(clearanceFailures(m)).toEqual([
      '844x390 inset=left 59, right 21: the capacity flash has no box, so its text was never staged and nothing was judged',
    ]);
  });

  it('fails a board the screenshot did not find, instead of clearing nothing', () => {
    const m = landscape();
    m.board = null;
    expect(clearanceFailures(m)).toEqual([
      '844x390 inset=left 59, right 21: the board was not found in the screenshot, so the flash was not judged against it',
    ]);
  });

  it('fails a flash under a side inset, where the camera housing is', () => {
    const right = landscape();
    right.match.capacity = box(rect(763, 13, 840, 39));
    expect(clearanceFailures(right)).toEqual([
      '844x390 inset=left 59, right 21: capacity flash 763,13 to 840,39 is outside the safe area of a 844px viewport',
    ]);
    const top = portrait();
    top.match.topbar = box(rect(0, 0, 390, 77), { display: 'flex', paddingTop: '47px' });
    top.match.capacity = box(rect(200, 30, 278, 56));
    expect(clearanceFailures(top)).toEqual([
      '390x844 inset=top 47: capacity flash 200,30 to 278,56 is outside the safe area of a 390px viewport',
    ]);
  });

  it('fails an inset the page never applied, rather than passing a 0px inset as a real one', () => {
    const m = portrait();
    m.match.topbar = box(rect(0, 0, 390, 38), { display: 'flex', paddingTop: '8px' });
    expect(clearanceFailures(m)).toEqual(['390x844 inset=top 47: topbar padding-top 8px ignores the 47px top inset']);
    const side = landscape();
    side.match.topbar = box(rect(0, 0, 844, 52), { display: 'flex', paddingTop: '12px', paddingLeft: '18px', paddingRight: '21px' });
    expect(clearanceFailures(side)).toEqual([
      '844x390 inset=left 59, right 21: topbar padding-left 18px ignores the 59px left inset',
    ]);
    const noInset = portrait();
    noInset.inset = { top: 0, left: 0, right: 0 };
    noInset.menu.toasts = box(rect(374, 14, 374, 14));
    noInset.match.topbar = box(rect(0, 0, 390, 38), { display: 'flex', paddingTop: '8px' });
    expect(clearanceFailures(noInset), 'no inset asked for, none required').toEqual([]);
  });

  it('fails a match whose topbar never showed, instead of clearing nothing', () => {
    const m = portrait();
    m.match.topbar = box(rect(0, 0, 0, 0), { display: 'none' });
    m.match.toasts = box(rect(374, 12, 374, 12));
    expect(clearanceFailures(m)).toEqual(['390x844 inset=top 47: the match topbar is not shown, so nothing was cleared']);
  });

  it('fails a menu toast rail inside the inset once no topbar is there to clear it', () => {
    const m = portrait();
    m.menu.toasts = box(rect(374, 14, 374, 14));
    expect(clearanceFailures(m)).toEqual(['390x844 inset=top 47: menu toast rail top 14 is inside the 47px top inset']);
  });

  it('fails a menu measured with the topbar shown, which is not the no-topbar case', () => {
    const m = portrait();
    m.menu.topbar = box(rect(0, 0, 390, 77), { display: 'flex', paddingTop: '47px' });
    expect(clearanceFailures(m)).toEqual([
      '390x844 inset=top 47: the menu topbar is shown, so the no-topbar case was not measured',
    ]);
  });
});
