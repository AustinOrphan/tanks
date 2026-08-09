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
// AUTHORED_LAYOUT, not LOADABLE: every case in this file is about what happens
// when a declared file FAILS TO LOAD, and the shipped manifest declares nothing, so
// against it this file builds zero Howls and asserts nothing. Measured: with the
// shipped manifest, deleting `sounds[key] = null` from engine.ts's loaderror handler
// passed all 1355 tests; against this fixture it fails 8.
import { AUTHORED_LAYOUT as LOADABLE } from './manifest';

interface FakeNode {
  connect(target: unknown): unknown;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /**
   * Models WebKit's rule, not Chrome's: a resume() issued outside a user
   * gesture never settles. Flip via grantGesture() to model a real click.
   */
  static gestureGranted = false;

  state: AudioContextState = 'suspended';
  currentTime = 0;
  destination = {};
  resumeCalls = 0;
  started: number[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  /**
   * Real AudioContext.resume() is ASYNCHRONOUS: `state` stays 'suspended'
   * until the promise settles, and per spec a resume that is not yet permitted
   * is parked on [[pending promises]] and may never settle at all. An earlier
   * version of this fake flipped `state` synchronously, which made the engine
   * look like it de-duplicated resume calls when it did not.
   */
  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (!FakeAudioContext.gestureGranted) return new Promise<void>(() => {}); // never settles
    return Promise.resolve().then(() => {
      this.state = 'running';
    });
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
    this.state = 'closed';
    return Promise.resolve();
  }
}

/** Let the queued microtask that fires `loaderror` run. */
const flushLoadErrors = (): Promise<void> => Promise.resolve();

beforeEach(() => {
  FakeAudioContext.instances = [];
  FakeAudioContext.gestureGranted = false;
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

describe('audio engine procedural fallback (the only live path today)', () => {
  it('routes play() to a real oscillator once the asset fails to load', async () => {
    const engine = createAudioEngine(LOADABLE);
    await flushLoadErrors();

    engine.play('cannon');

    const ctx = FakeAudioContext.instances[0];
    expect(ctx).toBeDefined();
    expect(ctx.started).toEqual([180]); // FALLBACK_FREQ.cannon
    engine.dispose();
  });

  it('resumes a suspended AudioContext, so the first sound is audible', async () => {
    FakeAudioContext.gestureGranted = true;
    const engine = createAudioEngine(LOADABLE);
    await flushLoadErrors();

    engine.play('cannon');
    await Promise.resolve();
    await Promise.resolve();

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe('running');
    engine.dispose();
  });

  it('does not pile up resume() calls while one is still in flight', async () => {
    // The sim emits sounds from the rAF loop, several per second. On WebKit a
    // resume() issued outside a gesture never settles, so `state` stays
    // 'suspended' forever -- a naive `if (suspended) resume()` on every sound
    // retains a pending promise per shot fired for the whole session.
    const engine = createAudioEngine(LOADABLE);
    await flushLoadErrors();

    engine.play('cannon');
    engine.play('ping');
    engine.play('explosion');

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.state).toBe('suspended'); // no gesture yet: the fake models WebKit
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.started).toEqual([180, 900, 90]); // still renders tones regardless
    engine.dispose();
  });

  it('unlock() resumes the context from a real user gesture', async () => {
    const engine = createAudioEngine(LOADABLE);
    await flushLoadErrors();
    FakeAudioContext.gestureGranted = true;

    engine.unlock();
    await Promise.resolve();
    await Promise.resolve();

    const ctx = FakeAudioContext.instances[0];
    expect(ctx).toBeDefined();
    expect(ctx.state).toBe('running');
    engine.dispose();
  });

  it('retries the resume on the next sound after a failed unlock', async () => {
    const engine = createAudioEngine(LOADABLE);
    await flushLoadErrors();

    engine.play('cannon'); // gesture not granted -> resume never settles
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.resumeCalls).toBe(1);

    // The user finally interacts; the in-flight resume settles and the next
    // sound must not be blocked by a stale "already resuming" latch.
    FakeAudioContext.gestureGranted = true;
    engine.unlock();
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.state).toBe('running');
    engine.play('ping');
    expect(ctx.started).toEqual([180, 900]);
    engine.dispose();
  });

  it('stays silent while muted rather than resuming the context', async () => {
    const engine = createAudioEngine(LOADABLE);
    await flushLoadErrors();
    engine.setMuted(true);

    engine.play('cannon');

    expect(FakeAudioContext.instances).toHaveLength(0);

    // Contrast: the same call unmuted DOES render a tone, so this test cannot
    // pass merely because play() stopped working.
    engine.setMuted(false);
    engine.play('cannon');
    expect(FakeAudioContext.instances[0]?.started).toEqual([180]);
    engine.dispose();
  });
});
