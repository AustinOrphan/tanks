import { describe, it, expect } from 'vitest';
import { accelSlew } from './turret-accel';

describe('accelSlew', () => {
  it('ramps in from rest: the first tick moves by the acceleration budget, not the speed cap', () => {
    // A bang-bang slew would move vMax (0.05) on tick one. An accelerating one moves aMax.
    const r = accelSlew(0, 0, 3.0, 0.05, 0.01);
    expect(r.vel).toBeCloseTo(0.01, 12);
    expect(r.angle).toBeCloseTo(0.01, 12);
  });

  it('decelerates on approach so it can stop ON the target, not past it', () => {
    // Travelling at the cap (0.05/tick) with only 0.06 of error left. The fastest speed it
    // could still shed in time is sqrt(2*aMax*err) = sqrt(2*0.01*0.06) = 0.0346, so this
    // tick must brake by the full acceleration budget: 0.05 -> 0.04. A ramp-in-only
    // implementation keeps going at 0.05 and sails past.
    const r = accelSlew(0, 0.05, 0.06, 0.05, 0.01);
    expect(r.vel).toBeCloseTo(0.04, 12);
  });

  it('arrives ON the target instead of sailing past it, and stops there', () => {
    // 0.002 of error left, moving at 0.005/tick. The unclamped result would land on
    // 0.00632 -- past the target -- and then have to come back, which is an oscillation
    // the eye reads as a wobble rather than a stop.
    const r = accelSlew(0, 0.005, 0.002, 0.05, 0.01);
    expect(r.angle).toBe(0.002);
    expect(r.vel).toBe(0);
  });

  it('holds still when it is already on target: no residual creep', () => {
    const r = accelSlew(1.25, 0, 1.25, 0.05, 0.01);
    expect(r.angle).toBe(1.25);
    expect(r.vel).toBe(0);
  });

  it('reverses through zero rather than flipping direction in one tick', () => {
    // THE smoothness property. Travelling +0.05/tick when the target jumps behind it: the
    // velocity must walk down by the acceleration budget (0.05 -> 0.04), not snap to -0.05.
    // A bang-bang slew reverses instantly, which is the artefact this whole change exists
    // to remove.
    const r = accelSlew(0, 0.05, -1.0, 0.05, 0.01);
    expect(r.vel).toBeCloseTo(0.04, 12);
    expect(r.vel).toBeGreaterThan(0); // still moving the OLD way, just slower
  });

  it('reaches the speed cap on a long sweep and never exceeds it', () => {
    // Angles are periodic, so the furthest a target can ever be is pi -- there is no
    // "100 radians away" to accelerate across. Half a turn is the longest real sweep.
    const TARGET = Math.PI - 0.001;
    let vel = 0, angle = 0, peak = 0;
    for (let i = 0; i < 200; i++) {
      const r = accelSlew(angle, vel, TARGET, 0.05, 0.01);
      angle = r.angle; vel = r.vel;
      peak = Math.max(peak, Math.abs(vel));
      expect(Math.abs(vel)).toBeLessThanOrEqual(0.05 + 1e-12);
    }
    expect(peak).toBeCloseTo(0.05, 12);  // it does reach the cap mid-sweep
    expect(vel).toBe(0);                 // and has stopped by the end
    expect(angle).toBeCloseTo(TARGET, 12);
  });

  it('takes the short way round the +/-pi seam', () => {
    // Just under +pi, target just over -pi: 0.02 apart the short way, 6.26 the long way.
    // A raw subtraction would send the turret most of a full turn the wrong direction.
    const r = accelSlew(Math.PI - 0.01, 0, -Math.PI + 0.01, 0.05, 0.01);
    expect(r.vel).toBeGreaterThan(0); // positive = onward through +pi, the short way
  });
});
