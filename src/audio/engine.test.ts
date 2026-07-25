import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Howler so the engine can be constructed and exercised headlessly (node env).
// vi.mock factories are hoisted above the whole module, so the spies they close
// over must be created via vi.hoisted (plain top-level consts would still be
// TDZ at the time the hoisted factory runs).
const { globalMute, globalVolume } = vi.hoisted(() => ({
  globalMute: vi.fn(),
  globalVolume: vi.fn(),
}));

vi.mock('howler', () => {
  class Howl {
    playCount = 0;
    constructor(_opts: unknown) {}
    play() {
      this.playCount += 1;
      return this.playCount;
    }
    stop() {}
    volume() {}
    rate() {}
    mute() {}
    unload() {}
    playing() {
      return false;
    }
    on() {}
  }
  return {
    Howl,
    Howler: { mute: globalMute, volume: globalVolume },
  };
});

import { createAudioEngine } from './engine';
import { AUDIO_MANIFEST } from './manifest';

describe('createAudioEngine', () => {
  beforeEach(() => {
    globalMute.mockClear();
    globalVolume.mockClear();
  });

  it('constructs without throwing and starts unmuted', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    expect(engine.isMuted()).toBe(false);
    engine.dispose();
  });

  it('plays a known SFX key without throwing', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    expect(() => engine.play('cannon', { rate: 1.2, volume: 0.8 })).not.toThrow();
    engine.dispose();
  });

  it('falls back gracefully (no throw) for an unknown/missing key', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    // No Howl for this key -> procedural fallback -> guarded no-op in node.
    expect(() => engine.play('does-not-exist')).not.toThrow();
    engine.dispose();
  });

  it('toggleMute flips state and returns the new value', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    expect(engine.toggleMute()).toBe(true);
    expect(engine.isMuted()).toBe(true);
    expect(engine.toggleMute()).toBe(false);
    expect(engine.isMuted()).toBe(false);
    expect(globalMute).toHaveBeenCalled();
    engine.dispose();
  });

  it('setMuted drives the muted state', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    engine.setMuted(true);
    expect(engine.isMuted()).toBe(true);
    engine.setMuted(false);
    expect(engine.isMuted()).toBe(false);
    engine.dispose();
  });

  it('setVolume clamps to [0,1] and forwards to Howler', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    engine.setVolume(2);
    engine.setVolume(-1);
    expect(globalVolume).toHaveBeenCalledWith(1);
    expect(globalVolume).toHaveBeenCalledWith(0);
    engine.dispose();
  });

  it('startMusic/stopMusic do not throw', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    expect(() => engine.startMusic()).not.toThrow();
    expect(() => engine.stopMusic()).not.toThrow();
    engine.dispose();
  });

  it('never throws when playing every manifest key with zero assets present', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    for (const key of Object.keys(AUDIO_MANIFEST.sfx)) {
      expect(() => engine.play(key)).not.toThrow();
    }
    engine.dispose();
  });
});
