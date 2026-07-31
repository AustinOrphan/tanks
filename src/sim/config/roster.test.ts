import { describe, it, expect } from 'vitest';
import {
  bulletConfig,
  FIRE_COOLDOWN_TICKS,
  MINE_CAP,
  SHELL_CAP,
  TANK_SPEED,
  TANK_TURN_RATE,
} from '../constants';
import type { TankKind } from '../types';
import { configFor, hasAbility } from './roster';
import { TankAbility } from './enums';

// The shipped kinds. `player` is included because the player is now resolved through
// the same pipeline (its weapon/movement/mine-capacity all come from configFor).
const KINDS: TankKind[] = ['player', 'brown', 'grey', 'teal'];

// The colours the renderer shipped before this refactor (entities.ts TANK_COLORS, as
// 0x hex). config.color must reproduce them exactly, or the tanks change colour.
const SHIPPED_COLORS: Record<TankKind, string> = {
  player: '#3d7bd6',
  brown: '#8a5a2b',
  grey: '#8890a0',
  teal: '#2bb0a6',
};

describe('game roster resolves to the shipped tunables (behaviour-preservation pins)', () => {
  // These pins are the whole safety argument for the refactor: the sim now reads
  // configFor(kind) where it used to read a global constant, so the resolved value
  // MUST equal that constant for every kind or behaviour shifts. Each assertion
  // fails if the roster/balance is authored with a different class or number.

  it('movement speed equals TANK_SPEED for every kind (the game is uniform today)', () => {
    for (const k of KINDS) expect(configFor(k).movementSpeed).toBe(TANK_SPEED);
  });

  it('rotation speed equals TANK_TURN_RATE for every kind', () => {
    for (const k of KINDS) expect(configFor(k).rotationSpeed).toBe(TANK_TURN_RATE);
  });

  it('fire cooldown equals FIRE_COOLDOWN_TICKS for every kind', () => {
    for (const k of KINDS) expect(configFor(k).weapon.fireCooldown).toBe(FIRE_COOLDOWN_TICKS);
  });

  it('shell cap equals SHELL_CAP and mine capacity equals MINE_CAP for every kind', () => {
    for (const k of KINDS) {
      expect(configFor(k).weapon.maxActiveProjectiles).toBe(SHELL_CAP);
      expect(configFor(k).mineCapacity).toBe(MINE_CAP);
    }
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
});
