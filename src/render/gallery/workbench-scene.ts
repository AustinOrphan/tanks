/**
 * The gallery workbench's scene handle (issue #730): one registered subject, drawn onto one
 * canvas, at a chosen frame.
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
 * Moving backward disposes the build and replays from zero. `planSeek` is that rule as a pure
 * function; `workbench-scene.test.ts` pins that every route to a frame leaves the same draw
 * history, and `tools/gl/harness.ts` pins that it leaves the same pixels.
 *
 * ONE CANVAS FOR THE PANE'S LIFETIME. A rebuild constructs a new `WebGLRenderer` on the SAME
 * canvas after the old one is disposed, without `forceContextLoss()` -- the path
 * `render/preview.ts` measured: a force-lost context does not come back on the same element,
 * and a plain dispose leaves the context live for the next renderer to reuse.
 */
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
) => BuiltScene;

/**
 * The production builder: the SAME two functions the capture page calls, with the same
 * defaults. `spawnAnim` reaches the posed gallery only when it is not the default, which is
 * what `tools/gallery/main.ts` does when `?spawn-anim=` is absent -- `buildGallery` styles the
 * player tank only when something is being styled, so passing the default would draw a
 * different tank than the capture of the same selection.
 */
export const buildWorkbenchSubject: SceneBuilder = (canvas, w, h, opts) =>
  opts.subject.kind === 'moment'
    ? buildMomentScene(canvas, w, h, {
        moment: opts.subject.id,
        view: opts.view,
        skin: opts.skin,
        hull: opts.hull,
        accent: opts.accent,
        spawnAnim: opts.spawnAnim,
        mineWarn: opts.mineWarn,
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
      });

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

export interface WorkbenchScene {
  /** Frames on the subject's timeline; 1 for a static posed element. */
  readonly frames: number;
  /** The frame on screen. */
  readonly frame: number;
  /** Draw `frame`, clamped to `[0, frames)` and floored. Does nothing after `dispose`. */
  seek(frame: number): void;
  /** Releases the live build. Safe to call twice. */
  dispose(): void;
}

/**
 * Build `opts.subject` on `canvas` and draw its first frame.
 *
 * @param build injectable for the node tests; production passes nothing.
 */
export function createWorkbenchScene(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  opts: WorkbenchSceneOptions,
  build: SceneBuilder = buildWorkbenchSubject,
): WorkbenchScene {
  let live = build(canvas, w, h, opts);
  const frames = Math.max(1, live.frames);
  let drawn: number | null = null;
  let disposed = false;

  const seek = (frame: number): void => {
    if (disposed) return;
    const whole = Number.isFinite(frame) ? Math.floor(frame) : 0;
    const target = Math.min(Math.max(0, whole), frames - 1);
    const plan = planSeek(drawn, target);
    if (plan.rebuild) {
      live.dispose();
      live = build(canvas, w, h, opts);
    }
    for (const age of plan.draws) live.draw(age, 0);
    drawn = target;
  };

  seek(0);
  return {
    frames,
    get frame(): number {
      return drawn ?? 0;
    },
    seek,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      live.dispose();
    },
  };
}
