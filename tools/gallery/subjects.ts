import * as THREE from 'three';
import { createWorld } from '../../src/sim/world';
import type { World } from '../../src/sim/world';
import { createEntityViews, BULLET_Y } from '../../src/render/entities';
import { createMineDebug } from '../../src/render/minedebug';
import {
  MINE_TIMER, NORMAL_SPEED, MINE_BLAST_EXPAND_TICKS, MINE_BLAST_HOLD_TICKS,
} from '../../src/sim/constants';

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

export interface GalleryOptions {
  /** Names of elements to place, left to right. */
  elements: string[];
  view: string;
  /** Draw the mine dev overlay. */
  reach: boolean;
  timer: boolean;
  /** Light the underside, for shots checking for holes. Not how the game is lit. */
  fill: boolean;
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
  function draw(age: number, alpha: number): void {
    // prev/curr one tick apart, so interpolated quantities animate rather than step.
    views.sync(compose(opts.elements, age - 1).world, compose(opts.elements, age).world, alpha);
    debug.sync(compose(opts.elements, age).world);
    renderer.render(scene, cam);
  }
  return { draw, frames: layout.frames };
}
