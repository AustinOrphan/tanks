import { describe, it, expect } from 'vitest';
import { AUDIO_MANIFEST } from './manifest';

const REQUIRED_KEYS = [
  'cannon',
  'cannon-enemy',
  'ping',
  'explosion',
  'mine-drop',
  'mine-arm',
  'mine-boom',
  'victory',
  'defeat',
];

describe('AUDIO_MANIFEST', () => {
  it('defines every required SFX key', () => {
    for (const key of REQUIRED_KEYS) {
      expect(AUDIO_MANIFEST.sfx[key], `missing sfx key: ${key}`).toBeTruthy();
    }
  });

  it('has no unexpected extra SFX keys', () => {
    expect(Object.keys(AUDIO_MANIFEST.sfx).sort()).toEqual([...REQUIRED_KEYS].sort());
  });

  it('points all SFX and music paths under /audio/', () => {
    for (const path of Object.values(AUDIO_MANIFEST.sfx)) {
      expect(path.startsWith('/audio/')).toBe(true);
    }
    expect(AUDIO_MANIFEST.music.startsWith('/audio/')).toBe(true);
  });
});
