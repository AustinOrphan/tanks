export interface AudioManifest {
  sfx: Record<string, string>;
  music: string;
}

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
