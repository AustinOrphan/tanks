import { describe, it, expect } from 'vitest';
import { AIBehavior } from './enums';
import { configFor } from './roster';
import { TANK_KINDS } from './validate';
import { ARENA_DEFS } from './arenas';
import type { ArenaShape } from './arena-types';
import type { AIProfileBalance, ResolvedTankConfig } from './types';
import {
  AIM_ACCURACY_WEIGHT, REACTION_WEIGHT, AGGRESSION_WEIGHT, BANK_SHOT_WEIGHT,
  MINE_THREAT_WEIGHT, CLOSE_RANGE_WEIGHT, RANGE_TOLERANCE_WEIGHT, EVASION_WEIGHT,
  WEAPON_SPEED_WEIGHT, RICOCHET_WEIGHT, SHELL_CAP_WEIGHT, FIRE_RATE_WEIGHT,
  REACTION_TIME_BOUNDS, PREFERRED_DISTANCE_BOUNDS, MINIMUM_DISTANCE_BOUNDS,
  WEAPON_SPEED_BOUNDS, RICOCHET_COUNT_BOUNDS, SHELL_CAP_BOUNDS, FIRE_COOLDOWN_BOUNDS,
  ENEMY_DENSITY_BOUNDS,
  tankDifficulty, tankDifficultyBreakdown, levelDifficulty, levelDifficultyBreakdown,
} from './difficulty';
import type { TankDifficultyBreakdown } from './difficulty';

// ---- Synthetic fixtures ----
// A hand-built ResolvedTankConfig, independent of the shipped roster, so the
// model's math can be probed at exact chosen values rather than whatever the
// real ai-profiles.json happens to contain today.

function aiProfile(over: Partial<AIProfileBalance> = {}): AIProfileBalance {
  return {
    behavior: AIBehavior.OFFENSIVE,
    aimAccuracy: 0.5,
    estimationAccuracy: 0.5,
    reactionTime: 0.5,
    commitmentTime: 0.3,
    aggression: 0.5,
    preferredDistance: 5,
    minimumDistance: 3,
    retreatChance: 0.5,
    directShotWeight: 0.5,
    bankShotWeight: 0.5,
    minePlacementChance: 0.5,
    ...over,
  };
}

function cfg(over: Partial<ResolvedTankConfig> = {}, aiOver: Partial<AIProfileBalance> = {}): ResolvedTankConfig {
  const ai = aiProfile(aiOver);
  return {
    displayName: 'Synthetic', color: '#000000', firstMission: 0, singlePlayerOnly: false,
    movementSpeed: 3, rotationSpeed: 5,
    ai, behavior: ai.behavior,
    weapon: {
      speed: 6, damage: 1, radius: 0.1, lifetime: 0, explosionRadius: 0,
      bulletType: 'normal', fireCooldown: 24, maxActiveProjectiles: 3, ricochetCount: 1,
    },
    mineCapacity: 2, abilities: [],
    ...over,
  };
}

