// The pure half of the AI target-commitment sweep (issue #359).
//
// The runner patches validated config on disk and spawns a simulation per value, so none of
// it is cheap to test. Everything worth asserting was therefore put in `stats.mjs`, and this
// is what holds it honest -- in particular the verdict, which exists to stop the sweep
// publishing a comparison it has no basis for.
import { describe, it, expect } from 'vitest';
import {
  parseSeeds, distribution, heldSpans, summarise, knobIsWired,
  groupRows, foldToProfiles, profileCoverage, heldSpansByEndReason,
} from './stats.mjs';

describe('parseSeeds', () => {
  it('expands ranges and lists, and refuses what it cannot read', () => {
    expect(parseSeeds('1-4')).toEqual([1, 2, 3, 4]);
    expect(parseSeeds('1-3,9')).toEqual([1, 2, 3, 9]);
    expect(parseSeeds(' 7 ')).toEqual([7]);
    // A descending range is the typo that would silently measure NOTHING -- an empty seed
    // list means every row is empty, and empty rows compare equal.
    expect(() => parseSeeds('9-1')).toThrow(/descending/);
    expect(() => parseSeeds('')).toThrow(/no seeds/);
    expect(() => parseSeeds('two')).toThrow(/not a seed/);
  });
});

describe('distribution', () => {
  it('reports nulls for an empty list rather than zeros', () => {
    // Zeros would read as "spans of length 0" -- a measurement -- when the truth is that
    // there were none. The sweep prints these straight into a table a tuning decision is
    // made from, so the difference matters.
    expect(distribution([])).toEqual({ n: 0, min: null, p50: null, p90: null, max: null, mean: null });
  });

  it('summarises a list by position, not by average alone', () => {
    const d = distribution([10, 20, 30, 40, 100]);
    expect(d.n).toBe(5);
    expect(d.min).toBe(10);
    expect(d.max).toBe(100);
    expect(d.p50).toBe(30);
    expect(d.mean).toBe(40);
    // The point of keeping both: the mean is dragged up by one long span while the median is
    // not, which is exactly the thrash-vs-stickiness distinction this sweep is measuring.
    expect(d.mean).not.toBe(d.p50);
  });
});

describe('heldSpans', () => {
  it('measures how long each target was held, and leaves the last one open', () => {
    // Tank 1 takes target 5 at tick 10, swaps to 6 at tick 100, and the run ends. One
    // completed span of 90 ticks; the second is still open and is NOT counted.
    const spans = heldSpans([
      { tick: 10, tankId: 1, from: undefined, to: 5, reason: 'acquired' },
      { tick: 100, tankId: 1, from: 5, to: 6, reason: 'switched-on-expiry' },
    ]);
    expect(spans).toEqual([90]);
  });

  it('does not count an open span, which would bias every row downward', () => {
    // The control for the rule above. If the final, truncated hold were counted, a run that
    // simply ended would contribute a short span -- and the shorter the commitment time, the
    // more rows would gain one, flattering exactly the value under test.
    const onlyOpen = heldSpans([{ tick: 10, tankId: 1, from: undefined, to: 5, reason: 'acquired' }]);
    expect(onlyOpen).toEqual([]);
  });

  it('keeps tanks apart, so one tank switching is not read as another holding', () => {
    const spans = heldSpans([
      { tick: 0, tankId: 1, from: undefined, to: 5, reason: 'acquired' },
      { tick: 5, tankId: 2, from: undefined, to: 5, reason: 'acquired' },
      { tick: 50, tankId: 1, from: 5, to: 6, reason: 'switched-on-expiry' },
    ]);
    expect(spans).toEqual([50]);
  });
});

