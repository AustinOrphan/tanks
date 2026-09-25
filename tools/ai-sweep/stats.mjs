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

/**
 * One row per GROUP of AI tanks, so a sweep can say which profile moved (issue #908).
 *
 * WHY THIS EXISTS. `summarise` pools every bot on the board. That answers "what does this
 * tunable do" and cannot answer "what would it do if these two tanks differed", which is the
 * question #908 is about: with `--profile`, seven profiles hold and one moves, and a pooled
 * row dilutes that one by however small a share of AI-ticks it owns. Measured over seeds
 * 1-40 at 1800 ticks, the five reachable profiles own between 12.4% and 26.6% of the
 * measurable AI-ticks, so a pooled row understates a single-profile change roughly four- to
 * eight-fold.
 *
 * ONE FUNCTION, TWO GROUPINGS. `groupOf` decides whether a row is a tank KIND or an AI
 * PROFILE. Folding by profile has to re-derive the spans rather than average two kinds'
 * distributions -- `teal` and `yellow` share `MOBILE_MINE_LAYER`, and a median of two medians
 * is not the median of the union. Passing the grouping in is what keeps that arithmetic in
 * one place.
 *
 * `ticksByGroup` is the denominator and is supplied rather than counted from `changes`: a
 * group can hold its target for a whole run and record no change at all, and dividing by its
 * own change count would report that as a missing row rather than as perfect stickiness.
 *
 * @param {object} run
 * @param {readonly (TargetChange & {kind: string})[]} run.changes
 * @param {Readonly<Record<string, number>>} run.ticksByGroup AI-ticks per group.
 * @param {Readonly<Record<string, readonly number[]>>} [run.sharedByGroup] Shared-target samples.
 * @param {(change: TargetChange & {kind: string}) => string} [run.groupOf] Defaults to the kind.
 * @returns {object[]} One row per group present in `ticksByGroup`, in descending AI-ticks.
 */
export function groupRows({ changes, ticksByGroup, sharedByGroup = {}, groupOf = (c) => c.kind }) {
  /** @type {Map<string, (TargetChange & {kind: string})[]>} */
  const byGroup = new Map();
  for (const group of Object.keys(ticksByGroup)) byGroup.set(group, []);
  for (const c of changes) {
    const group = groupOf(c);
    // A change from a group with no recorded ticks is a contradiction, not a row to invent:
    // every change came from a tank that was alive on the tick it was seen.
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(c);
  }

  const rows = [];
  for (const [group, groupChanges] of byGroup) {
    const aiTicks = ticksByGroup[group] ?? 0;
    const byReason = {};
    for (const c of groupChanges) byReason[c.reason ?? 'unknown'] = (byReason[c.reason ?? 'unknown'] ?? 0) + 1;
    const per1k = (n) => (aiTicks === 0 ? null : +((n * 1000) / aiTicks).toFixed(3));
    const expiry = byReason['switched-on-expiry'] ?? 0;
    rows.push({
      group,
      aiTicks,
      changes: groupChanges.length,
      changesPer1kTicks: per1k(groupChanges.length),
      switchesOnExpiry: expiry,
      switchesOnExpiryPer1kTicks: per1k(expiry),
      byReason,
      spanTicks: distribution(heldSpans(groupChanges)),
      sharedTarget: distribution(sharedByGroup[group] ?? []),
    });
  }
  return rows.sort((a, b) => b.aiTicks - a.aiTicks || a.group.localeCompare(b.group));
}

/**
 * Fold per-kind AI-ticks and shared-target samples onto their AI profiles.
 *
 * Separate from `groupRows` because the denominators and the samples have to be folded before
 * the arithmetic, not after it, for the same reason the doc there gives.
 *
 * @param {Readonly<Record<string, number>>} ticksByKind
 * @param {Readonly<Record<string, readonly number[]>>} sharedByKind
 * @param {Readonly<Record<string, string>>} profileByKind
 */
export function foldToProfiles(ticksByKind, sharedByKind, profileByKind) {
  const ticks = {};
  const shared = {};
  for (const kind of Object.keys(ticksByKind)) {
    const profile = profileByKind[kind];
    // An unmapped kind is dropped LOUDLY rather than pooled under `undefined`: the caller
    // derives `profileByKind` from the validated catalog, so a gap here means the measurement
    // saw a tank the configuration does not describe.
    if (profile === undefined) throw new Error(`no AI profile for kind '${kind}'`);
    ticks[profile] = (ticks[profile] ?? 0) + ticksByKind[kind];
    shared[profile] = [...(shared[profile] ?? []), ...(sharedByKind[kind] ?? [])];
  }
  return { ticks, shared };
}

/**
 * Which authored profiles a seed set can say nothing about, and WHY -- two different reasons.
 *
 * REPORTED RATHER THAN LEFT TO THE READER. `ai-profiles.json` authors eight profiles and
 * `tank-defs.json` maps five of them to a tank kind, so three carry a `targetCommitmentTime`
 * that no simulation can exercise at all. A sweep that printed five rows and stopped would
 * read as five-of-five coverage.
 *
 * THE TWO REASONS ARE KEPT APART because they call for opposite responses, and pooling them
 * would hide that:
 *
 *  - `unreachable` -- no tank kind carries the profile. Widening the seed set cannot help;
 *    the value is unfalsifiable until some kind adopts it.
 *  - `silent` -- a kind carries it, but this seed set never produced one. Widen `--seeds`.
 *
 * Ids are NAMED rather than counted, so the gap stays legible when either file changes.
 *
 * @param {readonly string[]} authored Every profile id in `ai-profiles.json`.
 * @param {readonly string[]} reachable Every profile some tank kind carries, per `tank-defs.json`.
 * @param {Readonly<Record<string, number>>} ticksByProfile Measured AI-ticks per profile.
 * @returns {{covered: string[], unreachable: string[], silent: string[]}}
 */
export function profileCoverage(authored, reachable, ticksByProfile) {
  const covered = [];
  const unreachable = [];
  const silent = [];
  for (const id of authored) {
    if ((ticksByProfile[id] ?? 0) > 0) covered.push(id);
    else if (!reachable.includes(id)) unreachable.push(id);
    else silent.push(id);
  }
  return { covered, unreachable, silent };
}
