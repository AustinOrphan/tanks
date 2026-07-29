import { describe, it, expect } from 'vitest';
import { brownDecision } from './brown';
import { aimJitter, aimLead } from './targeting';
import { AI_AIM_SPREAD, bulletConfig } from '../constants';
import type { Tank, Vec2, Wall } from '../types';
import type { World } from '../world';

function tank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}

function wall(id: number, minX: number, minY: number, maxX: number, maxY: number): Wall {
  return { id, aabb: { minX, minY, maxX, maxY }, kind: 'solid', destroyed: false };
}

function world(tanks: Tank[], walls: Wall[] = []): World {
  return {
    tick: 0, nextId: 100, seed: 1, tanks, bullets: [], mines: [], walls,
    spawns: [], status: 'playing', lives: 3, roundStartTick: 0, unarmedTrigger: 'none' as const,
  };
}

describe('brownDecision', () => {
  // Brief tests (5)
  it('never moves', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = brownDecision(world([brown, player]), brown);
    expect(d.desiredMove).toEqual({ x: 0, y: 0 });
    expect(d.fireType).toBe('normal');
    expect(d.mine).toBe(false);
    expect(d.nextTimer).toBe(0);
  });

  it('leads a moving player (turret angle offset from the direct angle)', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 }, { desiredMove: { x: 0, y: 1 } });
    const w = world([brown, player]);
    const d = brownDecision(w, brown);
    // Brown at (0,0), player at (5,0) moving +y with TANK_SPEED=3 gives targetVel=(0,3)
    // With normal-shell speed 6, the intercept is at (5, 2.88675)
    // atan2(2.88675, 5) = π/6 exactly, plus this tank/tick's seeded aim jitter.
    expect(d.turretAngle).toBeCloseTo(Math.PI / 6 + aimJitter(w, brown, AI_AIM_SPREAD), 6);
  });

  it('leads a diagonal-moving player (clamped velocity)', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 }, { desiredMove: { x: 1, y: 1 } });
    const w = world([brown, player]);
    const d = brownDecision(w, brown);
    // desiredMove = (1,1) has length sqrt(2) ≈ 1.4142, so clamped direction = (1/√2, 1/√2)
    // targetVel = clamped * TANK_SPEED(3) = (3/√2, 3/√2) ≈ (2.1213, 2.1213), magnitude 3.0
    // aimLead quadratic: a = 9-36 = -27, b = 30/√2 = 15√2, c = 25
    // disc = 450 + 2700 = 3150, sqrt(disc) ≈ 56.0656
    // t ≈ 1.4311, intercept ≈ (8.0355, 3.0355), angle ≈ 0.3614 radians
    const sqrt2 = Math.sqrt(2);
    const velocityMagnitude = Math.sqrt((3 / sqrt2) ** 2 + (3 / sqrt2) ** 2); // should be 3.0
    expect(velocityMagnitude).toBeCloseTo(3.0, 6);
    // The exact angle computed from aimLead with clamped velocity (3/√2, 3/√2), plus this
    // tank/tick's seeded aim jitter.
    expect(d.turretAngle).toBeCloseTo(0.36137 + aimJitter(w, brown, AI_AIM_SPREAD), 5);
  });

  it('applies aim jitter: the final turret angle differs from the un-jittered aimLead result', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([brown, player]);
    const d = brownDecision(w, brown);
    const unjittered = aimLead(brown.pos, player.pos, { x: 0, y: 0 }, bulletConfig.normal.speed);
    expect(d.turretAngle).not.toBe(unjittered);
    expect(Math.abs(d.turretAngle - unjittered)).toBeLessThanOrEqual(AI_AIM_SPREAD + 1e-12);
  });

  it('fires only with clear line-of-sight, and advances Aim -> Fire', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = brownDecision(world([brown, player]), brown);
    expect(d.fire).toBe(true);
    expect(d.nextState).toBe('fire');
    expect(d.mine).toBe(false);
    expect(d.nextTimer).toBe(0);
  });

  it('does not fire when a wall blocks line-of-sight', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const walls = [wall(9, 2, -1, 3, 1)]; // between brown and player
    const d = brownDecision(world([brown, player], walls), brown);
    expect(d.fire).toBe(false);
  });

  it('returns to a cooldown state after firing (Fire -> Reposition)', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'fire' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = brownDecision(world([brown, player]), brown);
    expect(d.fire).toBe(false);
    expect(d.nextState).toBe('reposition');
  });

  // Additional tests (B-G)
  it('idle + clear LOS → nextState is aim, fire false', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'idle' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = brownDecision(world([brown, player]), brown);
    expect(d.nextState).toBe('aim');
    expect(d.fire).toBe(false);
  });

  it('idle + blocked LOS → nextState stays idle, fire false', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'idle' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const walls = [wall(9, 2, -1, 3, 1)]; // between brown and player
    const d = brownDecision(world([brown, player], walls), brown);
    expect(d.nextState).toBe('idle');
    expect(d.fire).toBe(false);
  });

  it('aim + blocked LOS → nextState is idle', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const walls = [wall(9, 2, -1, 3, 1)]; // between brown and player
    const d = brownDecision(world([brown, player], walls), brown);
    expect(d.nextState).toBe('idle');
  });

  it('reposition → nextState is idle, fire false', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'reposition' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = brownDecision(world([brown, player]), brown);
    expect(d.nextState).toBe('idle');
    expect(d.fire).toBe(false);
  });

  it('Turret holds previous angle when LOS is blocked', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim', turretAngle: 1.234 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const walls = [wall(9, 2, -1, 3, 1)]; // between brown and player
    const d = brownDecision(world([brown, player], walls), brown);
    expect(d.turretAngle).toBe(1.234);
  });

  it('No live player - world with no player', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim', turretAngle: 1.234 });
    const d = brownDecision(world([brown]), brown);
    expect(d.desiredMove).toEqual({ x: 0, y: 0 });
    expect(d.fire).toBe(false);
    expect(d.nextState).toBe('idle');
    expect(d.turretAngle).toBe(1.234);
    expect(d.mine).toBe(false);
    expect(d.fireType).toBe('normal');
    expect(d.nextTimer).toBe(0);
  });

  // ---- Friendly fire. resolveBulletHits kills ANY non-owner tank the shell touches, and
  // Brown never moves, so a parked Brown is a permanently available friendly-fire target.
  // lineOfSight only tests walls, so nothing used to stop this. ----

  it('holds fire when a teammate is standing on the firing line', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const mate = tank(3, 'grey', { x: 2.5, y: 0 }); // squarely between brown and the player
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = brownDecision(world([brown, mate, player]), brown);
    expect(d.fire).toBe(false);
    // Still tracking, still in 'aim': it must shoot the instant the teammate steps aside,
    // not fall back to 'idle' and re-walk the whole state machine.
    expect(d.nextState).toBe('aim');
  });

  it('fires when the teammate is well clear of the firing line', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const mate = tank(3, 'grey', { x: 2.5, y: 4 }); // same x, far off the y=0 line
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = brownDecision(world([brown, mate, player]), brown);
    expect(d.fire).toBe(true);
  });

  it('fires past a DEAD teammate on the line (a corpse is not a friendly-fire risk)', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const corpse = tank(3, 'grey', { x: 2.5, y: 0 }, { alive: false });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = brownDecision(world([brown, corpse, player]), brown);
    expect(d.fire).toBe(true);
  });

  it('No live player - player exists but not alive', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim', turretAngle: 1.234 });
    const player = tank(2, 'player', { x: 5, y: 0 }, { alive: false });
    const d = brownDecision(world([brown, player]), brown);
    expect(d.desiredMove).toEqual({ x: 0, y: 0 });
    expect(d.fire).toBe(false);
    expect(d.nextState).toBe('idle');
    expect(d.turretAngle).toBe(1.234);
    expect(d.mine).toBe(false);
    expect(d.nextTimer).toBe(0);
  });
});
