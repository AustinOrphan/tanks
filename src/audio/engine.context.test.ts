// @vitest-environment jsdom
//
// COMPOSITION, not behaviour. `music.test.ts` proves that a bar-aligned suite
// change lands on the next bar and a roam change still waits for the cycle;
// nothing there can see whether ENGINE.TS asks for the right one. It could not:
// removing `{ at: 'bar' }` from engine.ts left all 1277 tests passing, which is
// the same composition blindness step-pipeline.test.ts exists for.
//
// So this file fakes the bed and watches the ARGUMENTS the engine passes.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const changeSuite = vi.fn();
const bedStub = {
  start: vi.fn(),
  stop: vi.fn(),
  setVolume: vi.fn(),
  setIntensity: vi.fn(),
  queueTrack: vi.fn(),
  changeSuite,
  inTransition: () => false,
  currentTrackId: () => 'stub',
  isPlaying: () => true,
  dispose: vi.fn(),
};

vi.mock('./music', () => ({ createMusicBed: () => bedStub }));
vi.mock('howler', () => {
  class FakeHowl {
    private handlers: Record<string, Array<() => void>> = {};
    constructor(public opts: { src: string[] }) {
      queueMicrotask(() => {
        for (const h of this.handlers.loaderror ?? []) h();
      });
    }
    on(ev: string, fn: () => void): void {
      (this.handlers[ev] ??= []).push(fn);
    }
    play(): void {}
    stop(): void {}
    unload(): void {}
    playing(): boolean {
      return false;
    }
    volume(): void {}
  }
  return { Howl: FakeHowl, Howler: { volume: () => {}, mute: () => {} } };
});

import { createAudioEngine } from './engine';
import { AUDIO_MANIFEST } from './manifest';

// Capable enough for canSynthesise; the bed itself is stubbed, so nothing here
// needs to make a sound.
class Ctx {
  state: AudioContextState = 'running';
  currentTime = 0;
  sampleRate = 44100;
  destination = {} as AudioNode;
  private node(): AudioNode {
    return { connect: (t: AudioNode) => t, disconnect: () => {} } as AudioNode;
  }
  createGain(): GainNode {
    return { ...this.node(), gain: { value: 1, setValueAtTime: () => {} } } as unknown as GainNode;
  }
  createOscillator(): OscillatorNode {
    return {
      ...this.node(),
      type: 'sine',
      frequency: { value: 1, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      start: () => {},
      stop: () => {},
      addEventListener: () => {},
    } as unknown as OscillatorNode;
  }
  createBiquadFilter(): BiquadFilterNode {
    return { ...this.node(), type: 'lowpass', frequency: { value: 1, setValueAtTime: () => {} }, Q: { value: 1 } } as unknown as BiquadFilterNode;
  }
  createBufferSource(): AudioBufferSourceNode {
    return { ...this.node(), buffer: null, start: () => {}, stop: () => {} } as unknown as AudioBufferSourceNode;
  }
  createBuffer(_c: number, len: number, rate: number): AudioBuffer {
    return { length: len, sampleRate: rate, duration: len / rate, numberOfChannels: 1, getChannelData: () => new Float32Array(len) } as unknown as AudioBuffer;
  }
  createDynamicsCompressor(): DynamicsCompressorNode {
    return this.node() as DynamicsCompressorNode;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const flush = (): Promise<void> => Promise.resolve();

beforeEach(() => {
  changeSuite.mockClear();
  (window as unknown as { AudioContext: unknown }).AudioContext = Ctx;
});

describe('engine: a screen change is asked for PROMPTLY', () => {
  it("asks for a BAR-aligned change when the context changes", async () => {
    // Without `at: 'bar'` the bed defaults to the cycle boundary, which measured
    // min 0.35s / median 6.35s / max 11.85s of lag against the real modules
    // (24 of 24 calls, swept every 0.5s across one 12.8s menu cycle) -- the
    // title screen's music playing seconds into the level.
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flush();
    engine.startMusic(); // boots in the default 'menu' context
    changeSuite.mockClear();
    engine.setMusicContext('arena');
    expect(changeSuite, 'the context change never reached the bed').toHaveBeenCalledTimes(1);
    const [track, opts] = changeSuite.mock.calls[0];
    expect(track, 'the bed was handed nothing to change to').toBeTruthy();
    expect(opts, 'the engine let a screen change wait for the cycle boundary').toEqual({ at: 'bar' });
    engine.dispose();
  });

  it('does not ask again for a context it is already in', async () => {
    // loop.ts pushes the context on EVERY state change, including pause and
    // resume. Asking the bed to change suite on each would restart the music.
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flush();
    engine.startMusic();
    engine.setMusicContext('arena');
    changeSuite.mockClear();
    engine.setMusicContext('arena');
    engine.setMusicContext('arena');
    expect(changeSuite, 'a repeated context re-entered the world').not.toHaveBeenCalled();
    engine.dispose();
  });
});
