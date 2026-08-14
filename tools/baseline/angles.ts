/**
 * A cross-engine determinism probe for the LARGE-MAGNITUDE half of src/sim's transcendental
 * calls -- the regime issue #133's own gate names as untested. #133 stays closed only while
 * chromium/firefox/webkit agree on the golden trace (tools/baseline/trace.ts,
 * BASELINE_HASH), but that trace runs 2500 ticks per (arena, seed) and, MEASURED on this
 * checkout by instrumenting every tank's bodyAngle/turretAngle across all 5 arenas x 6
 * seeds x 2500 ticks, never carries either angle past 5.81 rad / 5.19 rad respectively
 * (measured maxima: 5.803198681858546 / 5.182415957339267, each rounded UP to 2dp so the
 * stated bound is not itself understated) -- inside the FIRST reachability rung this file
 * defines (+/-2*PI = 6.28), nowhere near the 1e2..1e8 bands below. So a clean golden-trace
 * hash is not evidence about large arguments; this file measures that regime directly, in
 * its own file with its OWN pinned hash, and leaves BASELINE_HASH untouched.
 *
 * WHY the large-magnitude regime is reachable at all, even though the golden trace never
 * finds it (grep-verified on this checkout, file:line):
 *
 *   - src/sim/types.ts:210-223 `slewAngle(current, target, maxDelta)` nudges `current`
 *     toward `target` by at most `maxDelta` per call (types.ts:222,
 *     `return current + Math.sign(delta) * maxDelta;`). The nudge direction and the
 *     "shortest arc" `delta` (types.ts:218-220) are both computed mod 2*PI, but the
 *     RETURNED value is not -- `current` itself is never wrapped back into any bounded
 *     range. Contrast `angleDelta` (types.ts:202-208), which canonicalises its own return
 *     value into (-PI, PI] and is used only for the target-relative comparison, never for
 *     the angle that persists tick to tick.
 *   - `slewAngle` is the only PER-TICK writer of both accumulators: bodyAngle at
 *     src/sim/collision.ts:420 (`tank.bodyAngle = slewAngle(tank.bodyAngle, aim, ...)`),
 *     and turretAngle at src/sim/world.ts:158 (player) and src/sim/ai/index.ts:87 (AI).
 *     The one other writer in src/sim is `resetArena` (world.ts:235-236), which assigns
 *     both fields directly from the spawn table -- but it runs only when the player dies
 *     with lives remaining, so it bounds the accumulation per LIFE, not per tick, and a
 *     life in which the player never dies accumulates without limit. Nothing anywhere
 *     reduces either field mod 2*PI. A player who circles the aim reticle repeatedly in
 *     one rotational sense keeps adding to `turretAngle` every such lap; the same holds
 *     for a hull driven in tight circles.
 *   - Both accumulators feed transcendental calls directly, on the very next line in one
 *     case: src/sim/collision.ts:422, `Math.cos(tank.bodyAngle)` / `Math.sin(tank.bodyAngle)`,
 *     immediately after the unwrapped assignment at line 420. turretAngle reaches the same
 *     pair one call deeper: `fromAngle(tank.turretAngle)` (called at src/sim/bullets.ts:59,
 *     with turretAngle passed in at src/sim/world.ts:167 and src/sim/ai/index.ts:124) does
 *     `Math.cos(r)` / `Math.sin(r)` at src/sim/types.ts:177.
 *
 * So "the sim never normalises angles" is not a vague description -- it is one function
 * (`slewAngle`) that every writer of these two fields goes through, verified to never wrap
 * its own return value, feeding two call sites that hand the raw accumulator straight to
 * Math.cos/Math.sin. A long play session (or an autoplay demo, or a lockstep replay run for
 * hours) can drive either field arbitrarily far from zero; this file asks what chromium,
 * firefox and webkit do with the results once it has.
 *
 * WHAT #133 says is actually at risk. ECMA-262 leaves `sin`, `cos`, `atan2` and `hypot`
 * "implementation-approximated" (fdlibm recommended, not required) -- issue #133's own
 * function-occurrence table (`gh issue view 133`) is what fixes the function list this file
 * sweeps: hypot (10 occurrences), sqrt (4), sin (3), cos (3), atan2 (1), 21 total on 18
 * lines. `Math.sqrt` is the one exception: ES2024 specified it as implementation-
 * approximated too, but ES2025 and later specify it as "the square root of the mathematical
 * value, correctly rounded" -- so it is EXPECTED to agree on every ES2025+ engine, and is
 * swept here as a CONTROL. If the sqrt band ever disagrees, that is not a finding about
 * range reduction; it means this harness (or an engine's ES2025 conformance) is broken, and
 * should be treated as a bug report against the probe before anything else.
 *
 * DETERMINISTIC SAMPLE GENERATION. Every generator below is built only from `+ - * / %`,
 * integer/decimal literals, and the spec-fixed constants `Math.PI`, `Number.MIN_VALUE`,
 * `Number.MAX_VALUE`. Those are all EXACTLY specified by ECMA-262: `+ - * / %` on Number
 * values round per IEEE 754-2008 (round-to-nearest, ties-to-even) -- a mandated rounding,
 * not an approximated one, so two conformant engines given the same operands produce
 * bit-identical results regardless of whether the true mathematical value happens to be
 * exactly representable. `Math.PI` and the `Number.*` limits are specified VALUES, not the
 * output of an approximated FUNCTION call. No generator here calls `Math.pow`, `Math.exp`,
 * `Math.log`, `Math.random`, or `Date` -- an approximated function (Math.pow chief among
 * them) used to SPREAD the samples would let a divergence in the GENERATOR masquerade as a
 * divergence in the function under test. NO Math.random, NO Date anywhere in this file:
 * every sample is a pure function of an integer index, so the sweep is exactly reproducible
 * run to run and engine to engine, which is what lets a hash mismatch mean anything.
 *
 * HASHING RAW BITS, NOT DECIMAL STRINGS. Each group's outputs are written into a
 * Float64Array, viewed as a Uint8Array, and hashed with Web Crypto -- never formatted with
 * `toFixed`/`toString` first. That is deliberate: even though modern ECMA-262 fully
 * specifies Number::toString, going through decimal text would round-trip the very bits
 * this file exists to compare through an extra, unrelated layer, and would silently lose
 * information if two distinct doubles ever happened to format the same way at whatever
 * precision was chosen. Hashing the IEEE 754 bit pattern directly has neither risk. Group
 * sub-hashes are then rolled into one final hash by hashing a fixed-format ASCII string of
 * `name:count:hexhash` triples -- that text is never a formatted float, only hex digits and
 * decimal counts, so it carries none of the same risk.
 *
 * `crypto.subtle` (not `node:crypto`) and `TextEncoder`, exactly as tools/baseline/trace.ts
 * uses them -- see that module's header for why: both are present in Node 20+ and in every
 * browser, and `crypto.subtle` requires a SECURE CONTEXT (localhost or https), which
 * tools/baseline/run.mjs and page.html already account for.
 *
 * THE SPLIT, same discipline as trace.ts's own header: `angles.test.ts` pins
 * `computeAngleHash() === ANGLE_HASH` under whatever V8 the test runner has -- that proves
 * only that THIS engine is self-stable, run to run, on this sweep. It says nothing about
 * any other engine BY ITSELF, but see "MEASURED" below: this is not merely asserted, it is
 * checked -- ANGLE_HASH was verified equal, run to run, across three real Node/V8 builds
 * (20.19.0/V8 11.3, 22.13.0/V8 12.4, 24.15.0/V8 13.6 -- the exact 20.19.0 and a 22.x close
 * to the CI matrix's floating '22', plus the box's own Node), so the pin CI's `npm test`
 * runs under (Node 20.19.0 and 22 per ci.yml's matrix) is not merely convenient on one
 * machine. The cross-engine-FAMILY question -- whether chromium, firefox and webkit agree
 * on THIS hash -- is a separate question, answered only by running this sweep in each of
 * them, which the browser wiring below does; that is where this file's real divergence
 * lives, not between Node versions. Unlike BASELINE_HASH, ANGLE_HASH is NOT wired into
 * tools/baseline/run.mjs's exit code for a browser mismatch -- see that file's comment at
 * the angle-probe reporting block for why: this pin is not a validated cross-engine-FAMILY
 * invariant the way BASELINE_HASH is, and gating CI on it would make a required, deploy-
 * gating step permanently red over a finding rather than a regression.
 *
 * MEASURED (2026-08-12, this checkout, Playwright on Linux x86-64, `npm run trace:browser
 * -- --all`): chromium 151.0.7922.34, firefox 153.0 and Playwright's webkit (JavaScriptCore,
 * UA-spoofed as macOS Safari but a Linux build) produce THREE DISTINCT angle hashes, none
 * equal to ANGLE_HASH (Node's d5d81535...): chromium 6fb1a390..., firefox 01c09fbb...,
 * webkit 702a88b5... (see the commit that introduced this file for all four hashes in
 * full). Per-band bisection (rolled into ANGLE_HASH, so this cost nothing extra) shows the
 * divergence is not confined to the large-magnitude bands this file was built to reach:
 * sin and cos disagree pairwise across all three browser engines on EVERY reachability
 * band, including the smallest (+/-2*PI, the same order of magnitude the golden trace
 * itself already samples). atan2 disagrees too, with a partial pairing verified at the
 * FULL 64-hex-digit hash, not the runner's truncated print: chromium and webkit's atan2
 * sub-hashes are identical, and firefox's atan2 sub-hash is identical to Node's (ANGLE_HASH's
 * own atan2 sub-hash) -- reported as measured pairings over this one ~3000-sample sweep,
 * not as a claim about WHY (this file has no evidence for a mechanism, only the equality).
 * hypot disagrees across all three browser engines, though Node and chromium's hypot
 * sub-hashes are identical (also full-hash verified). sqrt -- the control -- agreed across
 * all four (Node, chromium, firefox, webkit alike; absent from the run's DIVERGES list),
 * which is what makes the rest of this paragraph a measurement of sin/cos/atan2/hypot
 * rather than a broken harness: the one function ES2025 promises will agree, did.
 */
