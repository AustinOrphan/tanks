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

  it('points all SFX and music paths under the configured base, not the site root', () => {
    // Vitest resolves BASE_URL to '/', so this cannot verify the value the
    // PRODUCTION build emits -- a unit test in this environment structurally
    // can't. Its job is narrower: catch a path that hardcodes a leading '/'
    // and so bypasses base rewriting entirely (which is what shipped before,
    // and would 404 all ten files on any non-root host). The build-output
    // assertion in CI is the real regression guard for the deployed base.
    const base = import.meta.env.BASE_URL;
    for (const path of Object.values(AUDIO_MANIFEST.sfx)) {
      expect(path.startsWith(`${base}audio/`)).toBe(true);
    }
    expect(AUDIO_MANIFEST.music.startsWith(`${base}audio/`)).toBe(true);
  });
});
