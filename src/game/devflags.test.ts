import { describe, it, expect } from 'vitest';
import { parseDevFlags, DEV_FLAGS_OFF } from './devflags';

describe('parseDevFlags', () => {
  it('is off for an empty query', () => {
    expect(parseDevFlags('')).toEqual(DEV_FLAGS_OFF);
    expect(parseDevFlags('?')).toEqual(DEV_FLAGS_OFF);
  });

  it('ignores a feature flag that arrives WITHOUT dev mode', () => {
    // The point of the two-key rule: a shared link carrying ?aimRay=1
    // must not turn anything on for whoever opens it.
    expect(parseDevFlags('?aimRay=1').aimRay).toBe(false);
  });

  it('dev mode alone still leaves every feature off', () => {
    expect(parseDevFlags('?dev=1')).toEqual(DEV_FLAGS_OFF);
  });

  it('turns roundPhaseHud on only with both keys', () => {
    expect(parseDevFlags('?roundPhaseHud=1').roundPhaseHud).toBe(false);
    expect(parseDevFlags('?dev=1').roundPhaseHud).toBe(false);
    expect(parseDevFlags('?dev=1&roundPhaseHud=1').roundPhaseHud).toBe(true);
  });

  it('leaves every other flag alone when one is set', () => {
    // Each flag must be independently settable, or a developer enabling one diagnostic
    // silently gets the others. Written against DEV_FLAGS_OFF rather than a literal, so
    // adding a flag cannot quietly shrink what this covers -- it was a three-flag literal
    // when there were three flags, and said "population: all three" while four more
    // existed on main.
    //
    // Population: every boolean flag in DEV_FLAGS_OFF, one at a time.
    const booleans = (Object.keys(DEV_FLAGS_OFF) as (keyof typeof DEV_FLAGS_OFF)[]).filter(
      (k) => typeof DEV_FLAGS_OFF[k] === 'boolean',
    );
    expect(booleans.length).toBeGreaterThan(3); // the literal this replaced covered 3
    for (const flag of booleans) {
      expect(parseDevFlags(`?dev=1&${flag}=1`)).toEqual({ ...DEV_FLAGS_OFF, [flag]: true });
    }
  });

  it('turns a feature on only with both keys', () => {
    expect(parseDevFlags('?dev=1&aimRay=1').aimRay).toBe(true);
    expect(parseDevFlags('?dev=1&shellCount=1').shellCount).toBe(true);
  });

  it('turns flags on independently', () => {
    const only = parseDevFlags('?dev=1&aimRay=1');
    expect(only.aimRay).toBe(true);
    expect(only.shellCount).toBe(false);
  });

  it('accepts a bare key as on', () => {
    expect(parseDevFlags('?dev&aimRay').aimRay).toBe(true);
  });

  it('treats explicit negatives as off', () => {
    // Population: the 4 values in FALSY, each tried on the feature key with dev
    // mode already on.
    for (const v of ['0', 'false', 'off', 'no']) {
      expect(parseDevFlags(`?dev=1&aimRay=${v}`).aimRay).toBe(false);
    }
    // and the same values disable dev mode itself
    for (const v of ['0', 'false', 'off', 'no']) {
      expect(parseDevFlags(`?dev=${v}&aimRay=1`).aimRay).toBe(false);
    }
  });

  it('works with or without the leading question mark', () => {
    expect(parseDevFlags('dev=1&aimRay=1').aimRay).toBe(true);
  });

  it('is unaffected by unrelated query parameters', () => {
    expect(parseDevFlags('?utm_source=x&dev=1&aimRay=1&ref=y').aimRay).toBe(true);
    expect(parseDevFlags('?utm_source=x&ref=y').aimRay).toBe(false);
  });
});

describe('parseDevFlags: seed', () => {
  it('is null without dev mode, whatever the seed says', () => {
    expect(parseDevFlags('?seed=1234').seed).toBeNull();
  });

  it('is null when absent', () => {
    expect(parseDevFlags('?dev=1').seed).toBeNull();
  });

  it('takes a positive integer', () => {
    expect(parseDevFlags('?dev=1&seed=1234').seed).toBe(1234);
  });

  it('rejects values the PRNG cannot use', () => {
    // 0 is degenerate for the PRNG -- deriveSeed never returns it -- and the
    // rest are simply not seeds. Population: the 6 forms below.
    for (const v of ['0', '-5', 'abc', '1.5', '', 'NaN']) {
      expect(parseDevFlags(`?dev=1&seed=${v}`).seed).toBeNull();
    }
  });

  it('does not disturb the boolean flags', () => {
    expect(parseDevFlags('?dev=1&seed=7')).toEqual({ ...DEV_FLAGS_OFF, seed: 7 });
  });
});

