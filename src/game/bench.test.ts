import { describe, it, expect } from 'vitest';
import {
  BENCH_REPORT_SCHEMA,
  BENCH_WORKLOADS,
  buildBenchReport,
  createFrameRecorder,
  instrumentRaf,
  summarizeFrames,
} from './bench';
import type { RafScheduler } from './driver';

const SESSION = { seed: 7, arenaId: 'arena-01', mode: 'ffa', humanPlayers: 0, bots: 4, quality: 'high' };
const PAGE = { search: '?dev=1&bench=versus-bots', viewport: { width: 390, height: 844 }, devicePixelRatio: 3, userAgent: 'test' };
const BUILD = { commit: '', known: false };

describe('summarizeFrames: nearest-rank percentiles and long-frame counts', () => {
  it('reports nothing measured as nulls and zero counts, not as zero milliseconds', () => {
    expect(summarizeFrames([])).toEqual({
      count: 0, p50: null, p95: null, p99: null, max: null, over16_7: 0, over33_3: 0, over50: 0,
    });
  });

  it('gives a single frame as every percentile', () => {
    expect(summarizeFrames([20])).toEqual({
      count: 1, p50: 20, p95: 20, p99: 20, max: 20, over16_7: 1, over33_3: 0, over50: 0,
    });
  });

  it('takes percentiles by nearest rank from unsorted input: 1..100 gives p50 50, p95 95, p99 99', () => {
    const shuffled = Array.from({ length: 100 }, (_, i) => ((i * 37) % 100) + 1);
    const s = summarizeFrames(shuffled);
    expect([s.count, s.p50, s.p95, s.p99, s.max]).toEqual([100, 50, 95, 99, 100]);
  });

  it('counts a frame as long only when it is strictly over each threshold', () => {
    const s = summarizeFrames([16.7, 16.8, 33.3, 33.4, 50, 50.1]);
    expect([s.over16_7, s.over33_3, s.over50]).toEqual([5, 3, 1]);
  });
});

describe('createFrameRecorder: one warm-up, one measurement window', () => {
  it('measures nothing during warm-up, then samples the frames after the window opens', () => {
    const r = createFrameRecorder({ warmupMs: 100, durationMs: 1000 });
    for (const t of [0, 50, 90]) r.frame(t, 1, 0);
    expect(r.phase).toBe('warmup');
    r.frame(100, 1, 0);
    expect(r.phase).toBe('measuring');
    expect(r.samples()).toEqual([]);
    r.frame(116, 4, 1);
    r.frame(150, 9, 3);
    expect(r.samples()).toEqual([
      { intervalMs: 16, workMs: 4 },
      { intervalMs: 34, workMs: 9 },
    ]);
    expect(r.measuredMs).toBe(50);
  });

  it('closes the window on the first frame past its duration, and ignores every frame after', () => {
    const r = createFrameRecorder({ warmupMs: 0, durationMs: 100 });
    r.frame(0, 1, 0);
    r.frame(10, 1, 0);
    r.frame(60, 2, 3);
    r.frame(110, 3, 6);
    r.frame(111, 4, 9);
    expect(r.phase).toBe('done');
    expect(r.samples()).toEqual([
      { intervalMs: 50, workMs: 2 },
      { intervalMs: 50, workMs: 3 },
    ]);
    r.frame(200, 5, 12);
    expect(r.samples()).toHaveLength(2);
    expect(r.simulatedTicks).toBe(6);
  });

  it('sums simulated ticks across a world rebuild, where the tick restarts at 0', () => {
    const r = createFrameRecorder({ warmupMs: 0, durationMs: 1000 });
    r.frame(0, 1, 40);
    r.frame(10, 1, 40);
    r.frame(20, 1, 55);
    r.frame(30, 1, 5);
    r.frame(40, 1, 12);
    expect(r.simulatedTicks).toBe(15 + 5 + 7);
  });
});

describe('instrumentRaf: times the callback without changing it', () => {
  function fakeRaf(): RafScheduler & { fire(t: number): void; cancelled: number[] } {
    let pending: ((t: number) => void) | null = null;
    const cancelled: number[] = [];
    return {
      request(cb): number {
        pending = cb;
        return 7;
      },
      cancel(handle): void {
        cancelled.push(handle);
      },
      fire(t): void {
        const cb = pending;
        pending = null;
        cb?.(t);
      },
      cancelled,
    };
  }

  it('hands the callback the browser timestamp and reports its run time', () => {
    const raf = fakeRaf();
    let clock = 1000;
    const seen: number[] = [];
    const frames: Array<[number, number]> = [];
    const wrapped = instrumentRaf(raf, () => clock, (t, work) => frames.push([t, work]));
    expect(wrapped.request((t) => { seen.push(t); clock += 6; })).toBe(7);
    raf.fire(16.5);
    expect(seen).toEqual([16.5]);
    expect(frames).toEqual([[16.5, 6]]);
  });

  it('reports a frame whose callback throws, and still throws', () => {
    const raf = fakeRaf();
    const frames: Array<[number, number]> = [];
    const wrapped = instrumentRaf(raf, () => 0, (t, work) => frames.push([t, work]));
    wrapped.request(() => { throw new Error('boom'); });
    expect(() => raf.fire(33)).toThrow('boom');
    expect(frames).toEqual([[33, 0]]);
  });

  it('passes cancel through to the real scheduler', () => {
    const raf = fakeRaf();
    instrumentRaf(raf, () => 0, () => {}).cancel(7);
    expect(raf.cancelled).toEqual([7]);
  });
});

describe('buildBenchReport', () => {
  function recorded(): ReturnType<typeof createFrameRecorder> {
    const r = createFrameRecorder({ warmupMs: 0, durationMs: 1000 });
    r.frame(0, 1, 0);
    r.frame(1, 1, 0);
    r.frame(21, 3, 1);
    r.frame(61, 5, 3);
    return r;
  }

  it('summarizes intervals as frames and callback time as work, never the other way round', () => {
    const report = buildBenchReport({ workload: 'versus-bots', recorder: recorded(), session: SESSION, pixelRatioCap: 2, page: PAGE, build: BUILD });
    expect([report.frames.count, report.frames.max, report.frames.p50]).toEqual([2, 40, 20]);
    expect([report.work.count, report.work.max, report.work.p50]).toEqual([2, 5, 3]);
    expect(report.simulatedTicks).toBe(3);
  });

  it('caps the device pixel ratio by the preset, as the renderer does', () => {
    const capped = buildBenchReport({ workload: 'versus-bots', recorder: recorded(), session: SESSION, pixelRatioCap: 2, page: PAGE, build: BUILD });
    expect(capped.render).toEqual({ pixelRatioCap: 2, effectivePixelRatio: 2 });
    const under = buildBenchReport({ workload: 'versus-bots', recorder: recorded(), session: SESSION, pixelRatioCap: 4, page: PAGE, build: BUILD });
    expect(under.render.effectivePixelRatio).toBe(3);
  });

  it('names its schema version and the workload it ran, with the page, session and build', () => {
    const report = buildBenchReport({ workload: 'versus-bots', recorder: recorded(), session: SESSION, pixelRatioCap: 2, page: PAGE, build: BUILD });
    expect(report.schema).toBe(BENCH_REPORT_SCHEMA);
    expect(report.workload).toBe(BENCH_WORKLOADS['versus-bots']);
    expect([report.page, report.session, report.build]).toEqual([PAGE, SESSION, BUILD]);
    expect(report.phase).toBe('measuring');
  });
});
