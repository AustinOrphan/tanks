import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { QUALITY_PRESETS, qualityFor } from './quality';
import {
  QUALITY_PRESET_IDS,
  DEFAULT_QUALITY_PRESET,
  type QualityPreset,
} from '../presentation/quality';
import { BILLOW_COUNT } from './muzzle-smoke';

describe('QUALITY_PRESETS.high matches scene.ts literals exactly', () => {
  // Pinned against LITERALS copied from scene.ts, not against QUALITY_PRESETS.high
  // itself -- comparing the table to itself is the tautology CLAUDE.md calls out by
  // name ("angle: 0 in a fixture whose angle is 0"). Each assertion fails if the
  // preset drifts from the line it claims to mirror, independent of the table.
  it('muzzleSmoke draws EVERY billow the effect has -- pinned to the table, not to a copy of its length', () => {
    // The one field here that has an independent source to be pinned against, and the
    // reason it is pinned that way: `high` is the preset an absent flag resolves to, so
    // it has to render what a tree with no quality knob at all rendered. A literal 3
    // would still read as correct on the day someone adds a fourth billow to
    // muzzle-smoke.ts and quietly leaves `high` drawing three of them.
    expect(QUALITY_PRESETS.high.muzzleSmoke?.billowsPerCloud).toBe(BILLOW_COUNT);
  });
  it('muzzleSmoke keeps the cloud ceiling issue #536 derived (32)', () => {
    // A literal, because since the smoke gained a quality budget this IS the definition --
    // the number moved out of muzzle-smoke.ts and its derivation (8 guns * 4 clouds at the
    // floor cooldown) moved with it. Nothing else in the tree can be asked what it should be, so the
    // assertion's job is to make a change to it deliberate rather than incidental.
    expect(QUALITY_PRESETS.high.muzzleSmoke?.maxClouds).toBe(32);
  });
  it('antialias is true (scene.ts:116)', () => {
    expect(QUALITY_PRESETS.high.antialias).toBe(true);
  });
  it('pixelRatioCap is 2 (scene.ts:117, :293)', () => {
    expect(QUALITY_PRESETS.high.pixelRatioCap).toBe(2);
  });
  it('shadowMapSize is 2048 (scene.ts:168)', () => {
    expect(QUALITY_PRESETS.high.shadowMapSize).toBe(2048);
  });
  it('shadowType is PCFSoftShadowMap (scene.ts:119)', () => {
    expect(QUALITY_PRESETS.high.shadowType).toBe(THREE.PCFSoftShadowMap);
  });
});

describe('DEFAULT_QUALITY_PRESET', () => {
  it('is high, so an absent flag reproduces the shipped render exactly', () => {
    expect(DEFAULT_QUALITY_PRESET).toBe('high');
  });
});

describe('qualityFor', () => {
  it('resolves null (flag absent, or a garbage value already rejected upstream) to high', () => {
    expect(qualityFor(null)).toEqual(QUALITY_PRESETS.high);
  });

  it('resolves each named preset to its own table entry -- population: all 3 QualityPreset values', () => {
    // The population comes from the exported id list, not from a copy of it: since issue
    // #540 those ids are also the domain of a stored player setting, so a preset added
    // there must be swept here without an edit.
    const presets: readonly QualityPreset[] = QUALITY_PRESET_IDS;
    for (const p of presets) {
      expect(qualityFor(p)).toEqual(QUALITY_PRESETS[p]);
    }
  });
});

describe('medium and low are real steps down, not copies of high', () => {
  it('every numeric knob is non-increasing from high to medium to low', () => {
    const { low, medium, high } = QUALITY_PRESETS;
    expect(medium.pixelRatioCap).toBeLessThan(high.pixelRatioCap);
    expect(low.pixelRatioCap).toBeLessThan(medium.pixelRatioCap);
    expect(medium.shadowMapSize).toBeLessThan(high.shadowMapSize);
    expect(low.shadowMapSize).toBeLessThan(medium.shadowMapSize);
  });

  it('low turns antialias off; medium and high leave it on', () => {
    expect(QUALITY_PRESETS.low.antialias).toBe(false);
    expect(QUALITY_PRESETS.medium.antialias).toBe(true);
    expect(QUALITY_PRESETS.high.antialias).toBe(true);
  });

  it('low DROPS the smoke rather than quietening it, and medium keeps a cheaper version', () => {
    // The owner's three-way ruling on muzzle smoke, one line each. `null` at low is load
    // bearing and is asserted as null rather than as falsy: renderer.ts reads this field
    // to decide whether to CONSTRUCT the system at all, and a preset that named a very
    // small cloud budget instead would still pay `spawn` and `update` every frame and
    // still hold pooled sprites in the scene -- the exact "off" that is not off.
    expect(QUALITY_PRESETS.low.muzzleSmoke).toBeNull();
    // The negative control for that: medium and high must NOT be null, or "low drops it"
    // would be true of a table that had dropped the effect everywhere.
    expect(QUALITY_PRESETS.medium.muzzleSmoke).not.toBeNull();
    expect(QUALITY_PRESETS.high.muzzleSmoke).not.toBeNull();
  });

  it('medium draws fewer billows and holds fewer clouds than high, and still draws some', () => {
    const medium = QUALITY_PRESETS.medium.muzzleSmoke;
    const high = QUALITY_PRESETS.high.muzzleSmoke;
    if (!medium || !high) throw new Error('medium and high must both carry a smoke budget');
    // Both directions, because both are ways of getting the ruling wrong: a medium equal
    // to high is not a cheapening, and a medium at zero billows is low wearing medium's
    // name. The billow count is the lever that cuts draw calls and fill together (see
    // CHEAP_MUZZLE_SMOKE); the ceiling is what bounds the crowded frame.
    expect(medium.billowsPerCloud).toBeGreaterThan(0);
    expect(medium.billowsPerCloud).toBeLessThan(high.billowsPerCloud);
    expect(medium.maxClouds).toBeGreaterThan(0);
    expect(medium.maxClouds).toBeLessThan(high.maxClouds);
  });

  it('the shadow filters step DOWN in order: PCFSoft, plain PCF, Basic', () => {
    // Pinned as literals, not distinctness: review proved that swapping medium's and
    // low's filters (an internally-incoherent table where "low" shadows better than
    // "medium") survived the whole 2144-test suite when this only asserted a Set of
    // size 3. Breaks if any preset's filter moves off its rung.
    expect(QUALITY_PRESETS.high.shadowType).toBe(THREE.PCFSoftShadowMap);
    expect(QUALITY_PRESETS.medium.shadowType).toBe(THREE.PCFShadowMap);
    expect(QUALITY_PRESETS.low.shadowType).toBe(THREE.BasicShadowMap);
  });
});
