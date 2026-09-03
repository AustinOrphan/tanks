// The synth is pure graph-building, so it is fully testable headlessly: build a
// fake context that RECORDS the graph, then assert the shape of each sound.
//
// These assertions are about sound DESIGN, not implementation trivia. Each one
// names a property a listener would notice if it broke -- an explosion with no
// noise layer is a beep, a ricochet with one partial is a tone, an enemy cannon
// as loud as your own makes the arena unreadable.
import { describe, it, expect } from 'vitest';
import { synthVoice, isSfxKey, type SfxKey } from './synth';

const KEYS: SfxKey[] = [
  'cannon',
  'cannon-enemy',
  'ping',
  'explosion',
  'mine-drop',
  'mine-arm',
  'mine-boom',
  'victory',
  'defeat',
];

interface RecordedParam {
  sets: Array<[number, number]>;
  ramps: Array<[number, number]>;
  value: number;
}

const param = (): RecordedParam => {
  const p: RecordedParam = {
    sets: [],
    ramps: [],
    value: 0,
  };
  return Object.assign(p, {
    setValueAtTime(v: number, t: number) {
      p.sets.push([v, t]);
    },
    exponentialRampToValueAtTime(v: number, t: number) {
      p.ramps.push([v, t]);
    },
  });
};

class FakeCtx {
  sampleRate = 44100;
  currentTime = 0;
  destination = { connect: () => undefined, disconnect: () => undefined } as unknown as AudioNode;
  oscillators: Array<{ type: string; frequency: RecordedParam; startedAt: number }> = [];
  sources: Array<{ startedAt: number; offset: number; duration: number }> = [];
  filters: Array<{ type: string; frequency: RecordedParam }> = [];
  gains: RecordedParam[] = [];
  disconnects = 0;
  buffersMade = 0;

  createBuffer(_ch: number, len: number, rate: number): AudioBuffer {
    this.buffersMade += 1;
    const data = new Float32Array(len);
    return {
      duration: len / rate,
      length: len,
      sampleRate: rate,
      numberOfChannels: 1,
      getChannelData: () => data,
    } as unknown as AudioBuffer;
  }
  createBufferSource(): AudioBufferSourceNode {
    const self = this;
    const rec = { startedAt: -1, offset: -1, duration: -1 };
    this.sources.push(rec);
    return {
      buffer: null,
      connect: (t: AudioNode) => t,
      disconnect: () => {
        self.disconnects += 1;
      },
      start(when: number, offset: number, duration: number) {
        rec.startedAt = when;
        rec.offset = offset;
        rec.duration = duration;
      },
      stop: () => undefined,
    } as unknown as AudioBufferSourceNode;
  }
  createBiquadFilter(): BiquadFilterNode {
    const self = this;
    const rec = { type: 'lowpass', frequency: param() };
    this.filters.push(rec);
    return {
      get type() {
        return rec.type;
      },
      set type(v: string) {
        rec.type = v;
      },
      frequency: rec.frequency,
      Q: { value: 1 },
      connect: (t: AudioNode) => t,
      disconnect: () => {
        self.disconnects += 1;
      },
    } as unknown as BiquadFilterNode;
  }
  createOscillator(): OscillatorNode {
    const self = this;
    const rec = { type: 'sine', frequency: param(), startedAt: -1 };
    this.oscillators.push(rec);
    return {
      get type() {
        return rec.type;
      },
      set type(v: string) {
        rec.type = v;
      },
      frequency: rec.frequency,
      connect: (t: AudioNode) => t,
      disconnect: () => {
        self.disconnects += 1;
      },
      start(when: number) {
        rec.startedAt = when;
      },
      stop: () => undefined,
    } as unknown as OscillatorNode;
  }
  createGain(): GainNode {
    const self = this;
    const g = param();
    this.gains.push(g);
    return {
      gain: g,
      connect: (t: AudioNode) => t,
      disconnect: () => {
        self.disconnects += 1;
      },
    } as unknown as GainNode;
  }
}

const build = (key: string, when = 0, opts?: { rate?: number; volume?: number }) => {
  const ctx = new FakeCtx();
  const voice = synthVoice(ctx as unknown as BaseAudioContext, ctx.destination, key, when, opts);
  return { ctx, voice };
};

