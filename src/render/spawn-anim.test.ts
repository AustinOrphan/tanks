import { describe, it, expect } from 'vitest';
import { SPAWN_ANIMATORS, ENTRANCE_SECONDS } from './spawn-anim';

const warp = SPAWN_ANIMATORS.warp;
const C = 0x3fd0ff;

describe('warp animator', () => {
  it('entrance: fades and scales the tank in, ring expands', () => {
    const a = warp('entrance', 0, C);
    const b = warp('entrance', 1, C);
    // Mutation that breaks this: an animator that returns a constant frame.
    expect(a.tankOpacity).toBeLessThan(b.tankOpacity);
    expect(a.tankScale).toBeLessThan(b.tankScale);
    expect(a.ring.radius).toBeLessThan(b.ring.radius);
    expect(b.tankOpacity).toBeCloseTo(1, 5); // fully solid by end of entrance
    expect(b.tankScale).toBeCloseTo(1, 5);
  });
  it('invincible: tank is translucent at the start and solidifies to opaque', () => {
    // progress here is 0=just shielded, 1=shield about to end.
    const start = warp('invincible', 0, C);
    const end = warp('invincible', 1, C);
    // Mutation that breaks this: dropping the invincibility branch (returns entrance frame).
    expect(start.tankOpacity).toBeLessThan(1);
    expect(end.tankOpacity).toBeCloseTo(1, 5);
    expect(start.tankOpacity).toBeLessThan(end.tankOpacity);
  });
  it('clamps progress outside [0,1] (negative control: no NaN, no >1 opacity)', () => {
    for (const p of [-1, 2]) {
      const f = warp('entrance', p, C);
      expect(f.tankOpacity).toBeGreaterThanOrEqual(0);
      expect(f.tankOpacity).toBeLessThanOrEqual(1);
    }
  });
  it('ENTRANCE_SECONDS is a positive, finite duration', () => {
    expect(ENTRANCE_SECONDS).toBeGreaterThan(0);
    expect(Number.isFinite(ENTRANCE_SECONDS)).toBe(true);
  });
});