describe('tankDifficultyBreakdown: every named weight is wired into the total', () => {
  // aggression and bankShot are now MUTUALLY EXCLUSIVE gates
  // (aggressionReads === (behavior === DEFENSIVE), bankShotReads === (behavior
  // !== DEFENSIVE) -- exact complements), so no single behavior can drive
  // BOTH terms non-zero at once and no single fixture can sum to 100 anymore.
  // Two fixtures instead of one: DEFENSIVE maxes every term except bankShot
  // (zeroed by its own gate); a mobile non-DEFENSIVE behavior maxes every term
  // except aggression (zeroed by its own gate). Between the two, all 12 named
  // weights are still driven to their max at least once, so the same mutation
  // classes the original single-fixture test caught (a weight never added,
  // added twice, or wired backwards) are still caught.
  it('DEFENSIVE at the hardest end of every OTHER bound sums to 100 minus BANK_SHOT_WEIGHT (its own gate)', () => {
    // If a term's weight constant existed but was never added into `total`, this
    // sum falls short. If a term were added TWICE, it exceeds. Each field below
    // is set to the value that SHOULD maximise its own contribution per the
    // model's documented direction (e.g. reactionTime at its bound's MIN,
    // because reaction is inverted) -- so this also catches a term wired with
    // the wrong direction: get invert()/normalize() backwards for any one field
    // and the corresponding term contributes 0 here instead of its weight, and
    // the sum comes up short.
    const hardestDefensive = cfg({
      weapon: {
        speed: WEAPON_SPEED_BOUNDS.max, damage: 1, radius: 0.1, lifetime: 0, explosionRadius: 0,
        bulletType: 'ricochet', fireCooldown: FIRE_COOLDOWN_BOUNDS.min,
        maxActiveProjectiles: SHELL_CAP_BOUNDS.max, ricochetCount: RICOCHET_COUNT_BOUNDS.max,
      },
    }, {
      behavior: AIBehavior.DEFENSIVE, // reads aggression (grey.ts); mobile, so the movement band terms are live too
      aimAccuracy: 1,
      reactionTime: REACTION_TIME_BOUNDS.min,
      aggression: 1,
      bankShotWeight: 1, // authored high on purpose: DEFENSIVE's own gate must still zero this term
      minePlacementChance: 1,
      preferredDistance: PREFERRED_DISTANCE_BOUNDS.min,
      minimumDistance: MINIMUM_DISTANCE_BOUNDS.min,
      retreatChance: 1,
    });
    const b = tankDifficultyBreakdown(hardestDefensive);
    expect(b.bankShot).toBe(0); // DEFENSIVE never routes to brownDecision/tealDecision
    const expectedMax = AIM_ACCURACY_WEIGHT + REACTION_WEIGHT + AGGRESSION_WEIGHT
      + MINE_THREAT_WEIGHT + CLOSE_RANGE_WEIGHT + RANGE_TOLERANCE_WEIGHT + EVASION_WEIGHT
      + WEAPON_SPEED_WEIGHT + RICOCHET_WEIGHT + SHELL_CAP_WEIGHT + FIRE_RATE_WEIGHT;
    expect(expectedMax).toBe(100 - BANK_SHOT_WEIGHT);
    expect(b.total).toBeCloseTo(expectedMax, 9);
  });

  it('a mobile non-DEFENSIVE behavior at the hardest end of every OTHER bound sums to 100 minus AGGRESSION_WEIGHT (its own gate)', () => {
    const hardestOffensive = cfg({
      weapon: {
        speed: WEAPON_SPEED_BOUNDS.max, damage: 1, radius: 0.1, lifetime: 0, explosionRadius: 0,
        bulletType: 'ricochet', fireCooldown: FIRE_COOLDOWN_BOUNDS.min,
        maxActiveProjectiles: SHELL_CAP_BOUNDS.max, ricochetCount: RICOCHET_COUNT_BOUNDS.max,
      },
    }, {
      behavior: AIBehavior.OFFENSIVE, // routes to tealDecision, which reads bankShotWeight (as a sign); never reads aggression
      aimAccuracy: 1,
      reactionTime: REACTION_TIME_BOUNDS.min,
      aggression: 1, // authored high on purpose: this behavior's own gate must still zero this term
      bankShotWeight: 1,
      minePlacementChance: 1,
      preferredDistance: PREFERRED_DISTANCE_BOUNDS.min,
      minimumDistance: MINIMUM_DISTANCE_BOUNDS.min,
      retreatChance: 1,
    });
    const b = tankDifficultyBreakdown(hardestOffensive);
    expect(b.aggression).toBe(0); // OFFENSIVE never routes to greyDecision
    const expectedMax = AIM_ACCURACY_WEIGHT + REACTION_WEIGHT + BANK_SHOT_WEIGHT
      + MINE_THREAT_WEIGHT + CLOSE_RANGE_WEIGHT + RANGE_TOLERANCE_WEIGHT + EVASION_WEIGHT
      + WEAPON_SPEED_WEIGHT + RICOCHET_WEIGHT + SHELL_CAP_WEIGHT + FIRE_RATE_WEIGHT;
    expect(expectedMax).toBe(100 - AGGRESSION_WEIGHT);
    expect(b.total).toBeCloseTo(expectedMax, 9);
  });

  it('the 12 weights still sum to 100 in total (documentation check, independent of any one fixture)', () => {
    const expectedMax = AIM_ACCURACY_WEIGHT + REACTION_WEIGHT + AGGRESSION_WEIGHT + BANK_SHOT_WEIGHT
      + MINE_THREAT_WEIGHT + CLOSE_RANGE_WEIGHT + RANGE_TOLERANCE_WEIGHT + EVASION_WEIGHT
      + WEAPON_SPEED_WEIGHT + RICOCHET_WEIGHT + SHELL_CAP_WEIGHT + FIRE_RATE_WEIGHT;
    expect(expectedMax).toBe(100);
  });

  it('a config at the EASIEST end of every bound sums to exactly zero', () => {
    const easiest = cfg({
      weapon: {
        speed: WEAPON_SPEED_BOUNDS.min, damage: 1, radius: 0.1, lifetime: 0, explosionRadius: 0,
        bulletType: 'normal', fireCooldown: FIRE_COOLDOWN_BOUNDS.max,
        maxActiveProjectiles: SHELL_CAP_BOUNDS.min, ricochetCount: RICOCHET_COUNT_BOUNDS.min,
      },
    }, {
      behavior: AIBehavior.OFFENSIVE,
      aimAccuracy: 0,
      reactionTime: REACTION_TIME_BOUNDS.max,
      aggression: 0,
      bankShotWeight: 0,
      minePlacementChance: 0,
      preferredDistance: PREFERRED_DISTANCE_BOUNDS.max,
      minimumDistance: MINIMUM_DISTANCE_BOUNDS.max,
      retreatChance: 0,
    });
    expect(tankDifficultyBreakdown(easiest).total).toBeCloseTo(0, 9);
  });
});

