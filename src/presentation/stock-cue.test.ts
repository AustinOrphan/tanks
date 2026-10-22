import { describe, it, expect } from 'vitest';
import {
  narrowMarkLayout, narrowPipLayout, NARROW_STRIP_QUERY, stockRowFor, type MarkLayout, type PipLayout,
  type StockRow,
} from './stock-cue';
import type { IdentityMarkerStyle } from './identity-marker';

/**
 * Issue #1022: which row draws a stock entry is ONE rule -- `marks` for an entry with no team
 * whose resolved marker is `shape`, `pips` for every other combination -- and this is the table.
 *
 * Population: entry (FFA, teams) x resolved marker (`shape`, `null`) = 4 cells; `arcs` and
 * `roof` left the table when issue #1023 deleted them, so `shape` is the one non-null marker.
 * `null` is both the reversal value `solid` and a HUD built without the option; the absent flag
 * resolves to `shape` before this rule sees it, so "absent" is a cell only at the HUD seam
 * (`hud.match.test.ts`, which mounts it).
 */
describe('stock cue: the strip\'s one row rule (issue #1022)', () => {
  /** A teams entry's team; any team takes the same branch, so one stands for all three. */
  const TEAM = 1;
  const EXPECTED: Record<string, StockRow> = {
    'ffa x shape': 'marks',
    'ffa x null': 'pips',
    'teams x shape': 'pips',
    'teams x null': 'pips',
  };
  type Rule = (team: number | undefined, marker: IdentityMarkerStyle | null) => StockRow;
  const args = (cell: string): [number | undefined, IdentityMarkerStyle | null] => {
    const [kind, marker] = cell.split(' x ');
    return [kind === 'teams' ? TEAM : undefined, marker === 'null' ? null : (marker as IdentityMarkerStyle)];
  };
  /** The cells where `rule` disagrees with the table. */
  const mismatches = (rule: Rule): string[] =>
    Object.entries(EXPECTED).filter(([cell, want]) => rule(...args(cell)) !== want).map(([cell]) => cell);

  it('draws the row the table names in every one of the 4 cells', () => {
    expect(Object.keys(EXPECTED)).toHaveLength(4);
    expect(mismatches(stockRowFor)).toEqual([]);
  });

  it('THE NEGATIVE CONTROLS, one per cell: a rule wrong in that cell alone is caught there', () => {
    // Without these the table check could be comparing nothing -- a `mismatches` that never
    // reported a cell would pass the case above for any rule at all.
    const other = (row: StockRow): StockRow => (row === 'marks' ? 'pips' : 'marks');
    for (const cell of Object.keys(EXPECTED)) {
      const [t, m] = args(cell);
      const wrongHere: Rule = (team, marker) =>
        team === t && marker === m ? other(stockRowFor(team, marker)) : stockRowFor(team, marker);
      expect(mismatches(wrongHere), cell).toEqual([cell]);
    }
  });

  it('every team takes the teams branch, not only the one the table uses', () => {
    // Teams has three sides (A, B, C); a rule that tested `team === 1` would pass the table.
    for (const team of [0, 1, 2]) {
      expect(stockRowFor(team, 'shape'), `team ${team}`).toBe('pips');
    }
    // NEGATIVE CONTROL: the same marker with no team is the shipped row.
    expect(stockRowFor(undefined, 'shape')).toBe('marks');
  });
});

/**
 * Issue #835: the `pips` row overflowed a 390px viewport and clipped its last entry silently,
 * because the strip is a nowrap flex row with no wrapping or scrolling.
 *
 * Every number here came from real Chromium layout at 390px against the real stylesheet
 * (`tools/hud/strip-width.mjs`, which is checked in so the measurement can be repeated). These
 * cases pin the TABLE; the tool proves the widths.
 */
