import { describe, it, expect } from 'vitest';
import { lineOfSight, aimLead } from './targeting';
import type { Wall } from '../types';

function wall(id: number, minX: number, minY: number, maxX: number, maxY: number,
             kind: 'solid' | 'destructible' = 'solid', destroyed = false): Wall {
  return { id, aabb: { minX, minY, maxX, maxY }, kind, destroyed };
}

describe('lineOfSight', () => {
  it('is blocked by a solid wall between the two points', () => {
    const walls = [wall(1, 1.5, -1, 2.5, 1)];
    expect(lineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 }, walls)).toBe(false);
  });

  it('is clear through a gap between walls', () => {
    const walls = [wall(1, 1.5, 1, 2.5, 3), wall(2, 1.5, -3, 2.5, -1)];
    expect(lineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 }, walls)).toBe(true);
  });

  it('is clear once the blocking wall is destroyed', () => {
    const walls = [wall(1, 1.5, -1, 2.5, 1, 'destructible', true)];
    expect(lineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 }, walls)).toBe(true);
  });
});

describe('aimLead', () => {
  it('aims directly at a stationary target', () => {
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 0 }, 6);
    expect(angle).toBeCloseTo(0, 6);
  });

  it('leads a crossing target ahead of its current position', () => {
    // target at (5,0) moving +y at 3, bullet speed 6.
    // a = 9-36 = -27, b = 0, c = 25, D = 2700, t = sqrt(2700)/54 = 0.96225...
    // intercept = (5, 2.88675) -> angle = atan2(2.88675, 5) = pi/6 exactly.
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 3 }, 6);
    expect(angle).toBeCloseTo(Math.PI / 6, 9);
  });

  it('returns a sane direct-aim angle when no intercept exists (target faster than bullet)', () => {
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 100, y: 0 }, 6);
    expect(Number.isNaN(angle)).toBe(false);
    expect(angle).toBeCloseTo(0, 6); // falls back to direct aim
  });

  it('selects the earlier (Math.min) root when both quadratic roots are positive', () => {
    // Head-on closing target: rel=(5,0), v=(-10,0), s=6.
    // a = 100-36 = 64, b = 2*(5*-10) = -100, c = 25.
    // D = 10000-6400 = 3600, sqrt(D) = 60.
    // t1 = (100+60)/128 = 1.25, t2 = (100-60)/128 = 0.3125 -> both positive, pick min = t2.
    // intercept = (5 + -10*0.3125, 0) = (1.875, 0) -> angle = 0.
    // (The rejected root t1 gives intercept (-7.5, 0) -> angle = pi, so this
    // assertion alone already distinguishes correct vs. incorrect root choice.)
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: -10, y: 0 }, 6);
    expect(angle).toBeCloseTo(0, 9);
  });

  it('selects the earlier root with a case where the two roots differ in angle', () => {
    // rel=(5,0), v=(-10,3), s=6.
    // a = (100+9)-36 = 73, b = 2*(5*-10) = -100, c = 25.
    // D = 10000 - 4*73*25 = 2700, sqrt(D) = 30*sqrt(3).
    // t1 = (100+30*sqrt(3))/146 = 1.04083..., t2 = (100-30*sqrt(3))/146 = 0.32903...
    // both positive -> pick min = t2.
    // intercept = (5-10*t2, 3*t2) = (-7/6 * ... ) -> exactly (x = y*sqrt(3)),
    // so angle = atan2(y, x) = pi/6 exactly (verified numerically: 0.5235987755982988).
    // The rejected root t1 gives intercept angle ~2.618 (150 degrees), so this
    // pins root selection via the angle itself.
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: -10, y: 3 }, 6);
    expect(angle).toBeCloseTo(Math.PI / 6, 9);
  });

  it('uses the linear (|a| < AIM_EPS) branch when target speed equals bullet speed', () => {
    // rel=(3,4), v=(-5,0), s=5 -> |v| = s = 5 so a = 25-25 = 0 (degenerate quadratic).
    // b = 2*(3*-5 + 4*0) = -30 (< 0, so t = -c/b is positive), c = 3^2+4^2 = 25.
    // t = -25/-30 = 5/6.
    // intercept = (3 + -5*5/6, 4 + 0) = (-7/6, 4) -> angle = atan2(4, -7/6)
    // = atan2(24, -7) = 1.8545904360032246 (not the fallback angleOf(rel),
    // which would be atan2(4,3) = 0.9272952180016122 -- distinct, so this
    // pins the linear branch actually running rather than falling back).
    const angle = aimLead({ x: 0, y: 0 }, { x: 3, y: 4 }, { x: -5, y: 0 }, 5);
    expect(angle).toBeCloseTo(1.8545904360032246, 9);
  });

  it('aims directly (angle 0, not NaN) when the target is exactly at the muzzle', () => {
    const angle = aimLead({ x: 2, y: -1 }, { x: 2, y: -1 }, { x: 0, y: 0 }, 6);
    expect(Number.isNaN(angle)).toBe(false);
    expect(angle).toBe(0);
  });
});
