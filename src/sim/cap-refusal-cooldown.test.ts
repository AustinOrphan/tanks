// A shot refused by the shell cap costs the fire cooldown (issue #356).
//
// Two claims, and the second is the one that needed the change. Mechanically the refusal is
// now paced by the same clock a real shot is, so a cue attached to `fire-blocked` cannot
// outrun a cannon: measured over 3 seeds x 3 arenas with the trigger held, refusals fell from
// 1378.3/min to 61.7/min at a player cap of 1, and the longest unbroken burst went from 166
// ticks to 1 at EVERY cap. And it gives the rule teeth -- spraying while every shell is still
// in the air costs the same beat a real shot costs.
//
// Only the CAP refusal pays. dispatch.test.ts pins the others (teammate on the line, barrel
// still traversing) leaving the cooldown alone, because none of those is the shooter's doing.
import { describe, it, expect } from 'vitest';
import { createWorld, step } from './world';
import { configFor } from './config';
import { COUNTDOWN_TICKS, FIRE_COOLDOWN_TICKS } from './constants';
import type { Bullet, Spawn, Tank, TankKind, Vec2 } from './types';

function mkTank(p: Partial<Tank> & { id: number; kind: TankKind; pos: Vec2 }): Tank {
  return {
    bodyAngle: 0, turretAngle: 0, alive: true, desiredMove: { x: 0, y: 0 },
    activeMineIds: [], fireCooldown: 0, mineCooldown: 0, aiState: 'idle', aiTimer: 0, ...p,
  };
}
const shells = (ownerId: number, n: number): Bullet[] =>
  Array.from({ length: n }, (_, i) => ({
    id: 500 + i, ownerId, type: 'normal' as const,
    pos: { x: 20 + i, y: 20 }, vel: { x: 0, y: 0 }, bouncesLeft: 9, alive: true,
  }));
const SPAWNS: Spawn[] = [{ kind: 'player', pos: { x: 0, y: 0 }, angle: 0 }];
function liveWorld(held: number) {
  const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } });
  const w = createWorld({ walls: [], tanks: [player], spawns: SPAWNS, lives: 3 });
  w.bullets = shells(1, held);
  w.roundStartTick = w.tick - COUNTDOWN_TICKS - 1; // past the countdown, so fire is live
  return w;
}
const FIRE = { move: { x: 0, y: 0 }, aim: { x: 10, y: 0 }, fire: true, mine: false };
const CAP = configFor('player').weapon.maxActiveProjectiles;
const COOLDOWN = configFor('player').weapon.fireCooldown;

describe('a shell-cap refusal costs the cooldown', () => {
  it('charges the same cooldown a real shot does', () => {
    const r = step(liveWorld(CAP), FIRE);
    expect(r.events.filter((e) => e.type === 'fire')).toHaveLength(0);
    expect(r.events.filter((e) => e.type === 'fire-blocked')).toHaveLength(1);
    const p = r.world.tanks[0];
    // Charged, and charged the SAME amount -- a cheaper refusal would still let the cue
    // outpace the cannon, just by less.
    expect(p.fireCooldown).toBe(COOLDOWN);
    const fired = step(liveWorld(CAP - 1), FIRE).world.tanks[0];
    expect(p.fireCooldown).toBe(fired.fireCooldown);
  });

  it('refuses at exactly the fire cadence, never faster', () => {
    // The structural claim behind the measurement: with the cooldown charged, the next tick
    // fails the `fireCooldown <= 0` gate, so `spawnBullet` is not even reached. That is what
    // makes the longest observed burst exactly one tick rather than merely shorter.
    //
    // The fixture RE-FILLS the tank to its cap every tick, deliberately. An earlier version
    // let five zero-velocity shells sit in the world and saw a single refusal in 80 ticks:
    // the shells expired, the tank dropped below its cap, and the next attempt was an
    // ordinary shot. Holding it at the cap is what isolates the cooldown from shell lifetime.
    const atCap = () => shells(1, CAP);
    let w = liveWorld(0);
    const refusals: number[] = [];
    for (let t = 0; t < 80; t++) {
      w.bullets = atCap();
      const r = step(w, FIRE);
      if (r.events.some((e) => e.type === 'fire-blocked')) refusals.push(t);
      w = r.world;
    }
    expect(refusals.length, 'the fixture must actually keep refusing').toBeGreaterThan(2);
    // Every gap is the full cooldown -- not merely "more than one tick".
    const gaps = refusals.slice(1).map((v, i) => v - refusals[i]);
    expect(gaps.every((g) => g === FIRE_COOLDOWN_TICKS), `gaps: ${gaps.join(',')}`).toBe(true);
  });

  it('leaves the cooldown alone when the tank never reaches the trigger', () => {
    // A dead tank pays nothing, and the reason is worth being exact about: it does not reach
    // the fire block at all (`applyPlayerInput` returns early on a dead player), so this
    // pins the OUTER gate rather than the `shellCapReached` guard beside it.
    //
    // Measured, and recorded so nobody reads more into that guard than is there: replacing
    // `fired || shellCapReached(...)` with a bare `true` SURVIVES this file. Today the cap is
    // the only refusal that can reach `spawnBullet` from either caller -- its other early
    // return is a dead or missing owner, and both callers exclude those first -- so the
    // guard is defensive, not load-bearing. It earns its place the moment `spawnBullet`
    // grows a third reason, which is exactly when charging for it would be wrong.
    const dead = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 }, alive: false });
    const w = createWorld({ walls: [], tanks: [dead], spawns: SPAWNS, lives: 3 });
    w.bullets = shells(1, CAP);
    w.roundStartTick = w.tick - COUNTDOWN_TICKS - 1;
    const r = step(w, FIRE);
    expect(r.events.filter((e) => e.type === 'fire-blocked')).toHaveLength(0);
    expect(r.world.tanks[0].fireCooldown).toBe(0);
  });

  it('does not charge a tank that never pulled the trigger', () => {
    // Sitting at the cap is not an offence; ASKING while at it is. Without this, a tank
    // parked on its cap would be silently held on cooldown forever.
    const r = step(liveWorld(CAP), { ...FIRE, fire: false });
    expect(r.world.tanks[0].fireCooldown).toBe(0);
  });
});
