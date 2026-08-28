import { describe, it, expect } from 'vitest';
import { tealDecision } from './teal';
import { aimJitter, aimLead, bankShot, wanderMove, profileAimSpread } from './targeting';
import type { Tank, Vec2, Wall, Bullet } from '../types';
import type { World } from '../world';
import { configFor, type ResolvedTankConfig } from '../config';
import { bulletConfig, RICOCHET_BOUNCES, TICK_HZ } from '../constants';

// The spread these fixtures' expected angles float with: teal's PROFILE-derived
// jitter (aimAccuracy pass), not the global anchor.
const TEAL_SPREAD = profileAimSpread(configFor('teal'));

function tank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}
// The shot plan these fixtures drive (issue #332). It replaced `tick: BANK_PREFER_TICKS`
// as the way a test says "direct-preferred": the preference is per-tank state now, so a
// tick no longer selects anything and a fixture that still set one would be asserting
// against whatever the default happens to be. Ticks are deliberately mid-window (not 1),
// so `lapsed` is false and these fixtures cannot also trip the turnover gate.
function held(plan: 'bank' | 'direct'): Partial<Tank> {
  return { aiShotPlan: plan, aiShotPlanTicks: 60 };
}

function bullet(id: number, ownerId: number, pos: Vec2, vel: Vec2): Bullet {
  return { id, ownerId, type: 'normal', pos, vel, bouncesLeft: 1, alive: true };
}
function wall(id: number, minX: number, minY: number, maxX: number, maxY: number): Wall {
  return { id, aabb: { minX, minY, maxX, maxY }, kind: 'solid', destroyed: false };
}
function world(over: Partial<World>): World {
  return {
    tick: 0, nextId: 100, seed: 3, tanks: [], bullets: [], mines: [], blasts: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: 0, unarmedTrigger: 'none' as const,
    corpseBlocksShells: false, muzzleClearsTanks: true, coopAttempts: true, mode: 'campaign-coop', friendlyFire: false, ...over,
  };
}

// Mine-DRAW isolation: since the minePlacementChance magnitude became a per-bucket
// draw (mineInclination), EVERY fixture that tests one of the OTHER mine gates --
// true side (cap available, roaming, cooldown ready) AND false side (!avoid,
// cooldown held, at cap) -- injects chance 1, so the draw can neither grant nor
// mask the gate under test. This file's seed-3 draw (0.5521) sits above teal's
// shipped 0.3: without MINE_SURE the false-side tests passed via the DRAW's
// short-circuit and deleting the gate under test left them green (review, PR #58).
// The draw itself is tested in profile.test.ts, where the chance is the variable.
const MINE_SURE = { ...configFor('teal'), ai: { ...configFor('teal').ai, minePlacementChance: 1 } };

