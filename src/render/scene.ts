/**
 * Coordinate convention (used by ALL render tasks):
 *
 * The sim is 2D `Vec2 {x, y}`. It maps to the Three.js **XZ ground plane**:
 *   - world `x` -> `three.x`
 *   - world `y` -> `three.z`
 *   - ground surface at `three.y = 0`
 *
 * World angles (`angleOf`, counter-clockwise in the xy-plane) map to
 * `object.rotation.y = -angle` -- note the negation, because rotating CCW
 * in the sim's xy-plane is a clockwise rotation about three's +y axis.
 */
import * as THREE from 'three';
import { createTextures, type TextureSet } from './textures';
import { framedBounds, fitCameraToArea } from './framing';

export interface SceneContext {
  scene: THREE.Scene;
  /**
   * Surface detail, created here because this is what owns the frame's lifetime and
   * therefore the dispose. entities.ts borrows from it rather than generating its own,
   * so every wall shares one map instead of one per mesh.
   */
  textures: TextureSet;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  resize(w: number, h: number): void;
  /**
   * Re-aim everything dimensional at a new board: ground plane, camera fit, light
   * rig, shadow camera, felt tiling. IN PLACE -- the GL context, the entity views
   * and the borrowed TextureSet all survive, so a level switch is arithmetic, not
   * a teardown.
   */
  refit(worldWidth: number, worldHeight: number, boundary: number): void;
  dispose(): void;
}

/** Vertical steps in the generated environment gradient. */
const ENV_STEPS = 64;

/**
 * A dim sky-to-ground gradient as raw RGBA, for the environment map.
 *
 * Cool above, warm-dark below, matching the fill and rim lights so a reflective surface
 * does not disagree with what is actually lighting it.
 */
function gradientPixels(): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(new ArrayBuffer(ENV_STEPS * 4));
  for (let i = 0; i < ENV_STEPS; i++) {
    const t = i / (ENV_STEPS - 1); // 0 = bottom, 1 = top
    data[i * 4 + 0] = Math.round(40 + t * 90);
    data[i * 4 + 1] = Math.round(44 + t * 110);
    data[i * 4 + 2] = Math.round(52 + t * 150);
    data[i * 4 + 3] = 255;
  }
  return data;
}

/**
 * The same generated sky-to-ground reflection environment createScene builds below,
 * pulled out so render/preview.ts's much smaller preview scene can give its tank the
 * SAME material read the main scene gives it -- one gradient, not two copies that could
 * drift apart. Every MeshStandardMaterial in render/entities.ts carries nonzero
 * metalness, which renders near-black with no environment at all (see createScene's own
 * comment on this), so a preview built without this would look worse than the tank it is
 * supposed to be showing faithfully.
 */
export function createEnvironmentMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const envScene = new THREE.Scene();
  const grad = new THREE.DataTexture(gradientPixels(), 1, ENV_STEPS, THREE.RGBAFormat);
  grad.needsUpdate = true;
  grad.mapping = THREE.EquirectangularReflectionMapping;
  envScene.background = grad;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(envScene).texture;
  grad.dispose();
  pmrem.dispose();
  return envMap;
}

