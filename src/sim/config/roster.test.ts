import { describe, it, expect } from 'vitest';
import {
  bulletConfig,
  DODGE_PATIENCE_TICKS,
  FIRE_COOLDOWN_TICKS,
  MINE_CAP,
  SHELL_CAP,
  TANK_SPEED,
  TANK_TURN_RATE,
  TICK_HZ,
} from '../constants';
import type { TankKind } from '../types';
import { configFor, hasAbility } from './roster';
import { AIBehavior, TankAbility } from './enums';

// The shipped kinds. `player` is included because the player is now resolved through
// the same pipeline (its weapon/movement/mine-capacity all come from configFor).
const KINDS: TankKind[] = ['player', 'brown', 'grey', 'teal', 'olive'];

// The colours the renderer shipped before this refactor (entities.ts TANK_COLORS, as
// 0x hex). config.color must reproduce them exactly, or the tanks change colour.
const SHIPPED_COLORS: Record<TankKind, string> = {
  player: '#3d7bd6',
  brown: '#8a5a2b',
  grey: '#8890a0',
  teal: '#2bb0a6',
  olive: '#7a8f3c', // new with the kind itself: no prior render literal to reproduce
};

describe('game roster resolves to the shipped tunables (behaviour-preservation pins)', () => {
  // These pins are the whole safety argument for the refactor: the sim now reads
  // configFor(kind) where it used to read a global constant, so the resolved value
  // MUST equal that constant for every kind or behaviour shifts. Each assertion
  // fails if the roster/balance is authored with a different class or number.

  // The uniform era ended with the 2026-07-31 balance pass: Brown turns and fires
  // slowly, Teal creeps but fires fast. Pinned PER KIND now -- retuning the roster
  // means updating the entry here too, exactly the balance.json contract.
  it('movement speed: uniform TANK_SPEED except Teal, who creeps', () => {
    for (const k of ['player', 'brown', 'grey'] as const) {
      expect(configFor(k).movementSpeed).toBe(TANK_SPEED);
    }
    expect(configFor('teal').movementSpeed).toBeCloseTo(TANK_SPEED * 0.6, 9);
  });

  it('rotation speed: player and grey at TANK_TURN_RATE; brown and teal slow', () => {
    for (const k of ['player', 'grey'] as const) {
      expect(configFor(k).rotationSpeed).toBe(TANK_TURN_RATE);
    }
    for (const k of ['brown', 'teal'] as const) {
      expect(configFor(k).rotationSpeed).toBeCloseTo(TANK_TURN_RATE * 0.6, 9);
    }
  });

  it('fire cooldown: player and grey at FIRE_COOLDOWN_TICKS; brown slow, teal fast', () => {
    for (const k of ['player', 'grey'] as const) {
      expect(configFor(k).weapon.fireCooldown).toBe(FIRE_COOLDOWN_TICKS);
    }
    // Measured from the resolved FireRate enums on 2026-07-31: SLOW = 38 ticks
    // (~0.63s), FAST = 14 (~0.23s). Integers, because cooldowns are counted in ticks.
    expect(configFor('brown').weapon.fireCooldown).toBe(38);
    expect(configFor('teal').weapon.fireCooldown).toBe(14);
  });

  it('shell cap and mine capacity: SHELL_CAP/MINE_CAP everywhere except olive', () => {
    for (const k of ['player', 'brown', 'grey', 'teal'] as const) {
      expect(configFor(k).weapon.maxActiveProjectiles).toBe(SHELL_CAP);
      expect(configFor(k).mineCapacity).toBe(MINE_CAP);
    }
    // Olive is the first kind with a genuinely PER-TANK cap: one rocket in
    // flight at a time (its whole rhythm -- a slow, telegraphed lance), and no
    // mines at all. Raising either is a gameplay change, not a tidy-up.
    expect(configFor('olive').weapon.maxActiveProjectiles).toBe(1);
    expect(configFor('olive').mineCapacity).toBe(0);
  });

  it('projectile speed/bounces mirror the sim bulletConfig for the resolved bullet type', () => {
    for (const k of KINDS) {
      const w = configFor(k).weapon;
      expect(w.speed).toBe(bulletConfig[w.bulletType].speed);
      // ricochetCount is carried per-tank; it must equal the sim's per-BulletType
      // bounce table, or a tank's shells would bounce a different number of times
      // than the bullet system actually grants them.
      expect(w.ricochetCount).toBe(bulletConfig[w.bulletType].bounces);
    }
  });
});

