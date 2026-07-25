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

  it('ignores dead bullets', () => {
    const t = tank(1, { x: 3, y: 0 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 });
    b.alive = false; // bullet is dead
    const w = world({ tanks: [t], bullets: [b] });
    expect(incomingThreats(w, t)).toHaveLength(0);
  });

  it('does not flag a bullet beyond the lookahead horizon', () => {
    const t = tank(1, { x: 10, y: 0 }); // 10 units ahead
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // speed 6, horizon 1s → 6 units lookahead
    const w = world({ tanks: [t], bullets: [b] });
    // along = 10 > speed * THREAT_HORIZON = 6
    expect(incomingThreats(w, t)).toHaveLength(0);
  });

  it('does not flag a bullet when perpendicular distance exceeds corridor width', () => {
    const t = tank(1, { x: 3, y: 1.5 }); // 1.5 units off-axis (> 0.8 corridor)
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // heading +x
    const w = world({ tanks: [t], bullets: [b] });
    // perp distance = 1.5 > DANGER_CORRIDOR (0.8)
    expect(incomingThreats(w, t)).toHaveLength(0);
  });
});

describe('dangerAvoidMove', () => {
  it('dodges laterally (perpendicular) to an incoming bullet, upward when offset above', () => {
    const t = tank(1, { x: 3, y: 0.1 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // heading +x
    const w = world({ tanks: [t], bullets: [b] });
    const result = dangerAvoidMove(w, t);
    expect(result).not.toBeNull();
    const move = result!;
    // move is perpendicular to the bullet direction (dot ~ 0), i.e. sideways
    expect(Math.abs(move.x * 1 + move.y * 0)).toBeCloseTo(0, 6);
    // it's a unit vector
    expect(Math.hypot(move.x, move.y)).toBeCloseTo(1, 6);
    // tank is offset upward (+y), so dodge should be upward
    expect(move.y).toBeCloseTo(1, 6);
  });

  it('dodges laterally to an incoming bullet, downward when offset below', () => {
    const t = tank(1, { x: 3, y: -0.1 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // heading +x
    const w = world({ tanks: [t], bullets: [b] });
    const result = dangerAvoidMove(w, t);
    expect(result).not.toBeNull();
    const move = result!;
    // move is perpendicular (dot ~ 0)
    expect(Math.abs(move.x * 1 + move.y * 0)).toBeCloseTo(0, 6);
    // unit vector
    expect(Math.hypot(move.x, move.y)).toBeCloseTo(1, 6);
    // tank is offset downward (-y), so dodge should be downward
    expect(move.y).toBeCloseTo(-1, 6);
  });

  it('picks the nearest threat when multiple bullets approach', () => {
    const t = tank(1, { x: 0, y: 0.1 });
    // FAR bullet first in array: at (-1, -3), heading +y, distance 3.1
    const bFar = bullet(51, 99, { x: 0, y: -3 }, { x: 0, y: 6 });
    // NEAR bullet second: at (-1, 0), heading +x, distance ~1.005
    const bNear = bullet(50, 99, { x: -1, y: 0 }, { x: 6, y: 0 });
    const w = world({ tanks: [t], bullets: [bFar, bNear] });
    const result = dangerAvoidMove(w, t);
    expect(result).not.toBeNull();
    const move = result!;
    // Should dodge to the nearest (bNear), which heads +x, so perpendicular is ±y.
    // Tank is at (0, 0.1), bNear is at (-1, 0), so rel=(1, 0.1), perpA=(0,1).
    // vdot((1, 0.1), (0, 1)) = 0.1 >= 0 → return perpA = (0, 1)
    expect(move.x).toBeCloseTo(0, 6);
    expect(move.y).toBeCloseTo(1, 6);
  });

  it('moves away from a nearby armed mine (including its own)', () => {
    const t = tank(1, { x: 0, y: 0 });
    const m = mine(70, 1, { x: 1, y: 0 }, true); // own mine, armed, within proximity
    const w = world({ tanks: [t], mines: [m] });
    const result = dangerAvoidMove(w, t);
    expect(result).not.toBeNull();
    const move = result!;
    // direction points away from the mine at (1, 0), so (-1, 0)
    expect(move.x).toBeCloseTo(-1, 6);
    expect(move.y).toBeCloseTo(0, 6);
  });

  it('ignores unarmed mines', () => {
    const t = tank(1, { x: 0, y: 0 });
    const m = mine(70, 1, { x: 1, y: 0 }, false); // mine is not armed
    const w = world({ tanks: [t], mines: [m] });
    expect(dangerAvoidMove(w, t)).toBeNull();
  });

  it('ignores detonated mines', () => {
    const t = tank(1, { x: 0, y: 0 });
    const m = mine(70, 1, { x: 1, y: 0 }, true);
    m.detonated = true; // mine has detonated
    const w = world({ tanks: [t], mines: [m] });
    expect(dangerAvoidMove(w, t)).toBeNull();
  });

  it('ignores mines beyond proximity radius', () => {
    const t = tank(1, { x: 0, y: 0 });
    const m = mine(70, 1, { x: 5, y: 0 }, true); // mine at distance 5 > 2.0 (MINE_PROXIMITY_RADIUS + TANK_RADIUS)
    const w = world({ tanks: [t], mines: [m] });
    expect(dangerAvoidMove(w, t)).toBeNull();
  });

  it('returns null when nothing threatens', () => {
    const t = tank(1, { x: 0, y: 0 });
    const w = world({ tanks: [t] });
    expect(dangerAvoidMove(w, t)).toBeNull();
  });
});
