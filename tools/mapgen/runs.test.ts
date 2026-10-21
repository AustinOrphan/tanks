import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RULESETS } from './rulesets.mjs';
import { BOARD, seedRange } from './lib.mjs';
import { MIN_WALL_BLOCK_CELLS, smallWallComponents, wallComponents } from './measure';
import type { GridBoard } from './measure';
import { destructibleReport, runLegs } from './sweep-report.mjs';
import { thicknessReport } from './thickness-gate.mjs';

/**
 * Issue #1029: default `runs` boards have no wall component below `MIN_WALL_BLOCK_CELLS`, the
 * shape every shipped board has (#1028). Population: seeds 1-100, the two disjoint 50-seed
 * samples the issue measures, every board DRAWN -- a superset of the boards the shipped tier
 * accepts, so the acceptance filter is not needed to state it.
 *
 * Each of the two causes has its own control, on literal seeds that exhibit it: the old
 * `minRun` 4 with the confinement on, and the confinement off at the new `minRun`. Each control
 * also checks the fragment is the SHAPE its cause makes, so a fragment from some third cause
 * cannot stand in for it. Since issue #1066 both controls run #1029's generator, masses off and
 * 16 pieces, so their seeds and measured shapes are still #1029's.
 *
 * Issue #1066: masses for cover, then the thin runs for circulation. Every default board for
 * seeds 1-100 lies inside the thickness gate's interior band and at or under the thin ceiling,
 * every mass is one 3x3 module thick and two or three long, and masses off with #1029's 16 pieces
 * is #1029's generator byte for byte. This file may read `thickness-gate.mjs`; the generator
 * must not, and does not.
 */
const generate = RULESETS.runs.generate as (seed: number, opts?: Record<string, unknown>) => GridBoard;

/** #1029's generator: masses off, and the piece count it shipped with. */
const RUNS_1029 = { masses: 0, pieces: 16 };

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

/** A board's wall and destructible cells as fractions of the board, as `BoardMeasures` has them. */
const fractions = (arena: { grid: string[]; legend: Record<string, string> }) => {
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
    // #1029's generator (RUNS_1029). Seeds 1 and 4 measured: 10 such runs each, none against the seam.
    const opts = { ...RUNS_1029, minRun: 4 };
    expect(seedsWithFragments(opts, [1, 4])).toEqual([1, 4]);
    for (const s of [1, 4]) {
      const found = fragments(opts, s);
      expect(found.length, `seed ${s}`).toBeGreaterThan(0);
      for (const cells of found) {
        expect(cells.length, `seed ${s}`).toBe(4);
        expect(isStraight(cells), `seed ${s}: a fragment that is not a straight run`).toBe(true);
        expect(touchesSeam(cells), `seed ${s}: a fragment against the seam is cause 2's shape`).toBe(false);
      }
    }
  });

  it('THE CONTROL for cause 2: the half-board confinement removed, at minRun 5, leaves a piece cut at the seam', () => {
    // #1029's generator (RUNS_1029). Seeds 1 and 4 measured: 4 and 2 fragments of 2-3 cells,
    // every one against the seam.
    const opts = { ...RUNS_1029, confineToHalf: false };
    expect(seedsWithFragments(opts, [1, 4])).toEqual([1, 4]);
    for (const s of [1, 4]) {
      const found = fragments(opts, s);
      expect(found.length, `seed ${s}`).toBeGreaterThan(0);
      for (const cells of found) {
        expect(touchesSeam(cells), `seed ${s}: a fragment away from the seam is not a cut piece`).toBe(true);
      }
    }
  });
});

describe('runs: destructibles over 30% of the wall mass, listed by seed (issue #1029)', () => {
  it('lists the default boards over 30% of their wall cells for seeds 1-100, by seed and share', () => {
    // Population: seeds 1-100, every default board drawn. Each thin piece is destructible with a
    // fixed chance and every mass is solid (issue #1066), so the masses dilute the destructible
    // cells: no board is over the cap, against 26 of these seeds under #1029's thin-only
    // generator. The criterion allows exceptions listed by seed, so the list is pinned exactly,
    // empty, beside the largest share and the count of boards carrying any destructible -- an
    // empty list alone would hold under a lower chance or a mass step that never ran.
    const boards = seedRange(0, 100).map((seed) => ({ seed, m: fractions(generate(seed)) }));
    // Not vacuous: 49 of the 100 boards carry destructibles to count (94 under #1029's generator;
    // 0 under mapgen-runs-draws-no-destructibles, 52 under mapgen-runs-destructible-share-drifts).
    expect(boards.filter((b) => b.m.destructibleFraction > 0).length).toBe(49);
    const report = destructibleReport(boards);
    // Seed 80. A chance of 0.25 (mapgen-runs-destructible-share-drifts) draws 0.280.
    expect(report.max.toFixed(3)).toBe('0.265');
    expect(report.exceptions.map((e) => [e.seed, e.share.toFixed(3)])).toEqual([]);
  });

  it('THE CONTROL: a board 40% destructible by wall cells is reported over the ceiling', () => {
    // Synthetic: 10 wall cells, 4 of them destructible -- 4% of this 100-cell board.
    const over = { grid: ['#'.repeat(6) + 'xxxx' + '.'.repeat(90)], legend: { '#': 'solid', x: 'destructible' } };
    expect(destructibleReport([{ seed: 1, m: fractions(over) }]).exceptions.map((e) => e.seed)).toEqual([1]);
  });
});

/** A board from a picture, as `sweep-report.test.ts` builds them: `#` solid, `.` floor. */
const picture = (rows: string[]): GridBoard => ({
  cols: rows[0].length,
  rows: rows.length,
  legend: { '#': 'solid', x: 'destructible' },
  grid: rows,
});

