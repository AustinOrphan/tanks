import { describe, it, expect } from 'vitest';
import { detSin, detCos, detAtan2 } from './trig';

/**
 * Spot values and edge cases for the vendored sin/cos/atan2. Every expected value
 * below is either a LITERAL fdlibm/IEEE-754 constant (a well-known exact quantity
 * like sin(0)=0) or was READ from Node's own native Math.sin/cos/atan2 on this box
 * (v24.15.0, V8 13.6.233) -- noted per assertion, per this repo's convention that a
 * pinned number states where it came from. This suite is a spot-check, not the
 * correctness proof: the full-sweep bit-compare against Node-native (all 5
 * reachability bands x sin/cos, plus the full atan2 combinatorial sweep --
 * tools/baseline/angles.ts's own generators) is reported in the PR body, not pinned
 * here, since pinning a live comparison against a currently-native function would
 * be the exact moving-target problem this port exists to avoid (see the plan).
 *
 * Each assertion is written against a value the corresponding mutation (a wrong
 * coefficient, a flipped branch, a dropped reduction step) would actually change --
 * not a value trivially true for any implementation (e.g. "not NaN").
 */

describe('detSin / detCos: spot values', () => {
  it('at 0', () => {
    expect(detSin(0)).toBe(0);
    expect(detCos(0)).toBe(1);
  });

  it('at +-pi/2 (Node-native: sin=+-1 exactly; cos is NOT exactly 0 -- Math.PI/2 is a', () => {
    // rounded double, not the true pi/2, so cos(Math.PI/2) is the residual of that
    // rounding error, not zero. Node-native: 6.123233995736766e-17.
    expect(detSin(Math.PI / 2)).toBe(1);
    expect(detCos(Math.PI / 2)).toBe(6.123233995736766e-17);
    expect(detSin(-Math.PI / 2)).toBe(-1);
    expect(detCos(-Math.PI / 2)).toBe(6.123233995736766e-17);
  });

  it('at +-pi (Node-native: cos=-1 exactly; sin is the rounding residual)', () => {
    expect(detCos(Math.PI)).toBe(-1);
    expect(detSin(Math.PI)).toBe(1.2246467991473532e-16);
    expect(detCos(-Math.PI)).toBe(-1);
    expect(detSin(-Math.PI)).toBe(-1.2246467991473532e-16);
  });

  it('at +-3pi/2 (Node-native)', () => {
    expect(detSin((3 * Math.PI) / 2)).toBe(-1);
    expect(detCos((3 * Math.PI) / 2)).toBe(-1.8369701987210297e-16);
    expect(detSin((-3 * Math.PI) / 2)).toBe(1);
    expect(detCos((-3 * Math.PI) / 2)).toBe(-1.8369701987210297e-16);
  });

  it('denormal-adjacent: sin(x)=x, cos(x)=1 for tiny x (fdlibm\'s own documented', () => {
    // small-argument shortcut -- __kernel_sin/__kernel_cos both special-case
    // |x|<2**-27 exactly this way). Node-native agrees exactly.
    expect(detSin(1e-320)).toBe(1e-320);
    expect(detCos(1e-320)).toBe(1);
    expect(detSin(Number.MIN_VALUE)).toBe(5e-324);
    expect(detCos(Number.MIN_VALUE)).toBe(1);
  });

  it('at 1 rad (an ordinary well-conditioned input, Node-native)', () => {
    expect(detSin(1)).toBe(0.8414709848078965);
    expect(detCos(1)).toBe(0.5403023058681398);
  });

  it('large magnitude, past the golden trace\'s own reach: exercises Payne-Hanek', () => {
    // reduction (ieee754RemPio2 -> kernelRemPio2), not just the small-angle kernel.
    // Node-native at this box.
    expect(detSin(1e8)).toBe(0.931639027109726);
    expect(detCos(1e8)).toBe(-0.3633850893556905);
  });

  it('NaN and Infinity: matches Math.sin/Math.cos\'s documented ECMA-262 behaviour', () => {
    expect(Number.isNaN(detSin(Infinity))).toBe(true);
    expect(Number.isNaN(detCos(Infinity))).toBe(true);
    expect(Number.isNaN(detSin(-Infinity))).toBe(true);
    expect(Number.isNaN(detCos(-Infinity))).toBe(true);
    expect(Number.isNaN(detSin(NaN))).toBe(true);
    expect(Number.isNaN(detCos(NaN))).toBe(true);
  });

  it('a wrong coefficient would be caught: the degree-14/13 polynomial terms are not', () => {
    // decorative. Perturbing C1 (kernelCos) or S1 (kernelSin) moves values near 0.5
    // rad (well inside the no-reduction branch, |x|<0.3 sub-branch) measurably --
    // this is the mutation this spot check is written against, not merely "does not
    // throw".
    expect(detSin(0.5)).toBe(Math.sin(0.5));
    expect(detCos(0.5)).toBe(Math.cos(0.5));
  });
});

