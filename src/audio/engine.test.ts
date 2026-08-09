import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// Mock Howler so the engine can be constructed and exercised headlessly (node env).
// vi.mock factories are hoisted above the whole module, so the spies they close
// over must be created via vi.hoisted (plain top-level consts would still be
// TDZ at the time the hoisted factory runs).
//
// WHY THIS MOCK RECORDS INSTANCES.
//
// The previous version of this file used `expect(fn).not.toThrow()` as the ONLY
// assertion in five of its ten tests, and its fake Howl tracked a `playCount`
// that nothing ever read. "Did not throw" is satisfied by an engine that does
// nothing at all: a mutation audit deleted the `rate`/`volume` forwarding from
// `engine.play()` -- the code that makes each ricochet ping a semitone higher
// than the last, the audio director's entire pitch design -- and all ten tests
// stayed green. Recording every constructed Howl lets these tests assert what
// actually reached howler, the standard engine.fallback.test.ts already holds
// itself to.
const { globalMute, globalVolume, howls } = vi.hoisted(() => ({
  globalMute: vi.fn(),
  globalVolume: vi.fn(),
  howls: [] as MockHowl[],
}));

/** A Howl as this file's mock builds it: every method is a spy. */
interface MockHowl {
  opts: { src: string[] };
  play: Mock;
  stop: Mock;
  volume: Mock;
  rate: Mock;
  mute: Mock;
  unload: Mock;
  playing: Mock;
  on: Mock;
}

vi.mock('howler', () => {
  class Howl {
    opts: unknown;
    // Real Howl.play() returns a distinct sound id per call, and that id is
    // what rate()/volume() must be scoped to -- passing rate(1.2) with no id
    // repitches EVERY currently-playing instance of the sample, not just the
    // shot that was just fired. Model the id so the tests can check it.
    private nextId = 0;
    play = vi.fn(() => {
      this.nextId += 1;
      return this.nextId;
    });
    stop = vi.fn();
    volume = vi.fn();
    rate = vi.fn();
    mute = vi.fn();
    unload = vi.fn();
    playing = vi.fn(() => false);
    on = vi.fn();
    constructor(opts: unknown) {
      this.opts = opts;
      howls.push(this as unknown as MockHowl);
    }
  }
  return {
    Howl,
    Howler: { mute: globalMute, volume: globalVolume },
  };
});

import { createAudioEngine, DUCK_FACTOR } from './engine';
// AUTHORED_LAYOUT, not LOADABLE: this file tests the FILE-LOADING path -- one
// Howl per entry, reached by src -- and the shipped manifest is deliberately empty,
// because no audio file has ever been committed. Pointing these at the shipped
// manifest would leave them asserting things about zero Howls, which is how a loading
// path rots unnoticed until the day a real asset lands.
import { AUDIO_MANIFEST, AUTHORED_LAYOUT as LOADABLE, DEFAULT_VOLUME } from './manifest';

/** The Howl the engine built for a given manifest SFX key. */
function howlFor(key: string): MockHowl {
  const src = LOADABLE.sfx[key];
  const found = howls.find((h) => h.opts.src[0] === src);
  if (!found) throw new Error(`no Howl was constructed for sfx key "${key}" (src ${src})`);
  return found;
}

/** The Howl the engine built for the music track. */
function musicHowl(): MockHowl {
  const found = howls.find((h) => h.opts.src[0] === LOADABLE.music);
  if (!found) throw new Error('no Howl was constructed for the music track');
  return found;
}

