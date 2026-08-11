// @vitest-environment jsdom
// The right thumb's scheme preference: persisted the same way the paint shop's choice
// is (customization.ts), including per-field validation -- an unknown stored value must
// fall back to the default, never crash or leak into a differently-shaped state.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTouchSettingsStore,
  DEFAULT_TOUCH_SCHEME,
  DEFAULT_FIRE_MODE,
  DEFAULT_HAPTICS,
  TOUCH_SETTINGS_KEY,
} from './touch-settings';
import { TOUCH_SCHEMES, FIRE_MODES } from '../input/touch';

beforeEach(() => localStorage.clear());

describe('createTouchSettingsStore', () => {
  it('defaults to stick', () => {
    // Pins the DEFAULT constant itself, not just that some scheme is returned --
    // the spec requires 'stick' specifically.
    expect(DEFAULT_TOUCH_SCHEME).toBe('stick');
    expect(createTouchSettingsStore(localStorage).scheme()).toBe('stick');
  });

  it('starts at the default and persists a pick across instances', () => {
    const a = createTouchSettingsStore(localStorage);
    expect(a.scheme()).toBe(DEFAULT_TOUCH_SCHEME);
    a.setScheme('point');
    expect(createTouchSettingsStore(localStorage).scheme()).toBe('point');
  });

  it('treats junk and unknown scheme values as the default', () => {
    for (const junk of ['banana', '{"scheme":"joystick"}', '{"scheme":7}', '']) {
      localStorage.setItem(TOUCH_SETTINGS_KEY, junk);
      expect(createTouchSettingsStore(localStorage).scheme(), junk).toBe(DEFAULT_TOUCH_SCHEME);
    }
  });

  it('refuses to store a value off TOUCH_SCHEMES', () => {
    const s = createTouchSettingsStore(localStorage);
    s.setScheme('joystick' as never); // forced past the types
    expect(s.scheme()).toBe(DEFAULT_TOUCH_SCHEME);
  });

  it('accepts every scheme TOUCH_SCHEMES actually lists', () => {
    // Population: the full, current set of legal schemes -- not a hardcoded 'point'
    // that would stop covering a third scheme added later.
    for (const id of TOUCH_SCHEMES) {
      const s = createTouchSettingsStore(localStorage);
      s.setScheme(id);
      expect(s.scheme(), id).toBe(id);
    }
  });

  it('survives a throwing storage, carrying the pick in-memory', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const s = createTouchSettingsStore(throwing);
    s.setScheme('point'); // must not throw
    expect(s.scheme()).toBe('point');
  });

  it('a junk value under one key never touches the other store', () => {
    // The whole reason this is a separate key from tanks.custom.v1: a broken write to
    // one must not be able to reset the other's default.
    localStorage.setItem(TOUCH_SETTINGS_KEY, 'not json');
    expect(createTouchSettingsStore(localStorage).scheme()).toBe(DEFAULT_TOUCH_SCHEME);
    expect(localStorage.getItem('tanks.custom.v1')).toBeNull();
  });
});

