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
