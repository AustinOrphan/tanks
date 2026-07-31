import { describe, it, expect } from 'vitest';
import { resolveTankConfig } from './resolve';
import { GAME_BALANCE } from './balance';
import {
  AIProfile,
  FireRate,
  MovementSpeed,
  ProjectileType,
  RotationSpeed,
  TankType,
} from './enums';
import type { BalanceConstants, TankDefinition, TankDefinitionMap } from './types';
import refDefsRaw from './reference/tank-types.json';
import refBalanceRaw from './reference/balance-constants.json';

function def(over: Partial<TankDefinition>): TankDefinition {
  return {
    displayName: 'X', color: '#000000', firstMission: 1, singlePlayerOnly: false,
    movementSpeed: MovementSpeed.MEDIUM, rotationSpeed: RotationSpeed.MEDIUM,
    aiProfile: refBalanceKeyedProfile(),
    weapon: { projectileType: ProjectileType.STANDARD_SHELL, fireRate: FireRate.MEDIUM, maxActiveProjectiles: 1, ricochetCount: 1 },
    mineCapacity: 0, abilities: [], ...over,
  };
}
// Any profile that exists in GAME_BALANCE; the resolver only needs it to be present.
function refBalanceKeyedProfile() {
  return Object.keys(GAME_BALANCE.aiProfiles)[0] as TankDefinition['aiProfile'];
}

describe('resolveTankConfig', () => {
  it('maps each ProjectileType onto the sim BulletType the shell systems use', () => {
    const defs = {
      A: def({ weapon: { projectileType: ProjectileType.STANDARD_SHELL, fireRate: FireRate.MEDIUM, maxActiveProjectiles: 1, ricochetCount: 1 } }),
      B: def({ weapon: { projectileType: ProjectileType.ROCKET, fireRate: FireRate.MEDIUM, maxActiveProjectiles: 1, ricochetCount: 0 } }),
      C: def({ weapon: { projectileType: ProjectileType.RICOCHET_ROCKET, fireRate: FireRate.MEDIUM, maxActiveProjectiles: 1, ricochetCount: 3 } }),
    };
    expect(resolveTankConfig('A', defs, GAME_BALANCE).weapon.bulletType).toBe('normal');
    expect(resolveTankConfig('B', defs, GAME_BALANCE).weapon.bulletType).toBe('fast');
    expect(resolveTankConfig('C', defs, GAME_BALANCE).weapon.bulletType).toBe('ricochet');
  });

  it('pulls speed from the projectile table and cooldown from the fire-rate table', () => {
    const defs = { A: def({ weapon: { projectileType: ProjectileType.ROCKET, fireRate: FireRate.FAST, maxActiveProjectiles: 2, ricochetCount: 0 } }) };
    const r = resolveTankConfig('A', defs, GAME_BALANCE);
    expect(r.weapon.speed).toBe(GAME_BALANCE.projectiles[ProjectileType.ROCKET].speed);
    expect(r.weapon.fireCooldown).toBe(GAME_BALANCE.fireCooldowns[FireRate.FAST]);
    expect(r.weapon.maxActiveProjectiles).toBe(2);
  });

  it('throws on an unknown key rather than resolving a partial config', () => {
    const defs: Record<string, TankDefinition> = { A: def({}) };
    expect(() => resolveTankConfig('nope', defs, GAME_BALANCE)).toThrow(/Unknown tank key/);
  });

  it('throws on a missing class in ANY balance table -- never a silent undefined stat', () => {
    // The Record<> types cannot protect the JSON path (reference data enters via
    // `as` casts), so the resolver guards every lookup. The surviving edit this
    // kills: deleting a class key from a balance JSON used to resolve that stat
    // to undefined with the suite green.
    const defs: Record<string, TankDefinition> = { A: def({}) };
    const strip = (mutate: (b: BalanceConstants) => void): BalanceConstants => {
      const broken = structuredClone(GAME_BALANCE);
      mutate(broken);
      return broken;
    };
    expect(() => resolveTankConfig('A', defs,
      strip((b) => { delete (b.movementSpeeds as Record<string, number>)[MovementSpeed.MEDIUM]; }),
    )).toThrow(/Unknown movement speed class/);
    expect(() => resolveTankConfig('A', defs,
      strip((b) => { delete (b.rotationSpeeds as Record<string, number>)[RotationSpeed.MEDIUM]; }),
    )).toThrow(/Unknown rotation speed class/);
    expect(() => resolveTankConfig('A', defs,
      strip((b) => { delete (b.fireCooldowns as Record<string, number>)[FireRate.MEDIUM]; }),
    )).toThrow(/Unknown fire rate class/);
  });

  it('rejects a mine-inclined profile on a definition without MINE_LAYER', () => {
    // A tank whose profile wants mines but whose definition cannot lay them would
    // propose mines every tick that the dispatcher silently discards -- an
    // authoring mistake with no loud failure anywhere downstream, so the resolver
    // is where it must die.
    const defs: Record<string, TankDefinition> = {
      A: def({ aiProfile: AIProfile.MOBILE_MINE_LAYER, abilities: [] }),
    };
    expect(() => resolveTankConfig('A', defs, GAME_BALANCE)).toThrow(/MINE_LAYER/);
  });

  it('resolved ai is a copy: mutating it cannot rewrite the balance table', () => {
    // Without the copy, configs of two kinds sharing a profile hold ONE object,
    // and a stray write corrupts global balance for every later resolve.
    const defs: Record<string, TankDefinition> = { A: def({ aiProfile: AIProfile.STATIC_BASIC }) };
    const before = GAME_BALANCE.aiProfiles[AIProfile.STATIC_BASIC].aggression;
    const r = resolveTankConfig('A', defs, GAME_BALANCE);
    r.ai.aggression = 0.999;
    expect(GAME_BALANCE.aiProfiles[AIProfile.STATIC_BASIC].aggression).toBe(before);
    expect(resolveTankConfig('A', defs, GAME_BALANCE).ai.aggression).toBe(before);
  });

  it('copies abilities (a mutation of the result cannot bleed into the definition)', () => {
    const defs = { A: def({ abilities: [] }) };
    const r = resolveTankConfig('A', defs, GAME_BALANCE);
    r.abilities.push('X' as never);
    expect(defs.A.abilities).toHaveLength(0);
  });
});