/**
 * The camera's vertical field of view, in degrees.
 *
 * A LONG LENS on purpose. The board is a fixed rect viewed at a tilt, so it projects
 * to a trapezium -- and the wider the lens, the harder the far edge converges and the
 * more screen is wasted in the two triangles beside it. At the old 50 degrees the
 * board covered 48.5% of a 16:9 frame; at 30 it covers 59.6%, measured by projecting
 * the framed rect's corners through this very camera -- framing.test.ts pins the floor.
 * The camera moves FURTHER OUT to compensate for the narrower lens, and because the fit
 * then re-tightens the board against the frame, the board ends up BIGGER on screen, not
 * the same size.
 *
 * It also evens out readability: at 50 degrees a tank on the far rank drew noticeably
 * smaller than one on the near rank, for no gameplay reason.
 *
 * 30 IS A TASTE STOP, NOT A LIMIT. Review falsified an earlier claim here that ~68%
 * (the board's 1.21 aspect over 16:9's 1.78) was the geometric ceiling: that formula is
 * the UNTILTED one, and a camera tilted by theta foreshortens the board's depth so it
 * projects with aspect A/sin(theta) -- 1.55 here, not 1.21. Measured through this very
 * fit at the shipped tilt: fov 20 reaches 65.3%, fov 15 reaches 68.7% (already past the
 * "ceiling"), fov 5 reaches 77.0%, all still containing the board. The long-lens limit
 * at this margin is ~82.2% (~87.3% at margin 0 -- an earlier draft quoted the margin-0
 * figure beside a table measured at 0.03, which silently changed probe mid-sentence).
 * What stops us at 30 is depth: fov 15 puts the camera 64.9 units out and the board
 * reads nearly orthographic. Going further is a look decision, not a fix.
 */
export const BASE_FOV = 30;

