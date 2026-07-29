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
import { framedBounds, fitCameraToArea } from './framing';

export interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  resize(w: number, h: number): void;
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
  const envScene = new THREE.Scene();
  const grad = new THREE.DataTexture(gradientPixels(), 1, ENV_STEPS, THREE.RGBAFormat);
  grad.needsUpdate = true;
  grad.mapping = THREE.EquirectangularReflectionMapping;
  envScene.background = grad;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(envScene).texture;
  scene.environment = envMap;
  // Intensity well under 1: the environment is here to give metals something to
  // reflect, not to light the scene. At 1.0 it flattened the sun's shadows.
  scene.environmentIntensity = 0.35;
  grad.dispose();
  pmrem.dispose();

  // Arena center in world/three space (ground = XZ plane).
  const cx = worldWidth / 2;
  const cz = worldHeight / 2;

  // Single fixed camera tilted ~50deg down, framing the whole board (no scrolling).
  const BASE_FOV = 50;
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 1000);
  const span = Math.max(worldWidth, worldHeight);

  // What the framing must contain: the playable area plus the boundary ring.
  // See framing.ts -- the fit itself lives there so it can be tested without a
  // GL context, which is why this file previously had no test at all.
  const framed = framedBounds(worldWidth, worldHeight, boundary);
  const target = new THREE.Vector3(cx, 0, cz);

  // Directional 'sun' casting soft shadows across the whole arena.
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(cx - worldWidth * 0.6, span * 1.6, cz - worldHeight * 0.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // The felt is one large flat receiver, the classic shadow-acne surface.
  sun.shadow.normalBias = 0.02;
  sun.shadow.bias = -0.0005;
  const shadowCam = sun.shadow.camera as THREE.OrthographicCamera;
  shadowCam.left = -span;
  shadowCam.right = span;
  shadowCam.top = span;
  shadowCam.bottom = -span;
  shadowCam.near = 0.5;
  shadowCam.far = span * 4;
  shadowCam.updateProjectionMatrix();
  sun.target.position.set(cx, 0, cz);
  scene.add(sun);
  scene.add(sun.target);

  // A cool fill from the opposite side of the sun. With a single directional light every
  // surface facing away from it fell to flat ambient, so the near faces of every wall
  // were one dead tone. This gives them a gradient without pretending to be a second sun:
  // no shadows, low intensity, and tinted toward sky blue so it reads as bounce.
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.55);
  fill.position.set(cx + worldWidth * 0.7, span * 0.6, cz + worldHeight * 0.5);
  fill.target.position.set(cx, 0, cz);
  scene.add(fill);
  scene.add(fill.target);

  // A low warm rim from behind the board, to separate wall tops and turret edges from
  // the dark background. Almost horizontal on purpose -- it should catch edges, not
  // light faces.
  const rim = new THREE.DirectionalLight(0xffd9a8, 0.4);
  rim.position.set(cx, span * 0.18, cz - worldHeight * 1.1);
  rim.target.position.set(cx, 0, cz);
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
  const groundGeo = new THREE.PlaneGeometry(framed.width, framed.height);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x2f6d4f,
    roughness: 1.0,
    metalness: 0.0,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, 0, cz);
  ground.receiveShadow = true;
  scene.add(ground);

  function resize(w: number, h: number): void {
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
    envMap.dispose();
    scene.environment = null;
    renderer.dispose();
    // dispose() alone leaves the WebGL context alive; browsers cap how many a
    // page may hold, so an explicit loss is what actually frees it.
    renderer.forceContextLoss();
  }

  return { scene, camera, renderer, resize, dispose };
}