describe('the movement band is gated on behavior !== STATIONARY', () => {
  // CLAUDE.md: "STATIONARY still ignores preferredDistance/minimumDistance/
  // retreatChance, and always will". A stationary tank never runs seekMove, so
  // crediting it for a tight preferred distance or a high retreat chance would
  // score data the sim never reads. The two fixtures are IDENTICAL except for
  // `behavior` and its knock-on `mobile` gate.
  const bandMaxedOut: Partial<AIProfileBalance> = {
    preferredDistance: PREFERRED_DISTANCE_BOUNDS.min, // closest = hardest, if it counted
    minimumDistance: MINIMUM_DISTANCE_BOUNDS.min,
    retreatChance: 1,
  };

  it('STATIONARY: closeRange, rangeTolerance and evasion are exactly zero', () => {
    const stationary = cfg({}, { behavior: AIBehavior.STATIONARY, ...bandMaxedOut });
    const b = tankDifficultyBreakdown(stationary);
    expect({ closeRange: b.closeRange, rangeTolerance: b.rangeTolerance, evasion: b.evasion })
      .toEqual({ closeRange: 0, rangeTolerance: 0, evasion: 0 });
  });

  it('the SAME values, on a MOBILE behavior, add the band AND the mine threat', () => {
    // The kill test for the gates: delete either `mobile ? ... : 0` and the STATIONARY
    // config above stops being 0, so this diff assertion fails.
    //
    // `mineThreat` is in this sum because it is gated on the SAME flag, and for the same
    // reason: `brown.ts` -- where decideAi routes every STATIONARY tank -- hardcodes
    // `mine: false` in both return paths and never imports `mineInclination`, so a
    // stationary tank cannot lay one whatever its authored chance. `bandMaxedOut` carries
    // a non-zero minePlacementChance, which is why the delta is four weights, not three.
    const stationary = cfg({}, { behavior: AIBehavior.STATIONARY, ...bandMaxedOut });
    const mobile = cfg({}, { behavior: AIBehavior.OFFENSIVE, ...bandMaxedOut });
    const diff = tankDifficultyBreakdown(mobile).total - tankDifficultyBreakdown(stationary).total;
    const mineTerm = tankDifficultyBreakdown(mobile).mineThreat;
    expect(mineTerm, 'the fixture no longer exercises the mine gate').toBeGreaterThan(0);
    expect(diff).toBeCloseTo(
      CLOSE_RANGE_WEIGHT + RANGE_TOLERANCE_WEIGHT + EVASION_WEIGHT + mineTerm,
      9,
    );
  });

  it('a STATIONARY tank earns nothing for a mine chance it cannot act on', () => {
    // The third instance of this file's recurring bug class, found by review. Dormant on
    // shipped data -- both STATIONARY profiles omit the optional field, so it defaulted
    // to 0 and no pinned number was wrong -- but a trap for whoever tunes this next.
    const stationary = cfg({}, { behavior: AIBehavior.STATIONARY, minePlacementChance: 0.9 });
    expect(tankDifficultyBreakdown(stationary).mineThreat).toBe(0);
    const mobile = cfg({}, { behavior: AIBehavior.TACTICAL, minePlacementChance: 0.9 });
    expect(tankDifficultyBreakdown(mobile).mineThreat).toBeGreaterThan(0);
  });

  it('shipped RICOCHET_SNIPER (green) is STATIONARY with a non-zero authored preferredDistance -- the gate is not a no-op on real data', () => {
    // Both shipped STATIONARY profiles carry retreatChance 0 already, so the gate
    // is a no-op for evasion on real data -- but green's preferredDistance (12)
    // and minimumDistance (0) are NOT trivially zero, so without the gate this
    // kind's score would move.
    const green = configFor('green');
    expect(green.ai.preferredDistance).toBeGreaterThan(0);
    const b = tankDifficultyBreakdown(green);
    expect({ closeRange: b.closeRange, rangeTolerance: b.rangeTolerance, evasion: b.evasion })
      .toEqual({ closeRange: 0, rangeTolerance: 0, evasion: 0 });
  });
});

