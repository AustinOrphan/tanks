import { TOUCH_SCHEMES, FIRE_MODES, type TouchScheme, type FireMode } from '../input/touch';
import { DEFAULT_VOLUME } from '../audio/manifest';
import { TOUCH_SETTINGS_KEY, readLegacyTouchSettings } from './touch-settings';

/**
 * The ONE store every durable player preference lives in (issue #320).
 *
 * Before this module the preferences were split three ways: touch scheme, fire mode and
 * haptics under `tanks.touch.v1` (touch-settings.ts, now a legacy READER only), and mute
 * and volume nowhere at all -- they were session-local fields on the audio engine, so a
 * reload OR an internal session replacement (boot.ts reboots the whole game handle to
 * enter a versus match) silently restored DEFAULT_VOLUME and unmuted. Reduced motion was
 * a `matchMedia` call inside render/preview.ts with no stored override at all, and UI
 * scale did not exist.
 *
 * Three values are deliberately distinguished and must not be conflated:
 *
 *  1. the player's STORED preference -- what this module owns and persists;
 *  2. the current platform CAPABILITY or OS preference -- capabilities.ts;
 *  3. the EFFECTIVE value a consumer should use -- effective-settings.ts.
 *
 * Nothing here reads a capability. A preference for a capability the device lacks stays
 * stored and comes back the moment the capability appears (a controller with a rumble
 * motor being plugged in), which is exactly what "unsupported capability must not erase
 * the stored preference" means.
 *
 * ## The schema
 *
 * | Field | Default | Accepted domain | Invalid stored value | Invalid setter argument |
 * | --- | --- | --- | --- | --- |
 * | `audio.muted` | `false` | boolean | default | (booleans have no off-domain value) |
 * | `audio.volume` | `DEFAULT_VOLUME` (0.6) | finite number in [0, 1] | finite out of range is CLAMPED; NaN/Infinity/non-number falls back to the default | non-finite is REFUSED (no change); finite is clamped |
 * | `input.touchScheme` | `'stick'` | `TOUCH_SCHEMES` | default | refused |
 * | `input.fireMode` | `'tap'` | `FIRE_MODES` | default | refused |
 * | `input.deviceHaptics` | `true` | boolean | default | -- |
 * | `input.controllerRumble` | `true` | boolean | default | -- |
 * | `presentation.motion` | `'system'` | `MOTION_PREFERENCES` | default | refused |
 * | `presentation.uiScale` | `100` | `UI_SCALES` (100/125/150 percent) | default | refused |
 *
 * Every field validates INDEPENDENTLY -- junk in one must never reset a sibling. That is
 * the property `tanks.touch.v1` already had (see touch-settings.ts's own comment) and it
 * is preserved across the migration: a legacy payload with a valid `scheme` and a junk
 * `fireMode` keeps the scheme.
 *
 * Persistence: every accepted change is written back immediately, as one JSON payload
 * under `SETTINGS_KEY`, and the shadow carries the session when the write throws.
 *
 * Capability and effective-value rules live in effective-settings.ts, next to the code
 * that applies them, rather than being restated here where they could drift.
 */
export const SETTINGS_KEY = 'tanks.settings.v1';

/**
 * The version of the PAYLOAD SHAPE, stored INSIDE the payload rather than only in the key
 * name.
 *
 * The other stores version themselves by key (`tanks.progress.v1`), which is enough when
 * the only question is "does this build know this key". It is not enough here: a build
 * that ships schema 2 under the SAME key must be able to hand its data back to this build
 * without this build silently reinterpreting or destroying it. An explicit integer inside
 * the payload is what makes `version > SETTINGS_SCHEMA_VERSION` a recognisable state
 * instead of a pile of unknown fields that per-field validation would quietly default.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

/** The player-facing motion states. Exactly three -- see the effective rule in effective-settings.ts. */
export const MOTION_PREFERENCES = ['system', 'full', 'reduced'] as const;
export type MotionPreference = (typeof MOTION_PREFERENCES)[number];

