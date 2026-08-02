// A circular import between music-data.ts and chords.ts left a module-level
// const uninitialised, and the symptom was a ReferenceError AT IMPORT TIME --
// not a wrong note. It survived `npx vitest run src/audio/` reporting "96
// passed", because a file that fails to load contributes no tests to the count
// and the failure sat above the summary line.
//
// This pins the layering that fixed it: note parsing is a leaf both sides use.
import { describe, it, expect } from 'vitest';
import notesSrc from './notes.ts?raw';
import chordsSrc from './chords.ts?raw';
import dataSrc from './music-data.ts?raw';

const localImports = (src: string): string[] =>
  [...src.matchAll(/from '\.\/([\w-]+)'/g)].map((m) => m[1]);

describe('the audio module graph stays acyclic', () => {
  it('read the sources at all', () => {
    // ?raw returns an empty string if the loader is not configured, which would
    // make every assertion below pass vacuously -- the same trap hud.css.test.ts
    // documents.
    for (const [name, src] of [['notes', notesSrc], ['chords', chordsSrc], ['music-data', dataSrc]] as const) {
      expect(typeof src, name).toBe('string');
      expect(src.length, name).toBeGreaterThan(200);
    }
  });

  it('keeps note parsing a LEAF: notes.ts imports nothing local', () => {
    expect(localImports(notesSrc)).toEqual([]);
  });

  it('never lets chords.ts and music-data.ts import each other', () => {
    // The exact cycle that broke. Either direction alone is fine; both is not.
    const chordsImportsData = localImports(chordsSrc).includes('music-data');
    const dataImportsChords = localImports(dataSrc).includes('chords');
    expect(chordsImportsData && dataImportsChords).toBe(false);
  });

  it('imports every audio module cleanly, in isolation', async () => {
    // The direct regression test: importing any one of these FIRST must not
    // throw. Vitest resets the module registry per file, so this exercises cold
    // import order rather than a already-warmed graph.
    for (const m of ['./notes', './chords', './melody', './music-data', './music', './synth']) {
      await expect(import(/* @vite-ignore */ m), m).resolves.toBeDefined();
    }
  });
});