describe('tealDecision', () => {
  // ---- Brief tests (4, with corrections A/B/C/F applied; updated for the Fix Round 1
  // patience/alternation/mobile changes) ----

  it('takes a direct ricochet shot when line-of-sight is clear', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world({ tanks: [teal, player] });
    const d = tealDecision(w, teal, MINE_SURE);
    expect(d.fire).toBe(true);
    expect(d.fireType).toBe('ricochet');
    // B: player is stationary (desiredMove {0,0}) -> driveVelocity is (0,0) -> aimLead
    // reduces to direct aim -> turretAngle toward (5,0) from (0,0) is exactly 0, plus
    // this tank/tick's seeded aim jitter.
    expect(d.turretAngle).toBeCloseTo(aimJitter(w, teal, TEAL_SPREAD), 6);
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
    const d = tealDecision(w, teal, MINE_SURE);
    expect(d.fire).toBe(true);
    expect(d.fireType).toBe('ricochet');
    // C: the bounce point is (2,2), so the firing angle from (0,0) is exactly pi/4 (plus
    // this tank/tick's seeded aim jitter).
    // If the direct path to (4,0) had been taken instead, the angle would be 0 (pi/4 != 0),
    // so this also proves lineOfSight(teal, player) was genuinely blocked by the wall(1) blocker
    // and the direct-shot branch was skipped in favour of the bank-shot branch.
    expect(d.turretAngle).toBeCloseTo(Math.PI / 4 + aimJitter(w, teal, TEAL_SPREAD), 6); // bounce point (2,2)
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
    expect(Math.abs(d.turretAngle - unjittered)).toBeLessThanOrEqual(TEAL_SPREAD + 1e-12);
  });

  it('applies aim jitter to a bank shot: the final turret angle differs from the un-jittered bankShot result', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1), wall(2, -5, 2, 10, 3)];
    const w = world({ tanks: [teal, player], walls });
    const d = tealDecision(w, teal, MINE_SURE);
    const unjittered = bankShot(teal.pos, player.pos, walls, RICOCHET_BOUNCES);
    expect(unjittered).not.toBeNull();
    expect(d.turretAngle).not.toBe(unjittered);
    expect(Math.abs(d.turretAngle - (unjittered as number))).toBeLessThanOrEqual(TEAL_SPREAD + 1e-12);
  });

  it('repositions (no fire) when neither a direct nor a bank shot exists', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1)]; // only the blocker, no bounce surface
    const d = tealDecision(world({ tanks: [teal, player], walls }), teal, MINE_SURE);
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
    const d = tealDecision(world({ tanks: [teal, player], bullets: [b] }), teal, MINE_SURE);
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
    const d = tealDecision(world({ tanks: [teal] }), teal, MINE_SURE);
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
    const d = tealDecision(world({ tanks: [teal, deadPlayer] }), teal, MINE_SURE);
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
    const teal = tank(1, 'teal', { x: 0, y: 0 }, held('direct'));
    const mate = tank(3, 'brown', { x: 2, y: 0 }); // on the direct line to the player
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(2, -5, 2, 10, 3)]; // bounce surface only; direct LOS is wall-clear
    const w = world({ tanks: [teal, mate, player], walls }); // plan: direct-preferred
    const d = tealDecision(w, teal);
    expect(d.fire).toBe(true);
    // Fell through to the bank path (bounce point (2,2) -> pi/4), not the direct angle 0.
    expect(d.turretAngle).toBeCloseTo(Math.PI / 4 + aimJitter(w, teal, TEAL_SPREAD), 6);
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

  // ---- Important 2 (user decision): both bank-preferred and direct-preferred targeting
  // occur, selected by the tank's HELD plan rather than a global tick cycle (issue #332) ----

  it('the held shot plan selects the angle: bank-preferred vs direct-preferred pick different angles when both a direct shot and a bank shot exist', () => {
    const player = tank(2, 'player', { x: 4, y: 0 });
    // Only the top bounce wall, no blocker: the direct line y=0 never enters the wall's
    // y:[2,3] span, so lineOfSight is clear; the wall's bottom face also yields a valid
    // single-bounce path (mirror of (4,0) across y=2 is (4,4); the muzzle->mirror ray
    // crosses y=2 at x=2, inside the wall's x:[-5,10] span, entering through the bottom
    // face, matching FACE_NORMALS[2] = (0,-1); both losIgnoring legs are trivially clear
    // since this is the only wall in the fixture). So both options are genuinely available
    // -- this is what makes the test discriminate real alternation from coincidence.
    const walls = [wall(2, -5, 2, 10, 3)];
    // BOTH worlds sit on tick 0 with the same tank id, so the seeded aim jitter is
    // identical in the two branches and the HELD PLAN is the only independent variable.
    const tealBank = tank(1, 'teal', { x: 0, y: 0 }, held('bank'));
    const wBank = world({ tanks: [tealBank, player], walls });
    const dBank = tealDecision(wBank, tealBank);
    const tealDirect = tank(1, 'teal', { x: 0, y: 0 }, held('direct'));
    const wDirect = world({ tanks: [tealDirect, player], walls });
    const dDirect = tealDecision(wDirect, tealDirect);
    expect(dBank.fire).toBe(true);
    expect(dDirect.fire).toBe(true);
    // plan 'bank': bank path taken, plus this tick's seeded aim jitter
    expect(dBank.turretAngle).toBeCloseTo(Math.PI / 4 + aimJitter(wBank, tealBank, TEAL_SPREAD), 6);
    // plan 'direct': direct shot taken, plus this tick's seeded aim jitter
    expect(dDirect.turretAngle).toBeCloseTo(aimJitter(wDirect, tealDirect, TEAL_SPREAD), 6);
    // The two angles genuinely differ, so neither assertion above could pass by both
    // branches collapsing onto the same default -- the vacuity the tick fixtures risked.
    expect(dBank.turretAngle).not.toBeCloseTo(dDirect.turretAngle as number, 6);
    // Solvable on both sides, so the window re-arms on the plan it held: no turnover.
    expect(dBank.nextShotPlan).toBe('bank');
    expect(dDirect.nextShotPlan).toBe('direct');
  });

  it('fallthrough: a bank-preferred plan still takes the direct shot when no bank path exists', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 }, held('bank'));
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world({ tanks: [teal, player] }); // plan: bank-preferred, no walls -> bank impossible
    const d = tealDecision(w, teal);
    expect(d.fire).toBe(true);
    expect(d.turretAngle).toBeCloseTo(aimJitter(w, teal, TEAL_SPREAD), 6);
  });

  it('fallthrough: a direct-preferred plan still takes the bank shot when line-of-sight is blocked', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 }, held('direct'));
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1), wall(2, -5, 2, 10, 3)]; // blocker + bounce wall
    const w = world({ tanks: [teal, player], walls }); // plan: direct-preferred, LOS blocked
    const d = tealDecision(w, teal);
    expect(d.fire).toBe(true);
    expect(d.turretAngle).toBeCloseTo(Math.PI / 4 + aimJitter(w, teal, TEAL_SPREAD), 6);
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
    const d = tealDecision(w, teal, MINE_SURE);
    expect(d.fire).toBe(true);
    // Closed-form intercept, rederived for the 2026-07-31 ricochet speed of 4:
    // a = |v|^2 - s^2 = 9 - 16, b = 2(rel.v) = 30/sqrt2, c = |rel|^2 = 25;
    // t = 3.93748952..., aim = atan2(v_y t, 5 + v_x t) = 0.55898986... (was
    // 0.36136712 at the spec's speed 6).
    expect(d.turretAngle).toBeCloseTo(0.5589898660249855 + aimJitter(w, teal, TEAL_SPREAD), 6);
  });

  // ---- Teal now lays mines too (mirrors Grey's rule, spec §7 "avoids its own mines").
  // A player is included in every fixture below because tealDecision's no-player early
  // return hardcodes mine:false before the real mine-eligibility check ever runs. ----

  it('roaming, cooldown ready, no active mines -> mine is true', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 }); // not dodging
    const d = tealDecision(world({ tanks: [teal, player] }), teal, MINE_SURE);
    expect(d.mine).toBe(true);
  });

  it('mineCooldown > 0 -> mine is false', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 }, { mineCooldown: 0.3 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = tealDecision(world({ tanks: [teal, player] }), teal, MINE_SURE);
    expect(d.mine).toBe(false);
  });

  it('at MINE_CAP -> mine is false', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 }, { activeMineIds: [70, 71] }); // length 2 == MINE_CAP
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = tealDecision(world({ tanks: [teal, player] }), teal, MINE_SURE);
    expect(d.mine).toBe(false);
  });

  it('while dodging an incoming bullet -> mine is false (pins the !avoid term)', () => {
    const teal = tank(1, 'teal', { x: 3, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // straight at teal -> dangerAvoidMove is non-null
    const d = tealDecision(world({ tanks: [teal, player], bullets: [b] }), teal, MINE_SURE);
    expect(d.mine).toBe(false);
    // Sanity check that this fixture really is a dodge, so this isn't a false-negative test.
    expect(Math.abs(d.desiredMove.y)).toBeCloseTo(1, 6);
  });

  it('cap boundary is a strict "<", not "<=" (below MINE_CAP -> true, at MINE_CAP -> false)', () => {
    const below = tank(1, 'teal', { x: 0, y: 0 }, { activeMineIds: [70] }); // 1 < MINE_CAP(2)
    const at = tank(1, 'teal', { x: 0, y: 0 }, { activeMineIds: [70, 71] }); // 2 == MINE_CAP(2)
    const playerBelow = tank(2, 'player', { x: 5, y: 0 });
    const playerAt = tank(2, 'player', { x: 5, y: 0 });
    expect(tealDecision(world({ tanks: [below, playerBelow] }), below, MINE_SURE).mine).toBe(true);
    expect(tealDecision(world({ tanks: [at, playerAt] }), at, MINE_SURE).mine).toBe(false);
  });
});

