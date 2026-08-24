import { describe, it, expect } from 'vitest';
import { commitMove } from './commitment';
import {
  AI_COMMIT_HYSTERESIS_DOT, AI_COMMIT_EMERGENCY_DOT, AI_COMMIT_DODGE_ALIGN_DOT, TICK_HZ, TANK_RADIUS,
} from '../constants';
import { configFor } from '../config';
import type { ResolvedTankConfig } from '../config';
import type { Tank, Wall, Vec2 } from '../types';
import type { World } from '../world';

function tank(over: Partial<Tank> = {}): Tank {
  return {
    id: 1, kind: 'grey', pos: { x: 10, y: 10 }, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}

function world(over: Partial<World> = {}): World {
  return {
    tick: 0, nextId: 100, seed: 7, tanks: [], bullets: [], mines: [], blasts: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: 0, unarmedTrigger: 'none' as const,
    corpseBlocksShells: false, muzzleClearsTanks: true, coopAttempts: true,
    mode: 'campaign-coop', friendlyFire: false, ...over,
  };
}

const cfgWith = (commitmentTime: number): ResolvedTankConfig => ({
  ...configFor('grey'),
  ai: { ...configFor('grey').ai, commitmentTime },
});

const GREY = configFor('grey');
const EAST: Vec2 = { x: 1, y: 0 };
const WEST: Vec2 = { x: -1, y: 0 };
const NORTH: Vec2 = { x: 0, y: 1 };

/** A wall filling everything east of the tank, so an eastward step is blocked. */
function wallEastOf(t: Tank): Wall {
  return {
    id: 1,
    aabb: { minX: t.pos.x + TANK_RADIUS * 0.5, minY: -100, maxX: t.pos.x + 100, maxY: 100 },
    kind: 'solid',
    destroyed: false,
  };
}

describe('commitMove', () => {
  it('holds the committed direction against an opposing candidate, and counts down by one', () => {
    // The defect this closes: without the hold the candidate comes straight through and
    // the tank reverses on a single tick. Measured before this existed, grey reversed on
    // 13.93% of adjacent live-tick pairs under a shooting player (8712/62529, arena3).
    const t = tank({ aiIntent: EAST, aiIntentTicks: 5 });
    const r = commitMove(world(), t, GREY, WEST, null);
    expect(r.move).toEqual(EAST);
    expect(r.nextIntent).toEqual(EAST);
    expect(r.nextIntentTicks).toBe(4);
  });

  it('adopts the candidate and re-arms the span once the hold expires', () => {
    const t = tank({ aiIntent: EAST, aiIntentTicks: 0 });
    const r = commitMove(world(), t, cfgWith(0.2), WEST, null);
    expect(r.move).toEqual(WEST);
    expect(r.nextIntentTicks).toBe(Math.round(0.2 * TICK_HZ));
  });

  it('re-arms to a span derived from the profile, not a shared constant (AC3)', () => {
    // Two configs differing ONLY in commitmentTime must produce different windows, and
    // each must equal its own profile's derivation -- asserting against the formula
    // rather than a hardcoded number, so retuning the data cannot silently pass.
    const t = () => tank({ aiIntent: EAST, aiIntentTicks: 0 });
    const jumpy = commitMove(world(), t(), cfgWith(0.2), WEST, null).nextIntentTicks;
    const stubborn = commitMove(world(), t(), cfgWith(0.5), WEST, null).nextIntentTicks;
    expect(jumpy).toBe(Math.round(0.2 * TICK_HZ));
    expect(stubborn).toBe(Math.round(0.5 * TICK_HZ));
    expect(stubborn).toBeGreaterThan(jumpy);
  });

  it('keeps the held vector when an expiring span offers a near-equivalent candidate', () => {
    // Hysteresis. Inside the cone the two are THE SAME decision, so the held vector is
    // returned rather than nudged -- otherwise the AI churns its heading every window on
    // choices that differ by nothing a player could perceive.
    const nearlyEast: Vec2 = { x: Math.cos(0.2), y: Math.sin(0.2) }; // ~11.5 deg off
    expect(nearlyEast.x * EAST.x + nearlyEast.y * EAST.y).toBeGreaterThan(AI_COMMIT_HYSTERESIS_DOT);
    const t = tank({ aiIntent: EAST, aiIntentTicks: 0 });
    expect(commitMove(world(), t, GREY, nearlyEast, null).move).toEqual(EAST);
  });

  it('adopts a candidate just OUTSIDE the hysteresis cone', () => {
    // The negative control for the case above: without it, "keeps the held vector" would
    // also pass an implementation that never adopts anything at all.
    const wellOff: Vec2 = { x: Math.cos(1.0), y: Math.sin(1.0) }; // ~57 deg off
    expect(wellOff.x * EAST.x + wellOff.y * EAST.y).toBeLessThan(AI_COMMIT_HYSTERESIS_DOT);
    const t = tank({ aiIntent: EAST, aiIntentTicks: 0 });
    expect(commitMove(world(), t, GREY, wellOff, null).move).toEqual(wellOff);
  });

  it('breaks the hold immediately when the committed direction now walks into a wall', () => {
    // An emergency the tank cannot ride out: moveTank resolves a hull-vs-wall overlap by
    // pushing straight back out, so holding here nets exactly zero displacement and pins
    // the tank where it stands.
    const t = tank({ aiIntent: EAST, aiIntentTicks: 5 });
    const w = world({ walls: [wallEastOf(t)] });
    const r = commitMove(w, t, GREY, NORTH, null);
    expect(r.move).toEqual(NORTH);
    expect(r.nextIntentTicks).toBe(Math.round(GREY.ai.commitmentTime * TICK_HZ));
  });

  it('breaks the hold when a required MINE escape points more than 90 degrees away', () => {
    const t = tank({ aiIntent: EAST, aiIntentTicks: 5 });
    expect(WEST.x * EAST.x + WEST.y * EAST.y).toBeLessThan(AI_COMMIT_EMERGENCY_DOT);
    expect(commitMove(world(), t, GREY, WEST, WEST, 'mine').move).toEqual(WEST);
  });

  it('does NOT break a BULLET dodge merely because the named perpendicular flipped sides', () => {
    // The bug this pins was in the first version of this module, and only measuring found
    // it. dangerAvoidMove picks between two EXACT OPPOSITE perpendiculars by the side the
    // tank currently sits on, so the name it returns flips the instant the tank crosses
    // the shell's axis -- while both remain equally good ways out of the corridor. Testing
    // the SIGNED dot made that flip read as an emergency, so the hold broke on precisely
    // the oscillation it exists to stop: `bullet->bullet` rose from 40.6% to 68.5% of all
    // reversals under a shooting player and grey's P95 turn stayed at 180.0 degrees.
    const t = tank({ aiIntent: NORTH, aiIntentTicks: 5 });
    const flipped = { x: -0, y: -1 }; // the opposite perpendicular
    const r = commitMove(world(), t, GREY, flipped, flipped, 'bullet');
    expect(r.move).toEqual(NORTH);
    expect(r.nextIntentTicks).toBe(4);
  });

  it('DOES break a bullet dodge once the held heading stops being sideways at all', () => {
    // The negative control for the case above: sign-blind must not mean threat-blind. A
    // heading that has decayed to running along the shell's own line keeps almost none of
    // its perpendicular component, and that is a real emergency.
    const t = tank({ aiIntent: EAST, aiIntentTicks: 5 });
    expect(Math.abs(EAST.x * NORTH.x + EAST.y * NORTH.y)).toBeLessThan(AI_COMMIT_DODGE_ALIGN_DOT);
    expect(commitMove(world(), t, GREY, NORTH, NORTH, 'bullet').move).toEqual(NORTH);
  });

  it('does not let an expiring span adopt the flipped perpendicular either', () => {
    // The SECOND path by which the 180-degree flip survived the hold: even with
    // emergencies handled, every commitment expiry during a sustained dodge was free to
    // adopt the opposite perpendicular as a "new" decision. Hysteresis is sign-blind for
    // bullets for the same reason the emergency test is.
    const t = tank({ aiIntent: NORTH, aiIntentTicks: 0 });
    const flipped = { x: -0, y: -1 };
    expect(commitMove(world(), t, GREY, flipped, flipped, 'bullet').move).toEqual(NORTH);
  });

  it('does NOT break the hold for an escape only mildly off the committed heading', () => {
    // Issue #222: emergencies interrupt "without making every shell or wall contact an
    // immediate full reversal". This is the case that fails if the rule is written as
    // "any non-null avoid breaks the hold".
    //
    // Uses a MINE-shaped escape direction on purpose. The bullet branch of
    // dangerAvoidMove returns one of two exact opposite perpendiculars, so dot(held,
    // avoid) there is only ever ~+1 or ~-1 and can never land in this middle band --
    // written against a bullet fixture this test would assert on an unreachable state.
    const mildly: Vec2 = { x: Math.cos(0.6), y: Math.sin(0.6) }; // ~34 deg off
    const dot = mildly.x * EAST.x + mildly.y * EAST.y;
    expect(dot).toBeGreaterThan(AI_COMMIT_EMERGENCY_DOT);
    const t = tank({ aiIntent: EAST, aiIntentTicks: 5 });
    const r = commitMove(world(), t, GREY, mildly, mildly);
    expect(r.move).toEqual(EAST);
    expect(r.nextIntentTicks).toBe(4);
  });

  it('holds nothing for a stationary tank whose candidate is the zero vector', () => {
    // Brown hardcodes a zero desiredMove on every path. An intent it can never act on is
    // state that only misleads a reader -- and acquiring one would also make every
    // stationary tank pay the wall probe below for nothing.
    const r = commitMove(world(), tank({ kind: 'brown' }), configFor('brown'), { x: 0, y: 0 }, null);
    expect(r.move).toEqual({ x: 0, y: 0 });
    expect(r.nextIntent).toBeNull();
    expect(r.nextIntentTicks).toBe(0);
  });

  it('starts a fresh commitment when nothing is held yet', () => {
    const r = commitMove(world(), tank(), GREY, EAST, null);
    expect(r.move).toEqual(EAST);
    expect(r.nextIntent).toEqual(EAST);
    expect(r.nextIntentTicks).toBe(Math.round(GREY.ai.commitmentTime * TICK_HZ));
  });
});
