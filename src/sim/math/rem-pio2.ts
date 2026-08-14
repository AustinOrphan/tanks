/**
 * Argument reduction: netlib.org/fdlibm's `e_rem_pio2.c` and `k_rem_pio2.c`, ported
 * line-by-line. This is the Payne-Hanek machinery `trig.ts`'s `detSin`/`detCos` fall
 * back to once |x| exceeds pi/4 -- the part of fdlibm that reduces an arbitrarily
 * large x to x mod pi/2 without ever computing that subtraction in one step (which
 * would lose all its low bits to cancellation once x is more than a few bits wider
 * than pi/2 itself).
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
 * branch-heads/13.6 (this repo's own Node -- v24.15.0, V8 13.6.233 -- runs this exact
 * branch; V8's `sin`/`cos`/`atan`/`atan2` are classic inline fdlibm there, not the
 * LLVM-libc implementation V8 `main` moved to in 2026-05, which is why that newer
 * tree was rejected as the port target -- see the plan this file's commit carries).
 *
 * ONE VERIFIED DELTA in this file, kept as V8's version rather than netlib's public
 * text: `__kernel_rem_pio2`'s "chance is 1 in 12" recompute path loops
 * `for(k=1;iq[jk-k]==0;k++);` in netlib with NO bound on k against jk -- if every one
 * of iq[0..jk-1] is zero (only reachable when q happens to be exactly representable
 * in fewer than jk 24-bit chunks, an exact-multiple-of-pi/2-to-very-high-precision
 * input), that loop reads iq[jk-k] for k>jk, a negative array index. V8 added a
 * `jk>=k &&` guard (see `kernelRemPio2`'s inner while below); ported as V8 has it,
 * since a faithful netlib port would carry a latent out-of-bounds read forward for
 * no reason -- Node/V8 is the bit-exact target this port is validated against, and
 * this is the branch Node actually runs.
 *
 * That one guard clause (`jk >= k &&`, two tokens) is V8-authored text, not netlib's,
 * so V8's own license applies to it specifically, addended here rather than assumed:
 * the surrounding function is still netlib's, under the Sun Microsystems notice above.
 *
 *   Copyright 2014, the V8 project authors. All rights reserved.
 *   Redistribution and use in source and binary forms, with or without
 *   modification, are permitted provided that the following conditions are met:
 *     * Redistributions of source code must retain the above copyright notice,
 *       this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above copyright notice,
 *       this list of conditions and the following disclaimer in the documentation
 *       and/or other materials provided with the distribution.
 *     * Neither the name of Google Inc. nor the names of its contributors may be
 *       used to endorse or promote products derived from this software without
 *       specific prior written permission.
 *   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 *   ANY EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED. See
 *   https://chromium.googlesource.com/v8/v8/+/branch-heads/13.6/LICENSE for the
 *   verbatim, unabridged text.
 *
 * WHAT THE FULL-SWEEP BIT-COMPARE (see this port's PR body) DOES NOT REACH: the
 * `recompute` loop above -- and so the `jk >= k &&` guard inside it -- only runs when
 * `z` lands EXACTLY on zero after distilling `q[]`, which needs an input whose true
 * value is an exact multiple of pi/2 to well beyond double precision. The angle probe's
 * breakpoint-clustered samples (angles.ts's `breakpointBandSamples`) land NEAR
 * k*pi/2, deliberately jittered so they are not exact hits -- so this path is translated
 * by inspection against the netlib and V8 source texts, not exercised by that sweep.
 * Nothing in this port constructs a fixture that reaches it.
 *
 * PRESERVES OPERATION ORDER AND BRANCH STRUCTURE EXACTLY. Do not simplify.
 */
import { getHighWord, getLowWord, setHighWord, fromWords, copysign } from './bits';

// ---- e_rem_pio2.c's tables --------------------------------------------------------

