// The rules boundary (issue #472): one resolution point for every match rule, frozen, and
// complete by construction. These tests pin the defaults, the key manifest and the
// immutability; world.test.ts pins that a World carries the result unchanged through
// createWorld, cloneWorld and stepInputs.
import { describe, it, expect } from 'vitest';
import { resolveWorldRules, WORLD_RULE_KEYS, type WorldRules } from './rules';
import type { ArenaGeometry } from './types';

/**
 * A second copy of world.test.ts's non-default table, on purpose: each file stands alone,
 * and both are typed against WorldRules, so a rule added later fails to compile in both
 * until it has a sample. The control below keeps this copy honest against the defaults.
 */
const NON_DEFAULT_RULES: { [K in keyof WorldRules]: WorldRules[K] } = {
  mode: 'teams',
  friendlyFire: true,
  unarmedTrigger: 'proximity',
  aiTargetPerception: 'line-of-sight',
  corpseBlocksShells: true,
  muzzleClearsTanks: false,
  coopAttempts: false,
  arenaGeometry: { cols: 2, rows: 1, cellSize: 1, grid: ['..'], legend: {} },
};

describe('resolveWorldRules: the shipped defaults', () => {
  it('with nothing stated resolves to the shipped rule set, key by key', () => {
    // Every literal here is a decision with its own owner ruling (see WorldRules's doc
    // comments); flipping any one in the resolver is a gameplay change on every world in
    // the tree, so each is pinned by value rather than by "equals whatever it returns".
    expect(resolveWorldRules()).toEqual({
      mode: 'campaign-coop',
      friendlyFire: false,
      unarmedTrigger: 'none',
      aiTargetPerception: 'full',
      corpseBlocksShells: false,
      muzzleClearsTanks: true,
      coopAttempts: true,
      arenaGeometry: null,
    });
    expect(resolveWorldRules({})).toEqual(resolveWorldRules());
  });

  it('control: every NON_DEFAULT_RULES sample differs from its default (population: all WORLD_RULE_KEYS)', () => {
    const defaults = resolveWorldRules();
    for (const key of WORLD_RULE_KEYS) expect(NON_DEFAULT_RULES[key], key).not.toEqual(defaults[key]);
  });

  it('a stated value wins over its default, for every key (population: all WORLD_RULE_KEYS)', () => {
    const resolved = resolveWorldRules(NON_DEFAULT_RULES);
    for (const key of WORLD_RULE_KEYS) expect(resolved[key], key).toEqual(NON_DEFAULT_RULES[key]);
  });

  it('a stated undefined means the default, exactly as an absent key does', () => {
    // The dev-flag path (levels.ts) passes `flags.aiPerception ?? undefined`, and
    // createWorldFor's trailing positionals are undefined at every call site that stops
    // short of them -- both must read as "unstated", not as a value.
    expect(resolveWorldRules({ aiTargetPerception: undefined, coopAttempts: undefined }))
      .toEqual(resolveWorldRules());
  });

  it('arenaGeometry: null and undefined both resolve to null; a grid is kept by reference, not copied', () => {
    const grid: ArenaGeometry = { cols: 3, rows: 2, cellSize: 1, grid: ['...', '...'], legend: {} };
    expect(resolveWorldRules({ arenaGeometry: null }).arenaGeometry).toBeNull();
    expect(resolveWorldRules({ arenaGeometry: undefined }).arenaGeometry).toBeNull();
    // By reference: the grid strings never mutate after loadArena builds them, and every
    // tick's clone shares this one object, so a copy here would only cost.
    expect(resolveWorldRules({ arenaGeometry: grid }).arenaGeometry).toBe(grid);
  });
});

describe('WORLD_RULE_KEYS: the key manifest the sweeps run over', () => {
  it('names exactly the keys the resolver produces -- no more, no fewer', () => {
    // The `satisfies Record<keyof WorldRules, true>` behind WORLD_RULE_KEYS makes a missing
    // or extra key a compile error; this is the runtime half, so a resolver that produced
    // a key the manifest does not name (or vice versa) fails here rather than leaving
    // world.test.ts's sweeps silently one key short.
    expect([...WORLD_RULE_KEYS].sort()).toEqual(Object.keys(resolveWorldRules()).sort());
    expect(new Set(WORLD_RULE_KEYS).size).toBe(WORLD_RULE_KEYS.length);
  });
});

describe('the resolved rules are immutable', () => {
  it('the object is frozen: a rule write after construction throws and changes nothing', () => {
    const rules = resolveWorldRules();
    expect(Object.isFrozen(rules)).toBe(true);
    expect(() => {
      // @ts-expect-error -- every rule is readonly: this is a compile error first, and the
      // strict-mode TypeError below second, so a post-construction write (what game/loop.ts
      // used to do for `?dev=1&aiPerception=los`) cannot land silently at either level.
      rules.mode = 'ffa';
    }).toThrow(TypeError);
    expect(rules.mode).toBe('campaign-coop');
  });

  it('a variant derived through the resolver from a spread of existing rules comes back frozen', () => {
    // The freeze is shallow and a spread is a fresh, unfrozen object; the documented idiom
    // for "these rules, but ffa" is to re-enter the resolver, which re-freezes. Mutation
    // that fails this: dropping the Object.freeze in resolveWorldRules.
    const base = resolveWorldRules({ friendlyFire: true });
    const variant = resolveWorldRules({ ...base, mode: 'ffa' });
    expect(Object.isFrozen(variant)).toBe(true);
    expect(variant).toEqual({ ...base, mode: 'ffa' });
    expect(Object.isFrozen({ ...base })).toBe(false); // the spread alone is not
  });

  it('type-level: a rules literal missing a required key does not typecheck', () => {
    // The acceptance criterion in one line: adding a rule to WorldRules makes every
    // incomplete construction a COMPILE error, never a runtime default after a clone.
    // `tsc` (npm run verify:quick) is what checks this directive; vitest only runs it.
    // The literal deliberately stops one key short of the interface (no arenaGeometry).
    // @ts-expect-error -- 'arenaGeometry' is missing, so this literal is not a WorldRules
    const incomplete: WorldRules = {
      mode: 'campaign-coop',
      friendlyFire: false,
      unarmedTrigger: 'none',
      aiTargetPerception: 'full',
      corpseBlocksShells: false,
      muzzleClearsTanks: true,
      coopAttempts: true,
    };
    // Runtime half of the same claim: the resolver is what makes a literal complete.
    expect(Object.keys(incomplete).length).toBeLessThan(WORLD_RULE_KEYS.length);
    expect(Object.keys(resolveWorldRules(incomplete)).length).toBe(WORLD_RULE_KEYS.length);
  });
});
