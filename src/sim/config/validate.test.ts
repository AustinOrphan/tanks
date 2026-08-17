import { describe, it, expect } from 'vitest';
import { TANK_KINDS, validateAiProfiles, validateArenaShape, validateArenas, validateCampaign, validateTankDefinitions } from './validate';
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

  it('rejects aimAccuracy 0 (profileAimSpread divides by it)', () => {
    const bad = corrupt(aiProfilesJson, (c) => { (c.STATIC_BASIC as Mutable).aimAccuracy = 0; });
    expect(() => validateAiProfiles(bad)).toThrow(/STATIC_BASIC\.aimAccuracy.*strictly positive/);
  });

  it('rejects estimationAccuracy 0 (profileHazardSpread divides by it)', () => {
    const bad = corrupt(aiProfilesJson, (c) => { (c.STATIC_BASIC as Mutable).estimationAccuracy = 0; });
    expect(() => validateAiProfiles(bad)).toThrow(/STATIC_BASIC\.estimationAccuracy.*strictly positive/);
  });

  it('rejects a profile missing estimationAccuracy -- it is required, not optional like minePlacementChance', () => {
    const bad = corrupt(aiProfilesJson, (c) => { delete (c.RICOCHET_SNIPER as Mutable).estimationAccuracy; });
    expect(() => validateAiProfiles(bad)).toThrow(/RICOCHET_SNIPER.*missing required entry "estimationAccuracy"/);
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

const GOOD_ARENA = {
  id: 'test-01',
  cols: 4, rows: 3, cellSize: 2,
  legend: { '#': 'solid' },
  grid: ['.B..', '.#..', '..P.'],
  notes: ['a note'],
  claims: [],
};

describe('validateArenas', () => {
  it('accepts a well-formed arena file and returns it intact', () => {
    expect(validateArenas({ arenas: [GOOD_ARENA] })).toEqual([GOOD_ARENA]);
  });

  it('rejects a grid whose row count disagrees with rows', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).rows = 4;
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.grid.*3 rows.*declares 4/);
  });

  it('rejects a row whose length disagrees with cols', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).grid = ['.B..', '.#.', '..P.'];
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.grid\[1\].*length 3.*declares 4/);
  });

  it('rejects a grid character that is neither legend, spawn letter, nor floor', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).grid = ['.B..', '.Z..', '..P.'];
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.grid\[1\]\[1\].*"Z"/);
  });

  it('rejects a legend value that is not a WallKind', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).legend = { '#': 'squishy' };
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.legend\["#"\].*WallKind/);
  });

  it('rejects zero or one player spawns, and demands an enemy', () => {
    const none = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).grid = ['.B..', '.#..', '....'];
    });
    expect(() => validateArenas(none)).toThrow(/exactly one player spawn.*found 0/);
    const two = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).grid = ['.B..', '.#..', '.PP.'];
    });
    expect(() => validateArenas(two)).toThrow(/exactly one player spawn.*found 2/);
    const noEnemy = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).grid = ['....', '.#..', '..P.'];
    });
    expect(() => validateArenas(noEnemy)).toThrow(/at least one enemy/);
  });

  it('rejects duplicate ids', () => {
    expect(() => validateArenas({ arenas: [GOOD_ARENA, GOOD_ARENA] }))
      .toThrow(/duplicate id "test-01"/);
  });

  it('rejects an empty arena list, a non-array, and a non-object root', () => {
    expect(() => validateArenas({ arenas: [] })).toThrow(/at least one arena/);
    expect(() => validateArenas({ arenas: 'nope' })).toThrow(/must be an array/);
    expect(() => validateArenas(null)).toThrow(/root.*object/);
  });

  it('rejects an unknown claim type and a malformed claim', () => {
    const badType = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [{ type: 'vibes', why: 'x' }];
    });
    expect(() => validateArenas(badType)).toThrow(/arenas\[0\]\.claims\[0\]\.type.*"vibes"/);
    const noWhy = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'spawnBlockRobust', nudge: 0.1 },
      ];
    });
    expect(() => validateArenas(noWhy)).toThrow(/arenas\[0\]\.claims\[0\].*"why"/);
  });

  it('rejects a claim cell outside the grid, or a sightline claim not on an enemy spawn', () => {
    const oob = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'sightlineAfterBreach', from: [9, 9], sees: true, why: 'x' },
      ];
    });
    expect(() => validateArenas(oob)).toThrow(/arenas\[0\]\.claims\[0\]\.from.*outside the grid/);
    const notSpawn = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'sightlineAfterBreach', from: [0, 0], sees: true, why: 'x' },
      ];
    });
    expect(() => validateArenas(notSpawn))
      .toThrow(/arenas\[0\]\.claims\[0\]\.from.*enemy spawn/);
  });

  it('rejects a sightline claim aimed at the player spawn (an enemy spawn only, not any spawn)', () => {
    // GOOD_ARENA's P is at [2, 2]; picking it -- rather than a floor tile like
    // the "not on an enemy spawn" control above -- proves enemySpawnCell's
    // `kind === 'player'` branch specifically, not just its `!kind` branch.
    const atPlayer = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'sightlineAfterBreach', from: [2, 2], sees: true, why: 'x' },
      ];
    });
    expect(() => validateArenas(atPlayer))
      .toThrow(/arenas\[0\]\.claims\[0\]\.from.*enemy spawn/);
  });

  it('accepts a lane claim naming any two in-grid cells, and returns it intact', () => {
    const laneClaim = { type: 'lane', from: [0, 0], to: [3, 2], intact: 'blocked', breached: 'open', why: 'x' };
    const withLane = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [laneClaim];
    });
    expect(validateArenas(withLane)[0].claims).toEqual([laneClaim]);
  });

  it('rejects a lane claim whose "from" and "to" are the same cell -- it could never fail', () => {
    // Before this guard, {from:[0,0],to:[0,0]} validated and shipped: a cell is
    // always in line of sight of itself, so the claim reads "open" in both wall
    // phases forever regardless of the arena's geometry. CLAUDE.md: every
    // assertion must be able to fail.
    const vacuous = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'lane', from: [0, 0], to: [0, 0], intact: 'blocked', breached: 'open', why: 'x' },
      ];
    });
    expect(() => validateArenas(vacuous)).toThrow(/arenas\[0\]\.claims\[0\].*identical "from" and "to"/);
  });

  it('rejects a non-boolean "sees" on a sightline claim', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'sightlineAfterBreach', from: [1, 0], sees: 'yes', why: 'x' },
      ];
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.claims\[0\]\.sees.*boolean/);
  });

  it('rejects a lane claim whose "intact" state is not "blocked" or "open"', () => {
    // breached is left VALID here: object-literal fields evaluate left to
    // right, so if it were also invalid this would only ever prove intact's
    // guard, never breached's -- the two get separate tests for that reason.
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'lane', from: [0, 0], to: [3, 2], intact: 'ajar', breached: 'open', why: 'x' },
      ];
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.claims\[0\]\.intact.*"ajar"/);
  });

  it('rejects a lane claim whose "breached" state is not "blocked" or "open"', () => {
    // intact is left VALID here, mirroring the control above -- this is the
    // only way to reach breached's oneOf() at all, since it is evaluated
    // after intact's in the object literal.
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'lane', from: [0, 0], to: [3, 2], intact: 'blocked', breached: 'ajar', why: 'x' },
      ];
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.claims\[0\]\.breached.*"ajar"/);
  });

  it('rejects a claim that is not an object', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = ['vibes'];
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.claims\[0\] must be an object/);
  });

  it('rejects an unknown field on a claim', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'spawnBlockRobust', nudge: 0.1, why: 'x', panache: true },
      ];
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.claims\[0\].*unknown entry "panache"/);
  });

  it('rejects a whitespace-only "why"', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'spawnBlockRobust', nudge: 0.1, why: '   ' },
      ];
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.claims\[0\]\.why must not be empty/);
  });

  it('rejects a spawnBlockRobust nudge that is zero or negative', () => {
    const zero = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'spawnBlockRobust', nudge: 0, why: 'x' },
      ];
    });
    expect(() => validateArenas(zero)).toThrow(/arenas\[0\]\.claims\[0\]\.nudge.*greater than zero/);
    const negative = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'spawnBlockRobust', nudge: -1, why: 'x' },
      ];
    });
    expect(() => validateArenas(negative)).toThrow(/arenas\[0\]\.claims\[0\]\.nudge.*greater than zero/);
  });

  it('rejects a claim cell that is not a [col, row] pair', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'sightlineAfterBreach', from: [1, 1, 1], sees: true, why: 'x' },
      ];
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.claims\[0\]\.from.*\[col, row\] pair/);
  });

  it('rejects a claim cell coordinate that is negative or fractional (cell()\'s own nonNegInt check)', () => {
    // A negative control cell() lacked entirely: swapping its nonNegInt calls for
    // the plain num() check left the full suite green (verified by hand -- a
    // check nothing exercises is a check that cannot fail, which CLAUDE.md
    // forbids). GOOD_ARENA's B spawn is at [1, 0]; picking THAT cell's row/col
    // off by a negative or fractional amount proves nonNegInt's two branches
    // (non-integer, and negative) without also tripping the in-bounds check
    // cell() runs afterward, which a wildly out-of-range value would confound.
    const negative = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'sightlineAfterBreach', from: [-1, 0], sees: true, why: 'x' },
      ];
    });
    expect(() => validateArenas(negative)).toThrow(/arenas\[0\]\.claims\[0\]\.from\[0\].*non-negative integer/);
    const fractional = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'sightlineAfterBreach', from: [0.5, 0], sees: true, why: 'x' },
      ];
    });
    expect(() => validateArenas(fractional)).toThrow(/arenas\[0\]\.claims\[0\]\.from\[0\].*non-negative integer/);
  });

  it('rejects an arena entry that is not an object', () => {
    expect(() => validateArenas({ arenas: ['nope'] })).toThrow(/arenas\[0\] must be an object/);
  });

  it('rejects an arena missing a required top-level field', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      delete ((c.arenas as Mutable[])[0] as Mutable).cellSize;
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\].*missing required entry "cellSize"/);
  });

  it('rejects an arena with an unknown top-level field', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).difficulty = 'hard';
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\].*unknown entry "difficulty"/);
  });

  it('rejects notes that are not an array, or a note that is not a string', () => {
    const notArray = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).notes = 'nope';
    });
    expect(() => validateArenas(notArray)).toThrow(/arenas\[0\]\.notes.*array of strings/);
    const badNote = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).notes = [7];
    });
    expect(() => validateArenas(badNote)).toThrow(/arenas\[0\]\.notes\[0\].*string/);
  });

  it('rejects claims that are not an array', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = 'nope';
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.claims must be an array/);
  });
});

