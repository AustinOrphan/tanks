// The workbench scene handle's timeline rule (issue #730), with the two WebGL builders and the
// renderer replaced by recorders. What only a browser can show -- that the same draw history
// leaves the same PIXELS, and that rebuilding on one canvas does not grow live GL objects -- is
// in tools/gl/harness.ts. What this file shows is the history itself.
import { describe, it, expect } from 'vitest';
import type * as THREE from 'three';
import {
  WORKBENCH_CATALOG,
  createWorkbench,
  planSeek,
  type BuiltScene,
  type SceneBuilder,
  type WorkbenchDeps,
  type WorkbenchSceneOptions,
} from './workbench-scene';
import { ELEMENTS, VIEWS } from './subjects';
import { MOMENTS } from './moments';
import { MINE_WARN_STYLES } from '../mine-warning';

interface Recorded extends BuiltScene {
  readonly subject: string;
  readonly renderer: unknown;
  readonly draws: number[];
  disposed: number;
}

interface Rig {
  readonly deps: WorkbenchDeps;
  readonly built: Recorded[];
  readonly renderers: { disposed: number }[];
}

/** `frames` per subject id; anything unlisted has 40. */
function rig(frames: Record<string, number> = {}): Rig {
  const built: Recorded[] = [];
  const renderers: { disposed: number }[] = [];
  const build: SceneBuilder = (_canvas, _w, _h, opts, renderer) => {
    const scene: Recorded = {
      subject: opts.subject.id,
      renderer,
      frames: frames[opts.subject.id] ?? 40,
      draws: [],
      disposed: 0,
      draw(age) {
        scene.draws.push(age);
      },
      dispose() {
        scene.disposed++;
      },
    };
    built.push(scene);
    return scene;
  };
  const createRenderer = (): THREE.WebGLRenderer => {
    const r = {
      disposed: 0,
      dispose() {
        r.disposed++;
      },
    };
    renderers.push(r);
    return r as unknown as THREE.WebGLRenderer;
  };
  return { deps: { build, createRenderer }, built, renderers };
}

const opts = (id = 'fire', kind: 'element' | 'moment' = 'moment'): WorkbenchSceneOptions => ({
  subject: { kind, id },
  view: 'game',
  skin: 'solid',
  hull: null,
  accent: null,
  spawnAnim: 'warp',
  mineWarn: null,
  reach: false,
  timer: false,
});

const canvas = {} as HTMLCanvasElement;
const upTo = (n: number): number[] => Array.from({ length: n + 1 }, (_, i) => i);
const last = (r: Rig): Recorded => r.built[r.built.length - 1];

describe('planSeek (issue #730)', () => {
  it('appends draws going forward and replays from zero going back', () => {
    expect(planSeek(null, 0)).toEqual({ rebuild: false, draws: [0] });
    expect(planSeek(null, 3)).toEqual({ rebuild: false, draws: [0, 1, 2, 3] });
    expect(planSeek(2, 5)).toEqual({ rebuild: false, draws: [3, 4, 5] });
    expect(planSeek(5, 5)).toEqual({ rebuild: false, draws: [] });
    expect(planSeek(5, 2)).toEqual({ rebuild: true, draws: [0, 1, 2] });
  });
});

describe('the workbench reaches a frame the same way however it is asked (issue #730)', () => {
  // Each route ends on frame 12. The live build's draw history must be exactly 0..12 in
  // order: a fresh build followed by every tick, which is the only history under which a
  // forward-only moment scene has fed each tick's events once.
  const routes: Record<string, (w: ReturnType<typeof createWorkbench>) => void> = {
    'straight there': (w) => w.seek(12),
    'past it and back': (w) => {
      w.seek(30);
      w.seek(12);
    },
    'one frame at a time': (w) => {
      for (const f of upTo(12)) w.seek(f);
    },
    'to the end, to the start, then there': (w) => {
      w.seek(39);
      w.seek(0);
      w.seek(12);
    },
    'there twice': (w) => {
      w.seek(12);
      w.seek(12);
    },
    'through another subject and back': (w) => {
      w.seek(30);
      w.show(opts('drive'));
      w.seek(5);
      w.show(opts('fire'));
      w.seek(12);
    },
  };
  for (const [name, route] of Object.entries(routes)) {
    it(`${name}: the live build drew 0..12 in order`, () => {
      const r = rig();
      const bench = createWorkbench(canvas, 1, 1, opts(), r.deps);
      route(bench);
      expect(bench.frame).toBe(12);
      expect(last(r).subject).toBe('fire');
      expect(last(r).draws).toEqual(upTo(12));
    });
  }

  it('clamps and floors the frame to the subject timeline', () => {
    const r = rig({ fire: 10 });
    const bench = createWorkbench(canvas, 1, 1, opts(), r.deps);
    bench.seek(99);
    expect(bench.frame).toBe(9);
    bench.seek(-4);
    expect(bench.frame).toBe(0);
    bench.seek(3.7);
    expect(bench.frame).toBe(3);
    bench.seek(Number.NaN);
    expect(bench.frame).toBe(0);
    expect(last(r).draws).toEqual([0]);
  });

  it('takes the timeline length from the subject shown, and a static one is one frame', () => {
    const r = rig({ fire: 40, tank: 0 });
    const bench = createWorkbench(canvas, 1, 1, opts(), r.deps);
    bench.seek(30);
    bench.show(opts('tank', 'element'));
    expect(bench.frames).toBe(1);
    expect(bench.frame).toBe(0);
    bench.seek(5);
    expect(bench.frame).toBe(0);
    expect(last(r).draws).toEqual([0]);
  });
});

describe('the workbench disposes every build it makes, and its renderer once (issue #730)', () => {
  it('gives every build the one renderer, and disposes each build exactly once', () => {
    const r = rig();
    const bench = createWorkbench(canvas, 1, 1, opts(), r.deps);
    for (let i = 0; i < 6; i++) {
      bench.seek(20);
      bench.seek(5);
      bench.show(opts(i % 2 === 0 ? 'drive' : 'fire'));
    }
    expect(r.built.length).toBe(1 + 6 * 2);
    expect(r.renderers.length).toBe(1);
    expect(new Set(r.built.map((b) => b.renderer)).size).toBe(1);
    // Every build but the live one is already gone, before the handle is.
    expect(r.built.slice(0, -1).map((b) => b.disposed)).toEqual(r.built.slice(0, -1).map(() => 1));
    expect(last(r).disposed).toBe(0);
    expect(r.renderers[0].disposed).toBe(0);
    bench.dispose();
    bench.dispose();
    expect(r.built.map((b) => b.disposed)).toEqual(r.built.map(() => 1));
    expect(r.renderers[0].disposed).toBe(1);
  });

  it('builds and draws nothing after dispose', () => {
    const r = rig();
    const bench = createWorkbench(canvas, 1, 1, opts(), r.deps);
    bench.dispose();
    bench.seek(10);
    bench.show(opts('drive'));
    expect(r.built.length).toBe(1);
    expect(r.built[0].draws).toEqual([0]);
  });
});

describe('WORKBENCH_CATALOG (issue #730)', () => {
  it('is read from the registries, so a new entry is offered without editing the workbench', () => {
    expect(WORKBENCH_CATALOG.elements).toEqual(Object.keys(ELEMENTS));
    expect(WORKBENCH_CATALOG.moments).toEqual(Object.keys(MOMENTS));
    expect(WORKBENCH_CATALOG.views).toEqual(Object.keys(VIEWS));
    expect(WORKBENCH_CATALOG.mineWarnStyles).toEqual([...MINE_WARN_STYLES]);
  });
});
