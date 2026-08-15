import { describe, it, expect } from 'vitest';
import { incomingThreats, dangerAvoidMove } from './targeting';
import { AI_MINE_FLEE_RADIUS } from '../constants';
import type { Tank, Bullet, Mine, Vec2, Wall } from '../types';
import type { World } from '../world';

function tank(id: number, pos: Vec2): Tank {
  return {
    id, kind: 'grey', pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  };
}
function wall(id: number, minX: number, minY: number, maxX: number, maxY: number): Wall {
  return { id, aabb: { minX, minY, maxX, maxY }, kind: 'solid', destroyed: false };
}
function bullet(id: number, ownerId: number, pos: Vec2, vel: Vec2): Bullet {
  return { id, ownerId, type: 'normal', pos, vel, bouncesLeft: 1, alive: true };
}
function world(over: Partial<World>): World {
  return {
    tick: 0, nextId: 100, seed: 1, tanks: [], bullets: [], mines: [], blasts: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: 0, unarmedTrigger: 'none' as const,
    corpseBlocksShells: false, muzzleClearsTanks: true, ...over,
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

  it('ignores the tank\'s own bullets while they are travelling AWAY from it', () => {
    const t = tank(1, { x: 3, y: 0 });
    const b = bullet(50, 1, { x: 0, y: 0 }, { x: -6, y: 0 }); // own shell, heading -x, away
    const w = world({ tanks: [t], bullets: [b] });
    expect(incomingThreats(w, t)).toHaveLength(0);
  });

  it('ignores the tank\'s own shell at the instant it leaves the muzzle (vel . rel == 0)', () => {
    // A fresh shell spawns AT the owner's position, so rel is the zero vector and the
    // dot product is exactly 0. resolveBulletHits treats that as NOT lethal (`<= 0`), so
    // incomingThreats must too -- otherwise every AI dodges the moment it pulls the
    // trigger, forever.
    const t = tank(1, { x: 3, y: 0 });
    const b = bullet(50, 1, { x: 3, y: 0 }, { x: 6, y: 0 });
    const w = world({ tanks: [t], bullets: [b] });
    expect(incomingThreats(w, t)).toHaveLength(0);
  });

  it('flags the tank\'s OWN shell once it is heading back at it (ricochet self-kill)', () => {
    // resolveBulletHits (bullets.ts) makes a shell lethal to its owner as soon as
    // vdot(b.vel, ownerPos - b.pos) > 0. NORMAL_BOUNCES is 1 and RICOCHET_BOUNCES is 3,
    // so EVERY AI shell can come back. Skipping own bullets outright meant the AI stood
    // still and let its own ricochet kill it.
    const t = tank(1, { x: 0, y: 0 });
    const b = bullet(50, 1, { x: -2, y: 0 }, { x: 6, y: 0 }); // own shell, now inbound
    const w = world({ tanks: [t], bullets: [b] });
    expect(incomingThreats(w, t).map((x) => x.id)).toContain(50);
    // ...and the tank must actually react to it, not just know about it.
    expect(dangerAvoidMove(w, t)).not.toBeNull();
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

  it('flees an UNARMED mine too -- the fuse does not care whether it armed', () => {
    // stepMines detonates on MINE_TIMER expiry regardless of `armed`, and that path
    // "spares nobody, including an owner still standing on it". A tank that dropped a mine
    // and then loitered inside 1.5 units (so it never armed) was blown up by its own fuse
    // while dangerAvoidMove reported no danger at all. Armed-ness only gates the PROXIMITY
    // trigger; the flee radius must not be gated on it.
    const t = tank(1, { x: 0, y: 0 });
    const m = mine(70, 1, { x: 1, y: 0 }, false);
    const move = dangerAvoidMove(world({ tanks: [t], mines: [m] }), t);
    expect(move).not.toBeNull();
    expect(move!.x).toBeCloseTo(-1, 6);
  });

  it('ignores detonated mines', () => {
    const t = tank(1, { x: 0, y: 0 });
    const m = mine(70, 1, { x: 1, y: 0 }, true);
    m.detonated = true; // mine has detonated
    const w = world({ tanks: [t], mines: [m] });
    expect(dangerAvoidMove(w, t)).toBeNull();
  });

  it('ignores mines beyond the flee radius', () => {
    const t = tank(1, { x: 0, y: 0 });
    const m = mine(70, 1, { x: 5, y: 0 }, true); // distance 5 > AI_MINE_FLEE_RADIUS
    const w = world({ tanks: [t], mines: [m] });
    expect(dangerAvoidMove(w, t)).toBeNull();
  });

  it('returns null when nothing threatens', () => {
    const t = tank(1, { x: 0, y: 0 });
    const w = world({ tanks: [t] });
    expect(dangerAvoidMove(w, t)).toBeNull();
  });

  // ---- Flee radius must cover the LETHAL radius, with a margin to escape it ----

  it('flees a mine sitting at exactly the radius detonateMine kills at (MINE_BLAST_RADIUS + TANK_RADIUS)', () => {
    // detonateMine kills every tank with vdist(t.pos, mine.pos) <= 2.0 + 0.5 = 2.5.
    // Guarding on MINE_PROXIMITY_RADIUS + TANK_RADIUS (= 2.0) instead left a 0.5-unit
    // shell of the lethal zone the AI stood in without reacting at all.
    const t = tank(1, { x: 0, y: 0 });
    const m = mine(70, 1, { x: 2.5, y: 0 }, true);
    const move = dangerAvoidMove(world({ tanks: [t], mines: [m] }), t);
    expect(move).not.toBeNull();
    expect(move!.x).toBeCloseTo(-1, 6);
  });

  it('flee radius boundary is inclusive ("<="), and stops just outside it', () => {
    const at = tank(1, { x: 0, y: 0 });
    const outside = tank(1, { x: 0, y: 0 });
    const mAt = mine(70, 1, { x: AI_MINE_FLEE_RADIUS, y: 0 }, true);
    const mOut = mine(70, 1, { x: AI_MINE_FLEE_RADIUS + 1e-9, y: 0 }, true);
    expect(dangerAvoidMove(world({ tanks: [at], mines: [mAt] }), at)).not.toBeNull();
    expect(dangerAvoidMove(world({ tanks: [outside], mines: [mOut] }), outside)).toBeNull();
  });

  it('escapes a bracket of two live mines instead of fleeing one into the other', () => {
    // MINE_CAP is 2, so a tank that drops one mine, walks off, and drops the second can
    // end up between them -- and the midpoint of two mines 2.8 apart is inside BOTH kill
    // radii. Fleeing only the nearest sends it at the other one, which then becomes the
    // nearest, so it ping-pongs in place until a 3-second fuse kills it where it stands.
    // Measured over 30 seeded games: 24 of 26 own-mine deaths had BOTH mines in flee
    // range, walking 5.91 units of path for 1.29 units of net displacement.
    const t = tank(1, { x: 0, y: 0 });
    const left = mine(70, 1, { x: -1.8, y: 0 }, true);
    const right = mine(71, 1, { x: 1, y: 0 }, true);
    const move = dangerAvoidMove(world({ tanks: [t], mines: [left, right] }), t);
    expect(move).not.toBeNull();
    // The escape must not close the gap on EITHER mine. Both lie on the x axis, so the
    // only directions that satisfy that are perpendicular to it.
    for (const m of [left, right]) {
      const toMine = { x: m.pos.x - t.pos.x, y: m.pos.y - t.pos.y };
      expect(move!.x * toMine.x + move!.y * toMine.y).toBeLessThanOrEqual(1e-9);
    }
  });

  it('still flees a single mine directly away from it', () => {
    const t = tank(1, { x: 0, y: 0 });
    const only = mine(71, 1, { x: 1, y: 0 }, true);
    const move = dangerAvoidMove(world({ tanks: [t], mines: [only] }), t);
    expect(move).not.toBeNull();
    expect(move!.x).toBeCloseTo(-1, 6);
    expect(move!.y).toBeCloseTo(0, 6);
  });

  // ---- The dodge direction must be wall-aware and mine-aware ----

  it('dodges to the opposite perpendicular when the preferred side is blocked by a wall', () => {
    // moveTank pushes a tank back out of any wall it overlaps, so a dodge aimed into a
    // wall nets EXACTLY zero displacement: the tank sits pinned in the danger corridor
    // and dies. Repro from the review: grey pinned against a wall for 24 ticks.
    const t = tank(1, { x: 0, y: 0.5 });
    const b = bullet(50, 99, { x: -3, y: 0.35 }, { x: 6, y: 0 });
    // rel = (3, 0.15); dir = (1,0); perpA = (0,1) wins the >= 0 tie-break -- straight
    // into this wall. perpB = (0,-1) is clear.
    const walls = [wall(9, -5, 1, 5, 5)];
    const move = dangerAvoidMove(world({ tanks: [t], bullets: [b], walls }), t);
    expect(move).not.toBeNull();
    expect(move!.x).toBeCloseTo(0, 6);
    expect(move!.y).toBeCloseTo(-1, 6);
  });

  it('still uses the preferred side when no wall blocks it', () => {
    // Same fixture minus the wall: the side-preference rule must survive the wall fix.
    const t = tank(1, { x: 0, y: 0.5 });
    const b = bullet(50, 99, { x: -3, y: 0.35 }, { x: 6, y: 0 });
    const move = dangerAvoidMove(world({ tanks: [t], bullets: [b] }), t);
    expect(move!.y).toBeCloseTo(1, 6);
  });

  it('picks the dodge side that does not step toward a nearby armed mine', () => {
    // The bullet branch used to `return` unconditionally, so a tank standing next to an
    // armed mine dodged a shell straight into the mine instead.
    const t = tank(1, { x: 3, y: 0.1 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // preferred perpendicular is (0,+1)
    const m = mine(70, 99, { x: 3, y: 2 }, true);             // ...and the mine is at +y
    const move = dangerAvoidMove(world({ tanks: [t], bullets: [b], mines: [m] }), t);
    expect(move).not.toBeNull();
    expect(move!.y).toBeCloseTo(-1, 6);
  });
});
