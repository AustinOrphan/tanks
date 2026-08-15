// Pins reportResult's exit-code semantics -- the one piece of tools/baseline/harness.mjs
// that is pure and does not touch a network or a process, so it is the one worth a unit
// test here. The rest (spawnVite, waitForVite, startBeaconCollector, ...) is exercised by
// actually running run.mjs (npm run trace:browser) and by the beacon end-to-end check
// described in this PR, not by vitest -- starting a real vite server/http listener from
// this file would duplicate what run.mjs itself already proves on every CI run.
import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error -- plain .mjs, deliberately dependency-free (see the file's own header)
import { reportResult } from './harness.mjs';

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
