/**
 * The scripted player's countdown clock (issue #367), in its own file on purpose
 * (issue #502): this is the ONE test that kills the manifest entry
 * `scripted-player-clock-banks-countdown-ticks`, and the win-rate suite it used to sit
 * beside simulates whole games to their tick cap under that mutant -- 179 s in CI for a
 * verdict this test reaches in under a second. The mutation harness runs whole files,
 * so the scope has to be the file.
 */
import { describe, it, expect } from 'vitest';
import { createWorld } from '../world';
import type { Tank } from '../types';
import { decidePlayerInput, createPlayerAiState, mulberry32 } from './player-profile';
import { configFor } from '../config';
import { TICK_HZ, COUNTDOWN_TICKS } from '../constants';

function makeTank(kind: Tank['kind'], id: number, x: number, y: number, team?: number): Tank {
  return {
    id, kind, pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
    ...(team !== undefined ? { team } : {}),
  };
}

describe('scripted player: the countdown clock', () => {
  it('countdown ticks do not satisfy the scripted player\'s reaction delay either (#367)', () => {
    // The mirror of the enemy rule (reaction.test.ts). `applyPlayerInput` already refuses
    // the shot during the countdown, so the defect this pins is invisible from the world:
    // the CLOCK banked those ticks, and the scripted player was therefore entitled to
    // fire on the very first live tick. Asserted on `input.fire`, the profile's own
    // output, because that is where the entitlement lives.
    //
    // `createWorld` anchors roundStartTick to tick + 1, so this fixture opens in the
    // countdown without having to say so -- the same anchoring production uses.
    const pid = 1;
    const player = makeTank('player', pid, 0, 0);
    const enemy = makeTank('brown', 2, 6, 0); // clear line of sight, no cover between
    const world = createWorld({ walls: [], tanks: [player, enemy], spawns: [], lives: 3 });
    const rnd = mulberry32(11);
    const state = createPlayerAiState(rnd);

    let firedDuringCountdown = false;
    for (let t = 0; t < COUNTDOWN_TICKS; t++) {
      world.tick += 1;
      if (decidePlayerInput(world, pid, rnd, state).fire) firedDuringCountdown = true;
      expect(state.aimTicks, `countdown tick ${t}`).toBe(0);
    }
    expect(firedDuringCountdown, 'the profile asked to fire during the countdown').toBe(false);

    // Live now. The first tick must NOT be a legal shot; the span starts here.
    const reactionTicks = Math.round(configFor('player').ai.reactionTime * TICK_HZ);
    expect(reactionTicks).toBe(48); // the shipped 0.8s; a retune moves this deliberately
    world.tick += 1;
    expect(decidePlayerInput(world, pid, rnd, state).fire, 'fired on live tick 1').toBe(
      false,
    );
    expect(state.aimTicks).toBe(1);
  });
});
