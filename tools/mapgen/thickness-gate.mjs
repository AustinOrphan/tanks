import { interiorShare, thicknessCounts, thinShare } from './measure';
import { SPREAD_TOLERANCE, ceilingFor } from './spread-gate.mjs';
import { medianOf } from './sweep-report.mjs';

/**
 * THE SECOND GATE THE QUALITY TIER FEEDS (issue #1065): a generated board's interior share.
 *
 * The thickness ruling on #821 (2026-10-09) chose a mix of thin runs and masses: mirror the
 * shipped set, thin runs for circulation and masses for cover, the interior share gated to the
 * band the shipped boards span, the thin share a minority. It was chosen over keeping
 * one-cell-thick runs as the whole construction and over replacing them with masses. Both
 * figures are `measure.ts`'s, over wall cells only: an INTERIOR cell is a wall cell whose four
 * orthogonal neighbours are all wall (`interiorShare`), and a THIN component is an 8-connected
 * wall component with no interior cell (`thinShare`). The ruling gates the interior share. "A
 * minority" is a criterion on the thin share, reported against a ceiling and not a second gate.
 *
 * WHY THIS IS AN EXCEPTION AND NOT A PRECEDENT, for the spread gate's reasons: it gates the one
 * measure its ruling names; it runs in `sweep.mjs` after generation and after the shipped
 * acceptance tier, so the tiers before it are unchanged; no ruleset imports this module or reads
 * the band, so none can redraw against it; and the band is a literal derived from the shipped
 * boards. The thin share, block size and every other quality measure stay reported, not gated,
 * and no other quality measure becomes a gate without its own ruling.
 *
 * THREE LIMITS TO CARRY WITH THESE NUMBERS:
 *   - Nine boards are not a sample of good boards. The band describes what ships.
 *   - "Thin" means no interior cell, not one cell thick. The literal one-cell-thick cells, in no
 *     all-wall 2x2 square, are 48 of the 1,410 shipped wall cells (3.4%), all on vs-duel-01 (22)
 *     and vs-tri-01 (26); vs-tri-01's 8 thin components are slabs and rings 2 cells thick, of 5
 *     to 18 cells.
 *   - A crossing counts as interior. Two of vs-duel-01's 5 components are bars 2 cells thick
 *     crossing, with an interior cell and no all-wall 3x3 square, and 6 of the 11 interior cells
 *     behind its 0.0940 are theirs. Under the stricter test "the component contains a 3x3
 *     square" the thin cells would be 146 (10.4% of 1,410), vs-duel-01's thin share 0.7179, and
 *     the ceiling different. The ruling's own definition, no interior cell, is the one built here.
 *
 * Kept out of `measure.ts` (which stays numbers only) and out of `src/sim/` (the generator is
 * tooling), in an importable module so the comparison and the report are under test --
 * `sweep.mjs` is a CLI the mutation harness cannot import, so it only calls
 * `passesThicknessGate` and `thicknessReport`.
 */

/**
 * The float tolerance, shared with the spread gate so both gates round their literals by one
 * rule: `ceilingFor` is that module's and `floorFor` below is its mirror. A share is a quotient
 * of two cell counts; the tolerance absorbs the float error of rounding it at two decimals.
 */
export const THICKNESS_TOLERANCE = SPREAD_TOLERANCE;

/**
 * The band a generated board's interior share must lie in, edges included.
 *
 * DERIVED, by the ruled rule: the per-board minimum and maximum interior share over the shipped
 * boards (`ARENA_DEFS`), the minimum rounded DOWN and the maximum rounded UP at two decimals
 * under the tolerance (`floorFor`, `ceilingFor`). Measured when this landed, over the 9 boards:
 * 0.0940 (vs-duel-01, 11 of 117 wall cells) to 0.3405 (vs-quad-01, 95 of 279) -- the same
 * extremes as over the 8 boards counted before vs-quad-02, which measures 0.2991 (70 of 234).
 * So the band is 0.09 to 0.35, and it refuses no board that ships. The two-decimal description
 * "0.09 to 0.34" quoted elsewhere in the tree is a record, not a limit: 0.34 would refuse
 * vs-quad-01. `thickness-gate.test.ts` recomputes both edges by the rule, so a board that moves
 * an extreme fails that test instead of moving the band silently.
 *
 * Nine authored boards are not a sample of good boards: this bounds a generated board by what
 * ships, nothing more.
 */
