// @vitest-environment jsdom
// The paint shop's memory: one persisted choice from a CURATED palette. Unknown or
// corrupt values read as the default -- a save must never paint the player an enemy
// colour, and the palette deliberately contains none.
import { describe, it, expect, beforeEach } from 'vitest';
import { createCustomizationStore, PALETTE, DEFAULT_HULL, CUSTOM_KEY } from './customization';
import { GAME_TANK_DEFS } from '../sim/config/roster';

beforeEach(() => localStorage.clear());

describe('the palette', () => {
  it('offers no enemy identity', () => {
    // Population: every non-player kind in the shipped roster, against every swatch.
    const enemyHues = Object.entries(GAME_TANK_DEFS)
      .filter(([kind]) => kind !== 'player')
      .map(([, def]) => def.color.toLowerCase());
    for (const swatch of PALETTE) {
      expect(enemyHues, swatch.id).not.toContain(swatch.hex.toLowerCase());
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