describe('createTouchSettingsStore — fire mode', () => {
  it('defaults to tap', () => {
    // Pins the DEFAULT constant itself, not just that some mode is returned -- the
    // spec requires 'tap' specifically.
    expect(DEFAULT_FIRE_MODE).toBe('tap');
    expect(createTouchSettingsStore(localStorage).fireMode()).toBe('tap');
  });

  it('starts at the default and persists a pick across instances', () => {
    const a = createTouchSettingsStore(localStorage);
    expect(a.fireMode()).toBe(DEFAULT_FIRE_MODE);
    a.setFireMode('double');
    expect(createTouchSettingsStore(localStorage).fireMode()).toBe('double');
  });

  it('treats junk and unknown fire-mode values as the default', () => {
    for (const junk of ['banana', '{"fireMode":"triple"}', '{"fireMode":7}', '']) {
      localStorage.setItem(TOUCH_SETTINGS_KEY, junk);
      expect(createTouchSettingsStore(localStorage).fireMode(), junk).toBe(DEFAULT_FIRE_MODE);
    }
  });

  it('refuses to store a value off FIRE_MODES', () => {
    const s = createTouchSettingsStore(localStorage);
    s.setFireMode('triple' as never); // forced past the types
    expect(s.fireMode()).toBe(DEFAULT_FIRE_MODE);
  });

  it('accepts every mode FIRE_MODES actually lists', () => {
    // Population: the full, current set of legal fire modes -- not a hardcoded 'tap'
    // that would stop covering a fourth mode added later.
    for (const id of FIRE_MODES) {
      const s = createTouchSettingsStore(localStorage);
      s.setFireMode(id);
      expect(s.fireMode(), id).toBe(id);
    }
  });

  it('survives a throwing storage, carrying the pick in-memory', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const s = createTouchSettingsStore(throwing);
    s.setFireMode('double'); // must not throw
    expect(s.fireMode()).toBe('double');
  });

  it('a junk fireMode value never touches scheme, and vice versa -- the two fields degrade independently', () => {
    // Corrupt fireMode alone: scheme is untouched.
    localStorage.setItem(TOUCH_SETTINGS_KEY, JSON.stringify({ scheme: 'point', fireMode: 7 }));
    let s = createTouchSettingsStore(localStorage);
    expect(s.scheme(), 'a bad fireMode reset scheme too').toBe('point');
    expect(s.fireMode()).toBe(DEFAULT_FIRE_MODE);

    // Corrupt scheme alone: fireMode is untouched.
    localStorage.setItem(
      TOUCH_SETTINGS_KEY,
      JSON.stringify({ scheme: 'joystick', fireMode: 'double' }),
    );
    s = createTouchSettingsStore(localStorage);
    expect(s.scheme()).toBe(DEFAULT_TOUCH_SCHEME);
    expect(s.fireMode(), 'a bad scheme reset fireMode too').toBe('double');
  });

  it('a junk value under one key never touches the other store', () => {
    localStorage.setItem(TOUCH_SETTINGS_KEY, 'not json');
    expect(createTouchSettingsStore(localStorage).fireMode()).toBe(DEFAULT_FIRE_MODE);
    expect(localStorage.getItem('tanks.custom.v1')).toBeNull();
  });
});

describe('createTouchSettingsStore — haptics', () => {
  it('defaults to on', () => {
    // Pins the DEFAULT constant itself, not just that some boolean is returned --
    // the spec requires `true` specifically, the same convention as audio's unmuted
    // default.
    expect(DEFAULT_HAPTICS).toBe(true);
    expect(createTouchSettingsStore(localStorage).haptics()).toBe(true);
  });

  it('starts at the default and persists a pick across instances', () => {
    const a = createTouchSettingsStore(localStorage);
    expect(a.haptics()).toBe(DEFAULT_HAPTICS);
    a.setHaptics(false);
    expect(createTouchSettingsStore(localStorage).haptics()).toBe(false);
  });

  it('treats junk haptics values as the default', () => {
    for (const junk of ['banana', '{"haptics":"yes"}', '{"haptics":1}', '']) {
      localStorage.setItem(TOUCH_SETTINGS_KEY, junk);
      expect(createTouchSettingsStore(localStorage).haptics(), junk).toBe(DEFAULT_HAPTICS);
    }
  });

  it('survives a throwing storage, carrying the pick in-memory', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const s = createTouchSettingsStore(throwing);
    s.setHaptics(false); // must not throw
    expect(s.haptics()).toBe(false);
  });

  it('a junk haptics value never resets scheme or fireMode, and vice versa -- all three degrade independently', () => {
    localStorage.setItem(
      TOUCH_SETTINGS_KEY,
      JSON.stringify({ scheme: 'point', fireMode: 'double', haptics: 'nope' }),
    );
    let s = createTouchSettingsStore(localStorage);
    expect(s.scheme(), 'a bad haptics value reset scheme too').toBe('point');
    expect(s.fireMode(), 'a bad haptics value reset fireMode too').toBe('double');
    expect(s.haptics()).toBe(DEFAULT_HAPTICS);

    localStorage.setItem(
      TOUCH_SETTINGS_KEY,
      JSON.stringify({ scheme: 'joystick', fireMode: 7, haptics: false }),
    );
    s = createTouchSettingsStore(localStorage);
    expect(s.scheme()).toBe(DEFAULT_TOUCH_SCHEME);
    expect(s.fireMode()).toBe(DEFAULT_FIRE_MODE);
    expect(s.haptics(), 'a bad scheme/fireMode reset haptics too').toBe(false);
  });

  it('a junk value under one key never touches the other store', () => {
    localStorage.setItem(TOUCH_SETTINGS_KEY, 'not json');
    expect(createTouchSettingsStore(localStorage).haptics()).toBe(DEFAULT_HAPTICS);
    expect(localStorage.getItem('tanks.custom.v1')).toBeNull();
  });
});
