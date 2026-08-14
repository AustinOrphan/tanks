import { describe, it, expect } from 'vitest';
import { scalbn } from './rem-pio2';
import { detSin, detCos } from './trig';

/**
 * scalbn(x,n) = x * 2**n by exponent manipulation (netlib's s_scalbn.c, an
 * "External function" k_rem_pio2.c calls -- see rem-pio2.ts's header). Expected
 * values are exact: multiplying by a power of two never rounds (the mantissa is
 * unchanged, only the exponent moves), so these are checkable by hand, not
 * Node-native readings.
 *
 * The Payne-Hanek reduction this file's kernelRemPio2/ieee754RemPio2 implement is
 * exercised indirectly by trig.test.ts's large-magnitude sin/cos cases (any |x|
 * over ~2^19*(pi/2) routes through them) and directly here by re-deriving one of
 * those same large values from scalbn + detSin/detCos, so a scalbn regression that
 * trig.test.ts's spot values happened not to disturb still has a place to be
 * caught.
 */
describe('scalbn', () => {
  it('positive n scales up by an exact power of two', () => {
    expect(scalbn(1, 10)).toBe(1024);
    expect(scalbn(1.5, 3)).toBe(12);
  });

  it('negative n scales down by an exact power of two', () => {
    expect(scalbn(1, -10)).toBe(0.0009765625);
    expect(scalbn(3, -3)).toBe(0.375);
  });

  it('n=0 is the identity', () => {
    expect(scalbn(7.25, 0)).toBe(7.25);
  });

  it('preserves sign, including of zero', () => {
    expect(scalbn(-2, 4)).toBe(-32);
    expect(Object.is(scalbn(-0, 5), -0)).toBe(true);
  });

  it('underflows to zero, signed, far enough down (a mutation that dropped the', () => {
    // subnormal path would instead throw or return a normal-range value here)
    expect(scalbn(1, -2000)).toBe(0);
    expect(Object.is(scalbn(-1, -2000), -0)).toBe(true);
  });

  it('overflows to signed Infinity far enough up', () => {
    expect(scalbn(1, 2000)).toBe(Infinity);
    expect(scalbn(-1, 2000)).toBe(-Infinity);
  });

  it('NaN and Infinity pass through unchanged in sign/kind', () => {
    expect(Number.isNaN(scalbn(NaN, 5))).toBe(true);
    expect(scalbn(Infinity, -5)).toBe(Infinity);
    expect(scalbn(-Infinity, 5)).toBe(-Infinity);
  });

  it('a subnormal input still scales correctly (exercises the k===0 branch)', () => {
    // Number.MIN_VALUE = 2**-1074; scaling up by 2**1074 recovers exactly 1.
    expect(scalbn(Number.MIN_VALUE, 1074)).toBe(1);
  });
});

describe('large-magnitude reduction (kernelRemPio2/ieee754RemPio2), cross-checked via scalbn', () => {
  it('a value built as k*2**900 for an odd integer k -- forcing the Payne-Hanek', () => {
    // large-argument path in ieee754RemPio2 -- matches Node-native sin/cos exactly.
    // (trig.test.ts's 1e8 case already exercises this path; this input is chosen
    // independently, via scalbn rather than a decimal literal, so it is not the
    // same code path's sample twice over.)
    const x = scalbn(12345, 900);
    expect(detSin(x)).toBe(Math.sin(x));
    expect(detCos(x)).toBe(Math.cos(x));
  });
});
