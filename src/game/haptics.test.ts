// The haptics seam: a fourth event consumer alongside render, particles and audio
// (see CLAUDE.md's "Render and audio are one-way projections"). The vibrate function
// itself is injected -- see resolveVibrate -- so this file never touches `navigator`.
import { describe, it, expect } from 'vitest';
import {
  createHapticsDirector,
  resolveVibrate,
  FIRE_PULSE_MS,
  DESTROYED_PATTERN_MS,
  MINE_NEAR_PULSE_MS,
  MINE_DANGER_RADIUS,
  type VibrateFn,
} from './haptics';
import type { SimEvent } from '../sim/events';

/** Records every call, and always reports success -- a fake device that never refuses. */
function fakeVibrate(): { vibrate: VibrateFn; calls: Array<number | number[]> } {
  const calls: Array<number | number[]> = [];
  return {
    calls,
    vibrate(pattern) {
      calls.push(pattern);
      return true;
    },
  };
}

const PLAYER_ID = 7;
const ENEMY_ID = 8;

function fireEvent(ownerId: number): SimEvent {
  return { type: 'fire', ownerId, bulletType: 'normal', pos: { x: 1, y: 2 }, angle: 0 };
}

function destroyedEvent(kind: 'player' | 'grey', tankId: number): SimEvent {
  return {
    type: 'tank-destroyed',
    tankId,
    kind,
    by: { source: 'shell', ownerId: ENEMY_ID },
    pos: { x: 3, y: 4 },
  };
}

function mineDetonateEvent(pos: { x: number; y: number }): SimEvent {
  return { type: 'mine-detonate', mineId: 1, ownerId: ENEMY_ID, pos };
}

describe('createHapticsDirector', () => {
  it("vibrates the fire pulse for the PLAYER's own shot", () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.handle([fireEvent(PLAYER_ID)]);
    expect(calls).toEqual([FIRE_PULSE_MS]);
  });

  it('does NOT vibrate for an enemy shot -- the stream is shared, discriminate by ownerId', () => {
    // Presence-only (`some(e => e.type === 'fire')`) is exactly the anti-pattern
    // CLAUDE.md names; this is the test that would pass under it and must not.
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.handle([fireEvent(ENEMY_ID)]);
    expect(calls).toHaveLength(0);
  });

  it('vibrates a DIFFERENT pattern when the player is destroyed than when the player fires', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.handle([destroyedEvent('player', PLAYER_ID)]);
    expect(calls).toEqual([DESTROYED_PATTERN_MS]);
    // No `.not.toEqual(FIRE_PULSE_MS)` companion: an array can never toEqual a
    // number, so that assertion was true regardless of either constant's value --
    // review flagged it as decorative and it is deleted rather than kept for show.
  });

  it('pins MINE_DANGER_RADIUS to the sim kill reach it claims to be', () => {
    // The boundary tests below probe RELATIVE to the constant, so they survive any
    // magnitude -- review proved a x10 mutation (radius 25, larger than arena-01's
    // whole board) passed 217 scoped tests. This literal is the magnitude pin:
    // 2.5 = MINE_BLAST_RADIUS (2, balance.json mines.blastRadius) + TANK_RADIUS
    // (0.5, balance.json tank.radius). Breaks if either constant retunes -- which is
    // the point: retuning the sim's kill reach SHOULD force this file to re-affirm
    // that the buzz still means "genuinely in the blast".
    expect(MINE_DANGER_RADIUS).toBe(2.5);
  });

  it('does NOT vibrate when an ENEMY tank is destroyed', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.handle([destroyedEvent('grey', 99)]);
    expect(calls).toHaveLength(0);
  });

  it('vibrates for a mine detonating within kill reach of the player', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setPlayerPosition({ x: 0, y: 0 });
    d.handle([mineDetonateEvent({ x: MINE_DANGER_RADIUS - 0.1, y: 0 })]);
    expect(calls).toEqual([MINE_NEAR_PULSE_MS]);
  });

  it('does NOT vibrate for a mine detonating outside kill reach of the player', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setPlayerPosition({ x: 0, y: 0 });
    d.handle([mineDetonateEvent({ x: MINE_DANGER_RADIUS + 0.1, y: 0 })]);
    expect(calls).toHaveLength(0);
  });

  it('does NOT vibrate for a mine detonation before any player position is known', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.handle([mineDetonateEvent({ x: 0, y: 0 })]);
    expect(calls).toHaveLength(0);
  });

  it('rebinds to a new player id, the way the audio director does across a level switch', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setPlayerId(ENEMY_ID);
    d.handle([fireEvent(PLAYER_ID)]); // now the OLD id, no longer "the player"
    expect(calls).toHaveLength(0);
    d.handle([fireEvent(ENEMY_ID)]);
    expect(calls).toEqual([FIRE_PULSE_MS]);
  });

  it('calls the injected vibrate function with exactly the named constants, nothing invented', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setPlayerPosition({ x: 0, y: 0 });
    d.handle([
      fireEvent(PLAYER_ID),
      destroyedEvent('player', PLAYER_ID),
      mineDetonateEvent({ x: 0.5, y: 0 }),
    ]);
    expect(calls).toEqual([FIRE_PULSE_MS, DESTROYED_PATTERN_MS, MINE_NEAR_PULSE_MS]);
  });

  it('when disabled, calls vibrate zero times even with events flowing', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setEnabled(false);
    d.setPlayerPosition({ x: 0, y: 0 });
    d.handle([
      fireEvent(PLAYER_ID),
      destroyedEvent('player', PLAYER_ID),
      mineDetonateEvent({ x: 0, y: 0 }),
    ]);
    expect(calls).toHaveLength(0);
  });

  it('re-enabling after a disable resumes vibrating', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setEnabled(false);
    d.handle([fireEvent(PLAYER_ID)]);
    d.setEnabled(true);
    d.handle([fireEvent(PLAYER_ID)]);
    expect(calls).toEqual([FIRE_PULSE_MS]);
  });

  it('is silent for event kinds this seam does not cover -- win, ricochet, wall-destroyed', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setPlayerPosition({ x: 0, y: 0 });
    const events: SimEvent[] = [
      { type: 'win' },
      { type: 'lose' },
      { type: 'ricochet', ownerId: PLAYER_ID, pos: { x: 0, y: 0 }, bounceIndex: 0 },
      { type: 'explosion', pos: { x: 0, y: 0 } },
      { type: 'mine-dropped', mineId: 1, ownerId: PLAYER_ID, pos: { x: 0, y: 0 } },
      { type: 'mine-armed', mineId: 1, ownerId: PLAYER_ID, pos: { x: 0, y: 0 } },
      { type: 'wall-destroyed', wallId: 1, ownerId: PLAYER_ID, pos: { x: 0, y: 0 } },
    ];
    d.handle(events);
    expect(calls).toHaveLength(0);
  });
});

