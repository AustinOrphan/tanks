import * as THREE from 'three';

/**
 * Procedurally generated surface detail.
 *
 * Every material in this game is flat untextured colour, which means the lighting has
 * nothing to bite on: a wall face is one value from edge to edge no matter how many
 * lights point at it. NORMAL maps are the fix rather than colour maps -- what is missing
 * is not variation in albedo, it is variation in the surface response, and that is what
 * makes a box read as concrete instead of a filled polygon.
 *
 * Generated at runtime rather than shipped, matching the audio: no binary assets, a few
 * kB of code, and every parameter visible and tunable instead of baked into a PNG.
 *
 * DETERMINISTIC. The generator is seeded, so two runs produce identical textures -- which
 * the screenshot-based visual gate depends on, and which a Math.random() fill would have
 * quietly broken.
 */
export interface TextureSet {
  /** Fibre grain for the felt. */
  feltNormal: THREE.Texture;
  /** Aggregate speckle for solid walls. */
  concreteNormal: THREE.Texture;
  /** Plank grooves for destructible walls. */
  timberNormal: THREE.Texture;
  dispose(): void;
}

const SIZE = 256;

/** xorshift32. Small, fast, and repeatable -- the point is determinism, not quality. */
function rng(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

/** Smoothed value noise at one frequency, as a height field in [0,1]. */
function valueNoise(size: number, cells: number, seed: number): Float32Array {
  const rand = rng(seed);
  const grid = new Float32Array((cells + 1) * (cells + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const out = new Float32Array(size * size);
  const step = size / cells;
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = Math.floor(x / step);
      const gy = Math.floor(y / step);
      const fx = smooth((x - gx * step) / step);
      const fy = smooth((y - gy * step) / step);
      // Wrap on the cell grid, so the finished texture tiles without a seam.
      const i00 = (gy % cells) * (cells + 1) + (gx % cells);
      const i10 = (gy % cells) * (cells + 1) + ((gx + 1) % cells);
      const i01 = ((gy + 1) % cells) * (cells + 1) + (gx % cells);
      const i11 = ((gy + 1) % cells) * (cells + 1) + ((gx + 1) % cells);
      const top = grid[i00] + (grid[i10] - grid[i00]) * fx;
      const bot = grid[i01] + (grid[i11] - grid[i01]) * fx;
      out[y * size + x] = top + (bot - top) * fy;
    }
  }
  return out;
}

/** Sum several octaves of value noise, each finer and weaker than the last. */
function fbm(size: number, baseCells: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const layer = valueNoise(size, baseCells * 2 ** o, seed + o * 7919);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp;
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/**
 * Convert a height field to a tangent-space normal map.
 *
 * Central differences on the height, packed into RGB the way three expects: +x in red,
 * +y in green, and blue held near full because the surface mostly faces the viewer.
 */
function normalFromHeight(height: Float32Array, size: number, strength: number): Uint8ClampedArray<ArrayBuffer> {
  const px = new Uint8ClampedArray(new ArrayBuffer(size * size * 4));
  const at = (x: number, y: number): number => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // Normalise (-dx, -dy, 1) and map from [-1,1] into [0,255].
      const len = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      px[o + 0] = ((-dx / len) * 0.5 + 0.5) * 255;
      px[o + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      px[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      px[o + 3] = 255;
    }
  }
  return px;
}

function makeTexture(px: Uint8ClampedArray<ArrayBuffer>, repeat: number): THREE.DataTexture {
  const t = new THREE.DataTexture(px, SIZE, SIZE, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  // Generated maps are linear data, not colour. Tagging them sRGB would wash the
  // normals out and bend every lit surface the wrong way.
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Height field with horizontal grooves at plank spacing, plus grain along them. */
function timberHeight(): Float32Array {
  const grain = fbm(SIZE, 4, 3, 31337);
  const out = new Float32Array(SIZE * SIZE);
  const PLANKS = 4;
  const period = SIZE / PLANKS;
  for (let y = 0; y < SIZE; y++) {
    // Distance to the nearest plank seam, normalised: 0 in the groove, 1 mid-plank.
    const d = Math.min(y % period, period - (y % period)) / (period / 2);
    const groove = Math.min(1, d * 6); // sharp, narrow seams
    for (let x = 0; x < SIZE; x++) {
      // Grain stretched along the plank, so it reads as timber rather than noise.
      out[y * SIZE + x] = groove * 0.75 + grain[y * SIZE + ((x * 3) % SIZE)] * 0.25;
    }
  }
  return out;
}

/**
 * @param feltRepeat How many times the felt grain tiles across the arena. Passed in
 * because it depends on arena size, which this module has no business knowing.
 */
export function createTextures(feltRepeat: number): TextureSet {
  // Felt: fine, dense fibre. High frequency and low strength -- it should catch the light
  // at a grazing angle and be invisible head-on.
  const feltNormal = makeTexture(normalFromHeight(fbm(SIZE, 16, 3, 12345), SIZE, 2.2), feltRepeat);
  // Concrete: coarser aggregate, stronger relief.
  const concreteNormal = makeTexture(normalFromHeight(fbm(SIZE, 8, 4, 24680), SIZE, 4.0), 2);
  // Timber: directional grooves, strongest of the three, because the plank seams are the
  // cue that says this wall is the one a shell can open.
  const timberNormal = makeTexture(normalFromHeight(timberHeight(), SIZE, 6.0), 1);

  return {
    feltNormal,
    concreteNormal,
    timberNormal,
    dispose(): void {
      feltNormal.dispose();
      concreteNormal.dispose();
      timberNormal.dispose();
    },
  };
}
