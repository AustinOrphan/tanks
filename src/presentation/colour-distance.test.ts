// The perceptual-distance helper's own guard (issue #579).
//
// A distance function nobody validates is exactly the failure this helper exists to end:
// the assertions it now backs are only as trustworthy as it is, and a metric that returned
// a constant would make every one of them pass. So it is pinned against published
// reference pairs, not merely exercised.
import { describe, it, expect } from 'vitest';
import {
  distance, overFelt, ARENA_FELT, contrastRatio, simulateColourVision, COLOUR_VISIONS,
} from './colour-distance';
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

// Issue #1056's two helpers, each pinned to values that follow from its definition rather
// than read back from this implementation: a guard built on an unvalidated metric certifies
// whatever the metric says, which is why the CIEDE2000 block above exists.
describe('WCAG contrast ratio', () => {
  it('is 21 for black against white, 1 for a colour against itself, and the same either way round', () => {
    // Both ends follow from the definition: (1 + 0.05) / (0 + 0.05) = 21, and equal
    // luminances give 1. Dropping the 0.05 flare term sends black/white to Infinity; taking
    // the smaller luminance over the larger gives 1/21.
    expect(contrastRatio(0x000000, 0xffffff)).toBeCloseTo(21, 10);
    expect(contrastRatio(0xffffff, 0x000000), 'order does not matter').toBeCloseTo(21, 10);
    for (const c of [0x000000, 0xffffff, 0x3fd0ff, ARENA_FELT]) {
      expect(contrastRatio(c, c), `${c.toString(16)} vs itself`).toBeCloseTo(1, 10);
    }
    // A mid-scale reference, where the linearisation matters: #777777 on white is the grey
    // WebAIM's checker reports as 4.47:1 (it truncates), just under the 4.5 text floor.
    expect(contrastRatio(0x777777, 0xffffff)).toBeCloseTo(4.478, 3);
  });
});

describe('colour-vision simulation (Machado 2009, severity 1)', () => {
  it('leaves every neutral grey unchanged under all three types, within one level', () => {
    // Every matrix row sums to 1, so a grey maps to itself; a mistyped coefficient breaks the
    // sum and tints the greys. Population: all 256 greys x 3 types; measured deviation 0. The
    // identity function passes this too, which is why the two tests below exist.
    let checked = 0;
    for (let g = 0; g < 256; g++) {
      const grey = (g << 16) | (g << 8) | g;
      for (const vision of COLOUR_VISIONS) {
        const seen = simulateColourVision(grey, vision);
        for (const shift of [16, 8, 0]) {
          expect(Math.abs(((seen >> shift) & 0xff) - g), `grey ${g} under ${vision}`)
            .toBeLessThanOrEqual(1);
        }
        checked += 1;
      }
    }
    expect(checked, '256 greys x 3 types').toBe(768);
  });

  it('collapses a red and a green that normal vision separates by far more than 20, under deutan', () => {
    // The paint shop's own Red and Green swatches: 67.61 apart in normal vision and 6.75 under
    // deutan. Protan (24.47) and tritan (65.14) keep them apart, so a simulation that returned
    // its input, or ran another type's matrix for deutan, fails the second check.
    const red = 0xd64545;
    const green = 0x4fae52;
    expect(distance(red, green), 'normal vision separates them').toBeGreaterThan(20);
    const deutan = distance(simulateColourVision(red, 'deutan'), simulateColourVision(green, 'deutan'));
    expect(deutan, 'deutan collapses them').toBeLessThan(10);
  });

  it('pins one colour under each type, so a swapped matrix or a skipped linearisation fails', () => {
    // Each type gives #d64545 a different answer, so exchanging any two matrices fails two of
    // these lines. Applying the matrix to the sRGB values directly, without linearising, reads
    // #7a6e43 for deutan; applying it transposed reads #8ccf00.
    expect(simulateColourVision(0xd64545, 'protan').toString(16)).toBe('6d6544');
    expect(simulateColourVision(0xd64545, 'deutan').toString(16)).toBe('918441');
    expect(simulateColourVision(0xd64545, 'tritan').toString(16)).toBe('eb1c47');
  });

  it('clamps a channel the matrix pushes outside [0, 1]', () => {
    // Protan's first row takes pure green to 1.053 linear, and deutan's third row takes pure
    // red below zero. Unclamped, the first overflows its byte into the next channel and the
    // second goes negative; neither result is a colour.
    expect(simulateColourVision(0x00ff00, 'protan').toString(16)).toBe('ffe500');
    expect(simulateColourVision(0xff0000, 'deutan').toString(16)).toBe('a39000');
  });
});
