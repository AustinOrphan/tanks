import { describe, it, expect } from 'vitest';
import { circleVsAABB, circleVsCircle, raySegmentVsAABB, reflectSweep, resolveWalls } from './collision';
import type { AABB, Wall } from './types';
import { vdist } from './types';
import { makeTank } from './arena';
import { TANK_RADIUS } from './constants';

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

describe('reflectSweep does not leak shells out of the arena', () => {
  // The `t > SWEEP_EPS` filter exists to stop the sweep re-hitting the wall it just
  // bounced off. It was applied to EVERY wall, so at the arena's inside corners -- where
  // two boundary AABBs meet -- the bounce point lies exactly on the ABUTTING wall's face,
  // that wall's entry comes back t=0, and it was discarded as if it were the wall just
  // left. The sweep then returned an endpoint inside a solid wall with expired=false, and
  // from inside an AABB every later entry is t=0 too, so the shell sailed out of the map
  // and was never retired -- permanently holding one of its owner's 5 shell slots.
  //
  // Two abutting boxes meeting at the origin, exactly like the shipped arena's corners.
  const left = { minX: -2, minY: 0, maxX: 0, maxY: 18 };
  const top = { minX: -2, minY: -2, maxX: 22, maxY: 0 };

  it('never returns an endpoint inside a solid wall', () => {
    // Starting ON the shared corner is the reachable case: the shell's leg passes exactly
    // through it, so `start` lands there after the first reflection.
    const r = reflectSweep({ x: 0, y: 0 }, { x: -0.25, y: -0.25 }, [left, top], 3);
    const inside = [left, top].some(
      (w) => r.end.x > w.minX && r.end.x < w.maxX && r.end.y > w.minY && r.end.y < w.maxY,
    );
    expect(inside, `end ${JSON.stringify(r.end)} is embedded in a wall`).toBe(false);
  });

  it('does not pass a shell through the far side of a solid boundary wall', () => {
    // Aimed straight at the corner from inside the playfield. Whatever it does -- bounce,
    // stop, expire -- it must not come out at x < -2 on the other side of a 2-unit wall.
    const r = reflectSweep({ x: 0, y: 0 }, { x: -0.5, y: -0.5 }, [left, top], 3);
    expect(r.end.x).toBeGreaterThanOrEqual(-2);
  });
});

