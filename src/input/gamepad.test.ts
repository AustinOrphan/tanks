import { describe, it, expect } from 'vitest';
import {
  deadzoneVector,
  createGamepadReader,
  GAMEPAD_DEADZONE,
  GAMEPAD_FIRE_BUTTON,
  GAMEPAD_MINE_BUTTON,
  type GamepadLike,
  type GetGamepads,
} from './gamepad';
import { AIM_PROJECTION_UNITS } from './touch';

describe('deadzoneVector', () => {
  it('reads exactly zero, and any noise no larger than the dead zone, as no input', () => {
    expect(deadzoneVector(0, 0)).toEqual({ x: 0, y: 0 });
    expect(deadzoneVector(GAMEPAD_DEADZONE, 0)).toEqual({ x: 0, y: 0 }); // exactly on the edge
    expect(deadzoneVector(0.05, 0.05)).toEqual({ x: 0, y: 0 }); // magnitude ~0.07, under 0.2
  });

  it('rescales just past the dead zone to just past zero, not a jump to the dead-zone value', () => {
    const v = deadzoneVector(GAMEPAD_DEADZONE + 0.01, 0);
    expect(v.x).toBeGreaterThan(0);
    expect(v.x).toBeLessThan(0.1);
  });

  it('reaches magnitude 1 at full deflection, straight along an axis', () => {
    const v = deadzoneVector(1, 0);
    expect(v.x).toBeCloseTo(1, 10);
    expect(v.y).toBe(0);
  });

  it('clamps a raw diagonal (magnitude ~1.414) to magnitude 1, unlike the keyboard sum', () => {
    const v = deadzoneVector(1, 1);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 10);
  });

  it('preserves direction through the rescale', () => {
    const v = deadzoneVector(0.6, 0.8); // a 3-4-5 triangle, unit direction (0.6, 0.8)
    const len = Math.hypot(v.x, v.y);
    expect(v.x / len).toBeCloseTo(0.6, 10);
    expect(v.y / len).toBeCloseTo(0.8, 10);
  });

  it('honours a custom dead zone', () => {
    expect(deadzoneVector(0.5, 0, 0.6)).toEqual({ x: 0, y: 0 });
    expect(deadzoneVector(0.7, 0, 0.6).x).toBeGreaterThan(0);
  });
});

/** A minimal fake pad, defaulting to centred sticks and released buttons. */
function fakePad(overrides: Partial<{ axes: number[]; buttons: boolean[] }> = {}): GamepadLike {
  const axes = overrides.axes ?? [0, 0, 0, 0];
  const pressedFlags = overrides.buttons ?? [];
  return {
    axes,
    buttons: Array.from({ length: Math.max(pressedFlags.length, 2) }, (_, i) => ({
      pressed: pressedFlags[i] ?? false,
    })),
  };
}

describe('createGamepadReader: no pad present', () => {
  it('returns a neutral poll and reports disconnected, for an empty array', () => {
    const reader = createGamepadReader(() => []);
    const poll = reader.poll(null);
    expect(poll).toEqual({ move: { x: 0, y: 0 }, aim: null, fire: false, mine: false });
    expect(reader.connected()).toBe(false);
  });

  it('tolerates a slot of null forever -- Firefox hides an unpressed pad this way', () => {
    const reader = createGamepadReader(() => [null, null, null, null]);
    for (let i = 0; i < 5; i++) {
      expect(reader.poll(null).move).toEqual({ x: 0, y: 0 });
    }
    expect(reader.connected()).toBe(false);
  });

  it('tolerates getGamepads throwing, rather than propagating', () => {
    const getGamepads: GetGamepads = () => {
      throw new Error('no gamepad API here');
    };
    const reader = createGamepadReader(getGamepads);
    expect(() => reader.poll(null)).not.toThrow();
    expect(reader.connected()).toBe(false);
  });
});

describe('createGamepadReader: connection edge', () => {
  // The reader deliberately computes NO justConnected field: an earlier draft carried
  // one, fully tested, and review proved it dead -- loop.ts derives the connect
  // toast's rising edge from connected() itself (pinned in loop.test.ts, including the
  // reconnect re-toast). What this block pins instead is the raw material that edge is
  // derived FROM: connected() tracking presence across polls.
  it('connected() follows presence across a disconnect/reconnect cycle', () => {
    let present = true;
    const reader = createGamepadReader(() => (present ? [fakePad()] : []));
    reader.poll(null);
    expect(reader.connected()).toBe(true);
    present = false;
    reader.poll(null);
    expect(reader.connected()).toBe(false);
    present = true;
    reader.poll(null);
    expect(reader.connected()).toBe(true);
  });

  it('connected() reflects the last poll without calling getGamepads again', () => {
    let calls = 0;
    const getGamepads: GetGamepads = () => {
      calls += 1;
      return [fakePad()];
    };
    const reader = createGamepadReader(getGamepads);
    reader.poll(null);
    expect(calls).toBe(1);
    reader.connected();
    reader.connected();
    reader.connected();
    // A production change that made connected() re-poll would raise this past 1.
    expect(calls).toBe(1);
    expect(reader.connected()).toBe(true);
  });
});

