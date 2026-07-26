import { describe, it, expect } from 'vitest';
import { lerp, lerpAngle, lerpVec2 } from './interpolate';

describe('lerp', () => {
  it('returns endpoints and midpoint', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
  });

  it('handles negative ranges', () => {
    expect(lerp(-4, 4, 0.25)).toBeCloseTo(-2, 6);
  });
});

// Wraps a raw angle difference into (-pi, pi]. Used only by the test helper
// below to assert congruence mod 2*pi without caring which "lap" the raw
// output landed on -- lerpAngle's contract (see the range test) is that its
// output is NOT normalized, so bit-for-bit equality is the wrong check for
// any case that actually crosses the wrap.
function normalizeAngle(a: number): number {
  const TWO_PI = Math.PI * 2;
  let x = a % TWO_PI;
  if (x > Math.PI) x -= TWO_PI;
  if (x <= -Math.PI) x += TWO_PI;
  return x;
}

function expectAngleCongruent(actual: number, expected: number, precision = 6) {
  // Two angles are "the same angle" iff their difference is congruent to 0
  // mod 2*pi. Compare via normalizeAngle(actual - expected) rather than
  // normalizing each side separately and comparing floats to avoid
  // boundary flakiness right at +/-pi.
  expect(normalizeAngle(actual - expected)).toBeCloseTo(0, precision);
}

