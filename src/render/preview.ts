/**
 * The paint shop's tank preview: a small, dedicated WebGL scene showing the PLAYER
 * tank close up, built from the SAME `render/entities.ts` mesh/material/skin code and
 * `render/skins.ts` textures the main game scene uses, through the same
 * tone-mapping/exposure and a matching generated environment map (see
 * scene.ts's `createEnvironmentMap`) -- so the geometry, materials and skin are not a
 * depiction, they are the game's own. The one thing that deliberately differs is the
 * LIGHT RIG: a simpler key/fill/ambient set sized for a close-up, not the arena's
 * sun/fill/rim tuned for a whole board, so absolute colour can read slightly
 * differently even though every material is identical -- see setStyle's own check in
 * tools/gl/harness.ts for what IS asserted (which channel dominates after a hull
 * change), not pixel-exact equality with the arena.
 *
 * A second WebGLRenderer is a real cost, so `game/loop.ts` builds one only while the
 * Customize panel is open (`hud.onCustomizeOpen`) and `dispose()`s it on close
 * (`onCustomizeClose`) -- the peak is two live contexts (this one plus the main
 * game's), well under a typical browser's concurrent-context cap (commonly cited
 * around 8-16), though this was not measured against actual eviction on low-end
 * hardware, nor against how the MAIN context behaves if the browser ever does evict
 * one (`webglcontextlost` is not handled here or in renderer.ts).
 *
 * There is exactly ONE `.hud-preview` canvas for the whole session (see hud.ts's
 * markup) -- open/Back/open again reuses the SAME element, not a fresh one -- so
 * dispose() deliberately does NOT call `renderer.forceContextLoss()` the way
 * scene.ts's does. scene.ts's canvas gets a brand new WebGLRenderer on every level
 * (a genuinely new canvas each time main.ts boots, or never at all otherwise), so
 * losing the context on teardown is free. This canvas is reused, and a lost context
 * does not reliably come back: a real run with `forceContextLoss()` still in dispose()
 * proved the SECOND `createTankPreview` on that same canvas returns `null` -- not a
 * live renderer that draws nothing, `new THREE.WebGLRenderer` itself throws against
 * the lost context, which the try/catch above (correctly, if for the "no context
 * available" reason it exists for) turns into a null return -- see the "reopening on
 * the SAME canvas" check in tools/gl/harness.ts, which fails with exactly that message
 * against the forceContextLoss version and is the reason this comment exists.
 * Measured directly, not merely inferred: after a plain (non-force-losing) dispose(),
 * `canvas.getContext(...)` on the SAME canvas returns the SAME context object, live,
 * and a `createTankPreview` built from it renders correctly -- so the context is not
 * freed by dispose(), it is HELD, from the first Customize open through the rest of
 * the session. dispose() still frees everything IT owns at the THREE level -- the
 * entity views, the lights, the ground, the generated environment map -- so that cost
 * does not grow across an open/close cycle; only the raw context itself, and the small
 * viewport/state THREE keeps for it, survives to be reused.
 *
 * `createTankPreview` returns `null` instead of throwing if the environment cannot
 * hand out a context (three.js's WebGLRenderer constructor throws when
 * `canvas.getContext` returns null). A low-end device that has run out of contexts
 * loses the preview, not the game -- see preview.test.ts, which proves this branch
 * for real: jsdom has no WebGL implementation at all, so constructing here under
 * vitest exercises the exact same catch this guards a real browser with.
 */
import * as THREE from 'three';
import { createEntityViews, type EntityViews } from './entities';
import { createEnvironmentMap } from './scene';
import { fitCameraToArea } from './framing';
import { createPreviewControls, type PreviewControls, type PreviewPose } from './preview-controls';
import type { SkinId } from '../game/customization';
import type { World } from '../sim/world';
import type { Tank } from '../sim/types';

export interface TankPreview {
  /** Repaint live -- same triple as Renderer3D.setPlayerStyle, same semantics. */
  setStyle(hex: string | null, skin: SkinId, accentHex: string | null): void;
  /** Re-read the canvas's CSS size and re-fit the camera. Cheap; call on window resize. */
  resize(): void;
  dispose(): void;
}

