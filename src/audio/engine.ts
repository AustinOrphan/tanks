import { Howl, Howler } from 'howler';
import { DEFAULT_VOLUME, type AudioManifest } from './manifest';

export interface AudioEngine {
  play(key: string, opts?: { rate?: number; volume?: number }): void;
  startMusic(): void;
  stopMusic(): void;
  setMuted(muted: boolean): void;
  toggleMute(): boolean;
  isMuted(): boolean;
  setVolume(v: number): void;
  getVolume(): number;
  /**
   * Open the audio context from inside a user-gesture handler (the Start
   * button). Safari/iOS will not start a context resumed from anywhere else,
   * and the sim's sounds are emitted from the rAF loop, which is never a
   * gesture. Safe to call repeatedly.
   */
  unlock(): void;
  dispose(): void;
}

const MUSIC_VOLUME = 0.25;

// Cap on simultaneous procedural voices. A mine chain-reaction can emit a
// dozen SFX on one tick; identical tones started at the same currentTime sum
// constructively, so without a cap the game's most dramatic moment is the one
// that clips into digital noise. Excess voices are dropped, not queued --
// a late explosion is worse than a missing one.
const MAX_VOICES = 8;
// Per-voice gain. MAX_VOICES * VOICE_GAIN stays under 1.0 so a full chorus
// cannot clip even before the compressor.
const VOICE_GAIN = 0.12;
// A WebKit resume() issued outside a user gesture is parked on
// [[pending promises]] and may never settle, so `.finally()` may never run.
// Time the latch out rather than letting it stick true for the session.
const RESUME_LATCH_TIMEOUT_MS = 1000;

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
  let masterVolume = DEFAULT_VOLUME;
  let ctx: AudioContext | null = null;
  let masterBus: AudioNode | null = null;
  let activeVoices = 0;
  let disposed = false;

  // Push the default through immediately. Howler's own default is 1.0, so
  // deferring this until the first slider drag leaves the HUD showing
  // DEFAULT_VOLUME while the game is actually playing at full volume.
  Howler.volume(masterVolume);

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

  // True while a resume() is in flight. Browsers suspend a context created
  // before a user gesture and can re-suspend a running one (tab hidden, OS
  // audio focus loss), so a suspended context must be retried -- but resume()
  // is ASYNCHRONOUS and, on WebKit, a resume issued outside a user gesture is
  // parked on [[pending promises]] and may never settle at all. Without this
  // latch, `state` stays 'suspended' and every sound from the rAF loop starts
  // another resume: one retained pending promise per shot fired, forever.
  let resuming = false;

  // `force` is for the user-gesture path (unlock). The latch above exists to
  // throttle the rAF loop, but a WebKit resume that never settles leaves it
  // stuck true forever -- which would make the latch swallow the one call that
  // can actually succeed. A gesture is rare and user-initiated: always retry.
  function tryResume(c: AudioContext, force = false): void {
    if (c.state !== 'suspended') return;
    if (resuming && !force) return;
    resuming = true;
    // .catch rather than `void`: resume() rejects with InvalidStateError on a
    // closed context, and older WebKit rejected on gesture-policy failures.
    // `void` would surface those as Uncaught (in promise) console noise.
    c.resume()
      .catch(() => {})
      .finally(() => {
        resuming = false;
      });
    // Belt and braces: if that promise never settles, release the latch anyway
    // so a later gesture is not swallowed by a permanently-stuck `resuming`.
    setTimeout(() => {
      resuming = false;
    }, RESUME_LATCH_TIMEOUT_MS);
  }

  function ensureCtx(force = false): AudioContext | null {
    if (disposed) return null;
    if (ctx) {
      tryResume(ctx, force);
      return ctx;
    }
    const AC =
      typeof window !== 'undefined'
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!AC) return null;
    ctx = new AC();
    tryResume(ctx, force);
    return ctx;
  }

  /**
   * Voices -> master gain -> [compressor] -> destination. The compressor is the
   * safety net for the case the voice cap cannot cover: several voices of
   * genuinely different pitch landing on one tick still sum, and a limiter is
   * cheaper than reasoning about every combination.
   */
  function ensureBus(audio: AudioContext): AudioNode {
    if (masterBus) return masterBus;
    const gain = audio.createGain();
    gain.gain.value = 1;
    // Feature-detected: not every environment (or test fake) implements it.
    if (typeof audio.createDynamicsCompressor === 'function') {
      const comp = audio.createDynamicsCompressor();
      gain.connect(comp).connect(audio.destination);
    } else {
      gain.connect(audio.destination);
    }
    masterBus = gain;
    return gain;
  }

  // The engine's own last-resort unlock. The HUD start button is the intended
  // gesture, but it is display:none during play (hud.css), so if that one
  // resume is parked the round would run silent with nothing able to retry.
  const onGesture = (): void => {
    ensureCtx(true);
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', onGesture);
    document.addEventListener('keydown', onGesture);
  }

  // Procedural fallback: a short decaying tone so dev is never blocked on assets.
  // No-ops safely when there is no Web Audio (e.g. headless test/node env).
  function beep(key: string, opts?: { rate?: number; volume?: number }): void {
    if (muted || disposed) return;
    if (activeVoices >= MAX_VOICES) return;
    const audio = ensureCtx();
    if (!audio) return;
    const freq = (FALLBACK_FREQ[key] ?? 440) * (opts?.rate ?? 1);
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    osc.type = key === 'explosion' || key === 'mine-boom' ? 'square' : 'sine';
    const vol = VOICE_GAIN * masterVolume * (opts?.volume ?? 1);
    gain.gain.setValueAtTime(vol, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.18);
    osc.connect(gain).connect(ensureBus(audio));

    activeVoices += 1;
    // A finished OscillatorNode still holds its edge into the graph until the
    // UA collects the whole subgraph, and UAs differ on how promptly they do.
    // Release explicitly: this is the only path that makes sound today, so a
    // leak here is a leak on every shot fired.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      activeVoices -= 1;
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        // Already disconnected (e.g. context closed under us) -- nothing to do.
      }
    };
    osc.onended = release;
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
    getVolume() {
      return masterVolume;
    },
    unlock() {
      ensureCtx(true);
    },
    dispose() {
      // Latch first: without it, ensureCtx() happily builds a *new*
      // AudioContext on the next play(), and browsers cap concurrent contexts
      // (~6 in Chrome) -- so a few title->play->title cycles would exhaust them.
      disposed = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('pointerdown', onGesture);
        document.removeEventListener('keydown', onGesture);
      }
      for (const k of Object.keys(sounds)) sounds[k]?.unload();
      music?.unload();
      masterBus = null;
      activeVoices = 0;
      if (ctx) {
        void ctx.close();
        ctx = null;
      }
    },
  };
}
