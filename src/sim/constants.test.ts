import { describe, it, expect } from 'vitest';
import {
  bulletConfig, DT, TICK_HZ, SHELL_CAP, MINE_CAP,
  NORMAL_BOUNCES, FAST_BOUNCES, RICOCHET_BOUNCES, LIVES,
  PLAYER_TURRET_TURN_RATE, AI_TURRET_TURN_RATE,
  TANK_RADIUS, TANK_SPEED, TANK_TURN_RATE, BULLET_RADIUS, MINE_TRIGGER_RADIUS,
  NORMAL_SPEED, FAST_SPEED, RICOCHET_SPEED,
  FIRE_COOLDOWN, MINE_COOLDOWN,
  MINE_TIMER, MINE_PROXIMITY_RADIUS, MINE_BLAST_RADIUS,
  AI_AIM_SPREAD,
} from './constants';
import type { BulletType } from './types';

// WHY THE LITERAL PINS BELOW EXIST.
//
// Every behavioural test in this suite expresses its geometry IN TERMS OF these
// constants -- a mine test places a victim at `MINE_BLAST_RADIUS + TANK_RADIUS -
// 0.1` and asserts it dies. That is the right way to write those tests (they
// stay meaningful when a value is deliberately retuned), but it means the whole
// suite FLOATS with the constant: a mutation audit changed MINE_BLAST_RADIUS
// 2.0 -> 3.0, MINE_PROXIMITY_RADIUS 1.5 -> 1.0, MINE_TIMER 3.0 -> 6.0,
// MINE_COOLDOWN 0.5 -> 0, AI_AIM_SPREAD 0.08 -> 0.5 and BULLET_RADIUS 0.1 ->
// 1.0, and all 313 tests stayed green. Doubling the blast radius makes mines an
// arena-wide instakill; zeroing the mine cooldown makes them a machine gun;
// AI_AIM_SPREAD 0.5 (~29 degrees) makes every enemy harmless. Those are
// game-defining changes that no test noticed.
//
// This file is the one place that must NOT float: it pins each tunable to its
// spec literal, so retuning a value is a deliberate two-file edit (the JSON
// entry in config/data/balance.json -- the authoritative home the constants now
// derive from -- and its pin here) rather than a silent one. The citation on
// each line is the authority the number comes from.

