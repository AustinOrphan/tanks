import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { patchField, patchProfileField, profileIds, readProfileField } from './patch.mjs';

/**
 * Issues #359 and #908. These were unreachable while they lived in `run.mjs`, which calls
 * `main()` at the top level -- importing it to test them would have run a sweep.
 *
 * The real file is read rather than mocked: a patcher that works on a hand-written fixture
 * and not on `ai-profiles.json` is the only failure that matters here.
 */
const REAL = readFileSync(
  new URL('../../src/sim/config/data/ai-profiles.json', import.meta.url),
  'utf8',
);

const FIXTURE = `{
  "ALPHA": {
    "aimAccuracy": 0.55,
    "targetCommitmentTime": 1.5
  },
  "BETA": {
    "aimAccuracy": 0.7,
    "nested": { "targetCommitmentTime": 9 },
    "targetCommitmentTime": 1.5
  }
}
`;

describe('profileIds', () => {
  it('reads every profile in the shipped file', () => {
    const ids = profileIds(REAL);
    expect(ids).toHaveLength(8);
    expect(ids).toContain('STATIC_BASIC');
    expect(ids).toContain('BERSERKER_ROCKET');
    // Top-level keys only: a nested object's key must not be mistaken for a profile.
    expect(ids.every((id) => /^[A-Z0-9_]+$/.test(id))).toBe(true);
  });
});

describe('patchField: every profile at once', () => {
  it('moves all eight in the shipped file and says how many', () => {
    const { patched, count } = patchField(REAL, 'targetCommitmentTime', 2.25);
    expect(count).toBe(8);
    expect(patched).not.toBe(REAL);
    expect([...patched.matchAll(/"targetCommitmentTime":\s*2\.25/g)]).toHaveLength(8);
  });

  it('reports 0 for a field that is not there, rather than patching nothing quietly', () => {
    // The caller refuses the run on 0. Without that, the sweep would measure the SHIPPED
    // value and label it with the one it meant to set -- the dead-knob failure.
    expect(patchField(REAL, 'noSuchField', 1).count).toBe(0);
  });

  it('leaves the rest of the file byte-identical', () => {
    const { patched } = patchField(FIXTURE, 'targetCommitmentTime', 3);
    expect(patched.replace(/3\b/g, '1.5')).toBe(FIXTURE.replace(/9\b/g, '1.5'));
  });
});

describe('patchProfileField: one profile, and only that one', () => {
  it('moves the named profile and leaves the other seven at their value', () => {
    const { patched, count } = patchProfileField(REAL, 'RICOCHET_SNIPER', 'targetCommitmentTime', 0.75);
    expect(count).toBe(1);
    expect([...patched.matchAll(/"targetCommitmentTime":\s*0\.75/g)]).toHaveLength(1);
    // THE POINT OF THE WHOLE FUNCTION: the others must not move. Seven at the shipped 1.5.
    expect([...patched.matchAll(/"targetCommitmentTime":\s*1\.5/g)]).toHaveLength(7);
  });

  it('patches the right one — the value lands inside that profile s block', () => {
    const { patched } = patchProfileField(REAL, 'STATIC_BASIC', 'targetCommitmentTime', 0.25);
    const block = /"STATIC_BASIC"\s*:\s*\{[\s\S]*?\n {2}\}/.exec(patched)?.[0] ?? '';
    expect(block).toMatch(/"targetCommitmentTime":\s*0\.25/);
  });

  it('REFUSES an unknown profile rather than patching everything', () => {
    // The failure this guards: falling back to a global replace on a typo'd id would sweep
    // all eight while the report said one profile differed.
    const { patched, count } = patchProfileField(REAL, 'NO_SUCH_PROFILE', 'targetCommitmentTime', 2);
    expect(count).toBe(0);
    expect(patched).toBe(REAL);
  });

  it('REFUSES a field the profile does not have', () => {
    expect(patchProfileField(REAL, 'STATIC_BASIC', 'noSuchField', 2).count).toBe(0);
  });

  it('finds the profile s real closing brace, not the first one', () => {
    // BETA holds a nested object BEFORE its own field, deliberately. Scanning for the first
    // `}` ends BETA's block at the nested object's brace, so the field that matters is never
    // reached -- and the mutation that does exactly that SURVIVED an earlier version of this
    // fixture, which had BETA's own field first and so could not tell the two apart.
    const { patched, count } = patchProfileField(FIXTURE, 'BETA', 'targetCommitmentTime', 4);
    expect(count, 'BETA has two matches: the nested one and its own').toBe(2);
    // The discriminating assertion: BETA's OWN field, the one after the nested object.
    expect(patched).toMatch(/"nested":[^}]*\}[,\s]*"targetCommitmentTime":\s*4/);
    expect(patched).toMatch(/"ALPHA"[\s\S]*?"targetCommitmentTime":\s*1\.5/);
  });

  it('does not touch a profile that merely appears later in the file', () => {
    const { patched } = patchProfileField(FIXTURE, 'ALPHA', 'targetCommitmentTime', 4);
    expect(patched).toMatch(/"ALPHA"[\s\S]*?"targetCommitmentTime":\s*4/);
    expect(patched).toMatch(/"BETA"[\s\S]*?"targetCommitmentTime":\s*1\.5/);
  });
});

