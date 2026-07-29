import { describe, it, expect } from 'vitest';
import { roundPhase, roundPhaseTicksLeft, phaseAt, ticksLeftAt } from './round';
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

  it('goes straight from countdown to live, because GRACE_TICKS is 0', () => {
    // The grace phase is switched off. This asserts what the SHIPPED constants do; the
    // boundary maths that would produce a grace phase is pinned separately below, so
    // turning GRACE_TICKS back on is a one-number change with tests already behind it.
    expect(GRACE_TICKS).toBe(0);
    expect(roundPhase(worldAt(COUNTDOWN_TICKS))).toBe('live');
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
    expect(roundPhase(worldAt(start + COUNTDOWN_TICKS + GRACE_TICKS, start))).toBe('live');
  });
});

describe('roundPhaseTicksLeft', () => {
  const at = (elapsed: number): World => ({ tick: elapsed, roundStartTick: 0 }) as World;

  it('counts the countdown down to 1, then reaches 0 as it goes live', () => {
    // GRACE_TICKS is 0, so there is no second leg to restart for: the count runs out
    // and the round is live. The restart behaviour still exists in the formula and is
    // pinned at a positive grace span in ticksLeftAt below.
    expect(GRACE_TICKS).toBe(0);
    expect(roundPhaseTicksLeft(at(0))).toBe(COUNTDOWN_TICKS);
    expect(roundPhaseTicksLeft(at(COUNTDOWN_TICKS - 1))).toBe(1);
    expect(roundPhaseTicksLeft(at(COUNTDOWN_TICKS))).toBe(0);
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

describe('phaseAt: the boundary maths, independent of the shipped spans', () => {
  // GRACE_TICKS is 0, so roundPhase can no longer produce a 'grace' at all. These pin
  // the formula at a POSITIVE grace span, which is the configuration the constant can be
  // restored to -- otherwise switching it back on would land on untested code.
  const C = 180;
  const G = 120;

  it('walks countdown -> grace -> live at the exact boundaries', () => {
    expect(phaseAt(0, C, G)).toBe('countdown');
    expect(phaseAt(C - 1, C, G)).toBe('countdown');
    expect(phaseAt(C, C, G)).toBe('grace'); // first grace tick
    expect(phaseAt(C + G - 1, C, G)).toBe('grace'); // last grace tick
    expect(phaseAt(C + G, C, G)).toBe('live'); // first live tick
    expect(phaseAt(C + G + 100000, C, G)).toBe('live');
  });

  it('skips grace entirely when its span is zero', () => {
    // The shipped configuration. The tick that would have opened grace is live instead.
    expect(phaseAt(C - 1, C, 0)).toBe('countdown');
    expect(phaseAt(C, C, 0)).toBe('live');
  });

  it('ticksLeftAt RESTARTS the count at the grace boundary', () => {
    // The behaviour the HUD banner was built around: 3,2,1 through countdown, then
    // 2,1 through grace, so the two phases read as two things rather than one long
    // wait. Unreachable while GRACE_TICKS is 0, and pinned here so switching it back
    // on does not land on untested code.
    expect(ticksLeftAt(0, C, G)).toBe(C);
    expect(ticksLeftAt(C - 1, C, G)).toBe(1);
    expect(ticksLeftAt(C, C, G)).toBe(G); // restarts, rather than continuing to count
    expect(ticksLeftAt(C + G - 1, C, G)).toBe(1);
    expect(ticksLeftAt(C + G, C, G)).toBe(0);
  });

  it('ticksLeftAt agrees with phaseAt about when the round is live', () => {
    // Population: every elapsed from -2 to C + G + 2, at both the positive-grace and
    // the shipped zero-grace spans.
    for (const g of [G, 0]) {
      for (let e = -2; e <= C + g + 2; e++) {
        expect(ticksLeftAt(e, C, g) === 0).toBe(phaseAt(e, C, g) === 'live');
      }
    }
  });

  it('skips countdown too when that span is zero, rather than mis-ordering', () => {
    // Not a configuration anything ships, but it proves the two spans are independent
    // and that a zero span is skipped rather than special-cased for grace alone.
    expect(phaseAt(0, 0, G)).toBe('grace');
    expect(phaseAt(G - 1, 0, G)).toBe('grace');
    expect(phaseAt(G, 0, G)).toBe('live');
    expect(phaseAt(0, 0, 0)).toBe('live');
  });
});