import { detSin, detCos, detAtan2 } from '../../src/sim/math/trig';
import { detHypot } from '../../src/sim/math/hypot';

// ---- Deterministic, exact-arithmetic sample generation --------------------------------

/** Milu (355/113): a rational approximation of pi, accurate to 6 decimal digits but not
 *  equal to it. Used only as a SPREADING constant (multiplied against an integer index),
 *  so index-derived samples land near, but essentially never exactly on, the pi/2
 *  multiples where range reduction is most sensitive -- without the harness ever having to
 *  special-case a collision, since 355/113 != pi. */
const MILU_NUM = 355;
const MILU_DEN = 113;

/** 1/64 is exactly representable in binary64 (a dyadic fraction), so multiplying by it
 *  never introduces its own rounding on top of the (still deterministic) rounding the
 *  later `/ MILU_DEN` step performs. */
const DYADIC_STEP = 1 / 64;

/**
 * Maps an integer index to a quasi-uniform value in [-1, 1). Built from a rational
 * (Weyl-sequence-style) rotation, not a pseudo-random generator -- there is no seed and no
 * Math.random, only `* + %` on Number values, which ECMA-262 rounds identically on every
 * conformant engine. Two disjoint index ranges (this function is called at `i` and, in
 * breakpointBandSamples, also at `i + 1_000_000`) are used where two independent-looking
 * values are needed from one index, so nothing here ever needs a second generator.
 */
