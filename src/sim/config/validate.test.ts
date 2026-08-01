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
    // teal is NOT deleted: with it also missing, the missing-key loop fires first
    // and this test would pass on the wrong branch (found in review -- the
    // original fixture proved nothing its name claimed).
    const bad = corrupt(tankDefsJson, (c) => { c.tea1 = structuredClone(c.teal); });
    expect(() => validateTankDefinitions(bad)).toThrow(/unknown entry "tea1"/);
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

  // Review found 8 of 15 fail() sites had no control -- the exact overclaim the
  // header warns about. One control per previously-unproven site:

  it('rejects a non-string displayName (str)', () => {
    const bad = corrupt(tankDefsJson, (c) => { (c.brown as Mutable).displayName = 7; });
    expect(() => validateTankDefinitions(bad)).toThrow(/brown\.displayName.*string/);
  });

  it('rejects a non-boolean singlePlayerOnly (bool)', () => {
    const bad = corrupt(tankDefsJson, (c) => { (c.grey as Mutable).singlePlayerOnly = 'no'; });
    expect(() => validateTankDefinitions(bad)).toThrow(/grey\.singlePlayerOnly.*boolean/);
  });

  it('rejects a root that is not an object (null, array)', () => {
    expect(() => validateTankDefinitions(null)).toThrow(/root.*object/);
    expect(() => validateTankDefinitions([tankDefsJson])).toThrow(/root.*object/);
  });

  it('rejects a kind whose value is not an object', () => {
    const bad = corrupt(tankDefsJson, (c) => { c.teal = 'ricochet tank'; });
    expect(() => validateTankDefinitions(bad)).toThrow(/teal must be an object/);
  });

  it('rejects a weapon that is not an object', () => {
    const bad = corrupt(tankDefsJson, (c) => { (c.player as Mutable).weapon = null; });
    expect(() => validateTankDefinitions(bad)).toThrow(/player\.weapon must be an object/);
  });

  it('rejects abilities that are not an array', () => {
    const bad = corrupt(tankDefsJson, (c) => { (c.teal as Mutable).abilities = 'MINE_LAYER'; });
    expect(() => validateTankDefinitions(bad)).toThrow(/teal\.abilities must be an array/);
  });

  it('rejects fractional or negative counts (nonNegInt)', () => {
    const frac = corrupt(tankDefsJson, (c) => { ((c.grey as Mutable).weapon as Mutable).maxActiveProjectiles = 2.5; });
    expect(() => validateTankDefinitions(frac)).toThrow(/grey\.weapon\.maxActiveProjectiles.*non-negative integer/);
    const neg = corrupt(tankDefsJson, (c) => { (c.brown as Mutable).mineCapacity = -1; });
    expect(() => validateTankDefinitions(neg)).toThrow(/brown\.mineCapacity.*non-negative integer/);
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

  it('rejects a profiles root that is not an object, and a profile that is not an object', () => {
    expect(() => validateAiProfiles(42)).toThrow(/root.*object/);
    const bad = corrupt(aiProfilesJson, (c) => { c.STATIC_BASIC = 'lazy'; });
    expect(() => validateAiProfiles(bad)).toThrow(/STATIC_BASIC must be an object/);
  });

  it('rejects out-of-[0,1] chances/weights (unitInterval) -- aggression > 1 would make patience negative', () => {
    const bad = corrupt(aiProfilesJson, (c) => { (c.DEFENSIVE_BASIC as Mutable).aggression = 1.7; });
    expect(() => validateAiProfiles(bad)).toThrow(/DEFENSIVE_BASIC\.aggression.*\[0, 1\]/);
    const badW = corrupt(aiProfilesJson, (c) => { (c.RICOCHET_SNIPER as Mutable).bankShotWeight = -0.2; });
    expect(() => validateAiProfiles(badW)).toThrow(/RICOCHET_SNIPER\.bankShotWeight.*\[0, 1\]/);
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
