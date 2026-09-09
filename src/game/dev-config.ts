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
  aiPerception: 'Gameplay',
  corpseBlock: 'Gameplay',
  muzzleInside: 'Gameplay',

  players: 'VS/Bots',
  bots: 'VS/Bots',
  mode: 'VS/Bots',
  friendlyFire: 'VS/Bots',
  pp1Roles: 'Gameplay',
  coopPool: 'VS/Bots',
  gamepad: 'VS/Bots',

  quality: 'Rendering',
  enemyDeathPulse: 'Rendering',
  backdrop: 'Rendering',
  menuTransition: 'Rendering',
  // With the two above rather than under Gameplay: all three name a TREATMENT of chrome
  // the player looks at, and none of them changes a rule of the match being played.
  topbar: 'Rendering',

  mineTrigger: 'Mines',
  mineReach: 'Mines',
  mineTimer: 'Mines',
  mineWarn: 'Mines',

  sandboxTanks: 'Sandbox',
  sandboxDisarmed: 'Sandbox',
  sandboxWalls: 'Sandbox',

  blockedFire: 'Gameplay',

  aimRay: 'Diagnostics',
  aiContact: 'Diagnostics',
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

// ---------------------------------------------------------------------------
// REQUESTED vs EFFECTIVE, with a machine-readable reason for every difference.
// ---------------------------------------------------------------------------

/**
 * Why a requested value is not the effective one, or why an effective one needs explaining.
 *
 * `rejected`, NOT `clamped`. Issue #244's scope says "clamping", but `devflags.ts` says the
 * opposite in three places and on purpose -- `asQuality` and `asPlayers` both state "not
 * clamped: an out-of-range value must not silently become a different meaning", and
 * `sandboxWalls` says it matches "`players`' own reject-to-null idiom rather than clamping".
 * So the parser REJECTS to the default and this model explains that. Modelling a `clamped`
 * reason would describe behaviour the code does not have. Raised on the issue.
 */
export type DevConfigReason =
  /** A developer parameter was supplied without `dev=1`, so nothing it asked for applies. */
  | 'gate-closed'
  /** `playtest` turned this boolean on; the URL did not ask for it directly. */
  | 'bundle-forced'
  /** The value did not parse, so the flag's default stands. */
  | 'rejected'
  /** Parsed and carried, but nothing reads it in this configuration. */
  | 'context-inert'
  /** A boolean whose default is ON, so absence is not "off" (`sandboxDisarmed`). */
  | 'inverted-default';

export interface DevConfigNote {
  readonly field: string;
  readonly param: string;
  readonly reason: DevConfigReason;
  /** The raw parameter value, when the URL carried one. */
  readonly requested?: string;
  /** What the parser actually produced. */
  readonly effective: unknown;
  /** One line, suitable for display beside the control. */
  readonly detail: string;
}

export interface DevConfigState {
  readonly developerMode: boolean;
  readonly effective: DevFlags;
  readonly notes: readonly DevConfigNote[];
  /** Parameters that are not `dev`, not `playtest`, and name no registry flag. */
  readonly unknownParams: readonly string[];
}

/** Every query parameter this model knows how to read. */
export function knownDevParams(): readonly string[] {
  const fields = Object.keys(FLAG_REGISTRY) as (keyof DevFlags)[];
  return ['dev', PLAYTEST_BUNDLE.param, ...fields.map((f) => FLAG_REGISTRY[f].param ?? f)];
}

function toParams(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
}

/**
 * Explain one query string.
 *
 * Routes `parseDeveloperMode` and `parseDevFlags` -- the SAME functions `createBrowserDeps`
 * calls at boot -- so a preview cannot disagree with what the game will do. Everything below
 * is commentary ON that result, never a second computation OF it.
 */
