import { describe, it, expect } from 'vitest';
import { tealDecision } from './teal';
import { aimJitter, aimLead, bankShot, wanderMove } from './targeting';
import type { Tank, Vec2, Wall, Bullet } from '../types';
import type { World } from '../world';
import { BANK_PREFER_TICKS, AI_AIM_SPREAD, bulletConfig, RICOCHET_BOUNCES } from '../constants';

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
    spawns: [], status: 'playing', lives: 3, roundStartTick: 0, ...over,
  };
}

describe('tealDecision', () => {
  // ---- Brief tests (4, with corrections A/B/C/F applied; updated for the Fix Round 1
  // patience/alternation/mobile changes) ----

  it('takes a direct ricochet shot when line-of-sight is clear', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world({ tanks: [teal, player] });
    const d = tealDecision(w, teal);
    expect(d.fire).toBe(true);
    expect(d.fireType).toBe('ricochet');
    // B: player is stationary (desiredMove {0,0}) -> driveVelocity is (0,0) -> aimLead
    // reduces to direct aim -> turretAngle toward (5,0) from (0,0) is exactly 0, plus
    // this tank/tick's seeded aim jitter.
    expect(d.turretAngle).toBeCloseTo(aimJitter(w, teal, AI_AIM_SPREAD), 6);
    expect(d.nextState).toBe('fire');
    // F: nextTimer on the direct-shot (not-dodging) path. Teal now lays mines too
    // (mirrors Grey): not dodging, cooldown ready, under cap -> mine is true.
    expect(d.mine).toBe(true);
    expect(d.nextTimer).toBe(0);
  });

  it('fires a bank shot when the player is behind cover but a bank path exists', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1), wall(2, -5, 2, 10, 3)]; // blocker + top bounce wall
    const w = world({ tanks: [teal, player], walls });
    const d = tealDecision(w, teal);
    expect(d.fire).toBe(true);
    expect(d.fireType).toBe('ricochet');
    // C: the bounce point is (2,2), so the firing angle from (0,0) is exactly pi/4 (plus
    // this tank/tick's seeded aim jitter).
    // If the direct path to (4,0) had been taken instead, the angle would be 0 (pi/4 != 0),
    // so this also proves lineOfSight(teal, player) was genuinely blocked by the wall(1) blocker
    // and the direct-shot branch was skipped in favour of the bank-shot branch.
    expect(d.turretAngle).toBeCloseTo(Math.PI / 4 + aimJitter(w, teal, AI_AIM_SPREAD), 6); // bounce point (2,2)
    // F: nextTimer on the bank-shot (not-dodging) path. Not dodging, cooldown ready,
    // under cap -> mine is true.
    expect(d.mine).toBe(true);
    expect(d.nextTimer).toBe(0);
  });

  it('applies aim jitter to a direct shot: the final turret angle differs from the un-jittered aimLead result', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world({ tanks: [teal, player] });
    const d = tealDecision(w, teal);
    const unjittered = aimLead(teal.pos, player.pos, { x: 0, y: 0 }, bulletConfig.ricochet.speed);
    expect(d.turretAngle).not.toBe(unjittered);
    expect(Math.abs(d.turretAngle - unjittered)).toBeLessThanOrEqual(AI_AIM_SPREAD + 1e-12);
  });

  it('applies aim jitter to a bank shot: the final turret angle differs from the un-jittered bankShot result', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1), wall(2, -5, 2, 10, 3)];
    const w = world({ tanks: [teal, player], walls });
    const d = tealDecision(w, teal);
    const unjittered = bankShot(teal.pos, player.pos, walls, RICOCHET_BOUNCES);
    expect(unjittered).not.toBeNull();
    expect(d.turretAngle).not.toBe(unjittered);
    expect(Math.abs(d.turretAngle - (unjittered as number))).toBeLessThanOrEqual(AI_AIM_SPREAD + 1e-12);
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
    // F: nextTimer on the reposition (not-dodging) path. Not dodging, cooldown ready,
    // under cap -> mine is true.
    expect(d.mine).toBe(true);
    expect(d.nextTimer).toBe(0);
  });

  it('dodges and fires simultaneously (aggressive, swapped from Grey): an incoming bullet overrides wander but does not suppress fire', () => {
    const teal = tank(1, 'teal', { x: 3, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 }); // clear line-of-sight, no walls
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // straight at teal
    const d = tealDecision(world({ tanks: [teal, player], bullets: [b] }), teal);
    // Teal is aggressive now: dodging does NOT hold fire, even with a threat present.
    expect(d.fire).toBe(true);
    // A: pin the dodge SIDE, not just that x ~ 0.
    // teal at (3,0), bullet at (0,0) heading +x: rel = (3,0), dir = (1,0),
    // perpA = (0,1), perpB = (0,-1). vdot(rel, perpA) = 0 >= 0 -> perpA = (0,1).
    expect(d.desiredMove.x).toBeCloseTo(0, 6);
    expect(d.desiredMove.y).toBeCloseTo(1, 6);
    expect(d.mine).toBe(false); // mid-dodge -> !avoid term suppresses the mine
    // Nothing consumes tank.aiTimer for Teal anymore -> nextTimer is always 0.
    expect(d.nextTimer).toBe(0);
  });

  // ---- No live player (D) ----

  it('D1: no player tank at all -> no fire, but Teal still WANDERS (mobile, spec §7)', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 }, { turretAngle: 1.234 });
    const d = tealDecision(world({ tanks: [teal] }), teal);
    expect(d.fire).toBe(false);
    // Freezing solid at {0,0} made Teal a stationary target between rounds and while the
    // player was respawning; Grey wanders in the same situation and so must Teal.
    expect(Math.hypot(d.desiredMove.x, d.desiredMove.y)).toBeCloseTo(1, 6);
    expect(d.nextState).toBe('idle');
    expect(d.turretAngle).toBe(1.234);
    expect(d.mine).toBe(false);
    expect(d.nextTimer).toBe(0);
  });

  it('D2: player exists but is not alive -> no fire, but Teal still wanders', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 }, { turretAngle: 1.234 });
    const deadPlayer = tank(2, 'player', { x: 5, y: 0 }, { alive: false });
    const d = tealDecision(world({ tanks: [teal, deadPlayer] }), teal);
    expect(d.fire).toBe(false);
    expect(Math.hypot(d.desiredMove.x, d.desiredMove.y)).toBeCloseTo(1, 6);
    expect(d.nextState).toBe('idle');
    expect(d.turretAngle).toBe(1.234);
    expect(d.mine).toBe(false);
    expect(d.nextTimer).toBe(0);
  });

  it('D3: the no-player wander heading is the SAME one wanderMove gives (not a fresh roll)', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const w = world({ tanks: [teal], tick: 0 });
    expect(tealDecision(w, teal).desiredMove).toEqual(wanderMove(w, teal));
  });

  it('D4: a dodge still overrides the no-player wander', () => {
    const teal = tank(1, 'teal', { x: 3, y: 0.3 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 });
    const d = tealDecision(world({ tanks: [teal], bullets: [b] }), teal);
    expect(d.desiredMove.x).toBeCloseTo(0, 6);
    expect(d.desiredMove.y).toBeCloseTo(1, 6);
  });

  // ---- Minor 5: off-axis dodge (pins the actual "dodge to the side you sit on" rule,
  // not just the >= 0 tie-break at rel·perpA == 0).
  // A LIVE PLAYER is mandatory in these fixtures: without one, tealDecision takes its
  // no-player early return and every assertion below is satisfied vacuously by a code
  // path that never reaches the targeting logic at all. ----

  it('off-axis dodge: teal above the bullet axis dodges to +y (the side it already sits on)', () => {
    const teal = tank(1, 'teal', { x: 3, y: 0.3 });
    const player = tank(2, 'player', { x: 8, y: 0.3 }); // clear LOS -> the real firing path runs
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 });
    const d = tealDecision(world({ tanks: [teal, player], bullets: [b] }), teal);
    expect(d.fire).toBe(true); // Teal is aggressive: it dodges AND shoots in the same tick
    expect(d.desiredMove.y).toBeCloseTo(1, 6);
  });

  it('off-axis dodge: teal below the bullet axis dodges to -y (the side it already sits on)', () => {
    const teal = tank(1, 'teal', { x: 3, y: -0.3 });
    const player = tank(2, 'player', { x: 8, y: -0.3 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 });
    const d = tealDecision(world({ tanks: [teal, player], bullets: [b] }), teal);
    expect(d.fire).toBe(true);
    expect(d.desiredMove.y).toBeCloseTo(-1, 6);
  });

  // ---- Friendly fire (same gate as brown/grey): resolveBulletHits kills any non-owner
  // tank the shell touches, and lineOfSight only ever tested walls. ----

  it('does not take a direct shot with a teammate on the line, and banks instead', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const mate = tank(3, 'brown', { x: 2, y: 0 }); // on the direct line to the player
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(2, -5, 2, 10, 3)]; // bounce surface only; direct LOS is wall-clear
    const w = world({ tanks: [teal, mate, player], walls, tick: BANK_PREFER_TICKS }); // direct-preferred
    const d = tealDecision(w, teal);
    expect(d.fire).toBe(true);
    // Fell through to the bank path (bounce point (2,2) -> pi/4), not the direct angle 0.
    expect(d.turretAngle).toBeCloseTo(Math.PI / 4 + aimJitter(w, teal, AI_AIM_SPREAD), 6);
  });

  it('repositions when a teammate blocks the only shot it has', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const mate = tank(3, 'brown', { x: 2, y: 0 });
    const player = tank(2, 'player', { x: 4, y: 0 });
    const d = tealDecision(world({ tanks: [teal, mate, player] }), teal); // no walls -> no bank
    expect(d.fire).toBe(false);
    expect(d.nextState).toBe('reposition');
  });

  // ---- Minor 6: pin the reposition wander heading via bucket determinism, so the
  // wanderMove call site is test-verified rather than just structurally present ----

  it('reposition wander: same bucket (ticks 0 and 29) yields the same heading', () => {
    const teal0 = tank(1, 'teal', { x: 0, y: 0 });
    const teal29 = tank(1, 'teal', { x: 0, y: 0 });
    const player0 = tank(2, 'player', { x: 4, y: 0 });
    const player29 = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1)]; // blocker only -> always reposition
    const d0 = tealDecision(world({ tanks: [teal0, player0], walls, tick: 0 }), teal0);
    const d29 = tealDecision(world({ tanks: [teal29, player29], walls, tick: 29 }), teal29);
    expect(d0.nextState).toBe('reposition');
    expect(d29.nextState).toBe('reposition');
    expect(d29.desiredMove.x).toBeCloseTo(d0.desiredMove.x, 12);
    expect(d29.desiredMove.y).toBeCloseTo(d0.desiredMove.y, 12);
  });

  it('reposition wander: different bucket (ticks 0 and 30) yields a different heading', () => {
    const teal0 = tank(1, 'teal', { x: 0, y: 0 });
    const teal30 = tank(1, 'teal', { x: 0, y: 0 });
    const player0 = tank(2, 'player', { x: 4, y: 0 });
    const player30 = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1)];
    const d0 = tealDecision(world({ tanks: [teal0, player0], walls, tick: 0 }), teal0);
    const d30 = tealDecision(world({ tanks: [teal30, player30], walls, tick: 30 }), teal30);
    const dx = Math.abs(d0.desiredMove.x - d30.desiredMove.x);
    const dy = Math.abs(d0.desiredMove.y - d30.desiredMove.y);
    expect(dx > 1e-6 || dy > 1e-6).toBe(true);
  });

  // ---- Important 3: Teal is mobile (spec §7) -- wander is the baseline move even while
  // firing, not a hardcoded {0,0} ----

  it('wanders while firing directly (mobile, not a stationary turret)', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = tealDecision(world({ tanks: [teal, player] }), teal);
    expect(d.fire).toBe(true);
    expect(Math.hypot(d.desiredMove.x, d.desiredMove.y)).toBeCloseTo(1, 6);
  });

  it('wanders while firing a bank shot (mobile, not a stationary turret)', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1), wall(2, -5, 2, 10, 3)];
    const d = tealDecision(world({ tanks: [teal, player], walls }), teal);
    expect(d.fire).toBe(true);
    expect(Math.hypot(d.desiredMove.x, d.desiredMove.y)).toBeCloseTo(1, 6);
  });

  // ---- Important 2 (user decision): alternate between bank-preferred and
  // direct-preferred targeting on a deterministic tick-bucket cycle ----

  it('alternates shot preference deterministically: bank-preferred vs direct-preferred pick different angles when both a direct shot and a bank shot exist', () => {
    const player = tank(2, 'player', { x: 4, y: 0 });
    // Only the top bounce wall, no blocker: the direct line y=0 never enters the wall's
    // y:[2,3] span, so lineOfSight is clear; the wall's bottom face also yields a valid
    // single-bounce path (mirror of (4,0) across y=2 is (4,4); the muzzle->mirror ray
    // crosses y=2 at x=2, inside the wall's x:[-5,10] span, entering through the bottom
    // face, matching FACE_NORMALS[2] = (0,-1); both losIgnoring legs are trivially clear
    // since this is the only wall in the fixture). So both options are genuinely available
    // -- this is what makes the test discriminate real alternation from coincidence.
    const walls = [wall(2, -5, 2, 10, 3)];
    const teal0 = tank(1, 'teal', { x: 0, y: 0 });
    const w0 = world({ tanks: [teal0, player], walls, tick: 0 }); // preferBank: floor(0/120)=0, even
    const d0 = tealDecision(w0, teal0);
    const teal120 = tank(1, 'teal', { x: 0, y: 0 });
    const w120 = world({ tanks: [teal120, player], walls, tick: BANK_PREFER_TICKS }); // floor(120/120)=1, odd -> direct-preferred
    const d120 = tealDecision(w120, teal120);
    expect(d0.fire).toBe(true);
    expect(d120.fire).toBe(true);
    // tick 0: bank-preferred -> bank path taken, plus this tick's seeded aim jitter
    expect(d0.turretAngle).toBeCloseTo(Math.PI / 4 + aimJitter(w0, teal0, AI_AIM_SPREAD), 6);
    // tick 120: direct-preferred -> direct shot taken, plus this tick's seeded aim jitter
    expect(d120.turretAngle).toBeCloseTo(aimJitter(w120, teal120, AI_AIM_SPREAD), 6);
  });

  it('fallthrough: bank-preferred tick still takes the direct shot when no bank path exists', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world({ tanks: [teal, player], tick: 0 }); // preferBank true, no walls -> bank impossible
    const d = tealDecision(w, teal);
    expect(d.fire).toBe(true);
    expect(d.turretAngle).toBeCloseTo(aimJitter(w, teal, AI_AIM_SPREAD), 6);
  });

  it('fallthrough: direct-preferred tick still takes the bank shot when line-of-sight is blocked', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1), wall(2, -5, 2, 10, 3)]; // blocker + bounce wall
    const w = world({ tanks: [teal, player], walls, tick: BANK_PREFER_TICKS }); // direct-preferred, LOS blocked
    const d = tealDecision(w, teal);
    expect(d.fire).toBe(true);
    expect(d.turretAngle).toBeCloseTo(Math.PI / 4 + aimJitter(w, teal, AI_AIM_SPREAD), 6);
  });

  // ---- Important 4: pin the driveVelocity fix with a diagonal-move fixture, so this
  // test would fail against the reverted vscale(player.desiredMove, TANK_SPEED) bug ----

  it('leads a diagonally-moving player using the CLAMPED drive velocity, not the raw desiredMove', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    // desiredMove {1,1} has raw length sqrt(2) (~1.41421356); driveDirection clamps this to
    // unit length before scaling by TANK_SPEED, so driveVelocity is (3/sqrt2, 3/sqrt2), NOT
    // vscale({1,1}, 3) = (3,3). See report for the full hand-derived intercept arithmetic.
    const player = tank(2, 'player', { x: 5, y: 0 }, { desiredMove: { x: 1, y: 1 } });
    const w = world({ tanks: [teal, player] });
    const d = tealDecision(w, teal);
    expect(d.fire).toBe(true);
    expect(d.turretAngle).toBeCloseTo(0.36136712390670783 + aimJitter(w, teal, AI_AIM_SPREAD), 6);
  });

  // ---- Teal now lays mines too (mirrors Grey's rule, spec §7 "avoids its own mines").
  // A player is included in every fixture below because tealDecision's no-player early
  // return hardcodes mine:false before the real mine-eligibility check ever runs. ----

  it('roaming, cooldown ready, no active mines -> mine is true', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 }); // not dodging
    const d = tealDecision(world({ tanks: [teal, player] }), teal);
    expect(d.mine).toBe(true);
  });

  it('mineCooldown > 0 -> mine is false', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 }, { mineCooldown: 0.3 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = tealDecision(world({ tanks: [teal, player] }), teal);
    expect(d.mine).toBe(false);
  });

  it('at MINE_CAP -> mine is false', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 }, { activeMineIds: [70, 71] }); // length 2 == MINE_CAP
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = tealDecision(world({ tanks: [teal, player] }), teal);
    expect(d.mine).toBe(false);
  });

  it('while dodging an incoming bullet -> mine is false (pins the !avoid term)', () => {
    const teal = tank(1, 'teal', { x: 3, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // straight at teal -> dangerAvoidMove is non-null
    const d = tealDecision(world({ tanks: [teal, player], bullets: [b] }), teal);
    expect(d.mine).toBe(false);
    // Sanity check that this fixture really is a dodge, so this isn't a false-negative test.
    expect(Math.abs(d.desiredMove.y)).toBeCloseTo(1, 6);
  });

  it('cap boundary is a strict "<", not "<=" (below MINE_CAP -> true, at MINE_CAP -> false)', () => {
    const below = tank(1, 'teal', { x: 0, y: 0 }, { activeMineIds: [70] }); // 1 < MINE_CAP(2)
    const at = tank(1, 'teal', { x: 0, y: 0 }, { activeMineIds: [70, 71] }); // 2 == MINE_CAP(2)
    const playerBelow = tank(2, 'player', { x: 5, y: 0 });
    const playerAt = tank(2, 'player', { x: 5, y: 0 });
    expect(tealDecision(world({ tanks: [below, playerBelow] }), below).mine).toBe(true);
    expect(tealDecision(world({ tanks: [at, playerAt] }), at).mine).toBe(false);
  });
});
