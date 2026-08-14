/**
 * hypot: V8's own `src/builtins/math.tq`, `FastMathHypot`'s 2-argument path,
 * transliterated -- not fdlibm-derived (hypot was never in `ieee754.cc`; it is a
 * Torque builtin, unaffected by V8's 2026-05 LLVM-libc migration of sin/cos/atan,
 * which is why PR #160 found Node already agreeing with chromium on this one
 * function). Apache/BSD-clean under V8's own license; no Sun Microsystems notice
 * applies to this file.
 *
 * All 10 `Math.hypot` call sites in src/sim are 2-argument (issue #133's own
 * grep), so only that path is ported -- the 3+-argument Kahan-compensated path in
 * math.tq is out of scope.
 *
 * Order matters and is preserved from the Torque source: the +-Infinity check runs
 * BEFORE the NaN check, which is why `hypot(NaN, Infinity) === Infinity` rather
 * than NaN -- ECMA-262 gives Infinity that precedence explicitly ("If abs(x) is
 * +Infinity ... the result is +Infinity, even if y is NaN"), and native
 * `Math.hypot` was checked against this exact case (see hypot.test.ts) before
 * trusting the formula.
 */

/** hypot(x, y) = sqrt(x^2 + y^2), scaled by the larger magnitude first so the
 *  intermediate squares never overflow before the larger input itself would. */
export function detHypot(x: number, y: number): number {
  const a = Math.abs(x);
  const b = Math.abs(y);
  if (a === Infinity || b === Infinity) return Infinity;
  const max = Math.max(a, b);
  if (Number.isNaN(max)) return NaN;
  if (max === 0) return 0;
  return Math.sqrt((a / max) * (a / max) + (b / max) * (b / max)) * max;
}
