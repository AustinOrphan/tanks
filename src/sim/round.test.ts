import { describe, it, expect } from 'vitest';
import { roundPhase } from './round';
import { createWorld } from './world';
import { COUNTDOWN_TICKS, GRACE_TICKS } from './constants';

// Minimal empty world; only `tick` and `roundStartTick` matter for roundPhase().
function worldAt(tick: number, roundStartTick = 0) {
  const w = createWorld({ walls: [], tanks: [], spawns: [], lives: 3 });
  w.tick = tick;
  w.roundStartTick = roundStartTick;
  return w;
}

describe('roundPhase', () => {
  it('tick 0 (elapsed 0) is countdown', () => {
    expect(roundPhase(worldAt(0))).toBe('countdown');
  });

  it('the last countdown tick (elapsed COUNTDOWN_TICKS - 1) is still countdown', () => {
    expect(roundPhase(worldAt(COUNTDOWN_TICKS - 1))).toBe('countdown');
  });

  it('the first grace tick (elapsed COUNTDOWN_TICKS) is grace', () => {
    expect(roundPhase(worldAt(COUNTDOWN_TICKS))).toBe('grace');
  });

  it('the last grace tick (elapsed COUNTDOWN_TICKS + GRACE_TICKS - 1) is still grace', () => {
    expect(roundPhase(worldAt(COUNTDOWN_TICKS + GRACE_TICKS - 1))).toBe('grace');
  });

  it('the first live tick (elapsed COUNTDOWN_TICKS + GRACE_TICKS) is live', () => {
    expect(roundPhase(worldAt(COUNTDOWN_TICKS + GRACE_TICKS))).toBe('live');
  });

  it('stays live arbitrarily far past the grace phase', () => {
    expect(roundPhase(worldAt(COUNTDOWN_TICKS + GRACE_TICKS + 100000))).toBe('live');
  });

  it('is relative to roundStartTick, not absolute world.tick (respawn case)', () => {
    // A large world.tick with a roundStartTick set to (tick - 1) means only 1 tick has
    // elapsed since the round began -- still countdown, no matter how large tick itself is.
    const w = worldAt(500000, 500000 - 1);
    expect(roundPhase(w)).toBe('countdown');
  });

  it('boundary math is symmetric around a nonzero roundStartTick', () => {
    const start = 123456;
    expect(roundPhase(worldAt(start + COUNTDOWN_TICKS - 1, start))).toBe('countdown');
    expect(roundPhase(worldAt(start + COUNTDOWN_TICKS, start))).toBe('grace');
    expect(roundPhase(worldAt(start + COUNTDOWN_TICKS + GRACE_TICKS - 1, start))).toBe('grace');
    expect(roundPhase(worldAt(start + COUNTDOWN_TICKS + GRACE_TICKS, start))).toBe('live');
  });
});
