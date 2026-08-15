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
import type { TankKind, UnarmedTrigger } from '../sim/types';
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
   * Read `navigator.getGamepads()` and merge gamepad[0] into the input stream alongside
   * keyboard/mouse/touch -- see `src/input/gamepad.ts`. Single player only: gamepad[1]
   * onward is ignored, matching every other input path (nothing about multiplayer exists
   * beyond `stepInputs` taking a list -- see CLAUDE.md).
   */
  gamepad: boolean;
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
  quality: null,
};

/** Values that read as "off" when a flag is present but negative. */
const FALSY = new Set(['0', 'false', 'off', 'no']);

const MINE_TRIGGERS = new Set(['none', 'proximity', 'bullet', 'both']);

const QUALITY_PRESET_NAMES = new Set(['low', 'medium', 'high']);

/** One of the three named presets, or null when absent or unrecognised -- an
 * unrecognised value (`?quality=potato`) is rejected to null rather than guessed,
 * matching asMineTrigger below; null resolves to the `high` default downstream. */
function asQuality(params: URLSearchParams): QualityPreset | null {
  const raw = params.get('quality');
  if (raw === null) return null;
  return QUALITY_PRESET_NAMES.has(raw) ? (raw as QualityPreset) : null;
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
    quality: asQuality(params),
  };
  // `playtest` is a BUNDLE, not a field: it expands here into the flags a playtest
  // session always wants, so the one-flag-flips-one-field test on DEV_FLAGS_OFF keeps
  // its meaning. OR semantics -- individual flags can add to the kit, not veto it.
  if (isOn(params, 'playtest')) {
    flags.invincible = true;
    flags.shellCount = true;
    flags.mineReach = true;
    flags.mineTimer = true;
  }
  return flags;
}
