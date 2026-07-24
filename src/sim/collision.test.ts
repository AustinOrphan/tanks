import { describe, it, expect } from 'vitest';
import { circleVsAABB, circleVsCircle, raySegmentVsAABB } from './collision';
import type { AABB } from './types';
import { vdist } from './types';

const BOX: AABB = { minX: 0, minY: 0, maxX: 2, maxY: 2 };

describe('circleVsAABB', () => {
  it('pushes along the shortest axis when overlapping a face', () => {
    // circle to the left of the box, overlapping the left face
    const hit = circleVsAABB({ x: -0.4, y: 1 }, 0.5, BOX);
    expect(hit.hit).toBe(true);
    // shortest separation is along -x
    expect(hit.push.x).toBeCloseTo(-0.1, 9);
    expect(hit.push.y).toBeCloseTo(0, 9);
  });

  it('pushes diagonally out to a corner', () => {
    // circle beyond the bottom-left corner (0,0)
    const hit = circleVsAABB({ x: -0.2, y: -0.2 }, 0.5, BOX);
    expect(hit.hit).toBe(true);
    expect(hit.push.x).toBeLessThan(0);
    expect(hit.push.y).toBeLessThan(0);
    // pushes back along the corner diagonal (equal components here)
    expect(hit.push.x).toBeCloseTo(hit.push.y, 9);
  });

  it('returns a nonzero push when the center is fully inside', () => {
    const hit = circleVsAABB({ x: 0.5, y: 1 }, 0.3, BOX);
    expect(hit.hit).toBe(true);
    // nearest face is the left face -> push out along -x
    expect(hit.push.x).toBeLessThan(0);
    expect(hit.push.y).toBeCloseTo(0, 9);
    expect(Number.isNaN(hit.push.x)).toBe(false);
  });

  it('returns no hit and zero push when disjoint', () => {
    const hit = circleVsAABB({ x: 5, y: 5 }, 0.5, BOX);
    expect(hit.hit).toBe(false);
    expect(hit.push).toEqual({ x: 0, y: 0 });
  });
});

describe('circleVsCircle', () => {
  it('pushes the first circle away from the second along their center line', () => {
    const hit = circleVsCircle({ x: 0, y: 0 }, 0.5, { x: 0.5, y: 0 }, 0.5);
    expect(hit.hit).toBe(true);
    // overlap is 1.0 - 0.5 = 0.5, directed from b toward a (-x)
    expect(hit.push.x).toBeCloseTo(-0.5, 9);
    expect(hit.push.y).toBeCloseTo(0, 9);
  });

  it('returns no hit when the circles are disjoint', () => {
    const hit = circleVsCircle({ x: 0, y: 0 }, 0.5, { x: 3, y: 0 }, 0.5);
    expect(hit.hit).toBe(false);
    expect(hit.push).toEqual({ x: 0, y: 0 });
  });

  it('produces a deterministic non-NaN direction for concentric circles', () => {
    const hit = circleVsCircle({ x: 1, y: 1 }, 0.5, { x: 1, y: 1 }, 0.5);
    expect(hit.hit).toBe(true);
    expect(Number.isNaN(hit.push.x)).toBe(false);
    expect(Number.isNaN(hit.push.y)).toBe(false);
    // default separation is along +x with magnitude ra+rb
    expect(vdist({ x: 0, y: 0 }, hit.push)).toBeCloseTo(1.0, 9);
  });
});

describe('raySegmentVsAABB', () => {
  const box: AABB = { minX: 1, minY: -1, maxX: 2, maxY: 1 };

  it('hits the left face with the correct t and -x normal', () => {
    const hit = raySegmentVsAABB({ x: 0, y: 0 }, { x: 3, y: 0 }, box);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(1 / 3, 9);
    expect(hit!.point.x).toBeCloseTo(1, 9);
    expect(hit!.point.y).toBeCloseTo(0, 9);
    expect(hit!.normal).toEqual({ x: -1, y: 0 });
  });

  it('returns a defined hit exactly at a corner', () => {
    const cornerBox: AABB = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const hit = raySegmentVsAABB({ x: -1, y: -1 }, { x: 1, y: 1 }, cornerBox);
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(0, 9);
    expect(hit!.point.y).toBeCloseTo(0, 9);
    expect(hit!.t).toBeCloseTo(0.5, 9);
  });

  it('returns null when the segment ends before the box', () => {
    const hit = raySegmentVsAABB({ x: 0, y: 0 }, { x: 0.5, y: 0 }, box);
    expect(hit).toBeNull();
  });

  it('returns null when the segment misses entirely', () => {
    const hit = raySegmentVsAABB({ x: 0, y: 5 }, { x: 3, y: 5 }, box);
    expect(hit).toBeNull();
  });

  it('handles a segment starting inside deterministically (t=0)', () => {
    const hit = raySegmentVsAABB({ x: 1.5, y: 0 }, { x: 3, y: 0 }, box);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBe(0);
    expect(hit!.point).toEqual({ x: 1.5, y: 0 });
  });

  it('does not divide-by-zero on a parallel/grazing segment', () => {
    // vertical segment whose x sits outside the box: dx===0 branch, no NaN
    const hit = raySegmentVsAABB({ x: 5, y: -5 }, { x: 5, y: 5 }, box);
    expect(hit).toBeNull();
  });
});
