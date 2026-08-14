/**
 * sin, cos and atan2: netlib.org/fdlibm's `s_sin.c`, `s_cos.c`, `k_sin.c`, `k_cos.c`,
 * `s_atan.c` and `e_atan2.c`, ported line-by-line. Exported as `detSin`/`detCos`/
 * `detAtan2` -- "det" for deterministic, so a call site reads as a deliberate choice
 * rather than a typo for the native function.
 *
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunSoft, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 *
 * Algorithm: fdlibm, netlib.org/fdlibm, cross-checked against V8 src/base/ieee754.cc
 * branch-heads/13.6 -- see rem-pio2.ts's header for why that branch (this repo's own
 * Node, v24.15.0/V8 13.6.233) is the right cross-check target rather than V8 `main`.
 *
 * TWO VERIFIED DELTAS in this file, kept as V8's version rather than netlib's public
 * text, because Node/V8 13.6 is the bit-exact target this port validates against:
 *
 *   - `atan`'s tiny-argument fast path: netlib's s_atan.c short-circuits
 *     `if (ix < 0x3e200000)` (|x| < 2**-29) before falling into the polynomial;
 *     V8's copy widens that to `0x3E400000` (2**-27). For |x| in [2**-29, 2**-27),
 *     netlib computes atan(x) via the full reduced-polynomial path (`x - x*(s1+s2)`,
 *     id=-1) while V8 just returns x (mathematically indistinguishable at that
 *     magnitude -- atan(x)=x-x^3/3+... and x^3/3 is far below a double's ULP there
 *     -- but not necessarily the SAME bit pattern). Ported with V8's threshold.
 *   - `atan2`'s huge-ratio branch (`k > 60`, i.e. |y| more than ~2**60 times |x|):
 *     netlib sets `z = pi_o_2 + 0.5*pi_lo` and falls through to the `switch(m)` on
 *     BOTH x's and y's sign; V8 additionally does `m &= 1`, discarding the sign-of-x
 *     bit before that switch. At this magnitude ratio x is negligible and the
 *     mathematically correct answer is +-pi/2 regardless of x's sign -- but the
 *     unmodified switch's m==2/m==3 cases compute `pi-(z-pi_lo)` / `(z-pi_lo)-pi`,
 *     which is only EXACTLY equal to z/-z in real-number math, not bit-for-bit once
 *     rounded. V8's `m &= 1` makes the huge-ratio result depend only on sign(y), not
 *     on the extra rounding those case-2/3 expressions introduce. Ported with V8's
 *     `m &= 1`.
 *
 * PRESERVES OPERATION ORDER AND BRANCH STRUCTURE EXACTLY. Do not simplify.
 */
import { getHighWord, getLowWord, setHighWord } from './bits';
import { ieee754RemPio2 } from './rem-pio2';

// ---- k_cos.c: __kernel_cos ---------------------------------------------------------

const cos_one = 1.0;
const C1 = 4.16666666666666019037e-2; /* 0x3FA55555, 0x5555554C */
const C2 = -1.38888888888741095749e-3; /* 0xBF56C16C, 0x16C15177 */
const C3 = 2.48015872894767294178e-5; /* 0x3EFA01A0, 0x19CB1590 */
const C4 = -2.75573143513906633035e-7; /* 0xBE927E4F, 0x809C52AD */
const C5 = 2.0875723212981748279e-9; /* 0x3E21EE9E, 0xBDB4B1C4 */
const C6 = -1.13596475577881948265e-11; /* 0xBDA8FAE9, 0xBE8838D4 */

/** kernel cos on [-pi/4, pi/4]. x is the reduced argument, y its tail. */
function kernelCos(x: number, y: number): number {
  let ix = getHighWord(x);
  ix &= 0x7fffffff; /* ix = |x|'s high word*/
  if (ix < 0x3e400000) {
    /* if x < 2**27 */
    if (Math.trunc(x) === 0) return cos_one; /* generate inexact */
  }
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) {
    /* if |x| < 0.3 */
    return cos_one - (0.5 * z - (z * r - x * y));
  } else {
    let qx: number;
    if (ix > 0x3fe90000) {
      /* x > 0.78125 */
      qx = 0.28125;
    } else {
      qx = setHighWord(0, ix - 0x00200000); /* x/4, low word 0 */
    }
    const hz = 0.5 * z - qx;
    const a = cos_one - qx;
    return a - (hz - (z * r - x * y));
  }
}

