/**
 * Perceptual colour distance, for the assertions that guard owner identity (issue #579).
 *
 * WHY THIS EXISTS. Every colour guard in this repository compared hex values for
 * INEQUALITY -- `expect(team).not.toBe(ring)`. That proves nothing in either direction: it
 * passes for two colours a player cannot tell apart, and it would equally fail two that
 * are obviously different. Issue #234 says so directly: "Tests currently prove only that
 * configured colors are unequal, not that they are perceptually distinguishable."
 *
 * WHY IT LIVES HERE, against the letter of the presentation rule. That rule admits a
 * definition when game/HUD and render/audio both read it, and nothing in the running game
 * reads this -- it is test support. It sits here because its consumers span
 * `presentation/` (the customization palette) and `render/` (identity rings and team
 * colours), so neither is a better home, and because the thing it measures IS presentation
 * vocabulary. It imports nothing, so it adds no edge for `dependency-direction.test.ts` to
 * classify, and no production module imports it, so it is absent from the bundle.
 *
 * MEASURE IN THE SPACE THE PLAYER SEES. `distance` takes the colours as rendered. Where a
 * surface is composited before anyone sees it, composite first -- `overFelt` does that for
 * the arena ground. Comparing authored constants is how issue #580 stayed invisible: the
 * identity palette measured fine as authored while additive blending pushed two of its
 * four rings to the same gold on screen.
 *
 * Issue #1056 added `contrastRatio` and `simulateColourVision` for the owner palettes'
 * floors, and moved the two floors below here from `render/entities.test.ts`. OWNER_FLOOR is
 * read by both the presentation and the render tests, so both hold the palettes to one
 * definition; TEAM_FLOOR is read only by the render tests and sits beside it so the two
 * floors live in one place.
 */

/** The arena ground, `0x2f6d4f` -- the surface owner rings are drawn onto. */
export const ARENA_FELT = 0x2f6d4f;

/**
 * Floors, in CIEDE2000, measured as drawn rather than asserted from a standard. Figures are
 * from these helpers on 2026-10-10 (origin/main c200cf62 plus issue #1056), every owner
 * colour composited with `overFelt`, every hull opaque.
 *
 * OWNER_FLOOR 15: what an owner colour must clear against a tank it is drawn beside. Classic
 * rings clear the 7 roster kinds at 17.09 (ring0 vs teal) and the unstyled placeholder at
 * 19.41 (ring3); Classic teams clear the player hull at 33.36 (team B) and the placeholder at
 * 25.54 (team A). The floor sits below all four with room, and would have caught the 2.09
 * collision between the old blue team B and the player hull that motivated it (#579). The
 * High contrast palette is also held to it against the 6 hull paints; Classic is not, since
 * #586 tolerates its ring 1 sitting 1.17 from the orange paint.
 *
 * TEAM_FLOOR 25: teammates share a colour, so telling two SIDES apart matters more than
 * telling two slots apart, and the trio has more room to spend. Worst pairs: Classic 35.98
 * (A vs B), High contrast 31.52 (A vs C).
 *
 * Neither is a published threshold. A just-noticeable difference is about 1-2 and these are
 * moving objects at play distance, so the numbers are chosen from what the shipped palettes
 * actually achieve, with enough headroom that a real regression trips them and normal
 * palette work does not.
 */
export const OWNER_FLOOR = 15;
export const TEAM_FLOOR = 25;

type Rgb = readonly [number, number, number];

const rgbOf = (colour: number): Rgb => [(colour >> 16) & 0xff, (colour >> 8) & 0xff, colour & 0xff];

/**
 * A colour as composited over the felt at `alpha`, matching the identity ring's material
 * (`NormalBlending` at `IDENTITY_RING_OPACITY`, since issue #580 -- see
 * `makeIdentityRing`). Source-over, so the result stays inside the authored gamut: the
 * additive blending this replaced could clip a channel at 255 and lose the hue entirely.
 */
export function overFelt(colour: number, alpha = 0.85): number {
  const [r, g, b] = rgbOf(colour);
  const [fr, fg, fb] = rgbOf(ARENA_FELT);
  const mix = (c: number, f: number): number => Math.round(c * alpha + f * (1 - alpha));
  return (mix(r, fr) << 16) | (mix(g, fg) << 8) | mix(b, fb);
}