function unit(i: number): number {
  const t = ((i * DYADIC_STEP * MILU_NUM) / MILU_DEN) % 2;
  return t - 1;
}

/** A mantissa in [1, 10), for scaling a decade literal without ever calling Math.pow. */
function mantissa(i: number): number {
  return 1 + (unit(i) + 1) * 4.5;
}

export interface Band {
  name: string;
  max: number;
}

/**
 * The reachability ladder: within +/-2*PI is the largest magnitude the golden trace itself
 * ever measures (see the header), and +/-1e2 .. +/-1e8 extend past it into territory a long
 * session can reach but no existing test does. Exported (along with bandSamples,
 * atan2Samples and hypotPairs below) so issue #133's vendored-math port can run the
 * identical input sweep against src/sim/math's detSin/detCos/detAtan2/detHypot -- both
 * the one-time Node-native bit-compare (see that PR body) and computeVendoredAngleBands
 * below need the SAME samples the native bands use, not a re-derived approximation of them.
 */
export const REACHABILITY_BANDS: Band[] = [
  { name: '2pi', max: 2 * Math.PI },
  { name: '1e2', max: 1e2 },
  { name: '1e4', max: 1e4 },
  { name: '1e6', max: 1e6 },
  { name: '1e8', max: 1e8 },
];

