// @vitest-environment jsdom
// The canonical player-settings store (issue #320): defaults, per-field validation,
// persistence, the one-way migration from `tanks.touch.v1`, and the three storage
// failure shapes -- unavailable, throwing, and a payload from a schema this build does
// not understand.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPlayerSettingsStore,
  parseSettingsPayload,
  serializeSettings,
  noticeFor,
  DEFAULT_SETTINGS,
  DEFAULT_VOLUME,
  DEFAULT_UI_SCALE,
  DEFAULT_MOTION,
  DEFAULT_CONTROLLER_RUMBLE,
  DEFAULT_DEVICE_HAPTICS,
  DEFAULT_TOUCH_SCHEME,
  DEFAULT_FIRE_MODE,
  DEFAULT_MUTED,
  DEFAULT_QUALITY_PRESET,
  QUALITY_PRESET_IDS,
  MOTION_PREFERENCES,
  UI_SCALES,
  SETTINGS_KEY,
  SETTINGS_SCHEMA_VERSION,
  NOT_PERSISTED_NOTICE,
  FUTURE_SCHEMA_NOTICE,
  type MotionPreference,
  type PlayerSettings,
  type QualityPreset,
  type UiScale,
} from './settings';
import { TOUCH_SETTINGS_KEY } from './touch-settings';
import { createMemoryStorage } from './storage';
import { TOUCH_SCHEMES, FIRE_MODES } from '../input/touch';

beforeEach(() => localStorage.clear());

/** A storage whose named methods throw, and whose others behave. Safari private mode. */
function hostile(throwing: Array<'getItem' | 'setItem' | 'removeItem'>): Storage {
  const real = createMemoryStorage();
  return {
    get length(): number {
      return real.length;
    },
    key: (i: number) => real.key(i),
    getItem: (k: string) => {
      if (throwing.includes('getItem')) throw new Error('denied');
      return real.getItem(k);
    },
    setItem: (k: string, v: string) => {
      if (throwing.includes('setItem')) throw new Error('denied');
      real.setItem(k, v);
    },
    removeItem: (k: string) => {
      if (throwing.includes('removeItem')) throw new Error('denied');
      real.removeItem(k);
    },
    clear: () => real.clear(),
  };
}

describe('the schema constants', () => {
  it('pins the canonical key and the payload version as literals', () => {
    // LITERALS, not derived. These two are the wire format: a rename or a silent bump
    // is a compatibility break for every player's stored settings, and should fail here
    // rather than in the field.
    expect(SETTINGS_KEY).toBe('tanks.settings.v1');
    expect(SETTINGS_SCHEMA_VERSION).toBe(1);
  });

  it('pins every documented default, so a silent retune fails here', () => {
    // Population: all NINE fields in PlayerSettings -- eight from issue #320 plus
    // `presentation.quality`, added by #540. Each is asserted against the literal the
    // issue requires, not against its own constant -- comparing a constant to itself
    // would pass whatever the constant became.
    //
    // `quality` carries the sharpest version of that: `DEFAULT_QUALITY_PRESET` is the
    // SAME constant `render/quality.ts` resolves an absent `?quality=` flag to, so the
    // literal `'high'` here is what pins "adding the setting did not move the shipped
    // render". A default of anything else is a visible change to every player who has
    // never opened Settings.
    expect(DEFAULT_MUTED).toBe(false);
    expect(DEFAULT_VOLUME).toBe(0.6);
    expect(DEFAULT_TOUCH_SCHEME).toBe('stick');
    expect(DEFAULT_FIRE_MODE).toBe('tap');
    expect(DEFAULT_DEVICE_HAPTICS).toBe(true);
    expect(DEFAULT_CONTROLLER_RUMBLE).toBe(true);
    expect(DEFAULT_MOTION).toBe('system');
    expect(DEFAULT_UI_SCALE).toBe(100);
    expect(DEFAULT_QUALITY_PRESET).toBe('high');
    expect(DEFAULT_SETTINGS).toEqual({
      audio: { muted: false, volume: 0.6 },
      input: {
        touchScheme: 'stick',
        fireMode: 'tap',
        deviceHaptics: true,
        controllerRumble: true,
      },
      presentation: { motion: 'system', uiScale: 100, quality: 'high' },
    });
  });

  it('names exactly the three player-facing motion states', () => {
    expect(MOTION_PREFERENCES).toEqual(['system', 'full', 'reduced']);
  });

  it('offers a closed UI-scale preset list, defaulting to 100%', () => {
    expect(UI_SCALES).toEqual([100, 125, 150]);
    expect(UI_SCALES).toContain(DEFAULT_UI_SCALE);
  });
});

