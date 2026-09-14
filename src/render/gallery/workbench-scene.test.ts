// The workbench scene handle's timeline rule (issue #730), with the two WebGL builders
// replaced by a recorder. What only a browser can show -- that the same draw history leaves
// the same PIXELS, and that rebuilding on one canvas does not grow live GL objects -- is in
// tools/gl/harness.ts. What this file shows is the history itself.
import { describe, it, expect } from 'vitest';
import {
  WORKBENCH_CATALOG,
  createWorkbenchScene,
  planSeek,
  type BuiltScene,
  type SceneBuilder,
  type WorkbenchSceneOptions,
} from './workbench-scene';
import { ELEMENTS, VIEWS } from './subjects';
import { MOMENTS } from './moments';
import { MINE_WARN_STYLES } from '../mine-warning';

interface Recorded extends BuiltScene {
  readonly draws: number[];
  disposed: number;
}

function recorder(frames: number): { build: SceneBuilder; built: Recorded[] } {
  const built: Recorded[] = [];
  const build: SceneBuilder = () => {
    const scene: Recorded = {
      frames,
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
  return { build, built };
}

const OPTS: WorkbenchSceneOptions = {
  subject: { kind: 'moment', id: 'fire' },
  view: 'game',
  skin: 'solid',
  hull: null,
  accent: null,
  spawnAnim: 'warp',
  mineWarn: null,
  reach: false,
  timer: false,
};

const canvas = {} as HTMLCanvasElement;
const upTo = (n: number): number[] => Array.from({ length: n + 1 }, (_, i) => i);

describe('planSeek (issue #730)', () => {
  it('appends draws going forward and replays from zero going back', () => {
    expect(planSeek(null, 0)).toEqual({ rebuild: false, draws: [0] });
    expect(planSeek(null, 3)).toEqual({ rebuild: false, draws: [0, 1, 2, 3] });
    expect(planSeek(2, 5)).toEqual({ rebuild: false, draws: [3, 4, 5] });
    expect(planSeek(5, 5)).toEqual({ rebuild: false, draws: [] });
    expect(planSeek(5, 2)).toEqual({ rebuild: true, draws: [0, 1, 2] });
  });
});

describe('the workbench scene reaches a frame the same way however it is asked (issue #730)', () => {
  // Each route ends on frame 12. The live build's draw history must be exactly 0..12 in
  // order: a fresh build followed by every tick, which is the only history under which a
  // forward-only moment scene has fed each tick's events once.
  const routes: Record<string, number[]> = {
    'straight there': [12],
    'past it and back': [30, 12],
    'one frame at a time': upTo(12),
    'to the end, to the start, then there': [39, 0, 12],
    'there twice': [12, 12],
  };
  for (const [name, seeks] of Object.entries(routes)) {
    it(`${name}: the live build drew 0..12 in order`, () => {
      const { build, built } = recorder(40);
      const scene = createWorkbenchScene(canvas, 1, 1, OPTS, build);
      for (const frame of seeks) scene.seek(frame);
      expect(scene.frame).toBe(12);
      expect(built[built.length - 1].draws).toEqual(upTo(12));
    });
  }

  it('clamps and floors the frame to the subject timeline', () => {
    const { build, built } = recorder(10);
    const scene = createWorkbenchScene(canvas, 1, 1, OPTS, build);
    scene.seek(99);
    expect(scene.frame).toBe(9);
    scene.seek(-4);
    expect(scene.frame).toBe(0);
    scene.seek(3.7);
    expect(scene.frame).toBe(3);
    scene.seek(Number.NaN);
    expect(scene.frame).toBe(0);
    expect(built[built.length - 1].draws).toEqual([0]);
  });

  it('treats a static subject as one frame', () => {
    const { build } = recorder(0);
    const scene = createWorkbenchScene(canvas, 1, 1, OPTS, build);
    expect(scene.frames).toBe(1);
    scene.seek(5);
    expect(scene.frame).toBe(0);
  });
});

describe('the workbench scene disposes every build it makes (issue #730)', () => {
  it('disposes the old build before replaying, and the live one exactly once on dispose', () => {
    const { build, built } = recorder(40);
    const scene = createWorkbenchScene(canvas, 1, 1, OPTS, build);
    for (let i = 0; i < 6; i++) {
      scene.seek(20);
      scene.seek(5);
    }
    scene.dispose();
    scene.dispose();
    expect(built.length).toBeGreaterThan(1);
    expect(built.map((b) => b.disposed)).toEqual(built.map(() => 1));
  });

  it('draws nothing after dispose', () => {
    const { build, built } = recorder(40);
    const scene = createWorkbenchScene(canvas, 1, 1, OPTS, build);
    scene.dispose();
    scene.seek(10);
    expect(built.length).toBe(1);
    expect(built[0].draws).toEqual([0]);
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