describe('detAtan2: spot values', () => {
  it('the four diagonal quadrants (Node-native)', () => {
    expect(detAtan2(1, 1)).toBe(0.7853981633974483);
    expect(detAtan2(1, -1)).toBe(2.356194490192345);
    expect(detAtan2(-1, -1)).toBe(-2.356194490192345);
    expect(detAtan2(-1, 1)).toBe(-0.7853981633974483);
  });

  it('on the axes (Node-native)', () => {
    expect(detAtan2(0, 1)).toBe(0);
    expect(detAtan2(0, -1)).toBe(Math.PI);
    expect(detAtan2(1, 0)).toBe(Math.PI / 2);
    expect(detAtan2(-1, 0)).toBe(-Math.PI / 2);
  });

  it('signed zeros: ECMA-262 gives atan2 four distinct answers for (+-0,+-0) and', () => {
    // (+-0, +anything)/(+-0,-anything) -- this is the classic place a naive port
    // collapses -0 into 0 and silently fails half these cases.
    expect(Object.is(detAtan2(0, 0), 0)).toBe(true);
    expect(Object.is(detAtan2(-0, 0), -0)).toBe(true);
    expect(detAtan2(0, -0)).toBe(Math.PI);
    expect(detAtan2(-0, -0)).toBe(-Math.PI);
    expect(Object.is(detAtan2(0, 1), 0)).toBe(true);
    expect(detAtan2(-0, -1)).toBe(-Math.PI);
  });

  it('Infinity combinations (Node-native, ECMA-262 special cases)', () => {
    expect(detAtan2(1, Infinity)).toBe(0);
    expect(detAtan2(1, -Infinity)).toBe(Math.PI);
    expect(detAtan2(Infinity, 1)).toBe(Math.PI / 2);
    expect(detAtan2(Infinity, Infinity)).toBe(Math.PI / 4);
    expect(detAtan2(Infinity, -Infinity)).toBe((3 * Math.PI) / 4);
  });

  it('NaN propagates', () => {
    expect(Number.isNaN(detAtan2(NaN, 1))).toBe(true);
    expect(Number.isNaN(detAtan2(1, NaN))).toBe(true);
  });

  it('x=1.0 exactly takes the atan(y) shortcut branch (e_atan2.c\'s own special case)', () => {
    expect(detAtan2(0.5, 1)).toBe(Math.atan2(0.5, 1));
    expect(detAtan2(-2.5, 1)).toBe(Math.atan2(-2.5, 1));
  });

  it('huge |y/x| ratio (k>60 branch, the one carrying the V8 m&=1 delta): matches', () => {
    // Node-native regardless of x's sign, which is exactly what that delta is for
    // -- see trig.ts's header. Without `m &= 1` this would still be numerically
    // close but not bit-identical on the negative-x cases.
    const hugeY = 1e300;
    const tinyX = 1e-30;
    expect(detAtan2(hugeY, tinyX)).toBe(Math.atan2(hugeY, tinyX));
    expect(detAtan2(hugeY, -tinyX)).toBe(Math.atan2(hugeY, -tinyX));
    expect(detAtan2(-hugeY, tinyX)).toBe(Math.atan2(-hugeY, tinyX));
    expect(detAtan2(-hugeY, -tinyX)).toBe(Math.atan2(-hugeY, -tinyX));
  });

  it('tiny |x| just below/above the V8 atan threshold delta (2**-27 vs netlib\'s', () => {
    // 2**-29): matches Node-native either side of the boundary this file's header
    // documents as a verified V8-vs-netlib difference.
    const below = Math.pow(2, -30); // < 2**-29: below both thresholds
    const between = 6e-9; // between 2**-29 (~1.86e-9) and 2**-27 (~7.45e-9)
    expect(detAtan2(below, 1)).toBe(Math.atan2(below, 1));
    expect(detAtan2(between, 1)).toBe(Math.atan2(between, 1));
  });
});
