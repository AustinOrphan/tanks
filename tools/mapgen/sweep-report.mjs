import { smallWallComponents, wallComponents } from './measure';
import { spreadOf } from './expressive-range.mjs';

/**
 * What `sweep.mjs` reports beyond its table of means (issue #1029): per-board medians against
 * the shipped bands with the share of boards inside each, small wall components 8- and
 * 4-connected, destructibles against the wall-mass ceiling, and the run-length read-back.
 *
 * In an importable module for the reason `spread-gate.mjs` gives: `sweep.mjs` is a CLI the
 * mutation harness cannot import, so a branch that lived only there could not be proved by a
 * failing mutation. The sweep only calls these. NOTHING HERE GATES: every function reports,
 * and no ruleset reads any of it.
 *
 * Shared by design with issue #1065, which also reports medians and in-band shares: whichever
 * of the two lands second reuses `medianOf`, `inBand` and `bandReport` rather than adding
 * another.
 */

/**
 * The spec's "shipped band (8 boards)" row (map-generation-rules-design.md, under "A fourth
 * ruleset"), CARRIED as issue #1029 rules rather than re-measured, and pinned to that row by
 * `sweep-report.test.ts`. vs-quad-02, added to the catalog after the row, is not in it.
 *
 * Carried means its quirks come with it. The open-ground floor of 0.01 sits above vs-tri-01's
 * 0.00 in the spec's own calibration table, and the open-sight floor of 0.17 below the 0.176
 * `SHIPPED_RANGES` records, so this row is the bands a generated board is read against, not a
 * fresh envelope of the shipped set.
 */
export const SHIPPED_BANDS = Object.freeze({
  wallFraction: Object.freeze({ min: 0.08, max: 0.37 }),
  legalAreaFraction: Object.freeze({ min: 0.28, max: 0.78 }),
  corridorAreaFraction: Object.freeze({ min: 0.01, max: 0.84 }),
  openGroundFraction: Object.freeze({ min: 0.01, max: 0.57 }),
  bottleneckWidth: Object.freeze({ min: 1.33, max: 6.0 }),
  routeCount: Object.freeze({ min: 1.0, max: 2.33 }),
  longestSightlineRelative: Object.freeze({ min: 0.6, max: 0.82 }),
  openSightFraction: Object.freeze({ min: 0.17, max: 0.43 }),
  bankGain: Object.freeze({ min: 0.09, max: 0.29 }),
});

/**
 * Half a unit in the bands' last place. The edges are TWO-DECIMAL figures read off unrounded
 * measures, so a value is inside when it is inside at two decimals: the route-count ceiling
 * 2.33 is the shipped boards' 7/3 = 2.333..., and a strict comparison would put a board
 * exactly at that shipped maximum outside the band it came from.
 */
export const BAND_HALF_UNIT = 0.005;

/** The median of the finite values (interpolated, `spreadOf`'s), or NaN when there are none. */
export function medianOf(values) {
  return spreadOf(values).median;
}

/**
 * Whether a value lies inside a band, edges included, at the band's two-decimal precision. A
 * non-finite value is outside.
 *
 * @param {number} value @param {{ min: number, max: number }} band
 */
export function inBand(value, band) {
  return Number.isFinite(value) && value >= band.min - BAND_HALF_UNIT && value <= band.max + BAND_HALF_UNIT;
}

/**
 * Per band: the median over the boards, how many lie inside it, and a verdict.
 *
 * `ok` is a median inside with most boards not outside; `miss` is a median inside with MOST
 * boards outside -- more than half -- which issue #1029 requires reported as a miss rather
 * than passed on the strength of the median; `out` is a median outside; `none` is an empty
 * sample. `n` counts every board, so a board whose measure is not finite counts against the
 * share while the median is taken over the finite ones.
 *
 * @param {readonly Record<string, number>[]} measures
 * @param {Record<string, { min: number, max: number }>} [bands]
 */
export function bandReport(measures, bands = SHIPPED_BANDS) {
  return Object.entries(bands).map(([field, band]) => {
    const values = measures.map((m) => m[field]);
    const n = values.length;
    const median = medianOf(values);
    const inside = values.filter((v) => inBand(v, band)).length;
    const medianInBand = inBand(median, band);
    let verdict = 'ok';
    if (n === 0) verdict = 'none';
    else if (!medianInBand) verdict = 'out';
    else if ((n - inside) * 2 > n) verdict = 'miss';
    return { field, band, n, median, inside, share: n ? inside / n : NaN, medianInBand, verdict };
  });
}

/**
 * Destructibles may be at most this share of a board's wall mass, counted in cells: the spec's
 * proposal 4 ("cap destructibles at about 30% of wall mass").
 */
export const DESTRUCTIBLE_WALL_CEILING = 0.3;

/** Float tolerance on the ceiling: the share is a quotient of two quotients. */
export const DESTRUCTIBLE_TOLERANCE = 1e-9;

/**
 * Destructible cells over wall cells. `BoardMeasures` carries both as fractions of the WHOLE
 * board, so their quotient is the share of wall mass; a board with no wall has no destructible
 * share at all, and reads 0 rather than 0/0.
 *
 * @param {{ wallFraction: number, destructibleFraction: number }} m
 */
export function destructibleShareOfWall(m) {
  return m.wallFraction > 0 ? m.destructibleFraction / m.wallFraction : 0;
}

