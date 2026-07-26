// @vitest-environment jsdom
//
// The PRODUCTION audio path, which engine.test.ts cannot reach.
//
// No audio assets ship with this slice (public/audio/ holds only .gitkeep), so
// every Howl fires `loaderror`, every `sounds[key]` is nulled, and the
// procedural `beep()` fallback is the ONLY path that ever makes a sound today.
// engine.test.ts mocks `Howl.on()` as a no-op, so `loaderror` never fires there
// and `sounds[key]` is always a truthy Howl -- its 8 green tests exercise the
// asset path exclusively and would stay green if `beep()` were deleted.
//
// This file mocks `on()` faithfully instead: it fires `loaderror` on the next
// microtask, exactly as howler does for a missing file.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('howler', () => {
  class Howl {
    private handlers: Record<string, Array<() => void>> = {};
    constructor(_opts: unknown) {
      // Every asset is missing -> loaderror, asynchronously, like the real Howl.
      queueMicrotask(() => {
        for (const cb of this.handlers.loaderror ?? []) cb();
      });
    }
    on(event: string, cb: () => void) {
      (this.handlers[event] ??= []).push(cb);
    }
    play() {
      throw new Error('play() must not be reached: every asset failed to load');
    }
    stop() {}
    volume() {}
    rate() {}
    mute() {}
    unload() {}
    playing() {
      return false;
    }
  }
  return { Howl, Howler: { mute: vi.fn(), volume: vi.fn() } };
});

import { createAudioEngine } from './engine';
import { AUDIO_MANIFEST } from './manifest';

interface FakeNode {
  connect(target: unknown): unknown;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = 'suspended';
  currentTime = 0;
  destination = {};
  resumeCalls = 0;
  started: number[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
    return Promise.resolve();
  }
  createOscillator(): FakeNode & { frequency: { value: number }; type: string; start(): void; stop(_t: number): void } {
    const self = this;
    return {
      frequency: { value: 0 },
      type: 'sine',
      connect: (target: unknown) => target,
      start(this: { frequency: { value: number } }) {
        self.started.push(this.frequency.value);
      },
      stop(_t: number) {},
    };
  }
  createGain(): FakeNode & { gain: { setValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void } } {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (target: unknown) => target,
    };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Let the queued microtask that fires `loaderror` run. */
const flushLoadErrors = (): Promise<void> => Promise.resolve();

beforeEach(() => {
  FakeAudioContext.instances = [];
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

describe('audio engine procedural fallback (the only live path today)', () => {
  it('routes play() to a real oscillator once the asset fails to load', async () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flushLoadErrors();

    engine.play('cannon');

    const ctx = FakeAudioContext.instances[0];
    expect(ctx).toBeDefined();
    expect(ctx.started).toEqual([180]); // FALLBACK_FREQ.cannon
    engine.dispose();
  });

  it('resumes a suspended AudioContext, so the first sound is audible', async () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flushLoadErrors();

    engine.play('cannon');

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe('running');
    engine.dispose();
  });

  it('does not call resume() again once the context is already running', async () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flushLoadErrors();

    engine.play('cannon');
    engine.play('ping');
    engine.play('explosion');

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.started).toEqual([180, 900, 90]);
    engine.dispose();
  });

  it('stays silent while muted rather than resuming the context', async () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flushLoadErrors();
    engine.setMuted(true);

    engine.play('cannon');

    expect(FakeAudioContext.instances).toHaveLength(0);
    engine.dispose();
  });
});
