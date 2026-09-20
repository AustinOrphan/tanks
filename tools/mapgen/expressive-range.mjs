/**
 * Expressive range analysis for a RULESET (issue #822, measure 3).
 *
 * `sweep.mjs` prints a mean per column over the accepted boards, and #822 names that as the
 * defect: "the sweep tables today report means over accepted boards and hide the spread
 * entirely, which is exactly the failure the technique exists to prevent". A ruleset that
 * produces one board twenty times and a ruleset that produces twenty different boards have
 * the same means. Only the second is a generator worth having.
 *
 * So this ranks the ruleset, not the board: bin its sample into a two-axis grid and report
 * how much of that grid it reaches, how evenly, and what the per-axis spread actually is.
 *
 * THREE THINGS THIS FILE REFUSES TO DO, each because the obvious version is wrong:
 *
 * 1. IT NEVER DERIVES THE AXIS RANGE FROM THE SAMPLE. A grid scaled to its own sample's
 *    min and max is covered 100% by construction, by every ruleset, including one that emits
 *    twenty nearly-identical boards -- the numbers look like a finding and measure nothing.
 *    Ranges are arguments. `SHIPPED_RANGES` below carries measured defaults so two rulesets
 *    are scored against the same grid.
 * 2. IT NEVER CLAMPS AN OUT-OF-RANGE SAMPLE. Clamping piles the outliers into the edge bins
 *    and inflates coverage exactly where the ruleset is least like anything shipped.
 *    `outOfRange` is counted and reported instead.
 * 3. IT DOES NOT PRESENT COVERAGE WITHOUT THE AXES' CORRELATION. Measured over the 8 shipped
 *    boards at N=2, every candidate axis pair in this module's measures is strongly
 *    correlated:
 *
 *      openSightFraction x bottleneckWidth        r =  0.951
 *      legalAreaFraction x openSightFraction      r =  0.935
 *      wallFraction      x bottleneckWidth        r = -0.871
 *      openSightFraction x corridorAreaFraction   r = -0.868
 *      wallFraction      x openSightFraction      r = -0.786
 *      corridorAreaFraction x bottleneckWidth     r = -0.778
 *
 *    On this board set those measures largely move together -- they are several views of
 *    "how open is this board". A grid over two of them is close to one-dimensional, so the
 *    reachable fraction is bounded by a diagonal band rather than by the ruleset's
 *    imagination, and a low coverage number would be read as a verdict on the generator when
 *    it is partly a property of the axes. `expressiveRange` therefore returns `axisCorrelation`
 *    beside `coverage`, and a reader who ignores it will draw the wrong conclusion.
 *
 *    (Population for those figures: 8 shipped boards at N=2. Measured at all 24 (board, N)
 *    combinations, four of the six are IDENTICAL to three decimals, because only
 *    `bottleneckWidth` among them varies with player count -- so the wider sweep adds rows,
 *    not independent geometries.)
 */

/**
 * @typedef {{ min: number, max: number }} AxisRange
 * @typedef {{
 *   axes: { x: string, y: string }, bins: number, cells: number,
 *   considered: number, placed: number, outOfRange: number,
 *   occupied: number, coverage: number, entropy: number,
 *   axisCorrelation: number | null,
 *   spread: { x: ReturnType<typeof spreadOf>, y: ReturnType<typeof spreadOf> },
 *   grid: number[][],
 * }} ExpressiveRange
 */

/**
 * Default axis ranges, measured over the 8 shipped boards at N in {2, 3, 4} -- 24 rows -- and
 * widened to round numbers so a generated board just outside the shipped envelope still lands
 * on the grid rather than in `outOfRange`.
 *
 * These describe the boards this project has shipped. They are not a statement about good
 * boards in general, for the reason `calibrate.mjs` already records about its own bands: 8
 * authored maps describe those maps.
 *
 *   field                shipped min   shipped max   range here
 *   wallFraction               0.085         0.366   0.00 - 0.40
 *   legalAreaFraction          0.279         0.779   0.20 - 0.85
 *   corridorAreaFraction       0.006         0.840   0.00 - 1.00
 *   openGroundFraction         0.000         0.573   0.00 - 0.65
 *   openSightFraction          0.176         0.435   0.10 - 0.50
 *   bottleneckWidth            1.333         6.000   1.00 - 6.50
 */
export const SHIPPED_RANGES = Object.freeze({
  wallFraction: Object.freeze({ min: 0, max: 0.4 }),
  legalAreaFraction: Object.freeze({ min: 0.2, max: 0.85 }),
  corridorAreaFraction: Object.freeze({ min: 0, max: 1 }),
  openGroundFraction: Object.freeze({ min: 0, max: 0.65 }),
  openSightFraction: Object.freeze({ min: 0.1, max: 0.5 }),
  bottleneckWidth: Object.freeze({ min: 1, max: 6.5 }),
});

/**
 * Five-number summary plus the mean, which is the direct answer to "the tables report means
 * and hide the spread". The mean stays in so a reader can see it sitting inside its own
 * spread rather than having to trust it alone.
 *
 * @param {readonly number[]} values
 */