/**
 * What the masses' construction rules out, read back off a board: a wall component that is no
 * straight run, L or mass (`other`), and a mass that is not one 3x3 module thick and two or three
 * modules long. A filled rectangle at least 3 cells each way of 18 or 27 cells can only be 3x6 or
 * 3x9. Two masses that touch read as `other`, or side by side as one rectangle of 36 or 54, so
 * this is the board-level form of the edge clearance and of the masses' confinement to the half.
 */
const massFaults = (board: GridBoard): string[] => {
  const legs = runLegs(board);
  const faults = legs.masses.filter((size) => size !== 18 && size !== 27).map((size) => `a mass of ${size} cells`);
  if (legs.other > 0) faults.push(`${legs.other} other`);
  return faults;
};

/** SHA-256 of seeds 1-100: each grid's rows joined by a newline, the boards by a blank line. */
const digestOf = (opts: Record<string, unknown>): string => createHash('sha256')
  .update(seedRange(0, 100).map((s) => generate(s, opts).grid.join('\n')).join('\n\n'))
  .digest('hex');

describe('runs: masses for cover and thin runs for circulation (issue #1066)', () => {
  it('puts every default board for seeds 1-100 inside the interior band and at or under the thin ceiling, each with a mass and a thin component', () => {
    // Population: seeds 1-100, every board DRAWN -- a superset of the boards the shipped tier
    // accepts at any N, so the acceptance filter is not needed to state it.
    const boards = seedRange(0, 100).map((seed) => ({ seed, arena: generate(seed) }));
    const t = thicknessReport(boards);
    expect(t.n).toBe(100);
    expect(t.refusedSeeds).toEqual([]);
    expect(t.overCeiling).toBe(0);
    expect(t.withThin).toBe(100);
    expect(boards.filter((b) => runLegs(b.arena).masses.length === 0).map((b) => b.seed)).toEqual([]);
  });

  it('THE CONTROL: masses disabled draws interior share 0 and thin share 1, boards the thickness gate refuses', () => {
    // The issue's named control for the interior band. The thin pieces alone, at the default 2.
    const boards = seedRange(0, 100).map((seed) => ({ seed, arena: generate(seed, { masses: 0 }) }));
    const t = thicknessReport(boards);
    expect(t.passed).toBe(0);
    expect(t.interior.max).toBe(0);
    expect(t.thin.min).toBe(1);
    expect(t.overCeiling).toBe(100);
    expect(boards.filter((b) => runLegs(b.arena).masses.length > 0).map((b) => b.seed)).toEqual([]);
  });

  it('THE CONTROL: no thin pieces draws boards with no thin component', () => {
    // The control for the any-thin count above: masses alone, the option the ruling declined.
    const boards = seedRange(0, 100).map((seed) => ({ seed, arena: generate(seed, { pieces: 0 }) }));
    expect(thicknessReport(boards).withThin).toBe(0);
  });

  it('builds every mass one module thick and two or three modules long, and every other wall component a straight run or an L', () => {
    const faulty = seedRange(0, 100)
      .map((seed) => ({ seed, faults: massFaults(generate(seed)) }))
      .filter((b) => b.faults.length > 0);
    expect(faulty).toEqual([]);
  });

  it('THE CONTROL: masses placed by their centre lines touch, and the read-back refuses the board', () => {
    // The issue's named control for the edge clearance. Clearance from a mass's centre line at
    // its own half-width reaches only its edge, so it admits a second mass that touches it. On
    // the 3-cell lattice that is these three shapes; the real generator is reached by the
    // mutation mapgen-runs-mass-clearance-from-the-centre-line.
    const inAnL = picture([
      '..........',
      '.######...',
      '.######...',
      '.######...',
      '.###......',
      '.###......',
      '.###......',
      '.###......',
      '.###......',
      '.###......',
      '..........',
    ]);
    const atACorner = picture([
      '...........',
      '.###.......',
      '.###.......',
      '.###.......',
      '.###.......',
      '.###.......',
      '.###.......',
      '....######.',
      '....######.',
      '....######.',
      '...........',
    ]);
    const sideBySide = picture(['........', '.######.', '.######.', '.######.', '.######.', '.######.', '.######.', '........']);
    expect(massFaults(inAnL)).toEqual(['1 other']);
    expect(massFaults(atACorner)).toEqual(['1 other']);
    expect(massFaults(sideBySide)).toEqual(['a mass of 36 cells']);
    // The same two bars a module apart, as the clearance from the edge leaves them: no fault.
    const aModuleApart = picture(['...........', '.###...###.', '.###...###.', '.###...###.', '.###...###.', '.###...###.', '.###...###.', '...........']);
    expect(massFaults(aModuleApart)).toEqual([]);
    expect(runLegs(aModuleApart).masses).toEqual([18, 18]);
  });

  it("with masses off and #1029's 16 pieces, draws seeds 1-100 byte for byte as at #1029's merge", () => {
    // Computed before #1066 edited `runs()`, at origin/main 2c750e9e, whose `runs()` is #1029's
    // merge (3ce9449b) unchanged: #1079 changed a comment in `spines()` and nothing else in the
    // file. `{ masses: 0 }` alone does not reproduce it, because the piece default moved to 2.
    expect(digestOf(RUNS_1029)).toBe('5904c31e805ab440816bac11e854b0e67a841ba0618eed3bb7966979d686a6d1');
  });

  it('THE CONTROL: one piece fewer than the half holds moves the digest', () => {
    // 13, not 15: no board for seeds 1-100 places more than 14 pieces a half, so 14 and 15 draw
    // the same boards as 16 and hash the same. 13 is the first count that moves a board.
    expect(digestOf({ ...RUNS_1029, pieces: 13 })).not.toBe(digestOf(RUNS_1029));
  });
});
