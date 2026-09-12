import { describe, it, expect } from 'vitest';
import {
  ANGLE_HASH,
  classifyAngleFingerprint,
  computeAngleBands,
  computeAngleHash,
  formatAngleBands,
  hashFloat64s,
  VERIFIED_ANGLE_ARCHITECTURES,
  VENDORED_ANGLE_HASH,
  computeVendoredAngleBands,
  computeVendoredAngleHash,
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
  it('fingerprint matches the pinned V8 hash on a VERIFIED architecture (issue #484)', async () => {
    // ARCHITECTURE-AWARE since issue #484, on the owner's ruling: enforce a native-V8 golden
    // only where that exact fingerprint has been deliberately verified. `ANGLE_HASH` was
    // measured across three Node/V8 builds, all x86-64. On macOS arm64 the same sweep is
    // stable and DIFFERENT, so the pin was permanently red there -- which does not surface a
    // regression, it hides one: every `verify:quick` needed manual dismissal, and a real
    // break in the sweep or the hashing would have looked exactly like the expected failure.
    //
    // The vendored probe below stays a hard assertion everywhere, and that is the point of
    // the pair: src/sim/math is built only from operations ECMA-262 specifies exactly, so
    // bit-identical output is a construction guarantee rather than a hope. Native `Math.*`
    // never promised that. Weakening the native pin on an unverified architecture costs
    // nothing the deterministic path was relying on.
    const bands = await computeAngleBands();
    const hash = await computeAngleHash(bands);
    const verdict = classifyAngleFingerprint(process.arch, hash);
    console.log(`ANGLE ${hash} (${process.arch}, ${verdict.kind})`);

    if (verdict.kind === 'unverified') {
      // Report, do not fail. Per-band output so the divergence can be localised to a
      // function and a range rather than appearing as one rolled-up hash -- which is what
      // #484 had to reconstruct by hand before this existed.
      console.log(
        `no verified golden for ${process.arch}; x86-64 golden is ${ANGLE_HASH}\n` +
          `per-band fingerprints:\n${formatAngleBands(bands)}`,
      );
      // Still asserted, weakly but not vacuously: the probe RAN and produced a full-width
      // digest. An unverified architecture must not become a branch where nothing is checked.
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      return;
    }

    // Verified architecture: the pin is hard, exactly as before. Per-band lines on failure,
    // so the first question after a red run -- which function, which range -- is answered by
    // the output rather than by a second debugging session.
    if (verdict.kind === 'verified-mismatch') console.log(`per-band fingerprints:\n${formatAngleBands(bands)}`);
    expect(verdict.kind, `native V8 fingerprint moved on ${process.arch}`).toBe('verified-match');
    expect(hash).toBe(ANGLE_HASH);
  });

  it('does not treat an unverified architecture as a verified pass', () => {
    // THE BRANCH THIS MACHINE CANNOT REACH. `process.arch` is whatever the box is -- x64
    // here -- so the arm64 path is unreachable by running the suite, and the policy is
    // exercised with synthetic pairs instead. Without this case, #484's fix would be one
    // typo away from silently accepting any hash on every architecture.
    expect(VERIFIED_ANGLE_ARCHITECTURES).toContain('x64');
    expect(VERIFIED_ANGLE_ARCHITECTURES, 'an arm64 golden was added without a ruling').not.toContain(
      'arm64',
    );

    // A verified architecture still fails on a real divergence.
    expect(classifyAngleFingerprint('x64', ANGLE_HASH).kind).toBe('verified-match');
    expect(classifyAngleFingerprint('x64', 'deadbeef').kind).toBe('verified-mismatch');

    // An unverified one reports rather than fails -- and, deliberately, does so even when
    // the hash HAPPENS to match: one coincidental sample is not the repeated verified
    // measurement the ruling requires before an architecture joins the list.
    expect(classifyAngleFingerprint('arm64', 'deadbeef').kind).toBe('unverified');
    expect(classifyAngleFingerprint('arm64', ANGLE_HASH).kind).toBe('unverified');
    // ...which is the assertion that stops `unverified` being read as `verified-match`.
    expect(classifyAngleFingerprint('arm64', ANGLE_HASH).kind).not.toBe('verified-match');
  });

  it('reports every band when a fingerprint has to be explained', async () => {
    // The per-band output is a product, not a debug aid: #484 had to paste a hand-built
    // table of thirteen sub-hashes into the issue because nothing printed them. A format
    // that silently dropped bands would leave the next reader doing the same.
    const bands = await computeAngleBands();
    const text = formatAngleBands(bands);
    const lines = text.split('\n');
    expect(lines.length).toBe(bands.length);
    for (const b of bands) {
      expect(text, `${b.name} missing from the per-band report`).toContain(b.name);
      expect(text, `${b.name}'s hash missing`).toContain(b.hash);
    }
    // Non-vacuity: thirteen bands, the same population the coverage case above pins.
    expect(bands.length).toBe(13);
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

/**
 * The vendored half (issue #133): src/sim/math's detSin/detCos/detAtan2/detHypot over
 * the SAME sweep the native bands use. Unlike ANGLE_HASH, this pin is not merely "this
 * engine is self-stable" -- the vendored functions are built only from ECMA-262's
 * exactly-specified operations (+ - * / %, Math.sqrt/abs/trunc/floor/max, DataView bit
 * access), so bit-identical output on every conformant engine is a construction
 * guarantee. tools/baseline/run.mjs is where that guarantee is actually checked across
 * chromium/firefox/webkit; this file only proves Node computes the pinned value.
 */
describe('vendored angle probe (issue #133)', () => {
  it('fingerprint matches the pinned vendored-math hash', async () => {
    const hash = await computeVendoredAngleHash();
    console.log(`VENDORED_ANGLE ${hash}`);
    expect(hash).toBe(VENDORED_ANGLE_HASH);
  });

  it('covers vsin/vcos on all 5 reachability bands, plus vatan2 and vhypot -- no vsqrt', async () => {
    const bands = await computeVendoredAngleBands();
    const names = bands.map((b) => b.name);
    for (const rung of ['2pi', '1e2', '1e4', '1e6', '1e8']) {
      expect(names).toContain(`vsin:${rung}`);
      expect(names).toContain(`vcos:${rung}`);
    }
    expect(names).toContain('vatan2');
    expect(names).toContain('vhypot');
    expect(names).not.toContain('vsqrt'); // Math.sqrt stays native -- out of #133's scope.
    for (const b of bands) expect(b.count).toBeGreaterThan(0);
    // 5 bands x 2 functions (vsin, vcos), plus vatan2 and vhypot -- one fewer group than
    // the native list's 5*2+3, since there is no vsqrt.
    expect(bands.length).toBe(5 * 2 + 2);
  });

  it('the same inputs the native sweep uses: vsin/vcos/vatan2/vhypot sample counts match', async () => {
    // sin/cos/atan2/hypot's own counts exactly -- proving the vendored groups reuse
    // bandSamples/atan2Samples/hypotPairs rather than a re-derived approximation of them.
    const [native, vendored] = await Promise.all([computeAngleBands(), computeVendoredAngleBands()]);
    const nativeByName = new Map(native.map((b) => [b.name, b.count]));
    for (const b of vendored) {
      const nativeName = b.name.replace(/^v/, '');
      expect(b.count).toBe(nativeByName.get(nativeName));
    }
  });
});
