import { describe, it, expect } from 'vitest';
import {
  DEV_FLAGS_OFF,
  FLAG_REGISTRY,
  PLAYTEST_BUNDLE,
  parseDevFlags,
  parseDeveloperMode,
  registryKeyMismatch,
  type FlagSpec,
} from './devflags';
import {
  DEV_FLAG_GROUPS,
  FLAG_GROUPS,
  controlKindFor,
  devControls,
  explainDevConfig,
  knownDevParams,
  canonicalDevSearch,
  DEPRECATED_DEV_PARAMS,
} from './dev-config';

// ---------------------------------------------------------------------------
// PARITY, in both directions (issue #244's first acceptance criterion).
//
// Reusing `registryKeyMismatch` rather than writing a second key-comparison: that function
// is already proven against SYNTHETIC fixtures in devflags.test.ts before anything trusts it
// on a real pair, and a fresh copy here would have to earn that proof again. What this file
// adds is the third pair it has to hold over -- FLAG_GROUPS against DevFlags -- plus the
// control list built from all three tables.
//
// The compile-time half is `Record<keyof DevFlags, DevFlagGroup>` on FLAG_GROUPS, the same
// gate FLAG_REGISTRY carries. These runtime checks exist for the same reason devflags.test.ts
// states for its own: the guarantee should survive the annotation ever being loosened.
// ---------------------------------------------------------------------------
describe('the control model cannot drift from the registry', () => {
  it('FLAG_GROUPS and DEV_FLAGS_OFF name exactly the same fields, both directions', () => {
    expect(registryKeyMismatch(FLAG_GROUPS, DEV_FLAGS_OFF)).toEqual({ missing: [], extra: [] });
  });

  it('FLAG_GROUPS and FLAG_REGISTRY name exactly the same fields, both directions', () => {
    expect(registryKeyMismatch(FLAG_GROUPS, FLAG_REGISTRY)).toEqual({ missing: [], extra: [] });
  });

  it('the check can FAIL -- a field with no group, and a group for no field', () => {
    // The negative control, and the reason the two assertions above are not decorative.
    // Same shape as devflags.test.ts's own synthetic proof: a real-pair assertion that
    // cannot fail while the `Record<keyof DevFlags, ...>` annotation stands would advertise
    // coverage the compiler is already providing.
    const groups = { ...FLAG_GROUPS } as Record<string, string>;
    const flags = { ...DEV_FLAGS_OFF } as Record<string, unknown>;
    delete groups.aimRay;                 // a field the model forgot to group
    flags.newlyAddedFlag = false;         // a field added to DevFlags with no group
    groups.staleGroupEntry = 'Gameplay';  // a group for a field that no longer exists
    expect(registryKeyMismatch(groups, flags)).toEqual({
      missing: ['aimRay', 'newlyAddedFlag'],
      extra: ['staleGroupEntry'],
    });
  });

  it('gives every registry field exactly one control, and adds exactly one for the bundle', () => {
    const controls = devControls();
    const fieldControls = controls.filter((c) => !c.isBundle);
    const bundles = controls.filter((c) => c.isBundle);
    // Counted against the registry rather than a literal, so adding a flag moves both sides.
    expect(fieldControls).toHaveLength(Object.keys(FLAG_REGISTRY).length);
    expect(new Set(fieldControls.map((c) => c.field)).size).toBe(fieldControls.length);
    expect(registryKeyMismatch(
      Object.fromEntries(fieldControls.map((c) => [c.field, 1])),
      FLAG_REGISTRY,
    )).toEqual({ missing: [], extra: [] });
    // `playtest` is NOT a DevFlags field (devflags.ts makes adding it to FLAG_REGISTRY a
    // type error on purpose), so it can only ever arrive as the bundle control.
    expect(bundles.map((c) => c.field)).toEqual(['playtest']);
    expect(bundles[0].param).toBe(PLAYTEST_BUNDLE.param);
  });

  it('carries every group in DEV_FLAG_GROUPS order, and no control lands outside them', () => {
    const controls = devControls();
    const seen = controls.map((c) => c.group);
    // Order: a menu must not have to sort, and two callers must not disagree about it.
    const firstIndex = new Map<string, number>();
    seen.forEach((g, i) => { if (!firstIndex.has(g)) firstIndex.set(g, i); });
    const order = [...firstIndex.keys()];
    expect(order).toEqual(DEV_FLAG_GROUPS.filter((g) => order.includes(g)));
    // ...and every group is contiguous, not interleaved.
    for (const g of new Set(seen)) {
      const at = seen.map((x, i) => (x === g ? i : -1)).filter((i) => i >= 0);
      expect(at, `${g} is split across the list`).toEqual(
        Array.from({ length: at.length }, (_, i) => at[0] + i),
      );
    }
    expect(new Set(seen).size, 'a named group has no flags in it').toBe(DEV_FLAG_GROUPS.length);
  });
});

