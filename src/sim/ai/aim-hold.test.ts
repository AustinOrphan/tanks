import { describe, it, expect } from 'vitest';
import { holdAim } from './aim-hold';

describe('holdAim', () => {
  it('with nothing held, adopts the fresh solution and arms the span', () => {
    const r = holdAim(null, 0, 12, 0.14, 1.5);
    expect(r.angle).toBe(1.5);
    expect(r.nextHeld).toBe(1.5);
    expect(r.nextHeldTicks).toBe(12);
  });

  it('keeps the held angle and counts down while the span is live and the fresh solution is close', () => {
    // held 1.5, fresh 1.55 -- 0.05 rad apart, inside the 0.14 break threshold.
    const r = holdAim(1.5, 12, 12, 0.14, 1.55);
    expect(r.angle).toBe(1.5);
    expect(r.nextHeld).toBe(1.5);
    expect(r.nextHeldTicks).toBe(11);
  });

  it('breaks the hold immediately when the fresh solution is beyond the threshold', () => {
    // 1.5 -> 1.9 is 0.4 rad, well outside 0.14: a genuinely new target is acquired now,
    // not after the span runs out.
    const r = holdAim(1.5, 12, 12, 0.14, 1.9);
    expect(r.angle).toBe(1.9);
    expect(r.nextHeld).toBe(1.9);
    expect(r.nextHeldTicks).toBe(12);
  });

  it('re-solves when the span has run out, even if the fresh solution is close', () => {
    const r = holdAim(1.5, 0, 12, 0.14, 1.55);
    expect(r.angle).toBe(1.55);
    expect(r.nextHeldTicks).toBe(12);
  });

  it('measures the break across the shortest arc, so a hold survives the +/-pi seam', () => {
    // held just under +pi, fresh just over -pi: 0.06 rad apart the short way round,
    // 6.22 the long way. A raw subtraction would read this as a break and re-solve.
    const held = Math.PI - 0.03;
    const solution = -Math.PI + 0.03;
    const r = holdAim(held, 12, 12, 0.14, solution);
    expect(r.angle).toBe(held);
    expect(r.nextHeldTicks).toBe(11);
  });

  it('a span of zero never holds, so the aim re-solves every tick', () => {
    const r = holdAim(1.5, 0, 0, 0.14, 1.55);
    expect(r.angle).toBe(1.55);
    expect(r.nextHeldTicks).toBe(0);
  });
});
