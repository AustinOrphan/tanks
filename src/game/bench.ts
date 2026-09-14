import type { RafScheduler } from './driver';
import type { BuildIdentity, SessionDiagnostics } from './dev-diagnostics';

/**
 * A FIXED BENCHMARK WORKLOAD AND ITS FRAME-TIME REPORT (issue #734, part of #721).
 *
 * #288 needs gameplay frame times from a physical phone, taken without editing source. This
 * module is the measurement half: a named workload says which session to open and how long
 * to warm up and measure, a recorder keeps the frames inside that window, and a report puts
 * the numbers beside the facts needed to compare two runs. `loop.ts` does the wiring behind
 * `?dev=1&bench=<workload>`, and the report is read from the console as `__tanks.bench()`.
 *
 * PURE apart from the scheduler decorator, which only wraps what it is handed. Nothing here
 * reads `window`, `navigator` or `import.meta`: page facts, the build and the session arrive
 * as values, the way `dev-diagnostics.ts` takes them.
 *
 * WHAT IT MEASURES, AND WHAT IT DOES NOT.
 * - `frames` is the rAF-to-rAF interval, from the timestamps the browser hands each callback.
 *   That is what a player feels as a dropped or long frame.
 * - `work` is how long the game's own frame callback ran on the main thread: stepping,
 *   routing events and submitting the render. GPU work that outlives the call is not in it,
 *   for the reason `tools/gl/idle-cost.ts` gives.
 * - Neither says anything about a device this did not run on. A desktop or software-GL report
 *   is preparation for #288, not evidence for its budget.
 *
 * THE SIMULATION IS UNTOUCHED. The decorator times a callback it does not alter, and the
 * recorder only reads the world's tick. `loop.test.ts` pins that a benchmarked session steps
 * the same world as the same session without the flag.
 */

/**
 * The report format's version. A reader that finds another number must refuse the report
 * rather than misread it -- #737's summarizer is the first such reader.
 */
export const BENCH_REPORT_SCHEMA = 1;

/** The named workloads, as `?bench=` accepts them. */
export const BENCH_WORKLOAD_IDS = ['versus-bots'] as const;
export type BenchWorkloadId = (typeof BENCH_WORKLOAD_IDS)[number];

export interface BenchWorkload {
  readonly id: BenchWorkloadId;
  readonly description: string;
  /**
   * The query string the run is opened with, this workload's own `bench` flag included. The
   * session is only the named workload when the page was opened with exactly these flags;
   * the report carries the page's actual query so a reader can check.
   */
  readonly query: string;
  /** Frames before this much time has passed are not measured: shaders compile, caches warm. */
  readonly warmupMs: number;
  /** How long frames are measured for, once warm-up ends. */
  readonly durationMs: number;
}

/**
 * `versus-bots` needs nothing that is not on `main` today: every slot is a bot, and a pinned
 * `seed` makes the bots' input streams, and so the match, repeat (`loop.test.ts`'s
 * reproducibility block). A campaign workload driven by autoplay can join once autoplay
 * repeats under a pinned seed (#728).
 */
export const BENCH_WORKLOADS: Readonly<Record<BenchWorkloadId, BenchWorkload>> = {
  'versus-bots': {
    id: 'versus-bots',
    description: 'A four-bot free-for-all on a pinned seed, with no human input.',
    query: '?dev=1&bench=versus-bots&mode=ffa&players=4&bots=4&seed=7',
    warmupMs: 5_000,
    durationMs: 60_000,
  },
};

/** Frame-time thresholds a report counts frames beyond: one, two and three 60 Hz frames. */
export const LONG_FRAME_MS = [16.7, 33.3, 50] as const;

export interface FrameSummary {
  readonly count: number;
  /** Nearest-rank percentiles in milliseconds; `null` when nothing was measured. */
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  /** How many values were strictly longer than 16.7, 33.3 and 50 ms. */
  readonly over16_7: number;
  readonly over33_3: number;
  readonly over50: number;
}

/**
 * Nearest-rank: the smallest value with at least `p` percent of the values at or below it.
 * No interpolation, so every percentile is a frame that really happened.
 */
function nearestRank(sorted: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(rank, 1) - 1];
}

export function summarizeFrames(values: readonly number[]): FrameSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const over = (ms: number): number => sorted.filter((v) => v > ms).length;
  if (sorted.length === 0) {
    return { count: 0, p50: null, p95: null, p99: null, max: null, over16_7: 0, over33_3: 0, over50: 0 };
  }
  return {
    count: sorted.length,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    p99: nearestRank(sorted, 99),
    max: sorted[sorted.length - 1],
    over16_7: over(LONG_FRAME_MS[0]),
    over33_3: over(LONG_FRAME_MS[1]),
    over50: over(LONG_FRAME_MS[2]),
  };
}

export interface FrameSample {
  /** Since the previous frame's rAF timestamp. */
  readonly intervalMs: number;
  /** How long this frame's callback ran. */
  readonly workMs: number;
}

export type BenchPhase = 'warmup' | 'measuring' | 'done';

