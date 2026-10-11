import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CLEARANCE_SELECTORS, clearanceFailures, insetLabel } from './clearance.mjs';

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
 *
 * A chip carries the selector `verify.mjs` measured it through (issue #1068): its place among
 * all of the bar's children, so the first shown chip is the second child, after the hidden
 * Practice chip.
 */
const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
const chip = (child: number, left: number, top: number, right: number, bottom: number) => ({
  selector: `.hud-topbar > :nth-child(${child})`,
  ...rect(left, top, right, bottom),
});
const box = (r: ReturnType<typeof rect>, extra: Record<string, string> = {}) => ({
  ...r,
  display: 'block',
  paddingTop: '0px',
  paddingLeft: '0px',
  paddingRight: '0px',
  ...extra,
});

function portrait() {
  const chips = [chip(2, 10, 52, 87, 72), chip(3, 95, 52, 140, 72), chip(4, 148, 52, 193, 72)];
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
  const chips = [chip(2, 59, 13, 168, 39), chip(3, 184, 13, 249, 39), chip(4, 265, 13, 332, 39)];
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

type Measurement = ReturnType<typeof portrait>;
const broken = (base: () => Measurement, change: (m: Measurement) => void) => () => {
  const m = base();
  change(m);
  return m;
};

/**
 * Every failing shape in this file, each a passing fixture with one thing broken. The tests
 * below take their shapes from here rather than building them inline, so the sweep at the end
 * of the file walks every one of them without a second copy.
 */
const FAILING = {
  matchTopbarHidden: broken(portrait, (m) => {
    m.match.topbar = box(rect(0, 0, 0, 0), { display: 'none' });
    m.match.toasts = box(rect(374, 12, 374, 12));
  }),
  topInsetNeverApplied: broken(portrait, (m) => {
    m.match.topbar = box(rect(0, 0, 390, 38), { display: 'flex', paddingTop: '8px' });
  }),
  sideInsetNeverApplied: broken(landscape, (m) => {
    m.match.topbar = box(rect(0, 0, 844, 52), { display: 'flex', paddingTop: '12px', paddingLeft: '18px', paddingRight: '21px' });
  }),
  toastRailInBar: broken(portrait, (m) => {
    m.match.toasts = box(rect(374, 64, 374, 64));
  }),
  flashWithNoBox: broken(landscape, (m) => {
    m.match.capacity = box(rect(823, 26, 823, 26));
  }),
  flashOnChips: broken(portrait, (m) => {
    m.match.capacity = box(rect(60, 56, 138, 82));
  }),
  boardNotFound: broken(landscape, (m) => {
    m.board = null;
  }),
  flashOnBoard: broken(landscape, (m) => {
    m.match.capacity = box(rect(384, 56, 460, 83));
  }),
  flashUnderSideInset: broken(landscape, (m) => {
    m.match.capacity = box(rect(763, 13, 840, 39));
  }),
  flashUnderTopInset: broken(portrait, (m) => {
    m.match.topbar = box(rect(0, 0, 390, 77), { display: 'flex', paddingTop: '47px' });
    m.match.capacity = box(rect(200, 30, 278, 56));
  }),
  chipsMoved: broken(landscape, (m) => {
    m.match.chipsStaged[2] = chip(4, 265, 13, 255, 39);
  }),
  chipAppeared: broken(landscape, (m) => {
    m.match.chipsStaged.push(chip(5, 348, 13, 425, 39));
  }),
  menuTopbarShown: broken(portrait, (m) => {
    m.menu.topbar = box(rect(0, 0, 390, 77), { display: 'flex', paddingTop: '47px' });
  }),
  menuToastsInInset: broken(portrait, (m) => {
    m.menu.toasts = box(rect(374, 14, 374, 14));
  }),
};

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
    expect(clearanceFailures(FAILING.toastRailInBar())).toEqual([
      '390x844 inset=top 47 state=match: toast rail .hud-toasts top 64 overlaps topbar .hud-topbar, whose bottom is 77',
    ]);
  });

  it('fails the capacity flash drawn on the board -- 844x390 just under the bar, issue #702', () => {
    expect(clearanceFailures(FAILING.flashOnBoard())).toEqual([
      '844x390 inset=left 59, right 21 state=match: capacity flash .hud-capacity 384,56 to 460,83 overlaps the drawn board at 208,48 to 635,390',
    ]);
  });

  it('fails the capacity flash inside the bar on top of a chip -- the shipped 56px under a 77px bar', () => {
    expect(clearanceFailures(FAILING.flashOnChips())).toEqual([
      '390x844 inset=top 47 state=match: capacity flash .hud-capacity 60,56 to 138,82 overlaps topbar chip .hud-topbar > :nth-child(2) at 10,52 to 87,72',
      '390x844 inset=top 47 state=match: capacity flash .hud-capacity 60,56 to 138,82 overlaps topbar chip .hud-topbar > :nth-child(3) at 95,52 to 140,72',
    ]);
  });

  it('fails a flash that moves the chips when it shows, which is a chip claiming room in the bar', () => {
    expect(clearanceFailures(FAILING.chipsMoved())).toEqual([
      '844x390 inset=left 59, right 21 state=match: showing capacity flash .hud-capacity moved the chips of topbar .hud-topbar, so it claims room in the bar',
    ]);
    expect(clearanceFailures(FAILING.chipAppeared()), 'a chip that appears is a moved row too').toEqual([
      '844x390 inset=left 59, right 21 state=match: showing capacity flash .hud-capacity moved the chips of topbar .hud-topbar, so it claims room in the bar',
    ]);
  });

  it('fails a flash with no box, instead of judging text that was never staged', () => {
    expect(clearanceFailures(FAILING.flashWithNoBox())).toEqual([
      '844x390 inset=left 59, right 21 state=match: capacity flash .hud-capacity has no box, so its text was never staged and nothing was judged',
    ]);
  });

  it('fails a board the screenshot did not find, instead of clearing nothing', () => {
    expect(clearanceFailures(FAILING.boardNotFound())).toEqual([
      '844x390 inset=left 59, right 21 state=match: the board was not found in the screenshot, so the flash was not judged against it',
    ]);
  });

  it('fails a flash under a side inset, where the camera housing is', () => {
    expect(clearanceFailures(FAILING.flashUnderSideInset())).toEqual([
      '844x390 inset=left 59, right 21 state=match: capacity flash .hud-capacity 763,13 to 840,39 is outside the safe area of a 844px viewport',
    ]);
    expect(clearanceFailures(FAILING.flashUnderTopInset())).toEqual([
      '390x844 inset=top 47 state=match: capacity flash .hud-capacity 200,30 to 278,56 is outside the safe area of a 390px viewport',
    ]);
  });

  it('fails an inset the page never applied, rather than passing a 0px inset as a real one', () => {
    expect(clearanceFailures(FAILING.topInsetNeverApplied())).toEqual([
      '390x844 inset=top 47 state=match: topbar .hud-topbar padding-top 8px ignores the 47px top inset',
    ]);
    expect(clearanceFailures(FAILING.sideInsetNeverApplied())).toEqual([
      '844x390 inset=left 59, right 21 state=match: topbar .hud-topbar padding-left 18px ignores the 59px left inset',
    ]);
    const noInset = portrait();
    noInset.inset = { top: 0, left: 0, right: 0 };
    noInset.menu.toasts = box(rect(374, 14, 374, 14));
    noInset.match.topbar = box(rect(0, 0, 390, 38), { display: 'flex', paddingTop: '8px' });
    expect(clearanceFailures(noInset), 'no inset asked for, none required').toEqual([]);
  });

  it('fails a match whose topbar never showed, instead of clearing nothing', () => {
    expect(clearanceFailures(FAILING.matchTopbarHidden())).toEqual([
      '390x844 inset=top 47 state=match: the match topbar .hud-topbar is not shown, so nothing was cleared',
    ]);
  });

  it('fails a menu toast rail inside the inset once no topbar is there to clear it', () => {
    expect(clearanceFailures(FAILING.menuToastsInInset())).toEqual([
      '390x844 inset=top 47 state=menu: menu toast rail .hud-toasts top 14 is inside the 47px top inset',
    ]);
  });

  it('fails a menu measured with the topbar shown, which is not the no-topbar case', () => {
    expect(clearanceFailures(FAILING.menuTopbarShown())).toEqual([
      '390x844 inset=top 47 state=menu: the menu topbar .hud-topbar is shown, so the no-topbar case was not measured',
    ]);
  });
});

