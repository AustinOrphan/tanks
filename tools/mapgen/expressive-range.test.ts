import { describe, expect, it } from 'vitest';
import {
  SHIPPED_RANGES,
  binOf,
  correlation,
  expressiveRange,
  renderExpressiveRange,
  spreadOf,
} from './expressive-range.mjs';

/**
 * Issue #822's measure 3 ranks a RULESET by how much of a behavioural space its sample
 * reaches. Every number here is a fraction with no natural scale, which is the same trap
 * `measure.test.ts` was written for -- so each test below builds a sample whose answer is
 * known by construction.
 */

/** A sample that lands on a known grid cell, given the default ranges. */
const at = (wall: number, sight: number) => ({ wallFraction: wall, openSightFraction: sight });

describe('expressive range: the sample never sets its own ruler', () => {
  it('scores a ruleset that emits one board over and over near zero, not at one', () => {
    // THE TRAP THIS MODULE EXISTS TO AVOID. Twenty identical boards fill exactly one cell of
    // the fixed grid. A grid scaled to the sample's own min and max would call that full
    // coverage -- the sample would be its own ruler, and every ruleset would score 1.0.
    const identical = Array.from({ length: 20 }, () => at(0.2, 0.3));
    const range = expressiveRange(identical, { x: 'wallFraction', y: 'openSightFraction', bins: 8 });

    expect(range.occupied).toBe(1);
    expect(range.coverage).toBeCloseTo(1 / 64, 10);
    // Everything in one cell: no spread inside what it reaches either.
    expect(range.entropy).toBe(0);
    expect(range.placed).toBe(20);

    // The control: a sample that really does reach many cells scores far higher on both.
    const spread = [];
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) spread.push(at(0.025 + i * 0.05, 0.125 + j * 0.05));
    const wide = expressiveRange(spread, { x: 'wallFraction', y: 'openSightFraction', bins: 8 });
    expect(wide.occupied).toBe(64);
    expect(wide.coverage).toBe(1);
    expect(wide.entropy).toBeCloseTo(1, 10);
  });

  it('counts an out-of-range board instead of clamping it into an edge bin', () => {
    // Clamping would pile outliers into the edge cells and inflate coverage exactly where the
    // ruleset is least like anything shipped.
    const sample = [at(0.2, 0.3), at(9, 9), at(-1, -1)];
    const range = expressiveRange(sample, { x: 'wallFraction', y: 'openSightFraction', bins: 8 });
    expect(range.considered).toBe(3);
    expect(range.placed).toBe(1);
    expect(range.outOfRange).toBe(2);
    expect(range.occupied).toBe(1);

    // The control: the same three boards with a range wide enough to hold them all. If the
    // out-of-range pair were being clamped rather than dropped, `placed` would already be 3.
    const wide = expressiveRange(sample, {
      x: 'wallFraction', y: 'openSightFraction',
      xRange: { min: -2, max: 10 }, yRange: { min: -2, max: 10 }, bins: 8,
    });
    expect(wide.placed).toBe(3);
    expect(wide.outOfRange).toBe(0);
  });

  it('puts a value exactly on the top edge in the last bin rather than off the grid', () => {
    // `max` is precisely the value a range derived from measurements tends to contain, so
    // losing it would silently drop the most interesting board in the sample.
    expect(binOf(0.4, SHIPPED_RANGES.wallFraction, 8)).toBe(7);
    expect(binOf(0, SHIPPED_RANGES.wallFraction, 8)).toBe(0);
    expect(binOf(0.4001, SHIPPED_RANGES.wallFraction, 8)).toBe(-1);
    expect(binOf(Number.NaN, SHIPPED_RANGES.wallFraction, 8)).toBe(-1);
  });

  it('refuses an axis it has no range for, rather than inventing one', () => {
    expect(() => expressiveRange([], { x: 'pathSpread', y: 'wallFraction' })).toThrow(/no range for pathSpread/);
    expect(() => expressiveRange([], { x: 'wallFraction', y: 'openSightFraction', bins: 0 })).toThrow(/positive integer/);
  });
});