// The preview deliberately uses a WIDER lens than the arena, and that divergence is
// now the point rather than an accident.
//
// This comment used to say the value matched scene.ts's BASE_FOV, and that BASE_FOV was
// a local const not worth exporting. Both stopped being true the moment PR #103 merged:
// BASE_FOV is exported now, and it is 30, chosen so the arena's whole board fills more
// of the screen without its far edge converging hard.
//
// That reasoning does not carry over to a close-up of ONE tank. A 30-degree lens here
// would push the camera far enough out that the tank reads nearly flat -- the opposite
// of what a preview is for, since the whole job of this panel is to show the model with
// some dimensionality. So 50 stays and the two are meant to differ.
//
// FEEL, not measurement: 30 vs 50 was never rendered side by side here, nothing pins
// this constant, and no test would notice it changing. Retune by looking, not by
// reasoning -- and if the arena's fov moves again, this comment does NOT automatically
// go stale with it, because it no longer claims to track it.
const FOV = 50;

// The area fitCameraToArea frames, in world units -- the hull is 1x1 (HULL_WIDTH /
// HULL_LEN in entities.ts) but the turret overhangs the nose and the muzzle overhangs
// the turret, so the framed area is generously larger than the hull alone. Chosen by
// eye against the real geometry (see "Numbers that are feel, not measurement" in
// CLAUDE.md); cheap to retune with `npm run gallery`.
const PREVIEW_AREA_W = 2.4;
const PREVIEW_AREA_H = 1.8;
const PREVIEW_MARGIN = 0.1;

// A neutral 3/4 pose: hull turned off dead-on so both a flank and the front plate
// read, turret aligned with the hull rather than off aiming at nothing in particular.
// The pose the preview OPENS at -- it is no longer where the tank stays, since
// preview-controls.ts drives it from there.
export const PREVIEW_BODY_ANGLE = Math.PI * 0.15;

/** The pose a freshly opened preview shows. */
export const INITIAL_PREVIEW_POSE: PreviewPose = {
  bodyAngle: PREVIEW_BODY_ANGLE,
  turretAngle: PREVIEW_BODY_ANGLE,
};

/**
 * The camera `createTankPreview` draws through, built standalone.
 *
 * Exported (and constructed here rather than inline) so `preview-controls.test.ts` can
 * unproject the pointer through the PRODUCTION camera instead of a stand-in built to
 * match it. A stand-in would pass happily after FOV or PREVIEW_AREA_W changed and left
 * the real aim pointing somewhere else -- the whole class of drift this repo's "prove
 * the assertion can fail" rule exists to catch. Needs no GL: a PerspectiveCamera and
 * `fitCameraToArea` are CPU maths, which is why framing.ts was split out in the first
 * place.
 */
export function createPreviewCamera(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(FOV, aspect, 0.05, 100);
  camera.aspect = aspect;
  fitCameraToArea(
    camera,
    new THREE.Vector3(0, 0, 0),
    PREVIEW_AREA_W,
    PREVIEW_AREA_H,
    PREVIEW_MARGIN,
  );
  return camera;
}

/** Write a pose onto the preview's single tank. The turret angle is stored ABSOLUTE,
 * which is what `entities.ts` reads (it subtracts the body angle itself when it
 * orients the turret group -- see the composition note there). Exported so
 * preview.test.ts can run the result through `createEntityViews` and read the barrel's
 * real world heading, without a GL context. */
export function applyPose(world: World, pose: PreviewPose): void {
  world.tanks[0].bodyAngle = pose.bodyAngle;
  world.tanks[0].turretAngle = pose.turretAngle;
}

/** A single, motionless player tank. Not built through sim/world.ts's `createWorld` --
 * that pulls collision/bullets/mines/ai into the render bundle for a static prop this
 * module never simulates. `World`/`Tank` are TYPE-ONLY imports (see the import above),
 * so this file reaches sim only at the type level, the same way renderer.ts already
 * does for `World`. */
