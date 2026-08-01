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

function fill(px: Uint8ClampedArray, i: number, c: RGB): void {
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
  px[i + 3] = 255;
}

/**
 * The pattern painters, by skin id. Each writes SIZE x SIZE RGBA. `solid` is absent
 * on purpose -- it is the no-map default, not a texture of one colour.
 */
const PAINTERS: Record<Exclude<SkinId, 'solid'>, (px: Uint8ClampedArray, base: RGB) => void> = {
  stripes(px, base) {
    // Two pale racing bands along the hull's long axis (texture v).
    const light = lighten(base, 0.75);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const u = x / SIZE;
        const banded = (u > 0.3 && u < 0.42) || (u > 0.58 && u < 0.7);
        fill(px, (y * SIZE + x) * 4, banded ? light : base);
      }
    }
  },
  camo(px, base) {
    // Seeded blotches in two derived tones over the base.
    const dark = scale(base, 0.62);
    const deep = scale(base, 0.4);
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
  checker(px, base) {
    const dark = scale(base, 0.66);
    const cells = 8;
    const cell = SIZE / cells;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
        fill(px, (y * SIZE + x) * 4, on ? base : dark);
      }
    }
  },
  flow(px, base) {
    // Soft diagonal bands built on a sine, so the tile scrolls seamlessly -- this is
    // the ANIMATED one; its speed lives in the skin def (game/customization.ts).
    const light = lighten(base, 0.6);
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
 * solid default, which stays a plain material colour. Caller owns disposal.
 */
export function createSkinTexture(skin: SkinId, baseHex: string): THREE.DataTexture | null {
  if (skin === 'solid') return null;
  const px = new Uint8ClampedArray(SIZE * SIZE * 4);
  PAINTERS[skin](px, rgbOf(baseHex));
  const t = new THREE.DataTexture(px, SIZE, SIZE, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
