/**
 * The developer configuration MODEL (issue #244): the registry and parser in
 * `devflags.ts`, turned into controls, grouping, requested-vs-effective state with
 * machine-readable reasons, and canonical URLs.
 *
 * PURE. No DOM, no rendering, no simulation mutation -- the issue's last acceptance
 * criterion, and the reason this is a separate module from the UI that will consume it.
 * Everything here is a function of a query string plus the two tables below.
 *
 * NOTHING IS RE-DERIVED. `devControls()` reads `FLAG_REGISTRY`, `DEV_FLAGS_OFF` and
 * `PLAYTEST_BUNDLE`; `explainDevConfig` routes the SAME `parseDevFlags`/`parseDeveloperMode`
 * the boot path uses (issue #244's second criterion: "the preview and boot path use the same
 * parser/normalizer"). A second parser here would be a place for the preview to disagree
 * with what the game actually does, which is the whole failure this model exists to prevent.
 */
import {
  DEV_FLAGS_OFF,
  FLAG_REGISTRY,
  PLAYTEST_BUNDLE,
  parseDevFlags,
  parseDeveloperMode,
  type DevFlags,
  type FlagSpec,
} from './devflags';

/** The seven groups issue #244 names, in the order a menu should show them. */
export const DEV_FLAG_GROUPS = [
  'Gameplay',
  'VS/Bots',
  'Rendering',
  'Mines',
  'Sandbox',
  'Diagnostics',
  'Persistence',
] as const;

export type DevFlagGroup = (typeof DEV_FLAG_GROUPS)[number];

/**
 * Which group each flag belongs to.
 *
 * `Record<keyof DevFlags, DevFlagGroup>` is the completeness gate, the SAME idiom
 * `FLAG_REGISTRY` uses: a new `DevFlags` field with no entry here is a compile error, and a
 * stray entry naming no real field is one too. `devConfigKeyMismatch` in the tests adds the
 * runtime half through `registryKeyMismatch`, the function devflags.test.ts already proves
 * against synthetic fixtures before trusting it on a real pair.
 *
 * A SEPARATE TABLE rather than a `FlagSpec.group` field, deliberately: `FLAG_REGISTRY` is
 * what `tools/devflags/render.ts` generates `docs/dev-flags.md` from, and grouping is a menu
 * concern that document does not show. Keeping it here leaves the generated doc
 * byte-identical while still getting the compile-time gate.
 *
 * Four assignments are judgement calls rather than derivations, recorded on issue #244 so
 * they can be overruled individually: `mineWarn` is grouped by SUBJECT (Mines) though it is a
 * draw treatment; `seed` by PURPOSE (Diagnostics -- reproducibility) though it changes the
 * world; `aimRay` and `shellCount` likewise (they draw, but to show internal state); and
 * `gamepad` has no natural home among the seven, so it sits with the slot knobs it affects.
 */
export const FLAG_GROUPS: Record<keyof DevFlags, DevFlagGroup> = {
  level: 'Gameplay',
  invincible: 'Gameplay',
  corpseBlock: 'Gameplay',
  muzzleInside: 'Gameplay',

  players: 'VS/Bots',
  bots: 'VS/Bots',
  mode: 'VS/Bots',
  friendlyFire: 'VS/Bots',
  coopPool: 'VS/Bots',
  gamepad: 'VS/Bots',

  quality: 'Rendering',
  enemyDeathPulse: 'Rendering',
  backdrop: 'Rendering',

  mineTrigger: 'Mines',
  mineReach: 'Mines',
  mineTimer: 'Mines',
  mineWarn: 'Mines',

  sandboxTanks: 'Sandbox',
  sandboxDisarmed: 'Sandbox',
  sandboxWalls: 'Sandbox',

  aimRay: 'Diagnostics',
  shellCount: 'Diagnostics',
  seed: 'Diagnostics',
  autoplay: 'Diagnostics',
  replay: 'Diagnostics',

  saveIo: 'Persistence',
};