describe('summarise', () => {
  it('reports rates per 1000 AI-ticks, so runs of different lengths compare', () => {
    const changes = [
      { tick: 10, tankId: 1, from: undefined, to: 5, reason: 'acquired' },
      { tick: 100, tankId: 1, from: 5, to: 6, reason: 'switched-on-expiry' },
      { tick: 200, tankId: 1, from: 6, to: undefined, reason: 'target-lost' },
    ];
    const r = summarise({ value: 1.5, changes, aiTicks: 6000, pressureSamples: [0.5, 1] });
    expect(r.changes).toBe(3);
    expect(r.changesPer1kTicks).toBe(0.5);
    // Only the expiry switch is a CHOICE. A run full of deaths looks busy and says nothing
    // about the commitment window, so the two are reported apart.
    expect(r.switchesOnExpiry).toBe(1);
    expect(r.byReason).toEqual({ acquired: 1, 'switched-on-expiry': 1, 'target-lost': 1 });
  });

  it('reports a null rate rather than dividing by zero when nothing was observed', () => {
    const r = summarise({ value: 1, changes: [], aiTicks: 0, pressureSamples: [] });
    expect(r.changesPer1kTicks).toBeNull();
    expect(r.spanTicks.n).toBe(0);
  });
});

describe('knobIsWired', () => {
  const row = (value: number, switchesOnExpiry: number, p50: number | null, max: number | null) =>
    ({ value, switchesOnExpiry, spanTicks: { p50, max } });

  it('calls identical rows NO-SIGNAL when there were too few expiry switches to act on', () => {
    // The case that actually happened while building this: 2 values, 3 seeds, 300 ticks, zero
    // expiry switches, identical rows. Reporting that as "the parameter does not matter"
    // would have been a false finding published from a scope with nothing in it.
    const v = knobIsWired([row(0.5, 0, null, null), row(3, 0, null, null)]);
    expect(v.verdict).toBe('no-signal');
    expect(v.comparable).toBe(false);
  });

  it('calls identical rows a DEAD KNOB only once there was signal', () => {
    const v = knobIsWired([row(0.5, 40, 90, 200), row(3, 40, 90, 200)]);
    expect(v.verdict).toBe('dead-knob');
    expect(v.comparable).toBe(false);
  });

  it('is comparable only when there was signal AND the rows differ', () => {
    const v = knobIsWired([row(0.5, 30, 30, 60), row(3, 30, 180, 400)]);
    expect(v.verdict).toBe('ok');
    expect(v.comparable).toBe(true);
    // The control for "differ": same signal, same spans -> not comparable. Without this the
    // verdict could be satisfied by signal alone, which is the whole mistake it prevents.
    expect(knobIsWired([row(0.5, 30, 30, 60), row(3, 30, 30, 60)]).verdict).toBe('dead-knob');
  });

  it('never calls a single row comparable, because one row is not a comparison', () => {
    expect(knobIsWired([row(1.5, 999, 90, 300)]).comparable).toBe(false);
  });
});