export interface FrameRecorder {
  /**
   * One rendered frame: the browser's timestamp for it, how long its callback ran, and the
   * world's tick once it had.
   */
  frame(frameTimeMs: number, workMs: number, tick: number): void;
  readonly phase: BenchPhase;
  samples(): readonly FrameSample[];
  /** Simulated ticks inside the measurement window, summed across world rebuilds. */
  readonly simulatedTicks: number;
  /** From the first measured frame's timestamp to the last one's. */
  readonly measuredMs: number;
}

/**
 * Keep the frames inside one measurement window.
 *
 * The window opens on the first frame at least `warmupMs` after the first frame seen, and the
 * first sample is the frame AFTER that, so no measured interval straddles warm-up. It closes
 * on the first frame more than `durationMs` after it opened, which is not measured; later
 * frames change nothing.
 *
 * A world rebuild (a new round, a rematch) restarts the tick at 0, so a tick lower than the
 * last one counts from zero rather than subtracting, the same rule the played-capture step
 * uses.
 */
export function createFrameRecorder(window: { readonly warmupMs: number; readonly durationMs: number }): FrameRecorder {
  let phase: BenchPhase = 'warmup';
  let origin: number | null = null;
  let windowStart = 0;
  let prevFrameTime = 0;
  let lastTick = 0;
  let simulatedTicks = 0;
  let measuredMs = 0;
  const samples: FrameSample[] = [];
  return {
    frame(frameTimeMs, workMs, tick): void {
      if (phase === 'done') return;
      if (origin === null) {
        origin = frameTimeMs;
        prevFrameTime = frameTimeMs;
        return;
      }
      if (phase === 'warmup') {
        if (frameTimeMs - origin >= window.warmupMs) {
          phase = 'measuring';
          windowStart = frameTimeMs;
          lastTick = tick;
        }
        prevFrameTime = frameTimeMs;
        return;
      }
      if (frameTimeMs - windowStart > window.durationMs) {
        phase = 'done';
        return;
      }
      samples.push({ intervalMs: frameTimeMs - prevFrameTime, workMs });
      simulatedTicks += tick >= lastTick ? tick - lastTick : tick;
      lastTick = tick;
      prevFrameTime = frameTimeMs;
      measuredMs = frameTimeMs - windowStart;
    },
    get phase(): BenchPhase {
      return phase;
    },
    samples: () => samples,
    get simulatedTicks(): number {
      return simulatedTicks;
    },
    get measuredMs(): number {
      return measuredMs;
    },
  };
}

/**
 * The scheduler the driver is handed, timing each callback it runs.
 *
 * The callback itself is passed through untouched, with the browser's own timestamp. The
 * frame is reported even when the callback throws -- the driver stops and rethrows -- so a
 * failing frame's cost is not silently dropped.
 */
export function instrumentRaf(
  raf: RafScheduler,
  now: () => number,
  onFrame: (frameTimeMs: number, workMs: number) => void,
): RafScheduler {
  return {
    request(cb): number {
      return raf.request((frameTimeMs) => {
        const start = now();
        try {
          cb(frameTimeMs);
        } finally {
          onFrame(frameTimeMs, now() - start);
        }
      });
    },
    cancel(handle): void {
      raf.cancel(handle);
    },
  };
}

/** The page facts a report is compared on, read by the caller. */
export interface BenchPage {
  /** `location.search`, so a reader can check the run was the workload it names. */
  readonly search: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly devicePixelRatio: number;
  readonly userAgent: string;
}

export interface BenchReport {
  readonly schema: typeof BENCH_REPORT_SCHEMA;
  readonly workload: BenchWorkload;
  readonly phase: BenchPhase;
  readonly frames: FrameSummary;
  readonly work: FrameSummary;
  readonly simulatedTicks: number;
  readonly measuredMs: number;
  readonly session: SessionDiagnostics;
  readonly render: {
    readonly pixelRatioCap: number;
    /** What the renderer draws at: the device ratio, capped by the preset (`render/scene.ts`). */
    readonly effectivePixelRatio: number;
  };
  readonly page: BenchPage;
  readonly build: BuildIdentity;
}

export interface BenchReportInput {
  readonly workload: BenchWorkloadId;
  readonly recorder: FrameRecorder;
  readonly session: SessionDiagnostics;
  readonly pixelRatioCap: number;
  readonly page: BenchPage;
  readonly build: BuildIdentity;
}

export function buildBenchReport(input: BenchReportInput): BenchReport {
  const samples = input.recorder.samples();
  return {
    schema: BENCH_REPORT_SCHEMA,
    workload: BENCH_WORKLOADS[input.workload],
    phase: input.recorder.phase,
    frames: summarizeFrames(samples.map((s) => s.intervalMs)),
    work: summarizeFrames(samples.map((s) => s.workMs)),
    simulatedTicks: input.recorder.simulatedTicks,
    measuredMs: input.recorder.measuredMs,
    session: input.session,
    render: {
      pixelRatioCap: input.pixelRatioCap,
      effectivePixelRatio: Math.min(input.page.devicePixelRatio, input.pixelRatioCap),
    },
    page: input.page,
    build: input.build,
  };
}
