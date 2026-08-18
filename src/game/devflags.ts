/**
 * Opt-in switches for work that is finished but not shipped.
 *
 * Nothing here is on unless `dev` is present in the query string, so a stray
 * `?aimRay=1` in a shared link does nothing on its own. Flipping a flag
 * needs both: `?dev=1&aimRay=1`.
 *
 * Parsing a string rather than reading `location` directly keeps this a pure
 * function, so the whole table is assertable without a browser.
 */
import type { TankKind, UnarmedTrigger, GameMode } from '../sim/types';
import { TANK_KINDS as ALL_TANK_KINDS } from '../sim/config';
import type { QualityPreset } from '../render/quality';

export interface DevFlags {
  /**
   * Draw the player's computed aim: a ray along the turret and a marker where
   * screenToGround says the cursor lands.
   *
   * NOT a missing feature made optional. The BARREL is the aim indicator, by
   * design; this exists to debug the mapping behind it, which is otherwise
   * invisible -- a wrong screenToGround and a correctly-drawn barrel look
   * identical on screen.
   */
  aimRay: boolean;
  /**
   * Show shells in flight against SHELL_CAP.
   *
   * Also deliberate: the cap is meant to be felt, not read. This is for
   * telling "the cap is working" apart from "the cannon is broken" while
   * developing -- the two are indistinguishable from the player's seat, which
   * is the point in the game and a nuisance in a debugger.
   */
  shellCount: boolean;
  /**
   * Fix the world seed instead of deriving one from the clock.
   *
   * The seed is normally `deriveSeed(Date.now())`, so no two sessions are the
   * same fight -- which is right for playing and useless for comparing. Pinning
   * it makes a scripted playthrough reproducible, so a before/after recording
   * shows the change rather than a different game.
   *
   * `null` when absent or unusable. 0 is rejected: the PRNG treats it as
   * degenerate, which is why deriveSeed never returns it.
   */
  seed: number | null;
  /**
   * What may detonate an UNARMED mine, for playtesting the "instant bomb".
   *
   * `null` leaves the world's own default ('none', the shipped rule). This
   * chooses what world is CREATED; the sim reads the field off the world, never
   * a flag, so a replay stays an exact function of its inputs.
   */
  mineTrigger: UnarmedTrigger | null;

  /**
   * Ring a mine's proximity-trigger radius and its kill radius.
   *
   * A mine is a 0.28 puck that kills at 2.5, so it shows about one part in eighty of the
   * ground it covers. That is deliberate -- a mine you can read perfectly is a much
   * weaker weapon -- which is exactly why the numbers need playtesting rather than
   * shipping. The two rings are separate because triggering and dying are separate
   * radii, and the gap between them is the counter-intuitive part.
   */
  mineReach: boolean;

  /** Show each mine's remaining fuse, in seconds, beside it. */
  mineTimer: boolean;