/**
 * The largest destructible share over the boards, and every board over the ceiling by seed.
 *
 * @param {readonly { seed: number, m: { wallFraction: number, destructibleFraction: number } }[]} boards
 */
export function destructibleReport(boards, ceiling = DESTRUCTIBLE_WALL_CEILING) {
  const shares = boards.map((b) => ({ seed: b.seed, share: destructibleShareOfWall(b.m) }));
  return {
    n: boards.length,
    max: shares.length ? Math.max(...shares.map((s) => s.share)) : NaN,
    exceptions: shares.filter((s) => s.share > ceiling + DESTRUCTIBLE_TOLERANCE),
  };
}

/**
 * How many boards have a wall component below `MIN_WALL_BLOCK_CELLS`, under each connectivity,
 * and which ones by seed. Both are reported because they disagree where blocks meet at a
 * corner: two bars touching diagonally are one component 8-connected and two 4-connected.
 *
 * @param {readonly { seed: number, arena: import('./measure').GridBoard }[]} boards
 */
export function smallBlockReport(boards) {
  const counts = boards.map((b) => ({
    seed: b.seed,
    c8: smallWallComponents(b.arena, 8),
    c4: smallWallComponents(b.arena, 4),
  }));
  return {
    n: boards.length,
    with8: counts.filter((c) => c.c8 > 0).length,
    with4: counts.filter((c) => c.c4 > 0).length,
    exceptions: counts.filter((c) => c.c8 > 0 || c.c4 > 0),
  };
}

/**
 * One component's shape: a straight run (`{ run }`), an L (`{ run, arm }`), or null.
 *
 * An L is two one-cell-thick legs meeting at a corner of its bounding box. `runs` draws a
 * straight of `len` cells and turns an arm of `max(2, floor(len / 2)) + 0 or 1` cells off its
 * far end, so the straight INCLUDES the corner and the arm does not. For every `len` of 4 or
 * more the arm's leg (at most `floor(len / 2) + 2` cells with the corner) is shorter than the
 * straight, or equal to it at `len` 4 alone, which is what lets the longer leg be read back as
 * the drawn straight.
 */
function legsOf(cells) {
  const cs = cells.map(([c]) => c);
  const rs = cells.map(([, r]) => r);
  const minC = Math.min(...cs);
  const maxC = Math.max(...cs);
  const minR = Math.min(...rs);
  const maxR = Math.max(...rs);
  const w = maxC - minC + 1;
  const h = maxR - minR + 1;
  if (w === 1 || h === 1) return cells.length === w * h ? { run: cells.length } : null;
  if (cells.length !== w + h - 1) return null;
  for (const r0 of [minR, maxR]) {
    for (const c0 of [minC, maxC]) {
      if (cells.every(([c, r]) => r === r0 || c === c0)) return { run: Math.max(w, h), arm: Math.min(w, h) - 1 };
    }
  }
  return null;
}

/**
 * A board's wall components (8-connected, the block target's own connectivity) read back as
 * the pieces `runs` draws: every straight run's length, and every L-arm's.
 *
 * READ FROM THE BOARD, not from the generator's draw, so it reports what survived placement and
 * the rotation: a fragment the mirror step cut shows up here as the short run it became. Two
 * pieces that touched would read as one `other` component, which `runs`' one-cell gap prevents,
 * so a non-zero `other` on a `runs` board is itself a finding. Each piece appears twice, once
 * per half, which leaves the min, median and max unchanged.
 *
 * @param {import('./measure').GridBoard} board
 */
export function runLegs(board) {
  const runs = [];
  const arms = [];
  let straight = 0;
  let bent = 0;
  let other = 0;
  for (const cells of wallComponents(board, 8)) {
    const legs = legsOf(cells);
    if (legs === null) { other++; continue; }
    runs.push(legs.run);
    if (legs.arm === undefined) straight++;
    else { bent++; arms.push(legs.arm); }
  }
  return { runs, arms, straight, bent, other };
}

/**
 * `runLegs` over a sample of boards: component counts, and min / median / max of the straight
 * runs (every straight piece, and every L's straight leg) and of the L-arms.
 *
 * @param {readonly import('./measure').GridBoard[]} boards
 */
export function runLengthReport(boards) {
  const runs = [];
  const arms = [];
  let straight = 0;
  let bent = 0;
  let other = 0;
  for (const board of boards) {
    const legs = runLegs(board);
    runs.push(...legs.runs);
    arms.push(...legs.arms);
    straight += legs.straight;
    bent += legs.bent;
    other += legs.other;
  }
  const summary = (xs) => {
    const s = spreadOf(xs);
    return { n: s.n, min: s.min, median: s.median, max: s.max };
  };
  return { boards: boards.length, straight, bent, other, runs: summary(runs), arms: summary(arms) };
}

/** Seeds as a sorted, compact list: `[1, 2, 3, 7]` reads `1-3, 7`, and none reads `none`. */
export function seedList(seeds) {
  const xs = [...new Set(seeds)].sort((a, b) => a - b);
  if (xs.length === 0) return 'none';
  const parts = [];
  let start = xs[0];
  let prev = xs[0];
  for (const s of xs.slice(1)) {
    if (s === prev + 1) { prev = s; continue; }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = s;
    prev = s;
  }
  parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(', ');
}
