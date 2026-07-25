import { describe, it, expect } from 'vitest';
import { incomingThreats, dangerAvoidMove } from './targeting';
import type { Tank, Bullet, Mine, Vec2 } from '../types';
import type { World } from '../world';

function tank(id: number, pos: Vec2): Tank {
  return {
    id, kind: 'grey', pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  };
}
function bullet(id: number, ownerId: number, pos: Vec2, vel: Vec2): Bullet {
  return { id, ownerId, type: 'normal', pos, vel, bouncesLeft: 1, alive: true };
}
function world(over: Partial<World>): World {
  return {
    tick: 0, nextId: 100, seed: 1, tanks: [], bullets: [], mines: [], walls: [],
    spawns: [], status: 'playing', lives: 3, ...over,
  };
}

function mine(id: number, ownerId: number, pos: Vec2, armed: boolean): Mine {
  return { id, ownerId, pos, timer: 3, armed, detonated: false };
}

describe('incomingThreats', () => {
  it('flags a bullet whose path passes through the tank', () => {
    const t = tank(1, { x: 3, y: 0 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // heading +x straight at the tank
    const w = world({ tanks: [t], bullets: [b] });
    expect(incomingThreats(w, t).map((x) => x.id)).toContain(50);
  });

  it('does not flag a bullet heading away from the tank', () => {
    const t = tank(1, { x: 3, y: 0 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: -6, y: 0 }); // heading -x, away
    const w = world({ tanks: [t], bullets: [b] });
    expect(incomingThreats(w, t)).toHaveLength(0);
  });

  it('ignores the tank\'s own bullets', () => {
    const t = tank(1, { x: 3, y: 0 });
    const b = bullet(50, 1, { x: 0, y: 0 }, { x: 6, y: 0 }); // owner is the tank itself
    const w = world({ tanks: [t], bullets: [b] });
    expect(incomingThreats(w, t)).toHaveLength(0);
  });
});

describe('dangerAvoidMove', () => {
  it('dodges laterally (perpendicular) to an incoming bullet, not backward into it', () => {
    const t = tank(1, { x: 3, y: 0.1 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // heading +x
    const w = world({ tanks: [t], bullets: [b] });
    const move = dangerAvoidMove(w, t)!;
    expect(move).not.toBeNull();
    // move is perpendicular to the bullet direction (dot ~ 0), i.e. sideways
    expect(Math.abs(move.x * 1 + move.y * 0)).toBeCloseTo(0, 6);
    // it's a unit vector
    expect(Math.hypot(move.x, move.y)).toBeCloseTo(1, 6);
  });

  it('moves away from a nearby armed mine (including its own)', () => {
    const t = tank(1, { x: 0, y: 0 });
    const m = mine(70, 1, { x: 1, y: 0 }, true); // own mine, armed, within proximity
    const w = world({ tanks: [t], mines: [m] });
    const move = dangerAvoidMove(w, t)!;
    // direction points away from the mine (negative x component dominant)
    expect(move.x).toBeLessThan(0);
  });

  it('returns null when nothing threatens', () => {
    const t = tank(1, { x: 0, y: 0 });
    const w = world({ tanks: [t] });
    expect(dangerAvoidMove(w, t)).toBeNull();
  });
});
