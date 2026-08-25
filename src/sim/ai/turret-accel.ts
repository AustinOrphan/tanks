import { angleDelta } from '../types';

export function accelSlew(
  current: number, vel: number, target: number, vMax: number, aMax: number,
): { angle: number; vel: number } {
  const err = angleDelta(current, target);
  const vStop = Math.sqrt(2 * aMax * Math.abs(err));
  const vDes = Math.sign(err) * Math.min(vMax, vStop);
  const nv = vel + Math.max(-aMax, Math.min(aMax, vDes - vel));
  // Arrival clamp. Without it the last tick lands PAST the target and the turret has to
  // come back, which reads as a wobble rather than a stop. This can only fire when the
  // remaining error is at most 2*aMax -- vStop caps the speed at sqrt(2*aMax*err), and
  // sqrt(2*aMax*err) >= err only when err <= 2*aMax -- so the velocity discarded here is
  // bounded by 2*aMax and cannot itself become a visible jump.
  if (Math.abs(nv) >= Math.abs(err)) return { angle: target, vel: 0 };
  return { angle: current + nv, vel: nv };
}
