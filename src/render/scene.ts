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
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  const span = Math.max(worldWidth, worldHeight);
  camera.position.set(cx, span * 1.05, cz + span * 0.85);
  camera.lookAt(cx, 0, cz);

  // Directional 'sun' casting soft shadows across the whole arena.
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(cx - worldWidth * 0.6, span * 1.6, cz - worldHeight * 0.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
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

  // Matte 'felt' ground plane sized to the arena.
  const groundGeo = new THREE.PlaneGeometry(worldWidth, worldHeight);
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
    renderer.setSize(w, h, false);
    camera.aspect = h === 0 ? 1 : w / h;
    camera.updateProjectionMatrix();
  }
  resize(
    canvas.clientWidth || window.innerWidth,
    canvas.clientHeight || window.innerHeight,
  );

  function dispose(): void {
    groundGeo.dispose();
    groundMat.dispose();
    renderer.dispose();
  }

  return { scene, camera, renderer, resize, dispose };
}
