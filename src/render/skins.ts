import * as THREE from 'three';
import type { SkinId } from '../game/customization';

/**
 * Procedural skin textures, minted at runtime like every other texture in the game --
 * no assets. Each pattern is built from the CHOSEN hull colour plus tones derived
 * from it, so paint and skin compose: a red camo and a green camo are the same
 * pattern in different clothes.
 *
 * Deterministic on purpose (seeded xorshift, no Math.random): the same pick renders
 * the same tank every session.
 */
const SIZE = 128;

/** xorshift32, as textures.ts uses: repeatable is the point. */
function xorshift(seed: number): () => number {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

type RGB = [number, number, number];

function rgbOf(hex: string): RGB {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Mix toward white rather than scalar-multiply for LIGHT tones: on saturated
 * bases a multiply clips one channel and the lift disappears under the scene's
 * lighting and tone mapping -- measured on-tank, x1.45 read as solid.
 */
function lighten(c: RGB, t: number): RGB {
  return [
    Math.round(c[0] + (255 - c[0]) * t),
    Math.round(c[1] + (255 - c[1]) * t),
    Math.round(c[2] + (255 - c[2]) * t),
  ];
}

function scale(c: RGB, f: number): RGB {
  return [
    Math.min(255, Math.round(c[0] * f)),
    Math.min(255, Math.round(c[1] * f)),
    Math.min(255, Math.round(c[2] * f)),
  ];
}

/**
 * Rec. 709 luma (the sRGB/BT.709 primaries this palette's hexes are authored against),
 * coarse and cheap -- only used to compare two tones' lightness. Was Rec. 601 until this
 * fix: same shape of formula, different channel weights, and the weights are what decide
 * MIN_ACCENT_DELTA's firing set below, so the two must be read together. `skins.test.ts`
 * keeps its OWN Rec. 601 luma for `toneStats` on purpose -- it measures the rendered
 * pixel bytes as an independent check, not by re-running this function.
 */
function luma(c: RGB): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** RGB (0-255 per channel) to HSL, h/s/l all in [0, 1]. Standard conversion. */
function rgbToHsl(c: RGB): { h: number; s: number; l: number } {
  const r = c[0] / 255;
  const g = c[1] / 255;
  const b = c[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l }; // achromatic: hue is undefined, 0 is as good as any
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return { h, s, l };
}

/** HSL (h/s/l in [0, 1]) back to RGB (0-255 per channel, rounded). */
function hslToRgb(h: number, s: number, l: number): RGB {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue2rgb(h + 1 / 3) * 255),
    Math.round(hue2rgb(h) * 255),
    Math.round(hue2rgb(h - 1 / 3) * 255),
  ];
}

/**
 * MIN_ACCENT_DELTA is the luma gap (of 255) an EXPLICIT accent is pushed to keep from
 * its hull. Measured against the shipped palette (6 hulls x 4 explicit accents, all 24,
 * this file's own `luma`): the three lowest gaps are ALL the white hull's light accents
 * -- white/white 6.4, white/silver 25.4, white/gold 40.2 -- then a jump to orange/gold
 * 45.7 and green/gold 48.2, with every other pairing at 60.5 or above. 43 sits in that
 * empty 40.2-45.7 band: it fires for the three white-hull pairings and nothing else, so
 * orange/gold and green/gold -- both already readable without help -- pass through
 * untouched. See skins.test.ts's population-24 sweep for the full table this is read
 * off of.
 */
const MIN_ACCENT_DELTA = 43;

/**
 * An EXPLICIT accent pick (not `auto`) is used directly as the pattern's second tone --
 * picking black should mean black bands, not a further-darkened black. The one thing it
 * must not do is go invisible: nudge it away from the hull's own lightness, toward
 * whichever pole (black or white) increases the gap, until they separate. A hull/accent
 * pair that already contrasts (every shipped hull against black or gold, for instance)
 * passes through untouched on the first check.
 *
 * The nudge moves ONLY lightness (HSL L), never hue or saturation: convert the accent to
 * HSL once, then step L toward whichever pole the hull needs, converting back to RGB
 * each step to re-check the luma gap. A darkened gold must still READ as gold, not slide
 * toward olive -- which is exactly what the old `scale()`/`lighten()` version did, since
 * multiplying or lifting RGB channels unevenly shifts hue as a side effect. Grey/white
 * accents (s = 0) have no hue to preserve, so this reduces to the old behaviour for them.
 */
function ensureContrast(base: RGB, accent: RGB): RGB {
  const { h, s, l: startL } = rgbToHsl(accent);
  let l = startL;
  let t = accent;
  const towardBlack = luma(base) > 127;
  const STEP = 0.05;
  for (let i = 0; i < 20 && Math.abs(luma(base) - luma(t)) < MIN_ACCENT_DELTA; i++) {
    l = towardBlack ? Math.max(0, l - STEP) : Math.min(1, l + STEP);
    t = hslToRgb(h, s, l);
    if (l === 0 || l === 1) break; // pinned at a pole: no further move is possible
  }
  return t;
}

