// The bed schedules against the AUDIO clock, so a fake context plus an injected
// timer makes the whole thing testable without waiting in real time.
import { describe, it, expect } from 'vitest';
import { createMusicBed } from './music';
import { noteToHz, trackById, type MusicTrackDef } from './music-data';
import { MUSIC_TRACK_ID } from './engine';
import { parseChord } from './chords';

interface Sched {
  freq: number;
  startedAt: number;
  stoppedAt: number | null;
  hardStopped: boolean;
  disconnected: boolean;
}

class FakeCtx {
  currentTime = 0;
  sampleRate = 44100;
  destination = { connect: () => undefined, disconnect: () => undefined } as unknown as AudioNode;
  notes: Sched[] = [];
  gains: Array<{ value: number }> = [];

  createOscillator(): OscillatorNode {
    const rec: Sched = {
      freq: 0,
      startedAt: -1,
      stoppedAt: null,
      hardStopped: false,
      disconnected: false,
    };
    this.notes.push(rec);
    return {
      set type(_v: string) {},
      frequency: {
        setValueAtTime(v: number) {
          rec.freq = v;
        },
        exponentialRampToValueAtTime() {},
      },
      connect: (t: AudioNode) => t,
      disconnect: () => {
        rec.disconnected = true;
      },
      start(when: number) {
        rec.startedAt = when;
      },
      stop(when?: number) {
        if (when === undefined) rec.hardStopped = true;
        else rec.stoppedAt = when;
      },
      addEventListener: () => undefined,
    } as unknown as OscillatorNode;
  }
  createGain(): GainNode {
    const g = { value: 1 };
    this.gains.push(g);
    return {
      gain: Object.assign(g, {
        setValueAtTime: () => undefined,
        exponentialRampToValueAtTime: () => undefined,
      }),
      connect: (t: AudioNode) => t,
      disconnect: () => undefined,
    } as unknown as GainNode;
  }
}

/** A manual timer, so "time passes" is an explicit step in the test. */
function fakeTimer() {
  let fn: (() => void) | null = null;
  return {
    setInterval: (f: () => void) => {
      fn = f;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      fn = null;
    },
    tick: () => fn?.(),
    live: () => fn !== null,
  };
}

const make = (seed = 1234) => {
  const ctx = new FakeCtx();
  const t = fakeTimer();
  const bed = createMusicBed(ctx as unknown as BaseAudioContext, ctx.destination, {
    setInterval: t.setInterval,
    clearInterval: t.clearInterval,
    seed,
  });
  return { ctx, t, bed };
};

