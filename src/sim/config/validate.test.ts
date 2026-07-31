import { describe, it, expect } from 'vitest';
import { TANK_KINDS, validateAiProfiles, validateTankDefinitions } from './validate';
import tankDefsJson from './data/tank-defs.json';
import aiProfilesJson from './data/ai-profiles.json';
import { AIProfile } from './enums';

// A guard is worth what its own tests prove (CLAUDE.md; the purity guard passed
// four of five known-bad probes before it got a meta-test). Every check the
// validator claims to make gets a NEGATIVE CONTROL here: a corrupted copy of the
// real data that must throw, with the message naming the corrupted path. The
// happy path is asserted against the shipped files, so the controls cannot pass
// vacuously against a fixture the game never loads.

type Mutable = Record<string, unknown>;
function corrupt<T>(raw: T, mutate: (copy: Mutable) => void): Mutable {
  const copy = structuredClone(raw) as Mutable;
  mutate(copy);
  return copy;
}

describe('validateTankDefinitions', () => {
  it('accepts the shipped tank-defs.json and returns it structurally intact', () => {
    const defs = validateTankDefinitions(tankDefsJson);
    expect(Object.keys(defs).sort()).toEqual([...TANK_KINDS].sort());
    expect(defs).toEqual(tankDefsJson); // validation is checking, not rewriting
  });

  it('rejects a missing kind (the JSON replacement for the Record<TankKind> compile error)', () => {
    const bad = corrupt(tankDefsJson, (c) => { delete c.teal; });
    expect(() => validateTankDefinitions(bad)).toThrow(/missing required entry "teal"/);
  });

  it('rejects an unknown kind (a typo cannot ship as a silently ignored tank)', () => {
    const bad = corrupt(tankDefsJson, (c) => { c.tea1 = c.teal; delete c.teal; });
    expect(() => validateTankDefinitions(bad)).toThrow(/"teal"|"tea1"/);
  });

  it('rejects an enum value outside the vocabulary, naming the path', () => {
    const bad = corrupt(tankDefsJson, (c) => {
      ((c.grey as Mutable).weapon as Mutable).fireRate = 'MEDIUMM';
    });
    expect(() => validateTankDefinitions(bad)).toThrow(/grey\.weapon\.fireRate.*MEDIUMM.*FireRate/);
  });

  it('rejects a wrong-typed field (string where number)', () => {
    const bad = corrupt(tankDefsJson, (c) => { (c.brown as Mutable).mineCapacity = '2'; });
    expect(() => validateTankDefinitions(bad)).toThrow(/brown\.mineCapacity.*finite number/);
  });

  it('rejects a colour the renderer could not parse (cssHex is #RRGGBB only)', () => {
    const bad = corrupt(tankDefsJson, (c) => { (c.player as Mutable).color = 'blue'; });
    expect(() => validateTankDefinitions(bad)).toThrow(/player\.color.*#RRGGBB/);
  });

  it('rejects junk inside abilities', () => {
    const bad = corrupt(tankDefsJson, (c) => {
      ((c.teal as Mutable).abilities as unknown[]).push('CLOAKING_DEVICE');
    });
    expect(() => validateTankDefinitions(bad)).toThrow(/teal\.abilities\[2\].*TankAbility/);
  });

  it('rejects an unknown field on a definition (schema drift dies loudly)', () => {
    const bad = corrupt(tankDefsJson, (c) => { (c.grey as Mutable).armour = 3; });
    expect(() => validateTankDefinitions(bad)).toThrow(/grey.*unknown entry "armour"/);
  });
});

describe('validateAiProfiles', () => {
  it('accepts the shipped ai-profiles.json, covering every AIProfile exactly', () => {
    const profiles = validateAiProfiles(aiProfilesJson);
    expect(Object.keys(profiles).sort()).toEqual([...Object.values(AIProfile)].sort());
    expect(profiles).toEqual(aiProfilesJson);
  });

  it('rejects a missing profile', () => {
    const bad = corrupt(aiProfilesJson, (c) => { delete c.BERSERKER_ROCKET; });
    expect(() => validateAiProfiles(bad)).toThrow(/missing required entry "BERSERKER_ROCKET"/);
  });

  it('rejects an unknown profile key', () => {
    const bad = corrupt(aiProfilesJson, (c) => { c.SNEAKY = c.STATIC_BASIC; });
    expect(() => validateAiProfiles(bad)).toThrow(/unknown entry "SNEAKY"/);
  });

  it('rejects a missing required field, naming profile and field', () => {
    const bad = corrupt(aiProfilesJson, (c) => { delete (c.RICOCHET_SNIPER as Mutable).aggression; });
    expect(() => validateAiProfiles(bad)).toThrow(/RICOCHET_SNIPER.*missing required entry "aggression"/);
  });

  it('rejects a behavior outside AIBehavior', () => {
    const bad = corrupt(aiProfilesJson, (c) => { (c.STATIC_BASIC as Mutable).behavior = 'CAMPING'; });
    expect(() => validateAiProfiles(bad)).toThrow(/STATIC_BASIC\.behavior.*CAMPING.*AIBehavior/);
  });

  it('rejects an unknown field on a profile', () => {
    const bad = corrupt(aiProfilesJson, (c) => { (c.OFFENSIVE_ELITE as Mutable).swagger = 1; });
    expect(() => validateAiProfiles(bad)).toThrow(/OFFENSIVE_ELITE.*unknown entry "swagger"/);
  });

  it('keeps minePlacementChance optional: profiles without it validate', () => {
    // STATIC_BASIC ships without the field; reaching here on the shipped file
    // (first test) already proves it, but pin the field's absence explicitly so
    // making it required is a deliberate edit, not a validator side effect.
    const profiles = validateAiProfiles(aiProfilesJson);
    expect('minePlacementChance' in profiles[AIProfile.STATIC_BASIC]).toBe(false);
    expect(profiles[AIProfile.DEFENSIVE_BASIC].minePlacementChance).toBe(0.3);
  });
});
