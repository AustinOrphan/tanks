// DataTextures are CPU-side, so the whole generator is testable headlessly.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createSkinTexture,
  ensureContrast,
  luma as luma709,
  MIN_ACCENT_DELTA,
  AUTO_ACCENT_DELTA,
} from './skins';
import type { RGB } from './skins';
import { SKINS, PALETTE, ACCENTS } from '../game/customization';

const pixelsOf = (
  skin: Exclude<(typeof SKINS)[number]['id'], 'solid'>,
  hex: string,
  accentHex: string | null = null,
): Uint8ClampedArray =>
  createSkinTexture(skin, hex, accentHex)!.image.data as Uint8ClampedArray;

const PATTERNED_SKINS = SKINS.filter((s) => s.id !== 'solid').map((s) => s.id) as Exclude<
  (typeof SKINS)[number]['id'],
  'solid'
>[];

/** Rec. 601 luma -- used only to measure a texture's lightest-to-darkest spread. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function toneStats(px: Uint8ClampedArray): { tones: number; spread: number } {
  const tones = new Set<string>();
  let minL = Infinity;
  let maxL = -Infinity;
  for (let i = 0; i < px.length; i += 4) {
    tones.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
    const l = luma(px[i], px[i + 1], px[i + 2]);
    if (l < minL) minL = l;
    if (l > maxL) maxL = l;
  }
  return { tones: tones.size, spread: maxL - minL };
}

/** FNV-1a over the raw RGBA bytes -- cheap, and sensitive to any single-byte change. */
function fnv1a(bytes: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const hslOf = (r: number, g: number, b: number): { h: number; s: number } => {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: (h / 6) * 360, s };
};

/** Every distinct RGB triple in a texture. */
function distinctTones(px: Uint8ClampedArray): Array<[number, number, number]> {
  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < px.length; i += 4) {
    seen.set(`${px[i]},${px[i + 1]},${px[i + 2]}`, [px[i], px[i + 1], px[i + 2]]);
  }
  return [...seen.values()];
}

const rgbOfHexTop = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

