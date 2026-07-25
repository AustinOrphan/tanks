import type { Vec2, Wall, AABB } from '../types';
import { vsub, angleOf } from '../types';
import { raySegmentVsAABB } from '../collision';
import { AIM_EPS } from '../constants';

export function lineOfSight(from: Vec2, to: Vec2, walls: Wall[]): boolean {
  for (const w of walls) {
    if (w.destroyed) continue;
    if (raySegmentVsAABB(from, to, w.aabb) !== null) return false;
  }
  return true;
}

export function aimLead(muzzle: Vec2, target: Vec2, targetVel: Vec2, bulletSpeed: number): number {
  const rel = vsub(target, muzzle);
  // Solve |rel + targetVel*t| = bulletSpeed*t  ->  a t^2 + b t + c = 0
  const a = targetVel.x * targetVel.x + targetVel.y * targetVel.y - bulletSpeed * bulletSpeed;
  const b = 2 * (rel.x * targetVel.x + rel.y * targetVel.y);
  const c = rel.x * rel.x + rel.y * rel.y;

  let t = -1;
  if (Math.abs(a) < AIM_EPS) {
    if (Math.abs(b) > AIM_EPS) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b + sq) / (2 * a);
      const t2 = (-b - sq) / (2 * a);
      if (t1 > AIM_EPS && t2 > AIM_EPS) t = Math.min(t1, t2);
      else if (t1 > AIM_EPS) t = t1;
      else if (t2 > AIM_EPS) t = t2;
    }
  }

  if (t <= AIM_EPS) return angleOf(rel); // no positive intercept: direct aim
  const intercept = { x: target.x + targetVel.x * t, y: target.y + targetVel.y * t };
  return angleOf(vsub(intercept, muzzle));
}

export function mirrorAcrossAABB(point: Vec2, box: AABB): Vec2[] {
  return [
    { x: 2 * box.minX - point.x, y: point.y }, // face 0: left  (x = minX, normal -x)
    { x: 2 * box.maxX - point.x, y: point.y }, // face 1: right (x = maxX, normal +x)
    { x: point.x, y: 2 * box.minY - point.y }, // face 2: bottom (y = minY, normal -y)
    { x: point.x, y: 2 * box.maxY - point.y }, // face 3: top   (y = maxY, normal +y)
  ];
}

// LOS that ignores one wall (the reflecting wall, since the bounce point sits on its surface).
function losIgnoring(from: Vec2, to: Vec2, walls: Wall[], ignore: Wall): boolean {
  for (const w of walls) {
    if (w === ignore || w.destroyed) continue;
    if (raySegmentVsAABB(from, to, w.aabb) !== null) return false;
  }
  return true;
}

const FACE_NORMALS: Vec2[] = [
  { x: -1, y: 0 }, // 0 left
  { x: 1, y: 0 },  // 1 right
  { x: 0, y: -1 }, // 2 bottom
  { x: 0, y: 1 },  // 3 top
];

/**
 * Finds a single-bounce bank-shot path from muzzle to target off any reflector wall.
 *
 * Searches each wall's four faces in order and returns the firing angle of the first
 * valid path (muzzle → bounce → target, where bounce lands exactly on the wall's surface
 * and both line-of-sight legs are clear). This returns the FIRST valid path in wall/face
 * iteration order, not the optimal or shortest path — deterministic given input, but
 * callers must not assume optimality.
 *
 * @param maxBounces — Presently used ONLY as a precondition: must be >= 1 to proceed.
 *   The search is single-bounce-only; multi-bounce is not implemented. Task 21+ must
 *   not assume this parameter enables ricochet-shell multi-bounce budgets — it will
 *   silently find only single-bounce paths regardless of maxBounces value.
 *
 * @returns Firing angle (from muzzle toward bounce point), or null if no path exists.
 */
export function bankShot(muzzle: Vec2, target: Vec2, walls: Wall[], maxBounces: number): number | null {
  if (maxBounces < 1) return null;
  for (const w of walls) {
    if (w.destroyed) continue;
    const mirrors = mirrorAcrossAABB(target, w.aabb);
    for (let face = 0; face < FACE_NORMALS.length; face++) {
      const mirror = mirrors[face];
      const hit = raySegmentVsAABB(muzzle, mirror, w.aabb);
      if (!hit) continue;
      // The ray must enter through the intended reflecting face (normals are exact ±1/0).
      // raySegmentVsAABB guarantees exact normals: each component is ±1 or 0, never epsilon.
      // A bounce landing at a wall corner (within 1e-7) is modelled here as a single-face
      // reflection; reflectSweep retroreflects both axes there, but the difference is negligible.
      const n = FACE_NORMALS[face];
      if (hit.normal.x !== n.x || hit.normal.y !== n.y) continue;
      const bounce = hit.point;
      // Clear line to the wall, and clear line from the bounce point to the real target.
      if (!losIgnoring(muzzle, bounce, walls, w)) continue;
      if (!losIgnoring(bounce, target, walls, w)) continue;
      return angleOf(vsub(bounce, muzzle));
    }
  }
  return null;
}