export function explainDevConfig(search: string): DevConfigState {
  const params = toParams(search);
  const developerMode = parseDeveloperMode(search);
  const effective = parseDevFlags(search);
  const fields = Object.keys(FLAG_REGISTRY) as (keyof DevFlags)[];
  const paramOf = (f: keyof DevFlags): string => FLAG_REGISTRY[f].param ?? f;
  const notes: DevConfigNote[] = [];

  const known = new Set(knownDevParams());
  const unknownParams = [...new Set([...params.keys()])].filter((k) => !known.has(k)).sort();

  // 1. The gate. `parseDevFlags` returns DEV_FLAGS_OFF wholesale without `dev=1`, so a URL
  //    full of developer parameters does nothing at all -- the single most confusing state
  //    this model exists to explain, and one no per-flag comparison would surface, since
  //    every flag simply equals its default.
  if (!developerMode) {
    for (const f of fields) {
      const p = paramOf(f);
      if (!params.has(p)) continue;
      notes.push({
        field: f, param: p, reason: 'gate-closed', requested: params.get(p) ?? '',
        effective: effective[f],
        detail: `\`${p}\` was supplied without \`dev=1\`, so it has no effect.`,
      });
    }
    if (params.has(PLAYTEST_BUNDLE.param)) {
      notes.push({
        field: 'playtest', param: PLAYTEST_BUNDLE.param, reason: 'gate-closed',
        requested: params.get(PLAYTEST_BUNDLE.param) ?? '', effective: false,
        detail: `\`${PLAYTEST_BUNDLE.param}\` was supplied without \`dev=1\`, so it has no effect.`,
      });
    }
    return { developerMode, effective, notes, unknownParams };
  }

  // 2. The bundle. Only ever sets booleans true (`expandsTo` is typed `BooleanFlagKey[]`),
  //    so it can never force a valued flag -- worth stating, because a reader may assume a
  //    bundle can set anything. A member the URL asked for directly is not "forced".
  if (params.has(PLAYTEST_BUNDLE.param)) {
    const bundleOn = toParams(search).get(PLAYTEST_BUNDLE.param);
    const on = bundleOn === null ? false : !['0', 'false', 'off', 'no'].includes(bundleOn.toLowerCase());
    if (on) {
      for (const f of PLAYTEST_BUNDLE.expandsTo) {
        const p = paramOf(f);
        if (params.has(p)) continue;
        notes.push({
          field: f, param: p, reason: 'bundle-forced', effective: effective[f],
          detail: `Turned on by \`${PLAYTEST_BUNDLE.param}\`, not requested directly.`,
        });
      }
    }
  }

  // 3. Rejection. A valued flag whose parameter is present but whose effective value is
  //    still the default was rejected -- sound here because EVERY valued flag defaults to
  //    null and no accepted value parses to null, which `dev-config.test.ts` pins as a
  //    premise rather than leaving as an assumption.
  for (const f of fields) {
    const spec = FLAG_REGISTRY[f];
    if (spec.kind !== 'valued') continue;
    const p = paramOf(f);
    if (!params.has(p)) continue;
    if (effective[f] !== DEV_FLAGS_OFF[f]) continue;
    const shape = spec.values ? spec.values.map((v) => `\`${v}\``).join(', ') : spec.type ?? '';
    notes.push({
      field: f, param: p, reason: 'rejected', requested: params.get(p) ?? '',
      effective: effective[f],
      detail: `Not an accepted value${shape ? ` (${shape})` : ''}; the default stands. Values are rejected, never clamped.`,
    });
  }

  // 4. Context-inert flags: carried faithfully, read by nothing in this configuration. Both
  //    instances are stated in DevFlags' own field comments ("so this flag is inert").
  if (effective.coopPool && (effective.players ?? 1) < 2) {
    notes.push({
      field: 'coopPool', param: 'coopPool', reason: 'context-inert', effective: true,
      detail: 'Only meaningful with `players` >= 2; a single-player session never enters the shared-pool path.',
    });
  }
  if (effective.friendlyFire && effective.mode !== 'teams') {
    notes.push({
      field: 'friendlyFire', param: 'friendlyFire', reason: 'context-inert', effective: true,
      detail: 'Only meaningful with `mode=teams`; outside teams it self-disables by construction.',
    });
  }

  // 5. Inverted defaults, derived rather than named: any boolean whose DEV_FLAGS_OFF entry is
  //    already `true`, so absence of its parameter does not mean "off". `sandboxDisarmed` is
  //    the only one today, and the test pins that population so a second one cannot appear
  //    unexplained.
  for (const f of fields) {
    if (FLAG_REGISTRY[f].kind !== 'boolean' || DEV_FLAGS_OFF[f] !== true) continue;
    const p = paramOf(f);
    notes.push({
      field: f, param: p, reason: 'inverted-default', ...(params.has(p) ? { requested: params.get(p) ?? '' } : {}),
      effective: effective[f],
      detail: `Defaults to ON: absence of \`${p}\` leaves it enabled, and \`${p}=0\` is what turns it off.`,
    });
  }

  return { developerMode, effective, notes, unknownParams };
}

