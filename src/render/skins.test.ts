// DataTextures are CPU-side, so the whole generator is testable headlessly.
import { describe, it, expect } from 'vitest';
import { createSkinTexture } from './skins';
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
     * choice including `auto` (5, ACCENTS) x every patterned skin (4) = 120 combinations,
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
      expect(checked).toBe(PALETTE.length * ACCENTS.length * PATTERNED_SKINS.length); // 120
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
     * which keeps the old unguarded derivation on purpose (4: black/white/silver/gold)
     * x every patterned skin (4) = 96 combinations, all checked.
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
      expect(checked).toBe(96);
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

    it('a white accent lands close to what auto ships today, on the default hull', () => {
      // auto on blue (the default hull) already lightens TOWARD white
      // (lighten(base, 0.75)), so an explicit white accent -- a different mechanism
      // reaching for a similar result -- should land in the same neighbourhood: a
      // player who picks "White" should not be surprised by a totally different
      // stripe brightness than the auto look they are used to.
      const auto = toneStats(pixelsOf('stripes', '#3d7bd6', null));
      const white = toneStats(pixelsOf('stripes', '#3d7bd6', '#f2f2f2'));
      expect(Math.abs(auto.spread - white.spread)).toBeLessThan(25);
    });

    it('an explicit accent is used AS THE TONE, not silently ignored in favour of auto', () => {
      // Black shares no history with auto's always-lighten derivation, so the two
      // must actually differ pixel-for-pixel -- proving the accent argument is wired
      // through, not dropped on the floor with auto rendering regardless of the pick.
      const auto = pixelsOf('stripes', '#3d7bd6', null);
      const black = pixelsOf('stripes', '#3d7bd6', '#101010');
      expect(black).not.toEqual(auto);
    });

    it('auto is BYTE-IDENTICAL to the pre-accent-feature derivation, for every shipped hull', () => {
      // Golden FNV-1a hashes of `createSkinTexture(skin, hex, null)`'s pixel bytes,
      // captured from THIS code and cross-checked once against origin/fire-modes's
      // skins.ts byte-for-byte (all 24 combinations matched exactly -- see the PR
      // description). Pinning the hash rather than re-deriving it here means a
      // constant tweak inside the `auto` branch (e.g. stripes' 0.75 lighten ratio)
      // fails this test instead of silently changing every existing save's tank.
      const GOLDEN: Record<string, string> = {
        'blue/stripes': '1337afc5', 'blue/camo': '9bb06987', 'blue/checker': '8be85dc5', 'blue/flow': 'ef5048e6',
        'red/stripes': '46778dc5', 'red/camo': 'eea1f490', 'red/checker': 'b8e15dc5', 'red/flow': '983e55a5',
        'orange/stripes': 'ace46dc5', 'orange/camo': '85862f64', 'orange/checker': 'e50d5dc5', 'orange/flow': 'b36a4c88',
        'purple/stripes': 'c2ebe9c5', 'purple/camo': '1dccbcc7', 'purple/checker': '83e51dc5', 'purple/flow': '6dcd11d9',
        'green/stripes': 'f207e7c5', 'green/camo': '660d915c', 'green/checker': '4dfaddc5', 'green/flow': 'c263c49e',
        'white/stripes': '386337c5', 'white/camo': '13d6f32b', 'white/checker': '18785dc5', 'white/flow': '24d53a05',
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
      expect(checked).toBe(24); // 6 shipped hulls x 4 patterned skins, all of them
    });
  });
});
