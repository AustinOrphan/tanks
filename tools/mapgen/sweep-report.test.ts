import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BAND_HALF_UNIT, DESTRUCTIBLE_WALL_CEILING, SHIPPED_BANDS,
  bandReport, destructibleReport, destructibleShareOfWall, inBand, medianOf, runLegs,
  runLengthReport, seedList, smallBlockReport,
} from './sweep-report.mjs';

/**
 * Issue #1029's reporting, on fixtures where the answer is known by construction. Each test
 * carries the case that would read the same under the plausible wrong version: a band edge at
 * the shipped maximum, a median the mean would put outside, exactly half the boards outside,
 * destructibles over 30% of the wall but under 30% of the board, bars that touch only at a
 * corner, an L that has lost its corner cell, and (issue #1066) a ring whose bounding box is a
 * mass's.
 */

/** A board from a picture: rows of characters, `#` solid, `x` destructible, letters spawns. */
const board = (rows: string[]) => ({
  cols: rows[0].length,
  rows: rows.length,
  legend: { '#': 'solid', x: 'destructible' },
  grid: rows,
});

const SPEC = fileURLToPath(new URL('../../docs/superpowers/specs/2026-09-17-map-generation-rules-design.md', import.meta.url));

describe('the shipped bands and the in-band share (issue #1029)', () => {
  it("carries the spec's shipped band row, column by column", () => {
    // By column NAME, so a column added to the table does not shift the comparison.
    const lines = readFileSync(SPEC, 'utf8').split('\n');
    const row = lines.findIndex((l) => l.startsWith('| shipped band (8 boards) |'));
    expect(row, 'the spec has no shipped band row').toBeGreaterThan(1);
    const cellsOf = (l: string) => l.split('|').slice(1, -1).map((c) => c.trim());
    const header = cellsOf(lines[row - 2]);
    const band = cellsOf(lines[row]);
    const column: Record<string, string> = {
      wall: 'wallFraction', legal: 'legalAreaFraction', corr: 'corridorAreaFraction',
      open: 'openGroundFraction', neck: 'bottleneckWidth', rout: 'routeCount',
      long: 'longestSightlineRelative', sight: 'openSightFraction', bank: 'bankGain',
    };
    const parsed: Record<string, { min: number; max: number }> = {};
    header.forEach((name, i) => {
      if (!(name in column)) return;
      const [min, max] = band[i].split('-').map(Number);
      parsed[column[name]] = { min, max };
    });
    expect(parsed).toEqual(SHIPPED_BANDS);
  });

  it('counts a value inside at two decimals as inside, the shipped 7/3 route count included', () => {
    const route = SHIPPED_BANDS.routeCount;
    expect(inBand(7 / 3, route), 'the shipped maximum, 2.333..., against its own 2.33').toBe(true);
    expect(inBand(2.334, route)).toBe(true);
    expect(inBand(2.336, route)).toBe(false);
    expect(inBand(0.9951, route)).toBe(true);
    expect(inBand(0.9949, route)).toBe(false);
    expect(inBand(Number.NaN, route)).toBe(false);
    expect(BAND_HALF_UNIT).toBe(0.005);
  });

  it('takes the median, not the mean, and reads "most outside" as more than half', () => {
    const band = { x: { min: 0, max: 1 } };
    const verdict = (xs: number[]) => bandReport(xs.map((x) => ({ x })), band)[0];
    expect(verdict([0.2, 0.5, 0.8])).toMatchObject({ n: 3, median: 0.5, inside: 3, share: 1, verdict: 'ok' });
    // The mean is 2.65, outside; the median 0.25 is inside, with 1 of 4 outside.
    const skewed = verdict([0.1, 0.2, 0.3, 10]);
    expect(skewed).toMatchObject({ inside: 3, verdict: 'ok' });
    expect(skewed.median).toBeCloseTo(0.25, 12);
    expect(medianOf([0.1, 0.2, 0.3, 10])).toBeCloseTo(0.25, 12);
    // Median inside, 4 of 5 outside: a miss, not a pass.
    expect(verdict([-1, -1, 0.5, 2, 2])).toMatchObject({ median: 0.5, inside: 1, verdict: 'miss' });
    // Exactly half outside is not MOST outside.
    expect(verdict([-1, 0.5, 0.6, 2])).toMatchObject({ inside: 2, verdict: 'ok' });
    expect(verdict([2, 2, 0.5])).toMatchObject({ median: 2, medianInBand: false, verdict: 'out' });
    // A board with no finite value counts against the share, not the median.
    expect(verdict([0.5, Number.NaN, 0.5])).toMatchObject({ n: 3, median: 0.5, inside: 2 });
    const empty = verdict([]);
    expect(empty.verdict).toBe('none');
    expect(empty.share).toBeNaN();
  });

  it('reports every band, in the order of the row', () => {
    const fields = bandReport([]).map((b) => b.field);
    expect(fields).toEqual(Object.keys(SHIPPED_BANDS));
    expect(fields).toContain('longestSightlineRelative');
  });
});