const GENERIC_SAMPLES_PER_BAND = 3000;
const BREAKPOINT_SAMPLES_PER_BAND = 500;

/** Samples spread quasi-uniformly across [-max, max]. */
function genericBandSamples(max: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < GENERIC_SAMPLES_PER_BAND; i++) out.push(unit(i) * max);
  return out;
}

/**
 * Samples clustered near integer multiples of PI/2 -- the internal breakpoints of any
 * range-reduction algorithm, and the likeliest place two implementations of the same
 * function part company: fdlibm's Payne-Hanek reduction avoids catastrophic cancellation
 * there, but only fdlibm-derived engines are guaranteed to. `Math.PI`, `Math.trunc`,
 * `Math.abs` and `Math.max` are all spec-fixed values or exact (non-approximated)
 * operations -- see the module header -- so using them here to CONSTRUCT inputs carries
 * none of the risk that using Math.pow or Math.sin would.
 */
function breakpointBandSamples(max: number): number[] {
  const halfPi = Math.PI / 2;
  const maxMultiple = max / halfPi;
  const out: number[] = [];
  for (let i = 0; i < BREAKPOINT_SAMPLES_PER_BAND; i++) {
    const k = Math.trunc(unit(i) * maxMultiple);
    // Jitter scaled by |k| so it stays meaningful relative to k*halfPi's own magnitude at
    // the top of a band -- a fixed absolute jitter would be swamped by float spacing there.
    const jitter = unit(i + 1_000_000) * 1e-3 * Math.max(1, Math.abs(k));
    out.push(k * halfPi + jitter);
  }
  return out;
}

export function bandSamples(band: Band): number[] {
  return [...genericBandSamples(band.max), ...breakpointBandSamples(band.max)];
}

/** Decade literals spanning denormal-adjacent to near-overflow. Every entry is either a
 *  decimal literal (exact per the spec's StringNumericLiteral -> Number conversion) or
 *  Number.MIN_VALUE/MAX_VALUE divided by a small integer (exact: dividing a double by a
 *  power of two only decrements its exponent, no rounding). None of this is Math.pow. */
const MAGNITUDE_DECADES = [
  Number.MIN_VALUE, // smallest denormal, ~4.94e-324
  Number.MIN_VALUE * 1024, // still denormal
  2.2250738585072014e-308, // smallest NORMAL double (DBL_MIN) -- the denormal boundary
  1e-300, 1e-200, 1e-100, 1e-50, 1e-20, 1e-10, 1e-5, 1e-2,
  1, 1e2, 1e5, 1e10, 1e20, 1e50, 1e100, 1e200, 1e300,
  Number.MAX_VALUE / 4, Number.MAX_VALUE / 2, // near-overflow: hypot(x,y) must scale
  // internally rather than compute x*x + y*y directly, which overflows before sqrt runs.
];

const ATAN2_RATIO_SAMPLES = 3000;

/**
 * atan2 over quadrant/axis/edge combinations and magnitude ratios. `ATAN2_EDGE_CASES` is a
 * finite, hand-picked list (signed zeros, axis-aligned points, and magnitude-extreme
 * pairs); the ratio sweep below spans MAGNITUDE_DECADES with an index-varied mantissa,
 * rotated through all four quadrants and both axis orientations (ratio-as-y and
 * ratio-as-x) by index parity.
 */
const ATAN2_EDGE_CASES: Array<[number, number]> = [
  [0, 0], [0, -0], [-0, 0], [-0, -0],
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [Number.MIN_VALUE, Number.MIN_VALUE], [Number.MIN_VALUE, -Number.MIN_VALUE],
  [-Number.MIN_VALUE, Number.MIN_VALUE], [-Number.MIN_VALUE, -Number.MIN_VALUE],
  [Number.MAX_VALUE, Number.MAX_VALUE], [Number.MAX_VALUE, -Number.MAX_VALUE],
  [Infinity, Infinity], [Infinity, -Infinity], [-Infinity, Infinity], [-Infinity, -Infinity],
  [Infinity, 0], [0, Infinity], [1, Infinity], [Infinity, 1],
  [Number.MIN_VALUE, 1], [1, Number.MIN_VALUE], [Number.MAX_VALUE, 1], [1, Number.MAX_VALUE],
];