// The geometry half of GOOD_ARENA -- what a bare `Arena` is, with the definition-only
// fields (id/notes/claims) dropped. Hoisted: this destructure appeared 8 times in the
// block below, each with its own `void` dance to satisfy noUnusedLocals.
const GOOD_SHAPE = (() => {
  const { id, notes, claims, ...shape } = GOOD_ARENA;
  void id; void notes; void claims;
  return shape;
})();

describe('validateArenaShape', () => {
  it('accepts a bare Arena (no id/notes/claims) -- the sandbox path', () => {
    const shape = GOOD_SHAPE;
    expect(validateArenaShape(shape, 'sandbox', 'sandbox')).toEqual(shape);
  });

  it('rejects a shape that is not an object', () => {
    expect(() => validateArenaShape('nope', 'sandbox', 'sandbox')).toThrow(/sandbox must be an object/);
  });

  it('rejects cols or rows of zero', () => {
    const shape = GOOD_SHAPE;
    expect(() => validateArenaShape({ ...shape, cols: 0 }, 'sandbox', 'sandbox'))
      .toThrow(/sandbox\.cols.*greater than zero/);
    expect(() => validateArenaShape({ ...shape, rows: 0 }, 'sandbox', 'sandbox'))
      .toThrow(/sandbox\.rows.*greater than zero/);
  });

  it('rejects a cellSize of zero or negative', () => {
    const shape = GOOD_SHAPE;
    expect(() => validateArenaShape({ ...shape, cellSize: 0 }, 'sandbox', 'sandbox'))
      .toThrow(/sandbox\.cellSize.*greater than zero/);
    expect(() => validateArenaShape({ ...shape, cellSize: -1 }, 'sandbox', 'sandbox'))
      .toThrow(/sandbox\.cellSize.*greater than zero/);
  });

  it('rejects a legend that is not an object', () => {
    const shape = GOOD_SHAPE;
    expect(() => validateArenaShape({ ...shape, legend: 'nope' }, 'sandbox', 'sandbox'))
      .toThrow(/sandbox\.legend must be an object/);
  });

  it('rejects a legend key that is not a single character', () => {
    const shape = GOOD_SHAPE;
    expect(() => validateArenaShape({ ...shape, legend: { '##': 'solid' } }, 'sandbox', 'sandbox'))
      .toThrow(/sandbox\.legend\["##"\].*single character/);
  });

  it('rejects a legend key that collides with floor or a spawn letter', () => {
    const shape = GOOD_SHAPE;
    expect(() => validateArenaShape({ ...shape, legend: { '.': 'solid' } }, 'sandbox', 'sandbox'))
      .toThrow(/sandbox\.legend\["\."\].*collides/);
    expect(() => validateArenaShape({ ...shape, legend: { P: 'solid' } }, 'sandbox', 'sandbox'))
      .toThrow(/sandbox\.legend\["P"\].*collides/);
  });

  it('rejects a grid that is not an array', () => {
    const shape = GOOD_SHAPE;
    expect(() => validateArenaShape({ ...shape, grid: 'nope' }, 'sandbox', 'sandbox'))
      .toThrow(/sandbox\.grid.*array of strings/);
  });

  it('rejects a grid row that is not a string', () => {
    const shape = GOOD_SHAPE;
    expect(() => validateArenaShape({ ...shape, grid: [5, '.#..', '..P.'] }, 'sandbox', 'sandbox'))
      .toThrow(/sandbox\.grid\[0\].*string/);
  });
});

