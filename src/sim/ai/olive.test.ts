import { describe, it, expect } from 'vitest';
import { decideAi, stepAi } from './index';
import { greyDecision } from './grey';
import { bulletConfig } from '../constants';
import type { Tank, Vec2 } from '../types';
import { vlen } from '../types';
import type { World } from '../world';

// ---------------------------------------------------------------------------
// Olive is the first kind added PURELY AS DATA -- a roster entry naming
// DEFENSIVE_ROCKET, no new decision code. These tests prove the whole pipeline
// end-to-end at the stepAi level: the routing, the weapon, the one-rocket cap
// and the mine denial all come from the resolved config. Every assertion names
// the roster edit that would break it.
// ---------------------------------------------------------------------------

function tank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}
const FAR_PAST = -100000;
function world(tanks: Tank[], over: Partial<World> = {}): World {
  return {
    tick: 0, nextId: 100, seed: 5, tanks, bullets: [], mines: [], blasts: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: FAR_PAST,
    unarmedTrigger: 'none', ...over,
  };
}

describe('olive, driven end-to-end by its resolved config', () => {
  it('fires a FAST rocket: bullet type, speed and zero bounces all from the roster', () => {
    // Breaks if olive's weapon.projectileType stops being ROCKET, or the
    // ProjectileType->BulletType mapping changes.
    const olive = tank(1, 'olive', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 }); // clear LOS
    const w = world([olive, player]);
    stepAi(w, []);
    expect(w.bullets).toHaveLength(1);
    expect(w.bullets[0].type).toBe('fast');
    expect(vlen(w.bullets[0].vel)).toBeCloseTo(bulletConfig.fast.speed, 9);
    expect(w.bullets[0].bouncesLeft).toBe(bulletConfig.fast.bounces);
  });

  it('one rocket in flight, ever: the per-kind cap reaches spawnBullet', () => {
    // Bullets are never advanced here (no stepBullets), so they only accumulate:
    // the strictest possible test of maxActiveProjectiles = 1. Breaks if the
    // roster raises the cap -- 400 ticks spans many 38-tick cooldown cycles, so
    // a cap of SHELL_CAP would land 5 shells.
    const olive = tank(1, 'olive', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([olive, player]);
    for (let i = 0; i < 400; i++) {
      stepAi(w, []);
      expect(w.bullets.filter((b) => b.alive && b.ownerId === 1).length).toBeLessThanOrEqual(1);
    }
    expect(w.bullets.filter((b) => b.ownerId === 1).length).toBe(1);
  });

  it('never lays a mine where a grey does: ability, profile and capacity all deny it', () => {
    // Control first: the same fixture with a grey genuinely produces a mine, so
    // the olive assertion cannot pass vacuously.
    const control = world([tank(1, 'grey', { x: 0, y: 0 }), tank(9, 'player', { x: 3, y: 0 })]);
    stepAi(control, []);
    expect(control.mines).toHaveLength(1);

    const w = world([tank(1, 'olive', { x: 0, y: 0 }), tank(9, 'player', { x: 3, y: 0 })]);
    for (let i = 0; i < 120; i++) stepAi(w, []);
    expect(w.mines).toHaveLength(0);
  });

  it('routes to the DEFENSIVE implementation: decideAi(olive) IS greyDecision(olive)', () => {
    // A fixture where the implementations visibly differ: brown would return
    // desiredMove {0,0}; the mobile implementations wander. Olive's decision must
    // match greyDecision exactly (same wander draw, same weapon) -- breaks if the
    // roster's aiProfile stops resolving to a DEFENSIVE behaviour.
    const build = () => world([tank(1, 'olive', { x: 0, y: 0 }), tank(2, 'player', { x: 8, y: 3 })]);
    const viaDispatch = decideAi(build(), build().tanks[0]);
    const direct = greyDecision(build(), build().tanks[0]);
    expect(viaDispatch).toEqual(direct);
    expect(vlen(viaDispatch.desiredMove)).toBeGreaterThan(0.9); // and it is genuinely mobile
  });
});
