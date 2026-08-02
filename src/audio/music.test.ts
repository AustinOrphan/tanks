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

  it('bridges with material from the SECTIONS THEMSELVES, nothing invented', () => {
    // Austin, after four iterations of composed interstitial material: "you're
    // still using something that exists in neither section to bridge between
    // the two and it's off". This is that sentence as an assertion: every pitch
    // scheduled across the whole run, transition included, must come from one
    // of the two tracks' own note lists. There is no third thing.
    const from: MusicTrackDef = {
      id: 'from', stepSeconds: 1, barSteps: 2, chords: ['Dm', 'A'],
      tracks: [
        { voice: 'bass', notes: [noteToHz('D1'), noteToHz('F1'), noteToHz('A1'), noteToHz('C#2')], generate: null, intensity: 0 },
        // A lead too, so the OVERLAP path is inside this sweep: its notes are
        // legal material, and anything else the overlap emitted would fail.
        { voice: 'lead', notes: [noteToHz('D4'), noteToHz('F4'), noteToHz('A4'), noteToHz('E4')], generate: null, intensity: 0 },
      ],
    };
    const to: MusicTrackDef = {
      id: 'to', stepSeconds: 0.5, barSteps: 2, chords: ['Am', 'E'],
      tracks: [{ voice: 'bass', notes: [noteToHz('A2'), noteToHz('C3'), noteToHz('E2'), noteToHz('G#2')], generate: null, intensity: 0 }],
    };
    const { ctx, t, bed } = withTrack(from);
    bed.start();
    bed.changeSuite(to);
    for (let i = 1; i <= 30; i++) { ctx.currentTime = i * 0.5; t.tick(); }
    const legal = new Set(
      [...from.tracks.flatMap((l) => l.notes ?? []), ...to.tracks.flatMap((l) => l.notes ?? [])]
        .filter((n): n is number => n !== null)
        .map((n) => Math.round(n)),
    );
    expect(ctx.notes.length).toBeGreaterThan(8);
    for (const n of ctx.notes) {
      expect(legal, `scheduled ${Math.round(n.freq)}Hz: material from neither section`).toContain(
        Math.round(n.freq),
      );
    }
    expect(bed.currentTrackId()).toBe('to');
    bed.stop();
  });

  it("enters through the incoming piece's OWN final bar -- its dominant -- first", () => {
    // The through-line construction ends every progression on its dominant, so
    // the incoming track's last bar IS the entry music. The first thing heard
    // from the new section must be that final bar, then the cycle proper.
    const to: MusicTrackDef = {
      id: 'to', stepSeconds: 1, barSteps: 2, chords: ['Am', 'E'],
      tracks: [{ voice: 'bass', notes: [noteToHz('A2'), noteToHz('A2'), noteToHz('E2'), noteToHz('G#2')], generate: null, intensity: 0 }],
    };
    const from: MusicTrackDef = {
      id: 'from', stepSeconds: 1, barSteps: 2, chords: ['Dm', 'A'],
      tracks: [{ voice: 'bass', notes: [noteToHz('D1'), noteToHz('D1'), noteToHz('D1'), noteToHz('D1')], generate: null, intensity: 0 }],
    };
    const { ctx, t, bed } = withTrack(from);
    bed.start();
    bed.changeSuite(to);
    for (let i = 1; i <= 16; i++) { ctx.currentTime = i; t.tick(); }
    const incoming = ctx.notes
      .map((n) => Math.round(n.freq))
      .filter((f) => f !== Math.round(noteToHz('D1')!));
    // Final bar first (E2, G#2 -- the V bar), THEN the cycle from the top.
    const e2 = Math.round(noteToHz('E2')!);
    const gs2 = Math.round(noteToHz('G#2')!);
    const a2 = Math.round(noteToHz('A2')!);
    expect(incoming.slice(0, 2), 'the pickup bar was skipped').toEqual([e2, gs2]);
    expect(incoming.slice(2, 4), 'the cycle proper did not follow').toEqual([a2, a2]);
    bed.stop();
  });

  it('carries the OUTGOING melody over the pickup, fading, then gone', () => {
    // The overlap Austin asked for, bounded by the no-invented-material law:
    // the overlapping notes are the outgoing track's own last-bar lead line.
    // It must sound DURING the pickup and be silent once the cycle proper
    // starts -- an overlap that lingers is two melodies fighting.
    const from: MusicTrackDef = {
      id: 'from', stepSeconds: 1, barSteps: 2, chords: ['Dm', 'A'],
      tracks: [
        { voice: 'bass', notes: [noteToHz('D1'), noteToHz('D1'), noteToHz('A1'), noteToHz('A1')], generate: null, intensity: 0 },
        // The lead's LAST BAR is C#5/E5 -- distinct pitches, so presence in the
        // pickup window is attributable.
        { voice: 'lead', notes: [noteToHz('D5'), noteToHz('F5'), noteToHz('C#5'), noteToHz('E5')], generate: null, intensity: 0 },
      ],
    };
    const to: MusicTrackDef = {
      id: 'to', stepSeconds: 1, barSteps: 2, chords: ['Am', 'E'],
      tracks: [{ voice: 'bass', notes: [noteToHz('A2'), noteToHz('A2'), noteToHz('E2'), noteToHz('G#2')], generate: null, intensity: 0 }],
    };
    const { ctx, t, bed } = withTrack(from);
    bed.start();
    bed.changeSuite(to);
    for (let i = 1; i <= 16; i++) { ctx.currentTime = i; t.tick(); }

    const cs5 = Math.round(noteToHz('C#5')!);
    const e5 = Math.round(noteToHz('E5')!);
    // The pickup spans steps 4..5 (the incoming 2-step final bar). The outgoing
    // lead's final-bar notes ride over exactly that window.
    const outgoingLeadTimes = ctx.notes
      .filter((n) => [cs5, e5].includes(Math.round(n.freq)))
      .map((n) => Math.round(n.startedAt - 0.08));
    const inPickup = outgoingLeadTimes.filter((x) => x === 4 || x === 5);
    const after = outgoingLeadTimes.filter((x) => x > 5);
    expect(inPickup.length, 'no overlap sounded in the pickup').toBeGreaterThan(0);
    expect(after, 'the overlap lingered past the pickup').toEqual([]);
    bed.stop();
  });

  it('RAMPS the tempo across the pickup bar rather than switching instantly', () => {
    // The ramp spans the incoming piece's pickup bar, so its resolution IS the
    // bar length: 2-step fixture bars gave only the two endpoints, which is why
    // this fixture uses realistic 8-step bars.
    const mkNotes = (name: string, n: number): Array<number | null> =>
      Array.from({ length: n }, () => noteToHz(name));
    const from: MusicTrackDef = {
      id: 'slow', stepSeconds: 1, barSteps: 8, chords: ['Am', 'E'],
      tracks: [{ voice: 'bass', notes: mkNotes('A1', 16), generate: null, intensity: 0 }],
    };
    const to: MusicTrackDef = {
      id: 'fast', stepSeconds: 0.25, barSteps: 8, chords: ['Am', 'E'],
      tracks: [{ voice: 'bass', notes: mkNotes('A1', 16), generate: null, intensity: 0 }],
    };
    const { ctx, t, bed } = withTrack(from);
    bed.start();
    bed.changeSuite(to);
    for (let i = 1; i <= 80; i++) { ctx.currentTime = i * 0.5; t.tick(); }
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
