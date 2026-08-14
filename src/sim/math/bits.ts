/**
 * IEEE 754 double bit access -- the primitive netlib's fdlibm C macros (`__HI`/`__LO`
 * /`__HI(x)=`/`__LO(x)=` in fdlibm.h) build the whole port on. Classic fdlibm reads a
 * double's two 32-bit halves through a union/pointer cast and picks which half is
 * "high" by testing host endianness at compile time (see the comment preserved in
 * rem-pio2.ts's header). That approach has no JS equivalent (no unions), and doesn't
 * need one: a `DataView` with an EXPLICITLY chosen byte order gives the same two
 * 32-bit halves on every host, little- or big-endian alike -- the identical idiom
 * `tools/baseline/angles.ts`'s `hashFloat64s` already uses for the same reason (a
 * bit-level operation that must mean the same thing everywhere). Big-endian is chosen
 * here purely so "high word" reads naturally as byte offset 0; the choice is otherwise
 * arbitrary since both offsets are always read through these functions, never through
 * raw byte access.
 *
 * Signedness follows each fdlibm call site's own C declaration, not one blanket
 * choice: `getHighWord` returns a SIGNED int32, because fdlibm's high-word variables
 * (`hx`, and `ix` before its own `&0x7fffffff` mask) are declared plain `int` and
 * compared with `hx>0`/`hx<0` -- reading it unsigned would make every negative input
 * register as positive. `getLowWord` returns an UNSIGNED uint32, matching fdlibm's own
 * `unsigned lx` declarations (e.g. e_atan2.c) where the low word is read numerically
 * rather than only copied bit-for-bit.
 *
 * One shared scratch buffer, not a fresh one per call: this sits on the sim's hot
 * path (every tank's heading, every shell's aim, every AI hypot call), and `tick-
 * cost.mjs` measures the result -- see the PR body for the before/after ratio.
 */
const scratch = new ArrayBuffer(8);
const view = new DataView(scratch);

/** The high 32 bits of x's IEEE 754 representation, as a SIGNED int32. */
export function getHighWord(x: number): number {
  view.setFloat64(0, x, false);
  return view.getInt32(0, false);
}

/** The low 32 bits of x's IEEE 754 representation, as an UNSIGNED uint32. */
export function getLowWord(x: number): number {
  view.setFloat64(0, x, false);
  return view.getUint32(4, false);
}

/** x with its high 32 bits replaced by hi (DataView's own ToInt32-equivalent
 *  conversion truncates/wraps hi exactly as a C `int` assignment would). */
export function setHighWord(x: number, hi: number): number {
  view.setFloat64(0, x, false);
  view.setInt32(0, hi, false);
  return view.getFloat64(0, false);
}

/** x with its low 32 bits replaced by lo. */
export function setLowWord(x: number, lo: number): number {
  view.setFloat64(0, x, false);
  view.setUint32(4, lo, false);
  return view.getFloat64(0, false);
}

/** Builds a double directly from its two 32-bit halves -- fdlibm's own idiom for
 *  this is two chained `__HI(z)=`/`__LO(z)=` writes into a fresh, uninitialised
 *  double; the starting value here is irrelevant since both halves are always
 *  overwritten before the result is read. */
export function fromWords(hi: number, lo: number): number {
  return setLowWord(setHighWord(0, hi), lo);
}

/** IEEE 754 copysign: the magnitude of x, the sign of y. Exactly specified (a sign-
 *  bit copy), needed because fdlibm's C source calls the C library's `copysign`
 *  directly (s_scalbn.c). Implemented via the sign bit rather than `Math.sign` so
 *  that a negative-zero y still yields a negative-signed result. */
export function copysign(x: number, y: number): number {
  const mag = Math.abs(x);
  return getHighWord(y) < 0 ? -mag : mag;
}
