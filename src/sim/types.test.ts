import { describe, it, expect } from 'vitest';
import {
  vadd, vsub, vscale, vlen, vnorm, vdot, vdist, angleOf, fromAngle, nextRng, slewAngle,
} from './types';
import type { Vec2 } from './types';

describe('vec math', () => {
  it('vadd / vsub add and subtract componentwise', () => {
    expect(vadd({ x: 1, y: 2 }, { x: 3, y: -1 })).toEqual({ x: 4, y: 1 });
    expect(vsub({ x: 1, y: 2 }, { x: 3, y: -1 })).toEqual({ x: -2, y: 3 });
  });

  it('vscale multiplies both components', () => {
    expect(vscale({ x: 2, y: -3 }, 2)).toEqual({ x: 4, y: -6 });
  });

  it('vlen / vdist measure length and distance', () => {
    expect(vlen({ x: 3, y: 4 })).toBeCloseTo(5, 10);
    expect(vdist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5, 10);
  });

  it('vdot computes the dot product', () => {
    expect(vdot({ x: 1, y: 2 }, { x: 3, y: 4 })).toBe(11);
  });

  it('vnorm returns a unit vector', () => {
    const n = vnorm({ x: 3, y: 4 });
    expect(vlen(n)).toBeCloseTo(1, 10);
    expect(n.x).toBeCloseTo(0.6, 10);
    expect(n.y).toBeCloseTo(0.8, 10);
  });

  it('vnorm of the zero vector returns {0,0} (no NaN)', () => {
    const n = vnorm({ x: 0, y: 0 });
    expect(n).toEqual({ x: 0, y: 0 });
    expect(Number.isNaN(n.x)).toBe(false);
    expect(Number.isNaN(n.y)).toBe(false);
  });

  it('angleOf and fromAngle round-trip', () => {
    const r = 0.7;
    const v: Vec2 = fromAngle(r);
    expect(vlen(v)).toBeCloseTo(1, 10);
    expect(angleOf(v)).toBeCloseTo(r, 10);
  });
});

describe('slewAngle', () => {
  it('steps by exactly maxDelta when the target is far away', () => {
    // current=0, target=90deg, maxDelta=0.1rad: remaining (~1.5708) >> maxDelta, so the
    // result is just current + maxDelta, not the target.
    const result = slewAngle(0, Math.PI / 2, 0.1);
    expect(result).toBe(0.1);
  });

  it('returns the target exactly when within maxDelta (no overshoot)', () => {
    // remaining (0.05) < maxDelta (0.1) -> snaps to target exactly.
    expect(slewAngle(0, 0.05, 0.1)).toBe(0.05);
    // remaining === maxDelta exactly (boundary uses <=) -> also returns target exactly.
    expect(slewAngle(0, 0.1, 0.1)).toBe(0.1);
  });

  it('is a no-op when current === target', () => {
    expect(slewAngle(1.2345, 1.2345, 0.1)).toBe(1.2345);
  });

  it('takes the short way across the +pi/-pi wrap: 170deg -> -170deg moves FORWARD through 180deg, not backward through 0', () => {
    // Naive lerp of the raw numbers (170 -> -170) would sweep -340deg through 0deg. The
    // shortest arc is only +20deg, forward through the +-180 seam.
    const current = (170 * Math.PI) / 180;
    const target = (-170 * Math.PI) / 180;
    const maxDelta = (15 * Math.PI) / 180; // less than the 20deg remaining -> partial step
    const result = slewAngle(current, target, maxDelta);
    // Steps +15deg from 170deg (to 185deg, unnormalized) -- NOT -15deg (which would head
    // the long way back toward 0).
    expect(result).toBeCloseTo(current + maxDelta, 12);
  });

  it('takes the short way across the wrap in the mirrored direction: -170deg -> 170deg moves BACKWARD through -180deg', () => {
    const current = (-170 * Math.PI) / 180;
    const target = (170 * Math.PI) / 180;
    const maxDelta = (15 * Math.PI) / 180;
    const result = slewAngle(current, target, maxDelta);
    expect(result).toBeCloseTo(current - maxDelta, 12);
  });

  it('resolves the antipodal case (exactly pi apart) deterministically', () => {
    // current=0, target=pi: the two arcs are equal length, so the choice of direction is
    // arbitrary -- but it must be STABLE (same answer every call). This implementation's
    // wrap correction only fires on strict inequality (> pi / < -pi), so a raw delta of
    // exactly +pi is left unchanged and resolves positive/CCW (same tie-break rationale
    // as lerpAngle in src/render/interpolate.ts). Pinned here so a future refactor that
    // silently flips the tie-break direction is caught.
    const maxDelta = 0.5;
    expect(slewAngle(0, Math.PI, maxDelta)).toBeCloseTo(maxDelta, 12);
  });
});

describe('nextRng', () => {
  it('is deterministic for a fixed seed', () => {
    expect(nextRng(12345)).toEqual(nextRng(12345));
  });

  it('advances the seed (chained calls differ)', () => {
    const a = nextRng(1);
    const b = nextRng(a.seed);
    expect(a.value).not.toBe(b.value);
    expect(a.seed).not.toBe(1);
  });

  it('stays in [0,1) across a range of seeds', () => {
    let seed = 7;
    for (let i = 0; i < 1000; i++) {
      const r = nextRng(seed);
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThan(1);
      seed = r.seed;
    }
  });
});
