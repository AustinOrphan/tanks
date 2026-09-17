import { describe, expect, it } from 'vitest';

import balance from '../sim/config/data/balance.json';
import {
  MAX_TRAIL_SEGMENTS,
  SHELL_TRAIL_STYLES,
  isShellTrailStyle,
  trailSegmentsFor,
} from './shell-trail';

describe('shell bounce-trail vocabulary (issues #688, #774)', () => {
  it('draws one dash per remaining bounce, and none on a last flight', () => {
    expect(trailSegmentsFor(0)).toBe(0);
    expect(trailSegmentsFor(1)).toBe(1);
    expect(trailSegmentsFor(2)).toBe(2);
  });

  it('gives each shipped starting budget its own count', () => {
    // Read from the balance data rather than restated, so a retuned budget is judged here.
    const { normal, fast, ricochet } = balance.shells;
    const starts = Object.entries({ normal, fast, ricochet }).map(([type, b]) => [type, trailSegmentsFor(b.bounces)]);
    expect(Object.fromEntries(starts)).toEqual({ normal: 1, fast: 0, ricochet: 2 });
    expect(new Set(starts.map(([, n]) => n)).size, 'two shipped types would start alike').toBe(starts.length);
  });

  it('clamps to the renderer budget at both ends', () => {
    expect(MAX_TRAIL_SEGMENTS).toBe(2);
    expect(trailSegmentsFor(7)).toBe(MAX_TRAIL_SEGMENTS);
    expect(trailSegmentsFor(-1), 'no negative row').toBe(0);
  });

  it('accepts exactly the styles it describes', () => {
    for (const style of SHELL_TRAIL_STYLES) expect(isShellTrailStyle(style)).toBe(true);
    expect(isShellTrailStyle('length')).toBe(false);
    expect(isShellTrailStyle(undefined)).toBe(false);
  });
});