// Per-profile attribution (issue #908). These exist because a pooled row cannot answer the
// question that issue is about -- "what would it do if these two tanks differed" -- and the
// ways a per-group report goes quietly wrong are all arithmetic: the wrong denominator, a
// group folded by averaging its parts, a missing group read as a missing measurement.
describe('groupRows', () => {
  /** Two kinds interleaved, so a row that forgot to filter by group would show it. */
  const CHANGES = [
    { tick: 10, tankId: 1, kind: 'brown', from: undefined, to: 7, reason: null },
    { tick: 12, tankId: 2, kind: 'teal', from: undefined, to: 7, reason: null },
    { tick: 100, tankId: 1, kind: 'brown', from: 7, to: 8, reason: 'switched-on-expiry' },
    { tick: 30, tankId: 2, kind: 'teal', from: 7, to: 9, reason: 'switched-on-expiry' },
    { tick: 60, tankId: 2, kind: 'teal', from: 9, to: 7, reason: 'target-lost' },
  ];

  it('divides each group by its OWN AI-ticks, not by the run total', () => {
    const rows = groupRows({ changes: CHANGES, ticksByGroup: { brown: 1000, teal: 4000 } });
    const brown = rows.find((r) => r.group === 'brown')!;
    const teal = rows.find((r) => r.group === 'teal')!;
    // One expiry switch each, on denominators 1000 and 4000.
    expect(brown.switchesOnExpiry).toBe(1);
    expect(teal.switchesOnExpiry).toBe(1);
    expect(brown.switchesOnExpiryPer1kTicks).toBe(1);
    expect(teal.switchesOnExpiryPer1kTicks).toBe(0.25);
    // THE CONTROL. Dividing by the pooled 5000 would give both rows 0.2, so equal rates here
    // would mean the denominator is the run's rather than the group's -- exactly the dilution
    // that makes a single-profile sweep look like it did nothing.
    expect(brown.switchesOnExpiryPer1kTicks).not.toBe(teal.switchesOnExpiryPer1kTicks);
  });

  it('scopes held spans to the group, so one kind cannot report another kind s spans', () => {
    const rows = groupRows({ changes: CHANGES, ticksByGroup: { brown: 1000, teal: 4000 } });
    const brown = rows.find((r) => r.group === 'brown')!;
    const teal = rows.find((r) => r.group === 'teal')!;
    // brown held 7 from tick 10 to 100: one span of 90. teal held 7 from 12 to 30 and 9 from
    // 30 to 60: spans 18 and 30.
    expect(brown.spanTicks.n).toBe(1);
    expect(brown.spanTicks.p50).toBe(90);
    expect(teal.spanTicks.n).toBe(2);
    expect(teal.spanTicks.max).toBe(30);
    // THE CONTROL. An implementation that passed ALL changes to heldSpans for every group
    // would give both rows n=3 and the same max. Identical distributions here would mean the
    // filter is missing and every profile is reporting the whole board.
    expect(brown.spanTicks.n).not.toBe(teal.spanTicks.n);
    expect(brown.spanTicks.max).not.toBe(teal.spanTicks.max);
  });

  it('keeps a group that never changed target, because that is perfect stickiness and not a gap', () => {
    const rows = groupRows({ changes: CHANGES, ticksByGroup: { brown: 1000, teal: 4000, olive: 2500 } });
    const olive = rows.find((r) => r.group === 'olive');
    expect(olive, 'a group with ticks and no changes must still get a row').toBeDefined();
    expect(olive!.aiTicks).toBe(2500);
    expect(olive!.changes).toBe(0);
    expect(olive!.changesPer1kTicks).toBe(0);
    // Reported as 0 changes over a real denominator, NOT as an empty distribution pretending
    // to be a measurement: the spans genuinely do not exist.
    expect(olive!.spanTicks).toEqual({ n: 0, min: null, p50: null, p90: null, max: null, mean: null });
    // The control for "0 is a measurement here": a group with no ticks at all cannot have a
    // rate, and reports null rather than 0.
    const noTicks = groupRows({ changes: [], ticksByGroup: { ghost: 0 } })[0];
    expect(noTicks.changesPer1kTicks).toBeNull();
  });

  it('groups by whatever groupOf says, which is how kinds fold onto profiles', () => {
    const rows = groupRows({
      changes: CHANGES,
      ticksByGroup: { SHARED: 5000 },
      groupOf: () => 'SHARED',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].group).toBe('SHARED');
    // Both kinds' expiry switches land in the one row.
    expect(rows[0].switchesOnExpiry).toBe(2);
    // The control: the default grouping splits the same changes in two.
    expect(groupRows({ changes: CHANGES, ticksByGroup: { brown: 1, teal: 1 } })).toHaveLength(2);
  });

  it('orders rows by AI-ticks so the thinnest evidence is not read first', () => {
    const rows = groupRows({ changes: CHANGES, ticksByGroup: { brown: 1000, teal: 4000, olive: 2500 } });
    expect(rows.map((r) => r.group)).toEqual(['teal', 'olive', 'brown']);
  });
});

describe('foldToProfiles', () => {
  it('folds ticks and samples onto the profile before the arithmetic, not after it', () => {
    // teal and yellow share MOBILE_MINE_LAYER in the shipped tank-defs, which is why folding
    // has to happen on the inputs: the median of a union is not the median of two medians.
    const { ticks, shared } = foldToProfiles(
      { teal: 100, yellow: 300, brown: 50 },
      { teal: [1, 1, 1], yellow: [0.2], brown: [0.5] },
      { teal: 'MOBILE_MINE_LAYER', yellow: 'MOBILE_MINE_LAYER', brown: 'STATIC_BASIC' },
    );
    expect(ticks).toEqual({ MOBILE_MINE_LAYER: 400, STATIC_BASIC: 50 });
    expect(shared.MOBILE_MINE_LAYER).toEqual([1, 1, 1, 0.2]);
    // THE CONTROL. The union's median is 1; averaging the two kinds' medians (1 and 0.2) gives
    // 0.6. A distribution taken over the folded samples must therefore read 1 here, and a 0.6
    // would mean the fold happened after the arithmetic.
    expect(distribution(shared.MOBILE_MINE_LAYER).p50).toBe(1);
    expect(distribution(shared.MOBILE_MINE_LAYER).p50).not.toBe(0.6);
  });

  it('refuses a kind the configuration does not map, rather than pooling it under undefined', () => {
    expect(() => foldToProfiles({ mauve: 10 }, {}, { brown: 'STATIC_BASIC' })).toThrow(/no AI profile for kind 'mauve'/);
  });

  it('carries a kind with no samples as an empty list, not as a missing profile', () => {
    const { ticks, shared } = foldToProfiles({ brown: 40 }, {}, { brown: 'STATIC_BASIC' });
    expect(ticks).toEqual({ STATIC_BASIC: 40 });
    // The ticks are real even when no sample was taken: the tank was alive and target-less.
    expect(shared.STATIC_BASIC).toEqual([]);
  });
});

