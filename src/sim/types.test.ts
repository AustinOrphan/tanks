import { describe, it, expect } from 'vitest';
import {
  vadd, vsub, vscale, vlen, vnorm, vdot, vdist, angleOf, fromAngle, nextRng,
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
