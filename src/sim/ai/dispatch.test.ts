import { describe, it, expect } from 'vitest';
import { decideAi, stepAi } from './index';
import { FIRE_COOLDOWN_TICKS, SHELL_CAP, DODGE_PATIENCE_TICKS, COUNTDOWN_TICKS, GRACE_TICKS, AI_TURRET_TURN_RATE, AI_TURRET_RAMP_TICKS, DT } from '../constants';
import type { Tank, Vec2 } from '../types';
import type { World } from '../world';
import type { SimEvent } from '../events';

function tank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}
// roundStartTick defaults far in the past so every pre-existing test in this file (all
// written before round phases existed, and none of them about round phases) lands in
// the unrestricted 'live' phase regardless of `tick`. Tests that DO exercise round
// phases below override roundStartTick explicitly.
const FAR_PAST = -100000;

function world(tanks: Tank[], over: Partial<World> = {}): World {
  return {
    tick: 0, nextId: 100, seed: 5, tanks, bullets: [], mines: [], blasts: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: FAR_PAST,
    unarmedTrigger: 'none', corpseBlocksShells: false, muzzleClearsTanks: true, coopAttempts: true, mode: 'campaign-coop', friendlyFire: false, ...over,
  };
}

// REACTION isolation: reactionTime (dispatcher gate on tank.aimTicks) would hold
// every first shot in this file for the profile's reaction span. These tests are
// about OTHER dispatcher gates -- phases, cooldown, caps, friendly fire, disarmed
// -- so their fixtures start with the solution long HELD. The reaction gate has
// its own suite (reaction.test.ts).
const HELD = { aimTicks: 999 };

describe('decideAi', () => {
  it('routes by tank kind (Brown never moves)', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { ...HELD, aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = decideAi(world([brown, player]), brown);
    expect(d.desiredMove).toEqual({ x: 0, y: 0 });
  });
});

describe('turret acceleration (issue #347)', () => {
  it('stepAi ramps the turret from rest instead of jumping straight to the rate cap', () => {
    // Player far off to the side, so the aim error is large and the turret has room to
    // accelerate. Before #347 the first tick moved a full AI_TURRET_TURN_RATE * DT; now it
    // moves one acceleration budget, which is that divided by AI_TURRET_RAMP_TICKS.
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD, turretAngle: 0 });
    const w = world([grey, tank(2, 'player', { x: 0, y: 8 })]);
    const before = w.tanks[0].turretAngle;
    stepAi(w, []);
    const moved = Math.abs(w.tanks[0].turretAngle - before);
    const cap = AI_TURRET_TURN_RATE * DT;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeCloseTo(cap / AI_TURRET_RAMP_TICKS, 12);
    expect(w.tanks[0].turretVel).toBeCloseTo(cap / AI_TURRET_RAMP_TICKS, 12);
  });
});

describe('aim hold (issue #344)', () => {
  it('a held aim does NOT suppress the firing solution: hasSolution still reads the fresh solve', () => {
    // Deliberate, and worth a pin because it is the load-bearing half of the design. The
    // hold decides where the tank POINTS; it must not become a stealth accuracy change by
    // also deciding what the tank believes it can hit. If hasSolution were computed against
    // the held angle, a tank whose barrel had drifted would stop firing entirely -- a much
    // larger behaviour change than the one measured, smuggled in as a smoothing fix.
    // The cost of keeping them separate is that a tank can fire with its barrel up to
    // AI_AIM_BREAK off the fresh solution and miss; that is what the engagement harness
    // prices, and what reaction.test.ts is re-run against at every swept span.
    const probe = tank(1, 'brown', { x: 0, y: 0 }, { ...HELD });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const fresh = decideAi(world([probe, player]), probe);

    const brown = tank(1, 'brown', { x: 0, y: 0 }, {
      ...HELD, aiAimHeld: fresh.turretAngle + 0.01, aiAimHeldTicks: 5,
    });
    const held = decideAi(world([brown, tank(2, 'player', { x: 5, y: 0 })]), brown);
    expect(held.turretAngle).not.toBe(fresh.turretAngle); // the hold IS in effect
    expect(held.hasSolution).toBe(fresh.hasSolution);     // and the solution is untouched
    expect(held.fireType).toBe(fresh.fireType);
  });

  it('decideAi returns the HELD aim angle, not the fresh solution, while the span is live', () => {
    // Learn the fresh solution this fixture produces, then arm a hold a hair off it --
    // 0.01 rad, inside any shippable break threshold -- so the two are distinguishable.
    const probe = tank(1, 'brown', { x: 0, y: 0 }, { ...HELD });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const fresh = decideAi(world([probe, player]), probe).turretAngle;

    const brown = tank(1, 'brown', { x: 0, y: 0 }, {
      ...HELD, aiAimHeld: fresh + 0.01, aiAimHeldTicks: 5,
    });
    const d = decideAi(world([brown, tank(2, 'player', { x: 5, y: 0 })]), brown);
    expect(d.turretAngle).toBe(fresh + 0.01);
    expect(d.nextAimHeld).toBe(fresh + 0.01);
    expect(d.nextAimHeldTicks).toBe(4);
  });
});