describe('synthVoice: every shipped sound is built', () => {
  it('knows exactly the manifest keys, and refuses anything else', () => {
    // Population: all 9 manifest sfx keys. An unknown key must return null so the
    // engine falls back rather than silently playing nothing.
    for (const k of KEYS) expect(isSfxKey(k), k).toBe(true);
    expect(isSfxKey('nope')).toBe(false);
    expect(build('nope').voice).toBeNull();
  });

  it('builds a multi-layer voice with a real duration for each key', () => {
    for (const k of KEYS) {
      const { ctx, voice } = build(k);
      expect(voice, k).not.toBeNull();
      // At least two layers: a single oscillator is the old beep, which is what
      // this module exists to replace.
      expect(ctx.oscillators.length + ctx.sources.length, k).toBeGreaterThanOrEqual(2);
      // And it ends in the future -- the engine schedules teardown from this.
      expect(voice!.endsAt, k).toBeGreaterThan(0);
    }
  });
});

describe('the blocked-fire `click` arm (issue #516)', () => {
  it('has NO tone layer at all -- the absent oscillator IS the design', () => {
    // #516 asks this arm for "a short dry mechanical click, no tone". Every other recipe
    // in this file is two or three layers, because a single oscillator is the old beep;
    // this one is deliberately one BUFFER SOURCE and no oscillator, which is also why it
    // is the only audio arm that needed a recipe rather than a rate or a gain applied to
    // the baseline (director.ts). A click that grew a body would be the baseline refusal
    // again wearing a second flag value, and the comparison would compare nothing.
    //
    // MEASURED: adding the baseline's square blip to this recipe left all 16 of this
    // file's tests green before this case existed.
    const { ctx, voice } = build('fire-blocked-click');
    expect(voice).not.toBeNull();
    expect(ctx.oscillators).toHaveLength(0);
    expect(ctx.sources).toHaveLength(1);

    // Negative control: the baseline refusal DOES carry a tone, so the assertion above is
    // reading the recipe rather than a fake context that never records an oscillator.
    const baseline = build('fire-blocked');
    expect(baseline.ctx.oscillators.length).toBeGreaterThan(0);

    // And "short" is not decorative: it must end before the cue it is a stripped-down
    // version of, or "dry click" is just "quieter refusal".
    expect(voice!.endsAt).toBeLessThan(baseline.voice!.endsAt);
  });
});

describe('synthVoice: the sound design itself', () => {
  it('gives explosions a filtered NOISE body, not just a tone', () => {
    // An explosion built from oscillators alone is a beep. The noise source and
    // its downward filter sweep are the explosion.
    for (const k of ['explosion', 'mine-boom'] as const) {
      const { ctx } = build(k);
      expect(ctx.sources.length, k).toBeGreaterThan(0);
      const sweep = ctx.filters[0];
      expect(sweep, k).toBeDefined();
      const startHz = sweep.frequency.sets[0][0];
      const endHz = sweep.frequency.ramps[0][0];
      expect(endHz, k).toBeLessThan(startHz); // falls away, as debris does
    }
  });

  it('drops the cannon in pitch, which is what separates a cannon from a rifle', () => {
    const { ctx } = build('cannon');
    const body = ctx.oscillators[0];
    expect(body.frequency.sets[0][0]).toBeGreaterThan(body.frequency.ramps[0][0]);
  });

  it('keeps the enemy cannon quieter and duller than the player\'s', () => {
    // The player must tell their own shot from an enemy's without looking. Peak
    // gain is the first ramp target on each layer's envelope.
    const mine = build('cannon').ctx;
    const theirs = build('cannon-enemy').ctx;
    // Layer BY LAYER, in creation order. Comparing maxima let a raised inner
    // layer through; so did sorting, which discards which layer is which --
    // raising the enemy's tone to the player's still passed. Only gains that
    // carry an envelope are layers (the voice bus sets .value directly).
    const peaks = (c: FakeCtx): number[] =>
      c.gains.filter((g) => g.ramps.length > 0).map((g) => g.ramps[0][0]);
    const [mp, tp] = [peaks(mine), peaks(theirs)];
    expect(tp).toHaveLength(mp.length);
    for (let i = 0; i < mp.length; i++) expect(tp[i], `layer ${i}`).toBeLessThan(mp[i]);
    // Duller: the enemy's noise burst starts lower in the spectrum.
    expect(theirs.filters[0].frequency.sets[0][0]).toBeLessThan(mine.filters[0].frequency.sets[0][0]);
  });

  it('rings the ricochet on two partials so it reads metallic', () => {
    const { ctx } = build('ping');
    expect(ctx.oscillators).toHaveLength(2);
    const [a, b] = ctx.oscillators.map((o) => o.frequency.sets[0][0]);
    expect(a).not.toBe(b); // a single partial is a pure tone, not metal
    expect(Math.min(a, b)).toBeGreaterThan(1000); // and it sits above the shooting
  });

  it('sequences the multi-note stingers in time instead of stacking them', () => {
    // victory/defeat are little melodies; started together they are a chord and
    // the shape is lost.
    for (const k of ['victory', 'defeat', 'mine-arm'] as const) {
      const { ctx } = build(k);
      const starts = ctx.oscillators.map((o) => o.startedAt);
      // STRICTLY increasing, not merely "more than one distinct time": with
      // three notes, stacking two of them still left two distinct values.
      for (let i = 1; i < starts.length; i++) {
        expect(starts[i], `${k} note ${i}`).toBeGreaterThan(starts[i - 1]);
      }
      expect(starts.length, k).toBeGreaterThan(1);
    }
  });

  it('rises for victory and falls for defeat', () => {
    const up = build('victory').ctx.oscillators.map((o) => o.frequency.sets[0][0]);
    const down = build('defeat').ctx.oscillators.map((o) => o.frequency.sets[0][0]);
    expect(up[up.length - 1]).toBeGreaterThan(up[0]);
    expect(down[down.length - 1]).toBeLessThan(down[0]);
  });
});

