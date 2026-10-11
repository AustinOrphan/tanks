import { describe, expect, it } from 'vitest';
import { RULESETS } from './rulesets.mjs';
import { BOARD, seedRange } from './lib.mjs';
import { MIN_WALL_BLOCK_CELLS, smallWallComponents, wallComponents } from './measure';

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