export function createScene(
  canvas: HTMLCanvasElement,
  worldWidth: number,
  worldHeight: number,
  /** Thickness of the boundary wall ring loadArena puts OUTSIDE the playable area. */
  boundary: number,
): SceneContext {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x14161c, 1);
  // ACES filmic instead of the default clip-to-white.
  //
  // Every material here is untextured flat colour, so the only thing separating a lit
  // face from an unlit one is the response curve. Linear clipping flattened the bright
  // faces of the walls into a single value and left the shaded sides muddy; ACES rolls
  // the highlights off and keeps the midtones separated, which is what makes a plain
  // box read as a solid object rather than a filled polygon.
  //
  // Exposure is above 1 because the curve darkens the midrange: the arena was measurably
  // dimmer at 1.0 than it had been with no tone mapping at all.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;

  const scene = new THREE.Scene();

  // A two-tone environment, so `metalness` means something.
  //
  // MeshStandardMaterial takes a metal's colour from reflections. With only direct
  // lights and no environment, anything metallic renders nearly BLACK -- so without
  // this, adding metalness to differentiate a steel wall from a wooden crate would
  // have made both darker rather than different.
  //
  // Built here rather than loaded: a 2x64 gradient run through PMREM costs a few lines
  // and no asset, matching how the audio is generated rather than shipped.
  const envMap = createEnvironmentMap(renderer);
  scene.environment = envMap;
  // Intensity well under 1: the environment is here to give metals something to
  // reflect, not to light the scene. At 1.0 it flattened the sun's shadows.
  scene.environmentIntensity = 0.35;

  // Single fixed camera, framing the whole board (no scrolling). See BASE_FOV above.
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 1000);

  // Everything below here is DIMENSIONAL state, owned by fit() so a level switch can
  // re-aim it at a new board. Initialised by the fit() call at the bottom.
  let cx = worldWidth / 2;
  let cz = worldHeight / 2;
  let span = Math.max(worldWidth, worldHeight);
  // What the framing must contain: the playable area plus the boundary ring.
  // See framing.ts -- the fit itself lives there so it can be tested without a
  // GL context, which is why this file previously had no test at all.
  let framed = framedBounds(worldWidth, worldHeight, boundary);
  const target = new THREE.Vector3(cx, 0, cz);

  // Directional 'sun' casting soft shadows across the whole arena.
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // The felt is one large flat receiver, the classic shadow-acne surface -- but the bias
  // that fixes acne DETACHES the shadow from its caster if you overdo it, leaving a lit
  // sliver of felt between a wall and its own shadow. It was overdone: normalBias 0.02
  // is a full texel at the old shadow-camera size, and it showed at the base of every
  // wall.
  //
  // The fix is texel density first, bias second. The camera was covering 2 * span (40
  // units) for a board that with its boundary ring is 24 across, so ~40% of the map fell
  // outside anything that can cast or receive. Fitting it to the framed bounds takes the
  // texel from 0.0195 to 0.0117 world units, which is what lets the bias come down far
  // enough to close the gap without acne returning.
  sun.shadow.normalBias = 0.008;
  sun.shadow.bias = -0.0001;
  const shadowCam = sun.shadow.camera as THREE.OrthographicCamera;
  scene.add(sun);
  scene.add(sun.target);

  // A cool fill from the opposite side of the sun. With a single directional light every
  // surface facing away from it fell to flat ambient, so the near faces of every wall
  // were one dead tone. This gives them a gradient without pretending to be a second sun:
  // no shadows, low intensity, and tinted toward sky blue so it reads as bounce.
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.55);
  scene.add(fill);
  scene.add(fill.target);

  // A low warm rim from behind the board, to separate wall tops and turret edges from
  // the dark background. Almost horizontal on purpose -- it should catch edges, not
  // light faces.
  const rim = new THREE.DirectionalLight(0xffd9a8, 0.4);
  scene.add(rim);
  scene.add(rim.target);

  // Ambient drops now that fill and rim carry the shaded side. Left at 0.45 the three
  // together washed the shadows out, which is the thing the sun is here to draw.
  const ambient = new THREE.AmbientLight(0xffffff, 0.28);
  scene.add(ambient);

  // Matte 'felt' ground plane, covering the arena and its boundary ring EXACTLY.
  // It must reach past the playable area, because loadArena puts the walls a cell
  // outside it and at exactly worldWidth x worldHeight all four floated over the
  // clear colour. It must not reach further either: the shipped build used a 10%
  // margin (2.2) against a 2.0-thick ring, and that 0.2 of overhang showed as a
  // sliver of felt detached from the arena along the near edge.
  let groundGeo = new THREE.PlaneGeometry(framed.width, framed.height);
  // Tile the fibre grain roughly once per two world units. Any coarser and the felt
  // reads as fabric print; any finer and it aliases into shimmer at this camera height.
  // fit() keeps this density on refit by mutating texture.repeat. The TextureSet as a
  // whole must survive refit -- entities.ts borrows concreteNormal and timberNormal
  // from it -- so recreating the set is off the table, and mutating feltNormal's
  // repeat is the cheap, safe alternative.
  const feltRepeatFor = (w: number, h: number): number => Math.max(2, Math.round(Math.max(w, h) / 2));
  const textures = createTextures(feltRepeatFor(worldWidth, worldHeight));

  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x2f6d4f,
    roughness: 1.0,
    metalness: 0.0,
    normalMap: textures.feltNormal,
    // Low: the felt is a huge flat receiver and the grain should only show where light
    // grazes it. Turned up, the whole board reads as gravel.
    normalScale: new THREE.Vector2(0.35, 0.35),
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // The one owner of every dimensional decision: called at construction and by refit().
  function fit(w: number, h: number, ring: number): void {
    cx = w / 2;
    cz = h / 2;
    span = Math.max(w, h);
    framed = framedBounds(w, h, ring);
    target.set(cx, 0, cz);

    groundGeo.dispose();
    groundGeo = new THREE.PlaneGeometry(framed.width, framed.height);
    ground.geometry = groundGeo;
    ground.position.set(cx, 0, cz);
    const rep = feltRepeatFor(w, h);
    textures.feltNormal.repeat.set(rep, rep);

    sun.position.set(cx - w * 0.6, span * 1.6, cz - h * 0.6);
    sun.target.position.set(cx, 0, cz);
    // Half-DIAGONAL of the framed board, plus a margin so a caster right on the
    // boundary still has its shadow inside the map. Texel density is the shadow
    // fidelity knob (see normalBias above), so the shadow camera must track the
    // board or big arenas regrow the acne/detachment trade-off.
    //
    // The half-diagonal, not the half-longest-side: this ortho is oriented by the sun's
    // azimuth, not by the board's axes, so a square window sized to the longer SIDE
    // clips the corners. That was invisible while `ring` was 2.0 -- the margin happened
    // to be large enough to cover the shortfall -- and became visible the moment the 3x
    // cell rescale made `ring` 0.667: measured on arena-01, 2,436 of 158,400 playable-floor
    // points (0.05 grid) fell outside the shadow ortho and 0 of 4 playable corners were
    // inside, against 0 and 4 of 4 before the rescale. On screen the boundary wall's
    // shadow stopped in a hard diagonal cut and the corner was lit.
    const shadowHalf = Math.hypot(framed.width, framed.height) / 2 + ring;
    shadowCam.left = -shadowHalf;
    shadowCam.right = shadowHalf;
    shadowCam.top = shadowHalf;
    shadowCam.bottom = -shadowHalf;
    shadowCam.near = 0.5;
    shadowCam.far = span * 4;
    shadowCam.updateProjectionMatrix();

    fill.position.set(cx + w * 0.7, span * 0.6, cz + h * 0.5);
    fill.target.position.set(cx, 0, cz);
    rim.position.set(cx, span * 0.18, cz - h * 1.1);
    rim.target.position.set(cx, 0, cz);
  }
  fit(worldWidth, worldHeight, boundary);

  // The viewport size last seen, so refit() can re-run the camera fit without
  // being handed the canvas size again.
  let lastW = 0;
  let lastH = 0;

  function resize(w: number, h: number): void {
    lastW = w;
    lastH = h;
    // Re-read the pixel ratio: browser zoom mutates devicePixelRatio, and
    // dragging the window between a HiDPI and a 1x monitor changes it too.
    // Setting it once at construction left the drawing buffer stale.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    camera.aspect = h === 0 ? 1 : w / h;
    camera.fov = BASE_FOV;
    camera.updateProjectionMatrix();

    // Re-fit on every resize: the binding constraint swaps between the vertical
    // and horizontal extent as the viewport changes shape. This replaces widening
    // the fov on narrow viewports -- both keep the whole board on screen, but
    // fitting the DISTANCE also removes the slack a fixed distance left behind,
    // which is what made the arena small on a normal 16:10 window.
    fitCameraToArea(camera, target, framed.width, framed.height);
  }
  resize(
    canvas.clientWidth || window.innerWidth,
    canvas.clientHeight || window.innerHeight,
  );

  function refit(w: number, h: number, ring: number): void {
    fit(w, h, ring);
    resize(lastW, lastH);
  }

  function dispose(): void {
    // main.ts now wires this to pagehide, so it is a live path rather than
    // dead code -- detach the scene graph as well as freeing the GPU handles.
    scene.remove(ground, sun, sun.target, fill, fill.target, rim, rim.target, ambient);
    groundGeo.dispose();
    groundMat.dispose();
    // Light.dispose() -> shadow.dispose() frees BOTH shadow render targets:
    // `map` and `mapPass`, the latter allocated only by the VSM path. Calling
    // shadow.map.dispose() directly would leak mapPass the moment anyone
    // switches shadowMap.type to VSMShadowMap, one line up in this same file.
    sun.dispose();
    // fill and rim cast no shadows, so they hold no render targets -- but dispose them
    // anyway: the cost is nothing and the alternative is a leak the day someone gives
    // one of them castShadow, which is exactly how the sun's own shadow targets were
    // nearly missed.
    fill.dispose();
    rim.dispose();
    textures.dispose();
    envMap.dispose();
    scene.environment = null;
    renderer.dispose();
    // dispose() alone leaves the WebGL context alive; browsers cap how many a
    // page may hold, so an explicit loss is what actually frees it.
    renderer.forceContextLoss();
  }

  return { scene, camera, renderer, textures, resize, refit, dispose };
}
