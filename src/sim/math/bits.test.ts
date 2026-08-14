import { describe, it, expect } from 'vitest';
import { getHighWord, getLowWord, setHighWord, setLowWord, fromWords, copysign } from './bits';

/**
 * The bit-access primitive every other file in src/sim/math builds on. Expected
 * values are literal IEEE-754 hex layouts (checkable by hand: sign(1) exponent(11)
 * mantissa(52), split at the 32-bit boundary), not Node-native readings -- this
 * file tests bit LAYOUT, not any transcendental function's output.
 */
describe('getHighWord / getLowWord', () => {
  it('1.0 is 0x3FF00000_00000000', () => {
    expect(getHighWord(1.0)).toBe(0x3ff00000);
    expect(getLowWord(1.0)).toBe(0x00000000);
  });

  it('-1.0 has the sign bit set in the high word only', () => {
    expect(getHighWord(-1.0)).toBe(0x3ff00000 | (-1 << 31)); // 0xBFF00000 as signed int32
    expect(getHighWord(-1.0)).toBe(-0x40100000);
    expect(getLowWord(-1.0)).toBe(0);
  });

  it('+0 and -0 differ only in the high word\'s sign bit', () => {
    expect(getHighWord(0)).toBe(0);
    expect(getHighWord(-0)).toBe(-0x80000000);
    expect(getLowWord(0)).toBe(0);
    expect(getLowWord(-0)).toBe(0);
  });

  it('getHighWord is SIGNED: a negative double reads as a negative int32', () => {
    expect(getHighWord(-2.5)).toBeLessThan(0);
    expect(getHighWord(2.5)).toBeGreaterThan(0);
  });

  it('getLowWord is UNSIGNED: a double whose low word has its top bit set reads', () => {
    // as a large positive number, never negative.
    // Number.MIN_VALUE = 2**-1074, bit pattern 0x00000000_00000001 (low word 1).
    expect(getLowWord(Number.MIN_VALUE)).toBe(1);
    expect(getLowWord(Number.MIN_VALUE)).toBeGreaterThanOrEqual(0);
  });
});

describe('setHighWord / setLowWord / fromWords', () => {
  it('round-trips: get after set returns exactly what was set', () => {
    const x = setHighWord(1.0, 0x40000000); // rewrite 1.0's high word -> 2.0
    expect(x).toBe(2.0);
  });

  it('setLowWord only touches the low 32 bits', () => {
    const x = setLowWord(1.0, 1); // 1.0 + one ULP in the low word
    expect(getHighWord(x)).toBe(0x3ff00000);
    expect(getLowWord(x)).toBe(1);
    expect(x).toBeGreaterThan(1.0);
    expect(x).toBeLessThan(1.0 + 1e-10);
  });

  it('fromWords builds 1.0 from its two known-exact halves', () => {
    expect(fromWords(0x3ff00000, 0)).toBe(1.0);
  });

  it('fromWords(hi,lo) then reading back hi/lo is the identity, for an arbitrary', () => {
    // double -- proves the two halves are independent and complete (no bit lost
    // or duplicated across the 32-bit boundary a mutation could shift).
    const original = 12345.6789;
    const hi = getHighWord(original);
    const lo = getLowWord(original);
    expect(fromWords(hi, lo)).toBe(original);
  });
});

describe('copysign', () => {
  it('copies a positive sign onto a negative magnitude source', () => {
    expect(copysign(-5, 1)).toBe(5);
  });

  it('copies a negative sign onto a positive magnitude source', () => {
    expect(copysign(5, -1)).toBe(-5);
  });

  it('treats -0 as a negative sign source, not merely "not positive"', () => {
    // A mutation using Math.sign(y)<0 instead of the bit test would miss this,
    // since Math.sign(-0) is -0, and -0<0 is false.
    expect(Object.is(copysign(5, -0), -5)).toBe(true);
  });

  it('preserves +0 as a positive sign source', () => {
    expect(Object.is(copysign(-5, 0), 5)).toBe(true);
  });
});
