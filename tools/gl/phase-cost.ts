/**
 * What each PHASE of building and drawing a scene costs, in a real browser (issue #867).
 *
 * Run it with `node tools/gl/phase-cost.mjs`. It is a measurement tool, not a check: it
 * prints numbers and asserts nothing, because the numbers are hardware-dependent and
 * pinning them would be pinning this box.
 *
 * WHY IT EXISTS, and why a plainer probe gave the wrong answer. `tools/gl/run.mjs`'s
 * per-check profile can say WHICH checks got dearer between two `three` versions but not
 * WHICH PART of a check did, because SwiftShader queues draws and compiles and charges
 * them at the first call that blocks. A timer wrapped around `createScene` therefore reads
 * flat while the work it queued is billed to whatever renders next -- which is exactly how
 * issue #867 first recorded scene construction as unchanged (0.99x / 1.12x) when it is the
 * whole regression.
 *
 * So EVERY phase here ends with a 1x1 `readPixels`, which is that blocking call. Each
 * number below is bounded by its own work rather than by its neighbour's queue. The cost
 * of that discipline is that the absolute numbers include a readback each; the readback is
 * ~7 ms (see `bareDispose`/`sceneDispose` for the floor) and is present in both arms, so
 * it moves no ratio.
 *
 * THE THREE SUBJECTS, smallest last:
 *
 *   scene*  -- `createScene`, the shared substrate: renderer, lights, shadow map, ground,
 *              generated textures, environment map. Split into construct / compile / three
 *              draws, so a first draw can be told apart from a steady one.
 *   app*    -- `createRenderer`, which is `createScene` plus the entity views, and is what
 *              most of the GL harness's checks actually build.
 *   bare*   -- inside construction: a naked `WebGLRenderer` against `createEnvironmentMap`
 *              alone, on a 64x64 canvas where the page's own rasterisation cannot matter.
 *
 * TO COMPARE TWO `three` VERSIONS, move the INSTALL and read it back -- `npm i --no-save
 * three@0.169.0`, run, `npm i --no-save three@<current>`, run -- for the reason
 * `tools/gl/run.mjs` records beside its own version label: `--no-save` leaves package.json's
 * caret alone, so a manifest-derived label would label both arms identically. The runner
 * prints `THREE.REVISION` read from inside the page, which is the label that cannot lie.
 */
import * as THREE from 'three';

import { CURRENT_ARENA, arenaBounds } from '../../src/sim/arena';
import { createWorld } from '../../src/sim/world';
import { createRenderer } from '../../src/render/renderer';
import { createEnvironmentMap, createScene } from '../../src/render/scene';
import type { Spawn, Tank } from '../../src/sim/types';

const { width: W, height: H } = arenaBounds(CURRENT_ARENA);
const BOUNDARY = CURRENT_ARENA.cellSize;
const ROUNDS = Number(new URLSearchParams(location.search).get('rounds') ?? 6);

/** One round's phases, in milliseconds, keyed by phase name. */
type Round = Record<string, number>;

declare global {
  interface Window {
    __phaseCost?: { revision: string; rounds: Round[] };
  }
}

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  document.body.appendChild(c);
  return c;
}

/**
 * The blocking call, and the whole reason this file exists.
 *
 * Returns the byte it read, and every caller adds it to `sink`, so neither the read nor
 * the phase it bounds can be optimised away as dead.
 */
function block(gl: WebGLRenderingContext | WebGL2RenderingContext): number {
  const px = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px[0];
}

/** One tank at the arena centre: enough for the entity views to have something to draw. */
function soloWorld(): ReturnType<typeof createWorld> {
  const tank: Tank = {
    id: 1, kind: 'player', pos: { x: W / 2, y: H / 2 }, bodyAngle: 0, turretAngle: 0,
    alive: true, desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0,
    mineCooldown: 0, aiState: 'idle', aiTimer: 0,
  };
  const spawns: Spawn[] = [{ kind: 'player', pos: { x: W / 2, y: H / 2 }, angle: 0 }];
  return createWorld({ walls: [], tanks: [tank], spawns, lives: 3 });
}

let sink = 0;

function timed(out: Round, key: string, fn: () => void): void {
  const started = performance.now();
  fn();
  out[key] = performance.now() - started;
}

const rounds: Round[] = [];
for (let i = 0; i < ROUNDS; i++) {
  const r: Round = {};

  // --- the shared substrate ---
  let ctx!: ReturnType<typeof createScene>;
  const sceneCanvas = canvasOf(1280, 800);
  timed(r, 'sceneConstruct', () => {
    ctx = createScene(sceneCanvas, W, H, BOUNDARY);
    sink += block(ctx.renderer.getContext());
  });
  // Separate from the draws on purpose: `compile` builds the programs without drawing, so
  // a version that made SHADER BUILDING dearer and one that made RASTERISING dearer land
  // in different rows here instead of both landing in the first draw.
  timed(r, 'sceneCompile', () => {
    ctx.renderer.compile(ctx.scene, ctx.camera);
    sink += block(ctx.renderer.getContext());
  });
  for (const key of ['sceneDraw1', 'sceneDraw2', 'sceneDraw3']) {
    timed(r, key, () => {
      ctx.renderer.render(ctx.scene, ctx.camera);
      sink += block(ctx.renderer.getContext());
    });
  }
  timed(r, 'sceneDispose', () => ctx.dispose());
  sceneCanvas.remove();

  // --- what the GL harness's checks actually build ---
  const world = soloWorld();
  let app!: ReturnType<typeof createRenderer>;
  const appCanvas = canvasOf(1280, 800);
  // `createRenderer` does not expose its renderer, so the block goes through the canvas:
  // `getContext` hands back the context three already made on it rather than a new one.
  const appGl = (): WebGL2RenderingContext => appCanvas.getContext('webgl2') as WebGL2RenderingContext;
  timed(r, 'appConstruct', () => {
    app = createRenderer(appCanvas, W, H, BOUNDARY, {});
    sink += block(appGl());
  });
  for (const key of ['appRender1', 'appRender2', 'appRender3']) {
    timed(r, key, () => {
      app.render(world, world, 1, [], 1 / 60);
      sink += block(appGl());
    });
  }
  timed(r, 'appDispose', () => app.dispose());
  appCanvas.remove();

  // --- inside construction: 64x64, so nothing here is the page's own rasterisation ---
  let bare!: THREE.WebGLRenderer;
  const bareCanvas = canvasOf(64, 64);
  timed(r, 'bareRenderer', () => {
    bare = new THREE.WebGLRenderer({ canvas: bareCanvas, antialias: true });
    bare.setPixelRatio(1);
    bare.shadowMap.enabled = true;
    bare.toneMapping = THREE.ACESFilmicToneMapping;
    sink += block(bare.getContext());
  });
  timed(r, 'envMap', () => {
    const env = createEnvironmentMap(bare);
    sink += env.isTexture ? 1 : 0;
    env.dispose();
    sink += block(bare.getContext());
  });
  timed(r, 'bareDispose', () => bare.dispose());
  bareCanvas.remove();

  rounds.push(r);
}

// `sink` is read here so the reads above are load-bearing and cannot be elided.
window.__phaseCost = { revision: `${THREE.REVISION}${sink < 0 ? '?' : ''}`, rounds };
