import * as THREE from 'three';
import { createWorld } from '../../src/sim/world';
import type { World } from '../../src/sim/world';
import { createEntityViews, BULLET_Y } from '../../src/render/entities';
import { createMineDebug } from '../../src/render/minedebug';
import {
  DT, MINE_TIMER, NORMAL_SPEED, MINE_BLAST_EXPAND_TICKS, MINE_BLAST_HOLD_TICKS,
} from '../../src/sim/constants';
import type { SkinId } from '../../src/game/customization';

export const BLAST_LIFE = MINE_BLAST_EXPAND_TICKS + MINE_BLAST_HOLD_TICKS;

/**
 * Every subject the gallery can pose, as a function from animation age to a World.
 *
 * These build REAL worlds and hand them to the REAL render modules, so what the gallery
 * shows is what the game draws. A subject that constructed its own meshes would be a
 * mockup, and a mockup cannot catch the two defects screenshots have already caught here
 * (a shell whose nose was an open hemisphere, a blast whose growth curve was linear).
 */

/**
 * One thing the gallery can place in a scene.
 *
 * Scenes are COMPOSED from these -- `--elements mine,tank,shell` -- rather than picked
 * from a fixed list, because the usual question is "how does this read next to that?"
 * and every fixed scene is the wrong answer to some version of it.
 */
export interface ElementDef {
  /** Put this element into the world, centred on x. `age` drives anything animated. */
  place(w: World, x: number, age: number): void;
  /** Roughly how much room it needs, for layout and camera distance. */
  width: number;
  /** How many animation frames it wants. 1 means static. */
  frames: number;
  /** Height of its visual centre, so the camera looks at the right place. */
  focusY: number;
}

export const ELEMENTS: Record<string, ElementDef> = {
  mine: {
    width: 0.9, frames: 1, focusY: 0.06,
    place: (w, x) => {
      w.mines.push({ id: 10 + w.mines.length, ownerId: 99, pos: { x, y: 0 }, timer: MINE_TIMER, armed: false, detonated: false });
    },
  },
  minearmed: {
    width: 0.9, frames: 1, focusY: 0.06,
    place: (w, x) => {
      w.mines.push({ id: 10 + w.mines.length, ownerId: 99, pos: { x, y: 0 }, timer: 0.5, armed: true, detonated: false });
    },
  },
  /** A mine burning its whole fuse, for watching the pulse rate climb. */
  fuse: {
    width: 0.9, frames: 90, focusY: 0.06,
    place: (w, x, age) => {
      w.mines.push({
        id: 10 + w.mines.length, ownerId: 99, pos: { x, y: 0 },
        timer: Math.max(0, MINE_TIMER * (1 - age / 90)), armed: true, detonated: false,
      });
    },
  },
  tank: {
    width: 1.4, frames: 1, focusY: 0.3,
    place: (w, x) => {
      w.tanks.push({
        id: 1 + w.tanks.length, kind: w.tanks.length % 2 ? 'brown' : 'player',
        pos: { x, y: 0 }, bodyAngle: 0, turretAngle: 0, alive: true,
        desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
        aiState: 'idle', aiTimer: 0,
      });
    },
  },
  /**
   * Two player-kind tanks, distinct co-op slots, each with a shell already in flight --
   * the identity ring and the shell tint side by side, in one still. `createWorld`
   * (not a loadable arena -- config/validate.ts still hard-fails a grid without exactly
   * one 'P') is what lets two `kind: 'player'` tanks coexist at all; see
   * entities.test.ts's own `twoPlayerWorld` for the same construction.
   */
  coop: {
    width: 4.0, frames: 1, focusY: 0.3,
    place: (w, x) => {
      const p1 = 1 + w.tanks.length;
      w.tanks.push({
        id: p1, kind: 'player', controlledBy: 0,
        pos: { x: x - 1.1, y: 0 }, bodyAngle: 0, turretAngle: 0, alive: true,
        desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
        aiState: 'idle', aiTimer: 0,
      });
      const p2 = 1 + w.tanks.length;
      w.tanks.push({
        id: p2, kind: 'player', controlledBy: 1,
        pos: { x: x + 1.1, y: 0 }, bodyAngle: Math.PI, turretAngle: Math.PI, alive: true,
        desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
        aiState: 'idle', aiTimer: 0,
      });
      // Each tank's own shell, mid-flight and owned accordingly -- shows the tint
      // matches the FIRING tank's ring, not just "a" identity colour.
      w.bullets.push({
        id: 100 + w.bullets.length, ownerId: p1, type: 'normal', bouncesLeft: 1, alive: true,
        pos: { x: x - 0.3, y: -0.45 }, vel: { x: NORMAL_SPEED, y: 0 },
      });
      w.bullets.push({
        id: 100 + w.bullets.length, ownerId: p2, type: 'normal', bouncesLeft: 1, alive: true,
        pos: { x: x + 0.3, y: 0.45 }, vel: { x: -NORMAL_SPEED, y: 0 },
      });
    },
  },
  /** One shell broadside and one nose-on: a shell's read changes with angle. */
  shell: {
    width: 1.0, frames: 1, focusY: BULLET_Y,
    place: (w, x) => {
      w.bullets.push({
        id: 100 + w.bullets.length, ownerId: 1, type: 'normal', bouncesLeft: 1, alive: true,
        pos: { x, y: -0.35 }, vel: { x: NORMAL_SPEED, y: 0 },
      });
      w.bullets.push({
        id: 100 + w.bullets.length, ownerId: 1, type: 'normal', bouncesLeft: 1, alive: true,
        pos: { x, y: 0.55 }, vel: { x: 0, y: NORMAL_SPEED },
      });
    },
  },
  /** Every heading at once, for checking the yaw mapping from overhead. */
  shellring: {
    width: 2.6, frames: 1, focusY: BULLET_Y,
    place: (w, x) => {
      for (let i = 0; i < 8; i++) {
        const a = (i * 2 * Math.PI) / 8;
        w.bullets.push({
          id: 100 + w.bullets.length, ownerId: 1, type: 'normal', bouncesLeft: 1, alive: true,
          pos: { x: x + Math.cos(a) * 0.9, y: Math.sin(a) * 0.9 },
          vel: { x: Math.cos(a) * NORMAL_SPEED, y: Math.sin(a) * NORMAL_SPEED },
        });
      }
    },
  },
  blast: {
    width: 5.4, frames: BLAST_LIFE, focusY: 0.6,
    place: (w, x, age) => {
      if (age >= 0 && age < BLAST_LIFE) w.blasts.push({ id: 900 + w.blasts.length, ownerId: 1, pos: { x, y: 0 }, age });
    },
  },
};