describe('createGamepadReader: move (left stick)', () => {
  it('is zero while the stick sits inside the dead zone', () => {
    const reader = createGamepadReader(() => [fakePad({ axes: [0.1, 0.1, 0, 0] })]);
    expect(reader.poll(null).move).toEqual({ x: 0, y: 0 });
  });

  it('reports a normalized vector once the stick clears the dead zone, matching deadzoneVector directly', () => {
    const reader = createGamepadReader(() => [fakePad({ axes: [1, 0, 0, 0] })]);
    expect(reader.poll(null).move).toEqual(deadzoneVector(1, 0));
  });

  it('tolerates a pad reporting fewer than 4 axes', () => {
    const reader = createGamepadReader(() => [{ axes: [1], buttons: [] } as unknown as GamepadLike]);
    expect(() => reader.poll(null)).not.toThrow();
    expect(reader.poll(null).move.x).toBeGreaterThan(0);
  });
});

describe('createGamepadReader: aim (right stick)', () => {
  it('is null when the right stick is centred -- hold whatever aim is already live', () => {
    const reader = createGamepadReader(() => [fakePad({ axes: [0, 0, 0, 0] })]);
    expect(reader.poll({ x: 5, y: 5 }).aim).toBeNull();
  });

  it('is null with no player position, even with the stick fully pushed', () => {
    const reader = createGamepadReader(() => [fakePad({ axes: [0, 0, 1, 0] })]);
    expect(reader.poll(null).aim).toBeNull();
  });

  it('projects a point AIM_PROJECTION_UNITS from the player, along the pushed direction', () => {
    const reader = createGamepadReader(() => [fakePad({ axes: [0, 0, 1, 0] })]);
    const aim = reader.poll({ x: 5, y: 5 })!.aim!;
    expect(aim.x).toBeCloseTo(5 + AIM_PROJECTION_UNITS, 6);
    expect(aim.y).toBeCloseTo(5, 6);
  });

  it('projects along a diagonal direction too, unit-normalized regardless of the dead-zone rescale', () => {
    const reader = createGamepadReader(() => [fakePad({ axes: [0, 0, 1, 1] })]);
    const playerPos = { x: 0, y: 0 };
    const aim = reader.poll(playerPos)!.aim!;
    const dist = Math.hypot(aim.x - playerPos.x, aim.y - playerPos.y);
    expect(dist).toBeCloseTo(AIM_PROJECTION_UNITS, 6);
  });
});

describe('createGamepadReader: fire and mine are edges, never held state', () => {
  it('fires exactly once across three polls with the button held down the whole time', () => {
    const reader = createGamepadReader(() => [fakePad({ buttons: [true, false] })]);
    const results = [reader.poll(null), reader.poll(null), reader.poll(null)];
    expect(results.map((r) => r.fire)).toEqual([true, false, false]);
  });

  it('fires again on a second distinct press after release', () => {
    let pressed = true;
    const reader = createGamepadReader(() => [fakePad({ buttons: [pressed, false] })]);
    expect(reader.poll(null).fire).toBe(true);
    pressed = false;
    expect(reader.poll(null).fire).toBe(false);
    pressed = true;
    expect(reader.poll(null).fire).toBe(true);
  });

  it('mine is the independent second button, same edge rule', () => {
    const reader = createGamepadReader(() => [fakePad({ buttons: [false, true] })]);
    const results = [reader.poll(null), reader.poll(null)];
    expect(results.map((r) => r.mine)).toEqual([true, false]);
    expect(results.every((r) => !r.fire)).toBe(true);
  });

  it('uses GAMEPAD_FIRE_BUTTON / GAMEPAD_MINE_BUTTON as the button indices', () => {
    expect(GAMEPAD_FIRE_BUTTON).toBe(0);
    expect(GAMEPAD_MINE_BUTTON).toBe(1);
  });

  it('a disconnect clears the held-button edge state, so a reconnect with the same button still down fires once more rather than reading as still-held', () => {
    let present = true;
    let pressed = true;
    const reader = createGamepadReader(() => (present ? [fakePad({ buttons: [pressed, false] })] : []));
    expect(reader.poll(null).fire).toBe(true);
    present = false;
    reader.poll(null); // disconnect
    present = true;
    // A fresh connection with the same physical button state reads as a new press,
    // because the reader cannot know whether it is the SAME press that survived the gap.
    expect(reader.poll(null).fire).toBe(true);
  });
});
