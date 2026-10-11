import { describe, expect, it } from 'vitest';
import { RULESETS } from './rulesets.mjs';
import { BOARD, seedRange } from './lib.mjs';
import { MIN_WALL_BLOCK_CELLS, smallWallComponents, wallComponents } from './measure';
import { destructibleReport } from './sweep-report.mjs';

/**
 * Issue #1029: default `runs` boards have no wall component below `MIN_WALL_BLOCK_CELLS`, the
 * shape every shipped board has (#1028). Population: seeds 1-100, the two disjoint 50-seed
 * samples the issue measures, every board DRAWN -- a superset of the boards the shipped tier
 * accepts, so the acceptance filter is not needed to state it.
 *
 * Each of the two causes has its own control, on literal seeds that exhibit it: the old
 * `minRun` 4 with the confinement on, and the confinement off at the new `minRun`. Each control
 * also checks the fragment is the SHAPE its cause makes, so a fragment from some third cause
 * cannot stand in for it.
 */
const generate = RULESETS.runs.generate as (seed: number, opts?: Record<string, unknown>) => {
  cols: number; rows: number; grid: string[]; legend: Record<string, string>;
};

/** The seeds whose board has a wall component below the threshold, either connectivity. */
const seedsWithFragments = (opts: Record<string, unknown> | undefined, seeds: readonly number[]): number[] =>
  seeds.filter((s) => {
    const arena = generate(s, opts);
    return smallWallComponents(arena, 8) > 0 || smallWallComponents(arena, 4) > 0;
  });

/** The components below the threshold, as cell lists. */
const fragments = (opts: Record<string, unknown>, seed: number): [number, number][][] =>
  wallComponents(generate(seed, opts), 8).filter((cells) => cells.length < MIN_WALL_BLOCK_CELLS);

/**
 * Whether a component sits against the rotation seam: a first-half cell whose next cell along
 * a row or down a column is at or past the midpoint index, or the antipodal copy of one. A
 * piece `rotate180` cut keeps exactly such an edge.
 */
const half = (BOARD.rows * BOARD.cols) / 2;
const at = (c: number, r: number): number => r * BOARD.cols + c;
const touchesSeam = (cells: [number, number][]): boolean => cells.some(([c, r]) => (at(c, r) < half
  ? at(c + 1, r) >= half || at(c, r + 1) >= half
  : at(c - 1, r) < half || at(c, r - 1) < half));

const isStraight = (cells: [number, number][]): boolean =>
  new Set(cells.map(([c]) => c)).size === 1 || new Set(cells.map(([, r]) => r)).size === 1;

/** A board's cells, wall cells and destructible cells, counted by the legend. */
const cellCounts = (arena: { grid: string[]; legend: Record<string, string> }) => {
  let wall = 0;
  let destructible = 0;
  let total = 0;
  for (const row of arena.grid) {
    for (const ch of row) {
      total++;
      const kind = arena.legend[ch];
      if (kind === 'solid' || kind === 'destructible') wall++;
      if (kind === 'destructible') destructible++;
    }
  }
  return { total, wall, destructible };
};

/** A board's wall and destructible cells as fractions of the board, as `BoardMeasures` has them. */
const fractions = (arena: { grid: string[]; legend: Record<string, string> }) => {
  const { total, wall, destructible } = cellCounts(arena);
  return { wallFraction: wall / total, destructibleFraction: destructible / total };
};

