import { describe, it, expect } from 'vitest';
import { TANK_KINDS } from '../sim/config';
import { BLOCKED_FIRE_CUES } from '../presentation/blocked-fire';
import {
  parseDevFlags,
  parseDeveloperMode,
  DEV_FLAGS_OFF,
  FLAG_REGISTRY,
  PLAYTEST_BUNDLE,
  registryKeyMismatch,
} from './devflags';

// ---------------------------------------------------------------------------
// parseDeveloperMode: the `dev` GATE itself, read separately from the flags.
//
// A bare `?dev=1` parses to exactly DEV_FLAGS_OFF, so `parseDevFlags` alone
// cannot tell "developer mode on, nothing enabled" from "no developer mode" --
// that is what this function exists for, and what makes DeveloperMetadata.active
// truthful. It is real production wiring (loop.ts's createBrowserDeps), so it
// gets direct coverage here rather than relying on the session-intent and loop
// tests, every one of which injects an already-decided `developerMode` boolean
// and would stay green with this function hardcoded to false.
//
// Population: the absent case, the documented enabled forms accepted by `isOn`
// (`?dev`, `?dev=`, `?dev=1`, and any non-FALSY value), and every member of the
// FALSY set, swept rather than sampled.
// ---------------------------------------------------------------------------
describe('parseDeveloperMode', () => {
  it('is inactive with no dev parameter at all', () => {
    expect(parseDeveloperMode('')).toBe(false);
    expect(parseDeveloperMode('?')).toBe(false);
    expect(parseDeveloperMode('?aimRay=1&seed=42')).toBe(false);
  });

  it('is active for the documented enabled forms', () => {
    // Same acceptance `isOn` gives every other flag: present-with-no-value counts.
    for (const search of ['?dev=1', 'dev=1', '?dev', '?dev=', '?dev=true', '?dev=on', '?dev=1&aimRay=1']) {
      expect(parseDeveloperMode(search), search).toBe(true);
    }
  });

  it('is inactive for every negative form the flag conventions define', () => {
    // The complete FALSY set (devflags.ts), case-insensitively -- not a sample.
    for (const raw of ['0', 'false', 'off', 'no', 'FALSE', 'Off', 'NO']) {
      expect(parseDeveloperMode(`?dev=${raw}`), raw).toBe(false);
    }
  });

  it('a BARE developer gate with no other enabled flag is still active', () => {
    // The exact case the flags object cannot express: `?dev=1` alone parses to
    // DEV_FLAGS_OFF, so a consumer deriving activity from the flags would read
    // this session as having no developer mode at all.
    expect(parseDevFlags('?dev=1')).toEqual(DEV_FLAGS_OFF);
    expect(parseDeveloperMode('?dev=1')).toBe(true);
  });

  it('is independent of the feature flags: a feature flag WITHOUT the gate activates nothing', () => {
    expect(parseDeveloperMode('?aimRay=1')).toBe(false);
    expect(parseDevFlags('?aimRay=1').aimRay).toBe(false);
  });

  it('reads only the `dev` key -- a lookalike parameter does not open the gate', () => {
    // Kills a `search.includes('dev')`-shaped implementation.
    expect(parseDeveloperMode('?developer=1')).toBe(false);
    expect(parseDeveloperMode('?devtools=1')).toBe(false);
    expect(parseDeveloperMode('?undev=1')).toBe(false);
  });
});

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

  it('turns aimRay on only with both keys', () => {
    expect(parseDevFlags('?aimRay=1').aimRay).toBe(false);
    expect(parseDevFlags('?dev=1').aimRay).toBe(false);
    expect(parseDevFlags('?dev=1&aimRay=1').aimRay).toBe(true);
  });

  it('no longer knows roundPhaseHud: the countdown HUD shipped, so the flag is gone', () => {
    // A retired flag must not linger as an accepted-but-ignored key, or a shared
    // ?dev=1&roundPhaseHud=1 link reads as still meaning something.
    expect('roundPhaseHud' in DEV_FLAGS_OFF).toBe(false);
    expect(parseDevFlags('?dev=1&roundPhaseHud=1')).toEqual(DEV_FLAGS_OFF);
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
    // Population: the four flags the bundle covers. Not a DevFlags field itself --
    // it EXPANDS at parse time, so the one-flag-flips-one-field derivation test
    // above keeps its meaning. (roundPhaseHud left the bundle when it shipped.)
    expect(f.invincible).toBe(true);
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

describe('parseDevFlags: corpseBlock and muzzleInside', () => {
  it('both need dev, like every other flag', () => {
    expect(parseDevFlags('?corpseBlock=1').corpseBlock).toBe(false);
    expect(parseDevFlags('?dev=1&corpseBlock=1').corpseBlock).toBe(true);
    expect(parseDevFlags('?muzzleInside=1').muzzleInside).toBe(false);
    expect(parseDevFlags('?dev=1&muzzleInside=1').muzzleInside).toBe(true);
  });

  it('are independent of each other', () => {
    const only = parseDevFlags('?dev=1&corpseBlock=1');
    expect(only.corpseBlock).toBe(true);
    expect(only.muzzleInside).toBe(false);
  });

  it('are NOT part of the playtest bundle -- unlike invincible/shellCount/mineReach/mineTimer', () => {
    const f = parseDevFlags('?dev=1&playtest=1');
    expect(f.corpseBlock).toBe(false);
    expect(f.muzzleInside).toBe(false);
  });
});

describe('parseDevFlags: enemyDeathPulse', () => {
  it('needs dev, like every other flag', () => {
    expect(parseDevFlags('?dev=1&enemyDeathPulse=1').enemyDeathPulse).toBe(true);
    expect(parseDevFlags('?dev=1').enemyDeathPulse).toBe(false);
    expect(parseDevFlags('').enemyDeathPulse).toBe(false);
  });

  it('is NOT part of the playtest bundle', () => {
    expect(parseDevFlags('?dev=1&playtest=1').enemyDeathPulse).toBe(false);
  });
});

describe('parseDevFlags: coopPool (restores the shipped shared-pool coop model)', () => {
  it('needs dev, like every other flag', () => {
    expect(parseDevFlags('?coopPool=1').coopPool).toBe(false);
    expect(parseDevFlags('?dev=1&coopPool=1').coopPool).toBe(true);
  });

  it('is off by default, leaving the shared-attempts ruling as the default', () => {
    expect(parseDevFlags('?dev=1').coopPool).toBe(false);
    expect(parseDevFlags('?dev=1&players=2').coopPool).toBe(false);
  });

  it('is NOT part of the playtest bundle', () => {
    expect(parseDevFlags('?dev=1&playtest=1').coopPool).toBe(false);
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
describe('parseDevFlags: gamepad', () => {
  it('needs dev, like every other flag', () => {
    expect(parseDevFlags('?gamepad=1').gamepad).toBe(false);
    expect(parseDevFlags('?dev=1&gamepad=1').gamepad).toBe(true);
  });
});

describe('parseDevFlags: players', () => {
  it('is null without dev mode, whatever the value says', () => {
    expect(parseDevFlags('?players=3').players).toBeNull();
  });

  it('is null when absent', () => {
    expect(parseDevFlags('?dev=1').players).toBeNull();
  });

  it('accepts 1 as an explicit no-op, matching the unflagged default', () => {
    expect(parseDevFlags('?dev=1&players=1').players).toBe(1);
  });

  it('accepts 2-4, the co-player range -- population: all 3 values', () => {
    for (const v of [2, 3, 4]) {
      expect(parseDevFlags(`?dev=1&players=${v}`).players).toBe(v);
    }
  });

  it('rejects anything else to null rather than clamping -- population: the 6 forms below', () => {
    for (const v of ['0', '5', '-1', '1.5', 'abc', '']) {
      expect(parseDevFlags(`?dev=1&players=${v}`).players).toBeNull();
    }
  });

  it('does not disturb the boolean flags', () => {
    expect(parseDevFlags('?dev=1&players=3')).toEqual({ ...DEV_FLAGS_OFF, players: 3 });
  });
});

describe('parseDevFlags: bots', () => {
  it('is null without dev mode, whatever the value says', () => {
    expect(parseDevFlags('?bots=2').bots).toBeNull();
  });

  it('is null when absent', () => {
    expect(parseDevFlags('?dev=1').bots).toBeNull();
  });

  it('accepts 0 as an explicit no-op, matching the unflagged default', () => {
    expect(parseDevFlags('?dev=1&bots=0').bots).toBe(0);
  });

  it('accepts 1-4, the full bot-count range -- population: all 4 values', () => {
    for (const v of [1, 2, 3, 4]) {
      expect(parseDevFlags(`?dev=1&bots=${v}`).bots).toBe(v);
    }
  });

  it('rejects anything else to null rather than clamping -- population: the 6 forms below', () => {
    for (const v of ['-1', '5', '1.5', 'abc', '', 'NaN']) {
      expect(parseDevFlags(`?dev=1&bots=${v}`).bots).toBeNull();
    }
  });

  it('does not disturb the boolean flags or players', () => {
    expect(parseDevFlags('?dev=1&bots=2&players=4')).toEqual({
      ...DEV_FLAGS_OFF,
      bots: 2,
      players: 4,
    });
  });
});

describe('the sandbox roster tracks the canonical kind list', () => {
  it('every enemy kind in TANK_KINDS parses in tanks= -- a new kind is spawnable the moment it exists', () => {
    // Pins the derivation in devflags.ts (review: it was built to admit new
    // kinds automatically, but nothing named the property). Fails if the
    // derived set ever loses a kind or the parser rejects one.
    const enemies = TANK_KINDS.filter((k) => k !== 'player');
    const flags = parseDevFlags(`?dev=1&level=sandbox&tanks=${enemies.join(',')}`);
    expect(flags.sandboxTanks).toEqual(enemies);
  });
});

describe('parseDevFlags: quality', () => {
  it('is null without dev mode, whatever the value says', () => {
    expect(parseDevFlags('?quality=low').quality).toBeNull();
  });

  it('is null when absent', () => {
    expect(parseDevFlags('?dev=1').quality).toBeNull();
  });

  it('accepts each of the three named presets -- population: all 3 QualityPreset values', () => {
    for (const v of ['low', 'medium', 'high']) {
      expect(parseDevFlags(`?dev=1&quality=${v}`).quality).toBe(v);
    }
  });

  it('rejects anything else, rather than guessing -- an unrecognised value leaves the render default', () => {
    for (const v of ['', 'ultra', 'HIGH', '1', 'lowx']) {
      expect(parseDevFlags(`?dev=1&quality=${v}`).quality).toBeNull();
    }
  });

  it('does not disturb the boolean flags', () => {
    expect(parseDevFlags('?dev=1&quality=low')).toEqual({ ...DEV_FLAGS_OFF, quality: 'low' });
  });
});

describe('parseDevFlags: mode (n-player arc PR 4 -- FFA + teams)', () => {
  it('is null without dev mode, whatever the value says', () => {
    expect(parseDevFlags('?mode=ffa').mode).toBeNull();
  });

  it('is null when absent -- resolves to campaign-coop downstream', () => {
    expect(parseDevFlags('?dev=1').mode).toBeNull();
  });

  it('accepts ffa and teams -- population: both values', () => {
    for (const v of ['ffa', 'teams']) {
      expect(parseDevFlags(`?dev=1&mode=${v}`).mode).toBe(v);
    }
  });

  it('rejects anything else to null rather than guessing -- population: the 4 forms below', () => {
    for (const v of ['', 'campaign-coop', 'FFA', 'coop']) {
      expect(parseDevFlags(`?dev=1&mode=${v}`).mode).toBeNull();
    }
  });

  it('does not disturb the boolean flags', () => {
    expect(parseDevFlags('?dev=1&mode=ffa')).toEqual({ ...DEV_FLAGS_OFF, mode: 'ffa' });
  });
});

describe('parseDevFlags: backdrop (issue #317 -- the felt treatment kept switchable)', () => {
  it('is null without dev mode, whatever the value says', () => {
    expect(parseDevFlags('?backdrop=felt').backdrop).toBeNull();
  });

  it('is null when absent -- the flat application ground is the shipped default', () => {
    expect(parseDevFlags('?dev=1').backdrop).toBeNull();
  });

  it('accepts felt -- population: the one named treatment this build carries', () => {
    expect(parseDevFlags('?dev=1&backdrop=felt').backdrop).toBe('felt');
  });

  it('rejects anything else to null rather than guessing -- population: the 5 forms below', () => {
    // `default` and `flat` are in the set deliberately: naming the DEFAULT is not a way
    // to select a treatment, and a parser that accepted either would put a value in the
    // field that no consumer branches on.
    for (const v of ['', 'FELT', 'velvet', 'default', 'flat']) {
      expect(parseDevFlags(`?dev=1&backdrop=${v}`).backdrop).toBeNull();
    }
  });

  it('does not disturb the boolean flags', () => {
    expect(parseDevFlags('?dev=1&backdrop=felt')).toEqual({ ...DEV_FLAGS_OFF, backdrop: 'felt' });
  });
});

describe('registryKeyMismatch: proven against synthetic fixtures first', () => {
  // The point of factoring this out: a check written directly against FLAG_REGISTRY can
  // never fail while `Record<keyof DevFlags, FlagSpec>` stands (a missing or extra key is
  // already a compile error), which would make the assertion decorative. These fixtures
  // are not FLAG_REGISTRY or DEV_FLAGS_OFF -- they prove the FUNCTION can catch a mismatch
  // before the next test trusts it to check the real pair.
  it('reports neither missing nor extra when the key sets agree', () => {
    expect(registryKeyMismatch({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual({ missing: [], extra: [] });
  });

  it('names a DevFlags key with no registry entry as missing', () => {
    expect(registryKeyMismatch({ a: 1 }, { a: 1, b: 2 })).toEqual({ missing: ['b'], extra: [] });
  });

  it('names a registry entry with no matching DevFlags key as extra', () => {
    expect(registryKeyMismatch({ a: 1, b: 2, c: 3 }, { a: 1, b: 2 })).toEqual({ missing: [], extra: ['c'] });
  });

  it('reports both directions at once, each sorted', () => {
    expect(registryKeyMismatch({ z: 1, x: 1 }, { y: 1, x: 1 })).toEqual({ missing: ['y'], extra: ['z'] });
  });
});

describe('FLAG_REGISTRY: the "programmatically kept up to date" guarantee', () => {
  it('has exactly one entry per DevFlags field, in both directions', () => {
    // The compile-time half is the `Record<keyof DevFlags, FlagSpec>` annotation on
    // FLAG_REGISTRY itself -- a field added to DevFlags with no registry entry, or a
    // registry entry naming no real field, is already a `tsc` error. This is the runtime
    // half, so the guarantee survives even if that annotation is ever loosened.
    expect(registryKeyMismatch(FLAG_REGISTRY, DEV_FLAGS_OFF)).toEqual({ missing: [], extra: [] });
  });

  it('gives every entry a description', () => {
    for (const [name, spec] of Object.entries(FLAG_REGISTRY)) {
      expect(spec.description.length, `${name} has no description`).toBeGreaterThan(0);
    }
  });

  it('gives every valued entry at least one of `values` or `type`', () => {
    // Population: every FLAG_REGISTRY entry whose kind is 'valued' -- seed, mineTrigger,
    // level, sandboxTanks, sandboxWalls, quality, at the time of writing. sandboxTanks
    // carries both (a multiset shape plus its per-element vocabulary), so this is an
    // "at least one" check, not an XOR.
    const valued = Object.entries(FLAG_REGISTRY).filter(([, s]) => s.kind === 'valued');
    expect(valued.length).toBeGreaterThan(0);
    for (const [name, spec] of valued) {
      const hasValues = spec.values !== undefined;
      const hasType = spec.type !== undefined;
      expect(hasValues || hasType, `${name} must carry values and/or type`).toBe(true);
    }
  });

  it('every entry carrying a `param` really differs from its DevFlags key', () => {
    // Catches a copy-paste `param` that restates the key -- the field only exists for the
    // three sandbox knobs whose query param is shorter than their DevFlags name.
    for (const [name, spec] of Object.entries(FLAG_REGISTRY)) {
      if (spec.param !== undefined) expect(spec.param).not.toBe(name);
    }
  });

  it("mineTrigger's and quality's documented values equal the parser's own sets", () => {
    // Derived via spread from the same MINE_TRIGGERS/QUALITY_PRESET_NAMES sets
    // parseDevFlags reads, so this cannot drift by construction -- this test guards the
    // derivation itself: swap either spread for a hand-written literal and this fails.
    for (const v of ['none', 'proximity', 'bullet', 'both']) {
      expect(FLAG_REGISTRY.mineTrigger.values).toContain(v);
    }
    expect(FLAG_REGISTRY.mineTrigger.values).toHaveLength(4);
    for (const v of ['low', 'medium', 'high']) {
      expect(FLAG_REGISTRY.quality.values).toContain(v);
    }
    expect(FLAG_REGISTRY.quality.values).toHaveLength(3);
  });

  it("sandboxTanks' documented values track TANK_KINDS minus the player, live", () => {
    const enemies = TANK_KINDS.filter((k) => k !== 'player');
    expect([...(FLAG_REGISTRY.sandboxTanks.values ?? [])].sort()).toEqual([...enemies].sort());
  });
});

describe('PLAYTEST_BUNDLE: the single list the parser and the doc both read', () => {
  it('names exactly the four flags the playtest tests above observe', () => {
    expect([...PLAYTEST_BUNDLE.expandsTo].sort()).toEqual(
      ['invincible', 'mineReach', 'mineTimer', 'shellCount'].sort(),
    );
  });

  it('every expandsTo entry is a real boolean DevFlags field', () => {
    for (const key of PLAYTEST_BUNDLE.expandsTo) {
      expect(typeof DEV_FLAGS_OFF[key]).toBe('boolean');
    }
  });
});


describe('parseDevFlags: blockedFire values are safe to paste into a query string (issue #497)', () => {
  it('every documented cue pastes raw into ?dev=1&blockedFire=... and comes back as itself -- population: the 5 registered values', () => {
    expect(BLOCKED_FIRE_CUES.size).toBe(5);
    for (const cue of BLOCKED_FIRE_CUES) {
      expect(parseDevFlags(`?dev=1&blockedFire=${cue}`).blockedFire, cue).toBe(cue);
    }
  });

  it('no registered value of ANY valued flag changes meaning under query decoding -- population: every value in the registry', () => {
    // The class of defect, not the instance: `URLSearchParams` decodes `+` as a space and
    // `%xx` as a byte, so a documented value carrying either would silently become a
    // different string on the way in. `ring+audio` was that value; this sweeps the whole
    // registry so the next one cannot ship. The negative control is the trap test below,
    // where a `+` demonstrably does change meaning.
    let values = 0;
    for (const [name, spec] of Object.entries(FLAG_REGISTRY)) {
      if (spec.kind !== 'valued') continue;
      for (const v of spec.values ?? []) { // free-form valued flags (seed, players) list no values
        values += 1;
        expect(new URLSearchParams(`x=${v}`).get('x'), `${name}=${v}`).toBe(v);
      }
    }
    expect(values, 'the population this sweeps').toBeGreaterThanOrEqual(BLOCKED_FIRE_CUES.size);
  });

  it('the historical trap: a raw ring+audio decodes to a space and is rejected to null, never silently another cue', () => {
    expect(new URLSearchParams('blockedFire=ring+audio').get('blockedFire')).toBe('ring audio');
    expect(parseDevFlags('?dev=1&blockedFire=ring+audio').blockedFire).toBeNull();
    expect(parseDevFlags('?dev=1&blockedFire=haptic+audio').blockedFire).toBeNull();
    expect(parseDevFlags('?dev=1&blockedFire=ring audio').blockedFire).toBeNull();
  });

  it('the properly encoded legacy spellings stay accepted as aliases of the canonical cue', () => {
    expect(parseDevFlags('?dev=1&blockedFire=ring%2Baudio').blockedFire).toBe('ring-audio');
    expect(parseDevFlags('?dev=1&blockedFire=haptic%2Baudio').blockedFire).toBe('haptic-audio');
    // Aliases are exact: a case or spacing variant is not a spelling anyone documented.
    expect(parseDevFlags('?dev=1&blockedFire=Ring%2BAudio').blockedFire).toBeNull();
    expect(parseDevFlags('?dev=1&blockedFire=ring%2B%20audio').blockedFire).toBeNull();
  });
});
