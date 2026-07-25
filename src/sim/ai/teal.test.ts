import { describe, it, expect } from 'vitest';
import { tealDecision } from './teal';
import type { Tank, Vec2, Wall, Bullet } from '../types';
import type { World } from '../world';

function tank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}
function bullet(id: number, ownerId: number, pos: Vec2, vel: Vec2): Bullet {
  return { id, ownerId, type: 'normal', pos, vel, bouncesLeft: 1, alive: true };
}
function wall(id: number, minX: number, minY: number, maxX: number, maxY: number): Wall {
  return { id, aabb: { minX, minY, maxX, maxY }, kind: 'solid', destroyed: false };
}
function world(over: Partial<World>): World {
  return {
    tick: 0, nextId: 100, seed: 3, tanks: [], bullets: [], mines: [], walls: [],
    spawns: [], status: 'playing', lives: 3, ...over,
  };
}

describe('tealDecision', () => {
  // ---- Brief tests (4, with corrections A/B/C/F applied) ----

  it('takes a direct ricochet shot when line-of-sight is clear', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = tealDecision(world({ tanks: [teal, player] }), teal);
    expect(d.fire).toBe(true);
    expect(d.fireType).toBe('ricochet');
    // B: player is stationary (desiredMove {0,0}) -> driveVelocity is (0,0) -> aimLead
    // reduces to direct aim -> turretAngle toward (5,0) from (0,0) is exactly 0.
    expect(d.turretAngle).toBeCloseTo(0, 6);
    expect(d.nextState).toBe('fire');
    // F: mine/nextTimer on the direct-shot path.
    expect(d.mine).toBe(false);
    expect(d.nextTimer).toBe(0);
  });

  it('fires a bank shot when the player is behind cover but a bank path exists', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1), wall(2, -5, 2, 10, 3)]; // blocker + top bounce wall
    const d = tealDecision(world({ tanks: [teal, player], walls }), teal);
    expect(d.fire).toBe(true);
    expect(d.fireType).toBe('ricochet');
    // C: the bounce point is (2,2), so the firing angle from (0,0) is exactly pi/4.
    // If the direct path to (4,0) had been taken instead, the angle would be 0 (pi/4 != 0),
    // so this also proves lineOfSight(teal, player) was genuinely blocked by the wall(1) blocker
    // and the direct-shot branch was skipped in favour of the bank-shot branch.
    expect(d.turretAngle).toBeCloseTo(Math.PI / 4, 6); // bounce point (2,2)
    // F: mine/nextTimer on the bank-shot path.
    expect(d.mine).toBe(false);
    expect(d.nextTimer).toBe(0);
  });

  it('repositions (no fire) when neither a direct nor a bank shot exists', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1)]; // only the blocker, no bounce surface
    const d = tealDecision(world({ tanks: [teal, player], walls }), teal);
    expect(d.fire).toBe(false);
    expect(d.nextState).toBe('reposition');
    // G: reposition wander is a unit vector, and fireType stays 'ricochet' even off the
    // firing path (Teal has no other bullet type to report).
    expect(Math.hypot(d.desiredMove.x, d.desiredMove.y)).toBeCloseTo(1, 6);
    expect(d.fireType).toBe('ricochet');
    // F: mine/nextTimer on the reposition path.
    expect(d.mine).toBe(false);
    expect(d.nextTimer).toBe(0);
  });

  it('dodges incoming fire instead of shooting, even though the shot is otherwise clear', () => {
    const teal = tank(1, 'teal', { x: 3, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 }); // clear line-of-sight, no walls
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // straight at teal
    const d = tealDecision(world({ tanks: [teal, player], bullets: [b] }), teal);
    // E: dodging must beat shooting, even with a clear shot available.
    expect(d.fire).toBe(false);
    // A: pin the dodge SIDE, not just that x ~ 0.
    // teal at (3,0), bullet at (0,0) heading +x: rel = (3,0), dir = (1,0),
    // perpA = (0,1), perpB = (0,-1). vdot(rel, perpA) = 0 >= 0 -> perpA = (0,1).
    expect(d.desiredMove.x).toBeCloseTo(0, 6);
    expect(d.desiredMove.y).toBeCloseTo(1, 6);
    // F: mine/nextTimer on the dodge path.
    expect(d.mine).toBe(false);
    expect(d.nextTimer).toBe(0);
  });

  // ---- Additional required tests (D) ----

  it('D1: no player tank at all -> idle, no fire, zero move, turretAngle passes through', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 }, { turretAngle: 1.234 });
    const d = tealDecision(world({ tanks: [teal] }), teal);
    expect(d.fire).toBe(false);
    expect(d.desiredMove).toEqual({ x: 0, y: 0 });
    expect(d.nextState).toBe('idle');
    expect(d.turretAngle).toBe(1.234);
    expect(d.mine).toBe(false);
    expect(d.nextTimer).toBe(0);
  });

  it('D2: player exists but is not alive -> idle, no fire, zero move, turretAngle passes through', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 }, { turretAngle: 1.234 });
    const deadPlayer = tank(2, 'player', { x: 5, y: 0 }, { alive: false });
    const d = tealDecision(world({ tanks: [teal, deadPlayer] }), teal);
    expect(d.fire).toBe(false);
    expect(d.desiredMove).toEqual({ x: 0, y: 0 });
    expect(d.nextState).toBe('idle');
    expect(d.turretAngle).toBe(1.234);
    expect(d.mine).toBe(false);
    expect(d.nextTimer).toBe(0);
  });
});
