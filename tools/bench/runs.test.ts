// Issue #738: the benchmark runner's arm parsing and run order. The browser half of
// tools/bench/runs.mjs is exercised by the on-demand workflow; these are the pure parts it builds on.
import { describe, expect, it } from 'vitest';
import { armQuery, runOrder } from './runs.mjs';

describe('the benchmark runner (issue #738)', () => {
  it('turns an arm into the query flags the page reads', () => {
    expect(armQuery('high')).toBe('&quality=high');
    expect(armQuery('low+antialias=on')).toBe('&quality=low&antialias=on');
    expect(armQuery('high+shadowMapSize=512+fillRimLights=off')).toBe('&quality=high&shadowMapSize=512&fillRimLights=off');
  });

  it('refuses an arm that does not start with a preset, or an override that is not flag=value', () => {
    expect(() => armQuery('ultra')).toThrow('arm "ultra": starts with low, medium or high');
    expect(() => armQuery('high+antialias')).toThrow('arm "high+antialias": "antialias" is not flag=value');
    expect(() => armQuery('high+seed=7&bots=0')).toThrow('"seed=7&bots=0" is not flag=value');
  });

  it('interleaves the arms round by round, so drift over the sitting lands on every arm', () => {
    expect(runOrder(['high', 'low'], 3)).toEqual([
      { round: 1, arm: 'high' },
      { round: 1, arm: 'low' },
      { round: 2, arm: 'high' },
      { round: 2, arm: 'low' },
      { round: 3, arm: 'high' },
      { round: 3, arm: 'low' },
    ]);
  });
});
