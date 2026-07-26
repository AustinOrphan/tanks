export interface AudioManifest {
  sfx: Record<string, string>;
  music: string;
}

/**
 * Master volume at boot. Lives here, in the audio layer's dependency-free data
 * module, because BOTH the engine (which applies it) and the HUD slider (which
 * displays it) must read the same number -- the HUD is game-layer and must not
 * pull `howler` in through engine.ts just to learn the default.
 */
export const DEFAULT_VOLUME = 0.6;

/**
 * Base the audio URLs on Vite's configured base rather than the site root.
 *
 * These files live in public/, which Vite copies verbatim and never rewrites --
 * a bare string like '/audio/cannon.wav' is opaque to the bundler, so setting
 * `base` does NOT fix it. Served from a subpath the browser would ask for
 * <origin>/audio/cannon.wav instead of <origin>/tanks/audio/cannon.wav and all
 * ten files would 404. `import.meta.env.BASE_URL` is the value Vite actually
 * built with, and already carries its trailing slash.
 */
const BASE = import.meta.env.BASE_URL;

export const AUDIO_MANIFEST: AudioManifest = {
  sfx: {
    cannon: `${BASE}audio/cannon.wav`,
    'cannon-enemy': `${BASE}audio/cannon-enemy.wav`,
    ping: `${BASE}audio/ping.wav`,
    explosion: `${BASE}audio/explosion.wav`,
    'mine-drop': `${BASE}audio/mine-drop.wav`,
    'mine-arm': `${BASE}audio/mine-arm.wav`,
    'mine-boom': `${BASE}audio/mine-boom.wav`,
    victory: `${BASE}audio/victory.wav`,
    defeat: `${BASE}audio/defeat.wav`,
  },
  music: `${BASE}audio/music-loop.wav`,
};