describe('per-kind identity comes from config, not code branches', () => {
  it('teal fires ricochet; brown/grey/player fire normal shells', () => {
    expect(configFor('teal').weapon.bulletType).toBe('ricochet');
    expect(configFor('brown').weapon.bulletType).toBe('normal');
    expect(configFor('grey').weapon.bulletType).toBe('normal');
    expect(configFor('player').weapon.bulletType).toBe('normal');
  });

  it('MINE_LAYER is held by exactly the kinds that lay mines today (grey/teal/player, not brown)', () => {
    expect(hasAbility('brown', TankAbility.MINE_LAYER)).toBe(false);
    expect(hasAbility('grey', TankAbility.MINE_LAYER)).toBe(true);
    expect(hasAbility('teal', TankAbility.MINE_LAYER)).toBe(true);
    expect(hasAbility('player', TankAbility.MINE_LAYER)).toBe(true);
  });

  it('reproduces the shipped render colours exactly', () => {
    for (const k of KINDS) expect(configFor(k).color).toBe(SHIPPED_COLORS[k]);
  });

  it('routes each kind to its shipped behaviour class (decideAi dispatches on this)', () => {
    // Changing any of these re-routes the kind to a DIFFERENT decision function --
    // a gameplay change, so it must be a deliberate two-file edit (roster + here).
    expect(configFor('brown').behavior).toBe(AIBehavior.STATIONARY);
    expect(configFor('grey').behavior).toBe(AIBehavior.DEFENSIVE);
    expect(configFor('teal').behavior).toBe(AIBehavior.TACTICAL);
  });

  it("grey's profile-derived dodge patience equals the tuned DODGE_PATIENCE_TICKS", () => {
    // greyDecision computes patience as (1 - ai.aggression) * TICK_HZ. This pin is
    // what makes retuning DEFENSIVE_BASIC.aggression a loud edit instead of a
    // silent difficulty change: 45 ticks was measured/tuned, not incidental.
    const derived = Math.round((1 - configFor('grey').ai.aggression) * TICK_HZ);
    expect(derived).toBe(DODGE_PATIENCE_TICKS);
  });

  it('mine inclination (minePlacementChance sign) matches who lays mines today', () => {
    // The decision functions propose mines only when the profile carries a positive
    // minePlacementChance; brown must stay inert on both this and the ability gate.
    expect(configFor('grey').ai.minePlacementChance ?? 0).toBeGreaterThan(0);
    expect(configFor('teal').ai.minePlacementChance ?? 0).toBeGreaterThan(0);
    expect(configFor('brown').ai.minePlacementChance ?? 0).toBe(0);
  });

  it("teal's profile keeps both shot types active (positive direct AND bank weights)", () => {
    // tryDirect/tryBank are gated on these signs; zeroing either would silently
    // delete a whole shot type from the shipped game.
    expect(configFor('teal').ai.directShotWeight).toBeGreaterThan(0);
    expect(configFor('teal').ai.bankShotWeight).toBeGreaterThan(0);
  });

  it("olive, the rocket debut: every stat the level-3 design depends on", () => {
    // The first kind added purely as data (PR: rocket tank + level 3). Each line
    // is a design decision: SLOW chassis (a deliberate, creeping siege tank),
    // SLOW fire but a 'fast' 12 u/s no-bounce rocket, one in flight at a time,
    // no mines, DEFENSIVE routing (grey's implementation drives it).
    const o = configFor('olive');
    expect(o.behavior).toBe(AIBehavior.DEFENSIVE);
    expect(o.weapon.bulletType).toBe('fast');
    expect(o.weapon.speed).toBe(bulletConfig.fast.speed);
    expect(o.weapon.ricochetCount).toBe(bulletConfig.fast.bounces);
    expect(o.movementSpeed).toBeCloseTo(TANK_SPEED * 0.6, 9);
    expect(o.rotationSpeed).toBeCloseTo(TANK_TURN_RATE * 0.6, 9);
    expect(o.weapon.fireCooldown).toBe(38); // SLOW, same tick count pinned for brown
    expect(hasAbility('olive', TankAbility.MINE_LAYER)).toBe(false);
    expect(o.ai.minePlacementChance ?? 0).toBe(0);
  });

  it('parses to the exact 0xRRGGBB numbers the renderer used to hardcode', () => {
    // entities.ts renders `parseInt(configFor(kind).color.slice(1), 16)`. Pinning the
    // NUMBER (not just the string) locks the value THREE actually receives to the old
    // TANK_COLORS literals -- the one migrated value whose consumed form is otherwise
    // only asserted as a string. Mirrors the render expression exactly.
    const asNumber = (k: TankKind) => parseInt(configFor(k).color.slice(1), 16);
    expect(asNumber('player')).toBe(0x3d7bd6);
    expect(asNumber('brown')).toBe(0x8a5a2b);
    expect(asNumber('grey')).toBe(0x8890a0);
    expect(asNumber('teal')).toBe(0x2bb0a6);
  });
});