export interface Composed {
  world: World;
  span: number;
  frames: number;
  focus: [number, number, number];
}

/**
 * Lay the named elements out in a row and build the World that holds them.
 *
 * Spacing comes from the elements' own widths, so adding a wide one pushes the others
 * apart and widens the camera rather than overlapping them.
 */
export function compose(names: string[], age: number): Composed {
  const defs = names.map((n) => ELEMENTS[n]).filter(Boolean);
  if (defs.length === 0) return compose(['mine'], age);
  const GAP = 0.6;
  const total = defs.reduce((a, d) => a + d.width, 0) + GAP * (defs.length - 1);
  const w = createWorld({ walls: [], spawns: [], lives: 3, tanks: [] });
  let cursor = -total / 2;
  for (const d of defs) {
    d.place(w, cursor + d.width / 2, age);
    cursor += d.width + GAP;
  }
  return {
    world: w,
    span: Math.max(total * 1.15, 1.2),
    frames: Math.max(...defs.map((d) => d.frames)),
    focus: [0, Math.max(...defs.map((d) => d.focusY)), 0],
  };
}

/**
 * Named camera DIRECTIONS, as unit-ish offsets from the subject's focus point.
 *
 * Deliberately not absolute positions: the distance is computed per subject from its
 * span, so `--view low` frames a 1.6-unit mine and a 9-unit blast equally well.
 */
export const VIEWS: Record<string, { dir: [number, number, number]; up?: [number, number, number] }> = {
  game: { dir: [0, 0.72, 0.86] },
  close: { dir: [0, 0.4, 0.92] },
  low: { dir: [0, 0.1, 1] },
  top: { dir: [0, 1, 0.0001], up: [0, 0, -1] },
  headon: { dir: [1, 0.06, 0] },
  behind: { dir: [-1, 0.06, 0] },
  below: { dir: [0, -1, 0.0001], up: [0, 0, 1] },
};

/**
 * THE GALLERY'S ANIMATION CLOCK, and the one design call in giving the gallery skins.
 *
 * Everything else here is tick-indexed: an element declares how many `frames` it wants
 * and `place` receives an integer `age`, which is a SIM TICK (the `fuse` element burns
 * `MINE_TIMER` over 90 of them, the `blast` element lives `BLAST_LIFE`). The renderer's
 * `dt`, by contrast, is wall-clock SECONDS -- it is what `entities.sync` scrolls an
 * animated skin by and what `particles.update` integrates.
 *
 * The mapping chosen, in one sentence: **one `age` step is one sim tick, so a
 * sub-divided step of `alpha` is `alpha` ticks, and the seconds between two draws are
 * the ticks between them times `DT`.** A gallery animation therefore advances a skin by
 * exactly what the game would advance it over the same number of ticks.
 *
 * Two consequences worth stating rather than discovering:
 *
 * - The gallery derives this from the (age, alpha) it is HANDED, not from a clock of
 *   its own, so it stays a pure function of the timeline the runner walks -- which is
 *   what keeps a still reproducible and a sweep comparable. The first draw has no
 *   predecessor and so gets `dt = 0`; a still shows the tile at offset 0.
 * - Playback is slow motion, and already was. `run.mjs` writes `--subdiv` frames per
 *   age step and assembles them at `--fps` (3 and 20 by default), so 60 ticks -- one
 *   second of game -- plays back over 9 seconds of gif. `flow` scrolls 0.08 of a tile
 *   per second, so a one-second animation drifts 0.08 of a tile however long the gif
 *   runs. To judge the SPEED of a skin, watch the game (`--scene game --slowmo`); to
 *   judge the tile, the sampling and the seams, this is the tool.
 */