describe('expressive range: coverage is not reported without its axes correlation', () => {
  it('returns null rather than zero when an axis never moved', () => {
    // 0 means "measured, and independent". null means "one axis was constant, so the question
    // is undefined". Reporting the first for the second would claim an independence that was
    // never observed.
    const flat = [at(0.1, 0.3), at(0.2, 0.3), at(0.3, 0.3)];
    expect(expressiveRange(flat, { x: 'wallFraction', y: 'openSightFraction' }).axisCorrelation).toBeNull();
    expect(correlation([1, 2, 3], [5, 5, 5])).toBeNull();
    expect(correlation([1], [1])).toBeNull();
  });

  it('measures a perfectly correlated sample as r = 1, which bounds what coverage can mean', () => {
    // A sample on a straight line can only ever occupy the grid's diagonal, so its coverage is
    // capped by the axes rather than by the ruleset -- which is why the pair is reported
    // together. Eight points on a line touch at most 8 of 64 cells.
    const line = Array.from({ length: 8 }, (_, i) => at(0.025 + i * 0.05, 0.125 + i * 0.05));
    const range = expressiveRange(line, { x: 'wallFraction', y: 'openSightFraction', bins: 8 });
    expect(range.axisCorrelation).toBeCloseTo(1, 10);
    expect(range.occupied).toBe(8);
    expect(range.coverage).toBeCloseTo(8 / 64, 10);
  });
});

describe('expressive range: the spread the mean was hiding', () => {
  it('reports a five-number summary beside the mean', () => {
    const s = spreadOf([1, 2, 3, 4, 5]);
    expect(s).toMatchObject({ n: 5, min: 1, p25: 2, median: 3, p75: 4, max: 5, mean: 3 });
  });

  it('separates two samples that share a mean, which is the whole complaint', () => {
    // #822: the sweep "reports means over accepted boards and hide the spread entirely".
    // These two have an identical mean and median and nothing else in common.
    const tight = spreadOf([3, 3, 3, 3, 3]);
    const loose = spreadOf([1, 2, 3, 4, 5]);
    expect(tight.mean).toBe(loose.mean);
    expect(tight.median).toBe(loose.median);
    // ...and the summary tells them apart, which a mean alone cannot.
    expect(tight.max - tight.min).toBe(0);
    expect(loose.max - loose.min).toBe(4);
  });

  it('survives an empty sample and a sample of non-numbers', () => {
    expect(spreadOf([]).n).toBe(0);
    expect(spreadOf([Number.NaN, Number.POSITIVE_INFINITY]).n).toBe(0);
    const empty = expressiveRange([], { x: 'wallFraction', y: 'openSightFraction' });
    expect(empty.placed).toBe(0);
    expect(empty.coverage).toBe(0);
    expect(empty.entropy).toBe(0);
    expect(empty.axisCorrelation).toBeNull();
  });
});

describe('expressive range: the rendered lines', () => {
  it('carries every denominator and puts the correlation before the coverage', () => {
    const range = expressiveRange([at(0.1, 0.2), at(0.3, 0.4), at(9, 9)], {
      x: 'wallFraction', y: 'openSightFraction', bins: 4,
    });
    const lines = renderExpressiveRange(range, 'rooms N=4');
    const text = lines.join('\n');
    expect(text).toContain('rooms N=4');
    // occupied/cells, and boards placed out of boards considered.
    expect(text).toContain('/16 cells');
    expect(text).toContain('from 2 of 3 boards');
    expect(text).toContain('1 off-grid');
    expect(text).toContain('read this before the coverage above');
    // Both axes get a spread line.
    expect(text).toContain('wallFraction');
    expect(text).toContain('openSightFraction');
  });

  it('says so in words when the correlation is undefined', () => {
    const flat = [at(0.1, 0.3), at(0.2, 0.3)];
    const text = renderExpressiveRange(
      expressiveRange(flat, { x: 'wallFraction', y: 'openSightFraction' }), 'flat',
    ).join('\n');
    expect(text).toContain('undefined (an axis never moved)');
  });
});