describe('stock cue: pip sizing on a narrow viewport (issue #835)', () => {
  it('leaves two- and three-player strips at the shipped size where they already fit', () => {
    // Measured: 2 players never exceeds the budget at any stock count, and 3 players fits up
    // to four stocks. Shrinking those would be a cost with nothing bought.
    for (const total of [1, 2, 3, 4, 5]) {
      expect(narrowPipLayout(2, total), `2p x ${total}`).toEqual({ kind: 'row', pip: 10, gap: 3 });
    }
    for (const total of [1, 2, 3, 4]) {
      expect(narrowPipLayout(3, total), `3p x ${total}`).toEqual({ kind: 'row', pip: 10, gap: 3 });
    }
  });

  it('steps down only where the shipped size overflowed', () => {
    // 3p x 5 measured 271.3px against a 254.1px budget; 4p x 3 measured 261.1px, the 7px
    // overflow the issue reported. Both carry a 9px pip.
    expect(narrowPipLayout(3, 5)).toEqual({ kind: 'row', pip: 9, gap: 2 });
    expect(narrowPipLayout(4, 3)).toEqual({ kind: 'row', pip: 9, gap: 2 });
    expect(narrowPipLayout(4, 1)).toEqual({ kind: 'row', pip: 9, gap: 2 });
  });

  it('keeps ONE pip and states the count, rather than dropping the shape entirely', () => {
    // Four players at four or five stocks fits a full row only at 7px and 6px, with about ONE
    // pixel of margin -- fragile, and self-defeating since `pips` is the arm that turns the
    // count into shape.
    //
    // THE FALLBACK IS NOT A BARE DIGIT, and that was the first answer and wrong twice over: it
    // drops the shape channel this arm exists to provide, and it leaves the loss cue with
    // nothing to animate, because the cue IS the pip swelling and bursting. An entry that
    // cannot burst is the absence of the arm, not a degraded form of it.
    expect(narrowPipLayout(4, 4)).toEqual({ kind: 'one', pip: 10 });
    expect(narrowPipLayout(4, 5)).toEqual({ kind: 'one', pip: 10 });
  });

  it('never draws a pip below the 8px legibility floor, in either layout', () => {
    // The property that makes the null meaningful: every size it DOES return is one a player
    // can count. Population: every player count the game allows (2-4) against every versus
    // stock setting (1-5).
    for (let slots = 2; slots <= 4; slots++) {
      for (let total = 1; total <= 5; total++) {
        const layout = narrowPipLayout(slots, total);
        expect(layout.pip, `${slots}p x ${total}`).toBeGreaterThanOrEqual(8);
        if (layout.kind === 'row') {
          expect(layout.gap, `${slots}p x ${total}`).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it('is scoped to the phone tier the measurement was taken at', () => {
    // A media query rather than a layout read: the strip is rebuilt on every status that
    // moves, and measuring it each time would force a reflow in the HUD path.
    expect(NARROW_STRIP_QUERY).toBe('(max-width: 480px)');
  });

});

/**
 * Issue #1021: the `marks` row had no narrow-viewport handling at all, so four players at four
 * or five stocks drew a strip wider than a 390px phone and clipped the last entry silently.
 *
 * The table is measured, by `tools/hud/strip-width.mjs` at 390px against the real stylesheet;
 * these cases pin it, the tool proves the widths.
 */
describe('stock cue: mark sizing on a narrow viewport (issue #1021)', () => {
  /** The measured table, every configuration the game offers: 2-4 players x 1-5 stocks. */
  const EXPECTED: Record<string, MarkLayout> = {};
  for (let slots = 2; slots <= 4; slots++) {
    for (let total = 1; total <= 5; total++) EXPECTED[`${slots}x${total}`] = { kind: 'full' };
  }
  EXPECTED['4x4'] = { kind: 'row', mark: 8, gap: 2 };
  EXPECTED['4x5'] = { kind: 'one' };

  /** The cells where `rule` disagrees with the measured table. */
  const mismatches = (rule: (slots: number, total: number) => MarkLayout): string[] =>
    Object.entries(EXPECTED)
      .filter(([cell, want]) => {
        const [slots, total] = cell.split('x').map(Number);
        return JSON.stringify(rule(slots, total)) !== JSON.stringify(want);
      })
      .map(([cell]) => cell);

  it('matches the measured table in every one of the 15 configurations', () => {
    expect(Object.keys(EXPECTED)).toHaveLength(15);
    expect(mismatches(narrowMarkLayout)).toEqual([]);
  });

  it('THE NEGATIVE CONTROLS, one per table cell: a rule wrong in that cell alone is caught there', () => {
    // Without these the table check could be comparing nothing -- a `mismatches` that never
    // reported a cell would pass the case above for any rule at all.
    const other = (l: MarkLayout): MarkLayout => (l.kind === 'one' ? { kind: 'full' } : { kind: 'one' });
    for (const cell of Object.keys(EXPECTED)) {
      const [s, t] = cell.split('x').map(Number);
      const wrongHere = (slots: number, total: number): MarkLayout =>
        slots === s && total === t ? other(narrowMarkLayout(slots, total)) : narrowMarkLayout(slots, total);
      expect(mismatches(wrongHere), cell).toEqual([cell]);
    }
  });

  it('leaves every strip that already fits at the full size, including 3x5 and 4x3', () => {
    // The derivation in the issue expected 3x5 over by about 4px; measured, it is 18.8px inside
    // the budget, and 4x3 35.6px inside. Shrinking them would be a cost with nothing bought.
    expect(narrowMarkLayout(3, 5)).toEqual({ kind: 'full' });
    expect(narrowMarkLayout(4, 3)).toEqual({ kind: 'full' });
  });

  it('shrinks four players at four stocks to an 8px row, not a fallback', () => {
    // Measured 12px over at full size and 18.5px inside at 8/2. The 9/2 row fits by 2.5px,
    // which is the one-pixel fragility the pips table refused.
    expect(narrowMarkLayout(4, 4)).toEqual({ kind: 'row', mark: 8, gap: 2 });
  });

  it('falls back to one mark and the count at four players and five stocks', () => {
    // 8px marks overflow by 5.5px even at a 1px gap; only 7px fits, below the floor.
    expect(narrowMarkLayout(4, 5)).toEqual({ kind: 'one' });
  });

  it('never draws a row of marks below the 8px floor, or with a gap under 2px', () => {
    // Population: every player count the game allows (2-4) against every stock setting (1-5).
    for (let slots = 2; slots <= 4; slots++) {
      for (let total = 1; total <= 5; total++) {
        const layout = narrowMarkLayout(slots, total);
        if (layout.kind !== 'row') continue;
        expect(layout.mark, `${slots}p x ${total}`).toBeGreaterThanOrEqual(8);
        expect(layout.gap, `${slots}p x ${total}`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

/**
 * Issue #1055: a teams entry draws `P1 A ` before its pips -- every teams entry draws pips
 * (`stockRowFor`) -- so it is wider than the FFA entry the pips table was chosen from, by a space
 * and a letter.
 *
 * Measured on the real HUD at 390px by `tools/hud/strip-width.mjs`, the letter fits at every rung
 * `narrowPipLayout` already takes, so a teams entry is laid out by that same rule, and these cases
 * pin it over the teams population: Teams is offered at three and four players only, so 3-4
 * players x 1-5 stocks, 10 configurations. The figure beside each cell is the px left inside the
 * topbar's content box.
 */
describe('stock cue: a teams entry on a narrow viewport (issue #1055)', () => {
  const ROW10: PipLayout = { kind: 'row', pip: 10, gap: 3 };
  const ROW9: PipLayout = { kind: 'row', pip: 9, gap: 2 };
  const ONE: PipLayout = { kind: 'one', pip: 10 };
  /** The measured table, spelled out cell by cell. */
  const EXPECTED: Record<string, PipLayout> = {
    '3x1': ROW10, // 166.6 spare
    '3x2': ROW10, // 127.6
    '3x3': ROW10, // 88.6
    '3x4': ROW10, // 49.6
    '3x5': ROW9, // 37.6
    '4x1': ROW9, // 112.8
    '4x2': ROW9, // 68.8
    '4x3': ROW9, // 24.8
    '4x4': ONE, // 54.4; an 8px row overflows by 3.2 with a 2px gap (an 8/1 row would fit by 8.8)
    '4x5': ONE, // 54.4; an 8px row overflows by 43.2 with a 2px gap, 27.2 with a 1px gap
  };

  /** The cells where `rule` disagrees with the measured table. */
  const mismatches = (rule: (slots: number, total: number) => PipLayout): string[] =>
    Object.entries(EXPECTED)
      .filter(([cell, want]) => {
        const [slots, total] = cell.split('x').map(Number);
        return JSON.stringify(rule(slots, total)) !== JSON.stringify(want);
      })
      .map(([cell]) => cell);

  it('takes the rung measured to hold the letter in every one of the 10 teams configurations', () => {
    expect(Object.keys(EXPECTED)).toHaveLength(10);
    expect(mismatches(narrowPipLayout)).toEqual([]);
  });

  it('THE NEGATIVE CONTROLS, one per table cell: a rule wrong in that cell alone is caught there', () => {
    // Without these the table check could be comparing nothing -- a `mismatches` that never
    // reported a cell would pass the case above for any rule at all.
    const other = (l: PipLayout): PipLayout => (l.kind === 'one' ? ROW9 : ONE);
    for (const cell of Object.keys(EXPECTED)) {
      const [s, t] = cell.split('x').map(Number);
      const wrongHere = (slots: number, total: number): PipLayout =>
        slots === s && total === t ? other(narrowPipLayout(slots, total)) : narrowPipLayout(slots, total);
      expect(mismatches(wrongHere), cell).toEqual([cell]);
    }
  });
});