describe('composed tracks', () => {
  const withTrack = (track: MusicTrackDef) => {
    const ctx = new FakeCtx();
    const t = fakeTimer();
    const bed = createMusicBed(ctx as unknown as BaseAudioContext, ctx.destination, {
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
      track,
    });
    return { ctx, t, bed };
  };

  const twoLayers: MusicTrackDef = {
    id: 'test',
    stepSeconds: 1,
    barSteps: 0,
    chords: [],
    tracks: [
      { voice: 'bass', notes: [noteToHz('A1'), noteToHz('B1')], generate: null, intensity: 0 },
      { voice: 'drone', notes: [noteToHz('E3'), null, noteToHz('C4')], generate: null, intensity: 0 },
    ],
  };

  it('plays the AUTHORED notes, not the generated pattern', () => {
    const { ctx, bed } = withTrack(twoLayers);
    bed.start();
    const played = ctx.notes.map((n) => Math.round(n.freq));
    expect(played).toContain(Math.round(noteToHz('A1')!));
    expect(played).toContain(Math.round(noteToHz('E3')!));
    bed.stop();
  });

  it('advances each layer INDEPENDENTLY, so lengths need not divide each other', () => {
    // 2-step bass under a 3-step drone gives a 6-step cycle. If both layers
    // shared one cursor the drone would restart with the bass and the whole
    // point of differing lengths would be lost.
    const { ctx, t, bed } = withTrack(twoLayers);
    bed.start();
    for (let i = 1; i <= 6; i++) {
      ctx.currentTime = i;
      t.tick();
    }
    const bass = ctx.notes.filter((n) => n.freq < 100).map((n) => Math.round(n.freq));
    const a1 = Math.round(noteToHz('A1')!);
    const b1 = Math.round(noteToHz('B1')!);
    // The bass alternates every step; a shared cursor would break the alternation.
    expect(bass.slice(0, 4)).toEqual([a1, b1, a1, b1]);
    bed.stop();
  });

  it('honours a REST: the step passes silently and the cursor still advances', () => {
    const { ctx, t, bed } = withTrack(twoLayers);
    bed.start();
    // EXACTLY one cycle of the 3-step drone: start() schedules step 0 and each
    // tick adds one more, so two ticks gives steps 0, 1, 2 and no wrap. Counting
    // sounded notes only works if the number of steps is known precisely.
    for (let i = 1; i <= 2; i++) {
      ctx.currentTime = i;
      t.tick();
    }
    // The drone is E3, rest, C4. Review proved the old version of this test
    // could not fail: making rests sound a 1kHz tone left it green, because it
    // only checked that the notes AROUND the rest were present. Assert the
    // absence too -- the drone layer must have emitted exactly two notes, not
    // three, over three steps.
    const highs = ctx.notes.filter((n) => n.freq > 100).map((n) => Math.round(n.freq));
    expect(highs).toContain(Math.round(noteToHz('C4')!));
    expect(highs).toContain(Math.round(noteToHz('E3')!));
    // Three steps, one of them a rest -> exactly two notes.
    expect(highs, 'the rest sounded something').toHaveLength(2);
    bed.stop();
  });

  it("uses the TRACK's tempo, not the generated bed's", () => {
    const fast: MusicTrackDef = { ...twoLayers, stepSeconds: 0.25 };
    const { ctx, bed } = withTrack(fast);
    bed.start();
    const starts = [...new Set(ctx.notes.map((n) => Math.round(n.startedAt * 100)))].sort((a, b) => a - b);
    // At 0.25s steps the 0.6s lookahead covers several steps; at the bed's 1.5s
    // it would cover exactly one.
    expect(starts.length).toBeGreaterThan(1);
    bed.stop();
  });

  it('falls back to the generated bed when no track is given', () => {
    // The whole point of keeping the generator: authoring can be incomplete and
    // the game still has music.
    const ctx = new FakeCtx();
    const t = fakeTimer();
    const bed = createMusicBed(ctx as unknown as BaseAudioContext, ctx.destination, {
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
      track: null,
    });
    bed.start();
    expect(ctx.notes.length).toBeGreaterThan(0);
    bed.stop();
  });

  it('LOOPS without a seam: the wrap is just another step', () => {
    // In game the bed never restarts -- cursors wrap with % and scheduling runs
    // continuously -- so the loop point should be indistinguishable from any
    // other step. This pins both halves of that: the note SEQUENCE repeats with
    // the layer's period, and the TIMING has no gap or overlap at the wrap.
    const { ctx, t, bed } = withTrack(twoLayers); // bass has 2 steps, drone 3
    bed.start();
    for (let i = 1; i <= 14; i++) {
      ctx.currentTime = i;
      t.tick();
    }
    const starts = [...new Set(ctx.notes.map((n) => Number(n.startedAt.toFixed(6))))].sort(
      (a, b) => a - b,
    );
    expect(starts.length).toBeGreaterThan(8);
    // Every gap is a WHOLE NUMBER of steps. The stricter "exactly one step"
    // held only because this fixture has no fully-resting step; on the shipped
    // arena track 75 of its gaps span several steps, so that assertion was
    // testing the fixture rather than the wrap.
    for (let i = 1; i < starts.length; i++) {
      const steps = (starts[i] - starts[i - 1]) / twoLayers.stepSeconds;
      expect(steps, `gap at index ${i} is ${steps} steps`).toBeCloseTo(Math.round(steps), 9);
      expect(steps, `gap at index ${i}`).toBeGreaterThan(0);
    }
    // And the bass alternates without interruption across its wrap.
    const bass = ctx.notes.filter((n) => n.freq < 100).map((n) => Math.round(n.freq));
    const period = twoLayers.tracks[0].notes!.length;
    for (let i = period; i < bass.length; i++) {
      expect(bass[i], `bass step ${i} should repeat step ${i - period}`).toBe(bass[i - period]);
    }
    bed.stop();
  });

  it('SWITCHES tracks only at a cycle boundary, never mid-phrase', () => {
    // The whole seamlessness argument. Queue a swap partway through a cycle and
    // the outgoing track must finish it; the incoming one must start at ITS
    // step 0, not wherever the old cursor happened to be.
    const a: MusicTrackDef = {
      id: 'a', stepSeconds: 1, barSteps: 2, chords: ['Am', 'F'],
      tracks: [{ voice: 'bass', notes: [noteToHz('A1'), noteToHz('C2'), noteToHz('E2'), noteToHz('G2')], generate: null, intensity: 0 }],
    };
    const b: MusicTrackDef = {
      id: 'b', stepSeconds: 1, barSteps: 2, chords: ['Am', 'F'],
      tracks: [{ voice: 'bass', notes: [noteToHz('D1'), noteToHz('D2'), noteToHz('D1'), noteToHz('D2')], generate: null, intensity: 0 }],
    };
    const { ctx, t, bed } = withTrack(a);
    bed.start();
    ctx.currentTime = 1; t.tick(); // 2 steps in: mid-cycle
    bed.queueTrack(b);
    expect(bed.currentTrackId(), 'a queued switch must not take effect at once').toBe('a');
    for (let i = 2; i <= 9; i++) { ctx.currentTime = i; t.tick(); }

    const played = ctx.notes.map((n) => Math.round(n.freq));
    const aNotes = a.tracks[0].notes!.map((n) => Math.round(n!));
    const bNotes = b.tracks[0].notes!.map((n) => Math.round(n!));
    const switchAt = played.findIndex((f) => bNotes.includes(f) && !aNotes.includes(f));
    expect(switchAt, 'the switch never happened').toBeGreaterThan(0);
    // It landed on a multiple of the cycle length: 4 steps here.
    expect(switchAt % 4, `switched at step ${switchAt}, not a cycle boundary`).toBe(0);
    // Track a played WHOLE cycles up to that point -- no truncated phrase.
    expect(played.slice(0, switchAt)).toEqual(
      Array.from({ length: switchAt }, (_, i) => aNotes[i % aNotes.length]),
    );
    // And b starts at ITS beginning, not mid-pattern.
    expect(played.slice(switchAt, switchAt + 4)).toEqual(bNotes);
    expect(bed.currentTrackId()).toBe('b');
    bed.stop();
  });

  it('keeps the STEP GRID unbroken across a switch', () => {
    // A switch that dropped or doubled a step would be audible as a stumble even
    // if the notes themselves were right.
    const mk = (id: string, hz: number): MusicTrackDef => ({
      id, stepSeconds: 1, barSteps: 2, chords: ['Am', 'F'],
      tracks: [{ voice: 'bass', notes: [hz, hz], generate: null, intensity: 0 }],
    });
    const { ctx, t, bed } = withTrack(mk('x', noteToHz('A1')!));
    bed.start();
    bed.queueTrack(mk('y', noteToHz('D1')!));
    for (let i = 1; i <= 8; i++) { ctx.currentTime = i; t.tick(); }
    const starts = [...new Set(ctx.notes.map((n) => Number(n.startedAt.toFixed(6))))].sort((p, q) => p - q);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1], `gap at ${i} spans the switch`).toBeCloseTo(1, 9);
    }
    bed.stop();
  });

  it('enters a new SUITE through its dominant, with the grid unbroken', () => {
    // The handled join between two sets. Two things must hold: the dominant
    // really sounds (that is what makes the new key arrive rather than cut), and
    // the step grid survives the tempo ramp -- a ramp that drifted would
    // desynchronise everything after it.
    const from: MusicTrackDef = {
      id: 'from', stepSeconds: 1, barSteps: 2, chords: ['Am', 'F'],
      tracks: [{ voice: 'bass', notes: [noteToHz('A1'), noteToHz('A1'), noteToHz('A1'), noteToHz('A1')], generate: null, intensity: 0 }],
    };
    const to: MusicTrackDef = {
      id: 'to', stepSeconds: 0.5, barSteps: 2, chords: ['Dm', 'Gm'],
      tracks: [{ voice: 'bass', notes: [noteToHz('D1'), noteToHz('D1'), noteToHz('D1'), noteToHz('D1')], generate: null, intensity: 0 }],
    };
    const { ctx, t, bed } = withTrack(from);
    bed.start();
    // Dm's dominant is A major -- that is the chord that pulls into D.
    bed.changeSuite(to, parseChord('A')!, 4);
    for (let i = 1; i <= 30; i++) { ctx.currentTime = i * 0.5; t.tick(); }

    const freqs = ctx.notes.map((n) => Math.round(n.freq));
    // The dominant assembles as a ROLLED chord: root, third, fifth entering at
    // staggered times, each SUSTAINED to the end of the passage. Three heard
    // faults excluded at once: the slab (all notes at once), the plink (short
    // stark notes with a rhythm of their own -- Austin heard both the timbre
    // and the rhythm as wrong), and absence.
    const wanted = ['A3', 'C#3', 'E3'].map((x) => Math.round(noteToHz(x)!));
    const domTones = ctx.notes.filter((n) => wanted.includes(Math.round(n.freq)));
    expect(domTones.length).toBeGreaterThanOrEqual(3);
    const entries = domTones.map((n) => n.startedAt);
    expect(new Set(entries).size, 'the triad landed all at once: that is the slab').toBeGreaterThan(1);
    // Sustained, not plinked: each tone rings for several steps, so the layer
    // has no rhythmic figure to fight the bass pulse.
    for (const n of domTones) {
      expect(n.stoppedAt, `tone at ${n.startedAt} never got a stop time`).not.toBeNull();
      expect(n.stoppedAt! - n.startedAt, `tone at ${n.startedAt} plinked`).toBeGreaterThan(1.5);
    }
    // And the dominant layer enters FEWER times than the passage has steps:
    // one note per step is a competing rhythm, which was the juxtaposition jar.
    expect(domTones.length).toBeLessThan(4);
    // And the destination arrived.
    expect(freqs).toContain(Math.round(noteToHz('D1')!));
    expect(bed.currentTrackId()).toBe('to');
    expect(bed.inTransition()).toBe(false);

    // The grid: every gap is a whole number of steps at SOME tempo in the range
    // the ramp spans. A drifting ramp shows up as a gap outside that band.
    const starts = [...new Set(ctx.notes.map((n) => Number(n.startedAt.toFixed(6))))].sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i] - starts[i - 1];
      expect(gap, `gap ${i} is ${gap}s`).toBeGreaterThan(0);
      expect(gap, `gap ${i} is ${gap}s, outside the ramp's tempo range`).toBeLessThanOrEqual(1 * 4 + 1e-9);
    }
    bed.stop();
  });

  it('keeps the outgoing RHYTHM but speaks ONE harmony through the passage', () => {
    // Austin heard the held-triad version as "sloppy and sudden", and the mush
    // was real: the outgoing pads kept their old key under a block chord in a
    // texture nothing else uses. The passage now keeps the outgoing bass RHYTHM
    // -- same steps sound, including its rests -- repitched onto the dominant,
    // with the dominant arpeggiated rather than held. The old pitches must NOT
    // sound: one harmony at a time is the whole point.
    const from: MusicTrackDef = {
      id: 'from', stepSeconds: 1, barSteps: 2, chords: ['Dm', 'Gm'],
      tracks: [
        // A rest in the pattern, so rhythm preservation is testable: a version
        // that pulses every step regardless would fill it in.
        { voice: 'bass', notes: [noteToHz('D1'), null, noteToHz('D2'), null], generate: null, intensity: 0 },
        { voice: 'pad', notes: [noteToHz('F3'), noteToHz('F3'), noteToHz('F3'), noteToHz('F3')], generate: null, intensity: 0 },
      ],
    };
    const to: MusicTrackDef = {
      id: 'to', stepSeconds: 1, barSteps: 2, chords: ['Am', 'Am'],
      tracks: [{ voice: 'bass', notes: [noteToHz('A2'), noteToHz('A2'), noteToHz('A2'), noteToHz('A2')], generate: null, intensity: 0 }],
    };
    const { ctx, t, bed } = withTrack(from);
    bed.start();
    bed.changeSuite(to, parseChord('E')!, 4); // E major pulls into Am
    for (let i = 1; i <= 12; i++) { ctx.currentTime = i; t.tick(); }

    // The passage spans steps 4..7 (times 4..7s). Gather what sounded there.
    const passage = ctx.notes.filter((n) => n.startedAt >= 4 && n.startedAt < 8);
    const hz = (name: string): number => Math.round(noteToHz(name)!);
    const freqs = passage.map((n) => Math.round(n.freq));
    // Bass: dominant root at the outgoing contour -- E1 where D1 was, E2 where
    // D2 was -- and NOTHING on the rest steps.
    // Times carry the bed's 0.08s start offset; strip it before taking steps.
    const bassSteps = passage.filter((n) => n.freq < 100).map((n) => Math.round((n.startedAt - 0.08) % 4));
    expect(freqs).toContain(hz('E1'));
    expect(freqs).toContain(hz('E2'));
    expect(new Set(bassSteps), 'bass sounded on a rest step').toEqual(new Set([0, 2]));
    // One harmony: the outgoing D roots and F pad are gone from the passage.
    for (const old of ['D1', 'D2', 'F3']) {
      expect(freqs, `outgoing ${old} bled through the pivot`).not.toContain(hz(old));
    }
    bed.stop();
  });

  it('RAMPS the tempo across the transition rather than switching instantly', () => {
    const from: MusicTrackDef = {
      id: 'slow', stepSeconds: 1, barSteps: 2, chords: ['Am', 'F'],
      tracks: [{ voice: 'bass', notes: [noteToHz('A1'), noteToHz('A1')], generate: null, intensity: 0 }],
    };
    const to: MusicTrackDef = {
      id: 'fast', stepSeconds: 0.25, barSteps: 2, chords: ['Am', 'F'],
      tracks: [{ voice: 'bass', notes: [noteToHz('A1'), noteToHz('A1')], generate: null, intensity: 0 }],
    };
    const { ctx, t, bed } = withTrack(from);
    bed.start();
    bed.changeSuite(to, parseChord('E')!, 8);
    for (let i = 1; i <= 40; i++) { ctx.currentTime = i * 0.5; t.tick(); }
    const starts = [...new Set(ctx.notes.map((n) => Number(n.startedAt.toFixed(6))))].sort((a, b) => a - b);
    const gaps = starts.slice(1).map((v, i) => v - starts[i]);
    // An instant switch would show only 1.0 and 0.25. A ramp visits values in
    // between -- that is the whole point.
    const between = gaps.filter((g) => g > 0.3 && g < 0.95);
    expect(between.length, `gaps: ${gaps.map((g) => g.toFixed(2)).join(',')}`).toBeGreaterThan(0);
    bed.stop();
  });

  it('plays THE track the engine asks for, by id', () => {
    // Review proved the old version could not fail: `trackById('arena')!` yields
    // null when the id is absent, withTrack(null) silently takes the generated
    // bed, and "some notes were scheduled" is satisfied by the generator. So
    // renaming the one track the game plays kept the whole suite green.
    const arena = trackById(MUSIC_TRACK_ID);
    expect(arena, `engine plays "${MUSIC_TRACK_ID}" but no such track exists`).not.toBeNull();
    const { ctx, bed } = withTrack(arena!);
    bed.start();
    // And it plays THAT track. A pitch is legitimate if it was authored, or --
    // for a generated layer -- if it belongs to one of the track's declared
    // chords. That second clause is the safety property generation rests on:
    // nothing can sound that is not in the harmony.
    const authored = new Set(
      arena!.tracks.flatMap((l) => l.notes ?? []).filter((n): n is number => n !== null).map((n) => Math.round(n)),
    );
    const harmony = new Set(
      arena!.chords.flatMap((c) => parseChord(c)?.pitchClasses ?? []),
    );
    expect(ctx.notes.length).toBeGreaterThan(0);
    for (const n of ctx.notes) {
      const hz = Math.round(n.freq);
      if (authored.has(hz)) continue;
      const pc = ((Math.round(12 * Math.log2(n.freq / 440)) + 9) % 12 + 12) % 12;
      expect(harmony, `scheduled ${hz}Hz: neither authored nor in the harmony`).toContain(pc);
    }
    bed.stop();
  });
});