export function previewWorld(): World {
  const tank: Tank = {
    id: 1,
    kind: 'player',
    pos: { x: 0, y: 0 },
    bodyAngle: PREVIEW_BODY_ANGLE,
    turretAngle: PREVIEW_BODY_ANGLE,
    alive: true,
    desiredMove: { x: 0, y: 0 },
    activeMineIds: [],
    fireCooldown: 0,
    mineCooldown: 0,
    aiState: 'idle',
    aiTimer: 0,
  };
  return {
    tick: 0,
    nextId: 2,
    seed: 1,
    unarmedTrigger: 'none',
    tanks: [tank],
    bullets: [],
    mines: [],
    blasts: [],
    walls: [],
    spawns: [],
    status: 'playing',
    lives: 1,
    roundStartTick: 1,
  };
}

/**
 * True when the player has asked the platform for less motion, in which case the idle
 * spin does not run at all.
 *
 * Read once per preview rather than subscribed to: the preview lives only while the
 * Customize panel is open, so a change taking effect on the next open is soon enough,
 * and a `matchMedia` subscription is one more listener to leak. Guarded because
 * `matchMedia` is not universally present (jsdom does not implement it), and losing
 * the preview to a missing media-query API would be an absurd trade.
 */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function createTankPreview(canvas: HTMLCanvasElement): TankPreview | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // Transparent clear: the panel already paints its own backdrop (hud.css
  // .hud-customize), so the preview blends into it rather than fighting it with a
  // second background colour.
  renderer.setClearColor(0x000000, 0);
  // Same tone-mapping/exposure as scene.ts's main renderer: without this the SAME
  // material would come out a different brightness/contrast here than in the arena,
  // which is exactly the "depiction, not the tank" drift this module exists to avoid.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  const envMap = createEnvironmentMap(renderer);
  scene.environment = envMap;
  scene.environmentIntensity = 0.35;

  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(-1.6, 2.4, 1.9);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(512, 512);
  const shadowCam = key.shadow.camera as THREE.OrthographicCamera;
  shadowCam.left = -1.6;
  shadowCam.right = 1.6;
  shadowCam.top = 1.6;
  shadowCam.bottom = -1.6;
  shadowCam.near = 0.5;
  shadowCam.far = 8;
  key.shadow.bias = -0.0008;
  scene.add(key, key.target);

  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.55);
  fill.position.set(1.6, 1.2, -1.3);
  scene.add(fill);

  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambient);

  // A small round platform, just enough to receive a contact shadow -- this is a
  // close-up of one tank, not an arena, so it does not try to be one.
  const groundGeo = new THREE.CircleGeometry(1.3, 32);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x2f6d4f,
    roughness: 1,
    metalness: 0,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const entities: EntityViews = createEntityViews(scene);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 100);
  const target = new THREE.Vector3(0, 0, 0);

  function fit(): void {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    camera.aspect = h === 0 ? 1 : w / h;
    fitCameraToArea(camera, target, PREVIEW_AREA_W, PREVIEW_AREA_H, PREVIEW_MARGIN);
  }
  fit();

  const world = previewWorld();

  function draw(): void {
    entities.sync(world, world, 1, 0);
    renderer.render(scene, camera);
  }
  draw();

  // The interaction layer. It owns the pose and calls back only when it actually
  // changes, so `onPose` is a redraw request with no filtering of its own.
  const controls: PreviewControls = createPreviewControls(canvas, {
    camera,
    initialPose: INITIAL_PREVIEW_POSE,
    reducedMotion: prefersReducedMotion(),
    onPose(pose): void {
      applyPose(world, pose);
      draw();
    },
  });

  return {
    setStyle(hex, skin, accentHex): void {
      entities.setPlayerStyle(hex, skin, accentHex);
      draw();
    },
    resize(): void {
      fit();
      draw();
    },
    dispose(): void {
      // First, so nothing can schedule a frame or draw into a torn-down renderer
      // afterwards. The Customize panel closing disposes the preview while a finger
      // may still be down on the canvas, which is exactly that race.
      controls.dispose();
      entities.dispose();
      key.dispose();
      fill.dispose();
      groundGeo.dispose();
      groundMat.dispose();
      envMap.dispose();
      scene.environment = null;
      // NOT renderer.forceContextLoss() -- see this file's doc comment. The single
      // persistent `.hud-preview` canvas needs its context reusable on the NEXT open,
      // and a force-lost context does not reliably come back.
      renderer.dispose();
    },
  };
}