const KNOWN_ARENA_IDS = new Set(['arena-a', 'arena-b', 'arena-c']);
const GOOD_CAMPAIGN = {
  id: 'main',
  levels: [
    { id: 'level-01', arenaId: 'arena-a' },
    { id: 'level-02', arenaId: 'arena-b' },
  ],
};

describe('validateCampaign', () => {
  it('accepts a well-formed campaign and returns it intact', () => {
    expect(validateCampaign(GOOD_CAMPAIGN, KNOWN_ARENA_IDS)).toEqual(GOOD_CAMPAIGN);
  });

  it('rejects a root that is not an object', () => {
    expect(() => validateCampaign(null, KNOWN_ARENA_IDS)).toThrow(/root.*object/);
    expect(() => validateCampaign('nope', KNOWN_ARENA_IDS)).toThrow(/root.*object/);
  });

  it('rejects an unknown root key', () => {
    const bad = corrupt(GOOD_CAMPAIGN, (c) => { c.extra = true; });
    expect(() => validateCampaign(bad, KNOWN_ARENA_IDS)).toThrow(/root.*unknown entry "extra"/);
  });

  it('rejects a missing or empty id', () => {
    const missing = corrupt(GOOD_CAMPAIGN, (c) => { delete c.id; });
    expect(() => validateCampaign(missing, KNOWN_ARENA_IDS)).toThrow(/root.*missing required entry "id"/);
    const empty = corrupt(GOOD_CAMPAIGN, (c) => { c.id = ''; });
    expect(() => validateCampaign(empty, KNOWN_ARENA_IDS)).toThrow(/root\.id.*not be empty/);
  });

  it('rejects a missing or empty levels array', () => {
    const missing = corrupt(GOOD_CAMPAIGN, (c) => { delete c.levels; });
    expect(() => validateCampaign(missing, KNOWN_ARENA_IDS)).toThrow(/root.*missing required entry "levels"/);
    const notArray = corrupt(GOOD_CAMPAIGN, (c) => { c.levels = 'nope'; });
    expect(() => validateCampaign(notArray, KNOWN_ARENA_IDS)).toThrow(/root\.levels.*array/);
    const empty = corrupt(GOOD_CAMPAIGN, (c) => { c.levels = []; });
    expect(() => validateCampaign(empty, KNOWN_ARENA_IDS)).toThrow(/root\.levels.*at least one level/);
  });

  it('rejects an entry with an unknown or missing key', () => {
    const extra = corrupt(GOOD_CAMPAIGN, (c) => {
      (c.levels as Record<string, unknown>[])[0] = { ...(c.levels as Record<string, unknown>[])[0], extra: 1 };
    });
    expect(() => validateCampaign(extra, KNOWN_ARENA_IDS)).toThrow(/levels\[0\].*unknown entry "extra"/);
  });

  it('rejects a duplicate level id', () => {
    // Would fail if: the Set-based duplicate check were removed or short-circuited.
    const bad = corrupt(GOOD_CAMPAIGN, (c) => {
      (c.levels as Record<string, unknown>[])[1] = { id: 'level-01', arenaId: 'arena-b' };
    });
    expect(() => validateCampaign(bad, KNOWN_ARENA_IDS)).toThrow(/levels\[1\].*duplicate id "level-01"/);
  });

  it('rejects a bare-digit level id -- reserved for a legacy persisted ordinal', () => {
    // The fixture that PROVES the /^\d+$/ guard actually fires, not merely that
    // the regex compiles: a level id of '3' (exactly what run.ts's old
    // levelIdFromIndex(3) produced) must be rejected outright.
    const bad = corrupt(GOOD_CAMPAIGN, (c) => {
      (c.levels as Record<string, unknown>[])[0] = { id: '3', arenaId: 'arena-a' };
    });
    expect(() => validateCampaign(bad, KNOWN_ARENA_IDS)).toThrow(/levels\[0\]\.id.*bare digit string "3"/);
  });

  it('accepts a level id that merely CONTAINS digits, only rejecting an id that is ALL digits', () => {
    // Negative control for the guard above: 'level-3' must not be caught by the
    // same regex that catches '3'.
    const ok = corrupt(GOOD_CAMPAIGN, (c) => {
      (c.levels as Record<string, unknown>[])[0] = { id: 'level-3', arenaId: 'arena-a' };
    });
    expect(() => validateCampaign(ok, KNOWN_ARENA_IDS)).not.toThrow();
  });

  it('rejects an empty level id', () => {
    const bad = corrupt(GOOD_CAMPAIGN, (c) => {
      (c.levels as Record<string, unknown>[])[0] = { id: '', arenaId: 'arena-a' };
    });
    expect(() => validateCampaign(bad, KNOWN_ARENA_IDS)).toThrow(/levels\[0\]\.id.*not be empty/);
  });

  it('rejects an arenaId that does not name a known arena', () => {
    // Would fail if: knownArenaIds were ignored and any string accepted.
    const bad = corrupt(GOOD_CAMPAIGN, (c) => {
      (c.levels as Record<string, unknown>[])[0] = { id: 'level-01', arenaId: 'arena-ghost' };
    });
    expect(() => validateCampaign(bad, KNOWN_ARENA_IDS))
      .toThrow(/levels\[0\]\.arenaId.*"arena-ghost".*does not name a known arena/);
  });

  it('preserves the INPUT level order verbatim, independent of arena-catalog order', () => {
    // The proof that campaign order and arena-catalog order are independent
    // knobs: this campaign's levels are NOT in `arena-a, arena-b, arena-c` order
    // (the order KNOWN_ARENA_IDS would suggest an arena catalog ships in), and
    // the validator must not silently re-sort them. Would fail if: validateCampaign
    // sorted levels by id or by arenaId before returning.
    const reordered = {
      id: 'main',
      levels: [
        { id: 'level-01', arenaId: 'arena-c' },
        { id: 'level-02', arenaId: 'arena-a' },
        { id: 'level-03', arenaId: 'arena-b' },
      ],
    };
    expect(validateCampaign(reordered, KNOWN_ARENA_IDS)).toEqual(reordered);
  });
});