describe('profileCoverage', () => {
  const AUTHORED = ['STATIC_BASIC', 'MOBILE_MINE_LAYER', 'RICOCHET_SNIPER', 'BERSERKER_ROCKET'];
  const REACHABLE = ['STATIC_BASIC', 'MOBILE_MINE_LAYER', 'RICOCHET_SNIPER'];

  it('separates "no tank carries it" from "these seeds did not produce one"', () => {
    const c = profileCoverage(AUTHORED, REACHABLE, { STATIC_BASIC: 500, MOBILE_MINE_LAYER: 200 });
    expect(c.covered).toEqual(['STATIC_BASIC', 'MOBILE_MINE_LAYER']);
    // RICOCHET_SNIPER has a kind and got no ticks: widening the seeds can fix that.
    expect(c.silent).toEqual(['RICOCHET_SNIPER']);
    // BERSERKER_ROCKET has no kind at all: no seed set can reach it.
    expect(c.unreachable).toEqual(['BERSERKER_ROCKET']);
    // THE CONTROL for keeping them apart: pooling both into one list would make these equal,
    // and the runner prints opposite advice for each ("widen --seeds" vs "cannot be reached").
    expect(c.silent).not.toEqual(c.unreachable);
  });

  it('counts a profile covered only on a POSITIVE tick count, not on the key existing', () => {
    const c = profileCoverage(AUTHORED, REACHABLE, { STATIC_BASIC: 0 });
    expect(c.covered).toEqual([]);
    // A key present with 0 ticks is the shape a fold produces for a kind that never spawned;
    // reading it as covered would report a row with no evidence behind it as evidence.
    expect(c.silent).toContain('STATIC_BASIC');
  });
});

