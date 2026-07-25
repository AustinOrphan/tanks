import { describe, it, expect } from 'vitest';
import { decideAi, stepAi } from './index';
import { FIRE_COOLDOWN, SHELL_CAP, DODGE_PATIENCE_TICKS, COUNTDOWN_TICKS, GRACE_TICKS } from '../constants';
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
    tick: 0, nextId: 100, seed: 5, tanks, bullets: [], mines: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: FAR_PAST, ...over,
  };
}

describe('decideAi', () => {
  it('routes by tank kind (Brown never moves)', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = decideAi(world([brown, player]), brown);
    expect(d.desiredMove).toEqual({ x: 0, y: 0 });
  });
});

describe('stepAi', () => {
  it('leaves a Brown stationary (desiredMove {0,0})', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([brown, player]);
    stepAi(w, []);
    expect(w.tanks[0].desiredMove).toEqual({ x: 0, y: 0 });
  });

  it('creates enemy bullets via spawnBullet when the enemy decides to fire', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 }); // clear LOS -> grey fires
    const w = world([grey, player]);
    const events: SimEvent[] = [];
    stepAi(w, events);
    expect(w.bullets.length).toBe(1);
    expect(w.bullets[0].ownerId).toBe(1);
    expect(events.some((e) => e.type === 'fire')).toBe(true);
  });

  it('respects fireCooldown (no every-tick spam)', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([grey, player]);
    stepAi(w, []);
    expect(w.bullets.length).toBe(1);
    expect(w.tanks[0].fireCooldown).toBeCloseTo(FIRE_COOLDOWN, 6);
    stepAi(w, []); // cooldown still active
    expect(w.bullets.length).toBe(1);
  });

  it('is deterministic across identical worlds', () => {
    const build = () => world([tank(1, 'grey', { x: 0, y: 0 }), tank(2, 'player', { x: 5, y: 0 })]);
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
    const grey = tank(1, 'grey', { x: 0, y: 0 });
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
    const grey = tank(2, 'grey', { x: 5, y: 0 });
    const w = world([player, grey]);
    stepAi(w, []);
    expect(w.tanks[0].turretAngle).toBe(2.5);
    expect(w.tanks[0].desiredMove).toEqual({ x: -1, y: 0.5 });
  });

  // --- D: fire-rate gating actually limits shots over a full simulated second. ---
  it('fire-rate gating: an enemy that wants to fire every tick only fires ~2-3 times per simulated second', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
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
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([grey, player]);
    // Long enough for many fire-cooldown cycles (FIRE_COOLDOWN=0.4s = 24 ticks) to elapse;
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
      tank(2, 'brown', { x: 5, y: 5 }, { aiState: 'idle' }),
      tank(3, 'grey', { x: -5, y: 5 }),
      tank(4, 'teal', { x: 5, y: -5 }),
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
      const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
      const player = tank(2, 'player', { x: 5, y: 0 });
      const d = decideAi(world([brown, player]), brown);
      expect(d.fireType).toBe('normal');
      expect(d.fire).toBe(true);
      expect(d.desiredMove).toEqual({ x: 0, y: 0 });
    });

    it('grey: fireType normal, fires immediately on LOS (no aim state gating) and can move', () => {
      const grey = tank(1, 'grey', { x: 0, y: 0 });
      const player = tank(2, 'player', { x: 5, y: 0 });
      const d = decideAi(world([grey, player]), grey);
      expect(d.fireType).toBe('normal');
      expect(d.fire).toBe(true);
    });

    it('teal: fireType ricochet, distinct from brown/grey', () => {
      const teal = tank(1, 'teal', { x: 0, y: 0 });
      const player = tank(2, 'player', { x: 5, y: 0 });
      const d = decideAi(world([teal, player]), teal);
      expect(d.fireType).toBe('ricochet');
    });

    it('unknown/player kind hits the default branch: no-op decision with nextTimer 0', () => {
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
      const grey = tank(1, 'grey', { x: 0, y: 0 });
      const player = tank(2, 'player', { x: 0, y: 5 });
      const w = world([grey, player], { tick: 0, roundStartTick: 0 }); // elapsed 0 -> countdown
      stepAi(w, []);
      expect(w.tanks[0].desiredMove).toEqual({ x: 0, y: 0 });
      expect(w.bullets.length).toBe(0);
      expect(w.mines.length).toBe(0);
      // Turret still tracks the target during countdown (orientation is the point of it).
      expect(w.tanks[0].turretAngle).toBeCloseTo(Math.PI / 2, 6);
    });

    it('grace: AI tanks move, but still cannot fire or lay mines', () => {
      const grey = tank(1, 'grey', { x: 0, y: 0 });
      const player = tank(2, 'player', { x: 5, y: 0 }); // clear LOS -> would fire and mine if live
      const w = world([grey, player], { tick: COUNTDOWN_TICKS, roundStartTick: 0 }); // first grace tick
      stepAi(w, []);
      expect(Math.hypot(w.tanks[0].desiredMove.x, w.tanks[0].desiredMove.y)).toBeGreaterThan(0.9);
      expect(w.bullets.length).toBe(0);
      expect(w.mines.length).toBe(0);
    });

    it('the last grace tick still suppresses fire; the first live tick fires normally', () => {
      const buildGrey = () => tank(1, 'grey', { x: 0, y: 0 });
      const buildPlayer = () => tank(2, 'player', { x: 5, y: 0 });

      const lastGrace = world([buildGrey(), buildPlayer()], {
        tick: COUNTDOWN_TICKS + GRACE_TICKS - 1,
        roundStartTick: 0,
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
});
