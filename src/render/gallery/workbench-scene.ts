/**
 * The gallery workbench's scene handle (issue #730): one registered subject at a time, drawn
 * onto one canvas, at a chosen frame.
 *
 * WHY A HANDLE AND NOT THE BUILDERS DIRECTLY. `buildGallery` and `buildMomentScene` are
 * forward-only. A moment feeds each tick's events to its particle and pulse systems exactly
 * once and never rewinds them (moment-scene.ts's DISCLOSED LIMITATION), and both builders
 * carry a `clock` whose delta animates the next draw. The capture runner only ever walks ages
 * forward, so that never mattered. A scrub bar walks backwards constantly, and a moment
 * dragged from tick 40 back to tick 12 would show tick 12's tanks under tick 40's smoke.
 *
 * So the one rule this module keeps: THE SCENE ON SCREEN IS ALWAYS A FRESH BUILD FOLLOWED BY
 * `draw(0, 0)`, `draw(1, 0)`, ..., `draw(frame, 0)`, IN ORDER. Moving forward appends draws.
 * Moving backward, or choosing another subject, disposes the build and starts again from zero.
 * `planSeek` is that rule as a pure function; `workbench-scene.test.ts` pins that every route
 * to a frame leaves the same draw history, and `tools/gl/harness.ts` pins that it leaves the
 * same pixels.
 *
 * ONE RENDERER PER HANDLE, SHARED BY EVERY BUILD. A build that makes and disposes its own
 * `WebGLRenderer` leaves behind what the renderer does not own -- compiled programs, and
 * textures that module-level caches uploaded through it. Rebuilt on one canvas at every scene
 * change, that grew live GL objects on every change (measured in tools/gl/harness.ts before
 * this handle took the renderer over). The renderer is disposed with the handle, without
 * `forceContextLoss()`: the pane keeps one canvas, and `render/preview.ts` measured that a
 * force-lost context does not come back on the same element.
 */
import * as THREE from 'three';
import { buildGallery, ELEMENTS, VIEWS } from './subjects';
import { buildMomentScene } from './moment-scene';
import { MOMENTS } from './moments';
import { DEFAULT_SPAWN_ANIM, type SkinId, type SpawnAnimId } from '../../presentation/customization';
import { MINE_WARN_STYLES, type MineWarnStyle } from '../mine-warning';

/** A posed element (`ELEMENTS`) or a scripted moment (`MOMENTS`), by its registry key. */
export interface WorkbenchSubject {
  readonly kind: 'element' | 'moment';
  readonly id: string;
}

/**
 * Everything one scene is built from. Names follow `tools/gallery/main.ts`'s parameters, so a
 * selection maps onto a capture invocation one field at a time.
 */
export interface WorkbenchSceneOptions {
  readonly subject: WorkbenchSubject;
  /** Key into `VIEWS`. */
  readonly view: string;
  readonly skin: SkinId;
  /** Hull hex, or null for the roster default. */
  readonly hull: string | null;
  /** Accent hex, or null for the hull-derived tone. */
  readonly accent: string | null;
  readonly spawnAnim: SpawnAnimId;
  readonly mineWarn: MineWarnStyle | null;
  /** The mine dev overlays. Posed subjects only: a moment scene draws neither. */
  readonly reach: boolean;
  readonly timer: boolean;
}

/**
 * The registry keys the workbench offers, read from the registries themselves so the pane
 * holds no copy of any id. Handed to the application layer by injection, because `game/` may
 * not import these registries (dependency-direction.test.ts).
 */
export interface WorkbenchCatalog {
  readonly elements: readonly string[];
  readonly moments: readonly string[];
  readonly views: readonly string[];
  readonly mineWarnStyles: readonly string[];
}

export const WORKBENCH_CATALOG: WorkbenchCatalog = Object.freeze({
  elements: Object.freeze(Object.keys(ELEMENTS)),
  moments: Object.freeze(Object.keys(MOMENTS)),
  views: Object.freeze(Object.keys(VIEWS)),
  mineWarnStyles: Object.freeze([...MINE_WARN_STYLES]),
});

/** What both builders return, minus the moment's capture report, which the pane does not read. */
export interface BuiltScene {
  draw(age: number, alpha: number): void;
  readonly frames: number;
  dispose(): void;
}

export type SceneBuilder = (
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  opts: WorkbenchSceneOptions,
  renderer: THREE.WebGLRenderer,
) => BuiltScene;

