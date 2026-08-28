import { describe, it, expect } from 'vitest';
import { stepAi } from './index';
import { roundPhase } from '../round';
import { configFor } from '../config';
import { TICK_HZ, COUNTDOWN_TICKS } from '../constants';
import type { Tank, Vec2, Wall } from '../types';
import type { World } from '../world';

// ---------------------------------------------------------------------------
// The REACTION gate: reactionTime consumed. An enemy must HOLD a firing
// solution (decision.hasSolution -> tank.aimTicks, dispatcher-accumulated) for
// its profile's reactionTime before the dispatcher lets a shot off. These tests
// pin the clock's build-up, its reset on cover, its independence from grey's
// dodge suppression, and its per-kind data-drivenness. Mutation-proven:
// removing the gate fires on tick 1; removing the reset survives cover.
// ---------------------------------------------------------------------------

function tank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}
function world(tanks: Tank[], over: Partial<World> = {}): World {
  return {
    tick: 0, nextId: 100, seed: 5, tanks, bullets: [], mines: [], blasts: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: -100000,
    unarmedTrigger: 'none', corpseBlocksShells: false, muzzleClearsTanks: true, coopAttempts: true, mode: 'campaign-coop', friendlyFire: false, ...over,
  };
}
const ticksFor = (kind: Tank['kind']) => Math.round(configFor(kind).ai.reactionTime * TICK_HZ);