describe('aggression is gated to DEFENSIVE only', () => {
  // grep -rn "\.aggression" src/sim/ai/*.ts returns exactly one production
  // reader: grey.ts:37, `Math.round((1 - cfg.ai.aggression) * TICK_HZ)` for
  // its dodge-patience. brown.ts and teal.ts never reference ai.aggression.
  // decideAi (src/sim/ai/index.ts) routes DEFENSIVE -> greyDecision and
  // everything else (STATIONARY -> brownDecision; TACTICAL/OFFENSIVE/BERSERKER
  // -> tealDecision) elsewhere, so crediting aggression outside DEFENSIVE
  // scores a field the sim never reads for that kind's actual behaviour.
  it('non-DEFENSIVE behaviors: the aggression term is exactly zero, even with aggression authored at 1', () => {
    const nonDefensive = [AIBehavior.STATIONARY, AIBehavior.TACTICAL, AIBehavior.OFFENSIVE, AIBehavior.BERSERKER];
    for (const behavior of nonDefensive) {
      const b = tankDifficultyBreakdown(cfg({}, { behavior, aggression: 1 }));
      expect(b.aggression, behavior).toBe(0);
    }
  });

  it('the SAME aggression value, on DEFENSIVE, adds exactly AGGRESSION_WEIGHT', () => {
    // Asserted on the `.aggression` FIELD, not a total diff: bankShot's gate is
    // the exact complement of aggression's (bankShotReads === behavior !==
    // DEFENSIVE), so DEFENSIVE and a non-DEFENSIVE behavior differ in BOTH
    // terms at once -- a total diff here would measure AGGRESSION_WEIGHT minus
    // whatever bankShot contributes on the non-DEFENSIVE side, not
    // AGGRESSION_WEIGHT alone. The kill test for the gate: delete the
    // `aggressionReads ? ... : 0` guard (always compute) and the non-DEFENSIVE
    // assertion above stops being 0 -- proven below by applying that mutation.
    const defensive = tankDifficultyBreakdown(cfg({}, { behavior: AIBehavior.DEFENSIVE, aggression: 1 })).aggression;
    const offensive = tankDifficultyBreakdown(cfg({}, { behavior: AIBehavior.OFFENSIVE, aggression: 1 })).aggression;
    expect(defensive).toBeCloseTo(AGGRESSION_WEIGHT, 9);
    expect(offensive).toBe(0);
  });

  it('shipped grey and olive (DEFENSIVE) are credited; shipped brown, teal and green (not DEFENSIVE) are not', () => {
    for (const kind of ['grey', 'olive'] as const) {
      expect(tankDifficultyBreakdown(configFor(kind)).aggression, kind).toBeGreaterThan(0);
    }
    for (const kind of ['brown', 'teal', 'green'] as const) {
      expect(tankDifficultyBreakdown(configFor(kind)).aggression, kind).toBe(0);
    }
  });
});