describe('synthVoice: housekeeping', () => {
  it('reuses ONE noise buffer per context: a buffer per shot would be the cost', () => {
    const ctx = new FakeCtx();
    for (let i = 0; i < 5; i++) {
      synthVoice(ctx as unknown as BaseAudioContext, ctx.destination, 'explosion', i * 0.1);
    }
    expect(ctx.buffersMade).toBe(1);
  });

  it('is deterministic: the same key at the same time builds the same graph', () => {
    const a = build('mine-boom', 1.5).ctx;
    const b = build('mine-boom', 1.5).ctx;
    expect(a.oscillators.map((o) => o.frequency.sets)).toEqual(b.oscillators.map((o) => o.frequency.sets));
    expect(a.sources.map((s) => s.offset)).toEqual(b.sources.map((s) => s.offset));
  });

  it('varies the noise slice with time, so repeated shots do not comb-filter', () => {
    const first = build('cannon', 0.0).ctx.sources[0].offset;
    const later = build('cannon', 1.7).ctx.sources[0].offset;
    expect(first).not.toBeCloseTo(later, 5);
  });

  it('release() disconnects every node, and twice is not twice the work', () => {
    const { ctx, voice } = build('explosion');
    const total = ctx.oscillators.length + ctx.sources.length + ctx.filters.length + ctx.gains.length;
    voice!.release();
    expect(ctx.disconnects).toBe(total);
    voice!.release(); // idempotent: the engine may release on timer AND on dispose
    expect(ctx.disconnects).toBe(total);
  });

  it('RAISES pitch with rate: the director\'s ricochet ladder depends on it', () => {
    // director.ts plays 'ping' at rate 1 + bounceIndex * RICOCHET_RATE_STEP, so
    // each bounce is a step higher. An earlier version applied rate only to the
    // reported end time, so every bounce sounded identical -- an audible feature
    // silently deleted, with the whole suite green.
    const at = (rate: number): number[] =>
      build('ping', 0, { rate }).ctx.oscillators.map((o) => o.frequency.sets[0][0]);
    const base = at(1);
    const up = at(1.15);
    expect(up).toHaveLength(base.length);
    for (let i = 0; i < base.length; i++) expect(up[i], `partial ${i}`).toBeGreaterThan(base[i]);
    // Proportional, not merely different: the ladder must stay in tune with itself.
    expect(up[0] / base[0]).toBeCloseTo(1.15, 6);
  });

  it('shortens the sound as rate rises, so a faster voice is not also longer', () => {
    // Playback rate means brighter AND shorter. If duration did not scale, a
    // sped-up voice would ring past its own teardown deadline and be cut off.
    const slow = build('ping', 0, { rate: 1 }).voice!.endsAt;
    const fast = build('ping', 0, { rate: 1.5 }).voice!.endsAt;
    expect(fast).toBeLessThan(slow);
  });

  it('applies volume ONCE, on a single voice bus', () => {
    // Per-layer application would multiply: a two-layer sound at 0.25 would come
    // out at 0.0625 and the engine's volume slider would be badly non-linear.
    const { ctx } = build('cannon', 0, { volume: 0.25 });
    expect(ctx.gains.filter((g) => g.value === 0.25)).toHaveLength(1);
  });

  it('returns null rather than throwing on a context that cannot synthesise', () => {
    const bare = { currentTime: 0 } as unknown as BaseAudioContext;
    expect(synthVoice(bare, {} as AudioNode, 'cannon', 0)).toBeNull();
  });
});