/**
 * Issue #1068's table, one row per `failures.push` site in `clearanceFailures`: the state it
 * measured, the elements its line must name by selector (keys of CLEARANCE_SELECTORS, plus
 * `chip` for the chip's own selector), the failing shapes above that reach it, and its marker,
 * a fragment of that site's wording that no other site prints. The marker is what ties a line
 * to the site it is filed under: rows 1 and 2 owe the same selector and state, so a shape that
 * drifted from one to the other would pass on those alone. Row 6, the board not found, names
 * no element: the board is found in a screenshot and has no selector.
 */
type Names = keyof typeof CLEARANCE_SELECTORS | 'chip';
type Site = {
  row: number;
  state: 'match' | 'menu';
  names: Names[];
  shapes: (keyof typeof FAILING)[];
  marker: string;
};
const SITES: Site[] = [
  { row: 1, state: 'match', names: ['topbar'], shapes: ['matchTopbarHidden'], marker: 'nothing was cleared' },
  { row: 2, state: 'match', names: ['topbar'], shapes: ['topInsetNeverApplied', 'sideInsetNeverApplied'], marker: 'ignores the' },
  { row: 3, state: 'match', names: ['toasts', 'topbar'], shapes: ['toastRailInBar'], marker: 'whose bottom is' },
  { row: 4, state: 'match', names: ['capacity'], shapes: ['flashWithNoBox'], marker: 'has no box' },
  { row: 5, state: 'match', names: ['capacity', 'chip'], shapes: ['flashOnChips'], marker: 'topbar chip' },
  { row: 6, state: 'match', names: [], shapes: ['boardNotFound'], marker: 'not found in the screenshot' },
  { row: 7, state: 'match', names: ['capacity'], shapes: ['flashOnBoard'], marker: 'drawn board' },
  { row: 8, state: 'match', names: ['capacity'], shapes: ['flashUnderSideInset', 'flashUnderTopInset'], marker: 'outside the safe area' },
  { row: 9, state: 'match', names: ['capacity', 'topbar'], shapes: ['chipsMoved', 'chipAppeared'], marker: 'moved the chips' },
  { row: 10, state: 'menu', names: ['topbar'], shapes: ['menuTopbarShown'], marker: 'no-topbar case' },
  { row: 11, state: 'menu', names: ['toasts'], shapes: ['menuToastsInInset'], marker: 'is inside the' },
];