describe('resolveVibrate', () => {
  it('binds and returns navigator.vibrate when the host has one', () => {
    // The fake READS `this`, because a fixture that ignores its receiver cannot tell
    // bound from unbound -- review proved the first version passed with .bind(nav)
    // deleted. Chromium's real vibrate throws "Illegal invocation" detached from its
    // navigator; this fake reproduces that contract, so dropping the bind fails here.
    const seen: Array<number | number[]> = [];
    const nav = {
      vibrate(this: unknown, pattern: number | number[]): boolean {
        if (this !== nav) throw new TypeError('Illegal invocation');
        seen.push(pattern);
        return true;
      },
    };
    const vibrate = resolveVibrate({ navigator: nav });
    expect(vibrate(10)).toBe(true);
    expect(seen).toEqual([10]);
  });

  it('degrades to the no-op when the navigator property itself THROWS on access', () => {
    // The resolveStorage-mirroring half the comment promises: Safari-style lockdown
    // hosts throw on property access rather than returning undefined. Breaks if the
    // try/catch around host.navigator is removed.
    const host = {
      get navigator(): { vibrate?: (p: number | number[]) => boolean } {
        throw new Error('SecurityError: navigator access blocked');
      },
    };
    const vibrate = resolveVibrate(host);
    expect(vibrate(10)).toBe(false); // the no-op, not a crash
  });

  it('returns a no-op that reports false when the host has no vibrate', () => {
    const vibrate = resolveVibrate({ navigator: {} });
    expect(vibrate(10)).toBe(false);
  });

  it('returns a no-op when the host has no navigator at all', () => {
    const vibrate = resolveVibrate({});
    expect(vibrate([10, 20])).toBe(false);
  });
});