/**
 * The production builder: the SAME two functions the capture page calls, with the same
 * defaults. `spawnAnim` reaches the posed gallery only when it is not the default, which is
 * what `tools/gallery/main.ts` does when `?spawn-anim=` is absent -- `buildGallery` styles the
 * player tank only when something is being styled, so passing the default would draw a
 * different tank than the capture of the same selection.
 */
export const buildWorkbenchSubject: SceneBuilder = (canvas, w, h, opts, renderer) =>
  opts.subject.kind === 'moment'
    ? buildMomentScene(canvas, w, h, {
        moment: opts.subject.id,
        view: opts.view,
        skin: opts.skin,
        hull: opts.hull,
        accent: opts.accent,
        spawnAnim: opts.spawnAnim,
        mineWarn: opts.mineWarn,
        renderer,
      })
    : buildGallery(canvas, w, h, {
        elements: [opts.subject.id],
        view: opts.view,
        reach: opts.reach,
        timer: opts.timer,
        fill: false,
        skin: opts.skin,
        hull: opts.hull,
        accent: opts.accent,
        spawnAnim: opts.spawnAnim === DEFAULT_SPAWN_ANIM ? undefined : opts.spawnAnim,
        frames: null,
        mineWarn: opts.mineWarn,
        renderer,
      });

/** The same construction both builders use when they own their renderer. */
export function createWorkbenchRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  return new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
}

export interface SeekPlan {
  /** Dispose the current build and start a new one before drawing. */
  readonly rebuild: boolean;
  /** The ages to draw, in order, each at alpha 0. */
  readonly draws: readonly number[];
}

/**
 * How to get from the frame last drawn to `target` while keeping the module's one rule.
 *
 * @param drawn the frame the current build last drew, or null when it has drawn nothing.
 * @param target a whole frame, already clamped to the subject's range.
 */
export function planSeek(drawn: number | null, target: number): SeekPlan {
  if (drawn !== null && target >= drawn) return { rebuild: false, draws: ages(drawn + 1, target) };
  return { rebuild: drawn !== null, draws: ages(0, target) };
}

function ages(from: number, to: number): number[] {
  const out: number[] = [];
  for (let a = from; a <= to; a++) out.push(a);
  return out;
}

export interface Workbench {
  /** Frames on the shown subject's timeline; 1 for a static posed element. */
  readonly frames: number;
  /** The frame on screen. */
  readonly frame: number;
  /** Replace the shown subject and draw its first frame. Does nothing after `dispose`. */
  show(opts: WorkbenchSceneOptions): void;
  /** Draw `frame`, clamped to `[0, frames)` and floored. Does nothing after `dispose`. */
  seek(frame: number): void;
  /** Releases the live build, then the renderer. Safe to call twice. */
  dispose(): void;
}

export interface WorkbenchDeps {
  readonly build?: SceneBuilder;
  readonly createRenderer?: (canvas: HTMLCanvasElement) => THREE.WebGLRenderer;
}

/**
 * Build `initial.subject` on `canvas` and draw its first frame.
 *
 * @param deps injectable for the node tests; production passes nothing.
 */
export function createWorkbench(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  initial: WorkbenchSceneOptions,
  deps: WorkbenchDeps = {},
): Workbench {
  const build = deps.build ?? buildWorkbenchSubject;
  const renderer = (deps.createRenderer ?? createWorkbenchRenderer)(canvas);
  let opts = initial;
  let live = build(canvas, w, h, opts, renderer);
  let frames = Math.max(1, live.frames);
  let drawn: number | null = null;
  let disposed = false;

  const seek = (frame: number): void => {
    if (disposed) return;
    const whole = Number.isFinite(frame) ? Math.floor(frame) : 0;
    const target = Math.min(Math.max(0, whole), frames - 1);
    const plan = planSeek(drawn, target);
    if (plan.rebuild) {
      live.dispose();
      live = build(canvas, w, h, opts, renderer);
    }
    for (const age of plan.draws) live.draw(age, 0);
    drawn = target;
  };

  seek(0);
  return {
    get frames(): number {
      return frames;
    },
    get frame(): number {
      return drawn ?? 0;
    },
    show(next: WorkbenchSceneOptions): void {
      if (disposed) return;
      live.dispose();
      opts = next;
      live = build(canvas, w, h, opts, renderer);
      frames = Math.max(1, live.frames);
      drawn = null;
      seek(0);
    },
    seek,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      live.dispose();
      renderer.dispose();
    },
  };
}
