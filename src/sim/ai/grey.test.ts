import { describe, it, expect } from 'vitest';
import { greyDecision } from './grey';
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
    tick: 0, nextId: 100, seed: 7, tanks: [], bullets: [], mines: [], walls: [],
    spawns: [], status: 'playing', lives: 3, ...over,
  };
}

describe('greyDecision', () => {
  // ---- Brief tests (4, with correction A on the dodge test) ----

  it('wander direction is deterministic for a fixed seed (reproducible)', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const w = world({ tanks: [grey] }); // no player, no threats -> pure wander
    const a = greyDecision(w, grey);
    const b = greyDecision(w, grey);
    expect(a.desiredMove).toEqual(b.desiredMove);
    expect(Math.hypot(a.desiredMove.x, a.desiredMove.y)).toBeCloseTo(1, 6);
  });

  it('an incoming bullet overrides wander with a lateral dodge (signed tie-break)', () => {
    const grey = tank(1, 'grey', { x: 3, y: 0 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // straight at grey
    const w = world({ tanks: [grey], bullets: [b] });
    const d = greyDecision(w, grey);
    // dodge is perpendicular to the bullet's +x direction.
    // rel = tank.pos - bullet.pos = (3,0); dir = (1,0); perpA = (0,1), perpB = (0,-1).
    // vdot(rel, perpA) = 0, which takes the >= 0 branch -> perpA = (0,1). Pin the SIDE,
    // not just the axis: Math.abs(...) on y would pass for either perpendicular.
    expect(d.desiredMove.x).toBeCloseTo(0, 6);
    expect(d.desiredMove.y).toBeCloseTo(1, 6);
  });

  it('fires normal only with line-of-sight', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const clear = greyDecision(world({ tanks: [grey, player] }), grey);
    expect(clear.fire).toBe(true);
    expect(clear.fireType).toBe('normal');

    const blocked = greyDecision(world({ tanks: [grey, player], walls: [wall(9, 2, -1, 3, 1)] }), grey);
    expect(blocked.fire).toBe(false);
  });

  it("steers away from its own armed mine's blast radius", () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const w = world({
      tanks: [grey],
      mines: [{ id: 70, ownerId: 1, pos: { x: 1, y: 0 }, timer: 3, armed: true, detonated: false }],
    });
    const d = greyDecision(w, grey);
    // moving away from the mine at +x means a negative x component
    expect(d.desiredMove.x).toBeLessThan(0);
  });

  // ---- Additional required tests (B-G) ----

  it('B: same wander bucket (ticks 0 and 29) yields the same heading', () => {
    const grey0 = tank(1, 'grey', { x: 0, y: 0 });
    const grey29 = tank(1, 'grey', { x: 0, y: 0 });
    const w0 = world({ tanks: [grey0], tick: 0 });
    const w29 = world({ tanks: [grey29], tick: 29 });
    const d0 = greyDecision(w0, grey0);
    const d29 = greyDecision(w29, grey29);
    expect(d29.desiredMove.x).toBeCloseTo(d0.desiredMove.x, 12);
    expect(d29.desiredMove.y).toBeCloseTo(d0.desiredMove.y, 12);
  });

  it('C: different wander bucket (ticks 0 and 30) yields a different heading', () => {
    const grey0 = tank(1, 'grey', { x: 0, y: 0 });
    const grey30 = tank(1, 'grey', { x: 0, y: 0 });
    const w0 = world({ tanks: [grey0], tick: 0 });
    const w30 = world({ tanks: [grey30], tick: 30 });
    const d0 = greyDecision(w0, grey0);
    const d30 = greyDecision(w30, grey30);
    const dx = Math.abs(d0.desiredMove.x - d30.desiredMove.x);
    const dy = Math.abs(d0.desiredMove.y - d30.desiredMove.y);
    expect(dx > 1e-6 || dy > 1e-6).toBe(true);
  });

  it('D: different tank ids wander differently in the same world/tick', () => {
    const greyA = tank(1, 'grey', { x: 0, y: 0 });
    const greyB = tank(2, 'grey', { x: 0, y: 0 });
    const w = world({ tanks: [greyA, greyB], tick: 0 });
    const dA = greyDecision(w, greyA);
    const dB = greyDecision(w, greyB);
    const dx = Math.abs(dA.desiredMove.x - dB.desiredMove.x);
    const dy = Math.abs(dA.desiredMove.y - dB.desiredMove.y);
    expect(dx > 1e-6 || dy > 1e-6).toBe(true);
  });

  it('E: no live player -> no fire, turretAngle and aiState pass through unchanged', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { turretAngle: 1.234, aiState: 'reposition' });
    const w = world({ tanks: [grey] });
    const d = greyDecision(w, grey);
    expect(d.fire).toBe(false);
    expect(d.turretAngle).toBe(1.234);
    expect(d.nextState).toBe('reposition');
  });

  it('F: nextTimer is 0 and mine is false on the fire path and the no-player path', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const firing = greyDecision(world({ tanks: [grey, player] }), grey);
    expect(firing.nextTimer).toBe(0);
    expect(firing.mine).toBe(false);

    const noPlayer = greyDecision(world({ tanks: [grey] }), grey);
    expect(noPlayer.nextTimer).toBe(0);
    expect(noPlayer.mine).toBe(false);
  });

  it('G: wander heading is always unit length across ticks', () => {
    for (const t of [0, 30, 60, 90]) {
      const grey = tank(1, 'grey', { x: 0, y: 0 });
      const w = world({ tanks: [grey], tick: t });
      const d = greyDecision(w, grey);
      expect(Math.hypot(d.desiredMove.x, d.desiredMove.y)).toBeCloseTo(1, 6);
    }
  });
});
