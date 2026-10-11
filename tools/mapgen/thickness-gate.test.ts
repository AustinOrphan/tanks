import { describe, expect, it } from 'vitest';
import { ARENA_DEFS } from '../../src/sim/arena';
import { interiorShare, thinShare } from './measure';
import {
  INTERIOR_SHARE_MAX,
  INTERIOR_SHARE_MIN,
  THICKNESS_TOLERANCE,
  THIN_SHARE_CEILING,
  ceilingFor,
  floorFor,
  passesThicknessGate,
  thicknessReport,
} from './thickness-gate.mjs';

/**
 * Issue #1065's gate. The predicate is tested on plain shares set well clear of the band on
 * both sides -- a fixture at an edge's own two-decimal figure is a knife edge on unrounded
 * values -- and the band and the thin ceiling are recomputed from every shipped board by the
 * ruled rule. The per-board table and the shape fixtures are in `measure.test.ts`.
 */

/** A board from a picture: rows of characters, `#` solid, `x` destructible, letters spawns. */
const board = (rows: string[]) => ({
  cols: rows[0].length,
  rows: rows.length,
  legend: { '#': 'solid' as const, x: 'destructible' as const },
  grid: rows,
});

describe('the thickness gate (issue #1065)', () => {
  it('passes a share well inside the band and refuses one well outside it on either side', () => {
    expect(passesThicknessGate(0.2)).toBe(true);
    expect(passesThicknessGate(0.05), 'under the minimum').toBe(false);
    expect(passesThicknessGate(0.45), 'over the maximum').toBe(false);
  });

  it('holds its tolerance at float noise on either side of both edges', () => {
    expect(passesThicknessGate(INTERIOR_SHARE_MIN - THICKNESS_TOLERANCE / 2)).toBe(true);
    expect(passesThicknessGate(INTERIOR_SHARE_MIN - 1e-6)).toBe(false);
    expect(passesThicknessGate(INTERIOR_SHARE_MAX + THICKNESS_TOLERANCE / 2)).toBe(true);
    expect(passesThicknessGate(INTERIOR_SHARE_MAX + 1e-6)).toBe(false);
    // The rounding: down for the minimum, up for the maximum, float noise absorbed either way.
    expect(floorFor(0.0899999999999)).toBe(0.09);
    expect(floorFor(0.094)).toBe(0.09);
    expect(floorFor(0.0899)).toBe(0.08);
    expect(ceilingFor(0.3500000000001)).toBe(0.35);
    expect(ceilingFor(0.3405)).toBe(0.35);
    expect(ceilingFor(0.3501)).toBe(0.36);
  });

  it('refuses a board with no wall cells, which reads 0, and passes a 3x3 block as its control', () => {
    const empty = board(['.....', '..P..', '.....']);
    expect(interiorShare(empty)).toBe(0);
    expect(passesThicknessGate(interiorShare(empty))).toBe(false);
    // 1 of 9, inside the band.
    const block = board(['.....', '.###.', '.###.', '.###.', '.....']);
    expect(passesThicknessGate(interiorShare(block))).toBe(true);
    // And a share that is not a number is refused rather than passed.
    expect(passesThicknessGate(Number.NaN)).toBe(false);
  });

  it('derives its band and thin ceiling from every shipped board by the rule', () => {
    // Over ARENA_DEFS, not a pinned list: a board that moves an extreme fails here and forces a
    // recorded decision instead of moving the band silently. Each message names the board that
    // defines the extreme (vs-duel-01, vs-quad-01 and vs-tri-01 when this was written).
    expect(ARENA_DEFS.length, 'no board ships').toBeGreaterThan(0);
    const measured = ARENA_DEFS.map((def) => ({ id: def.id, interior: interiorShare(def), thin: thinShare(def, 8) }));
    const min = measured.reduce((a, b) => (b.interior < a.interior ? b : a));
    const max = measured.reduce((a, b) => (b.interior > a.interior ? b : a));
    const thin = measured.reduce((a, b) => (b.thin > a.thin ? b : a));
    expect(
      INTERIOR_SHARE_MIN,
      `the minimum no longer matches its rule: ${min.id} defines the interior-share minimum at ${min.interior}`,
    ).toBe(floorFor(min.interior));
    expect(
      INTERIOR_SHARE_MAX,
      `the maximum no longer matches its rule: ${max.id} defines the interior-share maximum at ${max.interior}`,
    ).toBe(ceilingFor(max.interior));
    expect(
      THIN_SHARE_CEILING,
      `the thin ceiling no longer matches its rule: ${thin.id} defines the thin-share maximum at ${thin.thin}`,
    ).toBe(ceilingFor(thin.thin));
  });

  it('passes every shipped board, each at or under the thin ceiling', () => {
    for (const def of ARENA_DEFS) {
      const interior = interiorShare(def);
      const thin = thinShare(def, 8);
      expect(passesThicknessGate(interior), `${def.id} (interior share ${interior}) is refused by the gate`).toBe(true);
      expect(thin, `${def.id} is over the thin ceiling`).toBeLessThanOrEqual(THIN_SHARE_CEILING + THICKNESS_TOLERANCE);
    }
  });
});