// ---------------------------------------------------------------------------
// Control-type derivation. Swept over the real registry AND probed with synthetic specs,
// because the interesting case (`type` beating `values`) has exactly one real instance.
// ---------------------------------------------------------------------------
describe('control type is derived from the registry, not declared twice', () => {
  it('maps the three registry shapes to the three control kinds', () => {
    expect(controlKindFor({ kind: 'boolean', description: '' })).toBe('toggle');
    expect(controlKindFor({ kind: 'valued', values: ['a', 'b'], description: '' })).toBe('select');
    expect(controlKindFor({ kind: 'valued', type: 'an integer', description: '' })).toBe('input');
  });

  it('lets `type` beat `values` -- a roster is typed, not picked from a menu', () => {
    // The rule's whole point, and `sandboxTanks` is its one real instance: it carries both,
    // its `type` framing a multiset while its `values` are the per-element vocabulary. A
    // select over those values would offer "pick one element" for a control that takes a
    // roster. Probed synthetically first, then asserted on the real entry.
    const both: FlagSpec = { kind: 'valued', values: ['a', 'b'], type: 'a multiset', description: '' };
    expect(controlKindFor(both)).toBe('input');
    expect(FLAG_REGISTRY.sandboxTanks.values, 'the premise moved').toBeDefined();
    expect(FLAG_REGISTRY.sandboxTanks.type, 'the premise moved').toBeDefined();
    expect(devControls().find((c) => c.field === 'sandboxTanks')?.control).toBe('input');
  });

  it('assigns a control kind to every field, and every boolean field is a toggle', () => {
    const controls = devControls().filter((c) => !c.isBundle);
    let toggles = 0;
    for (const c of controls) {
      const spec = FLAG_REGISTRY[c.field as keyof typeof FLAG_REGISTRY];
      expect(c.control, c.field).toBe(controlKindFor(spec));
      if (spec.kind === 'boolean') { expect(c.control, c.field).toBe('toggle'); toggles++; }
    }
    // Stated so the sweep has a population rather than possibly checking nothing. MEASURED,
    // and the first draft of this line guessed 17 -- the assertion caught it, which is the
    // only reason a stated population is worth writing down.
    expect(toggles).toBe(15);
    expect(controls).toHaveLength(26);
  });

  it('reads each parameter from the registry, using the field name only where none is given', () => {
    // The three sandbox knobs are the only ones whose param differs from their field.
    const controls = devControls().filter((c) => !c.isBundle);
    const renamed = controls.filter((c) => c.param !== c.field).map((c) => [c.field, c.param]);
    expect(renamed).toEqual([['sandboxTanks', 'tanks'], ['sandboxDisarmed', 'disarmed'], ['sandboxWalls', 'walls']]);
    for (const c of controls) {
      expect(c.param, c.field).toBe(FLAG_REGISTRY[c.field as keyof typeof FLAG_REGISTRY].param ?? c.field);
    }
  });

  it('carries each default straight from DEV_FLAGS_OFF', () => {
    for (const c of devControls().filter((x) => !x.isBundle)) {
      expect(c.defaultValue, c.field).toBe(DEV_FLAGS_OFF[c.field as keyof typeof DEV_FLAGS_OFF]);
    }
  });
});

