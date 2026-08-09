// @vitest-environment jsdom
//
// engine.fallback.test.ts drives a DELIBERATELY minimal AudioContext, so it
// exercises the old one-oscillator `beep`. That left the synth path, the music
// bed, and every mute/volume push to the bed with no coverage at all: review
// proved that deleting `if (synth(key, opts)) return;` -- the whole feature --
// kept 1080 tests green.
//
// This file supplies a context capable enough for `canSynthesise()` to accept,
// so the paths that actually run in a browser are the ones under test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAudioEngine, DUCK_FACTOR } from './engine';
import { AUDIO_MANIFEST, AUTHORED_LAYOUT, DEFAULT_VOLUME } from './manifest';

vi.mock('howler', () => {
  class FakeHowl {
    private handlers: Record<string, Array<() => void>> = {};
    constructor(public opts: { src: string[]; loop?: boolean }) {
      // Every asset 404s in this repo, which is the shipped reality: fire
      // loaderror asynchronously exactly as Howler does.
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
  }
  return { Howl: FakeHowl, Howler: { volume: () => {}, mute: () => {} } };
});

interface NodeRec {
  kind: string;
  gainValue?: number;
  freqs: number[];
  connectedTo: string[];
  disconnected: boolean;
}

class CapableCtx {
  static instances: CapableCtx[] = [];
  state: AudioContextState = 'running';
  currentTime = 0;
  sampleRate = 44100;
  nodes: NodeRec[] = [];
  destination = { __id: 'destination' } as unknown as AudioNode;

  constructor() {
    CapableCtx.instances.push(this);
  }
  private rec(kind: string): NodeRec {
    const r: NodeRec = { kind, freqs: [], connectedTo: [], disconnected: false };
    this.nodes.push(r);
    return r;
  }
  private wrap(r: NodeRec, extra: Record<string, unknown> = {}): AudioNode {
    return {
      ...extra,
      connect: (t: { __id?: string }) => {
        r.connectedTo.push(t?.__id ?? 'node');
        return t;
      },
      disconnect: () => {
        r.disconnected = true;
      },
    } as unknown as AudioNode;
  }
  private audioParam(r: NodeRec) {
    return {
      get value() {
        return r.gainValue ?? 1;
      },
      set value(v: number) {
        r.gainValue = v;
      },
      setValueAtTime: (v: number) => {
        r.freqs.push(v);
      },
      exponentialRampToValueAtTime: () => {},
    };
  }
  createGain(): GainNode {
    const r = this.rec('gain');
    return this.wrap(r, { gain: this.audioParam(r) }) as GainNode;
  }
  createOscillator(): OscillatorNode {
    const r = this.rec('osc');
    return this.wrap(r, {
      type: 'sine',
      frequency: this.audioParam(r),
      start: () => {},
      stop: () => {},
      addEventListener: () => {},
    }) as OscillatorNode;
  }
  createBiquadFilter(): BiquadFilterNode {
    const r = this.rec('filter');
    return this.wrap(r, { type: 'lowpass', frequency: this.audioParam(r), Q: { value: 1 } }) as BiquadFilterNode;
  }
  createBufferSource(): AudioBufferSourceNode {
    const r = this.rec('bufferSource');
    return this.wrap(r, { buffer: null, start: () => {}, stop: () => {} }) as AudioBufferSourceNode;
  }
  createBuffer(_ch: number, len: number, rate: number): AudioBuffer {
    const data = new Float32Array(len);
    return {
      duration: len / rate,
      length: len,
      sampleRate: rate,
      numberOfChannels: 1,
      getChannelData: () => data,
    } as unknown as AudioBuffer;
  }
  createDynamicsCompressor(): DynamicsCompressorNode {
    return this.wrap(this.rec('compressor')) as DynamicsCompressorNode;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

const flush = (): Promise<void> => Promise.resolve();

beforeEach(() => {
  CapableCtx.instances = [];
  (window as unknown as { AudioContext: unknown }).AudioContext = CapableCtx;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

const ctxOf = (): CapableCtx => CapableCtx.instances[CapableCtx.instances.length - 1];

describe('engine: the synth path is the one that runs', () => {
  it('builds a LAYERED voice, not the single-oscillator beep', async () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flush();
    engine.play('explosion');
    const c = ctxOf();
    // The beep is exactly one oscillator + one gain. The synth uses filtered
    // noise, so a buffer source and a filter are the discriminator: deleting the
    // synth path from engine.ts must fail here.
    expect(c.nodes.filter((n) => n.kind === 'bufferSource').length).toBeGreaterThan(0);
    expect(c.nodes.filter((n) => n.kind === 'filter').length).toBeGreaterThan(0);
    engine.dispose();
  });

  it('caps concurrent voices and recovers once they expire', async () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flush();
    for (let i = 0; i < 20; i++) engine.play('cannon');
    const c = ctxOf();
    const capped = c.nodes.filter((n) => n.kind === 'osc').length;
    // MAX_VOICES is 8 and a cannon has one oscillator layer.
    expect(capped).toBe(8);
    // After the scheduled teardowns run, playing works again -- a leaked counter
    // would silence the game permanently.
    vi.advanceTimersByTime(5000);
    engine.play('cannon');
    expect(c.nodes.filter((n) => n.kind === 'osc').length).toBe(capped + 1);
    engine.dispose();
  });

  it('releases each voice on its own schedule, and dispose cancels the pending ones', async () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flush();
    engine.play('ping');
    const c = ctxOf();
    const voiceNodes = () => c.nodes.filter((n) => n.kind === 'osc');
    expect(voiceNodes().every((n) => !n.disconnected)).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(voiceNodes().every((n) => n.disconnected)).toBe(true);

    // And a dispose with a voice still in flight must CANCEL its teardown timer.
    // "does not throw" was the first version of this and could not fail -- the
    // callback is harmless, it just runs. The observable difference is that a
    // cancelled timer never releases its nodes.
    const engine2 = createAudioEngine(AUDIO_MANIFEST);
    await flush(); // its assets must fail too, or play() routes to the Howl
    engine2.play('cannon');
    const c2 = ctxOf();
    const fresh = c2.nodes.filter((n) => n.kind === 'osc' && !n.disconnected);
    expect(fresh.length).toBeGreaterThan(0);
    engine2.dispose();
    vi.advanceTimersByTime(5000);
    expect(fresh.every((n) => !n.disconnected)).toBe(true);
  });
});

describe('engine: the generated music bed', () => {
  it('starts the bed when no track loaded, and stops it on stopMusic', async () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flush(); // let the music Howl fail to load
    // No context exists until something asks for one -- startMusic is what
    // creates it here, so there is nothing to measure "before".
    expect(CapableCtx.instances).toHaveLength(0);
    engine.startMusic();
    const c = ctxOf();
    // The bed scheduled its first lookahead window: real oscillators, not a
    // silent no-op that a `music === null` guard would have produced.
    expect(c.nodes.filter((n) => n.kind === 'osc').length).toBeGreaterThan(0);
    engine.stopMusic();
    engine.dispose();
  });

  it('starts the bed even when startMusic beat the music load failure', async () => {
    // Every other bed test in this file awaits flush() FIRST, so the Howl is
    // already null by the time startMusic runs -- which is why none of them
    // could see this. The game now starts the music at boot, inside the window
    // where the Howl still exists and has not yet failed: measured in a real
    // browser, the asset resolved at ~1354ms while boot called startMusic at
    // ~380ms, and the title screen produced 0 bed voices against 8 after Start.
    const engine = createAudioEngine(AUDIO_MANIFEST);
    engine.startMusic(); // BEFORE the flush: the Howl is alive and mute
    await flush(); // ...and now it fails, as it always will in this repo
    const c = ctxOf();
    expect(c, 'no AudioContext at all -- the bed never ran').toBeDefined();
    expect(
      c.nodes.filter((n) => n.kind === 'osc').length,
      'the load failure arrived after startMusic and nothing retried: silence',
    ).toBeGreaterThan(0);
    engine.dispose();
  });


  /** Every pitch the bed scheduled on `c`, as a set. */
  const openingPitches = (c: CapableCtx): Set<number> =>
    new Set(
      c.nodes
        .filter((n) => n.kind === 'osc')
        .flatMap((o) => o.freqs)
        .map((f) => Math.round(f)),
    );

  /** Start an engine already in `context` and return the pitches it opened on. */
  const openIn = async (context: 'menu' | 'arena'): Promise<Set<number>> => {
    CapableCtx.instances = [];
    const engine = createAudioEngine(AUDIO_MANIFEST);
    engine.setMusicContext(context);
    engine.startMusic();
    await flush();
    const pitches = openingPitches(ctxOf());
    engine.dispose();
    return pitches;
  };

  it('OPENS on the music of the context it is in, not always the arena', async () => {
    // The headline of this branch, at the engine seam. Review proved the two
    // lines that enter the context could be deleted with all 476 tests in
    // src/audio + src/game still passing: the bed would boot on the arena start
    // suite and the title screen would play round music.
    //
    // Asserted as a CONTRAST rather than against hardcoded pitches, so retuning
    // a track does not fail it: with the context entry gone, both contexts open
    // on director.first() and these sets are identical. (Measured at this
    // commit: menu opens on 55/220/262/330 -- a full Am voicing -- and arena on
    // 55/110, bass octaves alone.)
    const menu = await openIn('menu');
    const arena = await openIn('arena');
    expect(menu.size, 'the menu context scheduled nothing at all').toBeGreaterThan(0);
    expect([...menu].sort(), 'both contexts opened on the SAME music').not.toEqual([...arena].sort());
    // Determinism, at the wiring rather than inside playlist.ts: fake timers
    // freeze Date.now(), so the seed is identical and a second engine in the
    // same context must open identically. Math.random here would not.
    expect([...(await openIn('arena'))].sort()).toEqual([...arena].sort());
  });

  it('DUCKS the bed to a fraction rather than muting or ignoring it', async () => {
    // Review: gutting duckMusic to an empty body left all 1268 tests passing,
    // and so did DUCK_FACTOR = 1. Both are pinned here.
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flush();
    engine.startMusic();
    const c = ctxOf();
    // The bed's own bus, identified by the exact level it is given -- the same
    // handle the dispose test uses. "some gain changed" could not fail.
    const full = 0.25 * DEFAULT_VOLUME;
    expect(c.nodes.some((n) => n.kind === 'gain' && n.gainValue === full)).toBe(true);
    engine.duckMusic(true);
    expect(
      c.nodes.some((n) => n.kind === 'gain' && n.gainValue === full * DUCK_FACTOR),
      'duckMusic(true) did not move the bed bus',
    ).toBe(true);
    engine.duckMusic(false);
    expect(
      c.nodes.some((n) => n.kind === 'gain' && n.gainValue === full),
      'unducking did not restore the level',
    ).toBe(true);
    // ...and the constant means what its name says. Written against the range,
    // not the value, so retuning the duck does not rewrite the test -- but
    // DUCK_FACTOR = 1 (no duck) or 0 (a mute, which is what pause used to be)
    // both fail.
    expect(DUCK_FACTOR, 'a duck of 1 is not a duck').toBeLessThan(1);
    expect(DUCK_FACTOR, 'a duck of 0 is a mute -- pause must stay audible').toBeGreaterThan(0);
    engine.dispose();
  });

  it('a duck survives the mute and volume paths rather than fighting them', async () => {
    // applyMusicVolume exists so these three cannot disagree. Population: the
    // 3 setters that touch the bed's level (setMuted, setVolume, duckMusic).
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flush();
    engine.startMusic();
    const c = ctxOf();
    engine.duckMusic(true);
    engine.setVolume(0.5);
    expect(
      c.nodes.some((n) => n.kind === 'gain' && n.gainValue === 0.25 * 0.5 * DUCK_FACTOR),
      'the volume slider cleared the duck',
    ).toBe(true);
    engine.setMuted(true);
    expect(c.nodes.some((n) => n.kind === 'gain' && n.gainValue === 0), 'mute lost to the duck').toBe(true);
    engine.dispose();
  });

  // AUTHORED_LAYOUT below, not AUDIO_MANIFEST: this case is ABOUT a `loaderror`, and
  // the shipped manifest declares no music file, so no Howl is built and no load can
  // fail. Against the shipped manifest the assertions would pass for the wrong reason
  // -- nothing to resurrect because nothing was ever requested.
  it('a stop BEFORE the load failure stays stopped, and dispose disarms the retry', async () => {
    // The retry is armed by startMusic and must be disarmed by both stopMusic
    // and dispose -- otherwise a load failure arriving later resurrects audio
    // the game has already turned off. Review verified this by probe; it is a
    // test now. `musicWanted = false` in stopMusic was deletable with all 476
    // tests in src/audio + src/game passing.
    const stopped = createAudioEngine(AUTHORED_LAYOUT);
    CapableCtx.instances = [];
    stopped.startMusic();
    stopped.stopMusic();
    await flush(); // the loaderror lands here, after the stop
    expect(CapableCtx.instances, 'a late load failure restarted music the game stopped').toHaveLength(0);
    stopped.dispose();

    // The dispose half pins the CONJUNCTION, and says so rather than implying
    // more: two independent guards stop a late failure resurrecting a disposed
    // engine -- `musicWanted = false` in dispose, and ensureCtx's `if (disposed)
    // return null`. Measured: removing either ALONE still passes (the other
    // covers it); removing both fails here. So this proves a disposed engine
    // never builds a context, NOT that the disarm in dispose is load-bearing
    // today. It is belt-and-braces, and this is the belt.
    const gone = createAudioEngine(AUTHORED_LAYOUT);
    CapableCtx.instances = [];
    gone.startMusic();
    gone.dispose();
    await flush();
    expect(CapableCtx.instances, 'a late load failure built a context on a disposed engine').toHaveLength(0);
  });

  it('does NOT play at full volume when the game is muted', async () => {
    // The bug this pins: Howler.mute() does not touch our own graph, so a bed
    // built while muted would sing over a silent game.
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flush();
    engine.setMuted(true);
    engine.startMusic();
    const gains = ctxOf().nodes.filter((n) => n.kind === 'gain');
    // The bed's bus is the gain carrying an explicit 0.
    expect(gains.some((g) => g.gainValue === 0)).toBe(true);
    engine.dispose();
  });

  it('mute and unmute reach the bed after it is already playing', async () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flush();
    engine.startMusic();
    const c = ctxOf();
    engine.setMuted(true);
    expect(c.nodes.some((n) => n.kind === 'gain' && n.gainValue === 0)).toBe(true);
    engine.setMuted(false);
    expect(c.nodes.some((n) => n.kind === 'gain' && (n.gainValue ?? 0) > 0)).toBe(true);
    engine.dispose();
  });

  it('the volume slider moves the bed, not just the effects', async () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flush();
    engine.startMusic();
    const c = ctxOf();
    engine.setVolume(0.5);
    const half = c.nodes.filter((n) => n.kind === 'gain').map((g) => g.gainValue);
    engine.setVolume(1);
    const full = c.nodes.filter((n) => n.kind === 'gain').map((g) => g.gainValue);
    expect(full).not.toEqual(half); // Howler.volume alone would leave these identical
    engine.dispose();
  });

  it('dispose tears the bed down', async () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    await flush();
    engine.startMusic();
    const c = ctxOf();
    // The BED's bus specifically, identified by the volume it is given:
    // MUSIC_VOLUME (0.25) x DEFAULT_VOLUME. "some gain was disconnected" could
    // not fail -- canSynthesise's probe gain is disconnected on every play.
    const bedVolume = 0.25 * DEFAULT_VOLUME;
    const bedBus = c.nodes.find((n) => n.kind === 'gain' && n.gainValue === bedVolume);
    expect(bedBus).toBeDefined();
    expect(bedBus!.disconnected).toBe(false);
    engine.dispose();
    expect(bedBus!.disconnected).toBe(true);
  });
});