describe('lerpAngle', () => {
  it('takes the short way across the -pi/pi wrap (170deg -> -170deg through 180deg)', () => {
    const a = (170 * Math.PI) / 180;
    const b = (-170 * Math.PI) / 180;
    // Short arc is +20deg through +/-180, so the midpoint is exactly PI.
    expect(lerpAngle(a, b, 0.5)).toBeCloseTo(Math.PI, 6);
  });

  it('takes the short way across the wrap in the mirror direction (-170deg -> 170deg through -180deg)', () => {
    // Hand derivation:
    //   a = -170deg = -17*pi/18 rad ~= -2.96705972839
    //   b =  170deg =  17*pi/18 rad ~=  2.96705972839
    //   raw delta = b - a = 340deg = 17*pi/9 rad ~= 5.93411945679
    //   delta % 2pi = 5.93411945679 (already < 2pi, sign preserved: positive)
    //   delta > pi (3.14159...), so delta -= 2pi:
    //     5.93411945679 - 6.28318530718 = -0.34906585039 rad (= -20deg)
    //   => short arc is -20deg, through -180/+180, NOT the long way through 0.
    // At t=0.5: result = a + delta*0.5
    //   = -17*pi/18 + (-pi/9)*0.5 = -17*pi/18 - pi/18 = -18*pi/18 = -pi
    const a = (-170 * Math.PI) / 180;
    const b = (170 * Math.PI) / 180;
    expect(lerpAngle(a, b, 0.5)).toBeCloseTo(-Math.PI, 6);
  });

  it('interpolates normally within range', () => {
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 6);
  });

  it('returns endpoints at t=0 and t=1', () => {
    expect(lerpAngle(0.3, 1.2, 0)).toBeCloseTo(0.3, 6);
    expect(lerpAngle(0.3, 1.2, 1)).toBeCloseTo(1.2, 6);
  });

  it('at t=0 returns exactly a, and at t=1 returns b or a value congruent to b mod 2pi, even across the wrap', () => {
    // Using the same 170deg -> -170deg pair as above, where the short-arc
    // delta is +20deg (see the first test's derivation).
    const a = (170 * Math.PI) / 180;
    const b = (-170 * Math.PI) / 180;

    // t=0: no wrap correction applied yet (delta * 0 === 0), so this must
    // be the literal input `a`, not merely close to it.
    expect(lerpAngle(a, b, 0)).toBe(a);

    // t=1: result = a + delta = 170deg + 20deg = 190deg raw (~3.3161 rad),
    // which is NOT bit-equal to b's raw representation (-170deg raw,
    // ~-2.9671 rad) -- lerpAngle does not renormalize its output (see the
    // range test below). 190deg and -170deg ARE the same angle though
    // (190 - 360 = -170), so assert congruence mod 2pi explicitly instead
    // of loosening to a wide toBeCloseTo tolerance.
    const result = lerpAngle(a, b, 1);
    expect(result).not.toBeCloseTo(b, 6); // raw values differ...
    expectAngleCongruent(result, b); // ...but represent the same angle
  });

  it('does not take a 320deg detour for a short interpolation well inside range (10deg -> 50deg)', () => {
    const a = (10 * Math.PI) / 180;
    const b = (50 * Math.PI) / 180;
    // Plain lerp and lerpAngle must agree here: no wrap is needed for a
    // 40deg gap, so this must behave exactly like lerp(a, b, t).
    expect(lerpAngle(a, b, 0.5)).toBeCloseTo(lerp(a, b, 0.5), 6);
    expect(lerpAngle(a, b, 0.5)).toBeCloseTo((30 * Math.PI) / 180, 6);
  });

  it('reduces a multi-lap raw difference before choosing the short arc', () => {
    // Nothing else in this file ever hands lerpAngle a raw `b - a` bigger than
    // 2pi, so the leading `% TWO_PI` in the implementation could be DELETED
    // with the whole suite still green. It is not dead code: turret angles
    // accumulate unbounded by design -- slewAngle (src/sim/types.ts) returns
    // `current + step` and never renormalizes, and lerpAngle's own contract
    // says its output is not renormalized either, so a turret that keeps
    // turning one way drifts several laps away from its rendered value and
    // multi-lap deltas are reachable in a real round.
    //
    // Derivation for a = 0, b = 4pi + 0.1 (two full laps plus 0.1 rad):
    //   with the modulo:  delta = (4pi + 0.1) % 2pi = 0.1   -> no correction
    //                     needed (0.1 < pi) -> result = 0 + 0.1 * 0.5 = 0.05
    //   without it:       delta = 4pi + 0.1 ~= 12.666, one `delta -= 2pi`
    //                     correction fires (the ifs are not loops) leaving
    //                     ~6.3835, still more than a full lap
    //                     -> result ~= 3.1916, i.e. a 183-degree turret snap
    //                     instead of a 3-degree nudge.
    expect(lerpAngle(0, 4 * Math.PI + 0.1, 0.5)).toBeCloseTo(0.05, 9);

    // Mirrored, so a sign error in the reduction cannot hide here either.
    expect(lerpAngle(0, -(4 * Math.PI) - 0.1, 0.5)).toBeCloseTo(-0.05, 9);
  });

  it('resolves the antipodal tie (exactly pi apart) deterministically', () => {
    // 0 -> pi: both the +pi/2 arc and the -pi/2 arc are equally short (each
    // exactly pi). This is a genuine tie with no "more correct" answer;
    // what matters is that the implementation is deterministic rather than
    // flipping on a refactor.
    //
    // Derivation for THIS implementation:
    //   delta = (pi - 0) % 2pi = pi
    //   the wrap-correction only fires on STRICT inequality (`> pi` / `< -pi`),
    //   so delta === pi is left unchanged (not flipped to -pi).
    //   => result = 0 + pi*t, i.e. it resolves toward the POSITIVE/CCW arc.
    // At t=0.5: result = pi/2.
    expect(lerpAngle(0, Math.PI, 0.5)).toBeCloseTo(Math.PI / 2, 10);
  });

  it('output is not normalized to (-pi, pi]: it can exceed that range when the short arc crosses a boundary', () => {
    // Same pair as the wrap test: a=170deg, b=-170deg, t=1 lands at 190deg
    // raw (~3.3161 rad), which is OUTSIDE (-pi, pi] (pi ~= 3.14159).
    // This is the contract lerpAngle actually implements: it returns
    // a + delta*t with NO final renormalization pass. Three.js's
    // object.rotation.y accepts unbounded radian values, so this is fine
    // for the render consumer, but it must be stated and pinned rather
    // than left as an accident of the implementation.
    const a = (170 * Math.PI) / 180;
    const b = (-170 * Math.PI) / 180;
    const result = lerpAngle(a, b, 1);
    expect(result).toBeGreaterThan(Math.PI);
    expect(result).toBeCloseTo((190 * Math.PI) / 180, 6);
  });
});

describe('lerpVec2', () => {
  it('interpolates both components independently', () => {
    expect(lerpVec2({ x: 0, y: 4 }, { x: 10, y: 8 }, 0.5)).toEqual({ x: 5, y: 6 });
  });
});
