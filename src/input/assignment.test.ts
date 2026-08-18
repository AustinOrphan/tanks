import { describe, it, expect } from 'vitest';
import {
  deriveInitialAssignment,
  reassign,
  botAssignmentAllowed,
  createHeldInputSource,
  type Assignment,
  type SlotSource,
} from './assignment';
import { createWorld, applyPlayerInput } from '../sim/world';
import type { Tank } from '../sim/types';

describe('deriveInitialAssignment', () => {
  it('today\'s rule, made explicit: slot0 keyboard, slot i>=1 gamepad@padIndex i, no bots', () => {
    expect(deriveInitialAssignment(4, new Set())).toEqual<Assignment>([
      { kind: 'keyboard' },
      { kind: 'gamepad', padIndex: 1 },
      { kind: 'gamepad', padIndex: 2 },
      { kind: 'gamepad', padIndex: 3 },
    ]);
  });

  it('a single-player session with no bots is just keyboard', () => {
    expect(deriveInitialAssignment(1, new Set())).toEqual<Assignment>([{ kind: 'keyboard' }]);
  });

  it('bot-claimed slots (botSlotsFor\'s LAST-K rule) win over the default keyboard/gamepad fill', () => {
    // playerCount 3, last 1 slot (slot 2) is a bot -- mirrors botSlotsFor(3, 1).
    expect(deriveInitialAssignment(3, new Set([2]))).toEqual<Assignment>([
      { kind: 'keyboard' },
      { kind: 'gamepad', padIndex: 1 },
      { kind: 'bot' },
    ]);
  });

  it('slot 0 itself can be a bot -- the fully autonomous playerCount=1,bots=1 match', () => {
    expect(deriveInitialAssignment(1, new Set([0]))).toEqual<Assignment>([{ kind: 'bot' }]);
  });

  it('every slot can be a bot at once', () => {
    expect(deriveInitialAssignment(2, new Set([0, 1]))).toEqual<Assignment>([
      { kind: 'bot' },
      { kind: 'bot' },
    ]);
  });
});

describe('reassign: exclusivity-bounce cases', () => {
  const base: Assignment = [
    { kind: 'keyboard' },
    { kind: 'gamepad', padIndex: 1 },
    { kind: 'bot' },
    { kind: 'none' },
  ];

  it('assigning keyboard bounces whichever OTHER slot held it to none', () => {
    const next = reassign(base, 3, { kind: 'keyboard' });
    expect(next[3]).toEqual<SlotSource>({ kind: 'keyboard' });
    expect(next[0]).toEqual<SlotSource>({ kind: 'none' }); // bounced
    // Unrelated slots are untouched.
    expect(next[1]).toEqual<SlotSource>({ kind: 'gamepad', padIndex: 1 });
    expect(next[2]).toEqual<SlotSource>({ kind: 'bot' });
  });

  it('assigning a gamepad padIndex bounces whichever OTHER slot claims that same index', () => {
    const next = reassign(base, 3, { kind: 'gamepad', padIndex: 1 });
    expect(next[3]).toEqual<SlotSource>({ kind: 'gamepad', padIndex: 1 });
    expect(next[1]).toEqual<SlotSource>({ kind: 'none' }); // bounced
    expect(next[0]).toEqual<SlotSource>({ kind: 'keyboard' }); // untouched
  });

  it('a gamepad padIndex nobody currently holds bounces nothing', () => {
    const next = reassign(base, 3, { kind: 'gamepad', padIndex: 9 });
    expect(next).toEqual<Assignment>([
      { kind: 'keyboard' },
      { kind: 'gamepad', padIndex: 1 },
      { kind: 'bot' },
      { kind: 'gamepad', padIndex: 9 },
    ]);
  });

  it('assigning bot never bounces anything, even displacing keyboard/gamepad holders elsewhere', () => {
    const next = reassign(base, 1, { kind: 'bot' });
    expect(next[1]).toEqual<SlotSource>({ kind: 'bot' });
    expect(next[0]).toEqual<SlotSource>({ kind: 'keyboard' }); // untouched
  });

  it('assigning none never bounces anything', () => {
    const next = reassign(base, 0, { kind: 'none' });
    expect(next[0]).toEqual<SlotSource>({ kind: 'none' });
    expect(next[1]).toEqual<SlotSource>({ kind: 'gamepad', padIndex: 1 }); // untouched
  });

  it('a slot never bounces ITSELF: reassigning a slot to the source it already holds is a no-op', () => {
    const next = reassign(base, 1, { kind: 'gamepad', padIndex: 1 });
    expect(next).toEqual(base);
  });

  it('reassigning keyboard to the slot that already holds it is idempotent', () => {
    const next = reassign(base, 0, { kind: 'keyboard' });
    expect(next).toEqual(base);
  });

  it('is pure: the input array is never mutated', () => {
    const before = JSON.parse(JSON.stringify(base));
    reassign(base, 3, { kind: 'keyboard' });
    expect(base).toEqual(before);
  });

  it('preserves the length invariant regardless of which kind is assigned', () => {
    for (const source of [
      { kind: 'keyboard' },
      { kind: 'gamepad', padIndex: 5 },
      { kind: 'bot' },
      { kind: 'none' },
    ] as const) {
      expect(reassign(base, 2, source)).toHaveLength(base.length);
    }
  });
});