// ---------------------------------------------------------------------------
// REQUESTED vs EFFECTIVE. Every case here is a real query string routed through the SAME
// `parseDevFlags` the boot path calls, so a green test cannot mean "the model's own copy of
// the parser agrees with itself".
// ---------------------------------------------------------------------------
describe('explainDevConfig', () => {
  const reasons = (s: string): string[] => explainDevConfig(s).notes.map((n) => `${n.field}:${n.reason}`);
  const noteFor = (s: string, field: string) => explainDevConfig(s).notes.find((n) => n.field === field);

  it('THE PREMISE the rejection rule rests on: every valued flag defaults to null', () => {
    // The rule is "parameter present, effective still the default => rejected". That is only
    // sound while no ACCEPTED value can itself parse to the default. It holds because every
    // valued flag's default is null and nothing valid parses to null -- asserted here rather
    // than assumed, because a future valued flag defaulting to, say, 1 would silently make
    // `?players=1` look rejected.
    const valued = (Object.keys(FLAG_REGISTRY) as (keyof typeof FLAG_REGISTRY)[])
      .filter((f) => FLAG_REGISTRY[f].kind === 'valued');
    expect(valued.length, 'the population this premise covers').toBe(11);
    for (const f of valued) {
      expect(DEV_FLAGS_OFF[f], `${f} defaults to something a valid value could parse to`).toBeNull();
    }
  });

  it('THE PREMISE the inverted-default rule rests on: exactly one boolean defaults to ON', () => {
    const inverted = (Object.keys(FLAG_REGISTRY) as (keyof typeof FLAG_REGISTRY)[])
      .filter((f) => FLAG_REGISTRY[f].kind === 'boolean' && DEV_FLAGS_OFF[f] === true);
    expect(inverted).toEqual(['sandboxDisarmed']);
  });

  it('explains a whole URL that does nothing, because the gate is shut', () => {
    // The most confusing real state: every flag equals its default, so a per-flag value
    // comparison reports nothing wrong at all. Only the gate explains it.
    const s = explainDevConfig('?aimRay=1&seed=42&playtest=1');
    expect(s.developerMode).toBe(false);
    expect(s.effective).toEqual(DEV_FLAGS_OFF);
    expect(s.notes.map((n) => `${n.field}:${n.reason}`).sort())
      .toEqual(['aimRay:gate-closed', 'playtest:gate-closed', 'seed:gate-closed']);
    expect(s.notes.find((n) => n.field === 'seed')?.requested).toBe('42');
  });

  it('names each bundle member it forced, and does not claim one the URL asked for', () => {
    const forced = explainDevConfig('?dev=1&playtest=1').notes
      .filter((n) => n.reason === 'bundle-forced').map((n) => n.field);
    expect(forced.length, 'the bundle expands to something').toBeGreaterThan(0);
    expect(forced.sort()).toEqual([...PLAYTEST_BUNDLE.expandsTo].sort());
    // Ask for one member directly: it is still on, but it was not FORCED.
    const direct = PLAYTEST_BUNDLE.expandsTo[0];
    const withDirect = explainDevConfig(`?dev=1&playtest=1&${direct}=1`).notes
      .filter((n) => n.reason === 'bundle-forced').map((n) => n.field);
    expect(withDirect).not.toContain(direct);
    expect(withDirect.length).toBe(forced.length - 1);
  });

  it('reports a rejected value as rejected, and says the default stands', () => {
    const n = noteFor('?dev=1&quality=ludicrous', 'quality');
    expect(n?.reason).toBe('rejected');
    expect(n?.requested).toBe('ludicrous');
    expect(n?.effective).toBe(DEV_FLAGS_OFF.quality);
    expect(n?.detail).toContain('never clamped');
    // An ACCEPTED value produces no note at all -- the negative half, without which the
    // rule above would pass while flagging everything.
    expect(reasons('?dev=1&quality=low').filter((r) => r.startsWith('quality:'))).toEqual([]);
  });

  it('rejects an out-of-range number rather than clamping it into a different meaning', () => {
    // The behaviour the issue's "clamping" wording would have described wrongly:
    // `players=99` does not become the maximum, it becomes null.
    const n = noteFor('?dev=1&players=99', 'players');
    expect(n?.reason).toBe('rejected');
    expect(explainDevConfig('?dev=1&players=99').effective.players).toBeNull();
  });

  it('calls out a flag nothing reads in this configuration', () => {
    expect(noteFor('?dev=1&friendlyFire=1', 'friendlyFire')?.reason).toBe('context-inert');
    // ...and stops calling it out once the context it needs is present.
    expect(noteFor('?dev=1&friendlyFire=1&mode=teams', 'friendlyFire')).toBeUndefined();
    expect(noteFor('?dev=1&coopPool=1', 'coopPool')?.reason).toBe('context-inert');
    expect(noteFor('?dev=1&coopPool=1&players=2', 'coopPool')).toBeUndefined();
  });

  it('explains the one flag whose absence does not mean off', () => {
    const n = noteFor('?dev=1', 'sandboxDisarmed');
    expect(n?.reason).toBe('inverted-default');
    expect(n?.effective).toBe(true);
    expect(n?.detail).toContain('=0');
    // It is explained whether or not the URL mentions it, because the confusing case is
    // precisely the one where the parameter is absent.
    expect(noteFor('?dev=1&disarmed=0', 'sandboxDisarmed')?.effective).toBe(false);
  });

  it('surfaces parameters it does not know, and keeps the ones it does out of that list', () => {
    const s = explainDevConfig('?dev=1&aimRay=1&oldFlag=1&utm_source=x&disarmed=0');
    expect(s.unknownParams).toEqual(['oldFlag', 'utm_source']);
    for (const k of ['dev', 'aimRay', 'disarmed', 'playtest']) {
      expect(knownDevParams(), k).toContain(k);
    }
  });
});