function fill(px: Uint8ClampedArray, i: number, c: RGB): void {
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
  px[i + 3] = 255;
}

/**
 * The pattern painters, by skin id. Each writes SIZE x SIZE RGBA. `solid` is absent
 * on purpose -- it is the no-map default, not a texture of one colour.
 *
 * `accent` is null for the `auto` pick (customization.ts's AccentId): every formula
 * below then takes the branch it always has -- lighten/scale off the base -- so an
 * existing save's tank renders BYTE-IDENTICAL to before this feature landed. A
 * non-null accent is an EXPLICIT tone the player chose (black bands, not a further-
 * derived black), pushed through `ensureContrast` against the base so a pairing that
 * would otherwise flatten -- a light accent on the one light hull the palette ships,
 * for instance -- still patterns.
 */
const PAINTERS: Record<
  Exclude<SkinId, 'solid'>,
  (px: Uint8ClampedArray, base: RGB, accent: RGB | null) => void
> = {
  stripes(px, base, accent) {
    // Two pale racing bands along the hull's long axis (texture v).
    const light = accent ? ensureContrast(base, accent) : lighten(base, 0.75);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const u = x / SIZE;
        const banded = (u > 0.3 && u < 0.42) || (u > 0.58 && u < 0.7);
        fill(px, (y * SIZE + x) * 4, banded ? light : base);
      }
    }
  },
  camo(px, base, accent) {
    // Seeded blotches in two tones over the base. Auto derives both from the base, as
    // before; an explicit accent supplies the first and the second is a scaled step off
    // THAT (not off the base), so "black camo" reads as two shades of near-black blotch
    // rather than pulling a totally unrelated tone from the hull.
    const dark = accent ? ensureContrast(base, accent) : scale(base, 0.62);
    const deep = accent ? scale(dark, 0.7) : scale(base, 0.4);
    for (let i = 0; i < SIZE * SIZE * 4; i += 4) fill(px, i, base);
    const rnd = xorshift(0xc4310);
    for (const tone of [dark, deep]) {
      for (let b = 0; b < 26; b++) {
        const cx = rnd() * SIZE;
        const cy = rnd() * SIZE;
        const r = 6 + rnd() * 14;
        for (let y = Math.floor(cy - r); y < cy + r; y++) {
          for (let x = Math.floor(cx - r); x < cx + r; x++) {
            if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
            // Wrap so blotches crossing an edge tile seamlessly.
            const wx = ((x % SIZE) + SIZE) % SIZE;
            const wy = ((y % SIZE) + SIZE) % SIZE;
            fill(px, (wy * SIZE + wx) * 4, tone);
          }
        }
      }
    }
  },
  checker(px, base, accent) {
    const dark = accent ? ensureContrast(base, accent) : scale(base, 0.66);
    const cells = 8;
    const cell = SIZE / cells;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
        fill(px, (y * SIZE + x) * 4, on ? base : dark);
      }
    }
  },
  flow(px, base, accent) {
    // Soft diagonal bands built on a sine, so the tile scrolls seamlessly -- this is
    // the ANIMATED one; its speed lives in the skin def (game/customization.ts).
    const light = accent ? ensureContrast(base, accent) : lighten(base, 0.6);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const t = (Math.sin(((x + y) / SIZE) * Math.PI * 4) + 1) / 2;
        const mixed: RGB = [
          Math.round(base[0] + (light[0] - base[0]) * t),
          Math.round(base[1] + (light[1] - base[1]) * t),
          Math.round(base[2] + (light[2] - base[2]) * t),
        ];
        fill(px, (y * SIZE + x) * 4, mixed);
      }
    }
  },
};

/**
 * A tiling colour texture for the skin, tinted from `baseHex` -- or null for the
 * solid default, which stays a plain material colour. `accentHex` is the paint shop's
 * `AccentId` resolved to a hex (customization.ts's `accentHexFor`) -- null means
 * `auto`, meaning derive the second tone from `baseHex` exactly as this always has.
 * Caller owns disposal.
 */
export function createSkinTexture(
  skin: SkinId,
  baseHex: string,
  accentHex: string | null = null,
): THREE.DataTexture | null {
  if (skin === 'solid') return null;
  const px = new Uint8ClampedArray(SIZE * SIZE * 4);
  PAINTERS[skin](px, rgbOf(baseHex), accentHex ? rgbOf(accentHex) : null);
  const t = new THREE.DataTexture(px, SIZE, SIZE, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