describe('createHeldInputSource: the un-retired echo, for a deliberately unassigned (\'none\') slot', () => {
  function makePlayerTank(id: number, x: number, y: number): Tank {
    return {
      id, kind: 'player', pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive: true,
      desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
      aiState: 'idle', aiTimer: 0,
    };
  }

  it('with no position ever set, samples a neutral input at the construction default', () => {
    const src = createHeldInputSource();
    expect(src.sample()).toEqual({ move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false });
  });

  it('never moves, fires or lays a mine, whatever position it is fed', () => {
    const src = createHeldInputSource();
    src.setPlayerPosition({ x: 11, y: 16.333 });
    const s = src.sample();
    expect(s.move).toEqual({ x: 0, y: 0 });
    expect(s.fire).toBe(false);
    expect(s.mine).toBe(false);
  });

  it('echoes the RAW (unquantized) position once known, not the literal {0,0} default', () => {
    const src = createHeldInputSource();
    src.setPlayerPosition({ x: 11, y: 16.333 }); // an off-grid, non-origin spawn
    expect(src.sample().aim).toEqual({ x: 11, y: 16.333 });
  });

  it('a null position after a real one holds the last REAL position, not {0,0}', () => {
    const src = createHeldInputSource();
    src.setPlayerPosition({ x: 5, y: -3 });
    src.setPlayerPosition(null);
    expect(src.sample().aim).toEqual({ x: 5, y: -3 });
  });

  it('gamepadConnected is always false: a reserved-idle slot has no hardware behind it', () => {
    const src = createHeldInputSource();
    expect(src.gamepadConnected()).toBe(false);
  });

  it('dispose is a no-op that does not throw: no listeners, no timers, no wrapped reader', () => {
    const src = createHeldInputSource();
    expect(() => src.dispose()).not.toThrow();
  });

  it('RED-FIRST: driven through the REAL sim, the turret holds its spawn heading instead ' +
    'of slewing toward world-origin -- this is the un-retirement\'s whole justification', () => {
    const tank = makePlayerTank(1, 11, 16.333);
    const world = createWorld({
      walls: [], tanks: [tank],
      spawns: [{ kind: 'player', pos: { x: tank.pos.x, y: tank.pos.y }, angle: 0 }],
      lives: 3,
    });
    const src = createHeldInputSource();
    src.setPlayerPosition({ x: tank.pos.x, y: tank.pos.y });
    applyPlayerInput(world, src.sample(), []);
    expect(tank.turretAngle).toBe(0); // held, not slewed toward (0,0)
  });
});

describe('botAssignmentAllowed: bots may not drive a player tank in the campaign', () => {
  // A directive: bots must not control player tanks in the campaign unless campaign bot
  // players are enabled by a dev flag. The full 2x3 truth table, so neither limb can be
  // dropped without a failure -- returning `true` unconditionally breaks the first case,
  // returning `campaignBotsEnabled` alone breaks both versus cases, and returning
  // `mode !== 'campaign-coop'` alone breaks the second.
  it('refuses in campaign-coop when the dev flag is absent', () => {
    expect(botAssignmentAllowed('campaign-coop', false)).toBe(false);
  });

  it('allows in campaign-coop when the dev flag is present', () => {
    expect(botAssignmentAllowed('campaign-coop', true)).toBe(true);
  });

  it('allows in ffa and teams regardless of the flag -- standing in for absent players is the point there', () => {
    expect(botAssignmentAllowed('ffa', false)).toBe(true);
    expect(botAssignmentAllowed('ffa', true)).toBe(true);
    expect(botAssignmentAllowed('teams', false)).toBe(true);
    expect(botAssignmentAllowed('teams', true)).toBe(true);
  });
});
