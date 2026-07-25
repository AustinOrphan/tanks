import { Howl, Howler } from 'howler';
import type { AudioManifest } from './manifest';

export interface AudioEngine {
  play(key: string, opts?: { rate?: number; volume?: number }): void;
  startMusic(): void;
  stopMusic(): void;
  setMuted(muted: boolean): void;
  toggleMute(): boolean;
  isMuted(): boolean;
  setVolume(v: number): void;
  dispose(): void;
}

const MUSIC_VOLUME = 0.25;

// Base frequencies for the procedural fallback tone per SFX key (Hz).
const FALLBACK_FREQ: Record<string, number> = {
  cannon: 180,
  'cannon-enemy': 150,
  ping: 900,
  explosion: 90,
  'mine-drop': 300,
  'mine-arm': 660,
  'mine-boom': 70,
  victory: 520,
  defeat: 160,
};

export function createAudioEngine(manifest: AudioManifest): AudioEngine {
  const sounds: Record<string, Howl | null> = {};
  let music: Howl | null = null;
  let muted = false;
  let masterVolume = 1;
  let ctx: AudioContext | null = null;

  // Load each SFX with pooling for overlap. A missing/broken asset is marked
  // null on loaderror and served by the procedural fallback instead.
  for (const key of Object.keys(manifest.sfx)) {
    try {
      const howl = new Howl({ src: [manifest.sfx[key]], preload: true, pool: 8, volume: 1 });
      howl.on('loaderror', () => {
        sounds[key] = null;
      });
      sounds[key] = howl;
    } catch {
      sounds[key] = null;
    }
  }

  try {
    music = new Howl({ src: [manifest.music], loop: true, volume: MUSIC_VOLUME, preload: true });
    music.on('loaderror', () => {
      music = null;
    });
  } catch {
    music = null;
  }

  function ensureCtx(): AudioContext | null {
    if (ctx) return ctx;
    const AC =
      typeof window !== 'undefined'
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!AC) return null;
    ctx = new AC();
    return ctx;
  }

  // Procedural fallback: a short decaying tone so dev is never blocked on assets.
  // No-ops safely when there is no Web Audio (e.g. headless test/node env).
  function beep(key: string, opts?: { rate?: number; volume?: number }): void {
    if (muted) return;
    const audio = ensureCtx();
    if (!audio) return;
    const freq = (FALLBACK_FREQ[key] ?? 440) * (opts?.rate ?? 1);
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    osc.type = key === 'explosion' || key === 'mine-boom' ? 'square' : 'sine';
    const vol = 0.2 * masterVolume * (opts?.volume ?? 1);
    gain.gain.setValueAtTime(vol, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.2);
  }

  return {
    play(key, opts) {
      const howl = sounds[key];
      if (howl) {
        const id = howl.play();
        if (opts?.rate !== undefined) howl.rate(opts.rate, id);
        if (opts?.volume !== undefined) howl.volume(opts.volume, id);
      } else {
        beep(key, opts);
      }
    },
    startMusic() {
      if (music && !music.playing()) music.play();
    },
    stopMusic() {
      if (music) music.stop();
    },
    setMuted(m) {
      muted = m;
      Howler.mute(m);
    },
    toggleMute() {
      muted = !muted;
      Howler.mute(muted);
      return muted;
    },
    isMuted() {
      return muted;
    },
    setVolume(v) {
      masterVolume = Math.max(0, Math.min(1, v));
      Howler.volume(masterVolume);
    },
    dispose() {
      for (const k of Object.keys(sounds)) sounds[k]?.unload();
      music?.unload();
      if (ctx) {
        void ctx.close();
        ctx = null;
      }
    },
  };
}