describe('createSkinTexture', () => {
  it('solid is the no-map default, every other skin mints a tiling texture', () => {
    expect(createSkinTexture('solid', '#3d7bd6')).toBeNull();
    // Population: every non-solid skin in the shipped list.
    for (const s of SKINS.filter((x) => x.id !== 'solid')) {
      const t = createSkinTexture(s.id, '#3d7bd6')!;
      expect(t, s.id).not.toBeNull();
      expect(t.wrapS, s.id).toBe(1000); // THREE.RepeatWrapping
      t.dispose();
    }
  });

  it('samples the tile the way it was DECIDED to, not the way DataTexture defaults', () => {
    // Population: all 5 non-solid skins (derived from SKINS, so a sixth arrives here
    // automatically). Every one is minted by the same factory, so this is really one
    // decision checked five times -- what it catches is a per-skin special case as much
    // as a change to the constants.
    //
    // The production change it catches: deleting the three assignments in
    // createSkinTexture, which is what the file did before -- `magFilter`/`minFilter`
    // both NearestFilter and `generateMipmaps` false, inherited from three's
    // DataTexture rather than chosen. At play distance that point-samples ~4 texels per
    // pixel; see the constants' comments for the measurement that moved it.
    for (const s of PATTERNED_SKINS) {
      const t = createSkinTexture(s, '#3d7bd6')!;
      expect(t.minFilter, s).toBe(THREE.LinearMipmapLinearFilter);
      expect(t.magFilter, s).toBe(THREE.NearestFilter);
      expect(t.generateMipmaps, s).toBe(true);
      t.dispose();
    }
  });

  it('never asks for a mipmap filter without mipmaps, which samples BLACK', () => {
    // Not a restatement of the case above: minFilter and generateMipmaps are separate
    // constants, so raising one without the other is a one-line edit that typechecks,
    // passes every pixel assertion in this file (they read image.data, not a sample),
    // and renders an incomplete texture -- a black tank, visible only in a browser.
    const MIPMAPPED: number[] = [
      THREE.NearestMipmapNearestFilter, THREE.NearestMipmapLinearFilter,
      THREE.LinearMipmapNearestFilter, THREE.LinearMipmapLinearFilter,
    ];
    for (const s of PATTERNED_SKINS) {
      const t = createSkinTexture(s, '#3d7bd6')!;
      if (MIPMAPPED.includes(t.minFilter)) expect(t.generateMipmaps, s).toBe(true);
      t.dispose();
    }
    // ...and the guard is worth what its own control proves: at least one skin really
    // does take the mipmap branch, so the loop above is not vacuous.
    const probe = createSkinTexture(PATTERNED_SKINS[0], '#3d7bd6')!;
    expect(MIPMAPPED).toContain(probe.minFilter);
    probe.dispose();
  });

  it('is deterministic: the same pick renders the same tank every session', () => {
    expect(pixelsOf('camo', '#d64545')).toEqual(pixelsOf('camo', '#d64545'));
  });

  it('tints from the chosen hull colour: red camo and green camo differ everywhere it matters', () => {
    const red = pixelsOf('camo', '#d64545');
    const green = pixelsOf('camo', '#4fae52');
    expect(red).not.toEqual(green);
    // The base tone dominates: sample a pixel and check the red channel leads on red.
    expect(red[0]).toBeGreaterThan(red[2]);
    expect(green[1]).toBeGreaterThan(green[0]);
  });

  it('every pattern actually patterns: at least two distinct tones per texture', () => {
    for (const s of PATTERNED_SKINS) {
      const px = pixelsOf(s, '#3d7bd6');
      expect(toneStats(px).tones, s).toBeGreaterThan(1); // a one-tone "pattern" is solid with extra steps
    }
  });

  describe('pattern direction and coverage', () => {
    const SIZE = 128;
    const rowOf = (px: Uint8ClampedArray, y: number): Array<string> => {
      const out: string[] = [];
      for (let x = 0; x < SIZE; x++) {
        const i = (y * SIZE + x) * 4;
        out.push(`${px[i]},${px[i + 1]},${px[i + 2]}`);
      }
      return out;
    };

    it('the racing stripe runs along the tank, not across it', () => {
      // Austin: "The hull also appears to have stripes running the wrong direction. They
      // should run parallel to the treads." He was right, and the cause is in the UVs:
      // the hull is an ExtrudeGeometry whose cap UVs are the shape's (x, y) = (LENGTH,
      // width), so banding on u held the LENGTH constant and ran the band across the
      // tank -- a belt, perpendicular to the treads.
      //
      // Expressed at the texture level: banding on v means every ROW is one flat colour
      // and rows differ. Banding on u is the transpose -- rows are striped internally --
      // so this assertion is exactly the discriminator between the two, and it fails on
      // the old code rather than merely describing the new.
      const px = pixelsOf('stripes', '#3d7bd6', null);
      const striped: number[] = [];
      for (let y = 0; y < SIZE; y++) {
        if (new Set(rowOf(px, y)).size !== 1) striped.push(y);
      }
      expect(striped, `rows ${striped.slice(0, 3)}... vary internally: the stripe runs ACROSS`).toEqual([]);
      const rowColours = new Set(Array.from({ length: SIZE }, (_, y) => rowOf(px, y)[0]));
      // ...and it must actually be a stripe, not a flat texture that trivially passes.
      expect(rowColours.size).toBe(2);
    });

    it('there are exactly TWO stripes, straddling the centreline', () => {
      // Austin asked for a single stripe first, then for two once he saw it on the
      // tank. Counting RUNS on the WRAPPED row sequence is what makes this exact: the
      // centreline is v = 0, which RepeatWrapping puts on the tile's edge, so a single
      // centred stripe would appear as two half-bands and count as ONE run, while these
      // two flanking stripes count as two. The wrap is why a naive scan would confuse
      // the two arrangements.
      const px = pixelsOf('stripes', '#3d7bd6', null);
      const rows = Array.from({ length: SIZE }, (_, y) => rowOf(px, y)[0]);
      const base = rows[Math.floor(SIZE / 2)]; // mid-texture is furthest from the seam
      let runs = 0;
      for (let y = 0; y < SIZE; y++) {
        const prev = rows[(y - 1 + SIZE) % SIZE];
        if (rows[y] !== base && prev === base) runs += 1;
      }
      expect(runs, 'the hull no longer carries exactly two stripes').toBe(2);
    });

    it('clouds is LIGHT on every hull that has room to be', () => {
      // The guard for the exemption above. Review measured that clouds' dominant tone
      // landed at luma 23 on the orange hull and 29 on the green -- near-black blotches
      // on a skin called Clouds, 3 of the 6 shipped hulls -- because `autoAccent` moves
      // away from the nearest pole and those hulls are light. Every existing test asked
      // about CONTRAST, which was fine, so nothing caught it.
      //
      // Population: all 6 shipped hulls, the complete set. Only the white hull may go
      // dark, and only because lightening it cannot clear the delta at all (19 luma of
      // headroom against a 64 target).
      const wrong: string[] = [];
      for (const hull of PALETTE) {
        const px = pixelsOf('clouds', hull.hex, null);
        const hullL = luma(...rgbOfHexTop(hull.hex));
        // The dominant tone: the second one painted, which covers the most texture.
        const counts = new Map<string, number>();
        for (let i = 0; i < px.length; i += 4) {
          const k = `${px[i]},${px[i + 1]},${px[i + 2]}`;
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const toneL = luma(...(top[0].split(',').map(Number) as [number, number, number]));
        const mayGoDark = 255 - hullL < AUTO_ACCENT_DELTA;
        if (!mayGoDark && toneL < hullL) wrong.push(`${hull.id}: ${hullL.toFixed(0)} -> ${toneL.toFixed(0)}`);
      }
      expect(wrong).toEqual([]);
    });

    it('pins WHERE the stripes sit, which the golden hash provably does not', () => {
      // Review found the hole this closes. The stripes texture is row-uniform, so an
      // FNV-1a over it collapses to the COUNT of banded rows -- it cannot see where
      // those rows are. Measured: 101 of 414 alternative STRIPE_CENTRE_V values in
      // [0.043, 0.457] reproduce the complete golden hash table, and the whole suite
      // stayed green at 0.30, with the stripes visibly moved off the centreline and
      // onto the shoulders. That directly falsified the re-pinned hash test's stated
      // purpose, so the position needs its own assertion.
      //
      // The expected rows are HARDCODED, not recomputed from STRIPE_CENTRE_V and
      // STRIPE_HALF_V -- deriving them from the constants under test is the tautology
      // this file keeps catching elsewhere. Read them as a golden value: 128 rows, two
      // stripes centred on v = +/-0.105, so row 13.5 and row 114.5.
      const px = pixelsOf('stripes', '#3d7bd6', null);
      const SIZE = 128;
      const rowColour = (y: number): string => {
        const i = (y * SIZE + 0) * 4;
        return `${px[i]},${px[i + 1]},${px[i + 2]}`;
      };
      const base = rowColour(SIZE / 2); // mid-texture is furthest from the seam
      const banded = Array.from({ length: SIZE }, (_, y) => y).filter((y) => rowColour(y) !== base);
      // Group into runs on the WRAPPED sequence, then take each run's centre.
      const centres: number[] = [];
      for (const y of banded) {
        if (!banded.includes((y - 1 + SIZE) % SIZE)) {
          let len = 0;
          while (banded.includes((y + len) % SIZE)) len += 1;
          centres.push((y + (len - 1) / 2) % SIZE);
        }
      }
      // The two centres ARE the symmetry check: 13.5 and 114.5 sit equidistant from the
      // seam at row 0 (13.5 and 128 - 114.5 = 13.5), so an asymmetric pair fails here.
      expect(centres.sort((a, b) => a - b)).toEqual([13.5, 114.5]);
      // Total width, kept as a cheap width check. Note it adds nothing the golden hash
      // does not already see -- the hash over a row-uniform texture IS the banded-row
      // count -- so it is the centres above that carry this test's whole contribution.
      expect(banded.length).toBe(20);
    });

    it('camo COVERS the hull; clouds leaves it as the majority tone', () => {
      // THIS TEST USED TO ASSERT THE OPPOSITE, and the assertion was the defect rather
      // than the guard against it. Austin: "camo and clouds need to be swapped, the
      // skins appear to have their names reversed." Camouflage is dense interlocking
      // patches that cover most of a surface; clouds are separated puffs over a field
      // that stays visible. Camo shipped sparse (hull surviving on 57.8%) and clouds
      // dense (27.9%), so each read as the other's name, and this test pinned it that
      // way. He confirmed the swap after seeing it rendered, so these thresholds are
      // now the right way round.
      //
      // Coverage is invisible to a spread metric, which is why it needs its own test:
      // both arrangements have identical tone spreads, because only the AREAS moved.
      //
      // MEASURED BY NEAREST TONE, not by exact equality with the hull hex, and the
      // change of metric is forced rather than cosmetic. Camo is three flat tones so
      // the two agree exactly on it (0.2922 either way). Clouds is soft-edged, so every
      // rim pixel is a blend that equals no tone exactly: counting exact matches scores
      // it 0.5913 while 0.6484 of the tile actually READS as hull. An exact-match metric
      // therefore penalises a skin for having soft edges, which is a property this skin
      // is supposed to have, and would drift further with any change to the rim width.
      const share = (skin: 'camo' | 'clouds', hex: string): number => {
        const px = pixelsOf(skin, hex, null);
        const base: [number, number, number] = [
          parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
        ];
        // The three flat tones are the three commonest exact colours: the base and the
        // two accents. Every other colour in the tile is a rim blend between them.
        const counts = new Map<string, number>();
        for (let i = 0; i < px.length; i += 4) {
          const k = `${px[i]},${px[i + 1]},${px[i + 2]}`;
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        const flat = [...counts.entries()]
          .sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([k]) => k.split(',').map(Number));
        let reads = 0;
        for (let i = 0; i < px.length; i += 4) {
          let bestD = Infinity;
          let best = flat[0];
          for (const t of flat) {
            const d = (px[i] - t[0]) ** 2 + (px[i + 1] - t[1]) ** 2 + (px[i + 2] - t[2]) ** 2;
            if (d < bestD) { bestD = d; best = t; }
          }
          if (best[0] === base[0] && best[1] === base[1] && best[2] === base[2]) reads += 1;
        }
        return reads / (px.length / 4);
      };
      // Swept over ALL SIX shipped hulls, not one: camo lands on 0.2922 for every hull
      // and clouds in 0.6470-0.6502, because both generators are seeded and carry no
      // colour dependence at all. The thresholds sit either side of the midpoint, so
      // swapping the two skins' parameters back fails BOTH of them rather than neither.
      let checked = 0;
      for (const hull of PALETTE) {
        checked++;
        expect(share('camo', hull.hex), `camo has stopped covering the ${hull.id} hull`)
          .toBeLessThan(0.35);
        expect(share('clouds', hull.hex), `clouds has stopped being sky-dominant on ${hull.id}`)
          .toBeGreaterThan(0.5);
      }
      expect(checked).toBe(6);
    });

    it('gives camo and clouds DIFFERENT shape languages, not one shape at two densities', () => {
      // This is the test that would have caught what two rounds of density-swapping
      // could not. Austin reported the two as swapped, the coverage WAS backwards, it
      // was fixed -- and he still said "clouds turret top could be made to look a bit
      // more cloudlike in shape. Same with some spots on the hull." They shared one
      // generator, so they were one silhouette at two densities and could only ever read
      // as versions of each other.
      //
      // Edge hardness is the discriminator, because it is what the eye names: camouflage
      // is hard-edged and clouds are not. Measured as the share of pixels that are NOT
      // one of the three flat tones -- i.e. that sit on a gradient.
      const softRimShare = (skin: 'camo' | 'clouds'): number => {
        const px = pixelsOf(skin, '#3d7bd6', null);
        const counts = new Map<string, number>();
        for (let i = 0; i < px.length; i += 4) {
          const k = `${px[i]},${px[i + 1]},${px[i + 2]}`;
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        const flat = new Set([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k));
        let soft = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (!flat.has(`${px[i]},${px[i + 1]},${px[i + 2]}`)) soft += 1;
        }
        return soft / (px.length / 4);
      };
      // Measured: camo 0.0000 (a power diagram assigns whole pixels to whole cells, so
      // there is no blend anywhere), clouds 0.1802. Replacing cumulus with the old
      // hard-edged blotch generator sends clouds to 0 and fails this.
      expect(softRimShare('camo'), 'camo has grown soft edges -- it will stop reading as camo')
        .toBe(0);
      expect(softRimShare('clouds'), 'clouds has lost its soft edges -- it will read as pale camo')
        .toBeGreaterThan(0.05);
    });
  });

  describe('accent (the pattern\'s second tone) is selectable', () => {
    /**
     * This is the test that would have caught the ORIGINAL defect: pure black and pure
     * white, run through the OLD single-direction derivation (always lighten toward
     * white for stripes/flow, always scale toward black for camo/checker), render as a
     * FLAT BLOCK for half the patterns -- measured before this feature existed:
     * #000000 camo and checker both come back `{tones:1,spread:0}`, and #ffffff stripes
     * and flow do too. See render/skins.ts's `ensureContrast` for the fix.
     *
     * What this does NOT catch, despite living right next to the accent machinery: the
     * later hue-shift defect (orange hull + gold accent rendering as dark olive). A
     * nudge that shifts hue while leaving the pattern multi-toned still passes here --
     * `tones > 1` is blind to WHICH tones. Verified independently: with `ensureContrast`
     * disabled entirely (the accent used raw, no nudge at all), this sweep still passes
     * in full; only the contrast-floor test below dies. Catching a hue shift needs a
     * test that looks at hue, which is the one further down this file.
     *
     * Population for the sweep below: every shipped hull (6, PALETTE) x every accent
     * choice including `auto` (5, ACCENTS) x every patterned skin (5, since `clouds` landed) = 150 combinations,
     * every one of them checked, not a sample.
     */
    it('never renders a flat block, across the full hull x accent x skin cross product', () => {
      const flat: string[] = [];
      let checked = 0;
      for (const hull of PALETTE) {
        for (const accent of ACCENTS) {
          for (const skin of PATTERNED_SKINS) {
            checked++;
            const stats = toneStats(pixelsOf(skin, hull.hex, accent.hex));
            if (stats.tones <= 1) flat.push(`${hull.id}/${accent.id}/${skin}`);
          }
        }
      }
      expect(checked).toBe(PALETTE.length * ACCENTS.length * PATTERNED_SKINS.length); // 150
      expect(flat).toEqual([]);
    });

    /**
     * A stronger bar than "not flat" for an EXPLICIT accent pick specifically -- every
     * one of these 96 combinations should hold a real margin, not just clear zero,
     * whether or not `ensureContrast` (skins.ts) actually nudges that particular pair.
     * Tightening `MIN_ACCENT_DELTA` (see that constant's comment) means most pairs now
     * pass through untouched, so the floor here is no longer "how far the nudge pushes"
     * -- it is "how close the shipped palette's own hexes get without any help", and the
     * worst of those is orange hull (#e08a2e) against the gold accent (#e8c547), which
     * sits at a measured 39.9 spread and is deliberately left un-nudged (see
     * MIN_ACCENT_DELTA). 35 sits 4.9 below that with real headroom, and above anything a
     * genuinely washed-out pattern could reach by accident.
     *
     * Population: every shipped hull (6) x every EXPLICIT accent -- excluding `auto`,
     * which is checked by its own visibility floor below (4: black/white/silver/gold)
     * x every patterned skin (5, since `clouds` landed) = 120 combinations, all
     * checked.
     */
    it('explicit accents clear a real contrast floor, not just "not flat"', () => {
      const weak: string[] = [];
      let checked = 0;
      for (const hull of PALETTE) {
        for (const accent of ACCENTS.filter((a) => a.id !== 'auto')) {
          for (const skin of PATTERNED_SKINS) {
            checked++;
            const stats = toneStats(pixelsOf(skin, hull.hex, accent.hex));
            if (stats.spread < 35) weak.push(`${hull.id}/${accent.id}/${skin} (${stats.spread.toFixed(1)})`);
          }
        }
      }
      expect(checked).toBe(120);
      expect(weak).toEqual([]);
    });

    /**
     * The guard the shipped defect was actually missing: an explicit accent must still
     * READ as the colour the player picked, not just clear a luma-spread floor (which is
     * hue-blind -- see the flat-block sweep's comment above).
     *
     * Measured directly against origin/skin-colours's ACTUAL shipped `ensureContrast`
     * (scale()/lighten(), MIN_ACCENT_DELTA 60, Rec. 601 luma) rather than assumed: hue
     * angle itself barely moves for this palette (worst measured: orange/silver at 3.8
     * degrees, orange/gold at 0.5) -- `scale()` multiplies every channel by the same
     * factor, which is close to hue-preserving on its own, rounding aside. A hue-only
     * assertion with any sane tolerance would NOT have failed on the shipped bug, so it
     * would not have been a real guard -- caught by first writing this test against that
     * un-fixed algorithm and watching it pass regardless.
     *
     * SATURATION is where the shipped defect actually shows up, and by a wide margin:
     * measured on the same un-fixed algorithm, orange/gold's saturation drops from 0.778
     * to 0.537 (-0.24) and orange/silver from 0.186 to 0.038 (-0.15) -- a moderately
     * saturated gold desaturating most of the way to grey is exactly "reads as olive/
     * brown, not gold". After this fix (HSL, lightness-only), the two pairs that still
     * fire at MIN_ACCENT_DELTA=43 (white/gold, white/silver -- every other combination in
     * this population no longer nudges at all, see MIN_ACCENT_DELTA's comment) measure
     * -0.001 and -0.004: saturation is carried through the HSL round-trip essentially
     * exactly, because the fixed `ensureContrast` never touches `s`.
     *
     * TOLERANCE 0.05 sits far below the shipped defect's smallest measured drop (0.15)
     * and above the fix's largest measured drift (0.004) -- both real margin. Hue is
     * still checked too, at a loose 15 degrees: not the primary signal (see above), but
     * cheap insurance against a future change that rotates hue without touching
     * saturation, which this palette's specific numbers do not currently exercise.
     *
     * Restricted to accents with real saturation: black (#101010) and white (#f2f2f2)
     * are fully desaturated (s=0 in HSL) already, so there is no saturation or hue to
     * preserve -- asserting either for them would be noise, not signal. NOT swept: black
     * and white, 2 of the 4 explicit accents, stated here rather than silently dropped.
     *
     * Population: every shipped hull (6) x the 2 saturated explicit accents (silver,
     * gold) = 12 combinations, all checked, sampled via `checker` (its `dark` cell is
     * `ensureContrast`'s output with no further mixing, unlike flow's blend or camo's
     * second-derived tone).
     */
    it('an explicit accent keeps its saturation and hue: gold stays gold, not olive', () => {
      const CELL = 128 / 8; // checker's cell size, matching skins.ts
      const off = (px: Uint8ClampedArray): [number, number, number] => {
        // x=CELL..2*CELL-1, y=0 is an "off" (dark/accent) cell -- see PAINTERS.checker.
        const x = CELL + 1;
        const i = (0 * 128 + x) * 4;
        return [px[i], px[i + 1], px[i + 2]];
      };
      const SAT_TOLERANCE = 0.05;
      const HUE_TOLERANCE_DEG = 15;
      const drifted: string[] = [];
      let checked = 0;
      for (const hull of PALETTE) {
        for (const accent of ACCENTS.filter((a) => a.id === 'silver' || a.id === 'gold')) {
          checked++;
          const want = hslOf(
            parseInt(accent.hex!.slice(1, 3), 16),
            parseInt(accent.hex!.slice(3, 5), 16),
            parseInt(accent.hex!.slice(5, 7), 16),
          );
          const [r, g, b] = off(pixelsOf('checker', hull.hex, accent.hex));
          const got = hslOf(r, g, b);
          const dSat = Math.abs(want.s - got.s);
          let dHue = Math.abs(got.h - want.h) % 360;
          if (dHue > 180) dHue = 360 - dHue;
          if (dSat > SAT_TOLERANCE || dHue > HUE_TOLERANCE_DEG) {
            drifted.push(
              `${hull.id}/${accent.id}: dSat=${dSat.toFixed(3)} dHue=${dHue.toFixed(1)}deg`,
            );
          }
        }
      }
      expect(checked).toBe(12);
      expect(drifted).toEqual([]);
    });

    it('auto keeps the hull\'s OWN hue: a blue tank gets a lighter blue, never white', () => {
      // This replaces a test that asserted auto lands near the explicit WHITE accent.
      // That was true of the old derivation and is exactly what was wrong with it: it
      // mixed toward white, so every auto accent drifted toward grey as it brightened,
      // and ON the white hull it WAS white -- white/stripes measured 14.3 spread and
      // rendered as a featureless blob (screenshotted). autoAccent moves lightness only.
      //
      // Population: 28 of the 30 hull x patterned-skin pairs. The two skipped are
      // clouds on orange and green, for the reason given in the loop; that is the gap.
      const drifted: string[] = [];
      let checked = 0;
      for (const hull of PALETTE) {
        const want = hslOf(...rgbOfHexTop(hull.hex));
        for (const skin of PATTERNED_SKINS) {
          // Clouds on ORANGE and GREEN only. Those are the two hulls whose bright tone
          // reaches pure white (they are light enough that clearing the delta upward
          // runs L to 1), leaving no saturation to keep. An earlier version excluded
          // clouds on ALL six hulls, which was four combinations wider than the reason
          // given -- review measured that narrowing it to these two still passes, 28 of
          // 30 checked. Clouds' own character is pinned by the direction test below.
          if (skin === 'clouds' && (hull.id === 'orange' || hull.id === 'green')) continue;
          checked += 1;
          for (const tone of distinctTones(pixelsOf(skin, hull.hex, null))) {
            const got = hslOf(...tone);
            // A greyed-out tone has lost its saturation; that is the failure mode the
            // old lighten() had. Achromatic hulls have no hue to keep, so they are
            // exempt -- but the shipped palette has none, which `want.s` proves here.
            if (want.s < 0.15) continue;
            if (got.s < want.s * 0.5) {
              drifted.push(`${hull.id}/${skin}: s ${want.s.toFixed(2)} -> ${got.s.toFixed(2)}`);
            }
          }
        }
      }
      expect(checked).toBe(28);
      expect(drifted).toEqual([]);
    });

    it('no auto combination is invisible on its own hull -- the bug Austin reported', () => {
      // white/stripes measured 14.3 and white/flow 11.4 against 33.6-141.6 for the other
      // 22 pairs; both were indistinguishable from a bare hull on screen. The floor is
      // set at 50, below the current worst (68.5, measured across all 30) and far above
      // anything the old derivation produced on white.
      //
      // Population: all 6 hulls x all 5 patterned skins = 30, the complete set.
      const weak: string[] = [];
      let checked = 0;
      for (const hull of PALETTE) {
        for (const skin of PATTERNED_SKINS) {
          checked += 1;
          const stats = toneStats(pixelsOf(skin, hull.hex, null));
          if (stats.spread < 50) weak.push(`${hull.id}/${skin} (${stats.spread.toFixed(1)})`);
        }
      }
      expect(checked).toBe(30);
      expect(weak).toEqual([]);
    });

    it('an explicit accent is used AS THE TONE, not silently ignored in favour of auto', () => {
      // Black shares no history with auto's always-lighten derivation, so the two
      // must actually differ pixel-for-pixel -- proving the accent argument is wired
      // through, not dropped on the floor with auto rendering regardless of the pick.
      const auto = pixelsOf('stripes', '#3d7bd6', null);
      const black = pixelsOf('stripes', '#3d7bd6', '#101010');
      expect(black).not.toEqual(auto);
    });

    it('the auto derivation is pinned: changing it is deliberate, never incidental', () => {
      // This test USED to assert auto was byte-identical to the pre-accent-feature
      // derivation, so an existing save rendered exactly as before. That guarantee is
      // now deliberately broken -- Austin reported that some auto combinations were
      // indistinguishable from the bare hull, and fixing that had to change what every
      // saved tank looks like. The machinery is kept and re-pinned rather than deleted,
      // because its real value was never the specific bytes: it is that a tweak inside
      // the `auto` branch fails HERE, loudly, instead of quietly repainting every
      // player's tank. Re-capture these only when you mean to.
      //
      // Population: 6 shipped hulls x 5 patterned skins = 30, the complete set.
      //
      // RE-CAPTURED TWICE on this branch, for two deliberate changes to the same pair:
      // first the camo/clouds density swap, then the shape-language split that gave each
      // its own generator. Exactly 12 of the 30 moved each time -- both skins on all six
      // hulls -- and the other 18 are byte-for-byte what they were before either change.
      // That invariance is the check that neither touched anything but camo and clouds.
      // If a stripes, checker or flow hash ever moves in the same commit as a
      // camo/clouds one, that is a second change riding along and it needs its own reason.
      const GOLDEN: Record<string, string> = {
        'blue/stripes': '68c745c5', 'blue/camo': '892c9da9', 'blue/clouds': '0865380c', 'blue/checker': '126d1dc5', 'blue/flow': 'ffda8c06',
        'red/stripes': '44d265c5', 'red/camo': '7504e4e5', 'red/clouds': '74217b43', 'red/checker': 'dd799dc5', 'red/flow': 'd3fe9845',
        'orange/stripes': '3678b9c5', 'orange/camo': '29f15911', 'orange/clouds': 'b9caf99e', 'orange/checker': '8750ddc5', 'orange/flow': '8bb8ea70',
        'purple/stripes': '8f6df1c5', 'purple/camo': 'a75fc0dd', 'purple/clouds': '73140927', 'purple/checker': '9b37ddc5', 'purple/flow': 'fe157ce5',
        'green/stripes': '8a012dc5', 'green/camo': '27573ce1', 'green/clouds': '36015881', 'green/checker': '641b9dc5', 'green/flow': 'c5c95e82',
        'white/stripes': 'f8ded5c5', 'white/camo': 'e71c4aed', 'white/clouds': '52c5e1da', 'white/checker': '05b19dc5', 'white/flow': '3d0a85d2',
      };
      let checked = 0;
      for (const hull of PALETTE) {
        for (const skin of PATTERNED_SKINS) {
          checked++;
          const key = `${hull.id}/${skin}`;
          const hash = fnv1a(pixelsOf(skin, hull.hex, null));
          expect(hash, key).toBe(GOLDEN[key]);
        }
      }
      expect(checked).toBe(30); // 6 shipped hulls x 5 patterned skins, all of them
    });
  });
});

describe('ensureContrast never trades the chosen hue away for contrast', () => {
  /**
   * Review found the pole-clip branch (`if (l === 0 || l === 1) break`) had zero
   * coverage, and named the failure it would produce: an accent pushed all the way to a
   * pole comes back pure black or pure white, silently losing the hue the player picked.
   *
   * Measuring first (as the mutation-before-test rule requires) showed the branch is
   * UNREACHABLE at the shipped MIN_ACCENT_DELTA -- 0 hits over the 909,792-pair probe
   * described in `skins.ts`, against 34,835 at 127 and 483,695 at 200 from that same
   * instrumented probe. So the right test is not one that contrives a clip; it is one
   * that pins the unreachability, and fails the day a retune breaks it. That is a live
   * risk: MIN_ACCENT_DELTA has already been moved once (60 -> 43).
   *
   * NOTE the two populations, which an earlier draft of this comment conflated: the
   * 909,792-pair figure is `skins.ts`'s instrumented probe (a 15-step accent grid), and
   * SWEEP below is a coarser 33,696-pair grid sized to run inside the suite. Numbers
   * from one do not describe the other.
   *
   * Killed mutants, all re-measured on the current head:
   *   - MIN_ACCENT_DELTA 43 -> 200 fails 5 of 13 tests here: all three below, plus the
   *     pre-existing gold-stays-gold and white-accent pairs.
   *   - iteration budget 20 -> 1 fails 2 of 13 -- the separation test below, plus the
   *     pre-existing contrast-floor test.
   *   - luma Rec. 709 -> Rec. 601 fails exactly 1 test repo-wide, the weights test
   *     below. Before that test existed the SAME mutation left the whole suite passing
   *     (82 files passed, 1 skipped; 1535 tests), which is why the claim that this
   *     file's own Rec. 601 luma
   *     "independently checks the weights" was false, and is deleted rather than
   *     reworded.
   *
   * EQUIVALENT (not merely surviving) mutant: dropping the `Math.max(0, ...)` clamp
   * changes 0 of 909,792 outputs, because it is unreachable for the same reason the
   * `break` is. No test could kill it, so it is not a coverage hole.
   *
   * These call `ensureContrast` directly rather than reading pixels back out of a
   * texture, because the population needed to make "never" mean anything is thousands of
   * pairs. The texture route was abandoned after the version first written took 253s for
   * 400 pairs -- but that cost was the `expect()` inside the pixel loop, NOT texture
   * generation. At SIZE 128 that is 16,384 px and 65,536 RGBA bytes, and the loop
   * asserted per BYTE: 20 pairs measure 6ms to generate, against 11,036ms with an
   * assertion per byte (8.4us each, which is what reconciles 400 pairs to ~221s of the
   * 253s observed). The sweeps below, calling `ensureContrast` directly, run in
   * MILLISECONDS -- the file's ~1.0s total is dominated by the texture-based tests
   * above, so do not read it as this sweep's cost.
   *
   * Production's Rec. 709 `luma` is imported as `luma709` and does NOT replace this
   * file's Rec. 601 `luma`, which is used for the rendered-pixel `toneStats`. Importing
   * it is right for the question the separation test asks -- "did the loop converge
   * against the threshold the loop itself uses", which is only well posed in the loop's
   * own metric -- and it does mean that test cannot see a wrong weighting. That is what
   * the weights test below is for.
   */
  const SWEEP: Array<{ base: RGB; accent: RGB }> = (() => {
    const out: Array<{ base: RGB; accent: RGB }> = [];
    // 52 base lightnesses x 3 hue families (grey, magenta ramp, cyan ramp) x a 51-step
    // RGB accent grid (6 values a channel). Chosen to cover both sides of the
    // `luma(base) > 127` branch and both fully saturated and achromatic accents, which
    // take different paths through the HSL round-trip.
    for (let bl = 0; bl < 256; bl += 5) {
      for (const base of [[bl, bl, bl], [bl, 0, 255 - bl], [0, bl, 255 - bl]] as RGB[]) {
        for (let r = 0; r < 256; r += 51)
          for (let g = 0; g < 256; g += 51)
            for (let b = 0; b < 256; b += 51) out.push({ base, accent: [r, g, b] });
      }
    }
    return out;
  })();

  const isAchromatic = (c: RGB): boolean => c[0] === c[1] && c[1] === c[2];

  it('always reaches the required separation, over a 33,696-pair sweep', () => {
    // Population: all 33,696 pairs in SWEEP -- an exhaustive product of the grids above,
    // NOT a sample of the 2^48 possible pairs. What it establishes is that no pair in
    // this grid leaves the loop short of the threshold, i.e. that 20 iterations at a
    // 0.05 step suffice for the whole grid.
    expect(SWEEP.length, 'the sweep is not the 33,696-pair grid this test describes').toBe(33696);
    const short = SWEEP.filter(
      ({ base, accent }) =>
        Math.abs(luma709(base) - luma709(ensureContrast(base, accent))) < MIN_ACCENT_DELTA - 1e-9,
    );
    expect(short.length, `${short.length} pairs, e.g. ${JSON.stringify(short[0])}`).toBe(0);
  });

  it('keeps a chromatic accent chromatic -- the pole is never reached', () => {
    // THE assertion review asked for. It fails the moment the clip branch starts firing:
    // re-run at MIN_ACCENT_DELTA 200 and 20,008 of these 32,760 chromatic accents come
    // back grey. (An earlier draft quoted 483,695 here, which is the other probe's
    // pole-hit count and larger than this whole population -- the exact "count without
    // its denominator" failure this repo keeps shipping.)
    const chromatic = SWEEP.filter(({ accent }) => !isAchromatic(accent));
    expect(chromatic.length, 'the chromatic sub-population is no longer 32,760').toBe(32760);

    const flattened = chromatic.filter(({ base, accent }) => isAchromatic(ensureContrast(base, accent)));
    expect(
      flattened.length,
      `${flattened.length} chromatic accents came back grey, e.g. ${JSON.stringify(flattened[0])}`,
    ).toBe(0);
  });

  it('nudges exactly the three white-hull pairings, which is what pins the luma weights', () => {
    // Closes a hole review measured: swapping production's luma from Rec. 709 to Rec.
    // 601 left the whole suite passing (82 files passed, 1 skipped; 1535 tests), even
    // though `skins.ts` says those weights decide this very firing set. Nothing checked
    // them.
    //
    // Population: all 24 (hull, explicit accent) pairs the shipped palette can produce --
    // 6 hulls x 4 non-auto accents, the complete set, not a sample. Under Rec. 601 the
    // set gains orange/gold, so this fails on that mutation.
    const rgbOfHex = (h: string): RGB => [
      parseInt(h.slice(1, 3), 16),
      parseInt(h.slice(3, 5), 16),
      parseInt(h.slice(5, 7), 16),
    ];
    const fired: string[] = [];
    let checked = 0;
    for (const hull of PALETTE) {
      for (const a of ACCENTS) {
        if (a.hex === null) continue; // `auto` is derived, not run through ensureContrast
        checked += 1;
        const accent = rgbOfHex(a.hex);
        const out = ensureContrast(rgbOfHex(hull.hex), accent);
        const moved = out[0] !== accent[0] || out[1] !== accent[1] || out[2] !== accent[2];
        if (moved) fired.push(`${hull.id}/${a.id}`);
      }
    }
    expect(checked, 'the palette changed size; this population is no longer 24').toBe(24);
    expect(fired.sort()).toEqual(['white/gold', 'white/silver', 'white/white']);
  });
});
