import { describe, it, expect } from 'vitest';
import { decideAi, stepAi } from './index';
import { greyDecision } from './grey';
import { bulletConfig } from '../constants';
import type { Bullet, Tank, Vec2 } from '../types';
import { vlen } from '../types';
import { createWorld, step, type World } from '../world';

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
  it("fires a FAST rocket: the roster selects the type; the sim's bullet table arms it", () => {
    // Breaks if olive's weapon.projectileType stops being ROCKET, or the
    // ProjectileType->BulletType mapping changes. The speed/bounces lines pin
    // spawnBullet's construction FOR that type (bulletConfig), not the roster --
    // the roster<->bulletConfig consistency is pinned in config/roster.test.ts's
    // mirror loop. (Review: the old title claimed all three came from the roster.)
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
    // the strictest possible test of the cap's BLOCKING half. Mechanism (review
    // corrected the original comment): a blocked spawnBullet does not re-arm the
    // cooldown, so after the single completed 38-tick cycle olive attempts every
    // tick (~360 blocked attempts in 400) -- while a cap of SHELL_CAP would land
    // 5 shells (successes at ticks 0/39/78/117/156 all fit).
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

  it('routes to the DEFENSIVE implementation: under fire, olive SUPPRESSES like grey', () => {
    // The fixture that discriminates every implementation (review: the original
    // no-threat fixture produced byte-identical grey and teal decisions, so it
    // proved only "not stationary"). A bullet parked in the danger corridor:
    //   grey/DEFENSIVE  -> dodge, HOLD fire, patience counter starts (nextTimer 1)
    //   teal/TACTICAL   -> dodge but FIRE anyway, nextTimer 0
    //   brown/STATIONARY-> desiredMove {0,0}
    // So each assertion below kills a specific wrong routing.
    const threat: Bullet = {
      id: 999, ownerId: 2, type: 'normal', pos: { x: -1, y: 0 }, vel: { x: 5, y: 0 },
      bouncesLeft: 1, alive: true,
    };
    const w = world(
      [tank(1, 'olive', { x: 0, y: 0 }), tank(2, 'player', { x: 20, y: 0 })],
      { bullets: [threat] },
    );
    const d = decideAi(w, w.tanks[0]);
    expect(d).toEqual(greyDecision(w, w.tanks[0]));
    expect(d.fire).toBe(false); // teal-routing fires here
    expect(d.nextTimer).toBe(1); // the DEFENSIVE patience counter, running
    expect(vlen(d.desiredMove)).toBeGreaterThan(0.9); // brown-routing sits still
  });

  it('fires AGAIN once the first rocket dies: the cap RELEASES through the full pipeline', () => {
    // Review found the cap's release half unpinned: nothing proved a second
    // rocket ever flies. Full step() here (not bare stepAi), with an INVINCIBLE
    // player -- ordnance detonates on it harmlessly (bullets.ts), so each rocket
    // dies on arrival, frees the single cap slot, and the 38-tick cooldown then
    // permits the next. Breaks if retired shells stop freeing the cap, or if
    // anything in the pipeline blocks refire after the first success.
    const olive = tank(1, 'olive', { x: 1, y: 9 });
    const player = tank(2, 'player', { x: 6, y: 9 }, { invincible: true });
    let w = createWorld({ walls: [], tanks: [olive, player], spawns: [], lives: 3 });
    w.roundStartTick = FAR_PAST; // straight to the live phase
    const input = { move: { x: 0, y: 0 }, aim: { x: 6, y: 0 }, fire: false, mine: false };
    let fires = 0;
    let maxLive = 0;
    for (let i = 0; i < 150; i++) {
      const r = step(w, input);
      w = r.world;
      fires += r.events.filter((e) => e.type === 'fire' && e.ownerId === 1).length;
      maxLive = Math.max(maxLive, w.bullets.filter((b) => b.alive && b.ownerId === 1).length);
    }
    expect(fires).toBeGreaterThanOrEqual(2); // released and refired
    expect(maxLive).toBe(1); // and the cap held the whole time
  });
});
