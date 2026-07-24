import type { Vec2, AABB } from './types';

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
  if (distSq >= radius * radius) return { hit: false, push: { x: 0, y: 0 } };
  const dist = Math.sqrt(distSq);
  const depth = radius - dist;
  return { hit: true, push: { x: (dx / dist) * depth, y: (dy / dist) * depth } };
}

export function circleVsCircle(a: Vec2, ra: number, b: Vec2, rb: number): Hit {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const r = ra + rb;
  const distSq = dx * dx + dy * dy;
  if (distSq >= r * r) return { hit: false, push: { x: 0, y: 0 } };
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