// ---- k_sin.c: __kernel_sin ----------------------------------------------------------

const sin_half = 5.0e-1;
const S1 = -1.66666666666666324348e-1; /* 0xBFC55555, 0x55555549 */
const S2 = 8.33333333332248946124e-3; /* 0x3F811111, 0x1110F8A6 */
const S3 = -1.98412698298579493134e-4; /* 0xBF2A01A0, 0x19C161D5 */
const S4 = 2.75573137070700676789e-6; /* 0x3EC71DE3, 0x57B1FE7D */
const S5 = -2.50507602534068634195e-8; /* 0xBE5AE5E6, 0x8A2B9CEB */
const S6 = 1.58969099521155010221e-10; /* 0x3DE5D93A, 0x5ACFD57C */

/** kernel sin on [-pi/4, pi/4]. x is the reduced argument, y its tail, iy indicates
 *  whether y is zero (0) or should be used (nonzero). */
function kernelSin(x: number, y: number, iy: number): number {
  let ix = getHighWord(x);
  ix &= 0x7fffffff; /* high word of x */
  if (ix < 0x3e400000) {
    /* |x| < 2**-27 */
    if (Math.trunc(x) === 0) return x; /* generate inexact */
  }
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) {
    return x + v * (S1 + z * r);
  } else {
    return x - (z * (sin_half * y - v * r) - y - v * S1);
  }
}

// ---- s_sin.c: sin, s_cos.c: cos -----------------------------------------------------

const remPioY = new Float64Array(2);

/** sin(x): fdlibm's dispatcher -- __kernel_sin directly for |x|<=pi/4, otherwise
 *  __ieee754_rem_pio2 to find the quadrant and the reduced argument first. */
export function detSin(x: number): number {
  let ix = getHighWord(x);
  ix &= 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    return kernelSin(x, 0.0, 0);
  } else if (ix >= 0x7ff00000) {
    /* sin(Inf or NaN) is NaN */
    return x - x;
  } else {
    /* argument reduction needed */
    const n = ieee754RemPio2(x, remPioY);
    switch (n & 3) {
      case 0:
        return kernelSin(remPioY[0], remPioY[1], 1);
      case 1:
        return kernelCos(remPioY[0], remPioY[1]);
      case 2:
        return -kernelSin(remPioY[0], remPioY[1], 1);
      default:
        return -kernelCos(remPioY[0], remPioY[1]);
    }
  }
}

/** cos(x): fdlibm's dispatcher, the __kernel_cos/__kernel_sin mirror of detSin. */
export function detCos(x: number): number {
  let ix = getHighWord(x);
  ix &= 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    return kernelCos(x, 0.0);
  } else if (ix >= 0x7ff00000) {
    /* cos(Inf or NaN) is NaN */
    return x - x;
  } else {
    /* argument reduction needed */
    const n = ieee754RemPio2(x, remPioY);
    switch (n & 3) {
      case 0:
        return kernelCos(remPioY[0], remPioY[1]);
      case 1:
        return -kernelSin(remPioY[0], remPioY[1], 1);
      case 2:
        return -kernelCos(remPioY[0], remPioY[1]);
      default:
        return kernelSin(remPioY[0], remPioY[1], 1);
    }
  }
}

// ---- s_atan.c: atan --------------------------------------------------------------

const atanhi: readonly number[] = [
  4.63647609000806093515e-1, /* atan(0.5)hi 0x3FDDAC67, 0x0561BB4F */
  7.85398163397448278999e-1, /* atan(1.0)hi 0x3FE921FB, 0x54442D18 */
  9.82793723247329054082e-1, /* atan(1.5)hi 0x3FEF730B, 0xD281F69B */
  1.57079632679489655800e0, /* atan(inf)hi 0x3FF921FB, 0x54442D18 */
];

