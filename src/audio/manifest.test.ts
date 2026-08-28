import { describe, it, expect } from 'vitest';
import { AUDIO_MANIFEST, AUTHORED_LAYOUT, audioUrl } from './manifest';
import manifestSource from './manifest.ts?raw';

/** Every sound the game can ask for. Mirrors `SfxKey` in synth.ts. */
const REQUIRED_KEYS = [
  'cannon',
  'cannon-enemy',
  'ping',
  'explosion',
  'mine-drop',
  'mine-arm',
  'mine-fuse-warn',
  'mine-trip',
  'mine-boom',
  'victory',
  'defeat',
];

describe('AUDIO_MANIFEST', () => {
  it('requests no audio files, because none has ever been committed', () => {
    // Not a placeholder assertion: declaring the ten files while `public/audio/` held
    // only `.gitkeep` cost a MEASURED 10 requests and 93,790 bytes on every load of the
    // deployed site (9,379 bytes per 404 body, no cache-control on any of them, so
    // none of it cached). Roughly half the gzipped bundle, spent to rediscover that
    // the files are still missing.
    //
    // This fails the moment someone re-adds an entry, which is the point: adding one
    // is a commitment that the file is actually in public/audio/ and licensed under
    // CREDITS.md. Deleting this test to make that green is the failure mode to avoid.
    expect(Object.keys(AUDIO_MANIFEST.sfx)).toEqual([]);
    expect(AUDIO_MANIFEST.music).toBeNull();
  });

  it('still knows the layout an authored set would take', () => {
    // AUTHORED_LAYOUT is what keeps the engine's file-loading path under test while
    // nothing is committed, so it must stay a COMPLETE description of the sounds the
    // game plays -- otherwise re-enabling it would ship a set with holes.
    expect(Object.keys(AUTHORED_LAYOUT.sfx).sort()).toEqual([...REQUIRED_KEYS].sort());
    expect(AUTHORED_LAYOUT.music).toBeTruthy();
  });

  it('builds audio paths from the configured base, not the site root', () => {
    // This one has to be a SOURCE check, and the reason is worth stating because the
    // obvious behavioural version cannot fail. Vitest resolves BASE_URL to '/', so
    // `audioUrl('x.wav')` returns '/audio/x.wav' -- byte-identical to what a hardcoded
    // '/audio/' would return. Comparing the function's output against `${base}audio/x`
    // computes the same expression twice: measured, hardcoding the leading slash
    // passed all 181 tests in src/audio.
    //
    // Nor does the build catch it any more: production imports only AUDIO_MANIFEST,
    // which is empty, so AUTHORED_LAYOUT is tree-shaken and `grep 'audio/.*\.wav'
    // dist/assets/*.js` finds nothing for CI's portability check to look at.
    //
    // So assert the mechanism instead. These files live in public/, which Vite copies
    // verbatim and never rewrites, so a bare '/audio/cannon.wav' is opaque to the
    // bundler and setting `base` does NOT fix it -- served from a subpath the browser
    // would ask for <origin>/audio/... instead of <origin>/tanks/audio/... .
    // Comments STRIPPED first. The draft of this assertion matched the JSDoc above
    // `audioUrl`, which names `import.meta.env.BASE_URL` in prose -- so replacing the
    // function body with a hardcoded '/' passed the whole suite AND the portability
    // gate. Third tautology of this change; the mutation sweep found all three.
    const code = manifestSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code, 'audioUrl no longer derives its path from the configured base').toContain(
      'import.meta.env.BASE_URL',
    );

    // And each key maps to the file NAMED AFTER IT. Derive the expected name from the
    // key, never from the path: an earlier draft asserted
    // `path === audioUrl(path.split('/').pop())`, which rebuilds the filename out of
    // the very path under test and so passed when `cannon` was pointed at `shot.wav`.
    expect(Object.keys(AUTHORED_LAYOUT.sfx).length).toBeGreaterThan(0);
    for (const [key, path] of Object.entries(AUTHORED_LAYOUT.sfx)) {
      expect(path, `sfx key "${key}" does not point at ${key}.wav`).toBe(
        audioUrl(`${key}.wav`),
      );
    }
    expect(AUTHORED_LAYOUT.music).toBe(audioUrl('music-loop.wav'));
  });
});