function atan2RatioPairs(): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const n = MAGNITUDE_DECADES.length;
  for (let i = 0; i < ATAN2_RATIO_SAMPLES; i++) {
    const ratio = MAGNITUDE_DECADES[i % n] * mantissa(i);
    const signY = (i & 1) === 0 ? 1 : -1;
    const signX = (i & 2) === 0 ? 1 : -1;
    if ((i & 4) === 0) pairs.push([signY * ratio, signX * 1]);
    else pairs.push([signY * 1, signX * ratio]);
  }
  return pairs;
}

export function atan2Samples(): Array<[number, number]> {
  return [...ATAN2_EDGE_CASES, ...atan2RatioPairs()];
}

const HYPOT_PAIR_SAMPLES = 2000;

/** hypot over pairs spanning many decades, including denormal-adjacent and near-overflow
 *  scaling (MAGNITUDE_DECADES covers both ends). Disjoint index offsets (i vs i+500_000)
 *  for the two mantissas keep them from moving in lockstep. */
export function hypotPairs(): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const n = MAGNITUDE_DECADES.length;
  for (let i = 0; i < HYPOT_PAIR_SAMPLES; i++) {
    const da = MAGNITUDE_DECADES[i % n];
    const db = MAGNITUDE_DECADES[Math.floor(i / n) % n];
    const signA = (i & 1) === 0 ? 1 : -1;
    const signB = (i & 2) === 0 ? 1 : -1;
    pairs.push([signA * da * mantissa(i), signB * db * mantissa(i + 500_000)]);
  }
  return pairs;
}

const SQRT_SAMPLES = 2000;

/** sqrt's CONTROL band: the same magnitude decades as hypot, always non-negative (a
 *  negative input would return NaN, and NaN's payload bits are not something this probe
 *  wants to depend on -- see the module header's note on why sqrt is the control). */
function sqrtInputs(): number[] {
  const out: number[] = [];
  const n = MAGNITUDE_DECADES.length;
  for (let i = 0; i < SQRT_SAMPLES; i++) out.push(MAGNITUDE_DECADES[i % n] * mantissa(i));
  return out;
}

// ---- Groups, hashing, and the public API -----------------------------------------------

interface AngleGroup {
  name: string;
  compute: () => number[];
}

function buildGroups(): AngleGroup[] {
  const groups: AngleGroup[] = [];
  for (const band of REACHABILITY_BANDS) {
    const inputs = bandSamples(band);
    groups.push({ name: `sin:${band.name}`, compute: () => inputs.map((x) => Math.sin(x)) });
    groups.push({ name: `cos:${band.name}`, compute: () => inputs.map((x) => Math.cos(x)) });
  }
  groups.push({
    name: 'atan2',
    compute: () => atan2Samples().map(([y, x]) => Math.atan2(y, x)),
  });
  groups.push({ name: 'hypot', compute: () => hypotPairs().map(([a, b]) => Math.hypot(a, b)) });
  groups.push({ name: 'sqrt', compute: () => sqrtInputs().map((x) => Math.sqrt(x)) });
  return groups;
}

/**
 * The vendored half of the same sweep (issue #133): the EXACT SAME input generators
 * (bandSamples, atan2Samples, hypotPairs -- imported below, never re-derived), fed to
 * src/sim/math's detSin/detCos/detAtan2/detHypot instead of the engine's native
 * Math.*. No `vsqrt` group -- Math.sqrt is left native (ES2025 correctly-rounded, out
 * of #133's scope), so there is nothing vendored to sweep.
 *
 * This is a SEPARATE group list from buildGroups' native one, not a parameterised
 * variant of it: the native list's names (`sin:2pi`, `atan2`, ...) feed the pinned
 * ANGLE_HASH, and changing what those names mean would move that pin for a reason
 * having nothing to do with a native-engine finding. `v`-prefixed names keep the two
 * rollups from ever colliding.
 */
function buildVendoredGroups(): AngleGroup[] {
  const groups: AngleGroup[] = [];
  for (const band of REACHABILITY_BANDS) {
    const inputs = bandSamples(band);
    groups.push({ name: `vsin:${band.name}`, compute: () => inputs.map((x) => detSin(x)) });
    groups.push({ name: `vcos:${band.name}`, compute: () => inputs.map((x) => detCos(x)) });
  }
  groups.push({
    name: 'vatan2',
    compute: () => atan2Samples().map(([y, x]) => detAtan2(y, x)),
  });
  groups.push({ name: 'vhypot', compute: () => hypotPairs().map(([a, b]) => detHypot(a, b)) });
  return groups;
}

