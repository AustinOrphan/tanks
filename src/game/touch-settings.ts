import { TOUCH_SCHEMES, FIRE_MODES, type TouchScheme, type FireMode } from '../input/touch';

/**
 * The LEGACY touch-preferences key, kept as a READER only (issue #320).
 *
 * This module used to own a writable store: the right thumb's aim scheme, its fire mode
 * and the haptics switch, persisted under `tanks.touch.v1` with per-field validation. All
 * three now live in the canonical `tanks.settings.v1` payload (settings.ts), which also
 * covers mute, volume, controller rumble, motion policy and UI scale -- one versioned
 * model instead of a settings key that grew a field whenever one was needed.
 *
 * The store is GONE rather than deprecated in place. Leaving a second writable source
 * would mean two shadows over one preference, and whichever wrote last would win by
 * accident; issue #320 asks for exactly one authoritative store.
 *
 * What survives is the compatibility surface:
 *
 *  - `TOUCH_SETTINGS_KEY`, so the save importer can still accept an export taken before
 *    the canonical key existed (save.ts's `SAVE_IMPORT_KEYS`), and so the settings store
 *    can find and clear it;
 *  - `readLegacyTouchSettings`, the one-way migration read.
 *
 * Nothing in the tree writes this key any more. `createPlayerSettingsStore` removes it as
 * soon as it has written the canonical payload, so an ordinary session converges to one
 * key on its first boot after the upgrade.
 */
export const TOUCH_SETTINGS_KEY = 'tanks.touch.v1';

const SCHEME_IDS = new Set<string>(TOUCH_SCHEMES);
const FIRE_MODE_IDS = new Set<string>(FIRE_MODES);

/**
 * What a legacy payload actually carried, field by field.
 *
 * `present` is separate from the three fields, and is the reason this is not just a
 * nullable object: `present: true` with all three fields null is a key holding junk,
 * which still has to be CLEANED UP after migration, while `present: false` is a key that
 * was never there and must not cause a write at all.
 *
 * Each field is `null` when it was missing or off-domain, never defaulted here. Applying
 * defaults is the canonical store's job, and a reader that defaulted would make "the
 * legacy value was 'stick'" and "there was no legacy value" indistinguishable -- the
 * exact distinction migration needs to preserve a valid sibling of a malformed field.
 */
export interface LegacyTouchRead {
  readonly present: boolean;
  readonly scheme: TouchScheme | null;
  readonly fireMode: FireMode | null;
  readonly haptics: boolean | null;
}

const ABSENT: LegacyTouchRead = Object.freeze({
  present: false,
  scheme: null,
  fireMode: null,
  haptics: null,
});

export function readLegacyTouchSettings(storage: Storage): LegacyTouchRead {
  let raw: string | null;
  try {
    raw = storage.getItem(TOUCH_SETTINGS_KEY);
  } catch {
    // A storage that refuses reads has nothing to migrate and nothing to clean up.
    return ABSENT;
  }
  if (raw === null) return ABSENT;
  // An EMPTY string is present-but-useless: worth clearing, with nothing to adopt.
  const junk: LegacyTouchRead = Object.freeze({
    present: true,
    scheme: null,
    fireMode: null,
    haptics: null,
  });
  if (raw === '') return junk;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return junk;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return junk;
  const p = parsed as { scheme?: unknown; fireMode?: unknown; haptics?: unknown };
  return Object.freeze({
    present: true,
    scheme: typeof p.scheme === 'string' && SCHEME_IDS.has(p.scheme) ? (p.scheme as TouchScheme) : null,
    fireMode:
      typeof p.fireMode === 'string' && FIRE_MODE_IDS.has(p.fireMode) ? (p.fireMode as FireMode) : null,
    haptics: typeof p.haptics === 'boolean' ? p.haptics : null,
  });
}