const selectorOf = (name: Names) =>
  name === 'chip' ? `${CLEARANCE_SELECTORS.topbar} > :nth-child(` : CLEARANCE_SELECTORS[name];

/**
 * What one failure line lacks for its row: its state, a selector it owes, one it must not
 * carry, its row's marker, or another row's marker beside its own.
 */
function lineProblems(line: string, site: Site): string[] {
  const problems: string[] = [];
  if (!line.includes(` state=${site.state}: `)) problems.push(`no state=${site.state}`);
  if (site.names.length === 0) {
    for (const sel of Object.values(CLEARANCE_SELECTORS)) {
      if (line.includes(sel)) problems.push(`names ${sel}, but row ${site.row} is about no element`);
    }
  }
  for (const name of site.names) {
    if (!line.includes(selectorOf(name))) problems.push(`no ${selectorOf(name)}`);
  }
  if (!line.includes(site.marker)) problems.push(`not from row ${site.row}`);
  for (const other of SITES) {
    if (other.row !== site.row && line.includes(other.marker)) problems.push(`carries row ${other.row}'s marker`);
  }
  return problems;
}

/** Every line the failing shapes print, each filed under the row its shape is listed in. */
const sweep = (sites: Site[]) =>
  sites.flatMap((site) =>
    site.shapes.flatMap((shape) => clearanceFailures(FAILING[shape]()).map((line) => ({ site, shape, line }))),
  );

