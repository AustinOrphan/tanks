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
import { skinScroll, type SkinId } from '../game/customization';
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
// Exported so preview.test.ts can assert the fitted camera frames EXACTLY this, as
// tightly as the fit allows -- which is what makes a change to the framing fail
// something instead of silently moving the aim.
export const PREVIEW_AREA_W = 2.4;
export const PREVIEW_AREA_H = 1.8;
export const PREVIEW_MARGIN = 0.1;

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

/** What the preview's camera is aimed at: the tank, which stands on the origin. A
 * module-level constant rather than a fresh Vector3 per fit, since nothing moves it. */
const PREVIEW_TARGET = new THREE.Vector3(0, 0, 0);

/**
 * Aim `camera` at the tank for a viewport of the given aspect. THE ONLY place the
 * preview's framing is decided -- `createTankPreview`'s `fit()` and
 * `createPreviewCamera` both come through here, and neither calls `fitCameraToArea`
 * itself.
 *
 * That is the whole point of the function, and it did not start out true. `fit()` used
 * to make its own `fitCameraToArea` call with the same constants, which meant
 * `createPreviewCamera` was a PARALLEL construction that merely happened to agree:
 * review changed `fit()`'s framed area by 15% and every gate stayed green (50 of 50
 * vitest cases, 43 of 43 GL checks), with the shipped aim off by 15% of the frame and
 * the tests -- built on the other camera -- none the wiser. One fitter is what makes
 * "the tests unproject through the production camera" a fact about the code rather
 * than a coincidence between two call sites.
 */
export function fitPreviewCamera(camera: THREE.PerspectiveCamera, aspect: number): void {
  camera.aspect = aspect;
  fitCameraToArea(camera, PREVIEW_TARGET, PREVIEW_AREA_W, PREVIEW_AREA_H, PREVIEW_MARGIN);
}

/**
 * A preview camera, standalone: the same lens, framed by the same `fitPreviewCamera`
 * the live preview is framed by.
 *
 * Exported so `preview-controls.test.ts` can unproject the pointer through the
 * production framing rather than a stand-in built to match it. Needs no GL: a
 * PerspectiveCamera and `fitCameraToArea` are CPU maths, which is why framing.ts was
 * split out in the first place.
 *
 * What this does and does not guarantee, stated exactly, because the looser version of
 * this sentence was false. The FRAMING is shared, so a change to the fitted area, the
 * margin or the target moves the tests with the game -- and `preview.test.ts` pins that
 * framing tightly enough to notice. The LENS is shared only as the `FOV` constant, and
 * the near/far planes are duplicated literals; a change to those in one place and not
 * the other is not caught by construction, only by them sitting three lines apart.
 */
export function createPreviewCamera(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(FOV, aspect, 0.05, 100);
  fitPreviewCamera(camera, aspect);
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
    corpseBlocksShells: false,
    muzzleClearsTanks: true,
    coopAttempts: true, mode: 'campaign-coop', friendlyFire: false,
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

/**
 * @param rotateButtons The HUD's four rotate buttons, in any order. Optional, and the
 * preview is fully usable without them -- the drag, hover-aim and keyboard schemes are
 * on the canvas. They are passed in rather than looked up here because hud.ts owns the
 * markup and this file owns none of it (the same split that keeps `previewCanvas` on
 * the Hud interface), and because a querySelector against the document would make this
 * module silently depend on a class name nothing type-checks.
 */
export function createTankPreview(
  canvas: HTMLCanvasElement,
  rotateButtons?: Iterable<HTMLElement>,
): TankPreview | null {
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

  // Built through the same factory the tests use, then re-framed by the same fitter on
  // every resize -- so there is one camera construction for the preview, not two that
  // agree by inspection. See fitPreviewCamera's doc comment for what that bought.
  const camera = createPreviewCamera(1);

  function fit(): void {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    fitPreviewCamera(camera, h === 0 ? 1 : w / h);
  }
  fit();

  const world = previewWorld();

  /**
   * `dt` is the render animation clock, in seconds -- `entities.sync` gates an animated
   * skin's texture scroll on `dt > 0`.
   *
   * It defaulted to a hardwired literal `0` here, which froze `flow` -- the one animated
   * skin the game ships -- in the exact panel where a player decides whether to wear it.
   * A pose change or a restyle still passes 0: those redraws are not time passing, and
   * crediting them with any would drift the scroll by however often the player moved the
   * mouse. Time only comes from the controls' rAF loop, via `onAnimate`.
   */
  function draw(dt = 0): void {
    entities.sync(world, world, 1, dt);
    renderer.render(scene, camera);
  }
  draw();

  // The interaction layer. It owns the pose and calls back only when it actually
  // changes, so `onPose` is a redraw request with no filtering of its own -- and it owns
  // the panel's one rAF loop, which is why the skin's clock hangs off it too.
  const controls: PreviewControls = createPreviewControls(canvas, {
    camera,
    initialPose: INITIAL_PREVIEW_POSE,
    reducedMotion: prefersReducedMotion(),
    rotateButtons,
    onPose(pose): void {
      applyPose(world, pose);
      draw();
    },
    onAnimate(dt, pose): void {
      applyPose(world, pose);
      draw(dt);
    },
  });

  return {
    setStyle(hex, skin, accentHex): void {
      entities.setPlayerStyle(hex, skin, accentHex);
      // Picking an animated skin starts the clock; picking a static one stops it, so an
      // untouched panel showing `solid` costs no frames at all once the idle spin ends.
      //
      // That sentence is PINNED, and was not until review caught it. Writing
      // `controls.setAnimating(true)` unconditionally here -- a static skin repainting
      // for the life of the session -- passed 1741 of 1743 vitest cases (2 skipped) and
      // all 50 GL checks, measured with the one-loop test already present. It is killed now by `a STATIC skin schedules NO frames once
      // the spin has stopped` in tools/gl/harness.ts: 0 frames as shipped, 24 under the
      // mutation, over a 400ms window.
      //
      // Why every byte-level probe was blind to it, since that is the reusable part: a
      // static skin repainted forever changes ZERO bytes, and zero bytes is exactly what
      // the neighbouring check's `afterStatic === 0` half asserts. The observable that
      // works is the frame REQUEST, not the pixels. An earlier draft of this comment said
      // killing it needed an observable the preview does not expose; that was wrong --
      // `window.requestAnimationFrame` was reachable from the harness the whole time, and
      // "untested" had been written down as "unfalsifiable".
      controls.setAnimating(skinScroll(skin) !== null);
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
