import { describe, it, expect } from 'vitest';
import {
  deadzoneVector,
  createGamepadReader,
  createGamepadInputSource,
  readDetectedPads,
  GAMEPAD_DEADZONE,
  GAMEPAD_FIRE_BUTTON,
  GAMEPAD_MINE_BUTTON,
  type GamepadLike,
  type GetGamepads,
} from './gamepad';
import { AIM_PROJECTION_UNITS, AIM_GRID } from './touch';
import { createWorld, applyPlayerInput } from '../sim/world';
import type { Tank } from '../sim/types';

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

describe('createGamepadReader: padIndex (controllers 1-4, PR3)', () => {
  it('defaults to index 0, unchanged from every existing call site (input.ts\'s merge, loop.test.ts\'s pre-PR3 fixtures)', () => {
    const reader = createGamepadReader(() => [fakePad({ axes: [1, 0, 0, 0] })]);
    expect(reader.poll(null).move.x).toBeCloseTo(1, 5);
  });

  it('reads its OWN padIndex, not index 0: a pad only at index 1 is invisible to a reader bound to index 0, and vice versa', () => {
    const pads = [fakePad({ axes: [1, 0, 0, 0] }), null];
    const readerAt0 = createGamepadReader(() => pads, 0);
    const readerAt1 = createGamepadReader(() => pads, 1);
    readerAt0.poll(null);
    readerAt1.poll(null);
    expect(readerAt0.connected()).toBe(true);
    expect(readerAt1.connected()).toBe(false);
  });

  it('THE NAMED TRADEOFF: a LONE connected pad (browser index 0) serves a reader bound to index 0, ' +
    'not one bound to index 1 -- so "P1 on keyboard, hand the one pad to P2" (slot 1, padIndex 1) sees ' +
    'nothing from it. Accepted regression, see docs/superpowers/plans/2026-08-17-controllers-4.md.', () => {
    const lonePad = [fakePad({ axes: [1, 0, 0, 0] })]; // length 1: only index 0 exists
    const slot0Reader = createGamepadReader(() => lonePad, 0);
    const slot1Reader = createGamepadReader(() => lonePad, 1);
    const p0 = slot0Reader.poll(null);
    const p1 = slot1Reader.poll(null);
    expect(p0.move.x).toBeCloseTo(1, 5);
    expect(p1).toEqual({ move: { x: 0, y: 0 }, aim: null, fire: false, mine: false }); // neutral: no pad at 1
    expect(slot0Reader.connected()).toBe(true);
    expect(slot1Reader.connected()).toBe(false);
  });

  it('tolerates a padIndex beyond the array length exactly like index 0 does for an empty array', () => {
    const reader = createGamepadReader(() => [fakePad()], 3);
    expect(reader.poll(null)).toEqual({ move: { x: 0, y: 0 }, aim: null, fire: false, mine: false });
    expect(reader.connected()).toBe(false);
  });

  it('hotplug at a non-zero index: connecting and disconnecting index 2 mid-session flips connected() ' +
    'on the very next poll -- no cached "was it connected last frame" state beyond the fire/mine edge', () => {
    let present = false;
    const reader = createGamepadReader(() => (present ? [null, null, fakePad()] : []), 2);
    expect(reader.poll(null)).toEqual({ move: { x: 0, y: 0 }, aim: null, fire: false, mine: false });
    expect(reader.connected()).toBe(false);
    present = true;
    reader.poll(null);
    expect(reader.connected()).toBe(true);
    present = false;
    reader.poll(null);
    expect(reader.connected()).toBe(false);
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

/**
 * `createGamepadInputSource` is production code today runs `gamepad.ts` detached
 * from `input.ts`'s merge -- this is co-op's slot 1, driven by NOTHING but a
 * `GetGamepads` function. No `@vitest-environment jsdom` pragma on this file (see
 * vite.config.ts's default `environment: 'node'`): these tests running clean under
 * plain node is itself evidence no keyboard/mouse/touch DOM machinery is reachable
 * from this source, since none of that machinery would even construct under node.
 */
describe('createGamepadInputSource: standalone per-slot source', () => {
  it('produces a quantized InputState from the pad alone -- move, a projected aim, and fire/mine as edges', () => {
    const src = createGamepadInputSource(() => [fakePad({ axes: [1, 0, 1, 0], buttons: [true, false] })]);
    src.setPlayerPosition({ x: 5, y: 5 });
    const state = src.sample();
    expect(state.move).toEqual(deadzoneVector(1, 0));
    // Quantized to AIM_GRID, the SAME boundary function input.ts's merged sample() uses
    // (touch.ts's quantizeAim) -- not a second, differently-rounded copy.
    const expectedAim = {
      x: Math.round((5 + AIM_PROJECTION_UNITS) / AIM_GRID) * AIM_GRID,
      y: Math.round(5 / AIM_GRID) * AIM_GRID,
    };
    expect(state.aim).toEqual(expectedAim);
    expect(state.fire).toBe(true);
    expect(state.mine).toBe(false);
  });

  it('defaults aim to the quantized origin before any stick deflection is ever seen', () => {
    const src = createGamepadInputSource(() => [fakePad({ axes: [0, 0, 0, 0] })]);
    src.setPlayerPosition({ x: 5, y: 5 });
    expect(src.sample().aim).toEqual({ x: 0, y: 0 });
  });

  it('self-corrects to the real aim on the first deflection after a neutral start', () => {
    let axes = [0, 0, 0, 0];
    const src = createGamepadInputSource(() => [fakePad({ axes })]);
    src.setPlayerPosition({ x: 0, y: 0 });
    expect(src.sample().aim).toEqual({ x: 0, y: 0 }); // no deflection yet
    axes = [0, 0, 1, 0];
    const aim = src.sample().aim;
    expect(aim.x).toBeGreaterThan(0);
  });

  it('holds the last aim across a poll where the stick recentres -- no mouse/touch fallback exists to keep it alive otherwise', () => {
    let axes = [0, 0, 1, 0];
    const src = createGamepadInputSource(() => [fakePad({ axes })]);
    src.setPlayerPosition({ x: 0, y: 0 });
    const deflected = src.sample().aim;
    axes = [0, 0, 0, 0]; // stick recentres: GamepadReader.poll returns aim: null
    const recentred = src.sample().aim;
    expect(recentred).toEqual(deflected);
  });

  it('gamepadConnected() mirrors the wrapped reader, not a hardcoded true', () => {
    let present = true;
    const src = createGamepadInputSource(() => (present ? [fakePad()] : []));
    src.sample();
    expect(src.gamepadConnected()).toBe(true);
    present = false;
    src.sample();
    expect(src.gamepadConnected()).toBe(false);
  });

  it('works with no player position at all: move and fire/mine still resolve, aim stays at the default', () => {
    const src = createGamepadInputSource(() => [fakePad({ axes: [1, 0, 1, 0], buttons: [true, false] })]);
    const state = src.sample(); // setPlayerPosition never called
    expect(state.move).toEqual(deadzoneVector(1, 0));
    expect(state.fire).toBe(true);
    expect(state.aim).toEqual({ x: 0, y: 0 });
  });

  it('dispose() forwards to the wrapped reader without throwing', () => {
    const src = createGamepadInputSource(() => []);
    expect(() => src.dispose()).not.toThrow();
  });

  /**
   * The N-player design's traced-but-unrun claim, now actually run: with no pad ever
   * connected, `aim` used to never leave its `{0, 0}` construction default, which
   * `world.ts`'s `driveTank` reads as a real aim point at the world's origin -- not as
   * "no info." `driveTank: a literal {0,0} aim is not a neutral` (world.test.ts) pins the
   * mechanism once, permanently; these pin THIS source avoiding it.
   */
  describe('the no-pad-ever-connected case (distinct from a connected pad with a centred stick)', () => {
    function makePlayerTank(id: number, x: number, y: number): Tank {
      return {
        id, kind: 'player', pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive: true,
        desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
        aiState: 'idle', aiTimer: 0,
      };
    }

    it('echoes the RAW (unquantized) position once known, not the literal {0,0} default', () => {
      const src = createGamepadInputSource(() => []); // no pad, ever
      src.setPlayerPosition({ x: 11, y: 16.333 }); // an off-grid, non-origin spawn
      expect(src.sample().aim).toEqual({ x: 11, y: 16.333 });
    });

    it('RED-FIRST: driven through the REAL sim, the turret holds its spawn heading instead ' +
      'of slewing toward world-origin', () => {
      const tank = makePlayerTank(1, 11, 16.333);
      const world = createWorld({
        walls: [], tanks: [tank],
        spawns: [{ kind: 'player', pos: { x: tank.pos.x, y: tank.pos.y }, angle: 0 }],
        lives: 3,
      });
      const src = createGamepadInputSource(() => []); // no pad, ever
      src.setPlayerPosition({ x: tank.pos.x, y: tank.pos.y });
      applyPlayerInput(world, src.sample(), []);
      expect(tank.turretAngle).toBe(0); // held, not slewed toward (0,0)
    });

    it('with NO player position either, falls back to the quantized {0,0} default -- ' +
      'same as the connected-pad case with no position (existing test above)', () => {
      const src = createGamepadInputSource(() => []);
      expect(src.sample().aim).toEqual({ x: 0, y: 0 });
    });

    it('distinguishes "no pad" from "pad connected, stick centred": a CONNECTED pad with ' +
      'a centred stick still holds its last REAL aim, never the raw position echo', () => {
      let axes = [0, 0, 1, 0]; // deflected right on the aim stick
      const src = createGamepadInputSource(() => [fakePad({ axes })]);
      src.setPlayerPosition({ x: 11, y: 16.333 });
      const deflected = src.sample().aim;
      axes = [0, 0, 0, 0]; // stick recentres; pad stays connected throughout
      const recentred = src.sample().aim;
      expect(recentred).toEqual(deflected); // NOT echoed to the raw position
      expect(recentred).not.toEqual({ x: 11, y: 16.333 });
    });
  });
});

describe('createGamepadInputSource: padIndex (controllers 1-4, PR3)', () => {
  it('defaults to index 0, unchanged from every existing call site (input.ts\'s merge)', () => {
    const src = createGamepadInputSource(() => [fakePad({ axes: [1, 0, 0, 0] })]);
    expect(src.sample().move.x).toBeCloseTo(1, 5);
  });

  it('a source built at padIndex 1 reads pad[1]\'s state, not pad[0]\'s', () => {
    const pads = [fakePad({ axes: [0, 0, 0, 0] }), fakePad({ axes: [1, 0, 0, 0] })];
    const src0 = createGamepadInputSource(() => pads, 0);
    const src1 = createGamepadInputSource(() => pads, 1);
    expect(src0.sample().move).toEqual({ x: 0, y: 0 });
    expect(src1.sample().move.x).toBeCloseTo(1, 5);
  });

  it('gamepadConnected() reports its OWN index\'s presence, independent of any other index', () => {
    const pads = [null, fakePad()];
    const src0 = createGamepadInputSource(() => pads, 0);
    const src1 = createGamepadInputSource(() => pads, 1);
    src0.sample();
    src1.sample();
    expect(src0.gamepadConnected()).toBe(false);
    expect(src1.gamepadConnected()).toBe(true);
  });

  it('hotplug: connecting a pad at index 2 mid-session is visible to a source bound to index 2 on the very next sample()', () => {
    let present = false;
    const src = createGamepadInputSource(() => (present ? [null, null, fakePad({ axes: [1, 0, 0, 0] })] : []), 2);
    src.setPlayerPosition({ x: 5, y: 5 });
    expect(src.gamepadConnected()).toBe(false);
    expect(src.sample().move).toEqual({ x: 0, y: 0 });
    present = true;
    expect(src.sample().move.x).toBeCloseTo(1, 5);
    expect(src.gamepadConnected()).toBe(true);
    present = false;
    expect(src.sample().move).toEqual({ x: 0, y: 0 });
    expect(src.gamepadConnected()).toBe(false);
  });
});

describe('readDetectedPads: the controller assignment panel\'s live list', () => {
  it('lists every connected pad with its OWN index, skipping sparse nulls', () => {
    const pads = [fakePad(), null, { ...fakePad(), id: 'Xbox Wireless Controller' }];
    expect(readDetectedPads(() => pads)).toEqual([
      { padIndex: 0, id: '' }, // fakePad() carries no id -- falls back to ''
      { padIndex: 2, id: 'Xbox Wireless Controller' },
    ]);
  });

  it('is empty when nothing is connected', () => {
    expect(readDetectedPads(() => [])).toEqual([]);
    expect(readDetectedPads(() => [null, undefined])).toEqual([]);
  });

  it('tolerates a throwing getGamepads exactly like createGamepadReader does', () => {
    const throwing: GetGamepads = () => {
      throw new Error('no gamepad API');
    };
    expect(readDetectedPads(throwing)).toEqual([]);
  });
});