export function spreadOf(values) {
  const xs = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return { n: 0, min: NaN, p25: NaN, median: NaN, p75: NaN, max: NaN, mean: NaN };
  const at = (p) => {
    const i = (xs.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (i - lo);
  };
  return {
    n: xs.length,
    min: xs[0],
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    max: xs[xs.length - 1],
    mean: xs.reduce((s, v) => s + v, 0) / xs.length,
  };
}

/**
 * Pearson correlation, or null when it is undefined -- fewer than two points, or an axis with
 * no variance at all. Returning null rather than 0 matters: 0 means "measured, and they are
 * independent", which is the opposite of "one axis never moved".
 *
 * @param {readonly number[]} xs @param {readonly number[]} ys @returns {number | null}
 */
export function correlation(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = xs.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = ys.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/**
 * Which bin a value falls in, or -1 when it is outside the range.
 *
 * The top edge belongs to the LAST bin rather than to a bin of its own: without that, a value
 * exactly equal to `max` falls out of the grid, and `max` is precisely the value a range
 * derived from measurements tends to contain.
 *
 * @param {number} value @param {AxisRange} range @param {number} bins @returns {number}
 */
export function binOf(value, range, bins) {
  if (!Number.isFinite(value) || value < range.min || value > range.max) return -1;
  if (range.max === range.min) return 0;
  const scaled = ((value - range.min) / (range.max - range.min)) * bins;
  return Math.min(bins - 1, Math.floor(scaled));
}

/**
 * The ruleset's reach across a two-axis grid.
 *
 * `coverage` is occupied cells over total cells; `entropy` is the Shannon entropy of the
 * occupancy counts normalised by `log(cells)`, so it is 0 when every sample lands in one cell
 * and 1 when they are spread evenly over the whole grid. Coverage says how much is reached,
 * entropy says whether the sample is clumped inside what it reaches -- twenty boards in two
 * cells and twenty spread over twenty both differ from twenty in one.
 *
 * @param {readonly Record<string, number>[]} samples
 * @param {{ x: string, y: string, xRange?: AxisRange, yRange?: AxisRange, bins?: number }} options
 * @returns {ExpressiveRange}
 */
export function expressiveRange(samples, options) {
  const { x, y, bins = 8 } = options;
  const xRange = options.xRange ?? SHIPPED_RANGES[/** @type {keyof typeof SHIPPED_RANGES} */ (x)];
  const yRange = options.yRange ?? SHIPPED_RANGES[/** @type {keyof typeof SHIPPED_RANGES} */ (y)];
  if (xRange === undefined || yRange === undefined) {
    throw new Error(`expressiveRange: no range for ${xRange === undefined ? x : y}; pass one explicitly`);
  }
  if (!Number.isInteger(bins) || bins < 1) throw new Error(`expressiveRange: bins must be a positive integer, got ${bins}`);

  const rows = [...samples];
  const grid = Array.from({ length: bins }, () => new Array(bins).fill(0));
  let placed = 0;
  let outOfRange = 0;
  for (const sample of rows) {
    const i = binOf(sample?.[x], xRange, bins);
    const j = binOf(sample?.[y], yRange, bins);
    if (i < 0 || j < 0) { outOfRange++; continue; }
    grid[j][i] += 1;
    placed++;
  }

  let occupied = 0;
  let entropy = 0;
  for (const row of grid) {
    for (const count of row) {
      if (count === 0) continue;
      occupied++;
      const p = count / placed;
      entropy -= p * Math.log(p);
    }
  }
  const cells = bins * bins;

  return {
    axes: { x, y },
    bins,
    cells,
    // Every fraction below is out of one of these two, and they differ whenever a sample
    // falls off the grid -- which is the case the whole `outOfRange` rule exists for.
    considered: rows.length,
    placed,
    outOfRange,
    occupied,
    coverage: cells ? occupied / cells : 0,
    entropy: placed > 1 && cells > 1 ? entropy / Math.log(cells) : 0,
    // Read this BEFORE coverage. See rule 3 in the module comment.
    axisCorrelation: correlation(rows.map((s) => s?.[x]), rows.map((s) => s?.[y])),
    spread: { x: spreadOf(rows.map((s) => s?.[x])), y: spreadOf(rows.map((s) => s?.[y])) },
    grid,
  };
}

/**
 * One line per axis plus the headline, for `sweep.mjs`. Every figure carries its denominator.
 *
 * @param {ExpressiveRange} range @param {string} label @returns {string[]}
 */
export function renderExpressiveRange(range, label) {
  const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '  --');
  const axis = (name, s) =>
    `    ${name.padEnd(22)} min ${f(s.min)}  p25 ${f(s.p25)}  med ${f(s.median)}  p75 ${f(s.p75)}  max ${f(s.max)}  mean ${f(s.mean)}`;
  return [
    `  ${label}: ${range.occupied}/${range.cells} cells (coverage ${f(range.coverage)}), `
      + `entropy ${f(range.entropy)}, from ${range.placed} of ${range.considered} boards`
      + (range.outOfRange ? `, ${range.outOfRange} off-grid` : ''),
    `    axis correlation r = ${range.axisCorrelation === null ? 'undefined (an axis never moved)' : f(range.axisCorrelation)}`
      + ' -- read this before the coverage above',
    axis(range.axes.x, range.spread.x),
    axis(range.axes.y, range.spread.y),
  ];
}
