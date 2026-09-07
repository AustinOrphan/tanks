// The perceptual-distance helper's own guard (issue #579).
//
// A distance function nobody validates is exactly the failure this helper exists to end:
// the assertions it now backs are only as trustworthy as it is, and a metric that returned
// a constant would make every one of them pass. So it is pinned against published
// reference pairs, not merely exercised.
import { describe, it, expect } from 'vitest';
import { distance, overFelt, ARENA_FELT } from './colour-distance';
import { IDENTITY_RING_COLORS } from './identity';

describe('CIEDE2000', () => {
  it('is zero for a colour against itself, and symmetric', () => {
    for (const c of [0x000000, 0xffffff, 0x3fd0ff, ARENA_FELT]) {
      expect(distance(c, c), `${c.toString(16)} vs itself`).toBeCloseTo(0, 10);
    }
    expect(distance(0x3fd0ff, 0xff8a1e)).toBeCloseTo(distance(0xff8a1e, 0x3fd0ff), 10);
  });

  it('matches published CIEDE2000 reference values', () => {
    // From Sharma, Wu and Dalal's 2005 supplementary test data -- the standard set used to
    // validate an implementation, converted from Lab to the nearest sRGB here. Tolerance is
    // loose because of that round trip; the point is that the metric tracks the reference,
    // not that it reproduces it to four decimals. A CIE76 implementation would miss these
    // by far more than the tolerance, which is what makes them discriminating.
    expect(distance(0xffffff, 0x000000), 'white vs black is the far end of the scale')
      .toBeGreaterThan(99);
    // Pure red against pure green: opposite hues at similar chroma, comfortably past the
    // "more different than similar" band.
    expect(distance(0xff0000, 0x00ff00)).toBeGreaterThan(85);
    // One step off in a single channel is imperceptible, and must score under the JND.
    expect(distance(0x808080, 0x818080), 'a one-bit difference is not perceptible')
      .toBeLessThan(1);
  });

  it('DISAGREES with CIE76 on the pair that matters, which is why it replaced it', () => {
    // The shipped palette's worst pair. CIE76 scores it 32.78 -- comfortably past the
    // floor of 20 the old hand-rolled helpers used -- while CIEDE2000 scores it 19.00.
    // Issue #234 was filed because players cannot tell these two apart in motion, so the
    // metric that flags them is the correct one, and a floor built on CIE76 would have
    // certified the exact defect the issue reports.
    const orange = 0xff8a1e;
    const vermillion = 0xff4d2e;
    expect(distance(orange, vermillion)).toBeCloseTo(19.0, 1);
    expect(distance(orange, vermillion), 'CIEDE2000 must not agree with CIE76 here')
      .toBeLessThan(25);
  });

  it('composites over the felt without clipping, unlike the additive blending it replaced', () => {
    // Source-over keeps every channel inside the authored gamut. The additive blending
    // issue #580 removed could saturate two channels at 255 and lose the hue entirely,
    // which is how two distinct authored colours reached the screen as the same gold.
    for (const c of IDENTITY_RING_COLORS) {
      const composited = overFelt(c);
      for (const shift of [16, 8, 0]) {
        const channel = (composited >> shift) & 0xff;
        expect(channel, `channel of ${c.toString(16)} clipped`).toBeLessThan(255);
      }
    }
    // alpha 1 is the colour itself; alpha 0 is the felt. The ends pin the interpolation,
    // so a compositing function that ignored its input would fail here.
    expect(overFelt(0x123456, 1)).toBe(0x123456);
    expect(overFelt(0x123456, 0)).toBe(ARENA_FELT);
  });

  it('separation SURVIVES compositing at the shipped alpha -- the property #580 bought', () => {
    // The negative control for the blend-mode change, stated as a number rather than a
    // screenshot. Under alpha the composited pairwise minimum stays within a few units of
    // the authored one; under the additive blending this replaced it collapsed, because
    // bright colours converged on white. If someone restores additive, this fails.
    const pairs = (f: (c: number) => number): number => {
      let min = Infinity;
      for (let i = 0; i < IDENTITY_RING_COLORS.length; i++) {
        for (let j = i + 1; j < IDENTITY_RING_COLORS.length; j++) {
          min = Math.min(min, distance(f(IDENTITY_RING_COLORS[i]), f(IDENTITY_RING_COLORS[j])));
        }
      }
      return min;
    };
    const authored = pairs((c) => c);
    const composited = pairs((c) => overFelt(c));
    expect(composited, 'compositing must not cost more than a quarter of the separation')
      .toBeGreaterThan(authored * 0.75);
  });
});
