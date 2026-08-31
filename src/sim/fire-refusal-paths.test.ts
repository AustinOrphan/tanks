// Which refusals say "your shells are all out there", and which say nothing (issue #356).
//
// `fire-blocked` exists so a cue can explain ONE refusal: the active-shell cap. Four other
// things also stop a shot -- the fire cooldown, the round-phase lock, a per-tank action lock,
// and being dead -- and none of them may reach the same cue, or the game would tell a player
// mid-countdown that their magazine is full.
//
// bullets.test.ts already pins the emission and the dead-owner silence at the spawnBullet
// level. It cannot pin the other three, because they gate BEFORE spawnBullet is ever called
// (world.ts's `canAct && input.fire && player.fireCooldown <= 0`) -- so the only place their
// silence is observable is through the public boundary. These drive step().
import { describe, it, expect } from 'vitest';
import { createWorld, step } from './world';
import { configFor } from './config';
import { COUNTDOWN_TICKS } from './constants';
import type { SimEvent } from './events';
import type { Bullet, Spawn, Tank, TankKind, Vec2 } from './types';

function mkTank(p: Partial<Tank> & { id: number; kind: TankKind; pos: Vec2 }): Tank {
  return {
    bodyAngle: 0, turretAngle: 0, alive: true, desiredMove: { x: 0, y: 0 },
    activeMineIds: [], fireCooldown: 0, mineCooldown: 0, aiState: 'idle', aiTimer: 0, ...p,
  };
}
function shellsFor(ownerId: number, n: number): Bullet[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 500 + i, ownerId, type: 'normal' as const,
    pos: { x: 20 + i, y: 20 }, vel: { x: 0, y: 0 }, bouncesLeft: 9, alive: true,
  }));
}
/** A live world (past the countdown) holding one player and `shells` of its own shells. */
const SPAWNS: Spawn[] = [{ kind: 'player', pos: { x: 0, y: 0 }, angle: 0 }];
function liveWorld(shells: number, over: Partial<Tank> = {}) {
  const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 }, ...over });
  // A spawn is required, not decoration: the dead-tank case below reaches the respawn path,
  // which reads world.spawns and throws on an empty list.
  const w = createWorld({ walls: [], tanks: [player], spawns: SPAWNS, lives: 3 });
  w.bullets = shellsFor(1, shells);
  // Past the countdown: `roundStartTick` is the tick the round's first simulated tick will
  // carry, so backdating it is what makes `roundPhase` report 'live' on the very next step.
  w.roundStartTick = w.tick - COUNTDOWN_TICKS - 1;
  return w;
}
const FIRE = { move: { x: 0, y: 0 }, aim: { x: 10, y: 0 }, fire: true, mine: false };
const blocked = (events: SimEvent[]) => events.filter((e) => e.type === 'fire-blocked');
const fired = (events: SimEvent[]) => events.filter((e) => e.type === 'fire');
const CAP = configFor('player').weapon.maxActiveProjectiles;

describe('what a refused shot says, per refusal path (issue #356)', () => {
  it('SUCCESS: a shot below the cap fires and says nothing about being blocked', () => {
    const r = step(liveWorld(CAP - 1), FIRE);
    expect(fired(r.events)).toHaveLength(1);
    expect(blocked(r.events)).toHaveLength(0);
  });

  it('CAPACITY: at the cap, the refusal is announced, with the owner and the reason', () => {
    const r = step(liveWorld(CAP), FIRE);
    expect(fired(r.events)).toHaveLength(0);
    // ownerId is what lets a consumer show the cue to the CONTROLLING player only -- the
    // same event is emitted for enemy owners (bullets.test.ts), so a treatment that ignored
    // this field would flash on every enemy's blocked shot.
    expect(blocked(r.events)).toEqual([{ type: 'fire-blocked', ownerId: 1, reason: 'shell-cap' }]);
  });

  it('COOLDOWN: silent -- a shot still reloading is not a capacity problem', () => {
    // At the cap AND on cooldown would be ambiguous, so this fixture is deliberately BELOW
    // the cap: the only reason it cannot fire is the cooldown.
    const r = step(liveWorld(0, { fireCooldown: 5 }), FIRE);
    expect(fired(r.events)).toHaveLength(0);
    expect(blocked(r.events)).toHaveLength(0);
  });

  it('COUNTDOWN: silent, even with every shell already in the air', () => {
    // The nastiest of the four to get wrong: the tank IS at its cap here, so an
    // implementation that checked capacity before the phase would announce a full magazine
    // during the pre-round countdown, when firing was never on offer.
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } });
    const w = createWorld({ walls: [], tanks: [player], spawns: SPAWNS, lives: 3 });
    w.bullets = shellsFor(1, CAP);
    const r = step(w, FIRE); // fresh world: still inside the countdown
    expect(fired(r.events)).toHaveLength(0);
    expect(blocked(r.events)).toHaveLength(0);
  });

  it('DEAD: silent, even at the cap', () => {
    // NO SINGLE MUTATION BREAKS THIS ONE, and that is worth stating rather than leaving a
    // reader to discover it. Three independent guards stop a dead tank firing --
    // applyPlayerInput's own liveness check, spawnBullet's, and the respawn shield that
    // makes `canAct` false the moment the tank comes back -- so deleting any one, or even
    // the first two together, leaves this green (measured). The case still discriminates on
    // deadness: the same fixture fires normally with `alive` true, one line above.
    const r = step(liveWorld(CAP, { alive: false }), FIRE);
    expect(fired(r.events)).toHaveLength(0);
    expect(blocked(r.events)).toHaveLength(0);
  });

  it('NOT FIRING: silent at the cap when the trigger is not pulled', () => {
    // The cue is for a REFUSED REQUEST, not for the state of being full. Without this, a
    // treatment could legitimately be built on an event that fires 60 times a second at
    // every tank sitting on its cap.
    const r = step(liveWorld(CAP), { ...FIRE, fire: false });
    expect(blocked(r.events)).toHaveLength(0);
  });
});