/**
 * UI scale as a PERCENTAGE of the base interface size, from a closed preset list.
 *
 * A preset list rather than an arbitrary number because nothing in the tree yet defines a
 * continuous contract: issue #290 asks for "bounded shared tokens ... and user UI scale"
 * and names target sizes (body text 16-20 px, TV 20-26 px; controls 48 px preferred,
 * never below 44 px) but no scale range, and #321 owns the tokens these multiply. A
 * closed set also makes the invalid-value story trivial -- NaN, Infinity, 0 and 10000 are
 * all simply not members -- where a range would need its own clamp and rounding rules.
 * Widening this to a continuous range later is a schema change with an obvious migration
 * (every current value is still valid); narrowing an unbounded number would not be.
 */
export const UI_SCALES = [100, 125, 150] as const;
export type UiScale = (typeof UI_SCALES)[number];

export const DEFAULT_MUTED = false;
/** Re-exported through this module so consumers read ONE settings default, not two. */
export { DEFAULT_VOLUME };
export const DEFAULT_TOUCH_SCHEME: TouchScheme = 'stick';
export const DEFAULT_FIRE_MODE: FireMode = 'tap';
export const DEFAULT_DEVICE_HAPTICS = true;
/**
 * Rumble defaults ON, the same as device haptics.
 *
 * The two are SEPARATE capabilities (a phone vibrates but has no pad; a desktop pad
 * rumbles while the browser has no `navigator.vibrate` at all -- see capabilities.ts),
 * so they are separate stored fields. But they are the same kind of feedback from the
 * player's point of view, and defaulting one on and the other off would mean a player who
 * never opens Settings gets haptics on their phone and silence on their controller for no
 * reason they could name. Neither default can produce feedback on a device that cannot
 * deliver it, because the effective rule gates both on their own capability.
 */
export const DEFAULT_CONTROLLER_RUMBLE = true;
export const DEFAULT_MOTION: MotionPreference = 'system';
export const DEFAULT_UI_SCALE: UiScale = 100;

export interface AudioSettings {
  readonly muted: boolean;
  readonly volume: number;
}

export interface InputSettings {
  readonly touchScheme: TouchScheme;
  readonly fireMode: FireMode;
  /** Device vibration (`navigator.vibrate`). Distinct from `controllerRumble`. */
  readonly deviceHaptics: boolean;
  /** Gamepad actuator rumble. NEVER delivered through `navigator.vibrate`. */
  readonly controllerRumble: boolean;
}

export interface PresentationSettings {
  readonly motion: MotionPreference;
  readonly uiScale: UiScale;
}

export interface PlayerSettings {
  readonly audio: AudioSettings;
  readonly input: InputSettings;
  readonly presentation: PresentationSettings;
}

export const DEFAULT_SETTINGS: PlayerSettings = Object.freeze({
  audio: Object.freeze({ muted: DEFAULT_MUTED, volume: DEFAULT_VOLUME }),
  input: Object.freeze({
    touchScheme: DEFAULT_TOUCH_SCHEME,
    fireMode: DEFAULT_FIRE_MODE,
    deviceHaptics: DEFAULT_DEVICE_HAPTICS,
    controllerRumble: DEFAULT_CONTROLLER_RUMBLE,
  }),
  presentation: Object.freeze({ motion: DEFAULT_MOTION, uiScale: DEFAULT_UI_SCALE }),
});

/**
 * What `resolveStorage` found, which is NOT the same question as "do writes work".
 *
 * storage.ts deliberately does not write-probe (the origin is shared with the rest of
 * austinorphan.com, so a probe key would land in a neighbour's namespace), so this
 * answers only "is there a real `Storage` object here or the in-memory shim". A real
 * `Storage` whose `setItem` throws -- Safari private mode -- reports `'persistent'` here
 * and is caught by `SettingsStatus.persistence` instead, on the first write that fails.
 * Collapsing the two into one boolean is what would make private mode claim to be saving.
 *
 * Declared HERE rather than in storage.ts so storage.ts imports this module and this
 * module imports nothing back: a value-level import cycle between the two would be a real
 * hazard, and a type-only import in the other direction is not enough to prevent one.
 */
