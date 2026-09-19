// The pure half of the AI target-commitment sweep (issue #359).
//
// The runner patches validated config on disk and spawns a simulation per value, so none of
// it is cheap to test. Everything worth asserting was therefore put in `stats.mjs`, and this
// is what holds it honest -- in particular the verdict, which exists to stop the sweep
// publishing a comparison it has no basis for.
import { describe, it, expect } from 'vitest';
import { parseSeeds, distribution, heldSpans, summarise, knobIsWired } from './stats.mjs';

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
