import { describe, it, expect } from 'vitest';
import {
  ANGLE_HASH,
  computeAngleBands,
  computeAngleHash,
  hashFloat64s,
} from './angles';

/**
 * The Node/V8 half of the angle probe -- see angles.ts's header for the full argument
 * (why the sweep exists, why sqrt is a control, why the generator never calls an
 * approximated Math function). This file's job, same split as trace.test.ts:
 *
 *   1. the fingerprint still equals ANGLE_HASH -- proves only THIS engine is self-stable,
 *      run to run;
 *   2. the sweep actually covers every declared band, so the pin has the population it
 *      claims;
 *   3. a single flipped bit in one sample changes the hash -- the negative control that
 *      proves hashFloat64s is measuring bits, not silently collapsing them;
 *   4. swapping the order of two samples changes the hash -- proves the hash is over the
 *      SEQUENCE, which is what the per-band rollup (a fixed-order concatenation) depends on.
 *
 * The cross-engine question -- whether chromium, firefox and webkit agree on ANGLE_HASH --
 * is answered only by the browser wiring (tools/baseline/run.mjs, page.html), not here.
 */

describe('angle probe', () => {
  it('fingerprint matches the pinned V8 hash', async () => {
    const hash = await computeAngleHash();
    console.log(`ANGLE ${hash}`);
    expect(hash).toBe(ANGLE_HASH);
  });

  it('covers sin/cos on all 5 reachability bands, plus atan2, hypot and sqrt', async () => {
    const bands = await computeAngleBands();
    const names = bands.map((b) => b.name);
    for (const rung of ['2pi', '1e2', '1e4', '1e6', '1e8']) {
      expect(names).toContain(`sin:${rung}`);
      expect(names).toContain(`cos:${rung}`);
    }
    expect(names).toContain('atan2');
    expect(names).toContain('hypot');
    expect(names).toContain('sqrt');
    // Every declared band actually ran, not an early return's population.
    for (const b of bands) expect(b.count).toBeGreaterThan(0);
    // States the denominator: 5 bands x 2 functions (sin, cos), each with thousands of
    // samples (3000 generic + 500 breakpoint-clustered, per angles.ts), plus the three
    // combinatorial/decade groups.
    expect(bands.length).toBe(5 * 2 + 3);
    const sinCosCounts = bands.filter((b) => b.name.startsWith('sin:') || b.name.startsWith('cos:'));
    for (const b of sinCosCounts) expect(b.count).toBe(3500);
  });

  it('is sensitive to a single low-bit perturbation in one sample (negative control)', async () => {
    // If hashFloat64s ever lost precision -- e.g. by round-tripping through a formatted
    // string, or by hashing only a summary statistic -- this would fail to change, which
    // is exactly the failure mode a bit-identical cross-engine probe cannot afford.
    const values = [1.5, -2.25, 3.75, Math.PI, 1e100, Number.MIN_VALUE, 0, -0, Infinity];
    const original = await hashFloat64s(values);

    const mutated = [...values];
    const buf = new Float64Array([mutated[2]]);
    const view = new DataView(buf.buffer);
    view.setUint32(0, view.getUint32(0, true) ^ 1, true); // flip the least-significant bit
    mutated[2] = new Float64Array(buf.buffer)[0];

    const perturbed = await hashFloat64s(mutated);
    expect(perturbed).not.toBe(original);
    expect(mutated[2]).not.toBe(values[2]); // the perturbation itself actually landed
  });

  it('is sensitive to ORDER, not just to the multiset of values', async () => {
    // Would fail under a mutation that hashed an order-independent summary (a sum, an XOR
    // of the bytes) instead of the sequence -- which would also silently break the
    // per-band rollup above, since that concatenates bands in a fixed order.
    const values = [1, 2, 3, 4, 5];
    const reordered = [2, 1, 3, 4, 5];
    const forward = await hashFloat64s(values);
    const swapped = await hashFloat64s(reordered);
    expect(swapped).not.toBe(forward);
  });
});
