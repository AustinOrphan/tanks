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
import { distance, overFelt } from './colour-distance';
import { IDENTITY_RING_COLORS, TEAM_COLORS } from './identity';

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

  it('keeps every swatch a NOTICEABLE step from every player identity colour (issue #586)', () => {
    // The gap this closes, and why the floor is 1 rather than the 12 above.
    //
    // The test above compares swatches to ENEMY kinds. Nothing compared them to the PLAYER
    // identity palettes -- grepped before writing this: of the eight test files that mention
    // `PALETTE`, only `dependency-direction.test.ts` and `loop.test.ts` also name
    // `IDENTITY_RING_COLORS` or `TEAM_COLORS`, and neither compares them perceptually.
    //
    // MEASURED, composited over the felt the way `makeIdentityRing` actually draws the ring
    // (`overFelt`, the same helper #579 added), over all 7 x 6 = 42 pairs:
    //
    //   1.1706  ring1 #ff8a1e vs orange #e08a2e   <- the minimum
    //   2.7763  teamA #ff3b3b vs red    #d64545
    //   5.2794  ring3 #9d3bff vs purple #8a5ad6
    //   8.3668  ring2 #ff4d2e vs red    #d64545
    //
    // So 4 of 42 pairs sit below the 12 the enemy guard uses, and ONE sits below the 2.09 that
    // issue #579 treated as a defect worth re-picking team B over. That asymmetry is real and
    // it was ruled on: the ring says WHO and the hull says WHAT STYLE, so a player carrying an
    // orange ring over an orange hull is tolerated and ring 1 is NOT re-picked -- its
    // blue/orange axis was chosen to survive protanopia, deuteranopia and tritanopia, and
    // spending that argument to buy 1 unit of distance against one paint is the worse trade.
    //
    // WHAT THE FLOOR IS FOR, then: not adequacy, but preventing the tolerated collision from
    // becoming an identity. 1.0 is CIEDE2000's just-noticeable difference, so this says the two
    // must stay distinguishable AT ALL. Deliberately not raised to look safer -- the same
    // reasoning the enemy guard above records for its 12 against a measured 13.60. Measured
    // here: 0 of 42 pairs are below 1, and the margin on the tightest is 0.17.
    const identities: [string, number][] = [
      ...IDENTITY_RING_COLORS.map((c, i) => [`ring${i}`, c] as [string, number]),
      ...TEAM_COLORS.map((c, i) => [`team${'ABC'[i]}`, c] as [string, number]),
    ];
    expect(identities, '4 ring colours + 3 team colours').toHaveLength(7);
    let pairs = 0;
    let tightest = Infinity;
    let tightestPair = '';
    for (const [name, colour] of identities) {
      // The ring is translucent over the felt; the hull paint is opaque. Comparing the raw
      // ring hex instead would read 6.09 for the tightest pair and hide the real margin.
      const drawn = overFelt(colour);
      for (const swatch of PALETTE) {
        pairs += 1;
        const d = distance(drawn, parseInt(swatch.hex.slice(1), 16));
        if (d < tightest) { tightest = d; tightestPair = `${name} vs ${swatch.id}`; }
        expect(d, `${name} vs ${swatch.id} is not a noticeable step`).toBeGreaterThan(1);
      }
    }
    expect(pairs, '7 identity colours x 6 swatches').toBe(42);
    // The tightest pair is pinned by NAME, not just by floor: if a future re-pick moves the
    // collision to a different pair, that is a change worth reading about rather than one that
    // quietly keeps passing. The value is deliberately loose (2 d.p. would fail on a rounding
    // change in `overFelt`); the pair identity is the part that matters.
    expect(tightestPair, 'the tolerated collision is ring1 vs orange').toBe('ring1 vs orange');
    expect(tightest).toBeLessThan(1.5);
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