/** 396 hex digits (476 decimal) of 2/pi, as 24-bit chunks. */
const two_over_pi: readonly number[] = [
  0xa2f983, 0x6e4e44, 0x1529fc, 0x2757d1, 0xf534dd, 0xc0db62,
  0x95993c, 0x439041, 0xfe5163, 0xabdebb, 0xc561b7, 0x246e3a,
  0x424dd2, 0xe00649, 0x2eea09, 0xd1921c, 0xfe1deb, 0x1cb129,
  0xa73ee8, 0x8235f5, 0x2ebb44, 0x84e99c, 0x7026b4, 0x5f7e41,
  0x3991d6, 0x398353, 0x39f49c, 0x845f8b, 0xbdf928, 0x3b1ff8,
  0x97ffde, 0x05980f, 0xef2f11, 0x8b5a0a, 0x6d1f6d, 0x367ecf,
  0x27cb09, 0xb74f46, 0x3f669e, 0x5fea2d, 0x7527ba, 0xc7ebe5,
  0xf17b3d, 0x0739f7, 0x8a5292, 0xea6bfb, 0x5fb11f, 0x8d5d08,
  0x560330, 0x46fc7b, 0x6babf0, 0xcfbc20, 0x9af436, 0x1da9e3,
  0x91615e, 0xe61b08, 0x659985, 0x5f14a0, 0x68408d, 0xffd880,
  0x4d7327, 0x310606, 0x1556ca, 0x73a8c9, 0x60e27b, 0xc08c6b,
];

/** high word of n*pi/2, for n = 1..32, used to detect cancellation in the medium-
 *  size branch of ieee754RemPio2. */
const npio2_hw: readonly number[] = [
  0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c,
  0x4025fdbb, 0x402921fb, 0x402c463a, 0x402f6a7a, 0x4031475c, 0x4032d97c,
  0x40346b9c, 0x4035fdbb, 0x40378fdb, 0x403921fb, 0x403ab41b, 0x403c463a,
  0x403dd85a, 0x403f6a7a, 0x40407e4c, 0x4041475c, 0x4042106c, 0x4042d97c,
  0x4043a28c, 0x40446b9c, 0x404534ac, 0x4045fdbb, 0x4046c6cb, 0x40478fdb,
  0x404858eb, 0x404921fb,
];

/*
 * invpio2:  53 bits of 2/pi
 * pio2_1:   first  33 bit of pi/2
 * pio2_1t:  pi/2 - pio2_1
 * pio2_2:   second 33 bit of pi/2
 * pio2_2t:  pi/2 - (pio2_1+pio2_2)
 * pio2_3:   third  33 bit of pi/2
 * pio2_3t:  pi/2 - (pio2_1+pio2_2+pio2_3)
 */
const zero = 0.0;
const half = 5.0e-1;
const two24 = 1.6777216e7;
const invpio2 = 6.36619772367581382433e-1; /* 0x3FE45F30, 0x6DC9C883 */
const pio2_1 = 1.57079632673412561417e0; /* 0x3FF921FB, 0x54400000 */
const pio2_1t = 6.07710050650619224932e-11; /* 0x3DD0B461, 0x1A626331 */
const pio2_2 = 6.0771005063039659766e-11; /* 0x3DD0B461, 0x1A600000 */
const pio2_2t = 2.02226624879595063154e-21; /* 0x3BA3198A, 0x2E037073 */
const pio2_3 = 2.02226624871116645580e-21; /* 0x3BA3198A, 0x2E000000 */
const pio2_3t = 8.47842766036889956997e-32; /* 0x397B839A, 0x252049C1 */

// ---- k_rem_pio2.c's tables --------------------------------------------------------

const init_jk: readonly number[] = [2, 3, 4, 6]; /* initial value for jk */

const PIo2: readonly number[] = [
  1.57079625129699707031e0, /* 0x3FF921FB, 0x40000000 */
  7.54978941586159635335e-8, /* 0x3E74442D, 0x00000000 */
  5.39030252995776476554e-15, /* 0x3CF84698, 0x80000000 */
  3.28200341580791294123e-22, /* 0x3B78CC51, 0x60000000 */
  1.27065575308067607349e-29, /* 0x39F01B83, 0x80000000 */
  1.22933308981111328932e-36, /* 0x387A2520, 0x40000000 */
  2.73370053816464559624e-44, /* 0x36E38222, 0x80000000 */
  2.16741683877804819444e-51, /* 0x3569F31D, 0x00000000 */
];

const k_zero = 0.0;
const k_one = 1.0;
const twon24 = 5.9604644775390625e-8; /* 0x3E700000, 0x00000000 */

// ---- s_scalbn.c --------------------------------------------------------------------