// ---------------------------------------------------------------------------
// CANONICAL URLs.
// ---------------------------------------------------------------------------

/**
 * Developer parameters that were once accepted and no longer are.
 *
 * EMPTY, and deliberately so rather than omitted: no developer parameter has been removed
 * yet, so a populated list would be invented history. The mechanism is real and injectable
 * (`canonicalDevSearch`'s `deprecated` option) and `dev-config.test.ts` proves it with an
 * injected list, so the first real removal is a one-line edit here rather than a new feature.
 *
 * Without such a list this model CANNOT tell a deprecated developer parameter from an
 * unrelated application one -- both are simply "not known" -- and `unknownParams` reports
 * them together. That is a stated limit, not an oversight.
 */
export const DEPRECATED_DEV_PARAMS: readonly string[] = [];

/**
 * A chosen set of developer parameters, as the values a UI holds (issue #623).
 *
 * KEYED BY REGISTRY FIELD, not by query parameter, because that is what a control knows:
 * `devControls()` hands a UI `{field, param, ...}`, and three fields spell their parameter
 * differently (`sandboxTanks` -> `tanks`, and its two siblings). Translating once, here,
 * means no caller has to remember which is which. `'playtest'` is accepted alongside the
 * fields because the bundle is a control too, and `devControls()` emits it as one.
 *
 * `null` and `undefined` mean ABSENT -- the parameter is not emitted, so the flag takes
 * whatever `DEV_FLAGS_OFF` says. `false` is DIFFERENT: it is emitted as `=0`, an explicit
 * off.
 *
 * Those two have to be distinguishable, and `sandboxDisarmed` is why. It is the one boolean
 * whose default is TRUE (`DEV_FLAGS_OFF`, and `parseDevFlags` reads
 * `params.has('disarmed') ? isOn(...) : true`), so "absent" and "off" are opposite values
 * for it. Folding `false` into absent would make an armed sandbox unexpressible -- which is
 * exactly what one of the presets below is.
 */
export type DevSelection = Readonly<
  Partial<Record<keyof DevFlags | 'playtest', string | number | boolean | null>>
>;

/**
 * BUILD a developer query string from chosen values (issue #623).
 *
 * THE COMPLEMENT OF `canonicalDevSearch`, and the reason that function could not be used
 * for this. It reads from a `URLSearchParams` built from ITS INPUT and emits only what that
 * input already carried -- it rewrites, it cannot construct. Apply and Reload, Copy Link and
 * Reset Options (issue #246) all need to turn a set of control values into a URL, and there
 * was nothing to do it with.
 *
 * COMPOSED, not duplicated. `developerExitSearch(base)` already returns exactly the
 * parameters that are NOT developer parameters, so it is what preserves the caller's
 * unrelated query -- a deep link, a campaign tag, a router -- with its order and duplicates
 * intact. This function adds the developer half in front of it.
 *
 * ORDER MATCHES `canonicalDevSearch` EXACTLY: the gate, then the bundle, then registry
 * order, then everything else. That is not cosmetic -- it is what makes the output a fixed
 * point of the canonicaliser, so a built URL and a canonicalised one are the same string and
 * two callers cannot disagree about what the same selection means. A test pins it.
 *
 * THE GATE IS ALWAYS EMITTED. Every other developer parameter is inert without it
 * (`parseDevFlags` returns `DEV_FLAGS_OFF` when the gate is shut), so a builder that could
 * omit it would be able to produce a URL that silently does nothing. Reset Options is
 * therefore `devSearchFrom({})`: the gate alone, which is exactly "developer mode, no
 * options" -- and NOT `developerExitSearch`, whose whole job is to remove the gate too.
 *
 * @param selection the chosen values, keyed by registry field (or `'playtest'`).
 * @param base a `location.search` whose non-developer parameters are carried through.
 * @returns a search string with a leading `?`; never empty, since the gate is always set.
 */
export function devSearchFrom(selection: DevSelection, base = ''): string {
  const out = new URLSearchParams();
  out.append('dev', '1');

  const emit = (param: string, value: string | number | boolean | null | undefined): void => {
    if (value === undefined || value === null) return;
    // `1`/`0`, the forms every boolean parser accepts and the forms `canonicalDevSearch`
    // carries through, so a built URL reads like a typed one. `false` is emitted rather
    // than skipped -- see the type's doc comment for the flag that makes that necessary.
    if (typeof value === 'boolean') return void out.append(param, value ? '1' : '0');
    out.append(param, String(value));
  };

  emit(PLAYTEST_BUNDLE.param, selection.playtest);
  for (const field of Object.keys(FLAG_REGISTRY) as (keyof DevFlags)[]) {
    emit(FLAG_REGISTRY[field].param ?? field, selection[field]);
  }

  // The caller's own parameters, untouched. Sliced off the leading `?` that
  // `developerExitSearch` adds, since this string already has one.
  const unrelated = developerExitSearch(base).slice(1);
  return `?${out.toString()}${unrelated === '' ? '' : `&${unrelated}`}`;
}