describe('heldSpansByEndReason', () => {
  // One tank, three completed spans, each ended by a different reason. Built so the three
  // buckets have DIFFERENT medians: pooling them is exactly the defect this splits.
  const CHANGES = [
    { tick: 0, tankId: 1, kind: 'brown', from: undefined, to: 7, reason: 'acquired' },
    { tick: 200, tankId: 1, kind: 'brown', from: 7, to: 8, reason: 'switched-on-expiry' },
    { tick: 210, tankId: 1, kind: 'brown', from: 8, to: 9, reason: 'target-lost' },
    { tick: 500, tankId: 1, kind: 'brown', from: 9, to: 7, reason: 'switched-on-expiry' },
    { tick: 505, tankId: 1, kind: 'brown', from: 7, to: 8, reason: 'target-lost' },
  ];

  it('attributes each span to the change that ENDED it, not the one that opened it', () => {
    const byReason = heldSpansByEndReason(CHANGES);
    // 0->200 ended by expiry; 200->210 ended by target-lost; 210->500 by expiry; 500->505 by lost.
    expect(byReason['switched-on-expiry']).toEqual([200, 290]);
    expect(byReason['target-lost']).toEqual([10, 5]);
    // THE CONTROL for "ending, not opening". Attributing to the opener would give expiry the
    // spans that FOLLOW an expiry switch -- [10, 5] -- so these two must not be swappable.
    expect(byReason['switched-on-expiry']).not.toEqual(byReason['target-lost']);
  });

  it('accounts for every span the pooled measure counts, and no more', () => {
    const byReason = heldSpansByEndReason(CHANGES);
    const split = Object.values(byReason).flat().sort((a, b) => a - b);
    expect(split).toEqual([...heldSpans(CHANGES)].sort((a, b) => a - b));
    // Would catch a bucket that silently dropped a reason, or double-counted one: the split has
    // to be a partition of the pooled list, not merely a subset of it.
    expect(split).toHaveLength(heldSpans(CHANGES).length);
  });

  it('separates the expiry median from the pooled one, which is the whole point', () => {
    const byReason = heldSpansByEndReason(CHANGES);
    const expiry = distribution(byReason['switched-on-expiry']);
    const pooled = distribution(heldSpans(CHANGES));
    // Pooled spans are [200, 10, 290, 5]; the expiry-ended ones are [200, 290]. The pooled
    // median is dragged down by the two forced drops, which is the effect this fixture stands
    // in for. Measured over seeds 1-200 at 1800 ticks, all 20 of the 20 profile-and-value cells
    // (5 reachable profiles x 4 values) put the expiry-ended median above the pooled one, by
    // 1.50x to 5.66x -- MOBILE_MINE_LAYER at 0.5s reads 279 against 148 -- because rule-5 drops
    // are 63-88% of all changes and are short by nature.
    expect(expiry.p50).toBe(290);
    expect(pooled.p50).toBe(200);
    expect(expiry.p50).toBeGreaterThan(pooled.p50);
  });

  it('buckets a change with no reason under `unknown` rather than dropping it', () => {
    const spans = heldSpansByEndReason([
      { tick: 0, tankId: 1, kind: 'brown', from: undefined, to: 7, reason: null },
      { tick: 90, tankId: 1, kind: 'brown', from: 7, to: 8, reason: null },
    ]);
    expect(spans.unknown).toEqual([90]);
    // The control: a dropped span would leave the object empty, which reads as "no holds" --
    // a measurement -- when the truth is one hold whose reason was not recorded.
    expect(Object.values(spans).flat()).toHaveLength(1);
  });

  it('leaves a tank s final open hold uncounted, exactly as the pooled measure does', () => {
    const spans = heldSpansByEndReason([
      { tick: 0, tankId: 1, kind: 'brown', from: undefined, to: 7, reason: 'acquired' },
    ]);
    expect(Object.values(spans).flat()).toEqual([]);
    expect(heldSpans([
      { tick: 0, tankId: 1, kind: 'brown', from: undefined, to: 7, reason: 'acquired' },
    ])).toEqual([]);
  });
});

describe('groupRows reports the expiry-ended spans beside the pooled ones', () => {
  it('gives each group a distribution over only the spans its threshold ended', () => {
    const changes = [
      { tick: 0, tankId: 1, kind: 'brown', from: undefined, to: 7, reason: 'acquired' },
      { tick: 300, tankId: 1, kind: 'brown', from: 7, to: 8, reason: 'switched-on-expiry' },
      { tick: 305, tankId: 1, kind: 'brown', from: 8, to: 9, reason: 'target-lost' },
      { tick: 0, tankId: 2, kind: 'teal', from: undefined, to: 7, reason: 'acquired' },
      { tick: 40, tankId: 2, kind: 'teal', from: 7, to: 8, reason: 'target-lost' },
    ];
    const rows = groupRows({ changes, ticksByGroup: { brown: 1000, teal: 1000 } });
    const brown = rows.find((r) => r.group === 'brown')!;
    const teal = rows.find((r) => r.group === 'teal')!;
    expect(brown.expirySpanTicks.n).toBe(1);
    expect(brown.expirySpanTicks.p50).toBe(300);
    // teal's only completed span was FORCED, so it has no expiry-ended spans at all -- reported
    // as nulls rather than zeros, so "the threshold never acted here" cannot read as "it acted
    // and the span was 0".
    expect(teal.expirySpanTicks).toEqual({ n: 0, min: null, p50: null, p90: null, max: null, mean: null });
    // THE CONTROL. teal's POOLED span exists (40 ticks), so a row that reported the pooled
    // distribution under the expiry name would show n=1 here instead of n=0.
    expect(teal.spanTicks.n).toBe(1);
    expect(teal.spanTicks.p50).toBe(40);
  });
});