// The pipeline is meant to generalise past the shipped 4-kind roster. Proving it on
// the untouched 9-type Wii reference data is what makes "add a tank as data" real:
// the same resolver, run over reference/*.json, yields a full config for every type.
describe('generalises to the 9-type Wii reference taxonomy', () => {
  const refDefs = refDefsRaw as unknown as TankDefinitionMap;
  const refBalance = refBalanceRaw as unknown as BalanceConstants;

  it('resolves every reference TankType fully -- every numeric stat present', () => {
    for (const t of Object.values(TankType)) {
      const r = resolveTankConfig(t, refDefs, refBalance);
      expect(r.displayName.length).toBeGreaterThan(0);
      // ALL class-derived numbers, not a sample: before the resolver guarded
      // every table, deleting e.g. VERY_FAST from rotationSpeeds resolved
      // BLACK's rotation to a silent undefined and this test stayed green.
      expect(typeof r.movementSpeed).toBe('number');
      expect(typeof r.rotationSpeed).toBe('number');
      expect(typeof r.weapon.fireCooldown).toBe('number');
      expect(typeof r.weapon.speed).toBe('number');
      expect(r.weapon.bulletType).toBeDefined();
    }
  });

  it('resolves RED to its reference stats (FAST move, 3-shell standard cannon)', () => {
    const red = resolveTankConfig(TankType.RED, refDefs, refBalance);
    expect(red.movementSpeed).toBe(refBalance.movementSpeeds[MovementSpeed.FAST]);
    expect(red.weapon.bulletType).toBe('normal');
    expect(red.weapon.maxActiveProjectiles).toBe(3);
  });
});