const scalbn_two54 = 1.80143985094819840000e16; /* 0x43500000, 0x00000000 */
const scalbn_twom54 = 5.55111512312578270212e-17; /* 0x3C900000, 0x00000000 */
const scalbn_huge = 1.0e300;
const scalbn_tiny = 1.0e-300;

/** scalbn(x, n): x * 2**n, computed by exponent manipulation. Ported from
 *  netlib's s_scalbn.c (not one of the 8 files the plan names -- it's an "External
 *  function" k_rem_pio2.c calls, per that file's own doc comment -- but it is
 *  short and its own netlib text, ported fully rather than special-cased down to
 *  the bounded range __kernel_rem_pio2 actually calls it with). */
export function scalbn(x: number, n: number): number {
  let hx = getHighWord(x);
  const lx = getLowWord(x);
  let k = (hx & 0x7ff00000) >> 20; /* extract exponent */
  if (k === 0) {
    /* 0 or subnormal x */
    if ((lx | (hx & 0x7fffffff)) === 0) return x; /* +-0 */
    x *= scalbn_two54;
    hx = getHighWord(x);
    k = ((hx & 0x7ff00000) >> 20) - 54;
    if (n < -50000) return scalbn_tiny * x; /* underflow */
  }
  if (k === 0x7ff) return x + x; /* NaN or Inf */
  k = k + n;
  if (k > 0x7fe) return scalbn_huge * copysign(scalbn_huge, x); /* overflow */
  if (k > 0) {
    /* normal result */
    return setHighWord(x, (hx & 0x800fffff) | (k << 20));
  }
  if (k <= -54) {
    if (n > 50000) {
      /* in case integer overflow in n+k */
      return scalbn_huge * copysign(scalbn_huge, x); /* overflow */
    } else {
      return scalbn_tiny * copysign(scalbn_tiny, x); /* underflow */
    }
  }
  k += 54; /* subnormal result */
  return setHighWord(x, (hx & 0x800fffff) | (k << 20)) * scalbn_twom54;
}

// ---- k_rem_pio2.c: __kernel_rem_pio2 -----------------------------------------------

/**
 * __kernel_rem_pio2(x,y,e0,nx,prec,ipio2): returns the last three bits of N with
 * y = x - N*pi/2, |y| < pi/2. x has nx elements (24-bit chunks of the true value,
 * scaled by 2**e0); y receives 2 elements for prec 1/2 (the only precision this
 * port's callers ever use) or 3 for prec 3 (kept for fidelity, unreachable here).
 */