describe('teal shot-plan window (issue #332)', () => {
  // The span the shipped teal profile authorises, derived the way teal.ts derives it, so
  // these assertions track ai-profiles.json instead of restating a number beside it.
  const SPAN = Math.round(configFor('teal').ai.shotCommitmentTime * TICK_HZ);
  // Player in the open, no walls: the direct plan always solves here and the bank plan
  // never can (bankShot needs a bounce surface). That asymmetry is what lets one fixture
  // hold a solvable plan and another hold an unsolvable one on the same geometry.
  const openField = (over: Partial<Tank>, cfg?: ResolvedTankConfig) => {
    const teal = tank(1, 'teal', { x: 0, y: 0 }, over);
    const player = tank(2, 'player', { x: 5, y: 0 });
    return { teal, d: tealDecision(world({ tanks: [teal, player] }), teal, cfg ?? configFor('teal')) };
  };

  it('re-arms from the PROFILE FIELD, not from a constant that happens to equal it', () => {
    // The shipped span is 2.0s = 120 ticks, which is exactly the value of the prototype
    // constant this replaced -- so asserting 120 against the shipped profile could not
    // tell the two apart. Injecting a DIFFERENT shotCommitmentTime is what discriminates:
    // pin 120 in place of the field and this fails, while the shipped-profile assertion
    // below keeps passing.
    const slow = { ...configFor('teal'), ai: { ...configFor('teal').ai, shotCommitmentTime: 5 } };
    const { d } = openField({ aiShotPlan: 'direct', aiShotPlanTicks: 1 }, slow); // lapsed
    expect(d.nextShotPlanTicks).toBe(Math.round(5 * TICK_HZ));
    expect(d.nextShotPlanTicks).not.toBe(SPAN); // 300 != the shipped 120
  });

  it('re-arms to the shipped profile span when nothing is injected', () => {
    const { d } = openField({ aiShotPlan: 'direct', aiShotPlanTicks: 1 });
    expect(d.nextShotPlanTicks).toBe(SPAN);
  });

  it('counts DOWN while the window is live', () => {
    const { d } = openField({ aiShotPlan: 'direct', aiShotPlanTicks: 47 });
    expect(d.nextShotPlanTicks).toBe(46);
  });

  it('a lapsed window whose plan still SOLVES re-arms on the same plan -- no turnover', () => {
    const { d } = openField({ aiShotPlan: 'direct', aiShotPlanTicks: 1 });
    expect(d.nextShotPlan).toBe('direct'); // direct solves in the open
    expect(d.nextShotPlanTicks).toBe(SPAN);
  });

  it('a lapsed window whose plan does NOT solve is the only way the plan turns over', () => {
    const { d } = openField({ aiShotPlan: 'bank', aiShotPlanTicks: 1 }); // no walls -> bank unsolvable
    expect(d.nextShotPlan).toBe('direct');
    // ...and it still fires this tick, via the fallback: a turnover is not a lost shot.
    expect(d.fire).toBe(true);
  });

  it('an UNSOLVABLE plan inside a live window does NOT turn over -- the window is what gates it', () => {
    // Same unsolvable-bank geometry as the turnover fixture above; only the countdown
    // differs. This is the negative control for that test: without the `lapsed` term in
    // tealDecision both fixtures would report 'direct'.
    const { d } = openField({ aiShotPlan: 'bank', aiShotPlanTicks: 47 });
    expect(d.nextShotPlan).toBe('bank');
    expect(d.nextShotPlanTicks).toBe(46);
  });

  it('carries the plan on the NO-TARGET path, so the countdown cannot freeze', () => {
    // stepAi writes the pair back only when the decision carries one, so a return that
    // omitted it would stall the countdown for every tick the arena has no live player --
    // every countdown and every player death -- making the real window longer than the
    // profile says. Deleting `nextShotPlan`/`nextShotPlanTicks` from teal.ts's no-target
    // return makes both assertions below fail.
    const teal = tank(1, 'teal', { x: 0, y: 0 }, { aiShotPlan: 'direct', aiShotPlanTicks: 47 });
    const dead = tank(2, 'player', { x: 5, y: 0 }, { alive: false });
    const d = tealDecision(world({ tanks: [teal, dead] }), teal);
    expect(d.nextShotPlanTicks).toBe(46);
    // No target means no evidence the held plan has failed, so it holds rather than flips.
    expect(d.nextShotPlan).toBe('direct');
  });

  it('holds the plan across a lapse with no target, rather than flipping on the clock alone', () => {
    // The pre-#332 behaviour flipped on the clock regardless of the engagement. A lapsed
    // window with nobody to shoot at re-arms the same plan.
    const teal = tank(1, 'teal', { x: 0, y: 0 }, { aiShotPlan: 'bank', aiShotPlanTicks: 1 });
    const dead = tank(2, 'player', { x: 5, y: 0 }, { alive: false });
    const d = tealDecision(world({ tanks: [teal, dead] }), teal);
    expect(d.nextShotPlan).toBe('bank');
    expect(d.nextShotPlanTicks).toBe(SPAN);
  });

  it('a tank that has never held a plan starts on bank and arms a full window', () => {
    const { d } = openField({}); // aiShotPlan undefined
    // Bank is unsolvable in the open, so the very first decision is also a turnover: the
    // default is visible in the FALLBACK it fires, not in nextShotPlan.
    expect(d.fire).toBe(true);
    expect(d.nextShotPlan).toBe('direct');
    expect(d.nextShotPlanTicks).toBe(SPAN);
  });
});
