/**
 * What ONE idle-spin frame of the Customize preview costs on the main thread.
 *
 * Run it with `node tools/gl/idle-cost.mjs`. It is a measurement tool, not a check:
 * it prints numbers and asserts nothing, because the number is hardware-dependent and
 * pinning it would be pinning this box.
 *
 * HOW it measures, and what that does and does not include. `window.requestAnimationFrame`
 * is wrapped before `createTankPreview` runs, so every callback the preview schedules is
 * timed end to end with `performance.now()`. That callback IS the whole loop body:
 * the dt maths, the two angle updates, `applyPose`, `entities.sync` and
 * `renderer.render`. What it does NOT include is GPU work that outlives the JS call --
 * `renderer.render` submits commands and returns. The runner therefore also reports a
 * `gl.finish()` variant, which blocks until the driver has drained, as the upper bound.
 *
 * The runner launches chromium with `--use-gl=swiftshader`: the raster is on the CPU, so
 * these numbers are a slow-path ceiling, not what a machine with a GPU pays.
 *
 * READ THE RATIO, NOT THE RATE. The in-page arms and the CDP task-accounting arms
 * disagree about frame rate by roughly 2x for the SAME work -- ~57fps timed in-page
 * against ~30fps with a `Performance` session attached -- so attaching the instrument
 * changes what it measures. Every arm below therefore ships with a control measured
 * through the same probe, and the figure worth quoting is how far one arm dominates
 * another within one run, not any single absolute number.
 */
import { createTankPreview } from '../../src/render/preview';

interface Sample {
  readonly label: string;
  readonly seconds: number;
  readonly frames: number;
  readonly totalMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly fps: number;
  readonly mainThreadPct: number;
}

interface VisProbe {
  start(): void;
  mark(): number;
  read(): { frames: number; visibility: string };
  stop(): void;
}

declare global {
  interface Window {
    __idleCost?: { samples: Sample[]; notes: string[] };
    __vis?: VisProbe;
  }
}

const notes: string[] = [];
const samples: Sample[] = [];

function previewCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.style.width = '260px';
  c.style.height = '190px';
  document.body.appendChild(c);
  return c;
}

function summarise(label: string, seconds: number, durations: number[]): Sample {
  const sorted = [...durations].sort((a, b) => a - b);
  const total = durations.reduce((a, b) => a + b, 0);
  const at = (q: number): number => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  return {
    label,
    seconds,
    frames: durations.length,
    totalMs: total,
    meanMs: durations.length === 0 ? 0 : total / durations.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    fps: durations.length / seconds,
    mainThreadPct: (total / (seconds * 1000)) * 100,
  };
}

/** Time every rAF callback scheduled while `run` is in flight. */
async function measure(label: string, seconds: number, build: () => { dispose: () => void } | null): Promise<void> {
  const durations: number[] = [];
  const realRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = ((cb: FrameRequestCallback): number =>
    realRaf((t) => {
      const t0 = performance.now();
      cb(t);
      durations.push(performance.now() - t0);
    })) as typeof window.requestAnimationFrame;
  const built = build();
  const started = performance.now();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const elapsed = (performance.now() - started) / 1000;
  built?.dispose();
  window.requestAnimationFrame = realRaf;
  samples.push(summarise(label, elapsed, durations));
}

/** Force `prefers-reduced-motion: reduce`, which is preview.ts's own off switch for the
 * spin -- the control arm of every comparison here. */
function suppressMotion(): void {
  window.matchMedia = ((q: string) => ({
    matches: q.includes('prefers-reduced-motion'),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (params.get('mode') === 'probe') {
    // Nothing to sample: the runner drives this arm through __vis and reads the
    // browser's own main-thread task accounting over the window.
    if (params.get('reduced') === '1') suppressMotion();
    installVisProbe(params.get('kind') ?? 'preview');
    window.__idleCost = { samples, notes };
    return;
  }

  // 1. The shipped loop, untouched.
  await measure('idle spin, as shipped', 5, () => createTankPreview(previewCanvas()));

  // 2. Control: the same preview with prefers-reduced-motion, which suppresses the spin
  //    entirely. Anything but 0 frames here means the probe is measuring something else.
  const realMatchMedia = window.matchMedia;
  suppressMotion();
  await measure('control: reduced motion (spin off)', 5, () => createTankPreview(previewCanvas()));
  window.matchMedia = realMatchMedia;

  // 3. The same loop with a gl.finish() forced after each frame -- the GPU-inclusive
  //    upper bound. Done by wrapping rAF a second time around a finish() on the
  //    preview's own context.
  {
    const c = previewCanvas();
    const durations: number[] = [];
    const realRaf = window.requestAnimationFrame.bind(window);
    let gl: WebGLRenderingContext | null = null;
    window.requestAnimationFrame = ((cb: FrameRequestCallback): number =>
      realRaf((t) => {
        const t0 = performance.now();
        cb(t);
        gl?.finish();
        durations.push(performance.now() - t0);
      })) as typeof window.requestAnimationFrame;
    const preview = createTankPreview(c);
    gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
    const started = performance.now();
    await new Promise((r) => setTimeout(r, 5000));
    const elapsed = (performance.now() - started) / 1000;
    preview?.dispose();
    window.requestAnimationFrame = realRaf;
    samples.push(summarise('idle spin + gl.finish() (GPU-inclusive ceiling)', elapsed, durations));
  }

  installVisProbe('preview');
  window.__idleCost = { samples, notes };
}

/**
 * The runner-driven arm: it backgrounds the tab between start() and read(), and reads
 * the browser's own task accounting over the same window.
 *
 * `kind` selects what runs, so the task-duration figure can be attributed rather than
 * assumed. 'preview' is the shipped loop; 'raf' is an empty rAF loop with no WebGL at
 * all, which is the control that says whether a busy main thread is the DRAWING or
 * merely the fact that something asks for frames; 'none' runs nothing.
 */
function installVisProbe(kind: string): void {
  window.__vis = ((): VisProbe => {
    let frames = 0;
    let preview: { dispose: () => void } | null = null;
    let realRaf: typeof window.requestAnimationFrame | null = null;
    let stopped = false;
    return {
      start(): void {
        realRaf = window.requestAnimationFrame.bind(window);
        const raf = realRaf;
        window.requestAnimationFrame = ((cb: FrameRequestCallback): number =>
          raf((t) => {
            frames++;
            cb(t);
          })) as typeof window.requestAnimationFrame;
        if (kind === 'raf') {
          const spin = (): void => {
            if (!stopped) window.requestAnimationFrame(spin);
          };
          window.requestAnimationFrame(spin);
          return;
        }
        if (kind === 'none') return;
        preview = createTankPreview(previewCanvas());
      },
      mark(): number {
        return frames;
      },
      read(): { frames: number; visibility: string } {
        return { frames, visibility: document.visibilityState };
      },
      stop(): void {
        stopped = true;
        preview?.dispose();
        if (realRaf) window.requestAnimationFrame = realRaf;
      },
    };
  })();
}

void main();