describe('spans are scoped to one seed', () => {
  // The defect, in the shape the concatenated stream ACTUALLY takes: two seeds, the same
  // tankId, and each seed restarting its tick counter.
  //
  // Every change here carries a defined `from`, including each seed's first, and that detail is
  // the whole fixture. `measure.mjs` only records a change once it has seen the tank before, so
  // a tank's first RECORDED change in a seed is never its acquisition -- it is a switch away
  // from a target the guard swallowed. Measured over seeds 1-40 at 1800 ticks: all 56 of the 56
  // distinct (seed, tank) pairs recorded began with a defined `from`, none with an acquisition.
  //
  // That is what makes the cross-seed pairing reachable. Keyed by tankId alone, seed 2's
  // tick-40 change closes the span seed 1 opened at tick 1700 -- a span of -1660. An earlier
  // version of this fixture opened each seed with `from: undefined`, and a change with no
  // `from` closes nothing, so it could not pair across seeds and did not discriminate the
  // defect at all; the mutation harness caught that it was inert.
  const TWO_SEEDS = [
    { tick: 100, tankId: 3, seed: 1, kind: 'brown', from: 4, to: 7, reason: 'target-lost' },
    { tick: 1700, tankId: 3, seed: 1, kind: 'brown', from: 7, to: 8, reason: 'switched-on-expiry' },
    { tick: 40, tankId: 3, seed: 2, kind: 'brown', from: 5, to: 7, reason: 'target-lost' },
    { tick: 300, tankId: 3, seed: 2, kind: 'brown', from: 7, to: 9, reason: 'switched-on-expiry' },
  ];

  it('never pairs one seed s change with another s', () => {
    const spans = heldSpans(TWO_SEEDS);
    // Seed 1 held 7 from 100 to 1700 (1600); seed 2 held 7 from 40 to 300 (260). Nothing else.
    expect(spans).toEqual([1600, 260]);
    // THE CONTROL: keyed by tankId alone, seed 2's tick-40 change closes seed 1's tick-1700
    // hold and `assertSpan` throws on the -1660 -- so this call does not merely return a
    // different list under the defect, it does not return. Both facts are pinned: the spans are
    // the two real holds, and there are exactly two of them.
    expect(spans.every((s) => s > 0)).toBe(true);
    expect(spans).toHaveLength(2);
  });

  it('scopes the by-reason split the same way', () => {
    const byReason = heldSpansByEndReason(TWO_SEEDS);
    expect(byReason['switched-on-expiry']).toEqual([1600, 260]);
    expect(Object.values(byReason).flat().every((s) => s > 0)).toBe(true);
  });

  it('REFUSES a negative span rather than reporting it', () => {
    // Reached by a stream that is out of tick order within one seed -- the other way the pairing
    // can go wrong. A clamp or a filter here would have let the cross-seed defect keep producing
    // low medians indefinitely; it was a negative p50 in one run that exposed it.
    const outOfOrder = [
      { tick: 900, tankId: 1, seed: 1, kind: 'brown', from: undefined, to: 7, reason: 'acquired' },
      { tick: 100, tankId: 1, seed: 1, kind: 'brown', from: 7, to: 8, reason: 'switched-on-expiry' },
    ];
    expect(() => heldSpans(outOfOrder)).toThrow(/negative held span -800.*tank 1.*seed 1/);
    expect(() => heldSpansByEndReason(outOfOrder)).toThrow(/negative held span/);
  });

  it('keeps a seedless change in its own bucket instead of merging every seed', () => {
    // Older recorded data has no `seed`. It must read as ONE stream and be obviously so, not
    // average quietly into correctly-keyed numbers.
    const seedless = [
      { tick: 10, tankId: 1, kind: 'brown', from: undefined, to: 7, reason: 'acquired' },
      { tick: 90, tankId: 1, kind: 'brown', from: 7, to: 8, reason: 'switched-on-expiry' },
    ];
    expect(heldSpans(seedless)).toEqual([80]);
    // The control: a seeded change with the same tankId must not close the seedless one's span.
    const mixed = [...seedless, { tick: 20, tankId: 1, seed: 5, kind: 'brown', from: 8, to: 9, reason: 'target-lost' }];
    expect(heldSpans(mixed)).toEqual([80]);
  });
});
