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

  it('a CONTEXT change lands on the next bar; a roam change still waits for the cycle', () => {
    // The player-visible defect this fixes: every suite change waited for the
    // playing track's next CYCLE boundary. Measured against the real modules,
    // a context change therefore lagged the screen by min 0.35s / median 6.35s
    // / max 11.85s (24 of 24 calls, swept every 0.5s across one 12.8s menu
    // cycle) -- so leaving the title screen played menu music several seconds
    // into the level, then changed suite while the round was underway.
    //
    // A ROAM change is a musical decision and still belongs at the cycle
    // boundary. A CONTEXT change is a response to the player and belongs at the
    // next bar. Both are asserted here, so the fix cannot be "switch instantly".
    const spec = (id: string): MusicTrackDef => ({
      id, stepSeconds: 0.5, barSteps: 2, chords: ['Am', 'F', 'C', 'G'],
      tracks: [{
        voice: 'bass',
        notes: [noteToHz('A1'), noteToHz('F1'), noteToHz('C2'), noteToHz('G1'),
                noteToHz('A1'), noteToHz('F1'), noteToHz('C2'), noteToHz('G1')],
        generate: null, intensity: 0,
      }],
    });
    // cycleSteps = 8 (the one layer is 8 notes), barSteps = 2 -> bars at 0,2,4,6.
    const landing = (at?: 'bar' | 'cycle'): number => {
      const { ctx, t, bed } = withTrack(spec('from'));
      bed.start();
      bed.changeSuite(spec('to'), at ? { at } : undefined);
      for (let i = 1; i <= 24; i++) {
        ctx.currentTime = i * 0.5;
        t.tick();
        if (bed.currentTrackId() === 'to') { bed.stop(); return i; }
      }
      bed.stop();
      return -1;
    };
    // Exact indices: the fake clock is deterministic (0.5s steps, 0.6s
    // lookahead, so scheduling runs one step ahead of the tick count).
    expect(landing(), 'a roam change stopped waiting for the cycle').toBe(7);
    expect(landing('cycle'), 'the explicit default disagreed with the implicit one').toBe(7);
    const bar = landing('bar');
    expect(bar, 'the context change never landed at all').toBeGreaterThan(0);
    expect(bar, 'a context change still waited for the cycle boundary').toBeLessThan(7);
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

  it('a QUEUED track cannot hijack a suite change: the new suite plays a full cycle first', () => {
    // Review reproduced this exactly: the pickup made the wrap one bar later
    // read as a cycle boundary, so changeSuite(B) + queueTrack(Q) played B for
    // its pickup bar only, then Q took over. B must play its pickup AND a full
    // cycle before any queued switch fires.
    const mk = (id: string, hz: string): MusicTrackDef => ({
      id, stepSeconds: 1, barSteps: 2, chords: ['Am', 'E'],
      tracks: [{ voice: 'bass', notes: [noteToHz(hz), noteToHz(hz), noteToHz(hz), noteToHz(hz)], generate: null, intensity: 0 }],
    });
    const a = mk('a', 'A1');
    const b = mk('b', 'C2');
    const q = mk('q', 'E2');
    const { ctx, t, bed } = withTrack(a);
    bed.start();
    bed.changeSuite(b);
    bed.queueTrack(q);
    for (let i = 1; i <= 20; i++) { ctx.currentTime = i; t.tick(); }
    const c2 = Math.round(noteToHz('C2')!);
    const bCount = ctx.notes.filter((n) => Math.round(n.freq) === c2).length;
    // b's pickup (2 steps) plus its full cycle (4 steps) = at least 6 sounding
    // steps before q may enter. The hijack gave exactly 2.
    expect(bCount, `b played only ${bCount} steps before being replaced`).toBeGreaterThanOrEqual(6);
    expect(bed.currentTrackId()).toBe('q'); // ...and q does arrive, eventually
    bed.stop();
  });

  it('a single-bar-cycle suite is not clobbered in the same step it arrives', () => {
    // startAtStep is 0 when the incoming cycle is one bar long, which used to
    // satisfy the queued check in the SAME step: the incoming suite never
    // sounded a note while the ramp described a transition to a discarded track.
    const from: MusicTrackDef = {
      id: 'from', stepSeconds: 1, barSteps: 2, chords: ['Am', 'E'],
      tracks: [{ voice: 'bass', notes: [noteToHz('A1'), noteToHz('A1'), noteToHz('A1'), noteToHz('A1')], generate: null, intensity: 0 }],
    };
    const single: MusicTrackDef = {
      id: 'single', stepSeconds: 0.5, barSteps: 2, chords: ['E'],
      tracks: [{ voice: 'bass', notes: [noteToHz('B1'), noteToHz('B1')], generate: null, intensity: 0 }],
    };
    const q: MusicTrackDef = {
      id: 'q', stepSeconds: 0.5, barSteps: 2, chords: ['E'],
      tracks: [{ voice: 'bass', notes: [noteToHz('G2'), noteToHz('G2')], generate: null, intensity: 0 }],
    };
    const { ctx, t, bed } = withTrack(from);
    bed.start();
    bed.changeSuite(single);
    bed.queueTrack(q);
    for (let i = 1; i <= 24; i++) { ctx.currentTime = i * 0.5; t.tick(); }
    const b1 = Math.round(noteToHz('B1')!);
    expect(
      ctx.notes.filter((n) => Math.round(n.freq) === b1).length,
      'the incoming suite never sounded',
    ).toBeGreaterThanOrEqual(4); // pickup + its full (one-bar) cycle
    bed.stop();
  });

  it('stop() mid-transition clears it: no stale ramp survives into a restart', () => {
    const from: MusicTrackDef = {
      id: 'from', stepSeconds: 1, barSteps: 8, chords: ['Am', 'E'],
      tracks: [{ voice: 'bass', notes: Array.from({ length: 16 }, () => noteToHz('A1')), generate: null, intensity: 0 }],
    };
    const to: MusicTrackDef = { ...from, id: 'to', stepSeconds: 0.5 };
    const { ctx, t, bed } = withTrack(from);
    bed.start();
    bed.changeSuite(to);
    expect(bed.inTransition(), 'a committed change is a transition in flight').toBe(true);
    for (let i = 1; i <= 18; i++) { ctx.currentTime = i; t.tick(); } // into the ramp
    bed.stop();
    expect(bed.inTransition(), 'stop() left the transition alive').toBe(false);
    // And a restart does not resume a stale ramp against a new clock.
    bed.start();
    expect(bed.inTransition()).toBe(false);
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

  it('consults the DIRECTOR at each completed cycle, and applies its directives', () => {
    // The wiring that makes the playlist real: a cycle completes, the director
    // answers, the bed applies it through the same paths a caller would use.
    const mk = (id: string, hz: string): MusicTrackDef => ({
      id, stepSeconds: 1, barSteps: 2, chords: ['Am', 'E'],
      tracks: [{ voice: 'bass', notes: [noteToHz(hz), noteToHz(hz), noteToHz(hz), noteToHz(hz)], generate: null, intensity: 0 }],
    });
    const a = mk('a', 'A1');
    const b = mk('b', 'C2');
    const calls: number[] = [];
    const director = {
      first: () => a,
      next: () => {
        calls.push(1);
        return calls.length === 1 ? ({ kind: 'queue', track: b } as const) : ({ kind: 'stay' } as const);
      },
      enterContext: () => null,
      currentContext: () => 'arena' as const,
    };
    const ctx = new FakeCtx();
    const t = fakeTimer();
    const bed = createMusicBed(ctx as unknown as BaseAudioContext, ctx.destination, {
      setInterval: t.setInterval, clearInterval: t.clearInterval, track: a, director,
    });
    bed.start();
    for (let i = 1; i <= 12; i++) { ctx.currentTime = i; t.tick(); }
    // Consulted once per completed 4-step cycle, not per step.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThan(6);
    // And the directive took effect: b plays after a's first full cycle.
    const c2 = Math.round(noteToHz('C2')!);
    expect(ctx.notes.filter((n) => Math.round(n.freq) === c2).length).toBeGreaterThan(0);
    expect(bed.currentTrackId()).toBe('b');
    bed.stop();
  });

  it("a 'suite' directive enters via the PICKUP; a 'queue' does not", () => {
    // The two directives must map to their distinct mechanisms. Downgrading a
    // suite change to a plain queue skips the pickup bar and the ramp -- the
    // entire handled join -- and nothing used to notice.
    const a: MusicTrackDef = {
      id: 'a', stepSeconds: 1, barSteps: 2, chords: ['Am', 'E'],
      tracks: [{ voice: 'bass', notes: [noteToHz('A1'), noteToHz('A1'), noteToHz('A1'), noteToHz('A1')], generate: null, intensity: 0 }],
    };
    // b's bars are distinct: bar 1 = D2, final bar = G2. Pickup entry plays G2
    // FIRST; a queued entry would open on D2.
    const b: MusicTrackDef = {
      id: 'b', stepSeconds: 1, barSteps: 2, chords: ['Dm', 'A'],
      tracks: [{ voice: 'bass', notes: [noteToHz('D2'), noteToHz('D2'), noteToHz('G2'), noteToHz('G2')], generate: null, intensity: 0 }],
    };
    let sent = false;
    const director = {
      first: () => a,
      next: () => {
        if (sent) return { kind: 'stay' } as const;
        sent = true;
        return { kind: 'suite', track: b } as const;
      },
      enterContext: () => null,
      currentContext: () => 'arena' as const,
    };
    const ctx = new FakeCtx();
    const t = fakeTimer();
    const bed = createMusicBed(ctx as unknown as BaseAudioContext, ctx.destination, {
      setInterval: t.setInterval, clearInterval: t.clearInterval, track: a, director,
    });
    bed.start();
    for (let i = 1; i <= 14; i++) { ctx.currentTime = i; t.tick(); }
    const bNotes = ctx.notes
      .map((n) => Math.round(n.freq))
      .filter((f) => f !== Math.round(noteToHz('A1')!));
    expect(bNotes.length).toBeGreaterThan(3);
    expect(bNotes[0], 'suite directive skipped the pickup bar').toBe(Math.round(noteToHz('G2')!));
    bed.stop();
  });

  it('does NOT consult the director at the pickup wrap -- only at real cycles', () => {
    // The pickup wraps stepsIntoCycle one bar in; consulting there would advance
    // the playlist before the member had actually played.
    const mk = (id: string, hz: string, step = 1): MusicTrackDef => ({
      id, stepSeconds: step, barSteps: 2, chords: ['Am', 'E'],
      tracks: [{ voice: 'bass', notes: [noteToHz(hz), noteToHz(hz), noteToHz(hz), noteToHz(hz)], generate: null, intensity: 0 }],
    });
    const a = mk('a', 'A1');
    const b = mk('b', 'C2');
    let consulted = 0;
    const director = {
      first: () => a,
      next: () => {
        consulted += 1;
        return { kind: 'stay' } as const;
      },
      enterContext: () => null,
      currentContext: () => 'arena' as const,
    };
    const ctx = new FakeCtx();
    const t = fakeTimer();
    const bed = createMusicBed(ctx as unknown as BaseAudioContext, ctx.destination, {
      setInterval: t.setInterval, clearInterval: t.clearInterval, track: a, director,
    });
    bed.start();
    bed.changeSuite(b);
    // Phase 1: a's own cycle completes (4 steps) -- but a suite change is
    // already committed, so there is nothing to ask: the director's previous
    // answer has not landed yet.
    for (let i = 1; i <= 4; i++) { ctx.currentTime = i; t.tick(); }
    expect(consulted, 'consulted while a switch was already pending').toBe(0);
    // Phase 2: b's pickup plays and WRAPS (2 steps). stepsIntoCycle hits 0 here,
    // but the member has only played one bar -- no consult.
    for (let i = 5; i <= 6; i++) { ctx.currentTime = i; t.tick(); }
    expect(consulted, 'the pickup wrap consulted the director').toBe(0);
    // Phase 3: b's full cycle finally completes -- now it is asked.
    for (let i = 7; i <= 12; i++) { ctx.currentTime = i; t.tick(); }
    expect(consulted).toBe(1);
    bed.stop();
  });

  it('a PAUSE does not desync the director from what actually plays', () => {
    // The gap that let two blockers through: every director test ran one
    // uninterrupted session, while loop.ts calls stopMusic() on EVERY non-
    // playing state -- Esc included. A committed switch must survive the pause,
    // or the director has counted a member against its dwell that never played.
    const mk = (id: string, hz: string): MusicTrackDef => ({
      id, stepSeconds: 1, barSteps: 2, chords: ['Am', 'E'],
      tracks: [{ voice: 'bass', notes: [noteToHz(hz), noteToHz(hz), noteToHz(hz), noteToHz(hz)], generate: null, intensity: 0 }],
    });
    const a = mk('a', 'A1');
    const b = mk('b', 'C2');
    // DISTINCT tracks per call: a director that hands the same track every time
    // makes a dropped directive invisible, because the next consult re-supplies
    // it. Each handed track must actually sound.
    const c = mk('c', 'E3');
    const queue = [b, c];
    const handed: MusicTrackDef[] = [];
    const director = {
      first: () => a,
      next: () => {
        const track = queue[handed.length] ?? c;
        handed.push(track);
        return { kind: 'queue', track } as const;
      },
      enterContext: () => null,
      currentContext: () => 'arena' as const,
    };
    const ctx = new FakeCtx();
    const t = fakeTimer();
    const bed = createMusicBed(ctx as unknown as BaseAudioContext, ctx.destination, {
      setInterval: t.setInterval, clearInterval: t.clearInterval, track: a, director,
    });
    bed.start();
    // Tick to the PRECISE window the blocker lives in: a directive handed out
    // but not yet adopted. Stopping at a fixed tick missed it -- b had already
    // been adopted, so the drop had nothing to drop.
    let ticks = 0;
    while (ticks < 20 && !(handed.length > 0 && bed.currentTrackId() === 'a')) {
      ticks += 1;
      ctx.currentTime = ticks;
      t.tick();
    }
    expect(handed.length, 'never reached the committed-but-unadopted window').toBe(1);
    expect(bed.currentTrackId()).toBe('a');
    bed.stop();   // Esc, with b committed but not yet adopted
    bed.start();  // resume
    for (let i = ticks + 1; i <= ticks + 12; i++) { ctx.currentTime = i; t.tick(); }
    // EVERY handed track must have sounded. Dropping the one committed at the
    // pause leaves the director believing it played while the bed never did.
    const played = new Set(ctx.notes.map((n) => Math.round(n.freq)));
    for (const track of handed) {
      const hz = Math.round(track.tracks[0].notes![0]!);
      expect(played, `"${track.id}" was handed out but never sounded`).toContain(hz);
    }
    bed.stop();
  });

  it('a pause during a PICKUP does not cut the incoming member to one bar', () => {
    // The second blocker: stop() zeroed the switch lock while leaving the cycle
    // position mid-pickup, so the pickup's premature wrap read as a real
    // boundary on resume and the incoming member vanished after one bar.
    const from: MusicTrackDef = {
      id: 'from', stepSeconds: 1, barSteps: 2, chords: ['Am', 'E'],
      tracks: [{ voice: 'bass', notes: [noteToHz('A1'), noteToHz('A1'), noteToHz('A1'), noteToHz('A1')], generate: null, intensity: 0 }],
    };
    const to: MusicTrackDef = {
      id: 'to', stepSeconds: 1, barSteps: 2, chords: ['Dm', 'A'],
      tracks: [{ voice: 'bass', notes: [noteToHz('D2'), noteToHz('D2'), noteToHz('G2'), noteToHz('G2')], generate: null, intensity: 0 }],
    };
    const other: MusicTrackDef = { ...from, id: 'other',
      tracks: [{ voice: 'bass', notes: [noteToHz('E3'), noteToHz('E3'), noteToHz('E3'), noteToHz('E3')], generate: null, intensity: 0 }] };
    // A track is ALREADY queued when the pause happens, so a stale cycle
    // position on resume would adopt it immediately and evict the incoming
    // member mid-pickup -- which is the shape of the original blocker.
    const director = {
      first: () => from,
      next: () => ({ kind: 'stay' } as const),
      enterContext: () => null,
      currentContext: () => 'arena' as const,
    };
    const ctx = new FakeCtx();
    const t = fakeTimer();
    const bed = createMusicBed(ctx as unknown as BaseAudioContext, ctx.destination, {
      setInterval: t.setInterval, clearInterval: t.clearInterval, track: from, director,
    });
    bed.start();
    bed.changeSuite(to);
    for (let i = 1; i <= 5; i++) { ctx.currentTime = i; t.tick(); } // into the pickup
    bed.queueTrack(other);
    bed.stop();
    bed.start();
    for (let i = 6; i <= 16; i++) { ctx.currentTime = i; t.tick(); }
    // The incoming member must sound for more than its pickup bar.
    const toNotes = ctx.notes.filter((n) =>
      [Math.round(noteToHz('D2')!), Math.round(noteToHz('G2')!)].includes(Math.round(n.freq)),
    );
    expect(toNotes.length, 'the incoming member was cut to its pickup').toBeGreaterThanOrEqual(4);
    bed.stop();
  });

  it('never becomes a per-STEP callback, even for a degenerate one-step cycle', () => {
    // cycleSteps can be 1 for a track with a single-note layer. createMusicBed
    // is a public factory and cycleSteps is derived, not validated, so the
    // interval carries a floor.
    const one: MusicTrackDef = {
      id: 'one', stepSeconds: 1, barSteps: 1, chords: ['Am'],
      tracks: [{ voice: 'bass', notes: [noteToHz('A1')], generate: null, intensity: 0 }],
    };
    let consulted = 0;
    const director = {
      first: () => one,
      next: () => {
        consulted += 1;
        return { kind: 'stay' } as const;
      },
      enterContext: () => null,
      currentContext: () => 'arena' as const,
    };
    const ctx = new FakeCtx();
    const t = fakeTimer();
    const bed = createMusicBed(ctx as unknown as BaseAudioContext, ctx.destination, {
      setInterval: t.setInterval, clearInterval: t.clearInterval, track: one, director,
    });
    bed.start();
    for (let i = 1; i <= 20; i++) { ctx.currentTime = i; t.tick(); }
    const steps = ctx.notes.length;
    expect(steps).toBeGreaterThan(15);
    expect(consulted, `consulted ${consulted} times over ${steps} steps`).toBeLessThan(steps / 2);
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