/** The rows at least one swept line is filed under, in order; a row missing is a site no shape reaches. */
const rowsReached = (swept: ReturnType<typeof sweep>) => [...new Set(swept.map(({ site }) => site.row))];

describe('clearance failure lines name their element and state (issue #1068)', () => {
  it('walks every failing shape and finds each line naming its selectors and its state', () => {
    // Population: 14 failing shapes, giving 15 lines (the chip shape overlaps 2 chips), reach
    // all 11 push sites, each line carrying its own site's marker and no other's. 10 sites
    // name an element: 13 shapes, 14 lines. 1 site names none, the board not found: 1 shape,
    // 1 line, which must carry no selector.
    const source = readFileSync(new URL('./clearance.mjs', import.meta.url), 'utf8');
    expect(SITES.length, 'a push site in clearance.mjs with no row in the sweep').toBe(source.match(/failures\.push\(/g)?.length);
    expect(SITES.map((s) => s.row)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(SITES.flatMap((s) => s.shapes).sort(), 'a failing shape the sweep skips').toEqual(Object.keys(FAILING).sort());
    const swept = sweep(SITES);
    expect(swept.map(({ site, shape, line }) => [shape, lineProblems(line, site)])).toEqual(
      swept.map(({ shape }) => [shape, []]),
    );
    expect(rowsReached(swept), 'push sites reached by a shape filed under them').toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(swept.length, 'lines swept').toBe(15);
    expect(swept.filter(({ site }) => site.names.length > 0).length, 'lines that name an element').toBe(14);
    expect(new Set(swept.map(({ shape }) => shape)).size, 'shapes that failed').toBe(14);
  });

  it('fails a line with its selector or state taken out, or a board line naming one', () => {
    // Known-bad lines, spelled out rather than taken from the verdict: the first is the
    // row-3 line as it read before issue #1068, with neither selector nor state.
    const row = (n: number) => SITES[n - 1];
    expect(lineProblems('390x844 inset=top 47: toast rail top 64 overlaps the topbar, whose bottom is 77', row(3))).toEqual([
      'no state=match',
      'no .hud-toasts',
      'no .hud-topbar',
    ]);
    expect(
      lineProblems('390x844 inset=top 47 state=match: toast rail .hud-toasts top 64 overlaps the topbar, whose bottom is 77', row(3)),
    ).toEqual(['no .hud-topbar']);
    expect(
      lineProblems('390x844 inset=top 47 state=match: capacity flash .hud-capacity 60,56 to 138,82 overlaps a topbar chip at 10,52 to 87,72', row(5)),
    ).toEqual(['no .hud-topbar > :nth-child(']);
    expect(lineProblems('390x844 inset=top 47 state=match: menu toast rail .hud-toasts top 14 is inside the 47px top inset', row(11))).toEqual([
      'no state=menu',
    ]);
    expect(
      lineProblems('844x390 inset=left 59, right 21 state=match: the board .hud-capacity was not found in the screenshot', row(6)),
    ).toEqual(['names .hud-capacity, but row 6 is about no element']);
  });

  it('fails a line filed under a push site that did not print it, or a site no shape reaches', () => {
    // Known-bad lines, spelled out rather than taken from the verdict. The first is what the
    // hidden-topbar shape printed with the topbar check skipped: row 2's line, which names
    // row 1's selector and state, so only the markers tell the two sites apart.
    const row = (n: number) => SITES[n - 1];
    expect(lineProblems('390x844 inset=top 47 state=match: topbar .hud-topbar padding-top 0px ignores the 47px top inset', row(1))).toEqual([
      'not from row 1',
      "carries row 2's marker",
    ]);
    // A marker that a second site also prints would let a shape drift between the two unseen.
    expect(
      lineProblems('390x844 inset=top 47 state=menu: menu toast rail .hud-toasts top 14 is inside the 47px top inset, whose bottom is 77', row(11)),
    ).toEqual(["carries row 3's marker"]);
    // A row left with no shapes is a push site the sweep no longer reaches.
    expect(rowsReached(sweep(SITES.map((s) => (s.row === 4 ? { ...s, shapes: [] } : s))))).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10, 11]);
  });
});
