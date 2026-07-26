import type { Vec2, AABB, Tank, Wall } from './types';
import { vadd, vsub, vscale, vlen, vnorm, vdot, angleOf } from './types';
import { SWEEP_EPS, SWEEP_MAX_ITERATIONS, TANK_RADIUS, TANK_SPEED } from './constants';

export interface Hit {
  hit: boolean;
  push: Vec2;
}

export function circleVsAABB(center: Vec2, radius: number, box: AABB): Hit {
  const inside =
    center.x >= box.minX &&
    center.x <= box.maxX &&
    center.y >= box.minY &&
    center.y <= box.maxY;

  if (inside) {
    // center is inside the box: push out through the nearest face
    const toLeft = center.x - box.minX;
    const toRight = box.maxX - center.x;
    const toBottom = center.y - box.minY;
    const toTop = box.maxY - center.y;
    const minPen = Math.min(toLeft, toRight, toBottom, toTop);
    if (minPen === toLeft) return { hit: true, push: { x: -(toLeft + radius), y: 0 } };
    if (minPen === toRight) return { hit: true, push: { x: toRight + radius, y: 0 } };
    if (minPen === toBottom) return { hit: true, push: { x: 0, y: -(toBottom + radius) } };
    return { hit: true, push: { x: 0, y: toTop + radius } };
  }

  // center outside: separate from the closest point on the box
  const cx = Math.max(box.minX, Math.min(center.x, box.maxX));
  const cy = Math.max(box.minY, Math.min(center.y, box.maxY));
  const dx = center.x - cx;
  const dy = center.y - cy;
  const distSq = dx * dx + dy * dy;
  // Negated rather than `>=`: every comparison against NaN is false, so a `>=`
  // guard falls THROUGH to the hit branch and reports a NaN circle as touching
  // every box in the world. Failing closed keeps a poisoned entity inert.
  if (!(distSq < radius * radius)) return { hit: false, push: { x: 0, y: 0 } };
  const dist = Math.sqrt(distSq);
  const depth = radius - dist;
  return { hit: true, push: { x: (dx / dist) * depth, y: (dy / dist) * depth } };
}

export function circleVsCircle(a: Vec2, ra: number, b: Vec2, rb: number): Hit {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const r = ra + rb;
  const distSq = dx * dx + dy * dy;
  // See circleVsAABB: `>=` fails OPEN on NaN and would make a NaN bullet kill
  // every tank in the arena, one per tick, at any distance.
  if (!(distSq < r * r)) return { hit: false, push: { x: 0, y: 0 } };
  const dist = Math.sqrt(distSq);
  if (dist === 0) {
    // concentric: pick a deterministic default axis
    return { hit: true, push: { x: r, y: 0 } };
  }
  const overlap = r - dist;
  return { hit: true, push: { x: (dx / dist) * overlap, y: (dy / dist) * overlap } };
}

export interface RayHit {
  t: number;
  point: Vec2;
  normal: Vec2;
}

export function raySegmentVsAABB(from: Vec2, to: Vec2, box: AABB): RayHit | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let tmin = 0;
  let tmax = 1;
  let normal: Vec2 = { x: 0, y: 0 };

  // X slab
  if (dx === 0) {
    if (from.x < box.minX || from.x > box.maxX) return null;
  } else {
    const inv = 1 / dx;
    let t1 = (box.minX - from.x) * inv;
    let t2 = (box.maxX - from.x) * inv;
    let nx = -1; // entering through minX face (moving +x)
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      nx = 1; // entering through maxX face (moving -x)
    }
    if (t1 > tmin) {
      tmin = t1;
      normal = { x: nx, y: 0 };
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }

  // Y slab
  if (dy === 0) {
    if (from.y < box.minY || from.y > box.maxY) return null;
  } else {
    const inv = 1 / dy;
    let t1 = (box.minY - from.y) * inv;
    let t2 = (box.maxY - from.y) * inv;
    let ny = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      ny = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      normal = { x: 0, y: ny };
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }

  return {
    t: tmin,
    point: { x: from.x + dx * tmin, y: from.y + dy * tmin },
    normal,
  };
}

export interface SweepHit {
  point: Vec2;
  normal: Vec2;
  wallIndex: number;
}

export interface SweepResult {
  end: Vec2;
  dir: Vec2;
  bouncesLeft: number;
  hits: SweepHit[];
  expired: boolean;
}

function reflectVec(v: Vec2, n: Vec2): Vec2 {
  const d = vdot(v, n);
  return { x: v.x - 2 * d * n.x, y: v.y - 2 * d * n.y };
}