describe('resolveWalls', () => {
  it('resolves a hull the same way however the wall is sliced', () => {
    const one: Wall[] = [
      { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 6, maxY: 2 } },
    ];
    const three: Wall[] = [0, 2, 4].map((x, i) => ({
      id: i + 1, kind: 'solid' as const, destroyed: false,
      aabb: { minX: x, minY: 0, maxX: x + 2, maxY: 2 },
    }));
    // A hull overlapping the seam at x=2 must land in the same place either way.
    for (const x of [1.9, 2.0, 2.1, 3.0]) {
      const a = { ...makeTank(1, 'player', { x, y: 2.3 }, 0) };
      const b = { ...makeTank(1, 'player', { x, y: 2.3 }, 0) };
      resolveWalls(a, one);
      resolveWalls(b, three);
      expect(b.pos.x, `x=${x}`).toBeCloseTo(a.pos.x, 9);
      expect(b.pos.y, `x=${x}`).toBeCloseTo(a.pos.y, 9);
    }
  });

  it('pushes a hull clear of a concave corner', () => {
    const walls: Wall[] = [
      { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 4, maxY: 2 } },
      { id: 2, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 2, maxX: 2, maxY: 6 } },
    ];
    const t = makeTank(1, 'player', { x: 2.3, y: 2.3 }, 0);
    resolveWalls(t, walls);
    for (const w of walls) expect(circleVsAABB(t.pos, TANK_RADIUS, w.aabb).hit, `wall ${w.id}`).toBe(false);
    // Bound WHERE it landed, not just that it cleared both boxes -- "cleared" alone is
    // satisfied by an inverted, 30x-scaled push that flings the hull far from the corner
    // just as readily as by the correct small displacement. The corner is at (2, 2); the
    // hull started 0.3 inside it on each axis and should resolve nearby, on the outward
    // (increasing x, increasing y) side.
    expect(t.pos.x).toBeCloseTo(2.5, 9);
    expect(t.pos.y).toBeCloseTo(2.5, 9);
  });

  it('does not escape or NaN in a gap narrower than the hull', () => {
    // Two walls 0.6 apart -- narrower than the 1.0 (2 * TANK_RADIUS) hull diameter, so no
    // displacement can clear both at once. Traced by hand: each iteration's deepest-push
    // pick alternates between the two walls (0.2 push right at x=2.3, then a full 0.4 push
    // left at x=2.5, then 0.4 right at x=2.1, ...), so the tank oscillates between x=2.1
    // and x=2.5 rather than converging. The iteration budget (SWEEP_MAX_ITERATIONS = 16,
    // even) exhausts instead of looping forever, landing on x=2.1 for THIS geometry -- the
    // exact resting value depends on the budget's parity, which is why this only pins
    // "stays finite and in the gap's neighbourhood", not the specific resting x.
    const walls: Wall[] = [
      { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 2, maxY: 2 } },
      { id: 2, kind: 'solid', destroyed: false, aabb: { minX: 2.6, minY: 0, maxX: 4.6, maxY: 2 } },
    ];
    const t = makeTank(1, 'player', { x: 2.3, y: 1 }, 0);
    resolveWalls(t, walls);
    expect(Number.isFinite(t.pos.x)).toBe(true);
    expect(Number.isFinite(t.pos.y)).toBe(true);
    // Stays in the neighbourhood of the gap -- not flung far outside either wall.
    expect(t.pos.x).toBeGreaterThan(-2);
    expect(t.pos.x).toBeLessThan(6.6);
    expect(t.pos.y).toBeGreaterThan(-2);
    expect(t.pos.y).toBeLessThan(4);
  });

  it('leaves the hull CENTRE outside the mass for every gap the shipped arenas can make', () => {
    // The bounds asserted above cannot tell "acceptably stuck, still overlapping" from
    // "resolved to a point inside a wall" -- every interior point satisfies them. That
    // second outcome is real, and it is NOT a property the code has unconditionally, so
    // asserting it on one fixture would only be sampling a coincidence. Measured over the
    // sweep below, it is a function of the gap:
    //
    //   gap  0.30 0.40 0.50 | 0.60 0.6667 0.70 0.80 0.90 1.00
    //   ends INSIDE INSIDE INSIDE | outside ...
    //
    // Population: those 9 gaps, tank started centred in each. The boundary sits between
    // 0.50 and 0.60, and every gap a shipped arena can produce is at or above cellSize
    // (0.6667) because walls are cell-aligned -- which is why the sub-0.6 half is
    // documented here rather than fixed. A change that pushed the boundary above 0.6667
    // would put a reachable gap on the wrong side of it, and this test is what catches it.
    const resolvedInsideAt = (gap: number): boolean => {
      const walls: Wall[] = [
        { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 2, maxY: 2 } },
        { id: 2, kind: 'solid', destroyed: false, aabb: { minX: 2 + gap, minY: 0, maxX: 4 + gap, maxY: 2 } },
      ];
      const t = makeTank(1, 'player', { x: 2 + gap / 2, y: 1 }, 0);
      resolveWalls(t, walls);
      return walls.some(
        (w) => t.pos.x >= w.aabb.minX && t.pos.x <= w.aabb.maxX
          && t.pos.y >= w.aabb.minY && t.pos.y <= w.aabb.maxY,
      );
    };
    for (const gap of [0.6, 2 / 3, 0.7, 0.8, 0.9, 1.0]) {
      expect(resolvedInsideAt(gap), `gap ${gap}`).toBe(false);
    }
    // Negative control: the sub-hull gaps really do end inside, so the loop above is
    // discriminating between two reachable outcomes rather than restating something
    // that holds everywhere.
    for (const gap of [0.3, 0.4, 0.5]) {
      expect(resolvedInsideAt(gap), `gap ${gap}`).toBe(true);
    }
  });

  it('breaks a tie on the push vector, not wall array order', () => {
    // Two walls placed diagonally, corners 0.25 apart from a tank centred exactly on
    // their bisector -- all coordinates are dyadic (integers and .25/.5 fractions), so
    // the two circleVsAABB pushes are bit-identical in magnitude and exactly opposite in
    // sign (verified: hA.push.x === -hB.push.x). That is a genuinely reachable tie, not a
    // contrived float coincidence -- an instrumented build hit an equivalent one on a
    // diagonal corner-touch pair. Reducing the selection to `depth > bestDepth` (dropping
    // the vector tiebreak) makes whichever wall is scanned first keep its push, so [A, B]
    // and [B, A] resolve to different positions; the current code must not.
    const A: Wall = { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 2, maxY: 2 } };
    const B: Wall = { id: 2, kind: 'solid', destroyed: false, aabb: { minX: 2.5, minY: 2.5, maxX: 4.5, maxY: 4.5 } };
    const ab = makeTank(1, 'player', { x: 2.25, y: 2.25 }, 0);
    const ba = makeTank(1, 'player', { x: 2.25, y: 2.25 }, 0);
    resolveWalls(ab, [A, B]);
    resolveWalls(ba, [B, A]);
    expect(ba.pos.x).toBe(ab.pos.x);
    expect(ba.pos.y).toBe(ab.pos.y);

    // ...and pin WHICH of the two tied pushes wins, not merely that both orders agree.
    // Order-independence alone is satisfied by either direction of the comparator, so
    // flipping `>` to `<` in the deepest-overlap tiebreak survived the entire suite --
    // 1315 tests, the golden trace byte-identical, all four arenas' decomposition sweeps
    // still at 0 divergences. The comparator keeps the LARGEST push vector, which here
    // is A's (pushing down-left, away from B), so the tank ends up below its start.
    expect(ab.pos.x).toBeLessThan(2.25);
    expect(ab.pos.y).toBeLessThan(2.25);
  });

  it('escapes a single-box mass exactly as circleVsAABB\'s inside branch would', () => {
    // One wall, no neighbours to march through -- the union-exit case degenerates to
    // circleVsAABB's old inside-branch push. Coordinates are asymmetric on every axis
    // (no ties) so the analytic answer is unambiguous: nearest face is the bottom
    // (toBottom = 0.3, beating toLeft = 3, toRight = 7, toTop = 1.7), so the tank is
    // pushed straight down by 0.3 + TANK_RADIUS, landing exactly on the box's bottom
    // face. Confirms Task 5b's new inside-case block leaves the single-box case
    // unchanged from what circleVsAABB itself would have computed.
    const wall: Wall = { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 10, maxY: 2 } };
    const t = makeTank(1, 'player', { x: 3, y: 0.3 }, 0);
    resolveWalls(t, [wall]);
    expect(t.pos.x).toBeCloseTo(3, 9);
    expect(t.pos.y).toBeCloseTo(-0.5, 9);
    expect(circleVsAABB(t.pos, TANK_RADIUS, wall.aabb).hit).toBe(false);
  });

  it('escapes a boundary-flush wall inward, never through the boundary ring', () => {
    // A cell flush against the LEFT boundary (its minX sits exactly on the boundary
    // wall's maxX) -- one cell deep in the boundary-normal direction, the SIMPLEST case
    // of this shape. This test proves only that case, not that every shipped arena's edge
    // geometry is safe: arena-02's rows 12-14 put a 3-cell-DEEP destructible run flush
    // against each side boundary, and that geometry DOES let the escape march cross the
    // boundary for some interior starts (measured: 544 of 20,000 swept points, deepest
    // safe/shallowest divergent start 0.6767 units in -- deeper than the 0.375-unit shove
    // `world.ts:98-101` documents, so judged unreachable but NOT proven safe by this test).
    // See task-5b-report.md's "Boundary-flush behaviour" section for the full numbers and
    // why a 1-cell-deep run (this fixture) and a 3-cell-deep run (arena-02) are genuinely
    // different cases, not the same claim at two scales.
    //
    // The risk this test DOES guard: the escape march finding the boundary CONTIGUOUS with
    // a 1-cell-deep wall and walking straight through it, landing the hull outside the play
    // area with nothing left to contain it.
    //
    // Deliberately NOT symmetric, and deliberately blocking up/down far away: the tie-
    // break (push VECTOR, smallest x then smallest y -- see resolveWalls's own doc
    // comment) always prefers a negative-x candidate over one with x=0, so a boundary
    // placed on the west side is the one orientation where a march bug that UNDER-counts
    // every axis (stops after one box instead of continuing through the mass) doesn't
    // just coincidentally get out-voted by that same tie-break -- it would make the
    // boundary the STRICT minimum instead. Right is left open (real distance 1.5, cheap);
    // up and down are each blocked by a 100-unit wall (real distance ~101), so they can
    // never legitimately compete; left leads into a 2-unit-thick boundary (real distance
    // 0.5 through the cell + 2.0 through the boundary = 2.5). The unique correct answer
    // is right, landing well inside the play area.
    //
    // If unionExitDistance stopped after a single box instead of marching through the
    // whole mass -- exactly the defect this task fixes for a multi-cell run -- every
    // distance here collapses to its first-hop value: right stays 1.5 (already single-
    // hop), but left wrongly drops to 0.5 and up/down wrongly drop to 1, making left the
    // STRICT minimum (0.5 < 1 < 1.5) and pushing the hull straight into the boundary's own
    // span (x < 0). Verified: reverting unionExitDistance's loop bound to `step <= 0`
    // makes this test fail (t.pos.x lands at -0.5, not >= 0) -- see task-5b-report.md.
    const cell: Wall = { id: 1, kind: 'destructible', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 2, maxY: 2 } };
    const boundaryThickness = 2, H = 8;
    const leftBoundary: Wall = { id: 2, kind: 'solid', destroyed: false, aabb: { minX: -boundaryThickness, minY: 0, maxX: 0, maxY: H } };
    const upBlocker: Wall = { id: 3, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: -102, maxX: 2, maxY: 0 } };
    const downBlocker: Wall = { id: 4, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 2, maxX: 2, maxY: 102 } };
    const t = makeTank(1, 'player', { x: 0.5, y: 1 }, 0);
    resolveWalls(t, [cell, leftBoundary, upBlocker, downBlocker]);
    // Escaped right, into the play area -- never entered the boundary ring's own span.
    expect(t.pos.x).toBeGreaterThanOrEqual(0);
    expect(t.pos.x).toBeCloseTo(2.5, 9);
    expect(t.pos.y).toBeCloseTo(1, 9);
  });

  it('the escape march does not treat a DESTROYED wall as part of the mass', () => {
    // Three walls in a row: wall1 [0,2], wall2 [2,4] DESTROYED (a mine-blasted gap), wall3
    // [4,6]. Tank centre at (1.9, 1), just inside wall1's right edge. Up/down/left are
    // blocked far away so right is the only competitive direction, isolating exactly the
    // mechanism under test: does the march stop at the destroyed gap (correct, real
    // distance 0.1 through the sliver of wall1 left of x=2) or keep going through wall2 as
    // though it were solid (wrong, would add wall2's and wall3's spans: 0.1 + 2 + 2 = 4.1)?
    const wall1: Wall = { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 2, maxY: 2 } };
    const wall2: Wall = { id: 2, kind: 'solid', destroyed: true, aabb: { minX: 2, minY: 0, maxX: 4, maxY: 2 } };
    const wall3: Wall = { id: 3, kind: 'solid', destroyed: false, aabb: { minX: 4, minY: 0, maxX: 6, maxY: 2 } };
    const blockerL: Wall = { id: 4, kind: 'solid', destroyed: false, aabb: { minX: -100, minY: 0, maxX: 0, maxY: 2 } };
    const blockerU: Wall = { id: 5, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: -100, maxX: 2, maxY: 0 } };
    const blockerD: Wall = { id: 6, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 2, maxX: 2, maxY: 102 } };
    const t = makeTank(1, 'player', { x: 1.9, y: 1 }, 0);
    resolveWalls(t, [wall1, wall2, wall3, blockerL, blockerU, blockerD]);
    // Correct: escapes right by 0.1 + TANK_RADIUS, landing at x=2.5. Verified this fails
    // under the mutation (dropping `!x.destroyed` from unionExitDistance's `find`), landing
    // at x=6.5 instead -- see task-5b-report.md.
    expect(t.pos.x).toBeCloseTo(2.5, 9);
    expect(t.pos.y).toBeCloseTo(1, 9);
  });

  it('escapes a symmetric box on the push-vector tie-break, matching the deepest-overlap pass', () => {
    // A perfectly centred hull inside a 2x2 box: all four axis distances tie at exactly 1.
    // resolveWalls's own doc comment claims ties break on the push VECTOR (smallest x, then
    // smallest y) "for the same reason the deepest-overlap pass does" -- and the deepest-
    // overlap pass has its own dedicated tie-break test above ("breaks a tie on the push
    // vector, not wall array order"). This is that test's equivalent for the escape-march
    // branch: with the vector tie-break, AXES processing order [right, left, down, up]
    // lands on LEFT (candidate x=-1.5 beats right's +1.5, and beats down/up's x=0), giving
    // a final position of (-0.5, 1).
    const wall: Wall = { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 2, maxY: 2 } };
    const t = makeTank(1, 'player', { x: 1, y: 1 }, 0);
    resolveWalls(t, [wall]);
    // Verified this fails under the mutation (reducing the tie-break to a bare `d <
    // escapeDist`, so the first-scanned direction keeps a tied result): the first-scanned
    // axis is RIGHT, so the mutant lands at (2.5, 1) instead -- see task-5b-report.md.
    expect(t.pos.x).toBeCloseTo(-0.5, 9);
    expect(t.pos.y).toBeCloseTo(1, 9);
  });

  it('a centre exactly on the seam between two adjacent walls is recognised as inside', () => {
    // containsPoint's bounds are inclusive (>=/<=). At the exact seam x=2 between wallA
    // [0,2] and wallB [2,4], inclusive bounds mean BOTH walls claim the point as contained,
    // so the outer "is the centre inside any wall" check fires and the union march runs
    // (escaping via the shorter y-axis here: down/up both cost 1, versus left/right's 2
    // each through a single wall -- tie-break picks up, landing at (2, -0.5)). A strict `>`/
    // `<` bound would have NEITHER wall claim the seam point, skipping the march entirely
    // and falling back to the old deepest-overlap `circleVsAABB` pass, which resolves the
    // same seam differently (landing at (2.5, -0.5) -- verified by mutation, see
    // task-5b-report.md). Dyadic coordinates are a real class of position this codebase
    // already treats as reachable, not a contrived float coincidence -- see "breaks a tie
    // on the push vector" above, which makes the identical argument for a diagonal corner.
    const wallA: Wall = { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 2, maxY: 2 } };
    const wallB: Wall = { id: 2, kind: 'solid', destroyed: false, aabb: { minX: 2, minY: 0, maxX: 4, maxY: 2 } };
    const t = makeTank(1, 'player', { x: 2, y: 1 }, 0);
    resolveWalls(t, [wallA, wallB]);
    expect(t.pos.x).toBeCloseTo(2, 9);
    expect(t.pos.y).toBeCloseTo(-0.5, 9);
  });

  it('does not apply a push for an overlap at or below SWEEP_EPS', () => {
    // A depth of 5e-8 is below SWEEP_EPS (1e-7) but the circle genuinely overlaps
    // (distSq < radius^2), so `hit.hit` is true and `best` is non-null -- this is the
    // one case that tells `bestDepth <= SWEEP_EPS` apart from a bare `best === null`
    // check. With the epsilon clause, the loop returns on iteration 1 without ever
    // calling vadd, so the position is untouched (exact object-level equality, not
    // merely close). Without it, that sub-epsilon push gets applied, moving the tank
    // measurably (to x=2.5 exactly, verified by hand).
    const wall: Wall = { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 2, maxY: 2 } };
    const startX = 2 + TANK_RADIUS - 5e-8;
    const t = makeTank(1, 'player', { x: startX, y: 1 }, 0);
    resolveWalls(t, [wall]);
    expect(t.pos.x).toBe(startX);
    expect(t.pos.y).toBe(1);
  });
});