describe('the thickness report the sweep prints (issue #1065)', () => {
  // Four boards with every figure known by construction.
  const block3 = board(['.....', '.###.', '.###.', '.###.', '.....']); // interior 1/9, thin 0 of 9
  const block4 = board(['......', '.####.', '.####.', '.####.', '.####.', '......']); // interior 4/16, thin 0 of 16
  const bar = board(['.......', '.#####.', '.......']); // interior 0, thin 5 of 5
  const mixed = board(['.........', '.###.....', '.###.###.', '.###.....', '.........']); // interior 1/12, thin 3 of 12

  it('counts the boards the gate passes, by the interior share, and names every refused seed', () => {
    const r = thicknessReport([
      { seed: 1, arena: block3 }, { seed: 2, arena: bar }, { seed: 3, arena: block4 }, { seed: 4, arena: mixed },
    ]);
    // The bar (0) and the mixed board (1/12, under 0.09) are refused; the blocks pass.
    expect(r).toMatchObject({ n: 4, passed: 2, refusedSeeds: [2, 4] });
    // The control for "by the interior share": the bar's thin share, 1, and the blocks' 0 would
    // refuse all three of them, and the mixed board's 0.25 would pass it.
  });

  it('reports the min / median / max of both shares, the boards over the thin ceiling, and any thin', () => {
    const r = thicknessReport([
      { seed: 1, arena: block3 }, { seed: 2, arena: bar }, { seed: 3, arena: block4 }, { seed: 4, arena: mixed },
    ]);
    expect(r.interior.min).toBe(0);
    expect(r.interior.max).toBe(0.25);
    // Interpolated between 1/12 and 1/9, medianOf's median.
    expect(r.interior.median).toBeCloseTo((1 / 12 + 1 / 9) / 2, 12);
    expect(r.thin).toEqual({ min: 0, median: 0.125, max: 1 });
    // Only the bar (1) is over 0.37; the mixed board's 0.25 is thin and under it, its control.
    expect(r.overCeiling).toBe(1);
    expect(r.withThin).toBe(2);
  });

  it('pools the thin share as thin cells over wall cells, not as a mean of per-board shares', () => {
    // The bar and the 4x4 block: 5 thin cells of 21 wall cells is 0.238; the mean of their
    // shares, (1 + 0) / 2, is 0.5.
    const r = thicknessReport([{ seed: 7, arena: bar }, { seed: 8, arena: block4 }]);
    expect(r).toMatchObject({ wallCells: 21, thinCells: 5 });
    expect(r.pooledThin).toBe(5 / 21);
  });

  it('reports the shipped set as the sweep prints it beside the generated rows', () => {
    const r = thicknessReport(ARENA_DEFS.map((def) => ({ seed: def.id, arena: def })));
    // The 9 boards: every one passes, none is over the ceiling, 2 carry a thin component, and
    // the pooled share is 96 of 1,410 wall cells (6.8%).
    expect(r).toMatchObject({ n: 9, passed: 9, refusedSeeds: [], overCeiling: 0, withThin: 2, wallCells: 1410, thinCells: 96 });
    expect(r.pooledThin).toBeCloseTo(0.0681, 4);
  });

  it('reads an empty sample as no boards, with no figures', () => {
    const r = thicknessReport([]);
    expect(r).toMatchObject({ n: 0, passed: 0, refusedSeeds: [], overCeiling: 0, withThin: 0 });
    for (const v of [r.interior.min, r.interior.median, r.interior.max, r.thin.median, r.pooledThin]) expect(v).toBeNaN();
  });
});