describe('bankShotWeight is a PRESENCE bonus (sign, not magnitude), gated to behaviors other than DEFENSIVE', () => {
  // brown.ts:38 reads `cfg.ai.bankShotWeight > 0`; teal.ts:75 reads
  // `if (cfg.ai.bankShotWeight <= 0) return null` -- both a sign check only,
  // never a magnitude. teal.ts's own comment: "Both weights are read as
  // inclinations -- attempted at all or not." grey.ts never reads it at all.
  // decideAi routes STATIONARY -> brownDecision and TACTICAL/OFFENSIVE/
  // BERSERKER -> tealDecision, i.e. every behavior except DEFENSIVE, so the
  // term is gated to behavior !== DEFENSIVE and scores presence, not scale.
  it('DEFENSIVE: the bankShot term is exactly zero, even with bankShotWeight authored at 1', () => {
    const b = tankDifficultyBreakdown(cfg({}, { behavior: AIBehavior.DEFENSIVE, bankShotWeight: 1 }));
    expect(b.bankShot).toBe(0);
  });

  it('a tiny positive bankShotWeight scores the SAME as bankShotWeight 1 on a reading behavior -- magnitude does not matter', () => {
    // The kill test for "presence, not magnitude": replacing `> 0 ? WEIGHT : 0`
    // with `* clamp01(ai.bankShotWeight)` makes the tiny case fall far short of
    // BANK_SHOT_WEIGHT -- proven below by applying that exact mutation.
    const reading = [AIBehavior.STATIONARY, AIBehavior.TACTICAL, AIBehavior.OFFENSIVE, AIBehavior.BERSERKER];
    for (const behavior of reading) {
      const tiny = tankDifficultyBreakdown(cfg({}, { behavior, bankShotWeight: 0.01 })).bankShot;
      const full = tankDifficultyBreakdown(cfg({}, { behavior, bankShotWeight: 1 })).bankShot;
      expect(tiny, behavior).toBeCloseTo(BANK_SHOT_WEIGHT, 9);
      expect(full, behavior).toBeCloseTo(BANK_SHOT_WEIGHT, 9);
    }
  });

  it('bankShotWeight exactly 0 scores 0 -- the same sign boundary brown.ts and teal.ts both use', () => {
    const b = tankDifficultyBreakdown(cfg({}, { behavior: AIBehavior.OFFENSIVE, bankShotWeight: 0 }));
    expect(b.bankShot).toBe(0);
  });

  it('shipped teal and green (non-DEFENSIVE, bankShotWeight > 0) are credited the full weight; grey (DEFENSIVE, bankShotWeight 0.1) is not, despite a nonzero authored value', () => {
    expect(tankDifficultyBreakdown(configFor('teal')).bankShot).toBeCloseTo(BANK_SHOT_WEIGHT, 9);
    expect(tankDifficultyBreakdown(configFor('green')).bankShot).toBeCloseTo(BANK_SHOT_WEIGHT, 9);
    expect(configFor('grey').ai.bankShotWeight).toBeGreaterThan(0); // authored, but grey.ts never reads it
    expect(tankDifficultyBreakdown(configFor('grey')).bankShot).toBe(0);
  });
});