describe('createPlayerSettingsStore: defaults and persistence', () => {
  it('starts at the documented defaults with nothing stored', () => {
    expect(createPlayerSettingsStore(localStorage).snapshot()).toEqual(DEFAULT_SETTINGS);
  });

  it('writes nothing at all when there is nothing to migrate', () => {
    // This origin's namespace is SHARED with every other project page on
    // austinorphan.com. A store that wrote its defaults at every boot would add a key
    // for a player who has never opened Settings.
    createPlayerSettingsStore(localStorage);
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('round-trips EVERY field through a fresh construction', () => {
    // Population: all eight fields, each moved OFF its default so a store that silently
    // fell back would have to disagree rather than accidentally match.
    const a = createPlayerSettingsStore(localStorage);
    a.setMuted(true);
    a.setVolume(0.25);
    a.setTouchScheme('point');
    a.setFireMode('button');
    a.setDeviceHaptics(false);
    a.setControllerRumble(false);
    a.setMotion('reduced');
    a.setUiScale(150);
    a.setQuality('low');
    const expected: PlayerSettings = {
      audio: { muted: true, volume: 0.25 },
      input: {
        touchScheme: 'point',
        fireMode: 'button',
        deviceHaptics: false,
        controllerRumble: false,
      },
      presentation: { motion: 'reduced', uiScale: 150, quality: 'low' },
    };
    expect(a.snapshot()).toEqual(expected);
    expect(createPlayerSettingsStore(localStorage).snapshot()).toEqual(expected);
  });

  it('publishes to subscribers on every accepted change, and stops on unsubscribe', () => {
    const store = createPlayerSettingsStore(localStorage);
    const seen: boolean[] = [];
    const off = store.subscribe((s) => seen.push(s.audio.muted));
    store.setMuted(true);
    store.setMuted(false);
    expect(seen).toEqual([true, false]);
    off();
    store.setMuted(true);
    expect(seen).toEqual([true, false]);
  });

  it('does NOT publish a refused value', () => {
    // The property loop.ts depends on: a rejected toggle publishes nothing, which is
    // what leaves the control showing the value the runtime was actually told.
    const store = createPlayerSettingsStore(localStorage);
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.setTouchScheme('joystick' as never);
    store.setUiScale(101 as UiScale);
    store.setMotion('sideways' as MotionPreference);
    store.setQuality('ultra' as QualityPreset);
    store.setVolume(Number.NaN);
    expect(calls).toBe(0);
  });
});

describe('createPlayerSettingsStore: validation', () => {
  it('refuses an off-domain SETTER argument and keeps the accepted value', () => {
    // Population: the five fields with a closed domain, each pushed past the types the
    // way untyped JS reaching this store would.
    const store = createPlayerSettingsStore(localStorage);
    store.setTouchScheme('point');
    store.setTouchScheme('joystick' as never);
    expect(store.snapshot().input.touchScheme).toBe('point');

    store.setFireMode('button');
    store.setFireMode('triple' as never);
    expect(store.snapshot().input.fireMode).toBe('button');

    store.setMotion('reduced');
    store.setMotion('mostly' as MotionPreference);
    expect(store.snapshot().presentation.motion).toBe('reduced');

    store.setUiScale(125);
    store.setUiScale(137 as UiScale);
    expect(store.snapshot().presentation.uiScale).toBe(125);

    // Issue #540's field. It matters more than it looks: the id is the domain of
    // `?dev=1&quality=` too, and an accepted junk value would be handed to
    // `qualityFor` when the next match builds its renderer.
    store.setQuality('low');
    store.setQuality('ultra' as QualityPreset);
    expect(store.snapshot().presentation.quality).toBe('low');
  });

  it('accepts every value the real domain lists', () => {
    // Population: all TOUCH_SCHEMES, all FIRE_MODES, all MOTION_PREFERENCES, all
    // UI_SCALES and all QUALITY_PRESET_IDS, sourced from the exported lists rather than
    // retyped, so a value added later is covered without an edit here.
    const store = createPlayerSettingsStore(localStorage);
    for (const id of TOUCH_SCHEMES) {
      store.setTouchScheme(id);
      expect(store.snapshot().input.touchScheme, id).toBe(id);
    }
    for (const id of FIRE_MODES) {
      store.setFireMode(id);
      expect(store.snapshot().input.fireMode, id).toBe(id);
    }
    for (const id of MOTION_PREFERENCES) {
      store.setMotion(id);
      expect(store.snapshot().presentation.motion, id).toBe(id);
    }
    for (const scale of UI_SCALES) {
      store.setUiScale(scale);
      expect(store.snapshot().presentation.uiScale, String(scale)).toBe(scale);
    }
    for (const id of QUALITY_PRESET_IDS) {
      store.setQuality(id);
      expect(store.snapshot().presentation.quality, id).toBe(id);
    }
  });

  it('refuses a NON-FINITE volume outright and clamps a finite one', () => {
    // The two halves are deliberately different. NaN and the infinities carry no
    // intent, so they are refused and the previous value stands; a finite out-of-range
    // number does carry one ("as loud as possible"), so it is normalised.
    const store = createPlayerSettingsStore(localStorage);
    store.setVolume(0.3);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      store.setVolume(bad);
      expect(store.snapshot().audio.volume, String(bad)).toBe(0.3);
    }
    store.setVolume(5);
    expect(store.snapshot().audio.volume).toBe(1);
    store.setVolume(-5);
    expect(store.snapshot().audio.volume).toBe(0);
  });

  it('never lets a non-finite volume reach STORAGE', () => {
    // The stored string is what a later build parses. `JSON.stringify(NaN)` is `null`,
    // which would read back as "no volume" rather than as junk -- a silently different
    // failure from the one the setter guard is written against.
    const store = createPlayerSettingsStore(localStorage);
    store.setVolume(Number.NaN);
    store.setMuted(true); // force a write regardless
    expect(localStorage.getItem(SETTINGS_KEY)).toContain(`"volume":${DEFAULT_VOLUME}`);
    expect(localStorage.getItem(SETTINGS_KEY)).not.toContain('null');
  });
});

describe('parseSettingsPayload: stored data', () => {
  it('recognises absence, and every shape of malformed', () => {
    // Population: the six ways a stored value fails as a whole -- absent, empty,
    // unparseable, a JSON scalar, an array, and a missing/invalid version. Each is a
    // DIFFERENT guard in the parser; an earlier draft that dropped the array check
    // returned a `current` payload for `[]`.
    expect(parseSettingsPayload(null).kind).toBe('absent');
    expect(parseSettingsPayload('').kind).toBe('absent');
    for (const junk of ['not json', '7', '[]', 'null', '{}', '{"version":0}', '{"version":1.5}']) {
      expect(parseSettingsPayload(junk).kind, junk).toBe('malformed');
    }
  });

  it('recognises a FUTURE version and reports it, without reading its fields', () => {
    const parsed = parseSettingsPayload(
      JSON.stringify({ version: 2, audio: { muted: true }, brandNew: 1 }),
    );
    expect(parsed).toEqual({ kind: 'future', version: 2 });
  });

  it('defaults each field INDEPENDENTLY when its neighbour is junk', () => {
    // The property that carried over from `tanks.touch.v1`. A single bad field must not
    // be able to reset the rest of the payload, and a non-object GROUP must not either.
    const parsed = parseSettingsPayload(
      JSON.stringify({
        version: 1,
        audio: { muted: 'yes', volume: 0.25 },
        input: 7,
        presentation: { motion: 'sideways', uiScale: 150, quality: 'ultra' },
      }),
    );
    expect(parsed.kind).toBe('current');
    if (parsed.kind !== 'current') throw new Error('unreachable');
    expect(parsed.settings.audio.muted).toBe(DEFAULT_MUTED); // junk
    expect(parsed.settings.audio.volume).toBe(0.25); // its valid sibling survived
    expect(parsed.settings.input).toEqual(DEFAULT_SETTINGS.input); // whole group junk
    expect(parsed.settings.presentation.motion).toBe(DEFAULT_MOTION); // junk
    expect(parsed.settings.presentation.uiScale).toBe(150); // its valid sibling survived
    // A stored preset this build does not know defaults to the SHIPPED one rather than
    // being carried through to `qualityFor`, which would index its table with a key it
    // has no entry for.
    expect(parsed.settings.presentation.quality).toBe(DEFAULT_QUALITY_PRESET); // junk
  });

  it('clamps a finite out-of-range stored volume and defaults a non-finite one', () => {
    const clamped = parseSettingsPayload(JSON.stringify({ version: 1, audio: { volume: 9 } }));
    if (clamped.kind !== 'current') throw new Error('unreachable');
    expect(clamped.settings.audio.volume).toBe(1);
    // JSON has no NaN literal, so the shape a real corrupted payload takes is `null`
    // or a string. Both must fall back rather than reach the accepted model.
    for (const bad of [null, 'loud', {}]) {
      const parsed = parseSettingsPayload(JSON.stringify({ version: 1, audio: { volume: bad } }));
      if (parsed.kind !== 'current') throw new Error('unreachable');
      expect(parsed.settings.audio.volume, JSON.stringify(bad)).toBe(DEFAULT_VOLUME);
    }
  });

  it('round-trips its own serialiser exactly', () => {
    const settings: PlayerSettings = {
      audio: { muted: true, volume: 0.75 },
      input: { touchScheme: 'point', fireMode: 'double', deviceHaptics: false, controllerRumble: false },
      presentation: { motion: 'full', uiScale: 125, quality: 'medium' },
    };
    const parsed = parseSettingsPayload(serializeSettings(settings));
    if (parsed.kind !== 'current') throw new Error('unreachable');
    expect(parsed.settings).toEqual(settings);
  });
});

describe('createPlayerSettingsStore: malformed and future stored data', () => {
  it('falls back safely for every malformed shape, without throwing at construction', () => {
    // Population: the same six malformed shapes the parser test sweeps, driven through
    // the CONSTRUCTOR this time -- the boot path a player actually hits.
    for (const junk of ['not json', '7', '[]', 'null', '{}', '{"version":0}']) {
      localStorage.setItem(SETTINGS_KEY, junk);
      const store = createPlayerSettingsStore(localStorage);
      expect(store.snapshot(), junk).toEqual(DEFAULT_SETTINGS);
      expect(store.status().schema, junk).toBe('recovered');
    }
  });

  it('does NOT overwrite a future-schema payload, and refuses to write at all', () => {
    // The core future-data contract. Its RAW bytes must survive this build entirely,
    // because a newer build wrote them and this one cannot represent them.
    const future = JSON.stringify({ version: 99, audio: { muted: true }, unknownGroup: { x: 1 } });
    localStorage.setItem(SETTINGS_KEY, future);
    const store = createPlayerSettingsStore(localStorage);

    expect(store.snapshot()).toEqual(DEFAULT_SETTINGS);
    expect(store.status()).toMatchObject({
      schema: 'future',
      storedVersion: 99,
      persistence: 'locked-future',
      writable: false,
    });

    // An ordinary change applies IN MEMORY for this session and reaches no bytes.
    store.setMuted(true);
    store.setVolume(0.1);
    expect(store.snapshot().audio).toEqual({ muted: true, volume: 0.1 });
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(future);
  });

  it('never migrates the legacy key over a future payload', () => {
    // The future payload is REAL data from a newer build; the legacy key predates both.
    // Adopting the older values here would be a silent downgrade, and writing them
    // would destroy the newer payload outright.
    const future = JSON.stringify({ version: 99 });
    localStorage.setItem(SETTINGS_KEY, future);
    localStorage.setItem(TOUCH_SETTINGS_KEY, JSON.stringify({ scheme: 'point' }));
    const store = createPlayerSettingsStore(localStorage);
    expect(store.snapshot().input.touchScheme).toBe(DEFAULT_TOUCH_SCHEME);
    expect(store.status().migratedLegacy).toBe(false);
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(future);
    expect(localStorage.getItem(TOUCH_SETTINGS_KEY)).not.toBeNull();
  });

  it('lets reset() -- and ONLY reset() -- clear the future lock', () => {
    // Issue #320 says settings "cannot safely be saved until reset or a compatible
    // version is used", so the lock has to have exactly one deliberate exit.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: 99 }));
    const store = createPlayerSettingsStore(localStorage);
    store.reset();
    expect(store.status()).toMatchObject({ schema: 'current', persistence: 'persisted', storedVersion: null });
    expect(parseSettingsPayload(localStorage.getItem(SETTINGS_KEY))).toEqual({
      kind: 'current',
      settings: DEFAULT_SETTINGS,
    });
    // ...and ordinary writes work again afterwards.
    store.setMuted(true);
    expect(createPlayerSettingsStore(localStorage).snapshot().audio.muted).toBe(true);
  });
});

describe('createPlayerSettingsStore: storage failures', () => {
  it('carries the session in memory when setItem THROWS, and says writes are failing', () => {
    const storage = hostile(['setItem']);
    const store = createPlayerSettingsStore(storage);
    expect(store.status().persistence).toBe('persisted'); // not knowable until a write
    store.setVolume(0.25);
    expect(store.snapshot().audio.volume).toBe(0.25); // usable
    expect(store.status()).toMatchObject({ persistence: 'error', writable: false, availability: 'persistent' });
  });

  it('survives a getItem that throws, at construction', () => {
    const store = createPlayerSettingsStore(hostile(['getItem']));
    expect(store.snapshot()).toEqual(DEFAULT_SETTINGS);
    expect(store.status().persistence).toBe('error');
  });

  it('reports memory-only storage as memory, separately from a write failure', () => {
    // The two facts issue #320 needs kept apart: `resolveStorage` found no real Storage
    // (availability) versus a real one that refuses writes (persistence).
    const store = createPlayerSettingsStore(createMemoryStorage(), { availability: 'memory' });
    expect(store.status()).toMatchObject({ availability: 'memory', persistence: 'memory', writable: false });
    store.setMuted(true); // still usable
    expect(store.snapshot().audio.muted).toBe(true);
  });

  it('defaults to persistent when the caller says nothing', () => {
    expect(createPlayerSettingsStore(createMemoryStorage()).status()).toMatchObject({
      availability: 'persistent',
      persistence: 'persisted',
      writable: true,
    });
  });
});

describe('noticeFor', () => {
  it('maps each unsaveable state to its own message, and a healthy one to none', () => {
    // Population: all four SettingsPersistence values.
    const base = { availability: 'persistent', schema: 'current', storedVersion: null, migratedLegacy: false } as const;
    expect(noticeFor({ ...base, persistence: 'persisted', writable: true })).toBeNull();
    expect(noticeFor({ ...base, persistence: 'memory', writable: false })).toEqual({
      kind: 'not-persisted',
      message: NOT_PERSISTED_NOTICE,
    });
    expect(noticeFor({ ...base, persistence: 'error', writable: false })).toEqual({
      kind: 'not-persisted',
      message: NOT_PERSISTED_NOTICE,
    });
    expect(noticeFor({ ...base, persistence: 'locked-future', writable: false })).toEqual({
      kind: 'future-schema',
      message: FUTURE_SCHEMA_NOTICE,
    });
  });

  it('uses the exact wording issue #320 asks for', () => {
    // A LITERAL: this is the string the player reads, and a silent reword should fail.
    expect(NOT_PERSISTED_NOTICE).toBe("Settings won't be saved this session.");
  });
});

describe('createPlayerSettingsStore: legacy migration', () => {
  it('adopts all three legacy fields, persists canonically, and clears the legacy key', () => {
    localStorage.setItem(
      TOUCH_SETTINGS_KEY,
      JSON.stringify({ scheme: 'point', fireMode: 'button', haptics: false }),
    );
    const store = createPlayerSettingsStore(localStorage);
    expect(store.snapshot().input).toEqual({
      touchScheme: 'point',
      fireMode: 'button',
      deviceHaptics: false,
      controllerRumble: DEFAULT_CONTROLLER_RUMBLE, // no legacy field existed
    });
    // Non-legacy fields are the current defaults, not anything invented.
    expect(store.snapshot().audio).toEqual(DEFAULT_SETTINGS.audio);
    expect(store.snapshot().presentation).toEqual(DEFAULT_SETTINGS.presentation);
    expect(store.status().migratedLegacy).toBe(true);
    expect(localStorage.getItem(TOUCH_SETTINGS_KEY)).toBeNull();
    expect(parseSettingsPayload(localStorage.getItem(SETTINGS_KEY)).kind).toBe('current');
  });

  it('keeps a VALID legacy field when its sibling is corrupt', () => {
    // Population: each of the three legacy fields corrupted in turn. The surviving
    // siblings must be the stored values, not the defaults -- which is only
    // distinguishable because every fixture value here is OFF its default.
    const rows: Array<[string, Record<string, unknown>, Partial<PlayerSettings['input']>]> = [
      ['scheme corrupt', { scheme: 'joystick', fireMode: 'button', haptics: false }, { touchScheme: DEFAULT_TOUCH_SCHEME, fireMode: 'button', deviceHaptics: false }],
      ['fireMode corrupt', { scheme: 'point', fireMode: 7, haptics: false }, { touchScheme: 'point', fireMode: DEFAULT_FIRE_MODE, deviceHaptics: false }],
      ['haptics corrupt', { scheme: 'point', fireMode: 'button', haptics: 'no' }, { touchScheme: 'point', fireMode: 'button', deviceHaptics: DEFAULT_DEVICE_HAPTICS }],
    ];
    for (const [label, stored, expected] of rows) {
      localStorage.clear();
      localStorage.setItem(TOUCH_SETTINGS_KEY, JSON.stringify(stored));
      const store = createPlayerSettingsStore(localStorage);
      expect(store.snapshot().input, label).toMatchObject(expected);
    }
  });

  it('lets a VALID canonical payload win outright, and clears the legacy key beside it', () => {
    // The two disagree on every shared field, so the winner is unambiguous.
    localStorage.setItem(
      SETTINGS_KEY,
      serializeSettings({
        ...DEFAULT_SETTINGS,
        input: { ...DEFAULT_SETTINGS.input, touchScheme: 'stick', fireMode: 'tap', deviceHaptics: true },
      }),
    );
    localStorage.setItem(
      TOUCH_SETTINGS_KEY,
      JSON.stringify({ scheme: 'point', fireMode: 'button', haptics: false }),
    );
    const store = createPlayerSettingsStore(localStorage);
    expect(store.snapshot().input).toMatchObject({
      touchScheme: 'stick',
      fireMode: 'tap',
      deviceHaptics: true,
    });
    expect(store.status().migratedLegacy).toBe(false);
    // One writable source when this finishes -- the point of the whole exercise.
    expect(localStorage.getItem(TOUCH_SETTINGS_KEY)).toBeNull();
  });

  it('MIGRATES when the canonical payload is malformed, rather than losing the legacy values', () => {
    // A deliberate superset of issue #320's literal "if the canonical key is absent".
    // Nothing in a malformed payload was usable, so there are no newer canonical
    // settings to lose, and the legacy key holds the only real preferences left.
    localStorage.setItem(SETTINGS_KEY, 'not json');
    localStorage.setItem(TOUCH_SETTINGS_KEY, JSON.stringify({ scheme: 'point' }));
    const store = createPlayerSettingsStore(localStorage);
    expect(store.snapshot().input.touchScheme).toBe('point');
    expect(store.status().migratedLegacy).toBe(true);
    expect(localStorage.getItem(TOUCH_SETTINGS_KEY)).toBeNull();
  });

  it('is IDEMPOTENT: a second construction reads canonical and re-applies nothing', () => {
    localStorage.setItem(TOUCH_SETTINGS_KEY, JSON.stringify({ scheme: 'point' }));
    const first = createPlayerSettingsStore(localStorage);
    expect(first.status().migratedLegacy).toBe(true);

    const second = createPlayerSettingsStore(localStorage);
    expect(second.snapshot().input.touchScheme).toBe('point');
    expect(second.status().migratedLegacy).toBe(false);
  });

  it('never re-applies legacy values over NEWER canonical settings', () => {
    // The regression this ordering exists to prevent: migrate, then change the setting,
    // then reboot. If the legacy key had survived the migration and were still consulted,
    // the second construction would hand back the stale legacy value.
    localStorage.setItem(TOUCH_SETTINGS_KEY, JSON.stringify({ scheme: 'point' }));
    const first = createPlayerSettingsStore(localStorage);
    first.setTouchScheme('stick');
    expect(createPlayerSettingsStore(localStorage).snapshot().input.touchScheme).toBe('stick');
  });

  it('after migrating, an ordinary change NEVER writes the legacy key again', () => {
    localStorage.setItem(TOUCH_SETTINGS_KEY, JSON.stringify({ scheme: 'point' }));
    const store = createPlayerSettingsStore(localStorage);
    store.setTouchScheme('stick');
    store.setFireMode('button');
    store.setDeviceHaptics(false);
    expect(localStorage.getItem(TOUCH_SETTINGS_KEY)).toBeNull();
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)!);
    expect(keys).toEqual([SETTINGS_KEY]);
  });

  it('keeps the migrated values usable AND the legacy bytes intact when the write throws', () => {
    // Ordering is the contract. If the legacy key were removed before the canonical
    // write were known to have landed, this player's preferences would be gone.
    const real = createMemoryStorage();
    real.setItem(TOUCH_SETTINGS_KEY, JSON.stringify({ scheme: 'point', haptics: false }));
    const storage: Storage = {
      get length(): number {
        return real.length;
      },
      key: (i: number) => real.key(i),
      getItem: (k: string) => real.getItem(k),
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: (k: string) => real.removeItem(k),
      clear: () => real.clear(),
    };
    const store = createPlayerSettingsStore(storage);
    expect(store.snapshot().input.touchScheme).toBe('point');
    expect(store.snapshot().input.deviceHaptics).toBe(false);
    expect(real.getItem(TOUCH_SETTINGS_KEY)).not.toBeNull();
    expect(real.getItem(SETTINGS_KEY)).toBeNull();
    // ...and the next construction migrates the still-present legacy data again.
    expect(createPlayerSettingsStore(storage).snapshot().input.touchScheme).toBe('point');
  });

  it('does not claim writes are failing when only the legacy REMOVAL throws', () => {
    // The canonical payload landed, so settings ARE being saved. Reporting an error here
    // would put a false "won't be saved" notice on screen.
    const real = createMemoryStorage();
    real.setItem(TOUCH_SETTINGS_KEY, JSON.stringify({ scheme: 'point' }));
    const storage: Storage = {
      get length(): number {
        return real.length;
      },
      key: (i: number) => real.key(i),
      getItem: (k: string) => real.getItem(k),
      setItem: (k: string, v: string) => real.setItem(k, v),
      removeItem: () => {
        throw new Error('denied');
      },
      clear: () => real.clear(),
    };
    const store = createPlayerSettingsStore(storage);
    expect(store.snapshot().input.touchScheme).toBe('point');
    expect(store.status()).toMatchObject({ persistence: 'persisted', writable: true });
    expect(real.getItem(SETTINGS_KEY)).not.toBeNull();
    // The stale key is inert: the next construction sees valid canonical settings, so it
    // is never read back over them.
    expect(createPlayerSettingsStore(storage).status().migratedLegacy).toBe(false);
  });

  it('clears a legacy key holding pure junk, with nothing to adopt', () => {
    localStorage.setItem(TOUCH_SETTINGS_KEY, 'not json');
    const store = createPlayerSettingsStore(localStorage);
    expect(store.snapshot()).toEqual(DEFAULT_SETTINGS);
    expect(store.status().migratedLegacy).toBe(false); // nothing valid was adopted
    expect(localStorage.getItem(TOUCH_SETTINGS_KEY)).toBeNull(); // but it was cleaned up
  });
});