describe('constants', () => {
  it('DT is the reciprocal of the tick rate', () => {
    expect(TICK_HZ).toBe(60);
    expect(DT).toBeCloseTo(1 / 60, 12);
  });

  it('carries the spec default caps and lives (caps apply to every tank, player and AI)', () => {
    expect(SHELL_CAP).toBe(5);
    expect(MINE_CAP).toBe(2);
    expect(LIVES).toBe(3);
  });

  it('carries the spec default tank and bullet geometry/speeds', () => {
    // docs/superpowers/plans/2026-07-22-tanks-vertical-slice.md, task 3
    // "Produces (the single home for all tunable numbers, spec section 4 defaults)":
    //   TANK_RADIUS = 0.5, TANK_SPEED = 3.0
    //   BULLET_RADIUS = 0.1
    //   NORMAL_SPEED = 6, FAST_SPEED = 12, RICOCHET_SPEED = 6
    expect(TANK_RADIUS).toBe(0.5);
    expect(TANK_SPEED).toBe(3.0);
    expect(BULLET_RADIUS).toBe(0.1);
    expect(NORMAL_SPEED).toBe(6);
    expect(FAST_SPEED).toBe(12);
    expect(RICOCHET_SPEED).toBe(6);
  });

  it('carries the spec default cooldowns in seconds', () => {
    // Same plan section: `FIRE_COOLDOWN = 0.4`, `MINE_COOLDOWN = 0.5`.
    // MINE_COOLDOWN -> 0 turns the mine cap into the only limit on laying
    // mines, which the design calls "a resource, not a carpet"
    // (docs/superpowers/specs/2026-07-22-tanks-design.md, section 4).
    expect(FIRE_COOLDOWN).toBe(0.4);
    expect(MINE_COOLDOWN).toBe(0.5);
  });

  it('carries the spec default mine timer and radii', () => {
    // Same plan section: `MINE_TIMER = 3.0`, `MINE_PROXIMITY_RADIUS = 1.5`,
    // `MINE_BLAST_RADIUS = 2.0`; spec section 4 "Mine detonation | ~3s timer OR
    // proximity trigger".
    expect(MINE_TIMER).toBe(3.0);
    expect(MINE_PROXIMITY_RADIUS).toBe(1.5);
    expect(MINE_BLAST_RADIUS).toBe(2.0);
    // The shell-trap radius (see its comment in constants.ts: the mine's BODY,
    // twenty times smaller than the blast). Unpinned until the JSON inversion
    // review: 20 of 22 balance.json values had pins, this and TANK_TURN_RATE
    // did not -- so retuning them was a silent one-file edit.
    expect(MINE_TRIGGER_RADIUS).toBe(0.35);
  });

  it('the blast reaches strictly farther than the proximity trigger', () => {
    // Not a restatement of the literals above: this ORDERING is what makes a
    // mine a threat rather than a nuisance. Anything close enough to trip the
    // mine (1.5) is inside the blast (2.0, +TANK_RADIUS against the hull), so
    // a trigger is a kill. Inverting them would let tanks set mines off from
    // a safe distance and walk away, quietly making mines useless.
    expect(MINE_BLAST_RADIUS).toBeGreaterThan(MINE_PROXIMITY_RADIUS);
  });

  it('AI aim spread stays at the tuned difficulty value', () => {
    // src/sim/constants.ts documents this as "THE PRIMARY DIFFICULTY KNOB for
    // this slice": 0.08 rad ~= 4.6 degrees of jitter on every AI firing
    // solution. There is no behavioural test that can pin it -- the AI is meant
    // to miss sometimes -- so widening it to, say, 0.5 rad (~29 degrees) makes
    // every enemy harmless with the whole suite still green. Pin the literal.
    expect(AI_AIM_SPREAD).toBe(0.08);
  });

  it('bulletConfig covers every BulletType exhaustively', () => {
    const types: BulletType[] = ['normal', 'fast', 'ricochet'];
    for (const t of types) {
      expect(bulletConfig[t]).toBeDefined();
      expect(typeof bulletConfig[t].speed).toBe('number');
      expect(typeof bulletConfig[t].bounces).toBe('number');
    }
    expect(Object.keys(bulletConfig).sort()).toEqual([...types].sort());
  });

  it('bounce counts match the spec: fast=0, normal=1, ricochet=3', () => {
    expect(bulletConfig.fast.bounces).toBe(FAST_BOUNCES);
    expect(bulletConfig.normal.bounces).toBe(NORMAL_BOUNCES);
    expect(bulletConfig.ricochet.bounces).toBe(RICOCHET_BOUNCES);
    expect(FAST_BOUNCES).toBe(0);
    expect(NORMAL_BOUNCES).toBe(1);
    expect(RICOCHET_BOUNCES).toBe(3);
  });

  it('turret turn rates: player is faster (more responsive) than AI (more telegraphed)', () => {
    expect(PLAYER_TURRET_TURN_RATE).toBe(8.0);
    expect(AI_TURRET_TURN_RATE).toBe(2.5);
    expect(PLAYER_TURRET_TURN_RATE).toBeGreaterThan(AI_TURRET_TURN_RATE);
  });

  it('hull turn rate stays below the turrets it carries (feel, constants.ts)', () => {
    // 5.0 is a feel value (modelled on Wii Play from recollection) but the
    // ORDERING is design: a hull that outturns its own gun makes aiming while
    // moving feel like fighting the tank. Both the literal and the ordering are
    // pinned; the literal was one of the two unpinned balance.json values.
    expect(TANK_TURN_RATE).toBe(5.0);
    expect(TANK_TURN_RATE).toBeLessThan(PLAYER_TURRET_TURN_RATE);
  });
});