describe('the reaction gate holds the first shot for the profile reaction span', () => {
  it('grey: silent through tick reactionTicks-1, fires ON the reactionTicks-th held tick', () => {
    // DEFENSIVE_BASIC reactionTime 0.7 -> 42 ticks. stepAi is called directly
    // (bullets never advance), so LOS holds continuously by construction.
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([grey, player]);
    const rt = ticksFor('grey');
    expect(rt).toBe(42); // the shipped derivation; a profile retune moves this deliberately
    for (let i = 1; i < rt; i++) {
      stepAi(w, []);
      expect(w.bullets, `tick ${i}`).toHaveLength(0);
      expect(w.tanks[0].aimTicks).toBe(i); // the clock is running
    }
    stepAi(w, []);
    expect(w.bullets).toHaveLength(1); // the 42nd held tick is the first legal shot
  });

  it('losing the solution RESETS the clock: cover means starting over', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([grey, player]);
    for (let i = 0; i < 30; i++) stepAi(w, []); // 30 of 42 held
    expect(w.tanks[0].aimTicks).toBe(30);
    // A wall drops between them for one tick: solution lost, clock zeroed.
    const cover: Wall = { id: 9, aabb: { minX: 2, minY: -1, maxX: 3, maxY: 1 }, kind: 'solid', destroyed: false };
    w.walls.push(cover);
    stepAi(w, []);
    expect(w.tanks[0].aimTicks).toBe(0);
    // Cover lifts: the full span is owed again -- 30 banked ticks bought nothing.
    w.walls.length = 0;
    for (let i = 0; i < ticksFor('grey') - 1; i++) stepAi(w, []);
    expect(w.bullets).toHaveLength(0);
    stepAi(w, []);
    expect(w.bullets).toHaveLength(1);
  });

  it("grey's dodge suppression does not stop the clock: patience and reaction are independent", () => {
    // A threat bullet parked in the corridor suppresses FIRE (patience) but the
    // player stays visible, so hasSolution stays true and aimTicks keeps
    // climbing -- when patience runs out at 45, reaction (42) is already paid
    // and grey fires on the patience boundary, not 42 ticks later.
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 20, y: 0 });
    const w = world([grey, player], {
      bullets: [{ id: 999, ownerId: 2, type: 'normal', pos: { x: -1, y: 0 }, vel: { x: 5, y: 0 }, bouncesLeft: 1, alive: true }],
    });
    for (let i = 0; i < 44; i++) stepAi(w, []);
    expect(w.bullets.filter((b) => b.ownerId === 1)).toHaveLength(0); // still patient
    expect(w.tanks[0].aimTicks).toBe(44); // but the reaction clock never stopped
    stepAi(w, []); // patience boundary (45)
    expect(w.bullets.filter((b) => b.ownerId === 1)).toHaveLength(1);
  });

  it("brown's clock is wired too: first shot ON held tick 50 (gate 48 + state machine)", () => {
    // Review found brown's hasSolution unpinned: a brown that never fires all
    // game survived every suite (the other stepAi fixtures wear the reaction
    // override, and nothing asserted the field). This pins the wiring at the
    // exact combined latency: the gate opens at 48 (0.8s), but brown's state
    // machine proposes fire only on ticks == 2 (mod 4) of continuous LOS, so
    // the first proposing tick past 48 is 50 -- re-derived and measured in
    // review. "0.8s" is the GATE span; 50 ticks is brown's true first-shot
    // latency. Fails if hasSolution stops being los, or the machine changes.
    const brown = tank(1, 'brown', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([brown, player]);
    for (let i = 1; i <= 49; i++) {
      stepAi(w, []);
      expect(w.bullets, `tick ${i}`).toHaveLength(0);
    }
    expect(w.tanks[0].aimTicks).toBe(49); // the clock ran the whole time
    stepAi(w, []);
    expect(w.bullets).toHaveLength(1);
  });

  it("a teammate crossing teal's lane holds the trigger but NOT the clock", () => {
    // Review measured teal's clock zeroing on a teammate crossing (grey kept 60
    // held ticks on identical geometry) -- against hasSolution's documented
    // meaning of "line of sight / a bank path". Now the raw solution keeps the
    // clock while shotHitsOwnSide holds only the trigger.
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const mate = tank(3, 'brown', { x: 2.5, y: 0 }); // parked on the firing lane
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([teal, mate, player]);
    for (let i = 0; i < 60; i++) stepAi(w, []);
    expect(w.bullets.filter((b) => b.ownerId === 1)).toHaveLength(0); // trigger held
    expect(w.tanks[0].aimTicks).toBe(60); // clock never reset
  });

  it('per-kind and data-driven: teal (0.6s) fires 6 ticks before grey (0.7s) would', () => {
    // Same geometry, different profile: the gate reads the RESOLVED config.
    // Breaks if the dispatcher hardcodes a span or reads the wrong kind's.
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([teal, player]);
    const rt = ticksFor('teal');
    expect(rt).toBe(36);
    for (let i = 0; i < rt - 1; i++) stepAi(w, []);
    expect(w.bullets).toHaveLength(0);
    stepAi(w, []);
    expect(w.bullets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ISSUE #367: countdown observation must not SATISFY the reaction delay.
//
// Every case above builds its world with `roundStartTick: -100000` -- permanently
// live -- so none of them can see the round-opening question at all. These build a
// real countdown instead, and advance `world.tick` by hand because `stepAi` does not
// (in production `step` increments the tick before running the pipeline, which is why
// `roundPhase` reads `tick - roundStartTick` and the first simulated tick sees 0).
// ---------------------------------------------------------------------------
describe('the reaction clock starts at LIVE acquisition, not at countdown acquisition (#367)', () => {
  /** A countdown-opening world: the round's first simulated tick is tick 0. */
  function opening(tanks: Tank[]): World {
    return world(tanks, { tick: 0, roundStartTick: 0 });
  }
  /** One dispatcher tick, then the tick advance `step` would have made. */
  function tickOn(w: World): void {
    stepAi(w, []);
    w.tick += 1;
  }

  it('holds the clock at zero through the whole countdown, with an unbroken solution', () => {
    // Teal has line of sight for all 180 countdown ticks -- the exact fixture the
    // shipped behaviour was measured on ("teal holding 180 countdown ticks on arena 1
    // and firing 1 tick into live"). The clock must not have banked any of them.
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = opening([teal, player]);
    expect(roundPhase(w)).toBe('countdown');
    for (let t = 0; t < COUNTDOWN_TICKS; t++) {
      tickOn(w);
      expect(w.tanks[0].aimTicks, `countdown tick ${t}`).toBe(0);
    }
    expect(roundPhase(w)).toBe('live');
    expect(w.bullets, 'nobody fires during the countdown').toHaveLength(0);
  });

  it('the first live tick is not a legal shot: the earliest one is reactionTicks into live', () => {
    // The acceptance criterion, stated as the two ticks that decide it. Before #367
    // this fired on live tick 1; the negative control is reverting the phase term in
    // the dispatcher's clock, which makes the FIRST assertion below fail immediately.
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = opening([teal, player]);
    for (let t = 0; t < COUNTDOWN_TICKS; t++) tickOn(w);

    const rt = ticksFor('teal');
    expect(rt).toBe(36); // the shipped derivation; a profile retune moves this deliberately
    for (let i = 1; i < rt; i++) {
      tickOn(w);
      expect(w.bullets, `live tick ${i}`).toHaveLength(0);
      expect(w.tanks[0].aimTicks).toBe(i); // ...and the clock is running NOW
    }
    tickOn(w);
    expect(w.bullets).toHaveLength(1); // the 36th LIVE held tick, not the 36th held tick
  });

  it('the same holds for a DIRECT shooter, not only the bank-shot profile', () => {
    // Teal is the bank-shot kind and carries the cases above because it is the one the
    // defect was measured on. The gate is one shared assignment in the dispatcher, so it
    // cannot be kind-specific by construction -- but "cannot by construction" is the kind
    // of claim this repo asks to be measured, and the issue's acceptance names direct and
    // bank-shot enemies separately. Grey is the direct one, with a longer span (0.7s).
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = opening([grey, player]);
    for (let t = 0; t < COUNTDOWN_TICKS; t++) tickOn(w);
    expect(w.tanks[0].aimTicks, 'grey banked the countdown').toBe(0);

    const rt = ticksFor('grey');
    expect(rt).toBe(42);
    for (let i = 1; i < rt; i++) {
      tickOn(w);
      expect(w.bullets, `live tick ${i}`).toHaveLength(0);
    }
    tickOn(w);
    expect(w.bullets).toHaveLength(1);
  });

  it('turret tracking still happens during the countdown -- the telegraph is preserved', () => {
    // The half of the shipped behaviour issue #367 keeps: the gun visibly follows the
    // player through the countdown, so the shot at the bell is announced rather than
    // hidden. Fails if the fix is implemented by suppressing the whole decision during
    // countdown instead of only the clock.
    const teal = tank(1, 'teal', { x: 0, y: 0, }, { turretAngle: Math.PI });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = opening([teal, player]);
    const before = w.tanks[0].turretAngle;
    for (let t = 0; t < COUNTDOWN_TICKS; t++) tickOn(w);
    expect(w.tanks[0].turretAngle, 'the turret never moved').not.toBe(before);
    // ...and it moved TOWARDS the player (angle 0), not merely somewhere.
    expect(Math.abs(w.tanks[0].turretAngle)).toBeLessThan(Math.abs(before));
  });

  it('applies again after a full-arena restart, not only at the first round', () => {
    // `resetArena` re-anchors `roundStartTick` and zeroes `aimTicks`, so a respawn
    // countdown is the same situation as the opening one. Modelled here by moving the
    // anchor forward, which is what that reset does.
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([teal, player], { tick: 5000, roundStartTick: -100000 });
    for (let i = 0; i < 40; i++) tickOn(w); // live: the clock banks freely
    expect(w.tanks[0].aimTicks).toBe(40);

    w.roundStartTick = w.tick; // the restart's countdown begins
    w.tanks[0].aimTicks = 0; // ...which resetArena does too (world.ts)
    for (let t = 0; t < COUNTDOWN_TICKS; t++) {
      tickOn(w);
      expect(w.tanks[0].aimTicks, `restart countdown tick ${t}`).toBe(0);
    }
    tickOn(w);
    expect(w.tanks[0].aimTicks).toBe(1); // and starts over from live acquisition
  });
});
