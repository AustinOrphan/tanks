// @vitest-environment jsdom
// The LEGACY touch-preferences key, now a one-way migration read (issue #320). The
// writable store this file used to cover lives in settings.ts; what is left here is the
// compatibility surface, and the property that matters is per-field independence -- a
// junk value in one field must never take a valid sibling down with it, because the
// migration adopts these fields one at a time.
import { describe, it, expect, beforeEach } from 'vitest';
import { readLegacyTouchSettings, TOUCH_SETTINGS_KEY } from './touch-settings';
import { TOUCH_SCHEMES, FIRE_MODES } from '../input/touch';
import { createMemoryStorage } from './storage';

beforeEach(() => localStorage.clear());

describe('TOUCH_SETTINGS_KEY', () => {
  it('is still the exact wire string older saves were written under', () => {
    // A LITERAL. This key is only ever read now, and only from data written by builds
    // that no longer exist to be consulted -- renaming it would silently orphan every
    // pre-#320 player's preferences with nothing failing.
    expect(TOUCH_SETTINGS_KEY).toBe('tanks.touch.v1');
  });
});

describe('readLegacyTouchSettings', () => {
  it('reports an absent key as absent, with nothing to adopt', () => {
    expect(readLegacyTouchSettings(localStorage)).toEqual({
      present: false,
      scheme: null,
      fireMode: null,
      haptics: null,
    });
  });

  it('reads all three fields when all three are valid', () => {
    localStorage.setItem(
      TOUCH_SETTINGS_KEY,
      JSON.stringify({ scheme: 'point', fireMode: 'button', haptics: false }),
    );
    expect(readLegacyTouchSettings(localStorage)).toEqual({
      present: true,
      scheme: 'point',
      fireMode: 'button',
      haptics: false,
    });
  });

  it('accepts every scheme and mode the real lists actually name', () => {
    // Population: the full current TOUCH_SCHEMES x FIRE_MODES cross-product (2 x 3 = 6
    // pairs as this is written), sourced from input/touch.ts rather than retyped, so a
    // scheme added later is covered here without an edit.
    let pairs = 0;
    for (const scheme of TOUCH_SCHEMES) {
      for (const fireMode of FIRE_MODES) {
        localStorage.setItem(TOUCH_SETTINGS_KEY, JSON.stringify({ scheme, fireMode }));
        const read = readLegacyTouchSettings(localStorage);
        expect(read.scheme, `${scheme}/${fireMode}`).toBe(scheme);
        expect(read.fireMode, `${scheme}/${fireMode}`).toBe(fireMode);
        pairs += 1;
      }
    }
    expect(pairs).toBe(TOUCH_SCHEMES.length * FIRE_MODES.length);
  });

  it('keeps a VALID field when its sibling is junk -- the property migration depends on', () => {
    // Population: each of the three fields corrupted in turn, with the other two valid.
    // This is the exact behaviour issue #320 requires migration to preserve, and the
    // reason this reader answers per field rather than all-or-nothing.
    const rows: Array<[string, unknown, Record<string, unknown>]> = [
      ['scheme', { scheme: 'joystick', fireMode: 'button', haptics: false }, { scheme: null, fireMode: 'button', haptics: false }],
      ['fireMode', { scheme: 'point', fireMode: 7, haptics: false }, { scheme: 'point', fireMode: null, haptics: false }],
      ['haptics', { scheme: 'point', fireMode: 'button', haptics: 'yes' }, { scheme: 'point', fireMode: 'button', haptics: null }],
    ];
    for (const [label, stored, expected] of rows) {
      localStorage.setItem(TOUCH_SETTINGS_KEY, JSON.stringify(stored));
      expect(readLegacyTouchSettings(localStorage), label).toEqual({ present: true, ...expected });
    }
  });

  it('reports junk as PRESENT with nothing to adopt, so it still gets cleaned up', () => {
    // Population: the four ways a stored value can be unusable as a whole -- empty
    // string, unparseable text, a JSON array, and a JSON scalar. `present: true` is the
    // load-bearing half: a key holding junk must still be removed after migration, and a
    // reader that answered "absent" for junk would leave it behind forever.
    for (const junk of ['', 'not json', '[1,2,3]', '7']) {
      localStorage.setItem(TOUCH_SETTINGS_KEY, junk);
      expect(readLegacyTouchSettings(localStorage), JSON.stringify(junk)).toEqual({
        present: true,
        scheme: null,
        fireMode: null,
        haptics: null,
      });
    }
  });

  it('treats a JSON null root as junk rather than throwing', () => {
    // `typeof null === 'object'`, so only the explicit null check rejects it. Without
    // that check the property reads below would throw straight out of a boot path.
    localStorage.setItem(TOUCH_SETTINGS_KEY, 'null');
    expect(readLegacyTouchSettings(localStorage).present).toBe(true);
    expect(readLegacyTouchSettings(localStorage).scheme).toBeNull();
  });

  it('survives a storage whose getItem THROWS', () => {
    // Safari private mode / a locked-down context. Nothing to migrate and nothing to
    // clean up, and above all no throw out of the settings store's constructor.
    const throwing = {
      getItem: (): string | null => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(() => readLegacyTouchSettings(throwing)).not.toThrow();
    expect(readLegacyTouchSettings(throwing).present).toBe(false);
  });

  it('reads only its own key, never a neighbour', () => {
    const s = createMemoryStorage();
    s.setItem('tanks.custom.v1', JSON.stringify({ scheme: 'point' }));
    expect(readLegacyTouchSettings(s).present).toBe(false);
  });
});
