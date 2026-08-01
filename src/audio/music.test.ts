// The bed schedules against the AUDIO clock, so a fake context plus an injected
// timer makes the whole thing testable without waiting in real time.
import { describe, it, expect } from 'vitest';
import { createMusicBed } from './music';

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
