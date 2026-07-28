import { describe, it, expect } from 'vitest';
import { greyDecision } from './grey';
import { aimJitter, aimLead } from './targeting';
import type { Tank, Vec2, Wall, Bullet, Mine } from '../types';
import type { World } from '../world';
import { DODGE_PATIENCE_TICKS, AI_AIM_SPREAD, AI_MINE_TACTICAL_RADIUS, bulletConfig } from '../constants';

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
function mine(id: number, ownerId: number, pos: Vec2, over: Partial<Mine> = {}): Mine {
  return { id, ownerId, pos, timer: 0, armed: true, detonated: false, ...over };
}
function world(over: Partial<World>): World {
  return {
    tick: 0, nextId: 100, seed: 7, tanks: [], bullets: [], mines: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: 0, ...over,
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

  it('applies aim jitter: the final turret angle differs from the un-jittered aimLead result', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world({ tanks: [grey, player] });
    const d = greyDecision(w, grey);
    const unjittered = aimLead(grey.pos, player.pos, { x: 0, y: 0 }, bulletConfig.normal.speed);
    expect(d.turretAngle).not.toBe(unjittered);
    expect(Math.abs(d.turretAngle - unjittered)).toBeLessThanOrEqual(AI_AIM_SPREAD + 1e-12);
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

  it('F: nextTimer is always 0 on the fire path and the no-player path (mine held off via cooldown, tested separately)', () => {
    // mineCooldown > 0 isolates this test to nextTimer/mine-gating-is-off, independent
    // of the mine-drop eligibility logic itself, which has its own dedicated tests below.
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { mineCooldown: 1 });
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

  // ---- Grey mine-dropping (fix round 2: user decision, spec §7 "avoids its own mines") ----

  it('H1: roaming, cooldown ready, no active mines, player in range -> mine is true', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(9, 'player', { x: 3, y: 0 }); // inside AI_MINE_TACTICAL_RADIUS
    const w = world({ tanks: [grey, player] }); // no bullets/mines -> not dodging
    const d = greyDecision(w, grey);
    expect(d.mine).toBe(true);
  });

  it('H1b: does not lay a mine with the player far away, however ready the cooldown is', () => {
    // Dropping "because the cooldown allows it" is what turned a roamer alone in a corner
    // into a tank standing in its own minefield. A mine that far from the player cannot
    // threaten anything before its 3-second fuse expires.
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(9, 'player', { x: 12, y: 0 });
    const d = greyDecision(world({ tanks: [grey, player] }), grey);
    expect(d.mine).toBe(false);
  });

  it('H1c: the tactical radius is measured from the drop point, inclusive', () => {
    const inside = tank(1, 'grey', { x: 0, y: 0 });
    const outside = tank(1, 'grey', { x: 0, y: 0 });
    const near = tank(9, 'player', { x: AI_MINE_TACTICAL_RADIUS - 1e-6, y: 0 });
    const far = tank(9, 'player', { x: AI_MINE_TACTICAL_RADIUS + 1e-6, y: 0 });
    expect(greyDecision(world({ tanks: [inside, near] }), inside).mine).toBe(true);
    expect(greyDecision(world({ tanks: [outside, far] }), outside).mine).toBe(false);
  });

  it('H1d: a dead player is nobody to mine against', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const corpse = tank(9, 'player', { x: 3, y: 0 }, { alive: false });
    expect(greyDecision(world({ tanks: [grey, corpse] }), grey).mine).toBe(false);
  });

  it('H1e: still allows a back-to-back burst while the player stays close', () => {
    // The point of the gate is to stop aimless littering, not to forbid deliberately
    // mining ground the player is contesting. With the player in range a tank may lay up
    // to MINE_CAP mines in succession.
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { activeMineIds: [70] });
    const player = tank(9, 'player', { x: 3, y: 0 });
    expect(greyDecision(world({ tanks: [grey, player] }), grey).mine).toBe(true);
  });

  it('H2: mineCooldown > 0 -> mine is false', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { mineCooldown: 0.3 });
    const w = world({ tanks: [grey] });
    const d = greyDecision(w, grey);
    expect(d.mine).toBe(false);
  });

  it('H3: at MINE_CAP -> mine is false', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { activeMineIds: [70, 71] }); // length 2 == MINE_CAP
    const w = world({ tanks: [grey] });
    const d = greyDecision(w, grey);
    expect(d.mine).toBe(false);
  });

  it('H4: while dodging an incoming bullet -> mine is false (pins the !avoid term)', () => {
    const grey = tank(1, 'grey', { x: 3, y: 0 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // straight at grey -> dangerAvoidMove is non-null
    const w = world({ tanks: [grey], bullets: [b] });
    const d = greyDecision(w, grey);
    expect(d.mine).toBe(false);
    // Sanity check that this fixture really is a dodge (would be a false-negative
    // test otherwise): if this fails, H4 above isn't exercising the !avoid branch.
    expect(Math.abs(d.desiredMove.y)).toBeCloseTo(1, 6);
  });

  it('H5: cap boundary is a strict "<", not "<=" (below MINE_CAP -> true, at MINE_CAP -> false)', () => {
    const below = tank(1, 'grey', { x: 0, y: 0 }, { activeMineIds: [70] }); // 1 < MINE_CAP(2)
    const at = tank(1, 'grey', { x: 0, y: 0 }, { activeMineIds: [70, 71] }); // 2 == MINE_CAP(2)
    const player = () => tank(9, 'player', { x: 3, y: 0 }); // in range, so the cap is what decides
    expect(greyDecision(world({ tanks: [below, player()] }), below).mine).toBe(true);
    expect(greyDecision(world({ tanks: [at, player()] }), at).mine).toBe(false);
  });

  // ---- Grey is now cautious (swapped from Teal): dodge suppression has a patience
  // limit, moved verbatim in behaviour from tealDecision's old DODGE_PATIENCE_TICKS logic.
  // The cap is mandatory: without it a player who just keeps shooting (FIRE_COOLDOWN 0.4s
  // < THREAT_HORIZON 1.0s) would suppress Grey's fire forever. ----

  it('dodges incoming fire instead of shooting while patience has not run out, even though the shot is otherwise clear', () => {
    const grey = tank(1, 'grey', { x: 3, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 }); // clear LOS, no walls
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // straight at grey
    const d = greyDecision(world({ tanks: [grey, player], bullets: [b] }), grey);
    expect(d.fire).toBe(false);
    // Still the dodge vector (signed +y, same tie-break as the earlier dodge test).
    expect(d.desiredMove.x).toBeCloseTo(0, 6);
    expect(d.desiredMove.y).toBeCloseTo(1, 6);
    expect(d.mine).toBe(false);
    // aiTimer defaults to 0, so dodgeTicks = 0 + 1 = 1, which is < DODGE_PATIENCE_TICKS
    // -> holds fire, and nextTimer reports the running count.
    expect(d.nextTimer).toBe(1);
  });

  it('dodging AT/above the patience threshold fires anyway while still dodging, and resets nextTimer', () => {
    const grey = tank(1, 'grey', { x: 3, y: 0 }, { aiTimer: DODGE_PATIENCE_TICKS });
    const player = tank(2, 'player', { x: 5, y: 0 }); // clear LOS, no walls, stationary
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // still an active threat
    const w = world({ tanks: [grey, player], bullets: [b] });
    const d = greyDecision(w, grey);
    expect(d.fire).toBe(true);
    // direct shot, player stationary, plus this tank/tick's seeded aim jitter
    expect(d.turretAngle).toBeCloseTo(aimJitter(w, grey, AI_AIM_SPREAD), 6);
    // Still dodging: desiredMove is the dodge vector (signed +y), not the wander heading.
    expect(d.desiredMove.x).toBeCloseTo(0, 6);
    expect(d.desiredMove.y).toBeCloseTo(1, 6);
    expect(d.mine).toBe(false);
    expect(d.nextTimer).toBe(0); // firing while dodging resets the cautious window
  });

  it('dodge patience boundary is a strict "<", not "<=" (dodgeTicks == threshold fires, one less still holds)', () => {
    const holding = tank(1, 'grey', { x: 3, y: 0 }, { aiTimer: DODGE_PATIENCE_TICKS - 2 }); // dodgeTicks = threshold - 1
    const firing = tank(1, 'grey', { x: 3, y: 0 }, { aiTimer: DODGE_PATIENCE_TICKS - 1 }); // dodgeTicks = threshold
    const player = tank(2, 'player', { x: 5, y: 0 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 });
    const dHold = greyDecision(world({ tanks: [holding, player], bullets: [b] }), holding);
    const dFire = greyDecision(world({ tanks: [firing, player], bullets: [b] }), firing);
    expect(dHold.fire).toBe(false);
    expect(dHold.nextTimer).toBe(DODGE_PATIENCE_TICKS - 1);
    expect(dFire.fire).toBe(true);
    expect(dFire.nextTimer).toBe(0);
    // Confirm the fire-while-dodging tick is genuinely still dodging, not a fallback to wander.
    expect(dFire.desiredMove.x).toBeCloseTo(0, 6);
    expect(dFire.desiredMove.y).toBeCloseTo(1, 6);
  });

  // ---- Friendly fire (see brown.test.ts for the same gate): lineOfSight only tests
  // walls, but resolveBulletHits kills any non-owner tank the shell touches. ----

  it('holds fire when a teammate is standing on the firing line', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const mate = tank(3, 'brown', { x: 2.5, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = greyDecision(world({ tanks: [grey, mate, player] }), grey);
    expect(d.fire).toBe(false);
    // The turret still tracks the player -- only the trigger is held.
    expect(d.turretAngle).toBeCloseTo(aimJitter(world({ tanks: [grey, mate, player] }), grey, AI_AIM_SPREAD), 6);
  });

  it('fires when the teammate is well clear of the firing line', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const mate = tank(3, 'brown', { x: 2.5, y: 4 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    expect(greyDecision(world({ tanks: [grey, mate, player] }), grey).fire).toBe(true);
  });

  it('nextTimer is 0 when not dodging, regardless of tank.aiTimer', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { aiTimer: 99 });
    const player = tank(2, 'player', { x: 5, y: 0 }); // no bullets -> not dodging
    const d = greyDecision(world({ tanks: [grey, player] }), grey);
    expect(d.fire).toBe(true);
    expect(d.nextTimer).toBe(0);
  });

  // ---- Own-mine fire suppression (regression) ----

  it('takes the shot while stepping away from its OWN mine', () => {
    // Grey drops a mine only when the player is close enough to be threatened,
    // which puts it inside its own AI_MINE_FLEE_RADIUS with a clear shot. Gating
    // fire on `avoid` rather than on incoming fire gagged the trigger there for
    // up to DODGE_PATIENCE_TICKS, for much of Grey's life.
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { activeMineIds: [50] });
    const player = tank(2, 'player', { x: 8, y: 0 });
    const w = world({
      tanks: [grey, player],
      mines: [mine(50, 1, { x: 0, y: 2 })], // 2.0 away, inside the 3.25 flee radius
      bullets: [],
    });
    expect(greyDecision(w, grey).fire).toBe(true);
  });

  it('still walks away from that mine while it shoots', () => {
    // The fix must not stop Grey fleeing: detonateMine kills every tank in the
    // blast with no owner exemption, so its own mine really can kill it.
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { activeMineIds: [50] });
    const player = tank(2, 'player', { x: 8, y: 0 });
    const w = world({ tanks: [grey, player], mines: [mine(50, 1, { x: 0, y: 2 })] });
    const d = greyDecision(w, grey);
    // Moving away from a mine at +y means a non-positive y component.
    expect(d.desiredMove.y).toBeLessThanOrEqual(0);
    expect(Math.hypot(d.desiredMove.x, d.desiredMove.y)).toBeGreaterThan(0);
  });

  it('still holds fire when the thing to dodge is an actual bullet', () => {
    // The negative control for the change: suppression is now tied to incoming
    // fire, so it must still fire (as in: not fire) exactly as before here.
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 8, y: 0 });
    const incoming = bullet(9, 2, { x: 3, y: 0 }, { x: -bulletConfig.normal.speed, y: 0 });
    const w = world({ tanks: [grey, player], bullets: [incoming] });
    expect(greyDecision(w, grey).fire).toBe(false);
  });

  it("a mine near Grey does not start the bullet-patience counter", () => {
    // nextTimer is the patience counter. A mine must leave it at 0, or a later
    // real dodge would inherit a head start and give up early.
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { activeMineIds: [50], aiTimer: 0 });
    const player = tank(2, 'player', { x: 8, y: 0 });
    const w = world({ tanks: [grey, player], mines: [mine(50, 1, { x: 0, y: 2 })] });
    expect(greyDecision(w, grey).nextTimer).toBe(0);
  });
});