export function kernelRemPio2(
  x: Float64Array,
  y: Float64Array,
  e0: number,
  nx: number,
  prec: number,
  ipio2: readonly number[],
): number {
  const iq = new Int32Array(20);
  const f = new Float64Array(20);
  const fq = new Float64Array(20);
  const q = new Float64Array(20);

  let jz: number, jx: number, jv: number, jp: number;
  let carry: number, n: number, i: number, j: number, k: number, m: number, q0: number, ih: number;
  let z: number, fw: number;

  /* initialize jk */
  const jk = init_jk[prec];
  jp = jk;

  /* determine jx,jv,q0, note that 3>q0 */
  jx = nx - 1;
  jv = Math.trunc((e0 - 3) / 24);
  if (jv < 0) jv = 0;
  q0 = e0 - 24 * (jv + 1);

  /* set up f[0] to f[jx+jk] where f[jx+jk] = ipio2[jv+jk] */
  j = jv - jx;
  m = jx + jk;
  for (i = 0; i <= m; i++, j++) {
    f[i] = j < 0 ? k_zero : ipio2[j];
  }

  /* compute q[0],q[1],...q[jk] */
  for (i = 0; i <= jk; i++) {
    for (j = 0, fw = 0.0; j <= jx; j++) fw += x[j] * f[jx + i - j];
    q[i] = fw;
  }

  jz = jk;
  // The `recompute` label in the original C becomes a loop here, since JS has no goto.
  for (;;) {
    /* distill q[] into iq[] reversingly */
    z = q[jz];
    for (i = 0, j = jz; j > 0; i++, j--) {
      fw = Math.trunc(twon24 * z);
      iq[i] = Math.trunc(z - two24 * fw);
      z = q[j - 1] + fw;
    }

    /* compute n */
    z = scalbn(z, q0); /* actual value of z */
    z -= 8.0 * Math.floor(z * 0.125); /* trim off integer >= 8 */
    n = Math.trunc(z);
    z -= n;
    ih = 0;
    if (q0 > 0) {
      /* need iq[jz-1] to determine n */
      i = iq[jz - 1] >> (24 - q0);
      n += i;
      iq[jz - 1] -= i << (24 - q0);
      ih = iq[jz - 1] >> (23 - q0);
    } else if (q0 === 0) {
      ih = iq[jz - 1] >> 23;
    } else if (z >= 0.5) {
      ih = 2;
    }

    if (ih > 0) {
      /* q > 0.5 */
      n += 1;
      carry = 0;
      for (i = 0; i < jz; i++) {
        /* compute 1-q */
        j = iq[i];
        if (carry === 0) {
          if (j !== 0) {
            carry = 1;
            iq[i] = 0x1000000 - j;
          }
        } else {
          iq[i] = 0xffffff - j;
        }
      }
      if (q0 > 0) {
        /* rare case: chance is 1 in 12 */
        switch (q0) {
          case 1:
            iq[jz - 1] &= 0x7fffff;
            break;
          case 2:
            iq[jz - 1] &= 0x3fffff;
            break;
        }
      }
      if (ih === 2) {
        z = k_one - z;
        if (carry !== 0) z -= scalbn(k_one, q0);
      }
    }

    /* check if recomputation is needed */
    if (z === k_zero) {
      j = 0;
      for (i = jz - 1; i >= jk; i--) j |= iq[i];
      if (j === 0) {
        /* need recomputation */
        // V8-vs-netlib delta: bounded with `jk >= k &&` -- see this file's header.
        for (k = 1; jk >= k && iq[jk - k] === 0; k++) {
          /* k = no. of terms needed */
        }

        for (i = jz + 1; i <= jz + k; i++) {
          /* add q[jz+1] to q[jz+k] */
          f[jx + i] = ipio2[jv + i];
          for (j = 0, fw = 0.0; j <= jx; j++) fw += x[j] * f[jx + i - j];
          q[i] = fw;
        }
        jz += k;
        continue; // goto recompute
      }
    }
    break;
  }

  /* chop off zero terms */
  if (z === 0.0) {
    jz -= 1;
    q0 -= 24;
    while (iq[jz] === 0) {
      jz--;
      q0 -= 24;
    }
  } else {
    /* break z into 24-bit if necessary */
    z = scalbn(z, -q0);
    if (z >= two24) {
      fw = Math.trunc(twon24 * z);
      iq[jz] = Math.trunc(z - two24 * fw);
      jz += 1;
      q0 += 24;
      iq[jz] = Math.trunc(fw);
    } else {
      iq[jz] = Math.trunc(z);
    }
  }

  /* convert integer "bit" chunk to floating-point value */
  fw = scalbn(k_one, q0);
  for (i = jz; i >= 0; i--) {
    q[i] = fw * iq[i];
    fw *= twon24;
  }

  /* compute PIo2[0,...,jp]*q[jz,...,0] */
  for (i = jz; i >= 0; i--) {
    for (fw = 0.0, k = 0; k <= jp && k <= jz - i; k++) fw += PIo2[k] * q[i + k];
    fq[jz - i] = fw;
  }

  /* compress fq[] into y[] */
  switch (prec) {
    case 0:
      fw = 0.0;
      for (i = jz; i >= 0; i--) fw += fq[i];
      y[0] = ih === 0 ? fw : -fw;
      break;
    case 1:
    case 2:
      fw = 0.0;
      for (i = jz; i >= 0; i--) fw += fq[i];
      y[0] = ih === 0 ? fw : -fw;
      fw = fq[0] - fw;
      for (i = 1; i <= jz; i++) fw += fq[i];
      y[1] = ih === 0 ? fw : -fw;
      break;
    case 3: /* painful */
      for (i = jz; i > 0; i--) {
        fw = fq[i - 1] + fq[i];
        fq[i] += fq[i - 1] - fw;
        fq[i - 1] = fw;
      }
      for (i = jz; i > 1; i--) {
        fw = fq[i - 1] + fq[i];
        fq[i] += fq[i - 1] - fw;
        fq[i - 1] = fw;
      }
      for (fw = 0.0, i = jz; i >= 2; i--) fw += fq[i];
      if (ih === 0) {
        y[0] = fq[0];
        y[1] = fq[1];
        y[2] = fw;
      } else {
        y[0] = -fq[0];
        y[1] = -fq[1];
        y[2] = -fw;
      }
  }
  return n & 7;
}