export type StorageAvailability = 'persistent' | 'memory';

/**
 * Whether accepted settings are actually reaching durable storage, and why not.
 *
 * - `'persisted'` -- a real `Storage` that has not refused a write.
 * - `'memory'` -- no real `Storage` at all; the session's changes die with the page.
 * - `'error'` -- a real `Storage` whose read or write THREW. Safari private mode.
 * - `'locked-future'` -- a payload from a NEWER schema is under `SETTINGS_KEY`. Writing
 *   would destroy data this build cannot represent, so nothing is written until `reset()`.
 */
export type SettingsPersistence = 'persisted' | 'memory' | 'error' | 'locked-future';

/**
 * What was found under `SETTINGS_KEY`.
 *
 * - `'current'` -- absent, or a well-formed payload at `SETTINGS_SCHEMA_VERSION`.
 * - `'recovered'` -- something was there that this build could not use as a whole
 *   (invalid JSON, wrong root type, missing/invalid version). Accepted values are
 *   defaults plus whatever legacy migration could rescue.
 * - `'future'` -- a well-formed payload whose `version` is greater than this build's.
 */
export type SettingsSchemaState = 'current' | 'recovered' | 'future';

export interface SettingsStatus {
  /** What `resolveStorage` found. See `StorageAvailability`. */
  readonly availability: StorageAvailability;
  readonly persistence: SettingsPersistence;
  /** Derived: `persistence === 'persisted'`. Present so consumers need no case analysis. */
  readonly writable: boolean;
  readonly schema: SettingsSchemaState;
  /** The `version` integer found when `schema === 'future'`, else null. */
  readonly storedVersion: number | null;
  /** True when this construction adopted values from `tanks.touch.v1`. */
  readonly migratedLegacy: boolean;
}

export type SettingsNoticeKind = 'not-persisted' | 'future-schema';

export interface SettingsNotice {
  readonly kind: SettingsNoticeKind;
  readonly message: string;
}

/** The wording issue #320 asks for, verbatim. One line, no punctuation the HUD must trim. */
export const NOT_PERSISTED_NOTICE = "Settings won't be saved this session.";
export const FUTURE_SCHEMA_NOTICE =
  "Settings from a newer version were found. Changes won't be saved until they are reset.";

/**
 * The notice a status deserves, or null when there is nothing to say.
 *
 * A FUNCTION of the status rather than a flag the store sets, so "which notice" cannot
 * drift from "what actually happened" -- and so a test can drive every branch without
 * constructing a store at all.
 */
export function noticeFor(status: SettingsStatus): SettingsNotice | null {
  if (status.persistence === 'locked-future') {
    return { kind: 'future-schema', message: FUTURE_SCHEMA_NOTICE };
  }
  if (status.persistence === 'memory' || status.persistence === 'error') {
    return { kind: 'not-persisted', message: NOT_PERSISTED_NOTICE };
  }
  return null;
}

export interface PlayerSettingsStore {
  /** The accepted settings. A frozen value, safe to hold. */
  snapshot(): PlayerSettings;
  status(): SettingsStatus;
  setMuted(v: boolean): void;
  /** Non-finite is refused; a finite value is clamped into [0, 1]. */
  setVolume(v: number): void;
  /** Off-list values are refused, not stored -- the discipline `tanks.touch.v1` had. */
  setTouchScheme(id: TouchScheme): void;
  setFireMode(id: FireMode): void;
  setDeviceHaptics(v: boolean): void;
  setControllerRumble(v: boolean): void;
  setMotion(p: MotionPreference): void;
  setUiScale(s: UiScale): void;
  /**
   * Restore the documented defaults and persist them.
   *
   * The ONLY operation allowed to overwrite a future-schema payload, and deliberately so:
   * `persistence === 'locked-future'` otherwise has no exit, and issue #320 states that
   * settings "cannot safely be saved until reset or a compatible version is used". Also
   * clears the legacy key, so a reset cannot be undone by a later migration.
   */
  reset(): void;
  /** Fired after every ACCEPTED change, and after any change to `status()`. */
  subscribe(cb: (settings: PlayerSettings, status: SettingsStatus) => void): () => void;
}