describe('bounds clamp rather than extrapolate past the fixed range', () => {
  it('reactionTime far below the bound scores the same as reactionTime AT the bound', () => {
    const atBound = tankDifficultyBreakdown(cfg({}, { reactionTime: REACTION_TIME_BOUNDS.min })).reaction;
    const wayBelow = tankDifficultyBreakdown(cfg({}, { reactionTime: REACTION_TIME_BOUNDS.min - 5 })).reaction;
    expect(wayBelow).toBeCloseTo(atBound, 9);
    expect(atBound).toBeCloseTo(REACTION_WEIGHT, 9);
  });

  it('aimAccuracy above 1 does not exceed the weight (clamp01, not raw multiply)', () => {
    // The mutation this kills: replacing clamp01(ai.aimAccuracy) with the raw
    // value would let an out-of-schema 1.5 score 30 instead of capping at 20.
    const over = tankDifficultyBreakdown(cfg({}, { aimAccuracy: 1.5 })).aimAccuracy;
    expect(over).toBeCloseTo(AIM_ACCURACY_WEIGHT, 9);
  });
});

describe('tankDifficulty over the shipped roster (population: all 7 shipped TankKinds)', () => {
  // Pinned by RUNNING the model (npx vitest run src/sim/config/difficulty.test.ts),
  // not computed by hand. Mutation ledger note: bumping any one weight constant
  // moves exactly the kinds whose corresponding term is non-zero -- see the report.
  const EXPECTED: Record<string, number> = {
    player: 29.428571428571427,
    brown: 26.428571428571427,
    grey: 43.42857142857143,
    teal: 51.93809523809524,
    olive: 39.345238095238095,
    green: 47.17857142857143,
    // Issue #136's new kind. Pinned the same way as every other entry here: by
    // RUNNING the model (`npx vitest run src/sim/config/difficulty.test.ts -t
    // "reports the full table"` and reading the `tank yellow:` line), not by hand.
    yellow: 43.7952380952381,
  };

  it('matches every shipped kind, not a sample', () => {
    expect(new Set(TANK_KINDS)).toEqual(new Set(Object.keys(EXPECTED)));
    for (const kind of TANK_KINDS) {
      expect(tankDifficulty(kind), kind).toBeCloseTo(EXPECTED[kind], 9);
    }
  });

  it('player is included for completeness but its number is not a real difficulty: its AI-derived terms exactly match brown, the other STATIC_BASIC kind', () => {
    // The player's own (inert) aiProfile is STATIC_BASIC only because the schema
    // requires one -- CLAUDE.md: "stepAi never runs it" (decideAi returns an
    // idle decision for tank.kind === 'player' BEFORE profile routing even
    // runs -- src/sim/ai/index.ts). brown is the other shipped STATIC_BASIC
    // kind, so every AI-derived term below (everything except the weapon
    // terms, which reflect the player's OWN real weapon stats) must come out
    // identical to brown's -- that equality is the actual claim "the player's
    // number is not a real difficulty" makes, and it fails if player's
    // aiProfile in tank-defs.json ever diverges from brown's.
    const player = tankDifficultyBreakdown(configFor('player'));
    const brown = tankDifficultyBreakdown(configFor('brown'));
    const aiTerms = (b: TankDifficultyBreakdown) => ({
      aimAccuracy: b.aimAccuracy, reaction: b.reaction, aggression: b.aggression, bankShot: b.bankShot,
      mineThreat: b.mineThreat, closeRange: b.closeRange, rangeTolerance: b.rangeTolerance, evasion: b.evasion,
    });
    expect(aiTerms(player)).toEqual(aiTerms(brown));
  });
});

