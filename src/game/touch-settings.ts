import { TOUCH_SCHEMES, type TouchScheme } from '../input/touch';

/**
 * The right thumb's chosen aim scheme (see touch.ts's `TouchScheme`), persisted the same
 * way the paint shop's choice is (customization.ts) but under its OWN key: this is an
 * input preference, not a cosmetic one, and a junk value in one must never be able to
 * reset the other. Two stores, two blast radii.
 */
export const TOUCH_SETTINGS_KEY = 'tanks.touch.v1';

export const DEFAULT_TOUCH_SCHEME: TouchScheme = 'stick';

const SCHEME_IDS = new Set<string>(TOUCH_SCHEMES);

export interface TouchSettingsStore {
  scheme(): TouchScheme;
  /** Off-list values are refused, not stored -- same discipline as an off-palette hull. */
  setScheme(id: TouchScheme): void;
}

export function createTouchSettingsStore(storage: Storage): TouchSettingsStore {
  function read(): { scheme: TouchScheme } {
    const fallback = { scheme: DEFAULT_TOUCH_SCHEME };
    let raw: string | null = null;
    try {
      raw = storage.getItem(TOUCH_SETTINGS_KEY);
    } catch {
      return fallback;
    }
    if (raw === null || raw === '') return fallback;
    try {
      const parsed = JSON.parse(raw) as { scheme?: unknown } | null;
      return {
        scheme:
          typeof parsed?.scheme === 'string' && SCHEME_IDS.has(parsed.scheme)
            ? (parsed.scheme as TouchScheme)
            : DEFAULT_TOUCH_SCHEME,
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
  };
}