/** SHA-256 of the values' exact IEEE 754 bit patterns, serialised LITTLE-ENDIAN
 *  explicitly (DataView, not typed-array buffer aliasing, whose byte order follows the
 *  host CPU) -- so the hash is a function of the float64 bits alone and the pinned
 *  ANGLE_HASH stays comparable if this ever runs on a big-endian host. Every
 *  measurement to date ran on little-endian x86-64, where the two serialisations
 *  coincide, so this choice preserves the pinned value. Exported so angles.test.ts can
 *  prove the hash is sensitive to a single bit -- the negative control the module
 *  header promises. */
export async function hashFloat64s(values: readonly number[]): Promise<string> {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat64(i * 8, values[i], true);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface AngleBandResult {
  name: string;
  count: number;
  hash: string;
}

/** Runs every group and returns its own sub-hash, so a mismatch localises to a function and
 *  a reachability band (or atan2/hypot/sqrt's own sweep) instead of one opaque number. */
export async function computeAngleBands(): Promise<AngleBandResult[]> {
  const results: AngleBandResult[] = [];
  for (const g of buildGroups()) {
    const values = g.compute();
    results.push({ name: g.name, count: values.length, hash: await hashFloat64s(values) });
  }
  return results;
}

/** The fingerprint: one hash over every group's own sub-hash, in a fixed order. Pass an
 *  already-computed `bands` to avoid re-running the sweep when both the per-band and the
 *  rolled-up result are wanted (computeAngleBands is the expensive half). */
export async function computeAngleHash(bands?: AngleBandResult[]): Promise<string> {
  const b = bands ?? (await computeAngleBands());
  const rollup = b.map((x) => `${x.name}:${x.count}:${x.hash}`).join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rollup));
  return Array.from(new Uint8Array(digest), (b2) => b2.toString(16).padStart(2, '0')).join('');
}

/**
 * The pinned V8 value. angles.test.ts asserts computeAngleHash() === ANGLE_HASH -- V8
 * self-stability only, same split as BASELINE_HASH in trace.ts. Measured on this checkout;
 * see angles.test.ts and the commit that introduced this file for the browser-run result
 * (chromium/firefox/webkit agreement or divergence), which this constant does not encode.
 */
export const ANGLE_HASH = 'd5d81535dc54cfae47ae7bc6db940544182454f2d5788c59b48ce663697351ec';

/** The vendored mirror of computeAngleBands: src/sim/math's detSin/detCos/detAtan2/
 *  detHypot over the identical sample sweep, not Math.*. */
export async function computeVendoredAngleBands(): Promise<AngleBandResult[]> {
  const results: AngleBandResult[] = [];
  for (const g of buildVendoredGroups()) {
    const values = g.compute();
    results.push({ name: g.name, count: values.length, hash: await hashFloat64s(values) });
  }
  return results;
}

/** The vendored mirror of computeAngleHash. */
export async function computeVendoredAngleHash(bands?: AngleBandResult[]): Promise<string> {
  const b = bands ?? (await computeVendoredAngleBands());
  const rollup = b.map((x) => `${x.name}:${x.count}:${x.hash}`).join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rollup));
  return Array.from(new Uint8Array(digest), (b2) => b2.toString(16).padStart(2, '0')).join('');
}

/**
 * The vendored-math fingerprint, pinned. CRITICAL DIFFERENCE from ANGLE_HASH: this one
 * is asserted equal ACROSS ENGINES (chromium/firefox/webkit), not merely self-stable on
 * one -- see tools/baseline/run.mjs, which wires a mismatch here into its exit code,
 * unlike the native ANGLE_HASH block. src/sim/math's port is built only from
 * `+ - * / %`, `Math.sqrt`/`abs`/`trunc`/`floor`/`max` and `DataView` bit access -- all
 * exactly specified by ECMA-262 -- so bit-identical output on every conformant engine is
 * a construction guarantee, not a hope; cross-engine agreement on this hash is the
 * measurement that proves the guarantee actually holds, not merely that it should.
 */
export const VENDORED_ANGLE_HASH = 'a4fdbbfb32debaae48844ba04f7492a55d9a03e53ada569f12c2ee344cd95aed';