export interface SettingsStoreOptions {
  /** Defaults to `'persistent'`: a caller that says nothing is handing over a real Storage. */
  readonly availability?: StorageAvailability;
}

const SCHEME_IDS = new Set<string>(TOUCH_SCHEMES);
const FIRE_MODE_IDS = new Set<string>(FIRE_MODES);
const MOTION_IDS = new Set<string>(MOTION_PREFERENCES);
const UI_SCALE_VALUES = new Set<number>(UI_SCALES);

/** Finite, in range, or null. NaN and both infinities fail `Number.isFinite`. */
function acceptedVolume(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  // Clamp rather than reject: a finite out-of-range number is an unambiguous intent
  // ("as loud as possible"), unlike NaN, which carries none.
  return Math.max(0, Math.min(1, v));
}

function acceptedBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function acceptedFrom<T extends string>(v: unknown, ids: ReadonlySet<string>, fallback: T): T {
  return typeof v === 'string' && ids.has(v) ? (v as T) : fallback;
}

function freezeSettings(s: PlayerSettings): PlayerSettings {
  return Object.freeze({
    audio: Object.freeze({ ...s.audio }),
    input: Object.freeze({ ...s.input }),
    presentation: Object.freeze({ ...s.presentation }),
  });
}

/** A plain object, not an array and not null -- the shape every payload branch needs first. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function groupOf(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const group = payload[key];
  // A non-object group is not fatal: every field below defaults independently, so
  // `{"audio": 7}` loses audio and keeps input, exactly like a junk sibling field.
  return isRecord(group) ? group : {};
}

/** The parse outcome, before any legacy migration is considered. */
type ParsedPayload =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'future'; readonly version: number }
  | { readonly kind: 'current'; readonly settings: PlayerSettings };

export function parseSettingsPayload(raw: string | null): ParsedPayload {
  if (raw === null || raw === '') return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'malformed' };
  }
  if (!isRecord(parsed)) return { kind: 'malformed' };
  const version = parsed.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { kind: 'malformed' };
  }
  if (version > SETTINGS_SCHEMA_VERSION) return { kind: 'future', version };
  const audio = groupOf(parsed, 'audio');
  const input = groupOf(parsed, 'input');
  const presentation = groupOf(parsed, 'presentation');
  return {
    kind: 'current',
    settings: freezeSettings({
      audio: {
        muted: acceptedBoolean(audio.muted, DEFAULT_MUTED),
        volume: acceptedVolume(audio.volume) ?? DEFAULT_VOLUME,
      },
      input: {
        touchScheme: acceptedFrom(input.touchScheme, SCHEME_IDS, DEFAULT_TOUCH_SCHEME),
        fireMode: acceptedFrom(input.fireMode, FIRE_MODE_IDS, DEFAULT_FIRE_MODE),
        deviceHaptics: acceptedBoolean(input.deviceHaptics, DEFAULT_DEVICE_HAPTICS),
        controllerRumble: acceptedBoolean(input.controllerRumble, DEFAULT_CONTROLLER_RUMBLE),
      },
      presentation: {
        motion: acceptedFrom(presentation.motion, MOTION_IDS, DEFAULT_MOTION),
        uiScale:
          typeof presentation.uiScale === 'number' && UI_SCALE_VALUES.has(presentation.uiScale)
            ? (presentation.uiScale as UiScale)
            : DEFAULT_UI_SCALE,
      },
    }),
  };
}

