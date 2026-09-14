import { describe, it, expect } from 'vitest';
import {
  BENCH_REPORT_SCHEMA,
  BENCH_WORKLOADS,
  buildBenchReport,
  createFrameRecorder,
  createPreviewBench,
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

  it('does not sample a frame that breaks the run, and takes the next interval from it (issue #736)', () => {
    // A loop that stopped for five seconds and started again: the restart frame's interval is
    // the gap, not a frame time, and the frame after it is an ordinary 16 ms frame.
    const r = createFrameRecorder({ warmupMs: 0, durationMs: 10_000 });
    r.frame(0, 1, 0);
    r.frame(10, 1, 0);
    r.frame(26, 2, 0);
    r.frame(5_000, 3, 0, false);
    r.frame(5_016, 4, 0);
    expect(r.samples()).toEqual([
      { intervalMs: 16, workMs: 2 },
      { intervalMs: 16, workMs: 4 },
    ]);
    expect(r.measuredMs).toBe(5_006);
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

  it('marks a frame continued only when the previous callback requested it (issue #736)', () => {
    // A loop that runs three frames and stops, then is started again from outside a callback,
    // the way the preview restarts on setAnimating, visibilitychange or a resume timer.
    const raf = fakeRaf();
    const seen: boolean[] = [];
    const wrapped = instrumentRaf(raf, () => 0, (_t, _work, continued) => seen.push(continued));
    let runs = 0;
    const loop = (): void => {
      runs += 1;
      if (runs < 3) wrapped.request(loop);
    };
    wrapped.request(loop);
    raf.fire(0);
    raf.fire(16);
    raf.fire(32);
    wrapped.request(() => {});
    raf.fire(900);
    expect(seen).toEqual([false, true, true, false]);
  });

  it('does not mark the next start continued after a callback threw (issue #736)', () => {
    const raf = fakeRaf();
    const seen: boolean[] = [];
    const wrapped = instrumentRaf(raf, () => 0, (_t, _work, continued) => seen.push(continued));
    wrapped.request(() => { throw new Error('boom'); });
    expect(() => raf.fire(0)).toThrow('boom');
    wrapped.request(() => {});
    raf.fire(16);
    expect(seen).toEqual([false, false]);
  });
});

describe('createPreviewBench: the preview workload samples unbroken runs on a visible page (issue #736)', () => {
  it('drops a frame that runs while the page is hidden, and measures the run on either side of it', () => {
    let pending: ((t: number) => void) | null = null;
    const raf: RafScheduler = {
      request(cb): number {
        pending = cb;
        return 1;
      },
      cancel(): void {},
    };
    const fire = (t: number): void => {
      const cb = pending;
      pending = null;
      cb?.(t);
    };
    let visible = true;
    const bench = createPreviewBench({ ...BENCH_WORKLOADS.preview, warmupMs: 0 }, raf, () => 0, () => visible);
    const loop = (): void => {
      bench.raf.request(loop);
    };
    bench.raf.request(loop);
    fire(0);
    fire(10);
    fire(26);
    // A callback already in flight when the page was hidden.
    visible = false;
    fire(42);
    visible = true;
    fire(58);
    expect(bench.recorder.samples().map((s) => s.intervalMs)).toEqual([16, 16]);
  });
});

describe('BENCH_WORKLOADS: which loop each workload measures (issue #736)', () => {
  it('measures a session for versus-bots and the Customize preview for preview', () => {
    expect([BENCH_WORKLOADS['versus-bots'].subject, BENCH_WORKLOADS.preview.subject]).toEqual(['session', 'preview']);
    expect(BENCH_WORKLOADS.preview.query).toBe('?dev=1&bench=preview');
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
    const report = buildBenchReport({ workload: 'versus-bots', recorder: recorded(), session: SESSION, pixelRatioCap: 2, renderOverrides: null, preview: null, page: PAGE, build: BUILD });
    expect([report.frames.count, report.frames.max, report.frames.p50]).toEqual([2, 40, 20]);
    expect([report.work.count, report.work.max, report.work.p50]).toEqual([2, 5, 3]);
    expect(report.simulatedTicks).toBe(3);
  });

  it('caps the device pixel ratio by the preset, as the renderer does', () => {
    const capped = buildBenchReport({ workload: 'versus-bots', recorder: recorded(), session: SESSION, pixelRatioCap: 2, renderOverrides: null, preview: null, page: PAGE, build: BUILD });
    expect(capped.render).toEqual({ pixelRatioCap: 2, effectivePixelRatio: 2, overrides: null });
    const under = buildBenchReport({ workload: 'versus-bots', recorder: recorded(), session: SESSION, pixelRatioCap: 4, renderOverrides: null, preview: null, page: PAGE, build: BUILD });
    expect(under.render.effectivePixelRatio).toBe(3);
  });

  it('reports the preview workload with no session and the preview renderer it measured (issue #736)', () => {
    const preview = { antialias: true, pixelRatioCap: 2, shadowMap: true, keyShadowMapSize: 512 };
    const report = buildBenchReport({ workload: 'preview', recorder: recorded(), session: null, pixelRatioCap: preview.pixelRatioCap, renderOverrides: null, preview, page: PAGE, build: BUILD });
    expect(report.workload).toBe(BENCH_WORKLOADS.preview);
    expect([report.session, report.preview]).toEqual([null, preview]);
    expect(report.render).toEqual({ pixelRatioCap: 2, effectivePixelRatio: 2, overrides: null });
  });

  it('records the render overrides a session ran with, as it was given them (issue #735)', () => {
    const renderOverrides = { shadowMapSize: 512, antialias: false, pixelRatioCap: 1, fillRimLights: false };
    const report = buildBenchReport({ workload: 'versus-bots', recorder: recorded(), session: SESSION, pixelRatioCap: 1, renderOverrides, preview: null, page: PAGE, build: BUILD });
    expect(report.render).toEqual({ pixelRatioCap: 1, effectivePixelRatio: 1, overrides: renderOverrides });
  });

  it('names its schema version and the workload it ran, with the page, session and build', () => {
    const report = buildBenchReport({ workload: 'versus-bots', recorder: recorded(), session: SESSION, pixelRatioCap: 2, renderOverrides: null, preview: null, page: PAGE, build: BUILD });
    expect(report.schema).toBe(BENCH_REPORT_SCHEMA);
    expect(report.workload).toBe(BENCH_WORKLOADS['versus-bots']);
    expect([report.page, report.session, report.build]).toEqual([PAGE, SESSION, BUILD]);
    expect(report.phase).toBe('measuring');
  });
});
