// `uvdiff.mjs` produces the PR's turret-unchanged numbers, and "0 differing pixels" is
// only worth something if the comparator can report NON-zero. These are the negative
// controls for that: each case would pass vacuously against a comparator that always
// returned zero, except that its partner in the same test does not.
import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain .mjs, and nothing under tools/ is typechecked.
import { compare, heatMap } from './uvdiff.mjs';

const W = 8;
const H = 4;

function frame(fill: [number, number, number]): Uint8Array {
  const b = new Uint8Array(W * H * 4);
  for (let i = 0; i < b.length; i += 4) {
    b[i] = fill[0];
    b[i + 1] = fill[1];
    b[i + 2] = fill[2];
    b[i + 3] = 255;
  }
  return b;
}

describe('uvdiff compare', () => {
  it('reports zero for identical frames, and non-zero the moment one pixel moves', () => {
    const a = frame([10, 20, 30]);
    const b = frame([10, 20, 30]);
    expect(compare(a, b, W, H).differing).toBe(0);
    expect(compare(a, b, W, H).bbox).toBeNull();

    // One channel, one pixel, off by one -- the smallest visible difference there is.
    b[(2 * W + 5) * 4 + 1] = 21;
    const r = compare(a, b, W, H);
    expect(r.differing).toBe(1);
    expect(r.bbox).toEqual({ minX: 5, minY: 2, maxX: 5, maxY: 2 });
    expect(r.total).toBe(32);
  });

  it('ignores alpha, because these frames are opaque and an alpha-only change is invisible', () => {
    const a = frame([10, 20, 30]);
    const b = frame([10, 20, 30]);
    b[3] = 7;
    expect(compare(a, b, W, H).differing).toBe(0);
  });

  it('sums absolute channel difference inside a rect, and sees only inside it', () => {
    const a = frame([10, 20, 30]);
    const b = frame([10, 20, 30]);
    b[(1 * W + 1) * 4] = 15; // +5, inside the rect below
    b[(3 * W + 7) * 4] = 40; // +30, outside it
    const r = compare(a, b, W, H, [0, 0, 4, 2]);
    expect(r.differing).toBe(2); // the whole-frame count still sees both
    expect(r.rect.pixels).toBe(1);
    expect(r.rect.bytes).toBe(5);
    expect(r.rect.coords).toEqual([[1, 1]]);
  });

  it('draws a heat map whose marks land where the differences are', () => {
    const a = frame([0, 0, 0]);
    const b = frame([0, 0, 0]);
    for (let x = 0; x < W; x++) b[(0 * W + x) * 4] = 255; // whole top row
    const rows = heatMap(a, b, W, H, 8, 4);
    expect(rows[0]).toBe('--------');
    expect(rows[1]).toBe('........');
    expect(rows[3]).toBe('........');
  });
});
