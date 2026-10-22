/**
 * One opponent drives movement AND fire (issue #893), in its own file since issue #1104.
 * Two of these tests are the named killers of the manifest entries
 * `bot-fires-at-an-opponent-it-cannot-see` and `bot-movement-and-fire-split-again`, and the
 * mutation harness runs whole files. In player-profile.test.ts, 'a competent scripted player
 * against the shipped arenas' simulates 25 seeded games on every shipped arena in its
 * describe body, 225 games at 9 arenas: 54 s of that file's 55 s on one local worker
 * (2026-10-22), for verdicts these tests reach in milliseconds. Neither mutant lengthens
 * those games, so the cost was the suite's own and not a tick cap the mutants run into.
 *
 * The retreat test and the "wins a meaningful share of games" test named in the comments
 * below are still in player-profile.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { createWorld } from '../world';
import type { Tank, Vec2 } from '../types';
import { fromAngle, vnorm, vsub, vdist } from '../types';
import { decidePlayerInput, createPlayerAiState, mulberry32 } from './player-profile';

function makeTank(kind: Tank['kind'], id: number, x: number, y: number, team?: number): Tank {
  return {
    id, kind, pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
    ...(team !== undefined ? { team } : {}),
  };
}

describe('issue #893: one opponent drives movement AND fire, not two', () => {
  const PLAYER_ID = 1;

  /**
   * The fixture the old code got wrong: the CLOSEST opponent is behind a wall, and a FARTHER
   * one is in the open. Before this change `assessThreats` handed movement the closest tank
   * while a separate line-of-sight scan handed aim and fire the visible one, so the bot drove
   * at the tank it could not shoot and shot the tank it was driving away from.
   */
  const occludedNear = () => {
    const player = makeTank('player', PLAYER_ID, 0, 0);
    // Closest by distance (9), to the LEFT, with a solid wall across the line to it.
    const hidden = makeTank('brown', 2, -9, 0);
    // Farther (12), to the RIGHT, in the clear. The sides matter: the approach heading has
    // to be one the path probe will accept, or `seekLikeMove` falls back to wander and the
    // assertion below compares against a direction the bot was never going to take.
    const seen = makeTank('grey', 3, 12, 0);
    const wall = { id: 1, aabb: { minX: -5, minY: -3, maxX: -4, maxY: 3 }, kind: 'solid' as const, destroyed: false };
    return { player, hidden, seen, world: createWorld({ walls: [wall], tanks: [player, hidden, seen], spawns: [], lives: 3 }) };
  };

  it('aims at the opponent it can see, not the nearer one behind a wall', () => {
    const { player, seen, world } = occludedNear();
    const rnd = mulberry32(3);
    const state = createPlayerAiState(rnd);
    const input = decidePlayerInput(world, PLAYER_ID, rnd, state);
    // The aim point is player.pos + unit direction, so the direction is aim - pos.
    const toSeen = vnorm(vsub(seen.pos, player.pos));
    const aimDir = vnorm(vsub(input.aim, player.pos));
    expect(aimDir.x, 'aim is not at the visible opponent').toBeCloseTo(toSeen.x, 1);
    expect(aimDir.y, 'aim is not at the visible opponent').toBeCloseTo(toSeen.y, 1);
  });

  it('MOVES toward that same opponent, which is the half that used to disagree', () => {
    const { player, hidden, seen, world } = occludedNear();
    const rnd = mulberry32(3);
    const state = createPlayerAiState(rnd);
    const input = decidePlayerInput(world, PLAYER_ID, rnd, state);

    // Same reconstruction the retreat test uses: the wander heading this exact call drew.
    const wander = fromAngle(state.wanderHeading);
    const blend = (toward: Vec2): Vec2 => vnorm({
      x: toward.x * 0.5 + wander.x * 0.5,
      y: toward.y * 0.5 + wander.y * 0.5,
    });
    const towardHidden = blend(vnorm(vsub(hidden.pos, player.pos)));
    const towardSeen = blend(vnorm(vsub(seen.pos, player.pos)));

    // The fixture must actually discriminate, or this passes while measuring nothing.
    expect(vdist(towardHidden, towardSeen), 'fixture does not separate the two candidates')
      .toBeGreaterThan(0.5);

    expect(input.move.x, `move.x: old(nearest-by-distance)=${towardHidden.x.toFixed(4)} new(engaged)=${towardSeen.x.toFixed(4)}`)
      .toBeCloseTo(towardSeen.x, 5);
    expect(input.move.y, `move.y: old(nearest-by-distance)=${towardHidden.y.toFixed(4)} new(engaged)=${towardSeen.y.toFixed(4)}`)
      .toBeCloseTo(towardSeen.y, 5);
  });

  it('holds its turret when NOTHING is visible, rather than tracking the tank behind the wall', () => {
    // The other half of `engaged = nearestVisible ?? nearest`: with no line of sight to
    // anyone, the bot still has an opponent to move toward but no firing solution. This is
    // the case that keeps the change a refactor -- it behaved this way before too.
    const player = makeTank('player', PLAYER_ID, 0, 0);
    const hidden = makeTank('brown', 2, -9, 0);
    const wall = { id: 1, aabb: { minX: -5, minY: -3, maxX: -4, maxY: 3 }, kind: 'solid' as const, destroyed: false };
    const world = createWorld({ walls: [wall], tanks: [player, hidden], spawns: [], lives: 3 });
    const rnd = mulberry32(3);
    const state = createPlayerAiState(rnd);
    const input = decidePlayerInput(world, PLAYER_ID, rnd, state);

    // Asserting `fire === false` here would be VACUOUS, and was until this comment replaced
    // it: `state.aimTicks` is gated on `roundPhase(world) === 'live'` (issue #367), and a
    // hand-built world is not in the live phase, so `fire` is false whatever the targeting
    // does. Measured -- with the line-of-sight half of the gate removed, that version stayed
    // green and only the broad "wins a meaningful share of games" test noticed.
    //
    // The AIM is the phase-independent tell. With nothing visible the bot holds its turret
    // heading; if the fallback opponent leaked into targeting it would swing round and lead
    // the tank behind the wall instead.
    const held = fromAngle(player.turretAngle);
    const aimDir = vnorm(vsub(input.aim, player.pos));
    expect(aimDir.x, 'the turret swung to an opponent it cannot see').toBeCloseTo(held.x, 5);
    expect(aimDir.y, 'the turret swung to an opponent it cannot see').toBeCloseTo(held.y, 5);
    // And the fallback IS still feeding movement, or the test would prove nothing about
    // `engaged = nearestVisible ?? nearest` -- just that targeting is empty.
    expect(vdist(input.move, { x: 0, y: 0 }), 'the bot stopped moving, so no opponent reached movement either')
      .toBeGreaterThan(0.1);
  });
});