export const INTERIOR_SHARE_MIN = 0.09;
export const INTERIOR_SHARE_MAX = 0.35;

/**
 * The ceiling the thin share is REPORTED against; nothing is refused on it.
 *
 * DERIVED the same way: the per-board maximum thin share (8-connected) over the shipped boards,
 * 0.3690 (vs-tri-01, 62 of 168 wall cells), rounded up. The shipped figures are bimodal, 0.0000
 * on 7 of the 9 boards and 0.2906 (vs-duel-01) and 0.3690 on the other two, so the thin share
 * has no floor -- one would refuse 7 of the 9 -- and "a minority" holds on every shipped board.
 * The pooled share, 96 of 1,410 wall cells (6.8%; 96 of 1,176, 8.2%, over the 8 boards before
 * vs-quad-02), is reported beside a sample's and is not a limit: as a per-board limit it would
 * refuse vs-duel-01 and vs-tri-01.
 */
export const THIN_SHARE_CEILING = 0.37;

export { ceilingFor };

/** A minimum rounded down at two decimals, under the tolerance: `ceilingFor`'s mirror. */
export function floorFor(minimum) {
  return Math.floor((minimum + THICKNESS_TOLERANCE) * 100) / 100;
}

/**
 * Whether a board passes the thickness gate: its interior share at least the minimum and at
 * most the maximum, within the float tolerance. A board with no wall cells reads 0 and is
 * refused, and so is a share that is not a number.
 *
 * @param {number} share the board's `interiorShare`
 * @returns {boolean}
 */
export function passesThicknessGate(share) {
  return share >= INTERIOR_SHARE_MIN - THICKNESS_TOLERANCE
    && share <= INTERIOR_SHARE_MAX + THICKNESS_TOLERANCE;
}

/**
 * The sweep's thickness block for one sample, normally the boards the shipped tier accepted
 * for one (ruleset, player count): how many the gate passes and every seed it refuses; the
 * min / median / max interior share and thin share (8-connected) over all of them; how many are
 * over the thin ceiling; the pooled thin share, thin cells over wall cells summed over the
 * sample; and how many boards have any thin component. A refused seed is reported, not retried.
 *
 * The median is `medianOf`'s (issue #1029), which interpolates. The band test is the gate's
 * own, not `inBand`'s: the band's edges are already rounded outward, and `inBand`'s half unit
 * on top would count a board at 0.354 inside a band the gate refuses it from.
 *
 * @param {readonly { seed: number | string, arena: import('./measure').GridBoard }[]} boards
 */
export function thicknessReport(boards) {
  const read = boards.map((b) => ({
    seed: b.seed,
    interior: interiorShare(b.arena),
    thin: thinShare(b.arena, 8),
    counts: thicknessCounts(b.arena, 8),
  }));
  const summary = (xs) => ({
    min: xs.length ? Math.min(...xs) : NaN,
    median: medianOf(xs),
    max: xs.length ? Math.max(...xs) : NaN,
  });
  const wallCells = read.reduce((sum, b) => sum + b.counts.wallCells, 0);
  const thinCells = read.reduce((sum, b) => sum + b.counts.thinCells, 0);
  const passing = read.filter((b) => passesThicknessGate(b.interior));
  return {
    n: read.length,
    passed: passing.length,
    refusedSeeds: read.filter((b) => !passing.includes(b)).map((b) => b.seed),
    interior: summary(read.map((b) => b.interior)),
    thin: summary(read.map((b) => b.thin)),
    overCeiling: read.filter((b) => b.thin > THIN_SHARE_CEILING + THICKNESS_TOLERANCE).length,
    wallCells,
    thinCells,
    pooledThin: wallCells > 0 ? thinCells / wallCells : read.length ? 0 : NaN,
    withThin: read.filter((b) => b.counts.thinComponents > 0).length,
  };
}