describe('createPlayerSettingsStore: reset', () => {
  it('restores every default, persists them, and clears the legacy key', () => {
    localStorage.setItem(TOUCH_SETTINGS_KEY, JSON.stringify({ scheme: 'point' }));
    const store = createPlayerSettingsStore(localStorage);
    store.setMuted(true);
    store.setUiScale(150);
    // Put the legacy key back, so reset has something to clear -- the case that matters
    // is an imported old save sitting beside settings the player then resets.
    localStorage.setItem(TOUCH_SETTINGS_KEY, JSON.stringify({ scheme: 'point' }));

    store.reset();
    expect(store.snapshot()).toEqual(DEFAULT_SETTINGS);
    expect(createPlayerSettingsStore(localStorage).snapshot()).toEqual(DEFAULT_SETTINGS);
    expect(localStorage.getItem(TOUCH_SETTINGS_KEY)).toBeNull();
  });

  it('touches no key but its own -- progress and stats are not settings', () => {
    // The hazard in both directions: a settings reset must not clear progress, and the
    // existing Reset Progress must not clear settings.
    localStorage.setItem('tanks.progress.v1', '5');
    localStorage.setItem('tanks.stats.v1', '{"shotsFired":3}');
    createPlayerSettingsStore(localStorage).reset();
    expect(localStorage.getItem('tanks.progress.v1')).toBe('5');
    expect(localStorage.getItem('tanks.stats.v1')).toBe('{"shotsFired":3}');
  });

  it('publishes the reset to subscribers', () => {
    const store = createPlayerSettingsStore(localStorage);
    store.setMuted(true);
    const seen: PlayerSettings[] = [];
    store.subscribe((s) => seen.push(s));
    store.reset();
    expect(seen).toEqual([DEFAULT_SETTINGS]);
  });
});
