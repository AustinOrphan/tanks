// @vitest-environment jsdom
// The paint shop's memory: one persisted choice from a CURATED palette. Unknown or
// corrupt values read as the default -- a save must never paint the player an enemy
// colour, and the palette deliberately contains none.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createCustomizationStore,
  PALETTE,
  SKINS,
  ACCENTS,
  DEFAULT_HULL,
  DEFAULT_SKIN,
  DEFAULT_ACCENT,
  CUSTOM_KEY,
} from './customization';
import { GAME_TANK_DEFS } from '../sim/config/roster';

beforeEach(() => localStorage.clear());

/** Rough CIE Lab from sRGB hex, enough for a coarse deltaE76 floor. */
function lab(hex: string): [number, number, number] {
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const r = lin(parseInt(hex.slice(1, 3), 16) / 255);
  const g = lin(parseInt(hex.slice(3, 5), 16) / 255);
  const b = lin(parseInt(hex.slice(5, 7), 16) / 255);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

describe('the palette', () => {
  it('keeps every swatch PERCEPTUALLY clear of every enemy identity', () => {
    // Population: every non-player kind in the shipped roster, against every swatch.
    // A distance floor, not exact-hex inequality: review pointed out the equality pin
    // would accept a swatch one hex off an enemy. Floor 20 deltaE76 -- the shipped
    // minimum is ~27.7 (green vs olive), measured, so this passes with headroom while
    // failing anything that would genuinely read as an enemy at play distance.
    const enemies = Object.entries(GAME_TANK_DEFS).filter(([kind]) => kind !== 'player');
    for (const swatch of PALETTE) {
      for (const [kind, def] of enemies) {
        expect(deltaE(swatch.hex, def.color), `${swatch.id} vs ${kind}`).toBeGreaterThan(20);
      }
    }
  });

  it('leads with the shipped default', () => {
    expect(PALETTE[0].id).toBe(DEFAULT_HULL);
    expect(PALETTE[0].hex.toLowerCase()).toBe(GAME_TANK_DEFS.player.color.toLowerCase());
  });
});

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
  it('offers the approved five, solid first as the default', () => {
    expect(SKINS.map((s) => s.id)).toEqual(['solid', 'stripes', 'camo', 'checker', 'flow']);
    expect(SKINS[0].id).toBe(DEFAULT_SKIN);
  });

  it('flow is the animated one, and slow: speed is per-skin DATA', () => {
    // The user wants a bold variant eventually; that must be a data entry, not new
    // machinery -- which is exactly what this field being data proves.
    const flow = SKINS.find((s) => s.id === 'flow')!;
    expect(flow.scroll).toBeDefined();
    expect(Math.hypot(flow.scroll!.u, flow.scroll!.v)).toBeLessThan(0.2); // repeats/second
    for (const s of SKINS.filter((x) => x.id !== 'flow')) expect(s.scroll).toBeUndefined();
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
  it('leads with auto, the shipped default, and includes black and white', () => {
    expect(ACCENTS[0].id).toBe('auto');
    expect(ACCENTS[0].id).toBe(DEFAULT_ACCENT);
    expect(ACCENTS[0].hex).toBeNull(); // auto has no hex of its own -- it derives one
    const ids = ACCENTS.map((a) => a.id);
    expect(ids).toContain('black');
    expect(ids).toContain('white');
    // Every non-auto entry carries a real hex.
    for (const a of ACCENTS.filter((x) => x.id !== 'auto')) {
      expect(a.hex, a.id).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

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
