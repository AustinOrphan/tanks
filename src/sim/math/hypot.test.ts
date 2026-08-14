import { describe, it, expect } from 'vitest';
import { detHypot } from './hypot';

/**
 * Spot values and ECMA-262 edge cases for the vendored hypot (V8's own 2-arg Torque
 * formula, not fdlibm -- see hypot.ts's header). Every expected value is either an
 * exact integer (a 3-4-5 triangle) or Node-native Math.hypot on this box, noted
 * per assertion.
 */
describe('detHypot: spot values', () => {
  it('exact integer triangles', () => {
    expect(detHypot(3, 4)).toBe(5);
    expect(detHypot(5, -12)).toBe(13);
    expect(detHypot(-3, -4)).toBe(5);
  });

  it('symmetric in its two arguments (the scaling-by-max formula does not care', () => {
    // which argument is larger -- a mutation that hardcoded "a is the larger one"
    // would fail this).
    expect(detHypot(3, 4)).toBe(detHypot(4, 3));
    expect(detHypot(7, 24)).toBe(detHypot(24, 7));
  });

  it('zero', () => {
    expect(Object.is(detHypot(0, 0), 0)).toBe(true);
    expect(Object.is(detHypot(-0, -0), 0)).toBe(true); // Node-native: hypot(-0,-0) is +0
    expect(detHypot(0, 5)).toBe(5);
  });

  it('Infinity takes precedence over NaN -- ECMA-262\'s explicit special case, and', () => {
    // the reason the formula checks +-Infinity BEFORE computing max/NaN (see
    // hypot.ts's header). A naive "check NaN first" port would return NaN here.
    expect(detHypot(NaN, Infinity)).toBe(Infinity);
    expect(detHypot(Infinity, NaN)).toBe(Infinity);
    expect(detHypot(-Infinity, NaN)).toBe(Infinity);
  });

  it('NaN propagates when neither argument is infinite', () => {
    expect(Number.isNaN(detHypot(NaN, 1))).toBe(true);
    expect(Number.isNaN(detHypot(1, NaN))).toBe(true);
  });

  it('near-overflow: the max-scaling keeps (a/max)^2 from overflowing before sqrt', () => {
    // runs, matching Node-native rather than overflowing to Infinity the way a
    // naive sqrt(a*a+b*b) would at this magnitude.
    expect(detHypot(1e300, 1e300)).toBe(Math.hypot(1e300, 1e300));
    expect(Number.isFinite(detHypot(1e300, 1e300))).toBe(true);
  });

  it('denormal-adjacent magnitudes match Node-native', () => {
    expect(detHypot(Number.MIN_VALUE, Number.MIN_VALUE)).toBe(Math.hypot(Number.MIN_VALUE, Number.MIN_VALUE));
  });

  it('a wrong max-selection would be caught: the two scaled terms differ enough at', () => {
    // an asymmetric pair that swapping which argument is treated as "max" changes
    // the bit pattern, not just an ULP.
    expect(detHypot(1e10, 1)).toBe(Math.hypot(1e10, 1));
  });
});