  /**
   * Jump straight to a level: a 1-based index into CAMPAIGN_LEVELS, or the word
   * `sandbox`. Range-checking against it is the caller's job -- knowing how many
   * levels exist would mean importing the sim here.
   */
  level: number | 'sandbox' | null;
  /**
   * Sandbox roster: `tanks=brown,teal,teal`, any multiset of enemy kinds. Null on
   * any unknown kind rather than dropping entries -- a silently-shrunk roster
   * misreports the fixture being observed.
   */
  sandboxTanks: TankKind[] | null;
  /** Sandbox enemies have their weapons OFF unless `disarmed=0` re-arms them. */
  sandboxDisarmed: boolean;
  /** Interior walls to scatter in the sandbox: `walls=8` or `walls=random:8`. */
  sandboxWalls: number | null;
  /**
   * The player cannot die: shells detonate on the hull harmlessly, blasts wash over.
   * The playtest staple -- walk a level, watch the AI, tune feel, no respawns.
   */
  invincible: boolean;
  /**
   * Let a tank killed earlier in the SAME tick still stop a bullet aimed at it,
   * instead of the shipped GHOST rule where the bullet passes straight through.
   *
   * Adopted ruling (2026-08-14): "Just-killed tank is a ghost for now. Flippable switch in
   * the future to playtest." This turns `World.corpseBlocksShells` ON to playtest the
   * WALL alternative; off (the default) leaves today's ghost behaviour unchanged. See
   * `src/sim/bullets.ts`'s `resolveBulletHits`.
   */
  corpseBlock: boolean;
  /**
   * Restore today's shipped muzzle spawn: a shell can be born already inside an
   * adjacent LIVE tank's hit circle.
   *
   * Adopted ruling (2026-08-14): "Spawn at hull center might be the way to go but im not
   * certain. Maybe set that up but also have it be flippable." The new clearance
   * check (`World.muzzleClearsTanks`) is ON by default -- the adopted lean -- so this flag is
   * the escape hatch: on, it turns the clearance back OFF for an A/B comparison
   * against the old feel. See `src/sim/bullets.ts`'s `muzzlePoint`.
   */
  muzzleInside: boolean;
  /**
   * Drive the player with the scripted "competent player" (sim/ai/player-profile.ts)
   * instead of reading the input controller -- the game demos itself.
   *
   * Chosen HERE, in the game layer, never inside src/sim/: the flag only decides WHICH
   * function loop.ts calls to build this frame's InputState (decidePlayerInput vs
   * input.sample()). The sim never sees the flag itself, only the InputState either
   * path hands to step() -- so a replay stays an exact function of its inputs, autoplay
   * or not.
   */
  autoplay: boolean;
  /**
   * Publish the save export/import on the dev console object (`__tanks`).
   *
   * localStorage is origin-scoped, so a player who moves from the web build to a
   * wrapped mobile build starts at zero -- and this is the only mechanism that
   * carries a save across, or backs one up at all. Console-level, not a HUD
   * button: whether it earns a permanent affordance is a product call, and
   * shipping a button now would decide it by accident.
   */
  saveIo: boolean;
  /**
   * Record the per-tick input stream, and publish it on the dev console object.
   *
   * The sim is already a pure function of (world, input per tick); this is the
   * thing in the shipped game that can CAPTURE that pair, for a bug report that
   * reproduces exactly or an attract-mode demo. Recording DECORATES the input
   * collaborator, so the flag never reaches src/sim/ -- see replay.ts.
   */
  replay: boolean;
  /**
   * Read `navigator.getGamepads()` and merge gamepad[0] into slot 0's input stream
   * alongside keyboard/mouse/touch -- see `src/input/gamepad.ts`. Always padIndex 0,
   * whatever `players` is set to: this flag is slot 0's own opt-in, unrelated to which
   * OTHER slots exist.
   *
   * Composes freely with `players >= 2` (n-player arc PR3, `pad[i] -> slot[i]`): every
   * co-player slot 1..N-1 owns its own dedicated pad index, so slot 0's optional
   * pad[0] merge can never collide with one -- see loop.ts and gamepad.ts's module doc
   * comment. Before PR3, slot 0 was forced to `{gamepad: false}` whenever a second
   * player existed, because the OLD mapping put slot 1 on pad[0] too; that forcing is
   * gone. THE NAMED TRADEOFF this composability buys: a session's only physical pad
   * (almost always browser index 0) now feeds slot 0 if this flag is set, not slot 1 --
   * "P1 keyboard, hand the one pad to P2" has no zero-flag path anymore. See
   * docs/superpowers/plans/2026-08-17-controllers-4.md.
   */
  gamepad: boolean;
  /**
   * How many player-controlled tanks share the world: couch co-op generalized past two
   * (owner directive 3: ceiling to 4).
   *
   * Valued, not boolean (unlike the `coop` flag it replaces) -- a co-player COUNT is
   * the actual shape of the feature, and `coop=1` was always secretly "playerCount 2,
   * full stop." 1 is an explicit no-op (matches omission, so a `players=1..4` sweep
   * script never needs a special case for the unflagged default); 2-4 add co-players.
   * Anything else (0, negative, non-integer, 5+) rejects to `null`, which resolves to
   * the unflagged default of 1 -- matching `quality`'s reject-to-null idiom rather than
   * clamping an out-of-range value into a different meaning.
   *
   * Excluded from the sandbox (`?dev=1&level=sandbox`): `createSandboxWorld` takes no
   * `playerCount` and has no co-op spawn rule to inherit from `loadArena`, so `players`
   * is read but never wired there -- no extra slot is constructed and `playerCount`
   * passed to `world()` stays 1. See loop.ts's `playerCount`.
   */
  players: number | null;
  /**
   * Restores the shipped shared-life-POOL coop model (docs/superpowers/plans/2026-08-15-
   * coop-semantics.md): every player death drains the shared pool by one and schedules
   * that one tank's own per-tank respawn, leaving the rest of the board untouched.
   *
   * Default (this flag off) is the shared-ATTEMPTS ruling (owner, 2026-08-16, see
   * docs/superpowers/plans/2026-08-16-coop-attempts.md): a lone death costs nothing and
   * the survivor fights on; only a full wipe -- every player down at once -- spends a
   * life and restarts the whole arena. See `World.coopAttempts`, which this sets to
   * `false` -- the sim never reads this flag itself, only the world switch it decided.
   *
   * Only meaningful once `players` >= 2: with a single player, `resolveStatusCoop` is
   * never entered (the 1P body handles death/lose on its own), so this flag is inert.
   */
  coopPool: boolean;
  /**
   * A render quality preset -- `low` | `medium` | `high` -- see `render/quality.ts` for
   * what each one sets (antialias, pixel ratio cap, shadow map size, shadow filter).
   *
   * `null` when absent OR unrecognised, exactly like `mineTrigger`: it leaves the
   * render's own default, which is `high`, today's shipped values. This makes an
   * on-device sweep a URL change instead of a rebuild per pass -- auto-selecting a
   * preset from a device probe is explicitly out of scope until that measurement
   * spike runs (see issue #113); this only makes the knobs reachable.
   *
   * End state, per this file's flag-lifecycle rule: this flag is not a permanent user
   * setting. It either ships as an auto-detected preset (device probe replaces the
   * manual value, flag deleted) or gets deleted outright once the on-device sweep
   * concludes low/medium/high are not worth keeping. It does not stay a dev-only knob
   * indefinitely.
   */
  quality: QualityPreset | null;
  /**
   * How many of the `players` slots are computer-controlled -- bots as simulated
   * players (owner directive 1's literal ask), riding the SAME per-slot substitution
   * `autoplay` already uses at slot 0 (see `game/loop.ts`'s `effectiveInput.sample()`).
   *
   * Valued, same `asPlayers` idiom: 0 is an explicit no-op (matches omission), 1-4
   * claim that many of the LAST slots (`bots=2` at `players=4` claims slots 2 and 3,
   * leaving 0 and 1 on their real sources) -- simplest possible rule, chosen because at
   * this PR no per-slot controller routing exists yet to arbitrate against (see the
   * n-player arc's PR2). `bots` may equal `players` -- including at the unflagged
   * default of 1 player, where `bots=1` puts a bot in the ONLY slot, the fully
   * autonomous match owner directive 1 literally asks for ("simulate multiplayer using
   * computer players"). Anything else (negative, non-integer, 5+) rejects to null,
   * matching `players`' own reject-to-null idiom rather than clamping into a different
   * meaning.
   *
   * A bot-claimed slot never constructs its slot's real controller -- its own dedicated
   * gamepad reader, `pad[i] -> slot[i]` (n-player arc PR3) -- there is nothing for it
   * to drive.
   *
   * Clamped against the resolved `playerCount`, not rejected: `bots=4` at `players=2`
   * silently claims both slots rather than erroring, since the two flags are read
   * independently and neither can see the other's value while parsing.
   *
   * Unlike `players`, NOT excluded from the sandbox: the sandbox always resolves to a
   * single slot, and `bots=1` there is exactly what `autoplay=1` already does
   * unguarded -- the sandbox's one player-kind tank driven by the scripted brain
   * instead of the input controller.
   */
  bots: number | null;
  /**
   * Which VERSUS mode a session builds with -- 'ffa'/'teams' only; `null` (absent or
   * unrecognised) leaves World.mode's own default, 'campaign-coop' -- see GameMode
   * (sim/types.ts). Same reject-to-null idiom as `quality`/`mineTrigger`: an
   * unrecognised value (`?mode=ffa2`) leaves the shipped rule rather than guessing.
   *
   * Resolved into World.mode at world construction (levels.ts's campaign branch,
   * closed over like `corpseBlock`/`muzzleInside`/`coopPool`); the sim never reads this
   * flag itself, only the World field it decided -- see CLAUDE.md's flags-never-reach-
   * the-sim rule.
   */
  mode: 'ffa' | 'teams' | null;
  /**
   * Whether a shell or mine blast harms a teammate -- meaningful only once `mode` is
   * 'teams'. Default off (this flag's off state, `false`): protect teammates by
   * default, the "Owner forks" call in the arc design. Resolved into
   * World.friendlyFire the same way `mode` is; self-disabling outside 'teams' by
   * construction (see World.friendlyFire's own doc comment), so this flag is inert
   * whatever its value at `mode` unset/'campaign-coop'/'ffa'.
   */
  friendlyFire: boolean;
  /**
   * Enemy tanks also fire the identity death pulse (a coloured world ring) on death.
   *
   * Off = players only, enemies keep just the explosion burst -- the shipped rule.
   */
  enemyDeathPulse: boolean;
}