/** One 8-bit sRGB channel to linear light in [0, 1], per IEC 61966-2-1. */
function toLinear(c8: number): number {
  const v = c8 / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** The inverse: linear light, clamped to [0, 1], back to the nearest 8-bit sRGB channel. */
function toSrgb8(linear: number): number {
  const v = Math.min(1, Math.max(0, linear));
  return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
}

/** sRGB (IEC 61966-2-1) -> linear -> XYZ D65 -> CIE Lab, white point D65. */
function lab(colour: number): Rgb {
  const [r, g, b] = rgbOf(colour).map((c) => toLinear(c)) as unknown as Rgb;
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * CIEDE2000, kL = kC = kH = 1.
 *
 * NOT CIE76, which the two hand-rolled helpers this replaces both used, and the difference
 * decides real cases: the identity palette's worst pair scores 32.78 under CIE76 and 19.00
 * under CIEDE2000. A floor built on CIE76 would have passed the very palette issue #234
 * was filed about. CIE76 overstates distance in exactly the saturated warm region this
 * game's identity colours occupy, which is the region that matters here.
 */
export function distance(a: number, b: number): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const hue = (ap: number, bp: number): number =>
    ap === 0 && bp === 0 ? 0 : ((Math.atan2(bp, ap) * 180) / Math.PI + 360) % 360;
  const h1 = hue(a1p, b1);
  const h2 = hue(a2p, b2);

  const dLp = l2 - l1;
  const dCp = c2p - c1p;
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2 - h1;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(rad(dhp) / 2);

  const lBar = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBar = h1 + h2;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1 - h2) <= 180) hBar = (h1 + h2) / 2;
    else hBar = h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos(rad(hBar - 30)) +
    0.24 * Math.cos(rad(2 * hBar)) +
    0.32 * Math.cos(rad(3 * hBar + 6)) -
    0.2 * Math.cos(rad(4 * hBar - 63));
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const rC = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sC = 1 + 0.045 * cBarP;
  const sH = 1 + 0.015 * cBarP * t;
  const rT = -Math.sin(rad(2 * dTheta)) * rC;

  return Math.sqrt(
    (dLp / sL) ** 2 +
      (dCp / sC) ** 2 +
      (dHp / sH) ** 2 +
      rT * (dCp / sC) * (dHp / sH),
  );
}

/**
 * WCAG 2.x contrast ratio, `(L1 + 0.05) / (L2 + 0.05)` over relative luminance, lighter
 * colour on top: 1 for a colour against itself, 21 for black against white, and the same
 * either way round. A distance in CIEDE2000 can be large between two colours of equal
 * lightness; this measures the lightness step alone, which colour-vision deficiencies change
 * far less than hue -- less, not never: a simulated deficiency can still lower it. Issue
 * #1056 holds the High contrast palette to 3:1 against the felt in normal vision, the WCAG
 * floor for non-text graphics.
 *
 * WCAG's own text gives the linearisation threshold as 0.03928, not IEC's 0.04045. On 8-bit
 * input the two agree everywhere -- 10/255 sits below both and 11/255 above both -- so this
 * shares `lab`'s conversion rather than carrying a second one.
 */
export function contrastRatio(a: number, b: number): number {
  const luminance = (colour: number): number => {
    const [r, g, b2] = rgbOf(colour).map((c) => toLinear(c));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The three dichromacies `simulateColourVision` models, each at full severity. */
export const COLOUR_VISIONS = ['protan', 'deutan', 'tritan'] as const;
export type ColourVision = (typeof COLOUR_VISIONS)[number];

/**
 * Machado, Oliveira and Fernandes (2009), "A Physiologically-based Model for Simulation of
 * Color Vision Deficiency", severity 1.0: one 3x3 matrix per type, applied to LINEAR sRGB.
 * Rows produce linear R, G and B. Every row sums to 1 (to six decimals), which is why a
 * neutral grey comes back unchanged -- the property the known-value test leans on.
 */
const MACHADO_2009: Readonly<Record<ColourVision, readonly [Rgb, Rgb, Rgb]>> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/**
 * A colour as a reader with `vision` sees it: sRGB to linear, the Machado matrix, clamp to
 * [0, 1], back to sRGB, rounded to 8 bits. Compose it with the other helpers in the order a
 * player meets them -- composite first (`overFelt`), then simulate, then measure -- because
 * the eye receives the composited colour, not the authored one.
 */
export function simulateColourVision(colour: number, vision: ColourVision): number {
  const [r, g, b] = rgbOf(colour).map((c) => toLinear(c));
  const [r2, g2, b2] = MACHADO_2009[vision].map(([kr, kg, kb]) => toSrgb8(kr * r + kg * g + kb * b));
  return (r2 << 16) | (g2 << 8) | b2;
}