describe('createAudioEngine', () => {
  beforeEach(() => {
    globalMute.mockClear();
    globalVolume.mockClear();
    howls.length = 0;
  });

  it('asks the network for NOTHING when the manifest declares nothing', () => {
    // The headline behaviour of the change that emptied the manifest, and it had no
    // test: every other case in this file runs against LOADABLE, so nothing observed
    // the SHIPPED configuration. Deleting the `if (manifest.music)` guard, or letting
    // the sfx loop run over a populated map, has to fail here.
    //
    // Population: the shipped AUDIO_MANIFEST, which declares 0 sfx and no music. On the
    // deployed site the previous manifest cost 10 requests and 93,790 bytes per load.
    const engine = createAudioEngine(AUDIO_MANIFEST);
    expect(howls, 'the empty manifest still built a Howl, so it still hits the network').toEqual(
      [],
    );
    engine.dispose();
  });

  it('constructs one Howl per manifest entry and starts unmuted', () => {
    const engine = createAudioEngine(LOADABLE);
    expect(engine.isMuted()).toBe(false);
    // One per SFX key plus the music track. Without this, every `howlFor()`
    // below could be silently looking at a Howl the engine never wired up.
    expect(howls).toHaveLength(Object.keys(LOADABLE.sfx).length + 1);
    engine.dispose();
  });

  it('applies DEFAULT_VOLUME at construction, so the HUD slider is not lying', () => {
    // The HUD renders its volume slider at DEFAULT_VOLUME before the user has
    // touched anything. If the engine boots at some other level and waits for
    // an 'input' event to call Howler.volume(), the displayed value is wrong
    // until the first drag.
    const engine = createAudioEngine(LOADABLE);

    expect(globalVolume).toHaveBeenCalledWith(DEFAULT_VOLUME);
    engine.dispose();
  });

  it('reports its current volume', () => {
    const engine = createAudioEngine(LOADABLE);
    expect(engine.getVolume()).toBe(DEFAULT_VOLUME);
    engine.setVolume(0.25);
    expect(engine.getVolume()).toBe(0.25);
    engine.dispose();
  });

  it('plays the right sample and forwards rate/volume scoped to the returned sound id', () => {
    // The behaviour under test, stated plainly, because `not.toThrow()` used to
    // stand in for it: play('cannon', {rate, volume}) must (1) start the cannon
    // sample -- not some other key's -- and (2) apply the caller's rate and
    // volume to THAT sound id. Dropping (2) silently flattens the director's
    // per-bounce ricochet pitch ladder to a single monotone ping; scoping it to
    // the wrong id (or none) repitches every other copy of the sample still
    // ringing out, which on a busy tick is most of them.
    const engine = createAudioEngine(LOADABLE);
    const cannon = howlFor('cannon');

    engine.play('cannon', { rate: 1.2, volume: 0.8 });

    expect(cannon.play).toHaveBeenCalledTimes(1);
    const id = cannon.play.mock.results[0].value as number;
    expect(cannon.rate).toHaveBeenCalledWith(1.2, id);
    expect(cannon.volume).toHaveBeenCalledWith(0.8, id);

    // ...and only that sample: a stray play on another key would be an audible
    // bug this file previously could not see.
    expect(howlFor('explosion').play).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('leaves rate and volume untouched when the caller passes no options', () => {
    // `opts?.rate !== undefined` guards, not truthiness guards. Calling
    // rate(undefined, id) on a real Howl coerces to NaN and silences the voice,
    // and defaulting to rate(1, id) would clobber a pitch a previous call set
    // on a pooled voice.
    const engine = createAudioEngine(LOADABLE);
    const ping = howlFor('ping');

    engine.play('ping');

    expect(ping.play).toHaveBeenCalledTimes(1);
    expect(ping.rate).not.toHaveBeenCalled();
    expect(ping.volume).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('gives each play() its own sound id, so overlapping shots are tuned independently', () => {
    // Howler pools voices; two shots in flight share a Howl but not a sound id.
    // Forwarding a rate against a stale id repitches the wrong shot.
    const engine = createAudioEngine(LOADABLE);
    const ping = howlFor('ping');

    engine.play('ping', { rate: 1 });
    engine.play('ping', { rate: 1.15 });

    const ids = ping.play.mock.results.map((r) => r.value as number);
    expect(new Set(ids).size).toBe(2);
    expect(ping.rate).toHaveBeenNthCalledWith(1, 1, ids[0]);
    expect(ping.rate).toHaveBeenNthCalledWith(2, 1.15, ids[1]);
    engine.dispose();
  });

  it('falls back to the procedural path for an unknown key without touching any Howl', () => {
    const engine = createAudioEngine(LOADABLE);

    // No Howl for this key -> procedural fallback -> guarded no-op in node
    // (there is no window/AudioContext here). The real fallback path is
    // exercised for its output in engine.fallback.test.ts; what matters here is
    // that an unknown key does not get quietly routed to some other sample.
    expect(() => engine.play('does-not-exist')).not.toThrow();

    expect(howls.every((h) => h.play.mock.calls.length === 0)).toBe(true);
    engine.dispose();
  });

  it('toggleMute flips state and returns the new value', () => {
    const engine = createAudioEngine(LOADABLE);
    expect(engine.toggleMute()).toBe(true);
    expect(engine.isMuted()).toBe(true);
    expect(engine.toggleMute()).toBe(false);
    expect(engine.isMuted()).toBe(false);
    // The internal flag is not enough: Howler.mute() is what actually silences
    // output, and it must receive the same value isMuted() reports.
    expect(globalMute.mock.calls).toEqual([[true], [false]]);
    engine.dispose();
  });

  it('setMuted drives the muted state and forwards it to Howler', () => {
    const engine = createAudioEngine(LOADABLE);
    engine.setMuted(true);
    expect(engine.isMuted()).toBe(true);
    engine.setMuted(false);
    expect(engine.isMuted()).toBe(false);
    expect(globalMute.mock.calls).toEqual([[true], [false]]);
    engine.dispose();
  });

  it('setVolume clamps to [0,1] and forwards to Howler', () => {
    const engine = createAudioEngine(LOADABLE);
    engine.setVolume(2);
    engine.setVolume(-1);
    expect(globalVolume).toHaveBeenCalledWith(1);
    expect(globalVolume).toHaveBeenCalledWith(0);
    // ...and the clamp is reflected back to the HUD, not just to howler.
    expect(engine.getVolume()).toBe(0);
    engine.dispose();
  });

  it('startMusic plays the music track and stopMusic stops it', () => {
    const engine = createAudioEngine(LOADABLE);
    const music = musicHowl();

    engine.startMusic();
    expect(music.play).toHaveBeenCalledTimes(1);

    engine.stopMusic();
    expect(music.stop).toHaveBeenCalledTimes(1);

    // Music must not be routed through an SFX Howl.
    expect(howlFor('cannon').play).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('ducks the LOADED track too, not only the generated bed', () => {
    // Raised by review: duckMusic reached `bed` alone, so pause would behave
    // differently depending on whether the asset happened to load. No asset
    // ships today (public/audio holds only .gitkeep), so this path is latent
    // -- but "latent" is why it needs a test rather than why it does not.
    const engine = createAudioEngine(LOADABLE);
    const music = musicHowl();
    engine.startMusic();
    music.volume.mockClear();
    engine.duckMusic(true);
    const ducked = music.volume.mock.calls.at(-1)?.[0] as number;
    engine.duckMusic(false);
    const open = music.volume.mock.calls.at(-1)?.[0] as number;
    expect(ducked, 'the loaded track was never ducked').toBeDefined();
    // Against the constant, not 0.25: retuning the duck must not rewrite this.
    expect(ducked / open).toBeCloseTo(DUCK_FACTOR, 9);
    engine.dispose();
  });

  it('startMusic does not restart a track that is already playing', () => {
    const engine = createAudioEngine(LOADABLE);
    const music = musicHowl();
    music.playing.mockReturnValue(true);

    engine.startMusic();

    expect(music.play).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('plays every manifest key through its own Howl, exactly once', () => {
    const engine = createAudioEngine(LOADABLE);
    for (const key of Object.keys(LOADABLE.sfx)) {
      expect(() => engine.play(key)).not.toThrow();
    }
    for (const key of Object.keys(LOADABLE.sfx)) {
      expect(howlFor(key).play, `sfx key "${key}" never reached its Howl`).toHaveBeenCalledTimes(1);
    }
    engine.dispose();
  });

  it('dispose unloads every Howl it created', () => {
    // Browsers cap concurrent AudioContexts and howler holds decoded buffers;
    // a title -> play -> title cycle that leaks both exhausts them.
    const engine = createAudioEngine(LOADABLE);
    const created = [...howls];
    engine.dispose();
    for (const h of created) expect(h.unload).toHaveBeenCalledTimes(1);
  });
});
