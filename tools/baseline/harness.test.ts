// Pins the two pure pieces of tools/baseline/harness.mjs: reportResult's exit-code
// semantics and the beacon report timeout's timer lifecycle. The rest (spawnVite,
// waitForVite, startBeaconCollector, ...) is exercised by actually running run.mjs (npm
// run trace:browser) and by the beacon end-to-end check, not by vitest -- starting a real
// vite server/http listener here would duplicate what run.mjs proves on every CI run.
import { afterEach, describe, it, expect, vi } from 'vitest';
// @ts-expect-error -- plain .mjs, deliberately dependency-free (see the file's own header)
import { reportResult, waitForBeaconReport } from './harness.mjs';

const ok = (extra = {}) => ({ match: true, hash: 'h', ms: 1, textLength: 1, userAgent: 'ua', ...extra });
const okBands = (extra = {}) => ({ match: true, hash: 'h', ms: 1, bands: [], userAgent: 'ua', ...extra });

describe('reportResult', () => {
  it('all three matching: 0 failures', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(reportResult('x', ok(), okBands(), okBands())).toBe(0);
    spy.mockRestore();
  });

  it('a trace MISMATCH counts', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(reportResult('x', ok({ match: false }), okBands(), okBands())).toBe(1);
    spy.mockRestore();
  });

  it('a native angle MISMATCH does NOT count -- structural, not a regression (see angles.ts)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(reportResult('x', ok(), okBands({ match: false }), okBands())).toBe(0);
    spy.mockRestore();
  });

  it('a vendored angle MISMATCH counts -- issue #133s construction guarantee', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(reportResult('x', ok(), okBands(), okBands({ match: false }))).toBe(1);
    spy.mockRestore();
  });

  it('a hard error in any of the three always counts, including the native angle probe', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(reportResult('x', { error: 'boom' }, okBands(), okBands())).toBe(1);
    expect(reportResult('x', ok(), { error: 'boom' }, okBands())).toBe(1);
    expect(reportResult('x', ok(), okBands(), { error: 'boom' })).toBe(1);
    spy.mockRestore();
  });

  it('errors and mismatches stack: all three broken is 3', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(
      reportResult('x', ok({ match: false }), okBands(), okBands({ match: false })),
    ).toBe(2);
    spy.mockRestore();
  });
});

describe('waitForBeaconReport', () => {
  afterEach(() => vi.useRealTimers());

  it('clears the long timeout as soon as a report arrives', async () => {
    vi.useFakeTimers();
    const report = { userAgent: 'Mobile Safari' };

    await expect(waitForBeaconReport(Promise.resolve(report), 300_000)).resolves.toBe(report);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('still rejects with the configured budget when no report arrives', async () => {
    vi.useFakeTimers();
    const waiting = expect(
      waitForBeaconReport(new Promise(() => {}), 300_000),
    ).rejects.toThrow('no report received within 300000ms');

    await vi.advanceTimersByTimeAsync(300_000);

    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });
});
