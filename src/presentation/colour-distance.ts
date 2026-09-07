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
 */

/** The arena ground, `0x2f6d4f` -- the surface owner rings are drawn onto. */
export const ARENA_FELT = 0x2f6d4f;

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

/** sRGB (IEC 61966-2-1) -> linear -> XYZ D65 -> CIE Lab, white point D65. */
function lab(colour: number): Rgb {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgbOf(colour).map(lin) as unknown as Rgb;
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