describe('stepAi', () => {
  it('leaves a Brown stationary (desiredMove {0,0})', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { ...HELD, aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([brown, player]);
    stepAi(w, []);
    expect(w.tanks[0].desiredMove).toEqual({ x: 0, y: 0 });
  });

  it('creates enemy bullets via spawnBullet when the enemy decides to fire', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD });
    const player = tank(2, 'player', { x: 5, y: 0 }); // clear LOS -> grey fires
    const w = world([grey, player]);
    const events: SimEvent[] = [];
    stepAi(w, events);
    expect(w.bullets.length).toBe(1);
    expect(w.bullets[0].ownerId).toBe(1);
    expect(events.some((e) => e.type === 'fire')).toBe(true);
  });

  it('respects fireCooldown (no every-tick spam)', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([grey, player]);
    stepAi(w, []);
    expect(w.bullets.length).toBe(1);
    expect(w.tanks[0].fireCooldown).toBe(FIRE_COOLDOWN_TICKS);
    stepAi(w, []); // cooldown still active
    expect(w.bullets.length).toBe(1);
  });

  it('is deterministic across identical worlds', () => {
    const build = () => world([tank(1, 'grey', { x: 0, y: 0 }, { ...HELD }), tank(2, 'player', { x: 5, y: 0 })]);
    const a = build(); const b = build();
    stepAi(a, []); stepAi(b, []);
    expect(JSON.stringify(a.bullets)).toBe(JSON.stringify(b.bullets));
  });

  // --- A: REGRESSION for the missing `tank.aiTimer = decision.nextTimer` write-back. ---
  // This is THE most important test in this task. Without the write-back, tank.aiTimer
  // never advances past 0, so Grey's dodgeTicks (= tank.aiTimer + 1 while dodging) is
  // permanently 1 and never reaches DODGE_PATIENCE_TICKS (45) -> Grey holds fire forever
  // whenever any bullet sits in its danger corridor.
  //
  // NOTE: this test targets 'grey', not 'teal'. The cautious dodge-patience mechanic was
  // swapped from Teal to Grey (personality swap: Grey is now cautious, Teal is now
  // aggressive), so the write-back this test guards is the one greyDecision now reads.
  //
  // We call stepAi() DIRECTLY in a loop here (not the full step() pipeline) so the threat
  // bullet does NOT get advanced by stepBullets between calls -- stepAi never moves
  // bullets itself, only stepBullets (a separate phase) does. That keeps the same bullet
  // sitting in Grey's danger corridor on every call without needing to re-supply it,
  // which is exactly what isolates "does stepAi's own per-tick state write-back work" from
  // "does the bullet-motion system also cooperate".
  it('REGRESSION: aiTimer advances tick-over-tick under sustained threat, and Grey eventually fires', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD });
    const player = tank(2, 'player', { x: 20, y: 0 }); // far away, clear LOS -> a shot exists
    // A bullet parked just behind Grey on its own axis, moving toward it: this sits inside
    // both THREAT_HORIZON and DANGER_CORRIDOR (see targeting.ts's incomingThreats), so
    // dangerAvoidMove keeps returning non-null every single call as long as the bullet
    // is not moved (which it isn't, since we don't call stepBullets in this loop).
    const w = world([grey, player], {
      bullets: [
        { id: 999, ownerId: 2, type: 'normal', pos: { x: -1, y: 0 }, vel: { x: 5, y: 0 }, bouncesLeft: 1, alive: true },
      ],
    });

    const aiTimers: number[] = [];
    for (let i = 0; i < DODGE_PATIENCE_TICKS; i++) {
      stepAi(w, []);
      aiTimers.push(w.tanks[0].aiTimer);
    }

    // Strictly increasing 1,2,3,...,DODGE_PATIENCE_TICKS-1 while still dodging (not stuck
    // at 1, which is what the bug produces). The very last call is the one where patience
    // runs out and Grey fires instead of dodging, which resets nextTimer to 0 -- that's
    // expected behaviour, not a bug, so it's checked separately below.
    const dodgingPortion = aiTimers.slice(0, -1);
    for (let i = 1; i < dodgingPortion.length; i++) {
      expect(dodgingPortion[i]).toBeGreaterThan(dodgingPortion[i - 1]);
    }
    expect(dodgingPortion[0]).toBe(1);
    expect(dodgingPortion[dodgingPortion.length - 1]).toBe(DODGE_PATIENCE_TICKS - 1);

    // After DODGE_PATIENCE_TICKS consecutive dodge ticks, Grey's patience runs out and it
    // fires despite the ongoing threat; nextTimer resets to 0 on the firing tick.
    expect(aiTimers[aiTimers.length - 1]).toBe(0);
    expect(w.tanks[0].fireCooldown).toBeGreaterThan(0);
    expect(w.bullets.some((b) => b.ownerId === 1)).toBe(true);
  });

  // --- B: dead tanks are skipped entirely. ---
  it('skips a dead enemy entirely: no fire, no movement, no cooldown decrement', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 }, {
      alive: false,
      turretAngle: 1.23,
      desiredMove: { x: 7, y: 7 },
      fireCooldown: 0.15,
      mineCooldown: 0.25,
    });
    const player = tank(2, 'player', { x: 5, y: 0 }); // would give clear LOS if grey were alive
    const w = world([grey, player]);
    stepAi(w, []);
    expect(w.bullets.length).toBe(0);
    expect(w.mines.length).toBe(0);
    expect(w.tanks[0].desiredMove).toEqual({ x: 7, y: 7 });
    expect(w.tanks[0].turretAngle).toBe(1.23);
    expect(w.tanks[0].fireCooldown).toBe(0.15);
    expect(w.tanks[0].mineCooldown).toBe(0.25);
  });

  // --- C: the player is untouched by stepAi. ---
  it('leaves the player tank untouched (player is driven by applyPlayerInput, not stepAi)', () => {
    const player = tank(1, 'player', { x: 0, y: 0 }, { turretAngle: 2.5, desiredMove: { x: -1, y: 0.5 } });
    const grey = tank(2, 'grey', { x: 5, y: 0 }, { ...HELD });
    const w = world([player, grey]);
    stepAi(w, []);
    expect(w.tanks[0].turretAngle).toBe(2.5);
    expect(w.tanks[0].desiredMove).toEqual({ x: -1, y: 0.5 });
  });

  // --- D: fire-rate gating actually limits shots over a full simulated second. ---
  it('fire-rate gating: an enemy that wants to fire every tick only fires ~2-3 times per simulated second', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD });
    const player = tank(2, 'player', { x: 5, y: 0 }); // permanent clear LOS -> grey always wants to fire
    const w = world([grey, player]);
    for (let i = 0; i < 60; i++) {
      stepAi(w, []);
    }
    const shotsFired = w.bullets.filter((b) => b.ownerId === 1).length;
    expect(shotsFired).toBeGreaterThanOrEqual(2);
    expect(shotsFired).toBeLessThanOrEqual(3);
    expect(shotsFired).not.toBe(60);
  });

  // --- E: enemy shells respect SHELL_CAP. ---
  it('enemy shells never exceed SHELL_CAP even when firing freely for a long time', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([grey, player]);
    // Long enough for many fire-cooldown cycles (FIRE_COOLDOWN_TICKS=0.4s = 24 ticks) to elapse;
    // bullets are never advanced/removed here (no stepBullets call), so they only accumulate,
    // making this the strictest possible test of the cap.
    for (let i = 0; i < 400; i++) {
      stepAi(w, []);
      const live = w.bullets.filter((b) => b.alive && b.ownerId === 1).length;
      expect(live).toBeLessThanOrEqual(SHELL_CAP);
    }
  });

  // --- F: determinism through the AI path. ---
  it('is deterministic across many ticks with mixed enemy kinds', () => {
    const build = (): World => world([
      tank(1, 'player', { x: 0, y: 0 }),
      tank(2, 'brown', { x: 5, y: 5 }, { ...HELD, aiState: 'idle' }),
      tank(3, 'grey', { x: -5, y: 5 }, { ...HELD }),
      tank(4, 'teal', { x: 5, y: -5 }, { ...HELD }),
    ]);
    const a = build();
    const b = build();
    for (let i = 0; i < 90; i++) {
      a.tick = i; b.tick = i; // wanderMove/bank-preference read world.tick
      stepAi(a, []);
      stepAi(b, []);
    }
    const project = (w: World) => ({
      positions: w.tanks.map((t) => ({ x: t.pos.x, y: t.pos.y })),
      turretAngles: w.tanks.map((t) => t.turretAngle),
      aiTimers: w.tanks.map((t) => t.aiTimer),
      bulletCount: w.bullets.length,
    });
    expect(project(a)).toEqual(project(b));
  });

  // --- G: decideAi dispatches by kind, including the default branch. ---
  describe('decideAi dispatches by kind', () => {
    it('brown: fireType normal, only fires from aiState "aim" with LOS', () => {
      const brown = tank(1, 'brown', { x: 0, y: 0 }, { ...HELD, aiState: 'aim' });
      const player = tank(2, 'player', { x: 5, y: 0 });
      const d = decideAi(world([brown, player]), brown);
      expect(d.fireType).toBe('normal');
      expect(d.fire).toBe(true);
      expect(d.desiredMove).toEqual({ x: 0, y: 0 });
    });

    it('grey: fireType normal, fires immediately on LOS (no aim state gating) and can move', () => {
      const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD });
      const player = tank(2, 'player', { x: 5, y: 0 });
      const d = decideAi(world([grey, player]), grey);
      expect(d.fireType).toBe('normal');
      expect(d.fire).toBe(true);
    });

    it('teal: fireType ricochet, distinct from brown/grey', () => {
      const teal = tank(1, 'teal', { x: 0, y: 0 }, { ...HELD });
      const player = tank(2, 'player', { x: 5, y: 0 });
      const d = decideAi(world([teal, player]), teal);
      expect(d.fireType).toBe('ricochet');
    });

    it('player kind returns an inert no-op decision with nextTimer 0', () => {
      const player = tank(1, 'player', { x: 0, y: 0 }, { turretAngle: 0.75 });
      const other = tank(2, 'player', { x: 5, y: 0 });
      const d = decideAi(world([player, other]), player);
      expect(d.desiredMove).toEqual({ x: 0, y: 0 });
      expect(d.turretAngle).toBe(0.75); // passthrough of current turret angle
      expect(d.fire).toBe(false);
      expect(d.mine).toBe(false);
      expect(d.nextState).toBe('idle');
      expect(d.nextTimer).toBe(0);
    });
  });

  // --- H: round phases (countdown / grace / live) gate the AI exactly like the player. ---
  describe('round phases', () => {
    it('countdown: no AI tank moves or fires, even with a clear kill shot', () => {
      // Player at (0,5) -- NOT on grey's turretAngle:0 axis -- so a turret update away
      // from the initial angle is visible proof that aiming still runs during countdown.
      const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD });
      const player = tank(2, 'player', { x: 0, y: 5 });
      const w = world([grey, player], { tick: 0, roundStartTick: 0 }); // elapsed 0 -> countdown
      stepAi(w, []);
      expect(w.tanks[0].desiredMove).toEqual({ x: 0, y: 0 });
      expect(w.bullets.length).toBe(0);
      expect(w.mines.length).toBe(0);
      // Turret still tracks the target during countdown (orientation is the point of it),
      // but it only SLEWS: the desired angle (pi/2 + jitter, jitter bounded by
      // profileAimSpread(grey) ~= 0.133) is far more than one tick's turn budget away from the
      // starting angle of 0, so after one stepAi call the turret has advanced by ONE
      // ACCELERATION BUDGET -- the exact desired angle (and its jitter) is not yet
      // visible in a single tick's result. Was a full AI_TURRET_TURN_RATE*DT before
      // issue #347 gave the turret angular acceleration; the point of the assertion is
      // unchanged (the turret slews, it does not snap), only the first tick is smaller.
      const firstTick = (AI_TURRET_TURN_RATE * DT) / AI_TURRET_RAMP_TICKS;
      expect(w.tanks[0].turretAngle).toBeCloseTo(firstTick, 10);
    });

    it('the tick the countdown ends on is fully live for the AI too', () => {
      // GRACE_TICKS is 0, so the AI gets no window where it may drive but not shoot --
      // and neither does the player. Asserted on both paths because they gate through
      // the same helper and have drifted apart before.
      expect(GRACE_TICKS).toBe(0);
      const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD });
      const player = tank(2, 'player', { x: 5, y: 0 }); // clear LOS -> fires
      const w = world([grey, player], { tick: COUNTDOWN_TICKS, roundStartTick: 0 });
      stepAi(w, []);
      expect(Math.hypot(w.tanks[0].desiredMove.x, w.tanks[0].desiredMove.y)).toBeGreaterThan(0.9);
      expect(w.bullets.length).toBe(1);
    });

    it('the last suppressed tick still cannot fire; the first live tick fires normally', () => {
      const buildGrey = () => tank(1, 'grey', { x: 0, y: 0 }, { ...HELD });
      const buildPlayer = () => tank(2, 'player', { x: 5, y: 0 });

      const lastGrace = world([buildGrey(), buildPlayer()], {
        tick: COUNTDOWN_TICKS + GRACE_TICKS - 1,
        roundStartTick: 0, unarmedTrigger: 'none' as const,
      });
      stepAi(lastGrace, []);
      expect(lastGrace.bullets.length).toBe(0);

      const firstLive = world([buildGrey(), buildPlayer()], {
        tick: COUNTDOWN_TICKS + GRACE_TICKS,
        roundStartTick: 0,
      });
      stepAi(firstLive, []);
      expect(firstLive.bullets.length).toBe(1);
    });
  });

  // --- I: turret slew (finite turn rate instead of instantaneous snap). ---
  describe('turret slew', () => {
    // Bearing 150deg from the origin, at radius 11.5546...: tan(30deg) =
    // 5.7735026918962575/10, and with dx<0, dy>0 the bearing is 180-30 = 150deg =
    // 5*pi/6 ~= 2.61799 rad. Chosen so that even after grey's profile-derived jitter (bounded
    // +/-profileAimSpread(grey) ~= 0.133 rad) is added, the desired angle stays safely inside (0, pi) -- nowhere
    // near the 0 or +/-pi wrap boundaries -- so the FIRST tick's slew direction and
    // magnitude are fully determined without needing to also compute the jitter by hand.
    const BEHIND_PLAYER_POS = { x: -10, y: 5.7735026918962575 };

    it('an AI cannot instantly face a target that appears behind it: one tick advances by one acceleration budget', () => {
      const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD }); // turretAngle starts at 0 (facing +x)
      const player = tank(2, 'player', BEHIND_PLAYER_POS); // stationary, bearing ~150deg
      const w = world([grey, player]);
      stepAi(w, []);
      // One acceleration budget, not the full rate cap: issue #347 starts the turret from
      // rest. The cap is still the ceiling, it just takes AI_TURRET_RAMP_TICKS to reach it.
      const firstTick = (AI_TURRET_TURN_RATE * DT) / AI_TURRET_RAMP_TICKS;
      expect(w.tanks[0].turretAngle).toBeCloseTo(firstTick, 10);
      expect(w.tanks[0].turretAngle).toBeLessThan(Math.PI / 2); // nowhere near the ~150deg target yet
    });

    it('does not drift when holding the last angle (no line of sight): slewing toward a no-op target is a no-op', () => {
      const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD, turretAngle: 1.75 });
      const player = tank(2, 'player', { x: 5, y: 0 });
      // A solid wall directly between them blocks LOS -> greyDecision holds tank.turretAngle
      // unchanged as its desired angle (see grey.ts: `let turretAngle = tank.turretAngle`).
      const wall = { id: 1, aabb: { minX: 2, minY: -1, maxX: 3, maxY: 1 }, kind: 'solid' as const, destroyed: false };
      const w = world([grey, player], { walls: [wall] });
      stepAi(w, []);
      expect(w.tanks[0].turretAngle).toBe(1.75); // unchanged, not drifting toward anything
    });

    it("fires with the ACTUAL (post-slew) turret angle, not the decision function's desired angle", () => {
      // Same geometry as the "cannot instantly face" test above: Grey starts facing +x
      // (turretAngle 0) with a clear shot at a stationary player ~150deg away, a swing far
      // too large to complete in one tick. If spawnBullet were (bug) called with
      // decision.turretAngle instead of tank.turretAngle, the bullet would fire toward the
      // player (~150deg) despite the barrel visibly still pointing near +x.
      const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD });
      const player = tank(2, 'player', BEHIND_PLAYER_POS);
      const w = world([grey, player]);
      stepAi(w, []);
      expect(w.bullets.length).toBe(1);
      const bullet = w.bullets[0];
      const bulletAngle = Math.atan2(bullet.vel.y, bullet.vel.x);
      const firstTick = (AI_TURRET_TURN_RATE * DT) / AI_TURRET_RAMP_TICKS;
      // The bullet's actual travel direction matches the tank's post-slew turret angle...
      expect(bulletAngle).toBeCloseTo(w.tanks[0].turretAngle, 10);
      expect(bulletAngle).toBeCloseTo(firstTick, 10);
      // ...NOT the ~150deg (2.618 rad) the decision function actually wanted.
      expect(Math.abs(bulletAngle - (5 * Math.PI) / 6)).toBeGreaterThan(1);
    });
  });

  // ---- Friendly fire is re-checked at the trigger, against the angle the barrel is
  // ACTUALLY pointing. The decision functions vet their own solution, but the test
  // directly above proves the shot leaves along the post-slew angle, which mid-swing can
  // be ~150deg away from what the decision reasoned about -- so a decision-time-only gate
  // sprays the arena on every turret swing. ----

  describe('friendly-fire gate at the trigger', () => {
    it('does not fire when a teammate sits on the POST-SLEW firing line', () => {
      // Grey's barrel points +x and can only creep AI_TURRET_TURN_RATE*DT per tick, so the
      // shot would leave along ~+x -- straight through Brown at (3,0) -- even though the
      // decision function is aiming at the player behind Grey.
      const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD, turretAngle: 0 });
      const mate = tank(3, 'brown', { x: 3, y: 0 }, { ...HELD });
      const player = tank(2, 'player', { x: -5, y: 0.5 });
      const w = world([grey, mate, player]);
      stepAi(w, []);
      expect(w.bullets.length).toBe(0);
      // A refused shot must not burn the cooldown either -- otherwise the tank pays for a
      // shot it never took and stays silent for another FIRE_COOLDOWN_TICKS.
      expect(w.tanks[0].fireCooldown).toBe(0);
    });

    it('still fires when the post-slew line is clear of teammates', () => {
      // Same fixture with the teammate off the +x line.
      const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD, turretAngle: 0 });
      const mate = tank(3, 'brown', { x: 3, y: 5 }, { ...HELD });
      const player = tank(2, 'player', { x: -5, y: 0.5 });
      const w = world([grey, mate, player]);
      stepAi(w, []);
      expect(w.bullets.length).toBe(1);
    });

    it('does not drop a mine that would sit inside a teammate\'s blast radius', () => {
      // Brown never moves, so a mine laid at its feet by a roaming teammate is a
      // guaranteed kill once it arms. Grey is otherwise fully mine-eligible here.
      const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD });
      const mate = tank(3, 'brown', { x: 1, y: 0 }, { ...HELD });
      const w = world([grey, mate]);
      stepAi(w, []);
      expect(w.mines.length).toBe(0);
      expect(w.tanks[0].mineCooldown).toBe(0);
    });

    it('still drops a mine when no teammate is within the blast', () => {
      const grey = tank(1, 'grey', { x: 0, y: 0 }, { ...HELD });
      const mate = tank(3, 'brown', { x: 12, y: 0 }, { ...HELD });
      // A player in range: laying a mine is gated on it being worth doing (see
      // mineThreatensPlayer), so without a nearby player this would prove nothing about
      // the friendly-fire gate this test is actually about.
      const player = tank(9, 'player', { x: 3, y: 0 });
      const w = world([grey, mate, player]);
      stepAi(w, []);
      expect(w.mines.length).toBe(1);
    });
  });

  describe('disarmed enemies (the dev sandbox rides on this)', () => {
    // Each case reuses THE fixture proven to produce the shot/mine two tests up, so the
    // disarmed assertion cannot pass vacuously: the same world with the flag off acts.

    it('never fires, while its armed twin does', () => {
      const events: SimEvent[] = [];
      const armed = world([tank(1, 'grey', { x: 0, y: 0 }, { ...HELD }), tank(2, 'player', { x: 5, y: 0 })]);
      stepAi(armed, events);
      expect(armed.bullets.length).toBe(1); // the fixture really is a firing solution

      const w = world([
        tank(1, 'grey', { x: 0, y: 0 }, { ...HELD, disarmed: true }),
        tank(2, 'player', { x: 5, y: 0 }),
      ]);
      for (let i = 0; i < 120; i++) stepAi(w, events);
      expect(w.bullets.length).toBe(0);
    });

    it('never lays a mine, while its armed twin does', () => {
      const armed = world([
        tank(1, 'grey', { x: 0, y: 0 }, { ...HELD }),
        tank(3, 'brown', { x: 12, y: 0 }, { ...HELD }),
        tank(9, 'player', { x: 3, y: 0 }),
      ]);
      stepAi(armed, []);
      expect(armed.mines.length).toBe(1); // the fixture really does lay one

      const w = world([
        tank(1, 'grey', { x: 0, y: 0 }, { ...HELD, disarmed: true }),
        tank(3, 'brown', { x: 12, y: 0 }, { ...HELD }),
        tank(9, 'player', { x: 3, y: 0 }),
      ]);
      for (let i = 0; i < 120; i++) stepAi(w, []);
      expect(w.mines.length).toBe(0);
    });

    it('still drives and aims: disarmed is not paralysed', () => {
      // The flag must remove ordnance only. A disarmed tank that also stopped moving
      // would make the sandbox useless for testing movement and pursuit.
      const w = world([
        tank(1, 'grey', { x: 0, y: 0 }, { ...HELD, disarmed: true }),
        tank(2, 'player', { x: 5, y: 3 }),
      ]);
      const before = w.tanks[0].turretAngle;
      for (let i = 0; i < 30; i++) stepAi(w, []);
      expect(w.tanks[0].turretAngle).not.toBe(before); // turret tracks the player
    });
  });
});

describe('shot-plan write-back (issue #332)', () => {
  // The WIRING layer, not the rule: teal.test.ts probes tealDecision directly and would
  // stay entirely green if stepAi discarded the pair the decision returns. Then the plan
  // would reset to the default every tick and the window would never advance at all.
  it('stepAi persists the shot plan and its countdown onto the tank', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 }, { ...HELD, aiShotPlan: 'direct', aiShotPlanTicks: 47 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    stepAi(world([teal, player]), [] as SimEvent[]);
    expect(teal.aiShotPlan).toBe('direct');
    expect(teal.aiShotPlanTicks).toBe(46); // advanced, not merely preserved
  });

  it('a decision with NO shot plan leaves an existing one untouched', () => {
    // brownDecision never evaluates a shot plan, so the absent pair must read as "no
    // opinion". Writing it unconditionally would clear a plan the tank still holds --
    // which is why AiDecision.nextShotPlan is optional rather than nullable.
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { ...HELD, aiShotPlan: 'bank', aiShotPlanTicks: 47 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    stepAi(world([brown, player]), [] as SimEvent[]);
    expect(brown.aiShotPlan).toBe('bank');
    expect(brown.aiShotPlanTicks).toBe(47);
  });
});
