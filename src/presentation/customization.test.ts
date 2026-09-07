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
import { distance } from './colour-distance';

describe('the palette', () => {
  it('keeps every swatch PERCEPTUALLY clear of every enemy identity', () => {
    // Population: every non-player kind in the shipped roster, against every swatch.
    // A distance floor, not exact-hex inequality: review pointed out the equality pin
    // would accept a swatch one hex off an enemy.
    //
    // NOW CIEDE2000, via the shared helper (issue #579). This file used to carry its own
    // hand-rolled deltaE76 and a floor of 20 against a measured minimum of ~27.7. The two
    // metrics disagree by more than the margin: the same worst pair, green vs olive, scores
    // **13.60** under CIEDE2000. CIE76 overstates distance in the saturated region these
    // colours occupy, so the old floor was looser than its number suggested.
    //
    // Floor 12, against that measured 13.60. Deliberately not raised to "look safer": the
    // shipped palette is what it is, and a floor above the real minimum would fail on the
    // first run. Whether green and olive are too close for a player is a design question
    // for the roster, not something this assertion can decide -- it is recorded here so the
    // next person sees the margin rather than inheriting a comfortable-looking 20.
    const enemies = Object.entries(GAME_TANK_DEFS).filter(([kind]) => kind !== 'player');
    for (const swatch of PALETTE) {
      for (const [kind, def] of enemies) {
        expect(
          distance(parseInt(swatch.hex.slice(1), 16), parseInt(def.color.slice(1), 16)),
          `${swatch.id} vs ${kind}`,
        ).toBeGreaterThan(12);
      }
    }
  });

  it('keeps every shipped KIND perceptually clear of every other kind', () => {
    // Kind-vs-kind, which the swatch test above cannot see: review proved that giving
    // yellow grey's exact hex passed all 2150 tests, because nothing compared enemies
    // to EACH OTHER and hull colour is a kind's primary identity channel (issue #137).
    // Population: all 21 pairs of the 7 shipped kinds, player included.
    //
    // NOW CIEDE2000, and the metric change moved WHICH PAIR IS WORST -- which is the
    // clearest argument for having made it. Under the hand-rolled deltaE76 this replaced,
    // the minimum was 33.0 at olive vs green. Under CIEDE2000 it is **17.82 at player vs
    // grey**, a pair the old measure ranked comfortably mid-table. The floor was guarding
    // a pair that was never the closest one.
    //
    // Floor 15, against that measured 17.82. Not rounded up to look reassuring: the margin
    // is genuinely thinner than the old number implied, and player-vs-grey is worth a look
    // from someone deciding roster colours rather than someone writing an assertion.
    const kinds = Object.entries(GAME_TANK_DEFS);
    for (let i = 0; i < kinds.length; i++) {
      for (let j = i + 1; j < kinds.length; j++) {
        const [ka, a] = kinds[i];
        const [kb, b] = kinds[j];
        expect(
          distance(parseInt(a.color.slice(1), 16), parseInt(b.color.slice(1), 16)),
          `${ka} vs ${kb}`,
        ).toBeGreaterThan(15);
      }
    }
  });

  it('leads with the shipped default', () => {
    expect(PALETTE[0].id).toBe(DEFAULT_HULL);
    expect(PALETTE[0].hex.toLowerCase()).toBe(GAME_TANK_DEFS.player.color.toLowerCase());
  });
});

describe('skins', () => {
  it('offers the approved seven, solid first as the default', () => {
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