export function reflectSweep(
  from: Vec2,
  to: Vec2,
  walls: AABB[],
  bounces: number,
): SweepResult {
  let start: Vec2 = { x: from.x, y: from.y };
  let target: Vec2 = { x: to.x, y: to.y };
  let bouncesLeft = bounces;
  const hits: SweepHit[] = [];

  // Bounded loop: guards against pathological infinite reflection.
  for (let iter = 0; iter < SWEEP_MAX_ITERATIONS; iter++) {
    let best: RayHit | null = null;
    let bestWall = -1;
    for (let i = 0; i < walls.length; i++) {
      const h = raySegmentVsAABB(start, target, walls[i]);
      // Skip t<=EPS so we don't immediately re-hit the wall we just left.
      if (h !== null && h.t > SWEEP_EPS && (best === null || h.t < best.t)) {
        best = h;
        bestWall = i;
      }
    }

    if (best === null) {
      return {
        end: target,
        dir: vnorm(vsub(target, start)),
        bouncesLeft,
        hits,
        expired: false,
      };
    }

    const box = walls[bestWall];
    const pt = best.point;

    if (bouncesLeft <= 0) {
      // Out of bounces: stop dead at the wall; caller kills the bullet.
      return {
        end: pt,
        dir: vnorm(vsub(target, start)),
        bouncesLeft,
        hits,
        expired: true,
      };
    }

    const onX =
      Math.abs(pt.x - box.minX) < SWEEP_EPS || Math.abs(pt.x - box.maxX) < SWEEP_EPS;
    const onY =
      Math.abs(pt.y - box.minY) < SWEEP_EPS || Math.abs(pt.y - box.maxY) < SWEEP_EPS;
    const corner = onX && onY;

    const remaining = vsub(target, pt);
    let reflected: Vec2;

    if (corner) {
      // Exact corner: reflect both axes -> retroreflection, two hit records.
      const nx = Math.abs(pt.x - box.minX) < SWEEP_EPS ? -1 : 1;
      const ny = Math.abs(pt.y - box.minY) < SWEEP_EPS ? -1 : 1;
      hits.push({ point: pt, normal: { x: nx, y: 0 }, wallIndex: bestWall });
      hits.push({ point: pt, normal: { x: 0, y: ny }, wallIndex: bestWall });
      reflected = { x: -remaining.x, y: -remaining.y };
    } else {
      hits.push({ point: pt, normal: best.normal, wallIndex: bestWall });
      reflected = reflectVec(remaining, best.normal);
    }

    bouncesLeft -= 1;
    start = pt;
    target = vadd(pt, reflected);
  }

  return {
    end: target,
    dir: vnorm(vsub(target, start)),
    bouncesLeft,
    hits,
    expired: false,
  };
}

/** Clamp a raw drive-input vector to unit length (diagonals aren't faster). */
export function driveDirection(move: Vec2): Vec2 {
  const mlen = vlen(move);
  return mlen > 1 ? vscale(move, 1 / mlen) : move;
}

/** A tank's actual world velocity in units/sec — exactly what moveTank will apply.
 *  Shared by movement and AI aiming so the two definitions cannot drift. */
export function driveVelocity(tank: Tank): Vec2 {
  return vscale(driveDirection(tank.desiredMove), TANK_SPEED);
}

/** Push a tank out of every non-destroyed wall it overlaps. */
export function resolveWalls(tank: Tank, walls: Wall[]): void {
  for (const wall of walls) {
    if (wall.destroyed) continue;
    const hit = circleVsAABB(tank.pos, TANK_RADIUS, wall.aabb);
    if (hit.hit) tank.pos = vadd(tank.pos, hit.push);
  }
}

export function moveTank(tank: Tank, walls: Wall[], dt: number): void {
  const move = driveDirection(tank.desiredMove);
  const mlen = vlen(tank.desiredMove);

  tank.pos = vadd(tank.pos, vscale(move, TANK_SPEED * dt));
  if (mlen > 0) tank.bodyAngle = angleOf(move);

  resolveWalls(tank, walls); // slide along whatever it ran into
}

export function separateTanks(tanks: Tank[]): void {
  for (let i = 0; i < tanks.length; i++) {
    for (let j = i + 1; j < tanks.length; j++) {
      const a = tanks[i];
      const b = tanks[j];
      if (!a.alive || !b.alive) continue;
      const hit = circleVsCircle(a.pos, TANK_RADIUS, b.pos, TANK_RADIUS);
      if (hit.hit) {
        // push apart symmetrically (push separates a from b)
        a.pos = vadd(a.pos, vscale(hit.push, 0.5));
        b.pos = vsub(b.pos, vscale(hit.push, 0.5));
      }
    }
  }
}
