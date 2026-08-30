import { describe, it, expect } from 'vitest';
import {
  DEV_FLAGS_OFF,
  FLAG_REGISTRY,
  PLAYTEST_BUNDLE,
  registryKeyMismatch,
  type FlagSpec,
} from './devflags';
import {
  DEV_FLAG_GROUPS,
  FLAG_GROUPS,
  controlKindFor,
  devControls,
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