export const DEV_FLAGS_OFF: DevFlags = {
  aimRay: false,
  shellCount: false,
  seed: null,
  mineTrigger: null,
  mineReach: false,
  mineTimer: false,
  level: null,
  sandboxTanks: null,
  // TRUE in the off state: the sandbox defaults to weapons-off, and this field is a
  // VALUE the sandbox reads, not a feature the dev query enables.
  sandboxDisarmed: true,
  sandboxWalls: null,
  invincible: false,
  corpseBlock: false,
  muzzleInside: false,
  autoplay: false,
  saveIo: false,
  replay: false,
  gamepad: false,
  players: null,
  coopPool: false,
  quality: null,
  bots: null,
  mode: null,
  friendlyFire: false,
  enemyDeathPulse: false,
};

/** Values that read as "off" when a flag is present but negative. */
const FALSY = new Set(['0', 'false', 'off', 'no']);

const MINE_TRIGGERS = new Set(['none', 'proximity', 'bullet', 'both']);

const QUALITY_PRESET_NAMES = new Set(['low', 'medium', 'high']);

const VERSUS_MODE_NAMES = new Set(['ffa', 'teams']);

/** One of the three named presets, or null when absent or unrecognised -- an
 * unrecognised value (`?quality=potato`) is rejected to null rather than guessed,
 * matching asMineTrigger below; null resolves to the `high` default downstream. */
