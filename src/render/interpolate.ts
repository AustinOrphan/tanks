import type { Vec2 } from '../sim/types';

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Shortest-arc angular interpolation. Wraps the raw a->b delta into
// (-pi, pi] BEFORE scaling by t, so the interpolation always travels the
// short way around the circle rather than sweeping the long way through 0.
//
// Contract (see src/render/interpolate.test.ts for the pinned cases):
//  - t=0 returns exactly `a` (delta*0 === 0).
//  - t=1 returns `a + delta`, which is congruent to `b` mod 2*pi but is
//    NOT renormalized -- it can land outside (-pi, pi] when `a` itself is
//    near the wrap boundary. This is fine for the render consumer
//    (Three.js's object.rotation.y accepts unbounded radians).
//  - The antipodal case (exactly pi apart) is a genuine tie between the two
//    equal-length arcs; this implementation resolves it toward the
//    positive/CCW arc because the wrap correction only fires on strict
//    inequality (`> pi` / `< -pi`), leaving delta === pi unchanged.
export function lerpAngle(a: number, b: number, t: number): number {
  const TWO_PI = Math.PI * 2;
  let delta = (b - a) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return a + delta * t;
}

export function lerpVec2(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}
