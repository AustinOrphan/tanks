import { angleDelta } from '../types';

export function accelSlew(
  current: number, vel: number, target: number, vMax: number, aMax: number,
): { angle: number; vel: number } {
  const err = angleDelta(current, target);
  const vStop = Math.sqrt(2 * aMax * Math.abs(err));
  const vDes = Math.sign(err) * Math.min(vMax, vStop);
  const nv = vel + Math.max(-aMax, Math.min(aMax, vDes - vel));
  // Arrival clamp. Without it the last tick lands past the target and the turret has to come
  // back, which reads as a wobble rather than a stop.
  //
  // The velocity it discards is bounded by vMax, not by aMax (turret-accel.test.ts pins
  // this): if the target jumps behind a turret already travelling fast, nv is still most of
  // the old speed while err is small and the opposite sign, so this fires and zeroes a large
  // velocity. Kept anyway: over 60 seeds x 2 arenas abrupt changes stay at 0.06% (brown) /
  // 0.24% (grey) / 0.44% (teal) of ticks against 0.84% / 1.84% / 2.85% for the bang-bang
  // slew. One bounded discontinuity is better than a wobble on every sweep.
  if (Math.abs(nv) >= Math.abs(err)) return { angle: target, vel: 0 };
  return { angle: current + nv, vel: nv };
}