describe('levelDifficulty over the 5 shipped arenas (population: all 5, from ARENA_DEFS)', () => {
  const EXPECTED: Record<string, { total: number; rosterSum: number; enemyCount: number; openCells: number }> = {
    'arena-01': { total: 131.1750830564784, rosterSum: 121.79523809523809, enemyCount: 3, openCells: 774 },
    'arena-02': { total: 164.99757123733025, rosterSum: 148.2238095238095, enemyCount: 4, openCells: 747 },
    'arena-03': { total: 196.541847041847, rosterSum: 174.97619047619045, enemyCount: 5, openCells: 792 },
    'arena-04': { total: 272.33219804478085, rosterSum: 260.25714285714287, enemyCount: 6, openCells: 1359 },
    'arena-05': { total: 319.4399453379586, rosterSum: 303.6857142857143, enemyCount: 7, openCells: 1359 },
  };

  it('matches every shipped arena, not a sample', () => {
    expect(new Set(ARENA_DEFS.map((a) => a.id))).toEqual(new Set(Object.keys(EXPECTED)));
    for (const arena of ARENA_DEFS) {
      const b = levelDifficultyBreakdown(arena);
      const exp = EXPECTED[arena.id];
      expect({ total: b.total, rosterSum: b.rosterSum, enemyCount: b.enemyCount, openCells: b.openCells }, arena.id)
        .toEqual(exp);
    }
  });

  it('openCells agrees with the independently-hand-rolled walk in arena-validation.test.ts', () => {
    // That test's cover-ratio block computes `open` (a wall/non-wall walk, no
    // lineOfSight) by hand, inline, over the same arenas. This module cannot
    // import that test file (see difficulty.ts's "what was not reused" note),
    // so this is a from-scratch re-derivation, not a shared call -- agreement
    // is evidence the two walks mean the same thing, not a structural guarantee.
    const known: Record<string, number> = {
      'arena-01': 774, 'arena-02': 747, 'arena-03': 792, 'arena-04': 1359, 'arena-05': 1359,
    };
    for (const arena of ARENA_DEFS) {
      expect(levelDifficultyBreakdown(arena).openCells, arena.id).toBe(known[arena.id]);
    }
  });

  it('is NOT monotonic in ship order on the density term -- arena-04 has the most enemies but a lower density than arena-02 or arena-03', () => {
    // Flagged per the issue brief: surprising output is signal, not a bug to
    // hide. arena-04 is a much larger board (45x33 vs 33x27), so its extra
    // enemies are spread thinner. The model's TOTAL still comes out monotonic
    // in ship order (rosterSum dominates), but the geometry term alone does not.
    const density = Object.fromEntries(
      ARENA_DEFS.map((a) => [a.id, levelDifficultyBreakdown(a).density]),
    );
    expect(density['arena-04']).toBeLessThan(density['arena-02']);
    expect(density['arena-04']).toBeLessThan(density['arena-03']);
    // The total ordering this model computes today -- stated as what the model
    // OUTPUTS, not verified against actual play (no scripted-player harness
    // exists yet; see the issue).
    const total = ARENA_DEFS.map((a) => levelDifficultyBreakdown(a).total);
    expect(total).toEqual([...total].sort((a, b) => a - b));
  });
});

describe('enemy count is not double-counted against the geometry term', () => {
  // rosterSum already scales with enemy count (one term summed per spawn); the
  // ONLY additional geometry input is density (enemies per open cell). Two
  // arenas with the IDENTICAL roster but different board sizes must have the
  // identical rosterSum and differing densityTerm only.
  const legend = { '#': 'solid' } as const;
  // Sized so BOTH densities land strictly inside ENEMY_DENSITY_BOUNDS -- with the
  // 5x5 / 9x9 boards first tried here, 2 enemies over so few open cells pushed
  // density past the bound's max on both boards, so densityTerm clamped to the
  // same value on each and the test passed for the wrong reason (a difference
  // that wasn't really there). A 20x20 interior (small, 400 open cells, density
  // 0.005) and a 40x20 interior (large, 800 open cells, density 0.0025) both sit
  // inside [0.002, 0.008], so the difference this test asserts is the model
  // actually computing two different clamped fractions, not two saturated 1s.
  const border = (w: number) => `#${'#'.repeat(w)}#`;
  const row = (w: number, content = '') => `#${content}${'.'.repeat(w - content.length)}#`;
  function board(w: number, h: number): string[] {
    const rows = [border(w)];
    for (let r = 0; r < h; r++) {
      if (r === 0) rows.push(row(w, 'B'));
      else if (r === h - 1) rows.push(row(w, '') .slice(0, -2) + 'P#');
      else if (r === Math.floor(h / 2)) rows.push(row(w, '') .slice(0, -2) + 'G#');
      else rows.push(row(w));
    }
    rows.push(border(w));
    return rows;
  }
  const small: ArenaShape = { cols: 22, rows: 22, cellSize: 2, legend, grid: board(20, 20) };
  const large: ArenaShape = { cols: 42, rows: 22, cellSize: 2, legend, grid: board(40, 20) };

  it('rosterSum is identical; densityTerm and total differ', () => {
    const s = levelDifficultyBreakdown(small);
    const l = levelDifficultyBreakdown(large);
    expect(s.enemyCount).toBe(l.enemyCount);
    expect(s.rosterSum).toBeCloseTo(l.rosterSum, 9);
    expect(s.densityTerm).not.toBeCloseTo(l.densityTerm, 3);
    expect(s.total).not.toBeCloseTo(l.total, 3);
  });

  it('the player spawn letter is excluded from enemyKinds', () => {
    const b = levelDifficultyBreakdown(small);
    expect(b.enemies.sort()).toEqual(['brown', 'grey']);
    expect(b.enemyCount).toBe(2);
  });

  it('a fully-solid arena (no open cells) reports density 0, not NaN', () => {
    const sealed: ArenaShape = { cols: 3, rows: 3, cellSize: 2, legend, grid: ['###', '###', '###'] };
    const b = levelDifficultyBreakdown(sealed);
    expect(b.openCells).toBe(0);
    expect(b.density).toBe(0);
    expect(Number.isNaN(b.total)).toBe(false);
  });
});

