// Issue #738: the benchmark runner's arm parsing and run order. The browser half of
// tools/bench/runs.mjs is exercised by the on-demand workflow; these are the pure parts it builds on.
import { readFileSync } from 'node:fs';

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

/**
 * Issue #877. Worse here than a timeout: a benchmark run that survives the ~40 s the two audio constructors cost reports frame times shaped by that stall.
 *
 * A source-text assertion, like `tools/screens/capture.test.ts`'s, because what it guards
 * happens only in a real browser. It lives HERE rather than in
 * `tools/shared/audio-context.test.ts`'s sweep because this file already imports the module:
 * the mutation harness measures an entry through Vitest's own dependency graph, and a test
 * that only reads a file as text relates to nothing.
 */
describe('runs.mjs: removing the AudioContext constructor before boot', () => {
  it('installs the override on the workload context, unconditionally, before it navigates', () => {
    const src = readFileSync(new URL('./runs.mjs', import.meta.url), 'utf8');
    // Exactly two spaces: the body's own indentation. `\s*` would accept the call nested
    // inside an `if`, which is the one shape this exists to reject -- an override only some
    // machines installed would let two machines benchmark different pages, one of them still
    // building the AudioContexts whose stall the header above describes.
    const call = /^ {2}await context\.addInitScript\(audioContextOverrideSource\(\)\);$/m;
    expect(src, 'the override is gone, conditional, or no longer on its own line').toMatch(call);
    const at = src.search(call);
    const firstGoto = src.indexOf('.goto(');
    expect(at, 'the override call was not found').toBeGreaterThan(-1);
    expect(firstGoto, 'no navigation was found').toBeGreaterThan(-1);
    expect(at, 'the override is installed after the first navigation').toBeLessThan(firstGoto);
  });
});
