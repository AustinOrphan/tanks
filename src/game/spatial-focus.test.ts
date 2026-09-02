import { describe, it, expect } from 'vitest';
import { isDirection, rowsOf, spatialNext, type Candidate, type Direction } from './spatial-focus';

/** A drawn layout: `rows` is a list of rows, each a list of item names; cells are 100x40 with 10px gaps. */
function layout(rows: string[][]): Candidate<string>[] {
  const out: Candidate<string>[] = [];
  rows.forEach((row, r) => {
    row.forEach((item, c) => {
      out.push({ item, rect: { left: c * 110, top: r * 50, width: 100, height: 40 } });
    });
  });
  return out;
}
const move = (cands: Candidate<string>[], from: string | null, dir: Direction): string | null =>
  spatialNext(cands, from, dir);

describe('spatial-focus: rows are derived from geometry, not from DOM order', () => {
  it('groups by vertical overlap and orders each row left to right, whatever order the candidates arrived in', () => {
    const drawn = layout([['a', 'b', 'c'], ['d', 'e']]);
    const shuffled = [drawn[4], drawn[1], drawn[3], drawn[0], drawn[2]];
    expect(rowsOf(shuffled).map((row) => row.map((c) => c.item))).toEqual([['a', 'b', 'c'], ['d', 'e']]);
  });

  it('a control whose centre is off the row but whose edge overlaps it starts a new row -- the wrap case', () => {
    // Two wrapped cards: the second card starts 30px below the first row's top, so its
    // top edge overlaps the first row's span but its centre does not. It is a new row.
    const cands: Candidate<string>[] = [
      { item: 'p', rect: { left: 0, top: 0, width: 100, height: 40 } },
      { item: 'q', rect: { left: 110, top: 0, width: 100, height: 40 } },
      { item: 'r', rect: { left: 0, top: 30, width: 100, height: 40 } },
    ];
    expect(rowsOf(cands).map((row) => row.map((c) => c.item))).toEqual([['p', 'q'], ['r']]);
    // Negative control: shift r up so its centre lands inside the first row's span.
    const joined = [cands[0], cands[1], { item: 'r', rect: { left: 0, top: 10, width: 100, height: 40 } }];
    expect(rowsOf(joined).map((row) => row.map((c) => c.item))).toEqual([['p', 'r', 'q']]);
  });

  it('isDirection names exactly the four directions', () => {
    for (const a of ['up', 'down', 'left', 'right'] as const) expect(isDirection(a), a).toBe(true);
    for (const a of ['confirm', 'back', 'pause'] as const) expect(isDirection(a), a).toBe(false);
  });
});

describe('spatial-focus: every move lands somewhere', () => {
  const grid = layout([['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h']]);

  it('Left and Right walk the row and wrap within it, never leaving it', () => {
    expect(move(grid, 'b', 'right')).toBe('c');
    expect(move(grid, 'c', 'right'), 'Right at the row end did not wrap to its start').toBe('a');
    expect(move(grid, 'a', 'left'), 'Left at the row start did not wrap to its end').toBe('c');
    expect(move(grid, 'h', 'right'), 'a short last row wraps within itself').toBe('g');
    expect(move(grid, 'g', 'left')).toBe('h');
  });

  it('Up and Down move to the adjacent row, on the control whose centre is nearest', () => {
    expect(move(grid, 'b', 'down')).toBe('e');
    expect(move(grid, 'e', 'up')).toBe('b');
    expect(move(grid, 'f', 'down'), 'the nearest control on a shorter row').toBe('h');
    expect(move(grid, 'c', 'down')).toBe('f');
  });

  it('Up from the first row wraps to the last, Down from the last wraps to the first', () => {
    expect(move(grid, 'a', 'up')).toBe('g');
    expect(move(grid, 'h', 'down')).toBe('b');
    expect(move(grid, 'c', 'up'), 'the nearest on the wrapped-to row').toBe('h');
  });

  it('with nothing tracked focused, a forward move enters at the first control and a backward one at the last', () => {
    for (const dir of ['down', 'right'] as const) expect(move(grid, null, dir), dir).toBe('a');
    for (const dir of ['up', 'left'] as const) expect(move(grid, null, dir), dir).toBe('h');
    expect(move(grid, 'not-a-candidate', 'down')).toBe('a');
  });

  it('with no candidates there is nothing to land on', () => {
    expect(move([], 'a', 'down')).toBeNull();
    expect(move([], null, 'left')).toBeNull();
  });
});

describe('spatial-focus: no layout to follow (every rect empty, as jsdom reports)', () => {
  const flat: Candidate<string>[] = ['a', 'b', 'c', 'd'].map((item) => ({
    item,
    rect: { left: 0, top: 0, width: 0, height: 0 },
  }));

  it('Up and Down walk document order and wrap, the pre-#495 cycle', () => {
    expect(move(flat, 'a', 'down')).toBe('b');
    expect(move(flat, 'd', 'down'), 'Down at the end did not wrap').toBe('a');
    expect(move(flat, 'a', 'up'), 'Up at the start did not wrap').toBe('d');
    expect(move(flat, 'c', 'up')).toBe('b');
  });

  it('Left and Right walk the same order, since the one row IS the document', () => {
    expect(move(flat, 'b', 'right')).toBe('c');
    expect(move(flat, 'a', 'left')).toBe('d');
  });

  it('a genuinely single visual row behaves the same way -- the negative control for the fallback', () => {
    // Real geometry, one row: Up/Down would otherwise wrap onto the same row and land on
    // the nearest control, which is the one already focused -- a dead end.
    const row = layout([['a', 'b', 'c']]);
    expect(move(row, 'b', 'down')).toBe('c');
    expect(move(row, 'a', 'up')).toBe('c');
  });
});