describe('runs: no wall component below 5 cells (issue #1029)', () => {
  it('draws no wall component below 5 cells, 8- or 4-connected, on any default board for seeds 1-100', () => {
    const seeds = seedRange(0, 100);
    expect(seeds.length).toBe(100);
    // Not vacuous: every board in the population has walls to count.
    for (const s of seeds) expect(wallComponents(generate(s), 8).length, `seed ${s} drew no wall`).toBeGreaterThan(0);
    expect(seedsWithFragments(undefined, seeds)).toEqual([]);
  });

  it('THE CONTROL for cause 1: the old minRun 4, confinement still on, draws a 4-cell straight run', () => {
    // Seeds 1 and 4 measured: 10 such runs each, none against the seam.
    expect(seedsWithFragments({ minRun: 4 }, [1, 4])).toEqual([1, 4]);
    for (const s of [1, 4]) {
      const found = fragments({ minRun: 4 }, s);
      expect(found.length, `seed ${s}`).toBeGreaterThan(0);
      for (const cells of found) {
        expect(cells.length, `seed ${s}`).toBe(4);
        expect(isStraight(cells), `seed ${s}: a fragment that is not a straight run`).toBe(true);
        expect(touchesSeam(cells), `seed ${s}: a fragment against the seam is cause 2's shape`).toBe(false);
      }
    }
  });

  it('THE CONTROL for cause 2: the half-board confinement removed, at minRun 5, leaves a piece cut at the seam', () => {
    // Seeds 1 and 4 measured: 4 and 2 fragments of 2-3 cells, every one against the seam.
    expect(seedsWithFragments({ confineToHalf: false }, [1, 4])).toEqual([1, 4]);
    for (const s of [1, 4]) {
      const found = fragments({ confineToHalf: false }, s);
      expect(found.length, `seed ${s}`).toBeGreaterThan(0);
      for (const cells of found) {
        expect(touchesSeam(cells), `seed ${s}: a fragment away from the seam is not a cut piece`).toBe(true);
      }
    }
  });
});

describe('runs: destructibles at most 30% of the wall mass (issue #1029)', () => {
  it('keeps destructibles at or under 30% of the wall cells on every default board for seeds 1-100', () => {
    const boards = seedRange(0, 100).map((seed) => ({ seed, m: fractions(generate(seed)) }));
    // Not vacuous: the population carries destructibles to count (94 of the 100 boards, measured).
    // Before the trim, 11 of seeds 1-50 and 15 of 51-100 drew over the ceiling.
    expect(boards.filter((b) => b.m.destructibleFraction > 0).length).toBeGreaterThan(50);
    expect(destructibleReport(boards).exceptions).toEqual([]);
  });

  it('trims only boards over the ceiling, only down to it, last placed first, moving no wall cell: seeds 1-100 pinned', () => {
    // A finished board cannot show what the trim did, so the population's totals pin it.
    // Population: seeds 1-100, every default board drawn; 26 draw over the cap and are trimmed,
    // the other 74 keep their draw byte for byte. Each pin moves under a mapgen-runs-trim-* entry:
    // - wall cells 13424: the trim turns pieces solid and removes none (12790 if it removed them);
    // - destructible cells 2450: trimming past the cap (1778 at 20%), touching a board already
    //   under it (2248), first placed first (2436) or removing the piece (2330) each move it;
    // - boards carrying destructibles 94: 93 trimming to 20%, 89 touching boards under the cap;
    // - boards ending above 0.28, seeds 33, 38, 65 and 97: 33 and 65 draw there and are left
    //   alone, and 38 and 97 are trimmed to 0.283 and 0.290, so a lower cap trims all four.
    const boards = seedRange(0, 100).map((seed) => ({ seed, ...cellCounts(generate(seed)) }));
    expect(boards.length).toBe(100);
    expect(boards.reduce((sum, b) => sum + b.wall, 0)).toBe(13424);
    expect(boards.reduce((sum, b) => sum + b.destructible, 0)).toBe(2450);
    expect(boards.filter((b) => b.destructible > 0).length).toBe(94);
    expect(boards.filter((b) => b.destructible / b.wall > 0.28).map((b) => b.seed)).toEqual([33, 38, 65, 97]);
  });

  it('THE CONTROL: a board 40% destructible by wall cells is reported over the ceiling', () => {
    // Synthetic: 10 wall cells, 4 of them destructible -- 4% of this 100-cell board.
    const over = { grid: ['#'.repeat(6) + 'xxxx' + '.'.repeat(90)], legend: { '#': 'solid', x: 'destructible' } };
    expect(destructibleReport([{ seed: 1, m: fractions(over) }]).exceptions.map((e) => e.seed)).toEqual([1]);
  });
});
