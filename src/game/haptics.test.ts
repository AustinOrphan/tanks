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
    expect(calls[0]).not.toEqual(FIRE_PULSE_MS);
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
    const seen: Array<number | number[]> = [];
    const nav = {
      vibrate(pattern: number | number[]): boolean {
        seen.push(pattern);
        return true;
      },
    };
    const vibrate = resolveVibrate({ navigator: nav });
    expect(vibrate(10)).toBe(true);
    expect(seen).toEqual([10]);
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