const atanlo: readonly number[] = [
  2.26987774529616870924e-17, /* atan(0.5)lo 0x3C7A2B7F, 0x222F65E2 */
  3.06161699786838301793e-17, /* atan(1.0)lo 0x3C81A626, 0x33145C07 */
  1.39033110312309984516e-17, /* atan(1.5)lo 0x3C700788, 0x7AF0CBBD */
  6.12323399573676603587e-17, /* atan(inf)lo 0x3C91A626, 0x33145C07 */
];

const aT: readonly number[] = [
  3.33333333333329318027e-1, /* 0x3FD55555, 0x5555550D */
  -1.99999999998764832476e-1, /* 0xBFC99999, 0x9998EBC4 */
  1.42857142725034663711e-1, /* 0x3FC24924, 0x920083FF */
  -1.11111104054623557880e-1, /* 0xBFBC71C6, 0xFE231671 */
  9.09088713343650656196e-2, /* 0x3FB745CD, 0xC54C206E */
  -7.69187620504482999495e-2, /* 0xBFB3B0F2, 0xAF749A6D */
  6.66107313738753120669e-2, /* 0x3FB10D66, 0xA0D03D51 */
  -5.83357013379057348645e-2, /* 0xBFADDE2D, 0x52DEFD9A */
  4.97687799461593236017e-2, /* 0x3FA97B4B, 0x24760DEB */
  -3.65315727442169155270e-2, /* 0xBFA2B444, 0x2C6A6C2F */
  1.62858201153657823623e-2, /* 0x3F90AD3A, 0xE322DA11 */
];

const atan_one = 1.0;
const atan_huge = 1.0e300;

/** atan(x): fdlibm's own reciprocal-symmetry reduction (no Payne-Hanek -- the
 *  domain is already bounded). Only used internally by detAtan2; not itself one of
 *  the sim's call sites (issue #133's occurrence table has no bare Math.atan), but
 *  e_atan2.c calls it twice, so it is ported as its own function rather than
 *  inlined. Carries the V8 tiny-threshold delta -- see this file's header. */
function atan(xIn: number): number {
  let x = xIn;
  const hx = getHighWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x44100000) {
    /* if |x| >= 2^66 */
    const low = getLowWord(x);
    if (ix > 0x7ff00000 || (ix === 0x7ff00000 && low !== 0)) return x + x; /* NaN */
    if (hx > 0) return atanhi[3] + atanlo[3];
    else return -atanhi[3] - atanlo[3];
  }
  let id: number;
  if (ix < 0x3fdc0000) {
    /* |x| < 0.4375 */
    if (ix < 0x3e400000) {
      /* |x| < 2^-27 -- V8's threshold; netlib's own text uses 0x3e200000 (2^-29) */
      if (atan_huge + x > atan_one) return x; /* raise inexact */
    }
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) {
      /* |x| < 1.1875 */
      if (ix < 0x3fe60000) {
        /* 7/16 <=|x|<11/16 */
        id = 0;
        x = (2.0 * x - atan_one) / (2.0 + x);
      } else {
        /* 11/16<=|x|< 19/16 */
        id = 1;
        x = (x - atan_one) / (x + atan_one);
      }
    } else {
      if (ix < 0x40038000) {
        /* |x| < 2.4375 */
        id = 2;
        x = (x - 1.5) / (atan_one + 1.5 * x);
      } else {
        /* 2.4375 <= |x| < 2^66 */
        id = 3;
        x = -1.0 / x;
      }
    }
  }
  /* end of argument reduction */
  const z = x * x;
  const w = z * z;
  /* break sum from i=0 to 10 aT[i]z**(i+1) into odd and even poly */
  const s1 = z * (aT[0] + w * (aT[2] + w * (aT[4] + w * (aT[6] + w * (aT[8] + w * aT[10])))));
  const s2 = w * (aT[1] + w * (aT[3] + w * (aT[5] + w * (aT[7] + w * aT[9]))));
  if (id < 0) {
    return x - x * (s1 + s2);
  } else {
    const zres = atanhi[id] - (x * (s1 + s2) - atanlo[id] - x);
    return hx < 0 ? -zres : zres;
  }
}

