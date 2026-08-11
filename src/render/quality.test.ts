import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { QUALITY_PRESETS, DEFAULT_QUALITY_PRESET, qualityFor, type QualityPreset } from './quality';

describe('QUALITY_PRESETS.high matches scene.ts literals exactly', () => {
  // Pinned against LITERALS copied from scene.ts, not against QUALITY_PRESETS.high
  // itself -- comparing the table to itself is the tautology CLAUDE.md calls out by
  // name ("angle: 0 in a fixture whose angle is 0"). Each assertion fails if the
  // preset drifts from the line it claims to mirror, independent of the table.
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
    const presets: QualityPreset[] = ['low', 'medium', 'high'];
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
