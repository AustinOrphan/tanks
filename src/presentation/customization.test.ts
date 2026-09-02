// The paint shop's CATALOG: which hull swatches, skins, accents and spawn animations
// exist, what they are called, and which is the default. Persisting a pick is
// game/customization.test.ts's subject; this file never touches storage.
import { describe, it, expect } from 'vitest';
import {
  PALETTE,
  SKINS,
  ACCENTS,
  SPAWN_ANIMATIONS,
  DEFAULT_HULL,
  DEFAULT_SKIN,
  DEFAULT_ACCENT,
  DEFAULT_SPAWN_ANIM,
  type SpawnAnimId,
} from './customization';
import { GAME_TANK_DEFS } from '../sim/config/roster';

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

  it('keeps every shipped KIND perceptually clear of every other kind', () => {
    // Kind-vs-kind, which the swatch test above cannot see: review proved that giving
    // yellow grey's exact hex passed all 2150 tests, because nothing compared enemies
    // to EACH OTHER and hull colour is a kind's primary identity channel (issue #137).
    // Population: all 21 pairs of the 7 shipped kinds, player included. Same floor 20
    // deltaE76 as the swatch test; the shipped minimum is 33.0 (olive vs green),
    // measured over those 21 pairs, so this passes with headroom while failing any
    // future kind that lands on (or one hex off) an existing identity.
    const kinds = Object.entries(GAME_TANK_DEFS);
    for (let i = 0; i < kinds.length; i++) {
      for (let j = i + 1; j < kinds.length; j++) {
        const [ka, a] = kinds[i];
        const [kb, b] = kinds[j];
        expect(deltaE(a.color, b.color), `${ka} vs ${kb}`).toBeGreaterThan(20);
      }
    }
  });

  it('leads with the shipped default', () => {
    expect(PALETTE[0].id).toBe(DEFAULT_HULL);
    expect(PALETTE[0].hex.toLowerCase()).toBe(GAME_TANK_DEFS.player.color.toLowerCase());
  });
});

describe('skins', () => {
  it('offers the approved six, solid first as the default', () => {
    // `clouds` is the newest and arrived by accident: unifying the `auto` accent briefly
    // gave camo a far larger delta, and the light blotch field that produced was better
    // as its own skin than as a broken camo. It shares camo's painter at a different
    // density -- see `blotches` in skins.ts.
    expect(SKINS.map((s) => s.id)).toEqual([
      'solid', 'stripes', 'camo', 'clouds', 'checker', 'flow', 'two-tone',
    ]);
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
});

describe('SPAWN_ANIMATIONS', () => {
  it('is a frozen list with unique ids and warp first', () => {
    expect(Object.isFrozen(SPAWN_ANIMATIONS)).toBe(true);
    const ids = SPAWN_ANIMATIONS.map((v) => v.id);
    expect(ids).toEqual(['warp', 'rise', 'beacon']);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('DEFAULT_SPAWN_ANIM is warp and is present in the list', () => {
    expect(DEFAULT_SPAWN_ANIM).toBe<SpawnAnimId>('warp');
    expect(SPAWN_ANIMATIONS.some((v) => v.id === DEFAULT_SPAWN_ANIM)).toBe(true);
  });
});
