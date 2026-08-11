import { TOUCH_SCHEMES, FIRE_MODES, type TouchScheme, type FireMode } from '../input/touch';

/**
 * The right thumb's chosen aim scheme (see touch.ts's `TouchScheme`), how it pulls the
 * trigger (`FireMode`), and whether haptic pulses (haptics.ts) are on, persisted the
 * same way the paint shop's choice is (customization.ts) but under its OWN key: these
 * are input/feedback preferences, not cosmetic ones, and a junk value in one FIELD must
 * never be able to reset another -- all three degrade independently, exactly as this
 * store's own key is separate from customization's. Haptics rides this store rather than
 * a new one: it is a sixth `tanks.*` key only if it needs to be, and a field fits.
 */
export const TOUCH_SETTINGS_KEY = 'tanks.touch.v1';

export const DEFAULT_TOUCH_SCHEME: TouchScheme = 'stick';
export const DEFAULT_FIRE_MODE: FireMode = 'tap';
/** On by default, the same convention as audio (unmuted until the player says otherwise). */
export const DEFAULT_HAPTICS = true;

const SCHEME_IDS = new Set<string>(TOUCH_SCHEMES);
const FIRE_MODE_IDS = new Set<string>(FIRE_MODES);

export interface TouchSettingsStore {
  scheme(): TouchScheme;
  /** Off-list values are refused, not stored -- same discipline as an off-palette hull. */
  setScheme(id: TouchScheme): void;
  fireMode(): FireMode;
  /** Off-list values are refused, not stored -- same discipline as setScheme. */
  setFireMode(id: FireMode): void;
  /** Whether haptics.ts's vibrate calls are allowed through. */
  haptics(): boolean;
  setHaptics(v: boolean): void;
}

export function createTouchSettingsStore(storage: Storage): TouchSettingsStore {
  function read(): { scheme: TouchScheme; fireMode: FireMode; haptics: boolean } {
    const fallback = {
      scheme: DEFAULT_TOUCH_SCHEME,
      fireMode: DEFAULT_FIRE_MODE,
      haptics: DEFAULT_HAPTICS,
    };
    let raw: string | null = null;
    try {
      raw = storage.getItem(TOUCH_SETTINGS_KEY);
    } catch {
      return fallback;
    }
    if (raw === null || raw === '') return fallback;
    try {
      const parsed = JSON.parse(raw) as
        | { scheme?: unknown; fireMode?: unknown; haptics?: unknown }
        | null;
      // Each field validated and defaulted independently: junk in one must never fall
      // back another away from what it actually stored.
      return {
        scheme:
          typeof parsed?.scheme === 'string' && SCHEME_IDS.has(parsed.scheme)
            ? (parsed.scheme as TouchScheme)
            : DEFAULT_TOUCH_SCHEME,
        fireMode:
          typeof parsed?.fireMode === 'string' && FIRE_MODE_IDS.has(parsed.fireMode)
            ? (parsed.fireMode as FireMode)
            : DEFAULT_FIRE_MODE,
        haptics: typeof parsed?.haptics === 'boolean' ? parsed.haptics : DEFAULT_HAPTICS,
      };
    } catch {
      return fallback;
    }
  }

  let shadow = read();

  function persist(): void {
    try {
      storage.setItem(TOUCH_SETTINGS_KEY, JSON.stringify(shadow));
    } catch {
      // Private mode: the shadow carries the session.
    }
  }

  return {
    scheme: () => shadow.scheme,
    setScheme(id: TouchScheme): void {
      if (!SCHEME_IDS.has(id)) return;
      shadow = { ...shadow, scheme: id };
      persist();
    },
    fireMode: () => shadow.fireMode,
    setFireMode(id: FireMode): void {
      if (!FIRE_MODE_IDS.has(id)) return;
      shadow = { ...shadow, fireMode: id };
      persist();
    },
    haptics: () => shadow.haptics,
    setHaptics(v: boolean): void {
      shadow = { ...shadow, haptics: v };
      persist();
    },
  };
}
