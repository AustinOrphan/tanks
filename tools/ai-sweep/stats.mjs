/**
 * The pure half of the AI target-commitment sweep (issue #359): turn a recorded stream of
 * target changes into the numbers a tuning decision is actually made on.
 *
 * SEPARATE FROM THE RUNNER for the reason `sweep-plan.mjs` and `hit-sweep.mjs` give: the
 * runner imports the simulation and spawns processes, so nothing in it can be unit-tested
 * cheaply. Everything here is arithmetic over a plain array, and its tests run in
 * milliseconds without a simulation at all.
 *
 * WHAT IS MEASURED, and why each one is here rather than an easier number:
 *
 *  - `changes` alone is misleading. A run that ends early has fewer changes for a reason
 *    that has nothing to do with stickiness, so every rate is reported per 1000 AI-ticks.
 *  - `spanTicks` is the direct measure of what `targetCommitmentTime` controls: how long one
 *    opponent is actually held. Reported as a distribution, because a mean hides the case
 *    the issue's rule 6 is about -- a few very short spans among many long ones is exactly
 *    the thrash that a mean absorbs.
 *  - `byReason` separates the three reasons. Rule 5 retargets (`target-lost`) are forced and
 *    say nothing about the window; only `switched-on-expiry` is a choice the threshold makes.
 *    A sweep that moved only the forced ones would be measuring deaths, not tuning.
 *  - `pressure` is the issue's "understandable pressure distribution": the largest share of
 *    live AI tanks aimed at one opponent, averaged over ticks. 1.0 means every AI ganged on
 *    one player for the whole run, which is the failure the seeded per-AI tie-break exists
 *    to prevent.
 */

/** @typedef {{ tick: number, tankId: number, from: number | undefined, to: number | undefined, reason: string | null }} TargetChange */

/**
 * "1-20,45" -> [1..20, 45]. The same spelling the generated-scenario sweep accepts.
 *
 * Here rather than beside the runner because `vite-node` sets `process.argv[1]` to its OWN
 * binary, so a measure script cannot tell whether it was run or imported -- it always runs.
 * Anything worth testing therefore has to live outside it.
 */
export function parseSeeds(spec) {
  const out = [];
  for (const part of String(spec).split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (to < from) throw new Error(`descending seed range: ${trimmed}`);
      for (let s = from; s <= to; s += 1) out.push(s);
    } else if (/^\d+$/.test(trimmed)) {
      out.push(Number(trimmed));
    } else {
      throw new Error(`not a seed or seed range: ${trimmed}`);
    }
  }
  if (out.length === 0) throw new Error('no seeds requested');
  return out;
}

/** Quantiles of a numeric list, as a plain object. An empty list reports nulls, never 0. */
export function distribution(values) {
  if (values.length === 0) return { n: 0, min: null, p50: null, p90: null, max: null, mean: null };
  const s = [...values].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    n: s.length,
    min: s[0],
    p50: at(0.5),
    p90: at(0.9),
    max: s[s.length - 1],
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
  };
}

/**
 * How long each committed target was held, in ticks.
 *
 * A tank's LAST target is left open on purpose: the run ended, it was not dropped, and
 * counting it would report a span the policy never chose. That truncation biases spans
 * DOWNWARD if included, which is the direction that would flatter a short commitment time.
 *
 * @param {readonly TargetChange[]} changes
 * @returns {number[]}
 */
export function heldSpans(changes) {
  /** @type {Map<number, number>} */
  const openedAt = new Map();
  const spans = [];
  for (const c of changes) {
    const prev = openedAt.get(c.tankId);
    if (prev !== undefined && c.from !== undefined) spans.push(c.tick - prev);
    if (c.to === undefined) openedAt.delete(c.tankId);
    else openedAt.set(c.tankId, c.tick);
  }
  return spans;
}

/**
 * The sweep's row for one parameter value.
 *
 * @param {{ value: number, changes: readonly TargetChange[], aiTicks: number, pressureSamples: readonly number[] }} run
 */
export function summarise(run) {
  const { value, changes, aiTicks, pressureSamples } = run;
  const byReason = {};
  for (const c of changes) {
    const key = c.reason ?? 'unknown';
    byReason[key] = (byReason[key] ?? 0) + 1;
  }
  // Per 1000 AI-ticks, so runs of different lengths -- and runs that ended early because a
  // side was wiped out -- are comparable at all.
  const per1k = (n) => (aiTicks === 0 ? null : +((n * 1000) / aiTicks).toFixed(3));
  return {
    value,
    aiTicks,
    changes: changes.length,
    changesPer1kTicks: per1k(changes.length),
    switchesOnExpiry: byReason['switched-on-expiry'] ?? 0,
    switchesOnExpiryPer1kTicks: per1k(byReason['switched-on-expiry'] ?? 0),
    byReason,
    spanTicks: distribution(heldSpans(changes)),
    pressure: distribution(pressureSamples),
  };
}

/**
 * Whether the sweep produced a comparison worth reading, and if not, WHICH reason.
 *
 * THE FIRST THING THE RUNNER REPORTS, before any table is believed. Three states, kept apart
 * because conflating them publishes a false finding:
 *
 *  - `no-signal`: the runs contain too few `switched-on-expiry` events for the parameter to
 *    have had anything to act on. Identical rows here say nothing about the parameter. This
 *    is the common case at small scopes and it is NOT a dead knob.
 *  - `dead-knob`: there WAS signal and the rows are still identical. That is the real
 *    suspicious case -- either the parameter does not affect this measure, or the patch is
 *    not reaching the code path the measure watches.
 *  - `ok`: signal, and the rows differ.
 *
 * Note what this cannot tell you: the runner separately asserts each child read the patched
 * value back out of its own resolved config, so "the patch reached the process" is already
 * proven before this runs. This function is only about whether the OUTCOME moved.
 *
 * `minExpirySwitches` is the floor below which a comparison is not attempted. Only
 * `switched-on-expiry` counts: `target-lost` retargets are forced by rule 5 and happen at
 * any commitment time, so a run full of deaths can look busy while telling you nothing.
 *
 * @param {readonly { value: number, switchesOnExpiry: number, spanTicks: { p50: number | null, max: number | null } }[]} rows
 */
export function knobIsWired(rows, minExpirySwitches = 10) {
  const distinct = new Set(rows.map((r) => `${r.spanTicks.p50}/${r.spanTicks.max}`));
  const totalExpirySwitches = rows.reduce((a, r) => a + (r.switchesOnExpiry ?? 0), 0);
  const differs = rows.length > 1 && distinct.size > 1;
  let verdict;
  if (totalExpirySwitches < minExpirySwitches) verdict = 'no-signal';
  else if (!differs) verdict = 'dead-knob';
  else verdict = 'ok';
  return {
    verdict,
    comparable: verdict === 'ok',
    distinctSignatures: distinct.size,
    rows: rows.length,
    totalExpirySwitches,
    minExpirySwitches,
  };
}
