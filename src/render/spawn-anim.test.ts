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

const rise = SPAWN_ANIMATORS.rise;

describe('rise animator', () => {
  it('entrance: scales up from near-zero (distinct from warp, which starts at 0.6)', () => {
    const a = rise('entrance', 0, 0x3fd0ff);
    const b = rise('entrance', 1, 0x3fd0ff);
    // Mutation that breaks this: rise === warp (its start scale would be 0.6, not < 0.2).
    expect(a.tankScale).toBeLessThan(0.2);
    expect(b.tankScale).toBeCloseTo(1, 5);
    expect(a.tankScale).toBeLessThan(b.tankScale);
  });
  it('invincible: ring opacity oscillates (pulse), unlike warp\'s monotone fade', () => {
    const samples = [0, 0.25, 0.5, 0.75, 1].map((p) => rise('invincible', p, 0x3fd0ff).ring.opacity);
    // A pulse is non-monotone: at least one sample rises after falling (or vice versa).
    // Mutation that breaks this: a monotone ring opacity (rise aliased to warp).
    const monotone = samples.every((v, i) => i === 0 || v <= samples[i - 1])
      || samples.every((v, i) => i === 0 || v >= samples[i - 1]);
    expect(monotone).toBe(false);
  });
});

const beacon = SPAWN_ANIMATORS.beacon;

describe('beacon animator', () => {
  it('invincible: tank stays opaque; ring ARC depletes from full to empty', () => {
    const start = beacon('invincible', 0, 0x3fd0ff);
    const end = beacon('invincible', 1, 0x3fd0ff);
    // Mutations that break this: beacon aliased to warp (start opacity would be 0.45,
    // and arc would be constant 1 the whole time).
    expect(start.tankOpacity).toBeCloseTo(1, 5);
    expect(end.tankOpacity).toBeCloseTo(1, 5);
    expect(start.ring.arc).toBeCloseTo(1, 5);
    expect(end.ring.arc).toBeCloseTo(0, 5);
    expect(end.ring.arc).toBeLessThan(start.ring.arc);
  });
});

// Anti-rot guard: until the picker UI and the `--spawn-anim` gallery arg (issue #201)
// land, this is the only thing that exercises rise/beacon by id through the registry
// rather than through the module-level const above. Fails if a variant is ever aliased
// to a dead/constant frame.
it.each(['warp', 'rise', 'beacon'] as const)('%s is a live animator, not a constant', (id) => {
  const a = SPAWN_ANIMATORS[id]('entrance', 0, 0);
  const b = SPAWN_ANIMATORS[id]('entrance', 1, 0);
  expect(a).not.toEqual(b);
});