// ---- e_rem_pio2.c: __ieee754_rem_pio2 ----------------------------------------------

/**
 * __ieee754_rem_pio2(x, y): the remainder of x rem pi/2 in y[0]+y[1]. Returns the
 * quadrant count N such that x = N*pi/2 + (y[0]+y[1]), used by trig.ts to select
 * which of __kernel_sin/__kernel_cos (and which sign) answers the original call.
 */
export function ieee754RemPio2(x: number, y: Float64Array): number {
  const hx = getHighWord(x); /* high word of x */
  const ix = hx & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    /* |x| ~<= pi/4 , no need for reduction */
    y[0] = x;
    y[1] = 0;
    return 0;
  }
  if (ix < 0x4002d97c) {
    /* |x| < 3pi/4, special case with n=+-1 */
    let z: number;
    if (hx > 0) {
      z = x - pio2_1;
      if (ix !== 0x3ff921fb) {
        /* 33+53 bit pi is good enough */
        y[0] = z - pio2_1t;
        y[1] = z - y[0] - pio2_1t;
      } else {
        /* near pi/2, use 33+33+53 bit pi */
        z -= pio2_2;
        y[0] = z - pio2_2t;
        y[1] = z - y[0] - pio2_2t;
      }
      return 1;
    } else {
      /* negative x */
      z = x + pio2_1;
      if (ix !== 0x3ff921fb) {
        /* 33+53 bit pi is good enough */
        y[0] = z + pio2_1t;
        y[1] = z - y[0] + pio2_1t;
      } else {
        /* near pi/2, use 33+33+53 bit pi */
        z += pio2_2;
        y[0] = z + pio2_2t;
        y[1] = z - y[0] + pio2_2t;
      }
      return -1;
    }
  }
  if (ix <= 0x413921fb) {
    /* |x| ~<= 2^19*(pi/2), medium size */
    const t = Math.abs(x);
    const n = Math.trunc(t * invpio2 + half);
    const fn = n;
    let r = t - fn * pio2_1;
    let w = fn * pio2_1t; /* 1st round good to 85 bit */
    if (n < 32 && ix !== npio2_hw[n - 1]) {
      y[0] = r - w; /* quick check no cancellation */
    } else {
      const j = ix >> 20;
      y[0] = r - w;
      let i = j - ((getHighWord(y[0]) >> 20) & 0x7ff);
      if (i > 16) {
        /* 2nd iteration needed, good to 118 */
        const t2 = r;
        w = fn * pio2_2;
        r = t2 - w;
        w = fn * pio2_2t - (t2 - r - w);
        y[0] = r - w;
        i = j - ((getHighWord(y[0]) >> 20) & 0x7ff);
        if (i > 49) {
          /* 3rd iteration need, 151 bits acc */
          const t3 = r; /* will cover all possible cases */
          w = fn * pio2_3;
          r = t3 - w;
          w = fn * pio2_3t - (t3 - r - w);
          y[0] = r - w;
        }
      }
    }
    y[1] = r - y[0] - w;
    if (hx < 0) {
      y[0] = -y[0];
      y[1] = -y[1];
      return -n;
    } else {
      return n;
    }
  }
  /*
   * all other (large) arguments
   */
  if (ix >= 0x7ff00000) {
    /* x is inf or NaN */
    y[0] = y[1] = x - x;
    return 0;
  }
  /* set z = scalbn(|x|,ilogb(x)-23) */
  const e0 = (ix >> 20) - 1046; /* e0 = ilogb(z)-23; */
  let z = fromWords(ix - (e0 << 20), getLowWord(x));
  const tx = new Float64Array(3);
  for (let i = 0; i < 2; i++) {
    tx[i] = Math.trunc(z);
    z = (z - tx[i]) * two24;
  }
  tx[2] = z;
  let nx = 3;
  while (tx[nx - 1] === zero) nx--; /* skip zero term */
  const n = kernelRemPio2(tx, y, e0, nx, 2, two_over_pi);
  if (hx < 0) {
    y[0] = -y[0];
    y[1] = -y[1];
    return -n;
  }
  return n;
}
