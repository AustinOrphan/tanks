import { angleDelta } from '../types';

export function accelSlew(
  current: number, vel: number, target: number, vMax: number, aMax: number,
): { angle: number; vel: number } {
  const err = angleDelta(current, target);
  const vStop = Math.sqrt(2 * aMax * Math.abs(err));
  const vDes = Math.sign(err) * Math.min(vMax, vStop);
  const nv = vel + Math.max(-aMax, Math.min(aMax, vDes - vel));
  // Arrival clamp. Without it the last tick lands PAST the target and the turret has to come
  // back, which reads as a wobble rather than a stop.
  //
  // The velocity it discards is bounded by vMax, NOT by aMax. An earlier version of this
  // comment claimed the latter, reasoning that vStop caps the speed at sqrt(2*aMax*err) so
  // the clamp could only fire below err = 2*aMax. That is wrong whenever the velocity has
  // NOT settled to vDes -- if the target jumps behind a turret already travelling fast, nv
  // is still most of the old speed while err is small and the opposite sign, so this fires
  // with a large velocity and zeroes it. Observed in the ai-tracking gallery moment: the
  // turret arrives on a target 1.11 degrees behind it while carrying 1.82 degrees/tick.
  //
  // Kept anyway, and the residual is measured rather than argued away: over 60 seeds x 2
  // arenas this path is most of what remains in the abrupt-change column, which still reads
  // 0.06% (brown) / 0.24% (grey) / 0.44% (teal) of ticks against 0.84% / 1.84% / 2.85% for
  // the bang-bang slew. Arriving is worth one bounded discontinuity; overshooting and
  // returning would be a visible wobble on every sweep instead of a rare one.
  if (Math.abs(nv) >= Math.abs(err)) return { angle: target, vel: 0 };
  return { angle: current + nv, vel: nv };
}
