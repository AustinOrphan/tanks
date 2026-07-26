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

// Paths resolve against Vite's public/ dir, which is served at the site root,
// so public/audio/cannon.wav is reachable at /audio/cannon.wav.
export const AUDIO_MANIFEST: AudioManifest = {
  sfx: {
    cannon: '/audio/cannon.wav',
    'cannon-enemy': '/audio/cannon-enemy.wav',
    ping: '/audio/ping.wav',
    explosion: '/audio/explosion.wav',
    'mine-drop': '/audio/mine-drop.wav',
    'mine-arm': '/audio/mine-arm.wav',
    'mine-boom': '/audio/mine-boom.wav',
    victory: '/audio/victory.wav',
    defeat: '/audio/defeat.wav',
  },
  music: '/audio/music-loop.wav',
};
