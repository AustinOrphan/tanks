import * as THREE from 'three';
import { createWorld } from '../../src/sim/world';
import type { World } from '../../src/sim/world';
import type { Tank } from '../../src/sim/types';
import { createEntityViews } from '../../src/render/entities';
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
export type Subject = (age: number) => World;

function tank(id: number, kind: Tank['kind'], x: number, y: number): Tank {
  return {
    id, kind, pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  };
}
const empty = (tanks: Tank[] = []): World =>
  createWorld({ walls: [], spawns: [], lives: 3, tanks });

export interface SubjectDef {
  world: Subject;
  frames: number;
  note: string;
  /** Point the camera looks at, in world (three) coordinates. */
  focus: [number, number, number];
  /**
   * Roughly how many world units across the subject is.
   *
   * The camera distance is derived from this, so every view frames every subject. Views
   * used to be absolute positions tuned for one subject, which framed all the others
   * wrong -- a four-cell sweep of the mine came back with the mine off-screen in all four.
   */
  span: number;
}

export const SUBJECTS: Record<string, SubjectDef> = {
  /** One shell per compass heading, so the yaw mapping is legible from overhead. */
  shell: {
    focus: [0, 0.35, 0],
    span: 5,
    frames: 1,
    note: 'eight shells, one per heading',
    world: () => {
      const w = empty();
      for (let i = 0; i < 8; i++) {
        const a = (i * 2 * Math.PI) / 8;
        w.bullets.push({
          id: 100 + i, ownerId: 1, type: 'normal', bouncesLeft: 1, alive: true,
          pos: { x: (i % 4) * 1.1 - 1.65, y: Math.floor(i / 4) * 1.1 - 0.55 },
          vel: { x: Math.cos(a) * NORMAL_SPEED, y: Math.sin(a) * NORMAL_SPEED },
        });
      }
      return w;
    },
  },
  /** Unarmed beside armed, with a tank for scale. */
  mine: {
    focus: [0, 0.1, 0],
    span: 8,
    frames: 1,
    note: 'unarmed and armed, tank for scale',
    world: () => {
      const w = empty([tank(1, 'player', 2.6, 1.9)]);
      w.mines.push({ id: 10, ownerId: 1, pos: { x: -1.6, y: 0 }, timer: MINE_TIMER, armed: false, detonated: false });
      w.mines.push({ id: 11, ownerId: 1, pos: { x: 1.6, y: 0 }, timer: 0.5, armed: true, detonated: false });
      return w;
    },
  },
  /** One mine, fuse running, so the pulse can be watched at its real rate. */
  fuse: {
    focus: [0, 0.06, 0],
    span: 1.6,
    frames: 90,
    note: 'a single mine burning its whole fuse',
    world: (age) => {
      const w = empty();
      const timer = Math.max(0, MINE_TIMER * (1 - age / 90));
      w.mines.push({ id: 10, ownerId: 1, pos: { x: 0, y: 0 }, timer, armed: true, detonated: false });
      return w;
    },
  },
  /** A detonation, one frame per tick of its life. */
  blast: {
    focus: [0, 0.6, 0],
    span: 9,
    frames: BLAST_LIFE,
    note: 'a detonation, one frame per tick',
    world: (age) => {
      const w = empty([tank(1, 'player', -2.6, 0.6), tank(2, 'brown', 2.7, -0.4)]);
      if (age >= 0 && age < BLAST_LIFE) w.blasts.push({ id: 900, ownerId: 1, pos: { x: 0, y: 0 }, age });
      return w;
    },
  },
};

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
  subject: string;
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

  const subject = SUBJECTS[opts.subject] ?? SUBJECTS.mine;
  const v = VIEWS[opts.view] ?? VIEWS.game;
  const FOV = 38;
  const cam = new THREE.PerspectiveCamera(FOV, w / h, 0.01, 200);
  if (v.up) cam.up.set(...v.up);
  // Distance that fits `span` across the SHORTER of the two axes, with a margin, so a
  // wide subject is not cropped by a tall viewport or vice versa.
  const vFov = (FOV * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (w / h));
  const dist = (subject.span / 2 / Math.tan(Math.min(vFov, hFov) / 2)) * 1.12;
  const focus = new THREE.Vector3(...subject.focus);
  const dir = new THREE.Vector3(...v.dir).normalize();
  cam.position.copy(focus).addScaledVector(dir, dist);
  cam.lookAt(focus);
  function draw(age: number, alpha: number): void {
    // prev/curr one tick apart, so interpolated quantities animate rather than step.
    views.sync(subject.world(age - 1), subject.world(age), alpha);
    debug.sync(subject.world(age));
    renderer.render(scene, cam);
  }
  return { draw, frames: subject.frames };
}
