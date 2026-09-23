import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { patchField, patchProfileField, profileIds } from './patch.mjs';

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
