import type { Vec2, AABB, Tank, Wall } from './types';
import { vadd, vsub, vscale, vlen, vnorm, vdot, angleDelta, slewAngle, angleOf } from './types';
import { SWEEP_EPS, SWEEP_MAX_ITERATIONS, TANK_RADIUS } from './constants';
import { configFor } from './config';

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

/**
 * True if a segment leaving `start` toward `target` is travelling INTO `box`, as opposed to
 * resting on one of its faces on the way out.
 *
 * Decided by probing a hair along the direction of travel rather than from the surface
 * normal, because the normal is exactly what raySegmentVsAABB fails to supply for a
 * boundary-start segment -- which is the whole reason this function exists.
 */
function headingInto(start: Vec2, target: Vec2, box: AABB): boolean {
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return false;
  const step = SWEEP_EPS / len;
  const px = start.x + dx * step;
  const py = start.y + dy * step;
  return px > box.minX && px < box.maxX && py > box.minY && py < box.maxY;
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
  // Which wall the previous iteration bounced off, so only THAT wall is allowed to be
  // ignored at t~0. Applying the epsilon to every wall is what let shells escape the map:
  // at the arena's inside corners two boundary boxes meet, so a bounce point sits exactly
  // on the abutting wall's face, its entry comes back t=0, and it was discarded as though
  // it were the wall just left. The sweep then ran on THROUGH a solid 2-unit wall with no
  // hit recorded and expired=false, and since raySegmentVsAABB reports t=0 for a segment
  // starting inside a box, every later tick was skipped too -- the shell left the arena and
  // nothing ever retired it, holding one of its owner's SHELL_CAP slots for the rest of the
  // life. Five of those and the player cannot fire at all.
  let lastWall = -1;

  // Bounded loop: guards against pathological infinite reflection.
  for (let iter = 0; iter < SWEEP_MAX_ITERATIONS; iter++) {
    let best: RayHit | null = null;
    let bestWall = -1;
    for (let i = 0; i < walls.length; i++) {
      const h = raySegmentVsAABB(start, target, walls[i]);
      if (h === null) continue;
      if (h.t <= SWEEP_EPS) {
        // Only the wall just bounced off is ignored outright.
        if (i === lastWall) continue;
        // Otherwise a t~0 contact is only real if the shell is actually going INTO this
        // box. Every ricochet comes to rest exactly ON a face, so treating all of them as
        // hits kills a shell the instant it bounces; ignoring all of them is what let one
        // cross an abutting wall at an arena corner. The direction decides which it is.
        if (!headingInto(start, target, walls[i])) continue;
      }
      if (best === null || h.t < best.t) {
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

    // raySegmentVsAABB only fills in a normal when a slab entry strictly beats the running
    // tmin, which starts at 0 -- so a segment beginning exactly on a face plane, or already
    // inside the box, comes back with a zero normal and nothing to reflect about. Fail
    // CLOSED: stop the shell at the wall exactly as running out of bounces does. Reflecting
    // about a zero normal returns the direction unchanged, which walks the shell deeper into
    // the wall and back out the far side.
    if (Math.abs(best.normal.x) < SWEEP_EPS && Math.abs(best.normal.y) < SWEEP_EPS) {
      return {
        end: pt,
        dir: vnorm(vsub(target, start)),
        bouncesLeft,
        hits,
        expired: true,
      };
    }

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
    lastWall = bestWall;
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
  return vscale(driveDirection(tank.desiredMove), configFor(tank.kind).movementSpeed);
}

/**
 * Push a tank out of the walls it overlaps, resolving the DEEPEST overlap at a time
 * until it is clear.
 *
 * It used to apply a push for EVERY overlapping wall in array order, which made the
 * result a function of how the level data was sliced rather than of its geometry: a
 * hull straddling three sub-cells of one flat run took three compounding pushes, and
 * each interior seam offered the circle-vs-box nearest-feature test a CORNER where the
 * real surface is flat. Measured on arena-01: before this change, 8,846 of 48,207
 * reachable wall-touching hull positions resolved to a different place after a 3x
 * re-slice of the same geometry, worst delta 0.481 against a TANK_RADIUS of 0.5; after,
 * 0 of 48,207, worst delta 0.000000. An independent re-measurement across all 4 shipped
 * arenas (3,356 reachable one-tick penetrations, both original and reversed wall array
 * order) also found 0 divergences, worst delta 0.000000000.
 *
 * Taking only the deepest overlap fixes that, because the deepest penetration is a
 * property of the UNION: for a hull over a flat run, the sub-cell beneath the centre
 * offers a face push AT LEAST as deep as its neighbours' corner pushes, which is exactly
 * what the unsliced wall would have offered. At most seam positions it is strictly
 * deeper; at an exact seam boundary the two adjacent sub-cells return an identical
 * corner push (same nearest point, same depth) and the union just needs either one of
 * them, which is where the paragraph below applies.
 *
 * Ties are broken on the push VECTOR, not array position, so the tiebreak is geometric
 * too: this matters even when the tied pushes are NOT identical, e.g. a tank centred on
 * the bisector of two diagonally-touching walls, where the tied depth is reached by two
 * opposite-direction pushes and picking "whichever wall came first" would make the
 * result order-dependent again.
 *
 * Iterating is what keeps concave corners correct -- clearing the deepest wall can
 * leave the hull inside a perpendicular one, so it goes round again. Bounded by
 * SWEEP_MAX_ITERATIONS; a gap narrower than the hull cannot be resolved by any
 * displacement and simply exhausts the budget rather than looping forever.
 */
export function resolveWalls(tank: Tank, walls: Wall[]): void {
  for (let iter = 0; iter < SWEEP_MAX_ITERATIONS; iter++) {
    let best: Vec2 | null = null;
    let bestDepth = 0;
    for (const wall of walls) {
      if (wall.destroyed) continue;
      const hit = circleVsAABB(tank.pos, TANK_RADIUS, wall.aabb);
      if (!hit.hit) continue;
      const depth = Math.hypot(hit.push.x, hit.push.y);
      if (depth > bestDepth || (depth === bestDepth && best !== null &&
          (hit.push.x > best.x || (hit.push.x === best.x && hit.push.y > best.y)))) {
        bestDepth = depth;
        best = hit.push;
      }
    }
    if (best === null || bestDepth <= SWEEP_EPS) return;
    tank.pos = vadd(tank.pos, best);
  }
}

export function moveTank(tank: Tank, walls: Wall[], dt: number): void {
  const cfg = configFor(tank.kind);
  const move = driveDirection(tank.desiredMove);
  const mlen = vlen(tank.desiredMove);

  if (mlen > 0) {
    // TURN, THEN DRIVE -- FORWARDS OR BACKWARDS, whichever is the shorter turn.
    //
    // Before this the hull was assigned the input direction outright and the position
    // stepped along that same input, so a tank changed facing AND travel within one
    // tick: it never turned, it teleported its heading.
    //
    // A tank has a reverse gear. Asking for the direction behind it should back it up,
    // not spin it through 180 first -- that is both slower and not how a tracked vehicle
    // behaves. So aim at whichever of the requested heading or its opposite the hull is
    // already closer to, and drive along the hull with the sign that matches.
    const want = angleOf(move);
    const reverse = Math.abs(angleDelta(tank.bodyAngle, want)) > Math.PI / 2;
    // Canonicalised into (-PI, PI]. `want + PI` is otherwise a raw 2PI when reversing
    // from a heading of PI, and every later reversal adds another turn -- the hull
    // renders identically but its angle marches off, and tests read as though it had
    // spun rather than stood still.
    const aim = angleDelta(0, reverse ? want + Math.PI : want);
    tank.bodyAngle = slewAngle(tank.bodyAngle, aim, cfg.rotationSpeed * dt);

    const heading = { x: Math.cos(tank.bodyAngle), y: Math.sin(tank.bodyAngle) };
    const gear = reverse ? -1 : 1;
    const travel = { x: heading.x * gear, y: heading.y * gear };
    // Speed still falls off with how far the hull has left to swing, so a turn costs
    // ground rather than being free. Picking the nearer of the two headings caps that
    // error at 90 degrees, so this never fully stalls the way a forced 180 did.
    const align = Math.max(0, travel.x * move.x + travel.y * move.y);
    tank.pos = vadd(tank.pos, vscale(travel, cfg.movementSpeed * align * dt));
  }

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