describe('parseDevFlags: mineTrigger', () => {
  it('is null without dev mode', () => {
    expect(parseDevFlags('?mineTrigger=both').mineTrigger).toBeNull();
  });

  it('accepts each of the four policies', () => {
    // Population: all four UnarmedTrigger values.
    for (const v of ['none', 'proximity', 'bullet', 'both']) {
      expect(parseDevFlags(`?dev=1&mineTrigger=${v}`).mineTrigger).toBe(v);
    }
  });

  it('rejects anything else, rather than guessing', () => {
    for (const v of ['', 'yes', 'BOTH', '1', 'proximty']) {
      expect(parseDevFlags(`?dev=1&mineTrigger=${v}`).mineTrigger).toBeNull();
    }
  });
});

describe('parseDevFlags: level', () => {
  it('is null without dev mode, so a shared link cannot skip levels', () => {
    expect(parseDevFlags('?level=2').level).toBeNull();
  });

  it('accepts a 1-based level number or the sandbox', () => {
    expect(parseDevFlags('?dev=1&level=1').level).toBe(1);
    expect(parseDevFlags('?dev=1&level=2').level).toBe(2);
    expect(parseDevFlags('?dev=1&level=sandbox').level).toBe('sandbox');
  });

  it('rejects non-levels, rather than guessing', () => {
    // Population: the 6 forms below. Range against ARENAS is the caller's job --
    // this module cannot know how many levels exist without importing the sim.
    for (const v of ['0', '-1', '1.5', 'abc', '', 'SANDBOX']) {
      expect(parseDevFlags(`?dev=1&level=${v}`).level).toBeNull();
    }
  });
});

describe('parseDevFlags: sandbox knobs', () => {
  it('parses an enemy multiset, keeping duplicates and order', () => {
    expect(parseDevFlags('?dev=1&tanks=brown,teal,teal').sandboxTanks)
      .toEqual(['brown', 'teal', 'teal']);
  });

  it('rejects the whole list on any unknown kind: a silent drop would misreport the fixture', () => {
    expect(parseDevFlags('?dev=1&tanks=brown,gray').sandboxTanks).toBeNull();
    expect(parseDevFlags('?dev=1&tanks=player').sandboxTanks).toBeNull();
    expect(parseDevFlags('?dev=1&tanks=').sandboxTanks).toBeNull();
  });

  it('defaults to disarmed; disarmed=0 re-arms', () => {
    expect(parseDevFlags('?dev=1').sandboxDisarmed).toBe(true);
    expect(parseDevFlags('?dev=1&disarmed=0').sandboxDisarmed).toBe(false);
    expect(parseDevFlags('?dev=1&disarmed=1').sandboxDisarmed).toBe(true);
  });

  it('parses a wall count, bare or in the promised random:N form', () => {
    expect(parseDevFlags('?dev=1&walls=8').sandboxWalls).toBe(8);
    expect(parseDevFlags('?dev=1&walls=random:8').sandboxWalls).toBe(8);
    for (const v of ['0', '-3', 'abc', 'random:', '']) {
      expect(parseDevFlags(`?dev=1&walls=${v}`).sandboxWalls).toBeNull();
    }
  });
});

describe('parseDevFlags: invincibility and the playtest bundle', () => {
  it('invincible needs dev, like everything else', () => {
    expect(parseDevFlags('?invincible=1').invincible).toBe(false);
    expect(parseDevFlags('?dev=1&invincible=1').invincible).toBe(true);
  });

  it('playtest=1 switches on the whole playtest kit in one flag', () => {
    const f = parseDevFlags('?dev=1&playtest=1');
    // Population: the five flags the bundle covers. Not a DevFlags field itself --
    // it EXPANDS at parse time, so the one-flag-flips-one-field derivation test
    // above keeps its meaning.
    expect(f.invincible).toBe(true);
    expect(f.roundPhaseHud).toBe(true);
    expect(f.shellCount).toBe(true);
    expect(f.mineReach).toBe(true);
    expect(f.mineTimer).toBe(true);
    // And nothing else: seed stays unset, the sandbox knobs stay default.
    expect(f.seed).toBeNull();
    expect(f.level).toBeNull();
  });

  it('playtest without dev does nothing, and playtest=0 is off', () => {
    expect(parseDevFlags('?playtest=1')).toEqual(DEV_FLAGS_OFF);
    expect(parseDevFlags('?dev=1&playtest=0')).toEqual(DEV_FLAGS_OFF);
  });
});

describe('parseDevFlags: playtest is additive, never a veto', () => {
  it('an explicit =0 on a bundled flag loses to the bundle, by documented OR semantics', () => {
    // The one surprising interaction: playtest=1&mineTimer=0 keeps mineTimer ON.
    // Individual flags can ADD to the kit, not subtract from it -- anyone wanting
    // the kit minus a piece lists the pieces instead of using the bundle.
    expect(parseDevFlags('?dev=1&playtest=1&mineTimer=0').mineTimer).toBe(true);
    expect(parseDevFlags('?dev=1&playtest=1&invincible=0').invincible).toBe(true);
  });
});
