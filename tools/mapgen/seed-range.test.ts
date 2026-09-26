import { describe, expect, it } from 'vitest';

// @ts-expect-error -- lib.mjs is plain JS with no declarations, like its siblings here.
import { seedRange } from './lib.mjs';

/**
 * `seedRange` exists so a sweep can be asked for a SECOND, DISJOINT sample.
 *
 * The property under test is disjointness, not arithmetic. A ranking taken from one seed set
 * is not a finding -- on the AI sweep a per-profile ordering held across all four commitment
 * values at n = 50-154 per cell and flipped outright on a disjoint set -- and `sweep.mjs`
 * could only ever run seeds `1..N`, so the set that catches that could not be requested.
 *
 * Tested here rather than through `sweep.mjs` because that file runs its whole sweep at
 * import: there is no way to import it and ask what seeds it would use without generating
 * every board first.
 */
describe('mapgen seed ranges (issue #821)', () => {
  it('runs offset+1 through offset+count, so offset 0 reproduces the published sweeps', () => {
    // Every sweep table in the specs was taken over seeds starting at 1. An offset of 0 has
    // to mean exactly that, or the new flag silently re-bases every number already published.
    expect(seedRange(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(seedRange(30, 3)).toEqual([31, 32, 33]);
    expect(seedRange(0, 1)).toEqual([1]);
  });

  it('gives two disjoint samples when the offset is the first sample size', () => {
    // THE WHOLE POINT OF THE FLAG. `--seeds 30` then `--seeds 30 --seed-offset 30`.
    const a = seedRange(0, 30);
    const b = seedRange(30, 30);
    expect(a).toHaveLength(30);
    expect(b).toHaveLength(30);
    expect(a.filter((s: number) => b.includes(s))).toEqual([]);
    // Adjacent as well as disjoint: nothing is skipped between them, so the two together are
    // the same population a single `--seeds 60` would have swept.
    expect([...a, ...b]).toEqual(seedRange(0, 60));
  });

  it('overlaps when the offset is smaller than the first sample, which is the misuse to catch', () => {
    // The negative control for the assertion above: this pair is NOT disjoint, so a
    // `seedRange` that ignored its offset would make the previous case pass and this one fail.
    const a = seedRange(0, 30);
    const c = seedRange(10, 30);
    expect(a.filter((s: number) => c.includes(s))).toHaveLength(20);
  });

  it('throws on the inputs a mistyped flag produces, rather than sweeping nothing', () => {
    // `Number(arg('--seeds'))` of a missing or misspelled value is NaN, and a loop over NaN
    // runs zero times -- the sweep would print empty rows and read as a generator that
    // accepts nothing. Measured before this guard: that is exactly what it did.
    expect(() => seedRange(0, Number.NaN)).toThrow(/positive integer/);
    expect(() => seedRange(Number.NaN, 10)).toThrow(/non-negative integer/);
    expect(() => seedRange(-1, 10)).toThrow(/non-negative integer/);
    expect(() => seedRange(0, 0)).toThrow(/positive integer/);
    expect(() => seedRange(1.5, 10)).toThrow(/non-negative integer/);
  });
});