describe('ENEMY_DENSITY_BOUNDS covers the shipped arenas with headroom (documentation check)', () => {
  it('every shipped arena density falls inside the bound, not clamped flush against an edge', () => {
    for (const arena of ARENA_DEFS) {
      const density = levelDifficultyBreakdown(arena).density;
      expect(density, arena.id).toBeGreaterThan(ENEMY_DENSITY_BOUNDS.min);
      expect(density, arena.id).toBeLessThan(ENEMY_DENSITY_BOUNDS.max);
    }
  });

  it('ENEMY_DENSITY_WEIGHT actually moves the level total (the weight is wired)', () => {
    const before = levelDifficulty(ARENA_DEFS[0]);
    // Simulate the weight being 0 by re-deriving from the breakdown rather than
    // mutating the constant (constants are readonly exports); this proves the
    // densityTerm is a real, non-zero component of `total` for a real arena.
    const b = levelDifficultyBreakdown(ARENA_DEFS[0]);
    expect(b.densityTerm).toBeGreaterThan(0);
    expect(before).toBeCloseTo(b.rosterSum + b.densityTerm, 9);
  });
});

describe('reports the full table', () => {
  // THE RETUNE LOOP difficulty.ts's own comment points at: change a weight,
  // run this test with `-t "reports the full table"`, and read the numbers
  // back off stdout. Kept as a real, permanent, non-vacuous test (not a
  // throwaway script) so the documented command stays true -- an earlier
  // version of this table was computed with a scratch file that got deleted
  // before commit, which would have left the comment pointing at nothing.
  //
  // Retuning a weight moves the PINNED tables above too (proven by Mutation 1
  // in the issue's report: one weight change fails the sum-to-100 test, the
  // roster pin and the arena pin); this test's own assertions are only
  // completeness, not exact values, so it does not ALSO need updating.
  it('every shipped kind and every shipped arena, printed and counted', () => {
    const kinds = TANK_KINDS.map((kind) => {
      const b = tankDifficultyBreakdown(configFor(kind));
      // eslint-disable-next-line no-console
      console.log(`tank ${kind}:`, JSON.stringify(b));
      return kind;
    });
    const arenas = ARENA_DEFS.map((arena) => {
      const b = levelDifficultyBreakdown(arena);
      // eslint-disable-next-line no-console
      console.log(`level ${arena.id}:`, JSON.stringify(b));
      return arena.id;
    });
    // Non-vacuity: if TANK_KINDS or ARENA_DEFS ever came back empty (a broken
    // import, a narrowed glob), the loops above would silently print nothing
    // and the test would still pass with zero assertions failing. Pin the
    // population so that failure mode is loud instead.
    expect(kinds).toEqual(['player', 'brown', 'grey', 'teal', 'olive', 'green', 'yellow']);
    expect(arenas).toEqual(['arena-01', 'arena-02', 'arena-03', 'arena-04', 'arena-05']);
  });
});
