// @vitest-environment jsdom
// The paint shop's memory: one persisted choice per catalog. Unknown or corrupt values
// read as the default -- a save must never paint the player an enemy colour, and the
// catalog (presentation/customization.ts, tested beside it) deliberately contains none.
import { describe, it, expect, beforeEach } from 'vitest';
import { createCustomizationStore, CUSTOM_KEY } from './customization';
import {
  ACCENTS,
  DEFAULT_HULL,
  DEFAULT_SKIN,
  DEFAULT_ACCENT,
} from '../presentation/customization';

beforeEach(() => localStorage.clear());

describe('createCustomizationStore', () => {
  it('starts at the default and persists a pick across instances', () => {
    const a = createCustomizationStore(localStorage);
    expect(a.hull()).toBe(DEFAULT_HULL);
    a.setHull('red');
    expect(createCustomizationStore(localStorage).hull()).toBe('red');
  });

  it('treats junk and unknown swatches as the default', () => {
    for (const junk of ['banana', '{"hull":"teal"}', '{"hull":7}', '']) {
      localStorage.setItem(CUSTOM_KEY, junk);
      expect(createCustomizationStore(localStorage).hull(), junk).toBe(DEFAULT_HULL);
    }
  });

  it('refuses to store a non-palette id', () => {
    const s = createCustomizationStore(localStorage);
    s.setHull('teal' as never); // an enemy hue, forced past the types
    expect(s.hull()).toBe(DEFAULT_HULL);
  });

  it('hexFor resolves any palette id and survives a throwing storage', () => {
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    } as unknown as Storage;
    const s = createCustomizationStore(throwing);
    s.setHull('purple'); // must not throw; carried in-memory
    expect(s.hull()).toBe('purple');
    expect(s.hexFor('purple')).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('skins', () => {
  it('accepts two-tone exactly like any other skin -- issue #137', () => {
    // The newest skin, and the one every enemy kind now wears (entities.ts). Not
    // scrolling (see its SkinDef comment), so it does not need the exclusivity test in
    // presentation/customization.test.ts to change -- this only proves setSkin's off-list
    // rejection recognises it.
    const a = createCustomizationStore(localStorage);
    a.setSkin('two-tone');
    expect(a.skin()).toBe('two-tone');
  });

  it('persists a skin pick beside the hull colour, and validates it the same way', () => {
    const a = createCustomizationStore(localStorage);
    a.setSkin('camo');
    a.setHull('red');
    const b = createCustomizationStore(localStorage);
    expect(b.skin()).toBe('camo');
    expect(b.hull()).toBe('red'); // the two fields do not clobber each other
    localStorage.setItem(CUSTOM_KEY, '{"hull":"red","skin":"zebra"}');
    const junkSkin = createCustomizationStore(localStorage);
    expect(junkSkin.skin()).toBe(DEFAULT_SKIN);
    expect(junkSkin.hull()).toBe('red'); // a junk skin must NOT reset the hull
    const c = createCustomizationStore(localStorage);
    c.setSkin('zebra' as never);
    expect(c.skin()).toBe(DEFAULT_SKIN);
  });
});

describe('accents', () => {
  it('persists an accent pick beside hull and skin, validated the same way', () => {
    const a = createCustomizationStore(localStorage);
    expect(a.accent()).toBe(DEFAULT_ACCENT);
    a.setAccent('black');
    a.setHull('red');
    a.setSkin('camo');
    const b = createCustomizationStore(localStorage);
    expect(b.accent()).toBe('black');
    expect(b.hull()).toBe('red'); // the three fields do not clobber each other
    expect(b.skin()).toBe('camo');
  });

  it('treats junk and unknown accents as auto, without resetting hull or skin', () => {
    localStorage.setItem(CUSTOM_KEY, '{"hull":"red","skin":"camo","accent":"rainbow"}');
    const s = createCustomizationStore(localStorage);
    expect(s.accent()).toBe(DEFAULT_ACCENT);
    expect(s.hull()).toBe('red');
    expect(s.skin()).toBe('camo');
  });

  it('a save from before `accent` existed reads as auto, not as junk', () => {
    // Pre-feature saves have no `accent` key at all -- not an invalid one.
    localStorage.setItem(CUSTOM_KEY, '{"hull":"purple","skin":"flow"}');
    const s = createCustomizationStore(localStorage);
    expect(s.accent()).toBe(DEFAULT_ACCENT);
    expect(s.hull()).toBe('purple');
    expect(s.skin()).toBe('flow');
  });

  it('refuses to store a non-list accent id', () => {
    const s = createCustomizationStore(localStorage);
    s.setAccent('rainbow' as never);
    expect(s.accent()).toBe(DEFAULT_ACCENT);
  });

  it('accentHexFor resolves every entry: null for auto, a real hex for the rest', () => {
    const s = createCustomizationStore(localStorage);
    expect(s.accentHexFor('auto')).toBeNull();
    for (const a of ACCENTS.filter((x) => x.id !== 'auto')) {
      expect(s.accentHexFor(a.id), a.id).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
