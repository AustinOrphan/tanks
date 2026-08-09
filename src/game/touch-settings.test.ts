// @vitest-environment jsdom
// The right thumb's scheme preference: persisted the same way the paint shop's choice
// is (customization.ts), including per-field validation -- an unknown stored value must
// fall back to the default, never crash or leak into a differently-shaped state.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTouchSettingsStore,
  DEFAULT_TOUCH_SCHEME,
  TOUCH_SETTINGS_KEY,
} from './touch-settings';
import { TOUCH_SCHEMES } from '../input/touch';

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
