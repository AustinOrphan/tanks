// @vitest-environment jsdom
//
// Issue #736's acceptance test: the `preview` benchmark workload measures only frames the
// Customize preview renders while it is visible and animating.
//
// Here and not beside either module, because it composes two layers the dependency guard keeps
// apart: the REAL preview loop (`src/render/preview-controls.ts`, whose `wantsFrame` decides when
// frames are requested) and the REAL instrument (`src/game/bench.ts`). A render test may not
// import game, and a game test may not import `preview-controls`. Faking either half would test
// the fake: the loop's own stop and restart paths are exactly what can put a gap inside a sample.
//
// No WebGL: the controls are CPU-only, and the draw they would trigger is a callback here.
import { describe, it, expect, afterEach } from 'vitest';
import { createPreviewControls } from '../../src/render/preview-controls';
import { createPreviewCamera, INITIAL_PREVIEW_POSE } from '../../src/render/preview';
import { BENCH_WORKLOADS, createPreviewBench } from '../../src/game/bench';

/** A page scheduler: requested callbacks wait until `fire`, and a cancel removes one. */
function pageRaf(): {
  request(cb: (t: number) => void): number;
  cancel(handle: number): void;
  fire(t: number): void;
  pending(): number;
  takePending(): (t: number) => void;
} {
  const queue = new Map<number, (t: number) => void>();
  let next = 1;
  return {
    request(cb): number {
      queue.set(next, cb);
      return next++;
    },
    cancel(handle): void {
      queue.delete(handle);
    },
    fire(t): void {
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb(t);
    },
    pending: () => queue.size,
    takePending(): (t: number) => void {
      const [[handle, cb]] = [...queue.entries()];
      queue.delete(handle);
      return cb;
    },
  };
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('the preview benchmark workload (issue #736)', () => {
  it('measures only frames the preview renders while it is visible and animating', () => {
    const raf = pageRaf();
    // The same visibility predicate `route-host.ts` hands the workload.
    const bench = createPreviewBench(
      { ...BENCH_WORKLOADS.preview, warmupMs: 0, durationMs: 600_000 },
      raf,
      () => 0,
      () => document.visibilityState !== 'hidden',
    );
    let draws = 0;
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    // Reduced motion, so the idle spin never runs: the only source of frames is the skin clock
    // this test switches on and off, which is what makes "animating" the variable under test.
    const controls = createPreviewControls(canvas, {
      camera: createPreviewCamera(260 / 190),
      initialPose: INITIAL_PREVIEW_POSE,
      reducedMotion: true,
      onPose: () => {},
      onAnimate: () => {
        draws += 1;
      },
      raf: (cb) => bench.raf.request(cb),
      cancelRaf: (h) => bench.raf.cancel(h),
    });
    const intervals = (): number[] => bench.recorder.samples().map((s) => s.intervalMs);

    // Not animating: the preview asks for no frames, so there is nothing to measure.
    expect(raf.pending()).toBe(0);

    // Animating: 11 frames 16 ms apart. The first sets the recorder's origin and the second
    // opens its window, so 9 intervals are sampled.
    controls.setAnimating(true);
    for (let i = 0; i <= 10; i++) raf.fire(i * 16);
    expect(intervals()).toEqual(Array(9).fill(16));

    // Hidden: the preview cancels its pending frame. A callback the browser had already
    // dispatched still runs once, and must not be measured.
    const inFlight = raf.takePending();
    raf.request(inFlight);
    setVisibility('hidden');
    expect(raf.pending()).toBe(1);
    raf.fire(176);
    expect(raf.pending(), 'the preview kept its loop running into a hidden page').toBe(0);
    expect(intervals()).toHaveLength(9);

    // Visible again after ten seconds away: the restart frame spans the gap and is not
    // sampled; the frames after it are.
    setVisibility('visible');
    for (const t of [10_000, 10_016, 10_032]) raf.fire(t);
    expect(intervals()).toHaveLength(11);

    // A static skin: the loop stops. Picked again ten seconds later, it restarts.
    controls.setAnimating(false);
    expect(raf.pending()).toBe(0);
    controls.setAnimating(true);
    for (const t of [20_000, 20_016]) raf.fire(t);

    expect(intervals(), 'a sampled interval spans a stop, a hide or a hidden frame').toEqual(Array(12).fill(16));
    // The measured frames are frames the preview drew. 13 draws: the 12 sampled frames, plus the
    // frame at 16 ms that opened the recorder's window, which drew but is not an interval inside
    // it. The three restart frames (0, 10 000 and 20 000 ms) drew nothing, because the loop
    // restarts its clock and a frame with dt 0 does not repaint.
    expect(draws).toBe(13);
    controls.dispose();
    canvas.remove();
  });
});