describe('the generated music bed', () => {
  it('schedules notes ahead on the AUDIO clock, not on timer time', () => {
    const { ctx, bed } = make();
    bed.start();
    expect(ctx.notes.length).toBeGreaterThan(0);
    // Every note is placed at or after "now" and inside the lookahead window --
    // scheduling on timer time instead would bunch them all at currentTime.
    for (const n of ctx.notes) {
      expect(n.startedAt).toBeGreaterThanOrEqual(ctx.currentTime);
      expect(n.startedAt).toBeLessThan(ctx.currentTime + 1.0);
    }
    bed.stop();
  });

  it('keeps scheduling as the clock advances, without re-scheduling the past', () => {
    const { ctx, t, bed } = make();
    bed.start();
    const first = ctx.notes.length;
    const firstStarts = ctx.notes.map((n) => n.startedAt);
    ctx.currentTime = 3.2;
    t.tick();
    expect(ctx.notes.length).toBeGreaterThan(first);
    // The new notes are all in the future; none replays a slot already played.
    for (const n of ctx.notes.slice(first)) expect(n.startedAt).toBeGreaterThanOrEqual(3.2);
    expect(ctx.notes.slice(0, first).map((n) => n.startedAt)).toEqual(firstStarts);
    bed.stop();
  });

  it('SILENCES notes already scheduled into the future when stopped', () => {
    // Stopping the timer alone leaves up to a lookahead window of music playing
    // after the player asked for silence -- the bug this pins.
    const { ctx, bed } = make();
    bed.start();
    const scheduled = ctx.notes.length;
    expect(scheduled).toBeGreaterThan(0);
    bed.stop();
    expect(ctx.notes.filter((n) => n.hardStopped)).toHaveLength(scheduled);
    expect(bed.isPlaying()).toBe(false);
  });

  it('does not layer a second bed when started twice', () => {
    const { ctx, bed } = make();
    bed.start();
    const after = ctx.notes.length;
    bed.start();
    expect(ctx.notes.length).toBe(after);
    bed.stop();
  });

  it('does not run away when the tab was backgrounded for a long stall', () => {
    // A naive scheduler catches up by emitting one note per missed step, so
    // returning to the tab fires a burst all at once.
    const { ctx, t, bed } = make();
    bed.start();
    const before = ctx.notes.length;
    ctx.currentTime = 600; // ten minutes hidden
    t.tick();
    const added = ctx.notes.length - before;
    expect(added).toBeLessThan(6); // a window's worth, not ten minutes' worth
    bed.stop();
  });

  it('ADVANCES the bass pattern: the only melodic content in the module', () => {
    // Freezing the step counter makes every bass note the same pitch forever --
    // the bed becomes one droning note -- and the determinism test above does not
    // notice, because the drone still varies by seed.
    const { ctx, t, bed } = make();
    bed.start();
    for (let i = 1; i <= 12; i++) {
      ctx.currentTime = i * 1.5;
      t.tick();
    }
    // The bass is the lowest voice; take the distinct pitches it has played.
    const lows = ctx.notes.map((n) => n.freq).filter((f) => f < 100);
    expect(lows.length).toBeGreaterThan(4);
    expect(new Set(lows).size).toBeGreaterThan(1);
    bed.stop();
  });

  it('is deterministic per seed, and different seeds differ', () => {
    const a = make(11);
    const b = make(11);
    const c = make(99);
    for (const m of [a, b, c]) {
      m.bed.start();
      m.ctx.currentTime = 9;
      m.t.tick();
    }
    expect(a.ctx.notes.map((n) => n.freq)).toEqual(b.ctx.notes.map((n) => n.freq));
    expect(c.ctx.notes.map((n) => n.freq)).not.toEqual(a.ctx.notes.map((n) => n.freq));
  });

  it('carries volume to the bus, including zero for mute', () => {
    const { ctx, bed } = make();
    bed.setVolume(0.4);
    bed.start();
    // The bus is the gain the bed connects to dest; it holds the set volume.
    expect(ctx.gains.some((g) => g.value === 0.4)).toBe(true);
    bed.setVolume(0);
    expect(ctx.gains.some((g) => g.value === 0)).toBe(true);
    bed.stop();
  });

  it('stays silent on a context that cannot schedule, rather than throwing', () => {
    const bare = {
      currentTime: 0,
      createGain: () => ({ gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined }),
    } as unknown as BaseAudioContext;
    const bed = createMusicBed(bare, {} as AudioNode, { setInterval: () => 1 as never });
    expect(() => bed.start()).not.toThrow();
    expect(bed.isPlaying()).toBe(false);
  });

  it('dispose stops it and keeps it stopped', () => {
    const { t, bed } = make();
    bed.start();
    bed.dispose();
    expect(t.live()).toBe(false);
    bed.start();
    expect(bed.isPlaying()).toBe(false);
  });
});
