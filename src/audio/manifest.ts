export interface AudioManifest {
  /** Authored SFX files by key. An absent key is played by the synth instead. */
  sfx: Record<string, string>;
  /** The authored music loop, or null when there is none. */
  music: string | null;
}

/**
 * Master volume at boot. Lives here, in the audio layer's dependency-free data
 * module, because BOTH the engine (which applies it) and the HUD slider (which
 * displays it) must read the same number -- the HUD is game-layer and must not
 * pull `howler` in through engine.ts just to learn the default.
 */
export const DEFAULT_VOLUME = 0.6;

/**
 * Where an authored audio file lives, given its filename.
 *
 * Based on Vite's configured base rather than the site root. These files live in
 * public/, which Vite copies verbatim and never rewrites -- a bare string like
 * '/audio/cannon.wav' is opaque to the bundler, so setting `base` does NOT fix it.
 * Served from a subpath the browser would ask for <origin>/audio/cannon.wav instead
 * of <origin>/tanks/audio/cannon.wav. `import.meta.env.BASE_URL` is the value Vite
 * actually built with, and already carries its trailing slash.
 */
export function audioUrl(file: string): string {
  return `${import.meta.env.BASE_URL}audio/${file}`;
}

/**
 * The shape an authored set takes, and the loader's test fixture.
 *
 * This is NOT what ships. It documents the naming convention -- one file per SFX key
 * plus the loop -- and it keeps `createAudioEngine`'s file-loading path under test
 * while no file exists, so that path does not rot into something that breaks the day
 * a real asset lands. Shipping an authored set is then one line: assign this to
 * AUDIO_MANIFEST.
 */
export const AUTHORED_LAYOUT: AudioManifest = {
  sfx: {
    cannon: audioUrl('cannon.wav'),
    'cannon-enemy': audioUrl('cannon-enemy.wav'),
    ping: audioUrl('ping.wav'),
    explosion: audioUrl('explosion.wav'),
    'mine-drop': audioUrl('mine-drop.wav'),
    'mine-arm': audioUrl('mine-arm.wav'),
    'mine-boom': audioUrl('mine-boom.wav'),
    victory: audioUrl('victory.wav'),
    defeat: audioUrl('defeat.wav'),
  },
  music: audioUrl('music-loop.wav'),
};

/**
 * What the game actually loads: NOTHING, because nothing has ever been committed.
 *
 * `public/audio/` has held only `.gitkeep` since the directory was created, and
 * `git log --all --diff-filter=A -- '*.wav' '*.mp3' '*.ogg'` is empty. Declaring the
 * ten files anyway cost a measured 10 requests and 93,790 bytes on EVERY load of the
 * deployed site -- 9,379 bytes per 404 body, none of them carrying a `cache-control`
 * header, so none of it is ever cached. That is about half the gzipped bundle, spent
 * to discover ten times per load that the files are still missing.
 *
 * The game does not sound different for this. Every key already reached the synth via
 * `beep()`, because a 404 marks the key null on `loaderror` and `play()` falls
 * through; the only change is that it no longer asks first. `src/audio/synth.ts` is
 * the real voice and has been since PR #64.
 *
 * This stays empty until a licensed or hand-authored set exists. CREDITS.md forbids
 * AI-generated audio and unverified-licence samples, so that is a deliberate decision
 * with an owner, not an oversight -- tracked as issue #86.
 */
export const AUDIO_MANIFEST: AudioManifest = {
  sfx: {},
  music: null,
};
