import { describe, it, expect } from 'vitest';
import { parseDevFlags, DEV_FLAGS_OFF } from './devflags';

describe('parseDevFlags', () => {
  it('is off for an empty query', () => {
    expect(parseDevFlags('')).toEqual(DEV_FLAGS_OFF);
    expect(parseDevFlags('?')).toEqual(DEV_FLAGS_OFF);
  });

  it('ignores a feature flag that arrives WITHOUT dev mode', () => {
    // The point of the two-key rule: a shared link carrying ?aimRay=1
    // must not turn anything on for whoever opens it.
    expect(parseDevFlags('?aimRay=1').aimRay).toBe(false);
  });

  it('dev mode alone still leaves every feature off', () => {
    expect(parseDevFlags('?dev=1')).toEqual(DEV_FLAGS_OFF);
  });

  it('turns a feature on only with both keys', () => {
    expect(parseDevFlags('?dev=1&aimRay=1').aimRay).toBe(true);
    expect(parseDevFlags('?dev=1&shellCount=1').shellCount).toBe(true);
  });

  it('turns flags on independently', () => {
    const only = parseDevFlags('?dev=1&aimRay=1');
    expect(only.aimRay).toBe(true);
    expect(only.shellCount).toBe(false);
  });

  it('accepts a bare key as on', () => {
    expect(parseDevFlags('?dev&aimRay').aimRay).toBe(true);
  });

  it('treats explicit negatives as off', () => {
    // Population: the 4 values in FALSY, each tried on the feature key with dev
    // mode already on.
    for (const v of ['0', 'false', 'off', 'no']) {
      expect(parseDevFlags(`?dev=1&aimRay=${v}`).aimRay).toBe(false);
    }
    // and the same values disable dev mode itself
    for (const v of ['0', 'false', 'off', 'no']) {
      expect(parseDevFlags(`?dev=${v}&aimRay=1`).aimRay).toBe(false);
    }
  });

  it('works with or without the leading question mark', () => {
    expect(parseDevFlags('dev=1&aimRay=1').aimRay).toBe(true);
  });

  it('is unaffected by unrelated query parameters', () => {
    expect(parseDevFlags('?utm_source=x&dev=1&aimRay=1&ref=y').aimRay).toBe(true);
    expect(parseDevFlags('?utm_source=x&ref=y').aimRay).toBe(false);
  });
});

describe('parseDevFlags: seed', () => {
  it('is null without dev mode, whatever the seed says', () => {
    expect(parseDevFlags('?seed=1234').seed).toBeNull();
  });

  it('is null when absent', () => {
    expect(parseDevFlags('?dev=1').seed).toBeNull();
  });

  it('takes a positive integer', () => {
    expect(parseDevFlags('?dev=1&seed=1234').seed).toBe(1234);
  });

  it('rejects values the PRNG cannot use', () => {
    // 0 is degenerate for the PRNG -- deriveSeed never returns it -- and the
    // rest are simply not seeds. Population: the 6 forms below.
    for (const v of ['0', '-5', 'abc', '1.5', '', 'NaN']) {
      expect(parseDevFlags(`?dev=1&seed=${v}`).seed).toBeNull();
    }
  });

  it('does not disturb the boolean flags', () => {
    expect(parseDevFlags('?dev=1&seed=7')).toEqual({ aimRay: false, shellCount: false, seed: 7 });
  });
});