// ---- e_atan2.c: __ieee754_atan2 -----------------------------------------------------

const atan2_tiny = 1.0e-300;
const atan2_zero = 0.0;
const pi_o_4 = 7.8539816339744827900e-1; /* 0x3FE921FB, 0x54442D18 */
const pi_o_2 = 1.5707963267948965580e0; /* 0x3FF921FB, 0x54442D18 */
const atan2_pi = 3.1415926535897931160e0; /* 0x400921FB, 0x54442D18 */
const pi_lo = 1.2246467991473531772e-16; /* 0x3CA1A626, 0x33145C07 */

/** atan2(y, x): fdlibm's __ieee754_atan2, the one Math.atan2 call site in
 *  src/sim needs (types.ts's angleOf). Carries the V8 `m &= 1` delta on the
 *  huge-ratio branch -- see this file's header. */
export function detAtan2(y: number, x: number): number {
  const hx = getHighWord(x);
  const ix = hx & 0x7fffffff;
  const lx = getLowWord(x);
  const hy = getHighWord(y);
  const iy = hy & 0x7fffffff;
  const ly = getLowWord(y);
  if ((ix | ((lx | -lx) >>> 31)) > 0x7ff00000 || (iy | ((ly | -ly) >>> 31)) > 0x7ff00000) {
    /* x or y is NaN */
    return x + y;
  }
  if (((hx - 0x3ff00000) | lx) === 0) return atan(y); /* x=1.0 */
  let m = ((hy >> 31) & 1) | ((hx >> 30) & 2); /* 2*sign(x)+sign(y) */

  /* when y = 0 */
  if ((iy | ly) === 0) {
    switch (m) {
      case 0:
      case 1:
        return y; /* atan(+-0,+anything)=+-0 */
      case 2:
        return atan2_pi + atan2_tiny; /* atan(+0,-anything) = pi */
      case 3:
        return -atan2_pi - atan2_tiny; /* atan(-0,-anything) =-pi */
    }
  }
  /* when x = 0 */
  if ((ix | lx) === 0) return hy < 0 ? -pi_o_2 - atan2_tiny : pi_o_2 + atan2_tiny;

  /* when x is INF */
  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0:
          return pi_o_4 + atan2_tiny; /* atan(+INF,+INF) */
        case 1:
          return -pi_o_4 - atan2_tiny; /* atan(-INF,+INF) */
        case 2:
          return 3.0 * pi_o_4 + atan2_tiny; /*atan(+INF,-INF)*/
        case 3:
          return -3.0 * pi_o_4 - atan2_tiny; /*atan(-INF,-INF)*/
      }
    } else {
      switch (m) {
        case 0:
          return atan2_zero; /* atan(+...,+INF) */
        case 1:
          return -atan2_zero; /* atan(-...,+INF) */
        case 2:
          return atan2_pi + atan2_tiny; /* atan(+...,-INF) */
        case 3:
          return -atan2_pi - atan2_tiny; /* atan(-...,-INF) */
      }
    }
  }
  /* when y is INF */
  if (iy === 0x7ff00000) return hy < 0 ? -pi_o_2 - atan2_tiny : pi_o_2 + atan2_tiny;

  /* compute y/x */
  const k = (iy - ix) >> 20;
  let z: number;
  if (k > 60) {
    /* |y/x| >  2**60 */
    z = pi_o_2 + 0.5 * pi_lo;
    m &= 1; // V8 delta: discards sign-of-x before the switch below -- see header.
  } else if (hx < 0 && k < -60) {
    z = 0.0; /* 0 > |y|/x > -2**-60 */
  } else {
    z = atan(Math.abs(y / x)); /* safe to do y/x */
  }
  switch (m) {
    case 0:
      return z; /* atan(+,+) */
    case 1:
      return -z; /* atan(-,+) -- V8 simplifies netlib's __HI(z)^=0x80000000 to
                    negation; equivalent since z is always finite and >= 0 here. */
    case 2:
      return atan2_pi - (z - pi_lo); /* atan(+,-) */
    default:
      /* case 3 */
      return z - pi_lo - atan2_pi; /* atan(-,-) */
  }
}