/**
 * What a menu should render for a control.
 *
 * DERIVED from `FlagSpec`, not declared a second time -- issue #244's first criterion is that
 * the control model cannot drift from the registry, and a hand-kept `kind` per control would
 * be exactly that drift.
 *
 * The rule, and the one entry that makes it non-obvious:
 *   - `kind: 'boolean'`                  -> `toggle`
 *   - `kind: 'valued'` with `type`       -> `input`   (a shape, not a menu)
 *   - `kind: 'valued'` with only `values`-> `select`
 *
 * `type` beats `values` because `sandboxTanks` carries BOTH, and `FlagSpec`'s own comment
 * says why: its `type` frames a multiset shape while its `values` are the per-element
 * vocabulary. A select over those values would offer "pick one element" for a control that
 * accepts a roster, so the presence of `type` is what says "this is free-form".
 */
export type DevControlKind = 'toggle' | 'select' | 'input';

export interface DevControl {
  /** The `DevFlags` field, or `'playtest'` for the bundle. */
  readonly field: string;
  /** The query-string parameter the field is read from. */
  readonly param: string;
  readonly group: DevFlagGroup;
  readonly control: DevControlKind;
  readonly description: string;
  /** The enumerable values, when the registry gives any. */
  readonly values?: readonly string[];
  /** The accepted shape, for a control the player types into. */
  readonly type?: string;
  readonly notes?: readonly string[];
  /** The value with no developer parameters at all -- `DEV_FLAGS_OFF`'s entry. */
  readonly defaultValue: DevFlags[keyof DevFlags] | false;
  /** True for the `playtest` bundle, which is not a `DevFlags` field. */
  readonly isBundle: boolean;
}

/** The derivation rule above, factored out so the tests can sweep it directly. */
export function controlKindFor(spec: FlagSpec): DevControlKind {
  if (spec.kind === 'boolean') return 'toggle';
  return spec.type === undefined ? 'select' : 'input';
}

/**
 * One control per registry field, plus one for the bundle, in group order.
 *
 * Order is `DEV_FLAG_GROUPS` then registry order within a group -- stable and derived, so a
 * menu does not have to sort and two callers cannot disagree about the order.
 */
/** Where the `playtest` bundle sits: with the Diagnostics flags it expands to. */
const BUNDLE_GROUP: DevFlagGroup = 'Diagnostics';

export function devControls(): readonly DevControl[] {
  const fields = Object.keys(FLAG_REGISTRY) as (keyof DevFlags)[];
  const out: DevControl[] = [];
  for (const group of DEV_FLAG_GROUPS) {
    for (const field of fields) {
      if (FLAG_GROUPS[field] !== group) continue;
      const spec = FLAG_REGISTRY[field];
      out.push({
        field,
        param: spec.param ?? field,
        group,
        control: controlKindFor(spec),
        description: spec.description,
        ...(spec.values ? { values: spec.values } : {}),
        ...(spec.type ? { type: spec.type } : {}),
        ...(spec.notes ? { notes: spec.notes } : {}),
        defaultValue: DEV_FLAGS_OFF[field],
        isBundle: false,
      });
    }
    // The bundle is a control but not a field: it has no `DevFlags` entry, no default of its
    // own, and it only ever sets booleans true (`PLAYTEST_BUNDLE.expandsTo` is typed
    // `BooleanFlagKey[]`), so it can never force a valued flag.
    //
    // Emitted INSIDE its own group rather than appended at the end, which is what keeps
    // every group contiguous -- appending put it after Persistence and split Diagnostics in
    // two, caught by this file's own contiguity assertion rather than by a reader.
    if (group === BUNDLE_GROUP) {
      out.push({
        field: 'playtest',
        param: PLAYTEST_BUNDLE.param,
        group,
        control: 'toggle',
        description: PLAYTEST_BUNDLE.description,
        ...(PLAYTEST_BUNDLE.notes ? { notes: PLAYTEST_BUNDLE.notes } : {}),
        defaultValue: false,
        isBundle: true,
      });
    }
  }
  return out;
}

export { parseDevFlags, parseDeveloperMode };