function asQuality(params: URLSearchParams): QualityPreset | null {
  const raw = params.get('quality');
  if (raw === null) return null;
  return QUALITY_PRESET_NAMES.has(raw) ? (raw as QualityPreset) : null;
}

/** 'ffa' or 'teams', or null when absent or unrecognised -- null resolves to
 *  World.mode's own default, 'campaign-coop', matching asQuality's idiom. */
function asMode(params: URLSearchParams): Extract<GameMode, 'ffa' | 'teams'> | null {
  const raw = params.get('mode');
  if (raw === null) return null;
  return VERSUS_MODE_NAMES.has(raw) ? (raw as Extract<GameMode, 'ffa' | 'teams'>) : null;
}

/** One of the four UnarmedTrigger values, or null when absent or unrecognised. */
function asMineTrigger(params: URLSearchParams): UnarmedTrigger | null {
  const raw = params.get('mineTrigger');
  if (raw === null) return null;
  return MINE_TRIGGERS.has(raw) ? (raw as UnarmedTrigger) : null;
}

/** A positive integer flag, or null when absent, empty, or not one. */
function asSeed(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** 1-4, or null when absent, empty, non-integer, or out of that range -- reject-to-null
 *  (asQuality's idiom), not clamped: an out-of-range value must not silently become a
 *  different, unrequested player count. */
function asPlayers(params: URLSearchParams): number | null {
  const raw = params.get('players');
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n >= 1 && n <= 4 ? n : null;
}

/** 0-4, or null when absent, empty, non-integer, or out of that range -- reject-to-null
 *  (asPlayers' own idiom), not clamped: an out-of-range value must not silently become a
 *  different, unrequested bot count. Clamping AGAINST playerCount (a different flag,
 *  read separately) happens downstream in loop.ts, not here. */
function asBots(params: URLSearchParams): number | null {
  const raw = params.get('bots');
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n >= 0 && n <= 4 ? n : null;
}

/** A 1-based level number, the word 'sandbox', or null. Case-sensitive on purpose. */
function asLevel(params: URLSearchParams): number | 'sandbox' | null {
  const raw = params.get('level');
  if (raw === null) return null;
  if (raw === 'sandbox') return 'sandbox';
  return asSeed(params, 'level'); // same shape: a positive integer or null
}

// Derived from the config module's canonical kind list, minus the player, so a
// new enemy kind is sandbox-spawnable the moment it exists -- this used to be a
// hand-kept subset that a new kind could silently miss (Set<TankKind> accepts
// any subset; no compile error would have named it).
const TANK_KINDS = new Set<TankKind>(ALL_TANK_KINDS.filter((k) => k !== 'player'));

/** The sandbox roster: every entry must be an enemy kind, or the whole list is null. */
function asTanks(params: URLSearchParams): TankKind[] | null {
  const raw = params.get('tanks');
  if (raw === null || raw === '') return null;
  const kinds = raw.split(',').map((s) => s.trim());
  if (!kinds.every((k) => TANK_KINDS.has(k as TankKind))) return null;
  return kinds as TankKind[];
}

/** `walls=8` or `walls=random:8`: a positive integer count, or null. */
function asWalls(params: URLSearchParams): number | null {
  const raw = params.get('walls');
  if (raw === null) return null;
  const bare = raw.startsWith('random:') ? raw.slice('random:'.length) : raw;
  const n = Number(bare);
  if (bare === '' || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

function isOn(params: URLSearchParams, name: string): boolean {
  if (!params.has(name)) return false;
  const raw = params.get(name);
  // `?dev` with no value is on; `?dev=0` is not.
  if (raw === null || raw === '') return true;
  return !FALSY.has(raw.toLowerCase());
}

/**
 * @param search a `location.search`, with or without the leading `?`.
 */
export function parseDevFlags(search: string): DevFlags {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (!isOn(params, 'dev')) return DEV_FLAGS_OFF;
  const flags: DevFlags = {
    aimRay: isOn(params, 'aimRay'),
    shellCount: isOn(params, 'shellCount'),
    seed: asSeed(params, 'seed'),
    mineTrigger: asMineTrigger(params),
    mineReach: isOn(params, 'mineReach'),
    mineTimer: isOn(params, 'mineTimer'),
    level: asLevel(params),
    sandboxTanks: asTanks(params),
    // Absent means disarmed: the sandbox is scenery until explicitly re-armed.
    sandboxDisarmed: params.has('disarmed') ? isOn(params, 'disarmed') : true,
    sandboxWalls: asWalls(params),
    invincible: isOn(params, 'invincible'),
    corpseBlock: isOn(params, 'corpseBlock'),
    muzzleInside: isOn(params, 'muzzleInside'),
    autoplay: isOn(params, 'autoplay'),
    saveIo: isOn(params, 'saveIo'),
    replay: isOn(params, 'replay'),
    gamepad: isOn(params, 'gamepad'),
    players: asPlayers(params),
    coopPool: isOn(params, 'coopPool'),
    quality: asQuality(params),
    bots: asBots(params),
    mode: asMode(params),
    friendlyFire: isOn(params, 'friendlyFire'),
    enemyDeathPulse: isOn(params, 'enemyDeathPulse'),
  };
  // `playtest` is a BUNDLE, not a field: it expands here into the flags a playtest
  // session always wants, so the one-flag-flips-one-field test on DEV_FLAGS_OFF keeps
  // its meaning. OR semantics -- individual flags can add to the kit, not veto it.
  // The membership itself lives in PLAYTEST_BUNDLE.expandsTo (below), the single list
  // both this loop and the generated doc (tools/devflags/render.ts) read, so the two
  // cannot name a different four flags.
  if (isOn(params, 'playtest')) {
    for (const f of PLAYTEST_BUNDLE.expandsTo) {
      flags[f] = true;
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// The FLAG REGISTRY: the machine-readable metadata docs/dev-flags.md is
// generated from (tools/devflags/render.ts, `npm run devflags:doc`).
//
// `Record<keyof DevFlags, FlagSpec>` is the completeness gate, the same idiom
// `TANK_KINDS` uses in sim/config/validate.ts: a `DevFlags` field with no entry
// here is a COMPILE error (a missing required property), and a stray entry that
// names no real field is also a compile error (excess-property checking on a
// directly-typed object literal) -- so a flag literally cannot land without a
// registry entry. devflags.test.ts adds the runtime half (`registryKeyMismatch`,
// tested against synthetic fixtures so its own failure mode is proven, then run
// against the real pair) so the guarantee survives even if this annotation is
// ever loosened to something wider like `Record<string, FlagSpec>`.
//
// `playtest` and `dev` are NOT `DevFlags` fields -- see `PLAYTEST_BUNDLE` and the
// generated doc's own header -- so neither belongs in this Record; adding either
// here is a type error (excess property), which is deliberate.
// ---------------------------------------------------------------------------

/** Whether a flag is an on/off switch or one that carries a value. */
export type FlagKind = 'boolean' | 'valued';

export interface FlagSpec {
  /** The query-string parameter, only when it differs from the DevFlags field name
   *  (the three sandbox knobs: `tanks`, `disarmed`, `walls`). */
  param?: string;
  kind: FlagKind;
  /** For a `valued` flag whose values are a small enumerable set (mineTrigger,
   *  quality, the sandbox roster's element vocabulary): the allowed values, in the
   *  order the parser accepts them. */
  values?: readonly string[];
  /** For a `valued` flag whose value isn't itself one of a small enumerable set (seed,
   *  level, the sandbox wall count): a free-form description of the accepted shape. A
   *  `valued` entry carries at least one of `values`/`type` -- `sandboxTanks` carries
   *  both, `type` framing the multiset shape and `values` giving the per-element
   *  vocabulary. */
  type?: string;
  /** One line, impersonal phrasing: what the flag does. */
  description: string;
  /** Requirements and interactions beyond the blanket `dev=1` gate every flag
   *  already shares (sandbox-only, mutual exclusions, playtest-bundle membership). */
  notes?: readonly string[];
}

/** The keys of DevFlags whose value type is boolean -- what PLAYTEST_BUNDLE.expandsTo
 *  is allowed to contain, so `flags[f] = true` below type-checks without a cast. */
type BooleanFlagKey = {
  [K in keyof DevFlags]: DevFlags[K] extends boolean ? K : never;
}[keyof DevFlags];

export interface BundleSpec {
  readonly kind: 'bundle';
  /** The query-string parameter. */
  readonly param: string;
  readonly description: string;
  /** The DevFlags fields it flips on, in application order -- the parser's `playtest`
   *  branch and the generated doc both read this list, never a hand-kept duplicate. */
  readonly expandsTo: readonly BooleanFlagKey[];
  readonly notes?: readonly string[];
}

export const PLAYTEST_BUNDLE: BundleSpec = {
  kind: 'bundle',
  param: 'playtest',
  description:
    'Switches on the flags a single-player numeric playtest session always wants, in one flag.',
  expandsTo: ['invincible', 'shellCount', 'mineReach', 'mineTimer'],
  notes: [
    'Additive only: an explicit `=0` on one of the four loses to the bundle -- individual ' +
      'flags can ADD to the kit, not veto it.',
    'Deliberately excludes `players`: an orthogonal, riskier experimental mode a shared ' +
      '`?playtest=1` link must not silently enable -- and structurally impossible anyway, ' +
      'since `players` is valued, not boolean, so `expandsTo`\'s own BooleanFlagKey type ' +
      'excludes it from ever being listed here.',
  ],
};

export const FLAG_REGISTRY: Record<keyof DevFlags, FlagSpec> = {
  aimRay: {
    kind: 'boolean',
    description:
      "Draws the player's computed aim: a ray along the turret and a marker where the " +
      'cursor maps to on the ground.',
  },
  shellCount: {
    kind: 'boolean',
    description: 'Shows the count of shells currently in flight against SHELL_CAP.',
    notes: ['In the playtest bundle.'],
  },
  seed: {
    kind: 'valued',
    type: 'a positive integer',
    description:
      "Fixes the world's PRNG seed instead of deriving one from the clock, for a " +
      'reproducible playthrough.',
  },
  mineTrigger: {
    kind: 'valued',
    values: [...MINE_TRIGGERS],
    description:
      "Overrides what may detonate an UNARMED mine (the shipped world default is 'none').",
  },
  mineReach: {
    kind: 'boolean',
    description: "Rings a mine's proximity-trigger radius and its kill radius.",
    notes: ['In the playtest bundle.'],
  },
  mineTimer: {
    kind: 'boolean',
    description: "Shows each mine's remaining fuse, in seconds, beside it.",
    notes: ['In the playtest bundle.'],
  },
  level: {
    kind: 'valued',
    type: 'a 1-based integer index into the campaign, or the literal `sandbox`',
    description: 'Jumps straight to a level, or to the sandbox rig, instead of resuming the active run.',
    notes: ['A jump does not consume, restore, advance, or complete the active run.'],
  },
  sandboxTanks: {
    param: 'tanks',
    kind: 'valued',
    values: [...TANK_KINDS],
    type: 'a comma-separated multiset (repeats and order kept), each element one of the values below',
    description: 'Sets the sandbox enemy roster.',
    notes: [
      'Only read when `level=sandbox`.',
      'Any unrecognised kind rejects the whole list to null rather than dropping entries.',
    ],
  },
  sandboxDisarmed: {
    param: 'disarmed',
    kind: 'boolean',
    description: 'Controls whether sandbox enemies carry weapons.',
    notes: [
      'Only read when `level=sandbox`.',
      'The one boolean flag whose OFF state is true: the sandbox defaults to disarmed even ' +
        'with `dev=1` alone, and `disarmed=0` re-arms it.',
    ],
  },
  sandboxWalls: {
    param: 'walls',
    kind: 'valued',
    type: 'a positive integer, bare or as `random:N`',
    description: 'Sets how many interior walls the sandbox scatters.',
    notes: ['Only read when `level=sandbox`.'],
  },
  invincible: {
    kind: 'boolean',
    description: 'Makes the player unkillable: shells detonate harmlessly, blasts wash over.',
    notes: ['In the playtest bundle.'],
  },
  corpseBlock: {
    kind: 'boolean',
    description:
      'Lets a tank killed earlier in the same tick still block a bullet aimed at it, instead ' +
      'of the shipped ghost rule where the bullet passes through.',
    notes: ['Applies in both the campaign and the sandbox.'],
  },
  muzzleInside: {
    kind: 'boolean',
    description:
      "Restores today's pre-clearance behaviour: a shell can be born already inside an " +
      "adjacent live tank's hit circle.",
    notes: ['Applies in both the campaign and the sandbox.'],
  },
  autoplay: {
    kind: 'boolean',
    description:
      "Drives the player with the scripted \"competent player\" AI instead of reading the " +
      'input controller -- the game demos itself.',
  },
  saveIo: {
    kind: 'boolean',
    description: 'Publishes save export/import on the dev console object (`__tanks`).',
  },
  replay: {
    kind: 'boolean',
    description:
      'Records the per-tick input stream and publishes it on the dev console object.',
  },
  gamepad: {
    kind: 'boolean',
    description: 'Merges gamepad[0] into slot 0\'s input stream alongside keyboard/mouse/touch.',
    notes: [
      'Always padIndex 0, whatever `players` is set to -- this is slot 0\'s own opt-in, ' +
        'unrelated to which OTHER slots exist.',
      'Composes freely with `players` >= 2 (`pad[i] -> slot[i]`): every co-player slot ' +
        '1..N-1 owns its own dedicated pad index, so this flag\'s pad[0] merge can never ' +
        'collide with one. A session\'s only physical pad (usually browser index 0) now ' +
        'feeds slot 0 if this is on, not a co-player slot -- see the players note below.',
    ],
  },
  players: {
    kind: 'valued',
    type: 'an integer 1-4 (1 is an explicit no-op; 2-4 add co-players)',
    description:
      'Sets how many player-controlled tanks share the world -- couch co-op, generalized ' +
      'past two.',
    notes: [
      'Composes freely with `gamepad`: slot 0\'s optional pad[0] merge and every co-player ' +
        'slot\'s own dedicated pad index (`pad[i] -> slot[i]`) read different indices of ' +
        'the same pads array, so they never collide.',
      'Named tradeoff: a session\'s only physical pad (usually browser index 0) now feeds ' +
        'slot 0 (if `gamepad` is on), not slot 1 -- "P1 on keyboard, hand the one pad to ' +
        'P2" has no zero-flag path anymore.',
      'Not part of the playtest bundle.',
      'Ignored under `level=sandbox`: the sandbox has no co-op spawn rule and always builds ' +
        'for one player.',
      'Excluded from writing to the active run: the shared life pool has no decided meaning ' +
        'against the single-player-shaped run record yet.',
    ],
  },
  coopPool: {
    kind: 'boolean',
    description:
      'Restores the shipped shared-life-pool coop model: every player death drains the ' +
      'pool by one and schedules that tank\'s own per-tank respawn. The default (this ' +
      'flag off) is the shared-attempts ruling: a lone death costs nothing and the ' +
      'survivor fights on; only a full wipe spends a life and restarts the arena.',
    notes: ['Only meaningful once `players` >= 2.'],
  },
  quality: {
    kind: 'valued',
    values: [...QUALITY_PRESET_NAMES],
    description:
      'Selects a render quality preset (antialiasing, pixel ratio cap, shadow map size and ' +
      'filter) instead of the shipped `high` default.',
  },
  bots: {
    kind: 'valued',
    type: 'an integer 0-4 (0 is an explicit no-op; 1-4 claim that many of the LAST slots)',
    description:
      'Sets how many of the player slots are computer-controlled -- simulated players ' +
      "riding the same substitution mechanism the `autoplay` flag already uses at slot 0.",
    notes: [
      'May equal `players` (including the unflagged default of 1), for a fully ' +
        'autonomous match.',
      'Clamped against the resolved player count, not rejected: `bots=4` with ' +
        '`players=2` claims both slots rather than erroring.',
      'A bot-claimed slot never builds its slot\'s real controller -- its own dedicated ' +
        'gamepad reader (`pad[i] -> slot[i]`).',
      'Not excluded from the sandbox, unlike `players`: the sandbox always resolves to ' +
        'one slot, and `bots=1` there is the same substitution `autoplay=1` already does.',
    ],
  },
  mode: {
    kind: 'valued',
    values: [...VERSUS_MODE_NAMES],
    description:
      'Sets which versus mode a session builds with -- free-for-all or teams -- instead ' +
      "of the shipped campaign-coop rule (win as every enemy dead, or coop's shared " +
      'lives).',
    notes: [
      'Unrecognised or absent leaves the campaign-coop default.',
      'Strips every enemy spawn from the built arena: versus modes have no AI opponents.',
    ],
  },
  friendlyFire: {
    kind: 'boolean',
    description:
      "Lets a shell or mine blast harm a teammate -- meaningful only once `mode=teams`; " +
      'the default protects teammates.',
    notes: ['Inert unless `mode=teams`.'],
  },
  enemyDeathPulse: {
    kind: 'boolean',
    description:
      'Enemy tanks also fire the identity death pulse (a coloured world ring); off = ' +
      'players only, enemies keep just the explosion burst.',
  },
};

/**
 * Both-directions key comparison, factored out so it has its own failure mode to test
 * against synthetic fixtures -- a bare `Object.keys(FLAG_REGISTRY).toEqual(...)` against
 * the real registry can never go red while the `Record<keyof DevFlags, FlagSpec>`
 * annotation stands, which would make the guard decorative. devflags.test.ts proves this
 * function itself can catch a missing or an extra key before relying on it to check the
 * real FLAG_REGISTRY / DEV_FLAGS_OFF pair.
 */
export function registryKeyMismatch(
  registry: object,
  flags: object,
): { missing: string[]; extra: string[] } {
  const registryKeys = new Set(Object.keys(registry));
  const flagKeys = new Set(Object.keys(flags));
  return {
    missing: [...flagKeys].filter((k) => !registryKeys.has(k)).sort(),
    extra: [...registryKeys].filter((k) => !flagKeys.has(k)).sort(),
  };
}