describe('destructibles over wall mass (issue #1029)', () => {
  it('divides by the wall, not the board: 4% of the board is 40% of a 10% wall', () => {
    expect(destructibleShareOfWall({ wallFraction: 0.1, destructibleFraction: 0.04 })).toBeCloseTo(0.4, 12);
    const report = destructibleReport([
      { seed: 7, m: { wallFraction: 0.1, destructibleFraction: 0.04 } },
      { seed: 8, m: { wallFraction: 0.1, destructibleFraction: 0.02 } },
    ]);
    expect(report.n).toBe(2);
    expect(report.max).toBeCloseTo(0.4, 12);
    expect(report.exceptions.map((e) => e.seed)).toEqual([7]);
  });

  it('passes a board at exactly 30% and reads a board with no wall as 0, not 0/0', () => {
    expect(DESTRUCTIBLE_WALL_CEILING).toBe(0.3);
    // 3 destructible cells of 10 wall cells on the 891-cell board.
    const atCeiling = { wallFraction: 10 / 891, destructibleFraction: 3 / 891 };
    expect(destructibleReport([{ seed: 1, m: atCeiling }]).exceptions).toEqual([]);
    expect(destructibleShareOfWall({ wallFraction: 0, destructibleFraction: 0 })).toBe(0);
    expect(destructibleReport([]).max).toBeNaN();
  });
});

describe('small wall components, 8- and 4-connected (issue #1029)', () => {
  it('counts two 3-cell bars touching at a corner as small only 4-connected', () => {
    const corner = board(['........', '.###....', '....###.', '........']);
    const clean = board(['........', '.#####..', '........']);
    const report = smallBlockReport([{ seed: 3, arena: corner }, { seed: 4, arena: clean }]);
    expect(report).toEqual({ n: 2, with8: 0, with4: 1, exceptions: [{ seed: 3, c8: 0, c4: 2 }] });
  });
});

describe('the run-length read-back (issue #1029)', () => {
  it("reads a straight run, and an L's longer leg as the run and its shorter leg less the corner as the arm", () => {
    const b = board([
      '..........',
      '.#####....',
      '..........',
      '.######...',
      '......#...',
      '......#...',
      '......#...',
      '..........',
      '........#.',
      '........#.',
      '.....####.',
      '..........',
    ]);
    const legs = runLegs(b);
    expect([...legs.runs].sort((a, c) => a - c)).toEqual([4, 5, 6]);
    expect([...legs.arms].sort((a, c) => a - c)).toEqual([2, 3]);
    expect(legs).toMatchObject({ straight: 1, bent: 2, other: 0 });
  });

  it('reads a block, a T and an L missing its corner cell as other', () => {
    const b = board([
      '..........',
      '.##...###.',
      '.##....#..',
      '.......#..',
      '..........',
      '..##......',
      '.#........',
      '.#........',
      '..........',
    ]);
    // The corner-less L is one component 8-connected, and its cells all lie on one row and
    // one column of its bounding box -- only its cell count says it is not an L.
    expect(runLegs(b)).toEqual({ runs: [], arms: [], masses: [], straight: 0, bent: 0, other: 3 });
  });

  it('sums the components and summarises the lengths over a sample of boards', () => {
    const one = board(['.......', '.#####.', '.......']);
    const two = board(['.........', '.#######.', '.........', '.#.......', '.#.......', '.###.....', '.........']);
    const report = runLengthReport([one, two]);
    expect(report).toMatchObject({ boards: 2, straight: 2, bent: 1, other: 0 });
    expect(report.runs).toEqual({ n: 3, min: 3, median: 5, max: 7 });
    expect(report.arms).toEqual({ n: 1, min: 2, median: 2, max: 2 });
  });
});

describe('the mass read-back (issue #1066)', () => {
  it('reads a filled rectangle at least three cells each way as a mass, and a hollow ring or a slab two cells thick as other', () => {
    // A 3x3 module (9 cells), a 3x6 bar (18), a 4x4 ring with no middle (12 of its 16 cells) and a
    // 6x2 slab (12). The ring's and the slab's bounding boxes are as wide as a mass's; only the
    // cell count says the ring is hollow, and only the 2-cell side says the slab is not a mass.
    const b = board([
      '..................',
      '.###..###..####...',
      '.###..###..#..#...',
      '.###..###..#..#...',
      '......###..####...',
      '......###.........',
      '......###.........',
      '..................',
      '.######...........',
      '.######...........',
      '..................',
    ]);
    const legs = runLegs(b);
    expect([...legs.masses].sort((a, c) => a - c)).toEqual([9, 18]);
    expect(legs).toMatchObject({ runs: [], arms: [], straight: 0, bent: 0, other: 2 });
  });

  it('summarises the mass sizes over a sample of boards', () => {
    // One board with a 3x6 bar, a 3x3 module and a straight run; one with a 9x3 bar.
    const one = board(['..........', '.###..###.', '.###..###.', '.###..###.', '......###.', '......###.', '......###.', '..........', '.#####....', '..........']);
    const two = board(['...........', '.#########.', '.#########.', '.#########.', '...........']);
    const report = runLengthReport([one, two]);
    expect(report.masses).toEqual({ n: 3, min: 9, median: 18, max: 27 });
    expect(report).toMatchObject({ boards: 2, straight: 1, bent: 0, other: 0 });
  });
});

describe('seed lists (issue #1029)', () => {
  it('compacts consecutive seeds into ranges, sorted and without repeats', () => {
    expect(seedList([9, 3, 1, 2, 7, 10, 2])).toBe('1-3, 7, 9-10');
    expect(seedList([5])).toBe('5');
    expect(seedList([])).toBe('none');
  });
});