describe('readProfileField: what the profiles a sweep leaves alone should still say', () => {
  it('reads one profile s shipped value out of the real file', () => {
    // Every shipped profile carries 1.5 today (#891 records why). The assertion is that the
    // reader finds the value at all and scopes it to the named profile, not that it is 1.5:
    // the loop below is what would catch a reader that always returned the first match.
    for (const id of profileIds(REAL)) {
      expect(readProfileField(REAL, id, 'targetCommitmentTime'), id).toBe(1.5);
    }
  });

  it('reads the profile s OWN field, not a nested object s copy of it', () => {
    // BETA's nested block carries 9 and BETA itself carries 1.5. A reader that searched the
    // whole file, or stopped at the first `}`, would return 9 -- and the sweep would then
    // "verify" an untouched profile against a number that is not its own.
    expect(readProfileField(FIXTURE, 'BETA', 'targetCommitmentTime')).toBe(1.5);
    expect(readProfileField(FIXTURE, 'ALPHA', 'targetCommitmentTime')).toBe(1.5);
  });

  it('returns null for an absent profile or field, never 0', () => {
    // 0 is a legal targetCommitmentTime -- `validate.ts` accepts non-negative and the sweep
    // sweeps it -- so a missing value reported as 0 would read as "retarget immediately".
    expect(readProfileField(REAL, 'NO_SUCH_PROFILE', 'targetCommitmentTime')).toBeNull();
    expect(readProfileField(REAL, 'STATIC_BASIC', 'noSuchField')).toBeNull();
  });

  it('reads a real 0 as 0, which is what makes the null above mean something', () => {
    const zeroed = patchProfileField(FIXTURE, 'ALPHA', 'targetCommitmentTime', 0).patched;
    expect(readProfileField(zeroed, 'ALPHA', 'targetCommitmentTime')).toBe(0);
    // THE CONTROL for the previous test: without this, `toBeNull()` would also pass against a
    // reader that returned null for every falsy value.
    expect(readProfileField(zeroed, 'BETA', 'targetCommitmentTime')).toBe(1.5);
  });

  it('agrees with the patcher about where a profile ends', () => {
    // The two share `profileBlock` for exactly this reason. If they ever disagreed, a sweep
    // would edit one span and verify another -- so the round trip is asserted rather than
    // assumed: patch BETA only, then read both back.
    const patched = patchProfileField(FIXTURE, 'BETA', 'targetCommitmentTime', 4).patched;
    expect(readProfileField(patched, 'BETA', 'targetCommitmentTime')).toBe(4);
    expect(readProfileField(patched, 'ALPHA', 'targetCommitmentTime')).toBe(1.5);
    // And the documented asymmetry, pinned so neither side drifts onto the other: the PATCHER
    // rewrote the nested copy too (the test above pins that at count 2), while the READER
    // reports only BETA's own field. `configFor` resolves the profile's own value, so that is
    // the one the read-back compares; a reader that matched the patcher here would report 4
    // for a nested block nothing reads.
    expect(patched).toContain('"nested": { "targetCommitmentTime": 4 }');
    expect(readProfileField(patched, 'BETA', 'targetCommitmentTime')).not.toBe(9);
  });
});
