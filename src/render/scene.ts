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

export interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  resize(w: number, h: number): void;
  dispose(): void;
}

export function createScene(
  canvas: HTMLCanvasElement,
  worldWidth: number,
  worldHeight: number,
): SceneContext {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x14161c, 1);

  const scene = new THREE.Scene();

  // Arena center in world/three space (ground = XZ plane).
  const cx = worldWidth / 2;
  const cz = worldHeight / 2;

  // Single fixed camera tilted ~50deg down, framing the whole board (no scrolling).
  const BASE_FOV = 50;
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 1000);
  const span = Math.max(worldWidth, worldHeight);
  camera.position.set(cx, span * 1.05, cz + span * 0.85);
  camera.lookAt(cx, 0, cz);

  // What the framing must actually contain: the playable area plus the ring of
  // boundary walls one cell outside it.
  const margin = Math.max(worldWidth, worldHeight) * 0.1;
  const requiredW = worldWidth + margin * 2;
  const requiredH = worldHeight + margin * 2;
  const requiredAspect = requiredW / requiredH;

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

  const ambient = new THREE.AmbientLight(0xffffff, 0.45);
  scene.add(ambient);

  // Matte 'felt' ground plane. Sized past the playable area because loadArena
  // puts the boundary walls a cell OUTSIDE it -- at exactly worldWidth x
  // worldHeight all four of them floated over the clear colour with nothing
  // beneath them, and their shadows fell on nothing.
  const groundGeo = new THREE.PlaneGeometry(worldWidth + margin * 2, worldHeight + margin * 2);
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
    const aspect = h === 0 ? 1 : w / h;
    camera.aspect = aspect;

    // Three's fov is VERTICAL, so horizontal coverage shrinks as the viewport
    // narrows while the camera distance stays fixed. This is a fixed-camera
    // game with no scrolling, so anything cropped is permanently unreachable
    // and unaimable -- at 0.89 aspect 9% of the arena width was off-screen, and
    // more than half of it in phone portrait. Widen the fov to compensate.
    camera.fov =
      aspect < requiredAspect
        ? (2 * Math.atan(Math.tan((BASE_FOV * Math.PI) / 360) * (requiredAspect / aspect)) * 180) /
          Math.PI
        : BASE_FOV;
    camera.updateProjectionMatrix();
  }
  resize(
    canvas.clientWidth || window.innerWidth,
    canvas.clientHeight || window.innerHeight,
  );

  function dispose(): void {
    // main.ts now wires this to pagehide, so it is a live path rather than
    // dead code -- detach the scene graph as well as freeing the GPU handles.
    scene.remove(ground, sun, sun.target, ambient);
    groundGeo.dispose();
    groundMat.dispose();
    // Light.dispose() -> shadow.dispose() frees BOTH shadow render targets:
    // `map` and `mapPass`, the latter allocated only by the VSM path. Calling
    // shadow.map.dispose() directly would leak mapPass the moment anyone
    // switches shadowMap.type to VSMShadowMap, one line up in this same file.
    sun.dispose();
    renderer.dispose();
    // dispose() alone leaves the WebGL context alive; browsers cap how many a
    // page may hold, so an explicit loss is what actually frees it.
    renderer.forceContextLoss();
  }

  return { scene, camera, renderer, resize, dispose };
}
