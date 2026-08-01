// DataTextures are CPU-side, so the whole generator is testable headlessly.
import { describe, it, expect } from 'vitest';
import { createSkinTexture } from './skins';
import { SKINS } from '../game/customization';

const pixelsOf = (skin: Exclude<(typeof SKINS)[number]['id'], 'solid'>, hex: string): Uint8ClampedArray =>
  (createSkinTexture(skin, hex)!.image.data as Uint8ClampedArray);

describe('createSkinTexture', () => {
  it('solid is the no-map default, every other skin mints a tiling texture', () => {
    expect(createSkinTexture('solid', '#3d7bd6')).toBeNull();
    // Population: every non-solid skin in the shipped list.
    for (const s of SKINS.filter((x) => x.id !== 'solid')) {
      const t = createSkinTexture(s.id, '#3d7bd6')!;
      expect(t, s.id).not.toBeNull();
      expect(t.wrapS, s.id).toBe(1000); // THREE.RepeatWrapping
      t.dispose();
    }
  });

  it('is deterministic: the same pick renders the same tank every session', () => {
    expect(pixelsOf('camo', '#d64545')).toEqual(pixelsOf('camo', '#d64545'));
  });

  it('tints from the chosen hull colour: red camo and green camo differ everywhere it matters', () => {
    const red = pixelsOf('camo', '#d64545');
    const green = pixelsOf('camo', '#4fae52');
    expect(red).not.toEqual(green);
    // The base tone dominates: sample a pixel and check the red channel leads on red.
    expect(red[0]).toBeGreaterThan(red[2]);
    expect(green[1]).toBeGreaterThan(green[0]);
  });

  it('every pattern actually patterns: at least two distinct tones per texture', () => {
    for (const s of SKINS.filter((x) => x.id !== 'solid')) {
      const px = pixelsOf(s.id as Exclude<(typeof SKINS)[number]['id'], 'solid'>, '#3d7bd6');
      const tones = new Set<string>();
      for (let i = 0; i < px.length; i += 4) tones.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
      expect(tones.size, s.id).toBeGreaterThan(1); // a one-tone "pattern" is solid with extra steps
    }
  });
});
