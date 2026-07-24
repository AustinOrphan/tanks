import { describe, it, expect } from 'vitest';
import { circleVsAABB, circleVsCircle, raySegmentVsAABB, reflectSweep } from './collision';
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
    // Documents current tie-break behavior: X slab is evaluated first and sets
    // tmin/normal; the Y slab's t1 ties tmin exactly, and `t1 > tmin` is false
    // on equality, so the Y slab never overwrites normal. Pinning this so the
    // tie-break isn't an unasserted accident of evaluation order.
    expect(hit!.normal).toEqual({ x: -1, y: 0 });
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
    // Documents current degenerate-default behavior: since t=0 already
    // satisfies both slabs, neither the X nor Y slab's `t1 > tmin` check ever
    // fires, so `normal` never leaves its {0,0} initializer.
    expect(hit!.normal).toEqual({ x: 0, y: 0 });
  });

  it('does not divide-by-zero on a parallel/grazing segment', () => {
    // vertical segment whose x sits outside the box: dx===0 branch, no NaN
    const hit = raySegmentVsAABB({ x: 5, y: -5 }, { x: 5, y: 5 }, box);
    expect(hit).toBeNull();
  });

  it('hits the right (maxX) face when moving in -x (X-slab swap branch)', () => {
    const hit = raySegmentVsAABB({ x: 3, y: 0 }, { x: 0, y: 0 }, box);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(1 / 3, 9);
    expect(hit!.point.x).toBeCloseTo(2, 9);
    expect(hit!.point.y).toBeCloseTo(0, 9);
    expect(hit!.normal).toEqual({ x: 1, y: 0 });
  });

  it('hits the top (maxY) face when moving in -y (Y-slab swap branch)', () => {
    const hit = raySegmentVsAABB({ x: 1.5, y: 3 }, { x: 1.5, y: 0 }, box);
    expect(hit).not.toBeNull();
    // dy = -3; t1 = (maxY - from.y) / dy = (1 - 3) / -3 = 2/3 after the swap
    expect(hit!.t).toBeCloseTo(2 / 3, 9);
    expect(hit!.point.x).toBeCloseTo(1.5, 9);
    expect(hit!.point.y).toBeCloseTo(1, 9);
    expect(hit!.normal).toEqual({ x: 0, y: 1 });
  });

  it('returns null for a horizontal segment whose y is outside the box (dy===0 parallel-reject branch)', () => {
    // Purely horizontal ray directly under the box (x in [1,2] matches the box's
    // x-extent) at y=-5, clearly outside [minY,maxY]=[-1,1]. The X slab does not
    // reject, so this exercises the Y slab's dy===0 reject arm specifically,
    // distinct from the existing "misses entirely" test above.
    const hit = raySegmentVsAABB({ x: 1, y: -5 }, { x: 2, y: -5 }, box);
    expect(hit).toBeNull();
  });
});

describe('reflectSweep', () => {
  it('passes straight through open space with no hits', () => {
    const res = reflectSweep({ x: 0, y: 0 }, { x: 1, y: 0 }, [], 1);
    expect(res.end.x).toBeCloseTo(1, 9);
    expect(res.end.y).toBeCloseTo(0, 9);
    expect(res.hits).toHaveLength(0);
    expect(res.expired).toBe(false);
    expect(res.dir.x).toBeCloseTo(1, 9);
  });

  it('reflects off a vertical wall, flipping the x component only', () => {
    const wall: AABB = { minX: 1, minY: -1, maxX: 2, maxY: 1 };
    const res = reflectSweep({ x: 0, y: 0 }, { x: 2, y: 0 }, [wall], 1);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].normal).toEqual({ x: -1, y: 0 });
    expect(res.hits[0].point.x).toBeCloseTo(1, 9);
    expect(res.dir.x).toBeLessThan(0); // heading reversed in x
    expect(res.dir.y).toBeCloseTo(0, 9);
    expect(res.bouncesLeft).toBe(0);
    expect(res.expired).toBe(false);
  });

  it('EXACT corner hit produces TWO SweepHits at the same point (both axes reflect)', () => {
    const wall: AABB = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const res = reflectSweep({ x: -1, y: -1 }, { x: 1, y: 1 }, [wall], 3);
    expect(res.hits).toHaveLength(2);
    expect(res.hits[0].point.x).toBeCloseTo(0, 9);
    expect(res.hits[0].point.y).toBeCloseTo(0, 9);
    expect(res.hits[1].point.x).toBeCloseTo(0, 9);
    expect(res.hits[1].point.y).toBeCloseTo(0, 9);
    // one hit per axis
    const normals = res.hits.map((h) => `${h.normal.x},${h.normal.y}`).sort();
    expect(normals).toEqual(['-1,0', '0,-1']);
    // both components of travel reversed -> retroreflection back toward origin
    expect(res.dir.x).toBeLessThan(0);
    expect(res.dir.y).toBeLessThan(0);
  });

  it('with bounces:0, stops at the wall and marks expired', () => {
    const wall: AABB = { minX: 1, minY: -1, maxX: 2, maxY: 1 };
    const res = reflectSweep({ x: 0, y: 0 }, { x: 3, y: 0 }, [wall], 0);
    expect(res.expired).toBe(true);
    expect(res.end.x).toBeCloseTo(1, 9);
    expect(res.end.y).toBeCloseTo(0, 9);
    expect(res.hits).toHaveLength(0);
  });

  it('reflects many times without tunneling through a wall', () => {
    const wallRight: AABB = { minX: 5, minY: -10, maxX: 6, maxY: 10 };
    const wallLeft: AABB = { minX: -6, minY: -10, maxX: -5, maxY: 10 };
    const res = reflectSweep(
      { x: 0, y: 0 },
      { x: 53, y: 0 },
      [wallRight, wallLeft],
      10,
    );
    expect(res.hits).toHaveLength(5);
    expect(res.expired).toBe(false);
    // total path folds into the [-5,5] corridor; never escapes
    expect(res.end.x).toBeCloseTo(-3, 6);
    expect(res.end.y).toBeCloseTo(0, 9);
    for (const h of res.hits) {
      expect(Math.abs(h.point.x)).toBeLessThanOrEqual(5 + 1e-6);
      expect(Number.isNaN(h.point.x)).toBe(false);
    }
  });
});