/**
 * A named set of developer parameters (issue #623), for issue #246's preset buttons.
 *
 * URL-LEVEL, NOT PARSER-LEVEL, and deliberately not shaped like `PLAYTEST_BUNDLE`. That
 * bundle is a real query parameter with its own branch in `parseDevFlags`; following it
 * would mean five more parameters that must also enter `knownDevParams()`,
 * `canonicalDevSearch`'s ordering, `developerExitSearch`'s drop set and the generated doc --
 * for no gain, because a preset is only ever "these parameters". It also could not WORK:
 * `BundleSpec.expandsTo` is `readonly BooleanFlagKey[]`, so a bundle can set booleans true
 * and nothing else, while five of the six presets here are defined by valued flags.
 *
 * A preset is therefore a `DevSelection`, and previewing one is `devSearchFrom` followed by
 * the same `explainDevConfig` every other URL goes through -- no second code path, and no
 * state that exists only inside a preset, which is what #246 requires of them.
 *
 * `playtest` is expressed as a member here too, so the six read as one list rather than
 * "five presets and the bundle".
 */
export interface DevPresetSpec {
  /** Stable identifier, for a control's `data-preset` and for tests. */
  readonly id: string;
  /** What the button says. */
  readonly label: string;
  /** One line, suitable for display beside the button. */
  readonly description: string;
  readonly selection: DevSelection;
}

/**
 * The six presets issue #246 names. Ordered as that issue lists them.
 *
 * Every value here is a real registry parameter value, and a test parses each preset through
 * `explainDevConfig` to prove the flags it claims are the flags it produces -- so a preset
 * that names a value the parser rejects fails rather than silently landing on a default.
 */
export const DEV_PRESETS: readonly DevPresetSpec[] = [
  {
    id: 'playtest',
    label: 'Playtest',
    description: 'The playtest bundle: survivable, with the ordnance readouts on.',
    selection: { playtest: true },
  },
  {
    id: 'armed-sandbox',
    label: 'Armed Sandbox',
    description: 'The sandbox rig with its enemies ARMED, which is not the sandbox default.',
    // `sandboxDisarmed: false` is the whole point of the name: the sandbox disarms its
    // enemies unless told otherwise, so this preset exists to say otherwise. Roster and wall
    // count are left unset deliberately -- the rig's own defaults are a fine starting point,
    // and a preset that pinned them would be making a level-design choice this issue has no
    // standing to make.
    selection: { level: 'sandbox', sandboxDisarmed: false },
  },
  {
    id: 'vs-2p',
    label: '2-player VS',
    description: 'A two-player free-for-all.',
    selection: { players: 2, mode: 'ffa' },
  },
  {
    id: 'vs-4p',
    label: '4-player VS',
    description: 'A four-player free-for-all.',
    selection: { players: 4, mode: 'ffa' },
  },
  {
    id: 'all-bots',
    label: 'All Bots',
    description: 'Four slots, every one of them computer-controlled -- nobody drives.',
    // `bots` counts how many of the PLAYER SLOTS are computer-controlled (its registry
    // description), so "all bots" is bots === players rather than a flag of its own.
    selection: { players: 4, bots: 4, mode: 'ffa' },
  },
  {
    id: 'visual-debug',
    label: 'Visual Debug',
    description: 'The overlays that draw what the simulation is thinking.',
    // THE ONE PRESET WITH NO FLAG-DEFINED MEMBERSHIP, and the only judgement call in this
    // table. It cannot be derived from the Diagnostics group: that group also holds
    // `autoplay` and `replay`, which change what RUNS rather than what is drawn, and `seed`,
    // which is not an overlay at all. So this is the three Diagnostics flags that put
    // something on screen. `mineReach` is the borderline case and is left to the playtest
    // bundle, which already carries it. Changing this membership is a one-line edit.
    selection: { aimRay: true, aiContact: true, shellCount: true },
  },
];