/** The wire form. A named function so the payload shape has exactly one producer. */
export function serializeSettings(settings: PlayerSettings): string {
  return JSON.stringify({
    version: SETTINGS_SCHEMA_VERSION,
    audio: { muted: settings.audio.muted, volume: settings.audio.volume },
    input: {
      touchScheme: settings.input.touchScheme,
      fireMode: settings.input.fireMode,
      deviceHaptics: settings.input.deviceHaptics,
      controllerRumble: settings.input.controllerRumble,
    },
    presentation: {
      motion: settings.presentation.motion,
      uiScale: settings.presentation.uiScale,
    },
  });
}

export function createPlayerSettingsStore(
  storage: Storage,
  options: SettingsStoreOptions = {},
): PlayerSettingsStore {
  const availability: StorageAvailability = options.availability ?? 'persistent';

  let shadow: PlayerSettings = DEFAULT_SETTINGS;
  let schema: SettingsSchemaState = 'current';
  let storedVersion: number | null = null;
  let migratedLegacy = false;
  /** Set when a real Storage read or write THREW. Never cleared except by a successful reset. */
  let storageErrored = false;
  /** Set while a future payload is under the key. Cleared only by `reset()`. */
  let lockedFuture = false;

  const listeners = new Set<(s: PlayerSettings, st: SettingsStatus) => void>();

  function currentStatus(): SettingsStatus {
    const persistence: SettingsPersistence = lockedFuture
      ? 'locked-future'
      : availability === 'memory'
        ? 'memory'
        : storageErrored
          ? 'error'
          : 'persisted';
    return Object.freeze({
      availability,
      persistence,
      writable: persistence === 'persisted',
      schema,
      storedVersion,
      migratedLegacy,
    });
  }

  function notify(): void {
    const s = shadow;
    const st = currentStatus();
    for (const cb of [...listeners]) cb(s, st);
  }

  function readRaw(key: string): string | null {
    try {
      return storage.getItem(key);
    } catch {
      // A throwing getItem is a storage that is not going to hold anything either. Say
      // so now rather than claiming to be persisting until the first write proves it.
      storageErrored = true;
      return null;
    }
  }

  /** True when the bytes actually went in. The return value is the whole point. */
  function write(value: PlayerSettings): boolean {
    try {
      storage.setItem(SETTINGS_KEY, serializeSettings(value));
      return true;
    } catch {
      storageErrored = true;
      return false;
    }
  }

  function removeLegacy(): void {
    try {
      storage.removeItem(TOUCH_SETTINGS_KEY);
    } catch {
      // Deliberately does NOT set `storageErrored`: every caller has already written the
      // canonical payload successfully, so settings ARE being saved and claiming
      // otherwise would put a false "won't be saved" notice on screen. A stale legacy key
      // is inert -- nothing writes it, and the next construction sees valid canonical
      // settings, so it is never read back over them.
    }
  }

  // ---- Construction: parse, then migrate only when there is nothing canonical to lose.
  const parsed = parseSettingsPayload(readRaw(SETTINGS_KEY));
  if (parsed.kind === 'future') {
    // Its raw bytes are left EXACTLY as they are. Not parsed field-by-field (unvalidated
    // future data must not enter the accepted model), not overwritten, and not migrated
    // over -- a newer build's payload is real data, and the legacy key is older than it.
    schema = 'future';
    storedVersion = parsed.version;
    lockedFuture = true;
  } else if (parsed.kind === 'current') {
    shadow = parsed.settings;
    // Canonical wins outright. A legacy key sitting beside it is cleaned up so there is
    // exactly ONE key any current build writes -- and cleaning up here rather than only
    // on migration is what makes "no second writable source of truth" literally true.
    const legacy = readLegacyTouchSettings(storage);
    if (legacy.present) removeLegacy();
  } else {
    // Absent OR malformed. The literal requirement in issue #320 is "if the canonical key
    // is absent"; malformed is folded in deliberately, as a superset: there are no newer
    // canonical settings to lose (nothing in the payload was usable), the legacy values
    // are the only real preferences left, and dropping them would be silent data loss.
    // A FUTURE payload is excluded from this branch on purpose -- that one IS real data.
    schema = parsed.kind === 'malformed' ? 'recovered' : 'current';
    const legacy = readLegacyTouchSettings(storage);
    if (legacy.present) {
      // Field by field: a valid sibling survives a malformed one.
      shadow = freezeSettings({
        audio: DEFAULT_SETTINGS.audio,
        input: {
          touchScheme: legacy.scheme ?? DEFAULT_TOUCH_SCHEME,
          fireMode: legacy.fireMode ?? DEFAULT_FIRE_MODE,
          deviceHaptics: legacy.haptics ?? DEFAULT_DEVICE_HAPTICS,
          // Not a legacy field: `tanks.touch.v1` never had one.
          controllerRumble: DEFAULT_CONTROLLER_RUMBLE,
        },
        presentation: DEFAULT_SETTINGS.presentation,
      });
      migratedLegacy = legacy.scheme !== null || legacy.fireMode !== null || legacy.haptics !== null;
      // ORDER IS THE CONTRACT: the legacy key is removed only after the canonical write
      // is known to have landed. Reversing these two loses the player's preferences on
      // any storage that refuses writes.
      if (write(shadow)) removeLegacy();
      // If the write failed, the migrated values stay usable in memory and the legacy
      // bytes stay on disk, so the next construction migrates them again.
    }
  }

  /** Every setter funnels through here so "accept, then persist, then notify" has one body. */
  function commit(next: PlayerSettings): void {
    shadow = freezeSettings(next);
    // A future payload is never overwritten by an ordinary change -- only `reset()`
    // clears the lock. The change still applies in memory for this session.
    if (!lockedFuture) write(shadow);
    notify();
  }

  return {
    snapshot: () => shadow,
    status: currentStatus,
    setMuted(v: boolean): void {
      commit({ ...shadow, audio: { ...shadow.audio, muted: v } });
    },
    setVolume(v: number): void {
      const accepted = acceptedVolume(v);
      if (accepted === null) return;
      commit({ ...shadow, audio: { ...shadow.audio, volume: accepted } });
    },
    setTouchScheme(id: TouchScheme): void {
      if (!SCHEME_IDS.has(id)) return;
      commit({ ...shadow, input: { ...shadow.input, touchScheme: id } });
    },
    setFireMode(id: FireMode): void {
      if (!FIRE_MODE_IDS.has(id)) return;
      commit({ ...shadow, input: { ...shadow.input, fireMode: id } });
    },
    setDeviceHaptics(v: boolean): void {
      commit({ ...shadow, input: { ...shadow.input, deviceHaptics: v } });
    },
    setControllerRumble(v: boolean): void {
      commit({ ...shadow, input: { ...shadow.input, controllerRumble: v } });
    },
    setMotion(p: MotionPreference): void {
      if (!MOTION_IDS.has(p)) return;
      commit({ ...shadow, presentation: { ...shadow.presentation, motion: p } });
    },
    setUiScale(s: UiScale): void {
      if (!UI_SCALE_VALUES.has(s)) return;
      commit({ ...shadow, presentation: { ...shadow.presentation, uiScale: s } });
    },
    reset(): void {
      shadow = DEFAULT_SETTINGS;
      // Clear the lock BEFORE writing: this is the one deliberate overwrite of a future
      // payload, and leaving the lock set would make the write a no-op.
      lockedFuture = false;
      schema = 'current';
      storedVersion = null;
      migratedLegacy = false;
      if (write(shadow)) {
        // A successful write means this storage does accept writes after all.
        storageErrored = false;
        removeLegacy();
      }
      notify();
    },
    subscribe(cb): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
