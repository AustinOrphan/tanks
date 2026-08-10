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

export type RGB = [number, number, number];

function rgbOf(hex: string): RGB {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
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
 * MIN_ACCENT_DELTA's firing set below, so the two must be read together. The weights are
 * pinned by `skins.test.ts`'s firing-set test, and by nothing else: until that test was
 * written a 709 -> 601 swap left the whole suite passing (82 files passed, 1 skipped;
 * 1535 tests). `skins.test.ts` also keeps its OWN Rec. 601 luma for `toneStats`, which
 * measures rendered pixel bytes rather than re-running this function -- useful, but it
 * is NOT what catches a weight change.
 */
export function luma(c: RGB): number {
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
export const MIN_ACCENT_DELTA = 43;

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
export function ensureContrast(base: RGB, accent: RGB, delta = MIN_ACCENT_DELTA): RGB {
  const { h, s, l: startL } = rgbToHsl(accent);
  let l = startL;
  let t = accent;
  const towardBlack = luma(base) > 127;
  const STEP = 0.05;
  for (let i = 0; i < 20 && Math.abs(luma(base) - luma(t)) < delta; i++) {
    l = towardBlack ? Math.max(0, l - STEP) : Math.min(1, l + STEP);
    t = hslToRgb(h, s, l);
    // Pinned at a pole: no further move exists, so stop rather than spin the remaining
    // iterations. MEASURED UNREACHABLE at the shipped MIN_ACCENT_DELTA: instrumenting
    // this line with a counter and sweeping 909,792 (hull, accent) pairs -- 52 base
    // lightnesses x 3 hue families x 5,832 accents on a 15-step RGB grid (18 values a
    // channel, 18^3) -- hits it 0
    // times. The same probe hits it 34,835 times at MIN_ACCENT_DELTA 127 and 483,695
    // times at 200, which is what proves the counter was wired rather than dead -- the
    // boundary between 43 and 127 was not bisected, so all that is claimed here is
    // "unreachable at 43, reachable by 127", not a threshold. So this is
    // a guard against RETUNING, not against the shipped palette: raise the threshold
    // past what a pole can deliver and accents start arriving here achromatic, losing
    // the chosen hue. `skins.test.ts` asserts that unreachability directly.
    if (l === 0 || l === 1) break;
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
 * How far an `auto` accent is pushed from the hull, in luma.
 *
 * FEEL, chosen by rendering the candidates on the real tank -- but the CONSISTENCY it
 * buys is not a matter of taste. Every skin used to derive its own second tone with its
 * own formula and its own magnitude: stripes `lighten(base, 0.75)`, flow
 * `lighten(base, 0.6)`, checker `scale(base, 0.66)`, camo `scale(base, 0.62)`. Two went
 * lighter and two went darker, so the same hull changed character skin to skin -- and
 * measured across the 24 shipped (hull, skin) pairs the tone spread ran from 11.4 to
 * 141.6, a 12x range.
 *
 * Worse, `lighten` toward white is a no-op ON white: the shipped white hull measured
 * 14.3 spread on stripes and 11.4 on flow, against 33.6-141.6 for every other pair.
 * After the change the four single-accent skins land in 68.5-75.4 -- a 1.10x range, not
 * the 1.9x an earlier draft quoted; 1.85x is the spread across all 30 pairs INCLUDING
 * clouds, which is deliberately far louder. Both figures are Rec. 709, this file's own
 * luma; measured in the Rec. 601 that skins.test.ts's `toneStats` uses, the worst is
 * 64.3 rather than 68.5, which is the margin the visibility floor of 50 actually has.
 * Both were invisible on the tank -- a featureless white blob, confirmed by screenshot.
 * A fixed delta with the direction chosen by the hull cannot do that, because it moves
 * AWAY from whichever pole the hull sits near.
 */
export const AUTO_ACCENT_DELTA = 64;

/**
 * The second tone for an `auto` pick: the hull's own colour, pushed `delta` in luma
 * away from whichever pole it is nearest.
 *
 * This is `ensureContrast` with the accent seeded to the base itself, which is exactly
 * the right primitive -- it already moves ONLY lightness (so the hull's hue and
 * saturation survive, and a blue tank gets a lighter blue rather than a grey) and it
 * already picks its direction from the hull's own luma. Sharing it is what makes the
 * `auto` path and the explicit-accent path behave the same way instead of drifting.
 */
function autoAccent(base: RGB, delta = AUTO_ACCENT_DELTA): RGB {
  return stepLightness(base, delta, luma(base) <= 127);
}

/**
 * The twin racing stripes, in texture units -- which are WORLD units, because every
 * surface they land on is mapped at one texture repeat per unit.
 *
 * TWO stripes straddling the centreline, not one: Austin asked for a single stripe
 * first, then for two once he saw it on the tank. They sit at +/- CENTRE from the
 * centreline and are 2 x HALF wide each, so together they lay down about the same ink
 * the single stripe did (0.168 of the hull's 0.875 width) but read as a pair.
 *
 * `entities.ts` normalises the turret and barrel to the hull's half-width when it
 * projects them, so the pair stays that same FRACTION of each part rather than a
 * constant width -- at constant width they would have swallowed the barrel, which is
 * only 0.26 across.
 */
const STRIPE_CENTRE_V = 0.105;
const STRIPE_HALF_V = 0.042;

/**
 * Step `base`'s lightness in a CHOSEN direction until it clears `delta` in luma.
 *
 * The direction is the parameter, because two callers want different policies from the
 * same walk: `autoAccent` wants whichever direction has room (maximum visibility), and
 * `cloudTone` wants UP wherever up will do (a cloud is light).
 */
function stepLightness(base: RGB, delta: number, up: boolean): RGB {
  const { h, s, l: startL } = rgbToHsl(base);
  let l = startL;
  let t = base;
  for (let i = 0; i < 20 && Math.abs(luma(base) - luma(t)) < delta; i++) {
    l = up ? Math.min(1, l + 0.05) : Math.max(0, l - 0.05);
    t = hslToRgb(h, s, l);
    if (l === 0 || l === 1) break;
  }
  return t;
}

/**
 * A cloud tone: like `autoAccent`, but it goes UP unless up cannot deliver the contrast.
 *
 * `autoAccent` moves away from whichever pole the hull is nearest, which is right for a
 * marking whose only job is to be seen. Clouds is a skin with an IDENTITY, and on a
 * light hull "away from the pole" means down -- at the 1.8x delta clouds uses, that put
 * the dominant tone at luma 23 on the orange hull and 29 on the green: near-black
 * blotches on a skin called Clouds. Three of the six shipped hulls darkened, but only
 * those TWO were near-black -- white's dominant sat at 112 against a 236 hull, a mid
 * grey, and white darkening is the behaviour this function deliberately keeps. So the
 * fix moves 2 of 30 textures, not 3. Every test it had asked about contrast, and
 * contrast was fine, so nothing objected.
 *
 * Lightening is preferred and only refused when the headroom to white is too small to
 * clear AUTO_ACCENT_DELTA at all -- which for the shipped palette is the white hull
 * alone (19 luma of headroom). There, darkening is right anyway: grey cloud on a white
 * sky is still cloud. A first attempt used a lightness FLOOR instead and was wrong in a
 * way worth recording: flooring keeps the tone out of the black, but on orange it left
 * only 29.7 of spread and tripped this file's own visibility guard.
 */
function cloudTone(base: RGB, delta: number): RGB {
  const headroom = 255 - luma(base);
  return stepLightness(base, delta, headroom >= AUTO_ACCENT_DELTA);
}

/**
 * WHY CAMO AND CLOUDS NO LONGER SHARE A GENERATOR -- and why only ONE of them moved.
 *
 * They used to share `blotches`, differing only in count, radius and lobe count. That is
 * why Austin kept reporting them as swapped. Coverage WAS wrong and swapping it helped --
 * he confirmed the dense/sparse split is now the right way round -- but it could never be
 * enough on its own, because two skins cut from one silhouette generator read as each
 * other at different densities. His verdict after the swap: "Clouds turret top could be
 * made to look a bit more cloudlike in shape. Same with some spots on the hull. Camo also
 * could use some shape-improvement on the hull."
 *
 * CAMO got a new generator and KEPT it. `camoCells` is a seeded power diagram: hard-edged
 * interlocking polygons, straight edges meeting at corners, no arcs anywhere, which a
 * circle-based generator cannot produce at any parameter setting.
 *
 * CLOUDS got one too and it was REJECTED ON LOOK. `cumulus` drew soft-edged bulbous puffs
 * with a ramped rim; shown the pair, Austin said "before clouds looks better actually".
 * So clouds is back on `blotches` at the sparse post-swap setting -- exactly the texture
 * he was comparing against, which is `tiles/A-current.png`'s bottom row and the BEFORE
 * panel of `compare/swap-*-clouds.png`. `cumulus` is DELETED rather than parked behind a
 * switch, because a generator nothing calls rots. If a later reader thinks "clouds should
 * be puffier": it was built, rendered and rejected -- see PR #139.
 *
 * The two shape languages still differ, and the surviving difference is the one the eye
 * names first: camo is straight-edged polygons that PARTITION the tile, clouds is a union
 * of circular lobes over a field that stays visible between them. Both tile seamlessly
 * (every distance below wraps toroidally) and both are deterministic from a fixed seed.
 * Neither touches its tone derivation: camo stays muted via `autoAccent` and clouds stays
 * light via `cloudTone`.
 */

/** Toroidal component distance -- the tile's left edge is adjacent to its right. */
function wrapDelta(a: number, b: number): number {
  const d = Math.abs(a - b);
  return d > SIZE / 2 ? SIZE - d : d;
}

/**
 * CAMO: a seeded power diagram (an additively weighted Voronoi partition).
 *
 * Scatter `points` feature sites, give each a weight and one of the three tones, then
 * colour every pixel by whichever site wins `d^2 - weight`. That yields cells with
 * STRAIGHT edges meeting at corners -- subtracting a per-site constant moves a boundary
 * without bending it, which is exactly what a power diagram buys over the multiplicative
 * kind, whose bisectors are circular arcs and would have put the arcs straight back.
 *
 * Two properties make it read as camouflage rather than as a mosaic. Adjacent sites
 * drawn the same tone MERGE, so the visible patches are unions of several cells and are
 * irregular in size and outline rather than one-cell-one-blob. And the weights vary the
 * cell areas, so nothing reads as a regular grid.
 *
 * Coverage is a consequence here, not a parameter: each site independently draws a tone,
 * so the base's share is the probability it is drawn, up to sampling noise over
 * `points` cells. That is why the shares below are close to but not exactly the split.
 */
function camoCells(
  px: Uint8ClampedArray,
  base: RGB,
  dark: RGB,
  deep: RGB,
  points: number,
  baseShare: number,
  darkShare: number,
): void {
  const rnd = xorshift(0xc4310);
  const fx: number[] = [];
  const fy: number[] = [];
  const fw: number[] = [];
  const tone: RGB[] = [];
  for (let i = 0; i < points; i++) {
    fx.push(rnd() * SIZE);
    fy.push(rnd() * SIZE);
    // Weight spread as a fraction of a typical cell's squared radius, so it perturbs
    // boundaries noticeably without letting one site swallow its neighbours.
    fw.push((rnd() * 2 - 1) * (SIZE * SIZE) / (points * 14));
    const r = rnd();
    tone.push(r < baseShare ? base : r < baseShare + darkShare ? dark : deep);
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let best = Infinity;
      let winner = 0;
      for (let i = 0; i < points; i++) {
        const dx = wrapDelta(x, fx[i]);
        const dy = wrapDelta(y, fy[i]);
        const d = dx * dx + dy * dy - fw[i];
        if (d < best) {
          best = d;
          winner = i;
        }
      }
      fill(px, (y * SIZE + x) * 4, tone[winner]);
    }
  }
}

/**
 * CLOUDS: a seamless field of round blotches in two tones over a base.
 *
 * CLOUDS ONLY, now. Camo shared this until the shape split above, and the sharing is what
 * made the two skins read as versions of each other -- so nothing else may call it again
 * without re-opening that.
 *
 * The tones are painted in order, so the second buries the first wherever they overlap.
 * At the sparse setting clouds ships -- 7 blotches, radius 8-15, 5 lobes -- the base
 * survives on 57.8% of the texture with 22.3% and 19.9% for the two tones, identical on
 * all 6 shipped hulls because the geometry is seeded and carries no colour dependence at
 * all. The dense setting camo used to take (13, radius 9-18, 4 lobes) left the base on
 * 27.9%; it has no caller now.
 */
function blotches(
  px: Uint8ClampedArray,
  base: RGB,
  first: RGB,
  second: RGB,
  count: number,
  rMin: number,
  rMax: number,
  lobes: number,
): void {
  for (let i = 0; i < SIZE * SIZE * 4; i += 4) fill(px, i, base);
  const rnd = xorshift(0xc4310);
  for (const tone of [first, second]) {
    for (let b = 0; b < count; b++) {
      const cx = rnd() * SIZE;
      const cy = rnd() * SIZE;
      const r = rMin + rnd() * (rMax - rMin);
      // Each patch is a CLUSTER of overlapping circles rather than one circle. A single
      // circle per patch reads as polka dots -- Austin's "camo still doesn't look camo"
      // -- because real camouflage is irregular and interlocking. Overlapping lobes cost
      // nothing and are what turn a dot into a blob.
      for (let lobe = 0; lobe < lobes; lobe++) {
        const ox = cx + (rnd() * 2 - 1) * r * 0.8;
        const oy = cy + (rnd() * 2 - 1) * r * 0.8;
        const lr = r * (0.45 + rnd() * 0.55);
        for (let y = Math.floor(oy - lr); y < oy + lr; y++) {
          for (let x = Math.floor(ox - lr); x < ox + lr; x++) {
            if ((x - ox) ** 2 + (y - oy) ** 2 > lr * lr) continue;
            // Wrap so patches crossing an edge tile seamlessly.
            const wx = ((x % SIZE) + SIZE) % SIZE;
            const wy = ((y % SIZE) + SIZE) % SIZE;
            fill(px, (wy * SIZE + wx) * 4, tone);
          }
        }
      }
    }
  }
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
    // TWIN racing stripes straddling the centreline, running the length of the tank.
    //
    // Banded on v, NOT u, and that is the whole fix for the direction: the hull is an
    // ExtrudeGeometry whose cap UVs are the shape's own (x, y) = (LENGTH, width), so a
    // band at constant u is a band at constant length -- a belt running ACROSS the tank,
    // perpendicular to the treads. Banding on v instead holds the width constant and
    // runs the full length, which is parallel to the treads. `entities.ts` projects the
    // turret and barrel with their across-axis on v too, so the same stripe continues up
    // over the turret and out along the barrel.
    //
    // The tank's centreline is v = 0, which RepeatWrapping puts on the tile's EDGE, so
    // the stripe straddles the seam and both halves have to be measured.
    const light = accent ? ensureContrast(base, accent) : autoAccent(base);
    for (let y = 0; y < SIZE; y++) {
      const v = y / SIZE;
      // Signed distance from the centreline, which sits at v = 0 -- the tile's EDGE
      // under RepeatWrapping, so the far half of the texture is really the near half on
      // the other side of the tank.
      const d = Math.abs(v > 0.5 ? v - 1 : v);
      const banded = Math.abs(d - STRIPE_CENTRE_V) < STRIPE_HALF_V;
      for (let x = 0; x < SIZE; x++) fill(px, (y * SIZE + x) * 4, banded ? light : base);
    }
  },
  camo(px, base, accent) {
    // Seeded blotches in two tones over the base. Auto derives both from the base, as
    // before; an explicit accent supplies the first and the second is a scaled step off
    // THAT (not off the base), so "black camo" reads as two shades of near-black blotch
    // rather than pulling a totally unrelated tone from the hull.
    // Camo takes a SMALLER step than the other skins, and that is deliberate rather
    // than an inconsistency: its blotches cover most of the surface, where a stripe
    // covers a tenth of it, and a large area needs far less contrast to read. Given the
    // full delta the blue tank came back reading as SNOW camo -- the blotches won and
    // the hull colour stopped being the tank's colour. Both tones stay on the same side
    // of the hull so camo is a family of one paint, not a clash.
    const dark = accent ? ensureContrast(base, accent) : autoAccent(base, AUTO_ACCENT_DELTA * 0.5);
    const deep = accent ? scale(dark, 0.7) : autoAccent(base, AUTO_ACCENT_DELTA * 0.95);
    // DENSE and interlocking, in HARD-EDGED polygons -- see camoCells. The hull survives
    // on a minority of the surface, which is what camouflage does and what the sparse
    // arrangement this skin used to carry could not.
    //
    // 44 cells over a 128px tile is about 19px across each before the same-tone merging
    // that makes the visible patches bigger; the shares are tuned so the base stays the
    // minority without either accent tone dominating. (This comment said 22 while the
    // call already passed 44 -- the count was doubled mid-tuning, see tiles/C-camo44.png,
    // and only the literal moved.)
    camoCells(px, base, dark, deep, 44, 0.3, 0.37);
  },
  clouds(px, base, accent) {
    // A blotch field taken to the FULL accent delta and beyond. Camo holds its tones
    // close to the hull so the paint still reads as the tank's colour; clouds
    // deliberately does not, and its tones go light -- a blue tank reads as blue sky with
    // white cloud rather than as a blue tank with markings.
    //
    // The TONES are what carry that, not the coverage. Since the density swap the hull
    // is the majority tone here (57.8%), which is correct for sky: the cloud is the
    // thing on top of it, not the field itself. An earlier version of this comment said
    // "the light tone wins", which was true only while clouds held the dense setting.
    //
    // It exists because the unified accent work briefly gave camo these deltas by
    // accident, and the result was better as its own thing than as a broken camo.
    const soft = accent ? ensureContrast(base, accent) : cloudTone(base, AUTO_ACCENT_DELTA);
    const bright = accent ? scale(soft, 0.7) : cloudTone(base, AUTO_ACCENT_DELTA * 1.8);
    // SPARSE and separated -- these were camo's numbers before the swap; see `blotches`.
    // Fewer, smaller puffs on a hull that stays visible between them is what reads as
    // sky, and it is the light tones above rather than the density that make them clouds.
    //
    // A SOFT-EDGED replacement (`cumulus`) was built for this call and rejected on look:
    // "before clouds looks better actually". These are the parameters that render is of.
    blotches(px, base, soft, bright, 7, 8, 15, 5);
  },
  checker(px, base, accent) {
    const dark = accent ? ensureContrast(base, accent) : autoAccent(base);
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
    const light = accent ? ensureContrast(base, accent) : autoAccent(base);
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

// ---------------------------------------------------------------------------
// How a skin tile is SAMPLED. Named constants rather than literals at the call site
// so `npm run gallery --sweep SKIN_MIN_FILTER,SKIN_MIPMAPS` can render the candidates
// side by side, which is how the values below were picked.
//
// A skin is a `DataTexture`, and that class defaults `magFilter`/`minFilter` to
// `NearestFilter` and `generateMipmaps` to `false` (three 0.169.0,
// `src/textures/DataTexture.js:6,14`). Those defaults were INHERITED here, never
// chosen -- which matters because a 128px tile maps to a whole UV face of a ~1-unit
// hull with no `repeat`, so at play distance it is minified several-fold.
// ---------------------------------------------------------------------------

/**
 * MINIFICATION -- changed from the inherited default, on a comparison.
 *
 * At play distance the whole 128px tile lands on a tank about 30 screen pixels wide
 * (measured: `npm run gallery -- --scene game --w 640 --h 480`, arena-01, the player's
 * hull spans ~30 of 640), so roughly 4 texels fall in every pixel. Point-sampling one
 * of them is the textbook recipe for aliasing, and it shows: rendering the same tank at
 * the same texel density (`--elements tank --view game --w 72 --h 54`) with `checker`,
 * the two settings differ at **33.2 dB PSNR**, and the difference is exactly where the
 * theory says -- the turret dome, where the UV is compressed hardest, breaks into
 * irregular high-contrast wedges without mipmaps and reads as an even pattern with
 * them. `flow`, a soft gradient tile, differs by only 43.0 dB.
 *
 * STATED AS MEASURED: those are STILLS. Shimmer is a temporal artefact and no still can
 * show it; what was measured is the spatial aliasing that causes it.
 */
const SKIN_MIN_FILTER = THREE.LinearMipmapLinearFilter;

/**
 * MAGNIFICATION -- deliberately LEFT at `DataTexture`'s default, which is not the same
 * as inheriting it.
 *
 * The largest a skin is ever drawn is the Customize preview, and even there the tile is
 * barely magnified: 128 texels over a hull about 400 device pixels across. Swept at the
 * preview's real device-pixel size, nearest vs linear differ by **60.7 dB PSNR** on
 * `flow` and **51.2 dB** on `checker` -- i.e. not visibly. With nothing to gain,
 * `NearestFilter` keeps `checker`'s and `stripes`' edges exactly as authored.
 */
const SKIN_MAG_FILTER = THREE.NearestFilter;

/**
 * Required by `SKIN_MIN_FILTER`: a mipmap minification filter with no mipmaps to sample
 * is an INCOMPLETE texture, which samples black. The two constants must move together,
 * and `skins.test.ts` asserts that coupling rather than the literals alone.
 *
 * Cost: 4/3 of the texture's 64 kB, once per style change, plus one `glGenerateMipmap`
 * on a 128x128 image -- against the per-frame texture-matrix upload three already does
 * for every mapped material.
 */
const SKIN_MIPMAPS = true;

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
  t.minFilter = SKIN_MIN_FILTER;
  t.magFilter = SKIN_MAG_FILTER;
  t.generateMipmaps = SKIN_MIPMAPS;
  t.needsUpdate = true;
  return t;
}