// ---------------------------------------------------------------------------
// CANONICAL URLs. One focused test per behaviour issue #244 lists, plus the round trip.
// ---------------------------------------------------------------------------
describe('canonicalDevSearch', () => {
  it('preserves unrelated parameters, in order and with their own duplicates', () => {
    // This model has no authority over parameters that are not its own, so it must not
    // reorder, collapse or drop them.
    const r = canonicalDevSearch('?utm_source=a&dev=1&ref=x&aimRay=1&utm_source=b');
    expect(r.search).toBe('?dev=1&aimRay=1&utm_source=a&ref=x&utm_source=b');
    expect(r.unknown).toEqual(['utm_source', 'ref']);
    expect(r.duplicates, 'an unrelated duplicate is not a KNOWN duplicate').toEqual([]);
  });

  it('collapses a duplicated known parameter to the FIRST value -- what the parser reads', () => {
    // The rule is forced, not chosen. `URLSearchParams.get` returns the first value and every
    // reader in devflags.ts goes through it, so canonicalising to the last would hand back a
    // URL that parses differently from the one supplied.
    const r = canonicalDevSearch('?dev=1&quality=low&quality=high');
    expect(r.search).toBe('?dev=1&quality=low');
    expect(r.duplicates).toEqual(['quality']);
    // The claim about the parser, measured rather than asserted about ourselves:
    expect(parseDevFlags('?dev=1&quality=low&quality=high').quality).toBe('low');
    // ...and the canonical form parses to exactly the same flags as the original.
    expect(parseDevFlags(r.search)).toEqual(parseDevFlags('?dev=1&quality=low&quality=high'));
  });

  it('drops deprecated parameters and names them', () => {
    // DEPRECATED_DEV_PARAMS ships empty -- no developer parameter has been retired yet, and a
    // populated list would be invented history -- so the MECHANISM is proven with an injected
    // list instead. That is the whole reason the option exists.
    expect(DEPRECATED_DEV_PARAMS, 'the shipped list is empty by design').toEqual([]);
    const r = canonicalDevSearch('?dev=1&oldFlag=1&aimRay=1', { deprecated: ['oldFlag'] });
    expect(r.search).toBe('?dev=1&aimRay=1');
    expect(r.deprecated).toEqual(['oldFlag']);
    expect(r.unknown).toEqual([]);
    // Without the list the same parameter is merely unknown, and is CARRIED, not dropped.
    const plain = canonicalDevSearch('?dev=1&oldFlag=1&aimRay=1');
    expect(plain.deprecated).toEqual([]);
    expect(plain.unknown).toEqual(['oldFlag']);
    expect(plain.search).toContain('oldFlag=1');
  });

  it('retains or removes the master gate as asked', () => {
    expect(canonicalDevSearch('?dev=1&aimRay=1').search).toBe('?dev=1&aimRay=1');
    const stripped = canonicalDevSearch('?dev=1&aimRay=1', { keepGate: false });
    expect(stripped.search).toBe('?aimRay=1');
    // ...and dropping the gate really does turn everything off, which is the point of being
    // able to drop it: the URL still SAYS aimRay, and the game will ignore it.
    expect(parseDevFlags(stripped.search)).toEqual(DEV_FLAGS_OFF);
    expect(explainDevConfig(stripped.search).notes.map((n) => n.reason)).toContain('gate-closed');
  });

  it('round trips: the canonical form reproduces the previewed effective flags', () => {
    // Issue #244's fourth criterion, swept over a set that exercises every behaviour above
    // rather than one happy case.
    const cases = [
      '?dev=1',
      '?dev=1&aimRay=1&seed=42',
      '?dev=1&quality=low&quality=high',
      '?dev=1&players=99',
      '?dev=1&playtest=1',
      '?dev=1&disarmed=0&tanks=grey,grey&walls=12',
      '?utm=1&dev=1&mode=teams&friendlyFire=1&ref=x',
      '?aimRay=1&seed=7',
    ];
    for (const c of cases) {
      const r = canonicalDevSearch(c);
      expect(parseDevFlags(r.search), c).toEqual(parseDevFlags(c));
      expect(parseDeveloperMode(r.search), c).toBe(parseDeveloperMode(c));
      // Stable: canonicalising a canonical form changes nothing.
      expect(canonicalDevSearch(r.search).search, `${c} is not a fixed point`).toBe(r.search);
    }
    expect(cases).toHaveLength(8);
  });

  it('emits developer parameters in a derived order, so two callers cannot disagree', () => {
    // Same flags, opposite input order -> identical output.
    const a = canonicalDevSearch('?dev=1&seed=42&aimRay=1&mineTimer=1').search;
    const b = canonicalDevSearch('?dev=1&mineTimer=1&aimRay=1&seed=42').search;
    expect(a).toBe(b);
    expect(a).toBe('?dev=1&aimRay=1&seed=42&mineTimer=1');
  });

  it('returns an empty string rather than a bare question mark', () => {
    expect(canonicalDevSearch('').search).toBe('');
    expect(canonicalDevSearch('?').search).toBe('');
    expect(canonicalDevSearch('?dev=1', { keepGate: false }).search).toBe('');
  });
});