export function timelineDt(fromTicks: number, toTicks: number): number {
  // Clamped at 0 rather than trusted: the runner walks ages forward, but a hand-driven
  // `GALLERY_DRAW(0, 0)` after a sequence would otherwise hand the skin a negative dt,
  // and `entities.sync`'s `dt > 0` gate would silently swallow it instead of showing it.
  return Math.max(0, toTicks - fromTicks) * DT;
}

export interface GalleryOptions {
  /** Names of elements to place, left to right. */
  elements: string[];
  view: string;
  /** Draw the mine dev overlay. */
  reach: boolean;
  timer: boolean;
  /** Light the underside, for shots checking for holes. Not how the game is lit. */
  fill: boolean;
  /**
   * The paint shop's triple, applied to the PLAYER tank through the game's own
   * `setPlayerStyle` -- so what the gallery shows is the shipped skin path, not a
   * depiction of it. `'solid'` with no hull/accent leaves the roster default alone.
   */
  skin: SkinId;
  hull: string | null;
  accent: string | null;
  /**
   * Override how many animation steps the subject wants. Null keeps what the elements
   * declare. It exists for skins: every shipped element is static (`frames: 1`) or a
   * few ticks long, so `--anim` on a tank had nothing to step and a scrolling skin had
   * no timeline to scroll along.
   *
   * DISCLOSED SURVIVING MUTANT: `buildGallery` ignoring this field entirely (returning
   * `frames: layout.frames`) passes 1741 of 1743 vitest cases (2 skipped) and 50 of 50
   * GL checks --
   * measured, both. `--frames N` would silently do nothing and only the runner would
   * show it. It is not killed here because the only observer is `run.mjs`, which writes
   * files from a real browser; nothing under `npm test` or `npm run test:gl` reads the
   * returned `frames`. Verified by hand instead, WITH its control: `--elements tank
   * --view low --skin flow --anim --frames 8 --subdiv 1` writes 8 frames with 8 distinct
   * md5s; under the mutation the same command writes 1 frame (`tank` declares
   * `frames: 1`), so the by-hand check really does discriminate.
   */
  frames: number | null;
}

export function buildGallery(canvas: HTMLCanvasElement, w: number, h: number, opts: GalleryOptions) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14171a);
  scene.add(new THREE.AmbientLight(0xffffff, 0.62));
  const key = new THREE.DirectionalLight(0xffffff, 1.05);
  key.position.set(6, 12, 4);
  scene.add(key);
  if (opts.fill) {
    const fill = new THREE.DirectionalLight(0xffffff, 0.7);
    fill.position.set(-3, -8, -2);
    scene.add(fill);
  }
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x2d5a3d }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const views = createEntityViews(scene);
  // Same call the game makes (renderer.ts's setPlayerStyle) and the Customize preview
  // makes -- the gallery has no skin machinery of its own to drift from it.
  if (opts.skin !== 'solid' || opts.hull || opts.accent) {
    views.setPlayerStyle(opts.hull ?? null, opts.skin, opts.accent ?? null);
  }
  const debug = createMineDebug(scene, { reach: opts.reach, timer: opts.timer });
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(w, h, false);

  const layout = compose(opts.elements, 0);
  const v = VIEWS[opts.view] ?? VIEWS.game;
  const FOV = 38;
  const cam = new THREE.PerspectiveCamera(FOV, w / h, 0.01, 200);
  if (v.up) cam.up.set(...v.up);
  // Distance that fits `span` across the SHORTER of the two axes, with a margin, so a
  // wide subject is not cropped by a tall viewport or vice versa.
  const vFov = (FOV * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (w / h));
  const dist = (layout.span / 2 / Math.tan(Math.min(vFov, hFov) / 2)) * 1.12;
  const focus = new THREE.Vector3(...layout.focus);
  const dir = new THREE.Vector3(...v.dir).normalize();
  cam.position.copy(focus).addScaledVector(dir, dist);
  cam.lookAt(focus);
  // Where on the timeline the last draw left off, in ticks. Null until the first draw,
  // which therefore advances nothing -- see timelineDt.
  let clock: number | null = null;
  function draw(age: number, alpha: number): void {
    const at = age + alpha;
    const dt = clock === null ? 0 : timelineDt(clock, at);
    clock = at;
    // prev/curr one tick apart, so interpolated quantities animate rather than step.
    views.sync(compose(opts.elements, age - 1).world, compose(opts.elements, age).world, alpha, dt);
    debug.sync(compose(opts.elements, age).world);
    renderer.render(scene, cam);
  }
  // The page itself never calls this -- it builds one gallery and lives as long as the
  // tab. It exists for tools/gl/harness.ts, which builds galleries inside a browser that
  // already holds other live contexts and must not leak one per check.
  function dispose(): void {
    views.dispose();
    debug.dispose();
    renderer.dispose();
  }
  return { draw, frames: opts.frames ?? layout.frames, dispose };
}