/**
 * The query string to leave developer mode with (issue #243).
 *
 * The COMPLEMENT of `canonicalDevSearch` below, and deliberately not a mode of it. That
 * function KEEPS every developer parameter and only chooses whether to carry the gate,
 * because its job is to produce a shareable canonical developer URL; `keepGate: false`
 * therefore still returns `?aimRay=1&topbar=...`, which is a developer URL missing its
 * gate rather than an ordinary one. Exiting is the opposite operation: every known
 * developer parameter goes, the master gate included.
 *
 * Unrelated parameters survive with their order and their duplicates intact, because they
 * belong to something else -- a deep link, a campaign tag, a router -- and leaving
 * developer mode has no standing to normalise them.
 *
 * Retired parameters are dropped as well. They were developer parameters, so leaving one
 * behind would mean an Exit that produces a URL still carrying developer state.
 *
 * @param search a `location.search`, with or without the leading `?`.
 * @returns a search string with a leading `?`, or `''` when nothing is left.
 */
export function developerExitSearch(
  search: string,
  deprecated: readonly string[] = DEPRECATED_DEV_PARAMS,
): string {
  const drop = new Set([...knownDevParams(), ...deprecated]);
  const out = new URLSearchParams();
  for (const [k, v] of toParams(search).entries()) {
    if (drop.has(k)) continue;
    out.append(k, v);
  }
  const s = out.toString();
  return s === '' ? '' : `?${s}`;
}

export interface CanonicalDevUrlOptions {
  /** Keep the `dev=1` gate in the output. Default true; false strips developer mode. */
  readonly keepGate?: boolean;
  /** Parameters to treat as retired. Defaults to `DEPRECATED_DEV_PARAMS`. */
  readonly deprecated?: readonly string[];
}

export interface CanonicalDevUrl {
  /** The normalized query string, with a leading `?`, or `''` when nothing remains. */
  readonly search: string;
  /** Known developer parameters that appeared more than once, and were collapsed. */
  readonly duplicates: readonly string[];
  /** Parameters matching the deprecated list; dropped from `search`. */
  readonly deprecated: readonly string[];
  /** Parameters this model does not know and did not drop; carried through untouched. */
  readonly unknown: readonly string[];
}

/**
 * Rewrite a query string into the canonical form for the flags it expresses.
 *
 * FIRST-WINS on a duplicate known parameter, and that is not a preference: `isOn`, `asSeed`
 * and every other reader in `devflags.ts` go through `URLSearchParams.get`, which returns the
 * FIRST value. Canonicalising to the last would produce a URL that parses differently from
 * the one the player pasted, which is the one thing this function must never do.
 *
 * Ordering is `dev`, then the bundle, then registry order -- derived, so two calls cannot
 * disagree and a round trip is stable. Unrelated parameters keep their original relative
 * order and their duplicates, because this model has no authority over them.
 */
export function canonicalDevSearch(search: string, options: CanonicalDevUrlOptions = {}): CanonicalDevUrl {
  const { keepGate = true, deprecated = DEPRECATED_DEV_PARAMS } = options;
  const params = toParams(search);
  const retired = new Set(deprecated);
  const known = new Set(knownDevParams());
  const fields = Object.keys(FLAG_REGISTRY) as (keyof DevFlags)[];

  const duplicates: string[] = [];
  const seenDeprecated: string[] = [];
  const out = new URLSearchParams();

  const countOf = (name: string): number => params.getAll(name).length;
  const take = (name: string): void => {
    if (!params.has(name)) return;
    if (countOf(name) > 1) duplicates.push(name);
    out.append(name, params.get(name) as string); // first-wins, as the parser reads it
  };

  if (keepGate) take('dev');
  take(PLAYTEST_BUNDLE.param);
  for (const f of fields) take(FLAG_REGISTRY[f].param ?? f);

  // Everything else, in the order it arrived and with its duplicates intact -- except the
  // retired ones, which are dropped and reported.
  const unknown: string[] = [];
  for (const [k, v] of params.entries()) {
    if (known.has(k)) continue;
    if (retired.has(k)) {
      if (!seenDeprecated.includes(k)) seenDeprecated.push(k);
      continue;
    }
    if (!unknown.includes(k)) unknown.push(k);
    out.append(k, v);
  }

  const s = out.toString();
  return {
    search: s === '' ? '' : `?${s}`,
    duplicates: [...new Set(duplicates)],
    deprecated: seenDeprecated,
    unknown,
  };
}
