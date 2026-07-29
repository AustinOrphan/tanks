import { describe, it, expect } from 'vitest';
import { roundPhase, roundPhaseTicksLeft } from './round';
import { createWorld, type World } from './world';
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

describe('roundPhaseTicksLeft', () => {
  const at = (elapsed: number): World => ({ tick: elapsed, roundStartTick: 0 }) as World;

  it('counts down through countdown, then RESTARTS for grace', () => {
    // Phase-relative on purpose: the number restarts at the boundary so the two
    // phases read as two things (3,2,1 then 2,1) rather than one 5s wait.
    expect(roundPhaseTicksLeft(at(0))).toBe(COUNTDOWN_TICKS);
    expect(roundPhaseTicksLeft(at(COUNTDOWN_TICKS - 1))).toBe(1);
    expect(roundPhaseTicksLeft(at(COUNTDOWN_TICKS))).toBe(GRACE_TICKS);
    expect(roundPhaseTicksLeft(at(COUNTDOWN_TICKS + GRACE_TICKS - 1))).toBe(1);
  });

  it('is 0 once live, so the HUD has nothing to show', () => {
    expect(roundPhaseTicksLeft(at(COUNTDOWN_TICKS + GRACE_TICKS))).toBe(0);
    expect(roundPhaseTicksLeft(at(COUNTDOWN_TICKS + GRACE_TICKS + 500))).toBe(0);
  });

  it('agrees with roundPhase at every boundary', () => {
    // Population: the 6 ticks either side of the two boundaries.
    for (const e of [COUNTDOWN_TICKS - 1, COUNTDOWN_TICKS, COUNTDOWN_TICKS + GRACE_TICKS - 1, COUNTDOWN_TICKS + GRACE_TICKS]) {
      const live = roundPhase(at(e)) === 'live';
      expect(roundPhaseTicksLeft(at(e)) === 0).toBe(live);
    }
  });

  it('tracks roundStartTick, so a respawn restarts the count', () => {
    // resetArena sets roundStartTick = tick + 1 on every respawn, not just at
    // game start, so this must be relative and not absolute.
    const respawned = { tick: 5000, roundStartTick: 5000 } as World;
    expect(roundPhaseTicksLeft(respawned)).toBe(COUNTDOWN_TICKS);
  });
});
