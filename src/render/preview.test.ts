// @vitest-environment jsdom
//
// createTankPreview builds a real WebGLRenderer, which jsdom cannot provide -- so the
// FACTORY can only be exercised here for the one branch that does not need a working
// GL context: the fail-soft guard around construction. What it renders, and whether a
// style reaches the pixels, still needs a real context and lives in tools/gl/harness.ts
// (`npm run test:gl`).
//
// Everything preview.ts exports BESIDE the factory is plain CPU maths -- the camera,
// the prop world, the pose it writes onto it -- and three builds and transforms its
// scene graph on the CPU, so the pose can be pushed all the way through the REAL
// entities.ts and read back off the scene graph here. That is what pins the one thing
// a pixel check cannot see: that the interactive turret angle stays ABSOLUTE.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createTankPreview,
  createPreviewCamera,
  previewWorld,
  applyPose,
  INITIAL_PREVIEW_POSE,
} from './preview';
import { createEntityViews } from './entities';
import { createPreviewControls, HULL_DRAG_RAD_PER_PX } from './preview-controls';

describe('createTankPreview: fails soft when no WebGL context is available', () => {
  it('returns null instead of throwing', () => {
    // jsdom implements no WebGL context at all -- canvas.getContext('webgl') and
    // ('webgl2') both return null here, which is exactly the condition
    // THREE.WebGLRenderer's constructor throws on ("Error creating WebGL context").
    // That is a REAL, unmocked exercise of the same catch branch a browser takes when
    // it has run out of contexts to hand out -- not a simulation of it.
    const canvas = document.createElement('canvas');
    expect(canvas.getContext('webgl2')).toBeNull();
    expect(canvas.getContext('webgl')).toBeNull();

    let result: ReturnType<typeof createTankPreview> | 'threw' = 'threw';
    try {
      result = createTankPreview(canvas);
    } catch {
      result = 'threw';
    }
    // The assertion that can fail: removing the try/catch around `new
    // THREE.WebGLRenderer` in preview.ts makes this throw instead of returning null,
    // which this catches and reports as 'threw' rather than null.
    expect(result).toBeNull();
  });
});

/**
 * The gun's heading, recovered as a SIM angle from the rendered scene graph -- the
 * same inversion entities.test.ts uses, repeated here rather than shared because what
 * it is checking is different: there, that entities.ts composes correctly; here, that
 * the PREVIEW hands it an angle in the convention it composes.
 */
function renderedGunAngle(scene: THREE.Scene): number {
  scene.updateMatrixWorld(true);
  const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
  let barrel: THREE.Mesh | undefined;
  group.traverse((o) => {
    if (o.name === 'barrel') barrel = o as THREE.Mesh;
  });
  if (!barrel) throw new Error('no barrel mesh');
  const pts = (barrel.geometry as THREE.LatheGeometry).parameters.points;
  const tipLocal = new THREE.Vector3(0, Math.max(...pts.map((p) => p.y)), 0);
  const gunPos = barrel.localToWorld(tipLocal);
  const tankPos = new THREE.Vector3();
  group.getWorldPosition(tankPos);
  return Math.atan2(gunPos.z - tankPos.z, gunPos.x - tankPos.x);
}

/** Draw a pose through the real entity views and hand back the scene graph. */
function render(pose: { bodyAngle: number; turretAngle: number }): {
  scene: THREE.Scene;
  dispose: () => void;
} {
  const scene = new THREE.Scene();
  const views = createEntityViews(scene);
  const world = previewWorld();
  applyPose(world, pose);
  views.sync(world, world, 1, 0);
  return { scene, dispose: () => views.dispose() };
}

const DEG = Math.PI / 180;

describe('the preview pose reaches the model the way the game does', () => {
  it.each([
    { bodyAngle: 0, turretAngle: 0 },
    { bodyAngle: 0, turretAngle: 90 * DEG },
    { bodyAngle: 120 * DEG, turretAngle: 0 },
    { bodyAngle: 120 * DEG, turretAngle: -35 * DEG },
    { bodyAngle: -75 * DEG, turretAngle: 160 * DEG },
  ])(
    'aims the barrel at turretAngle $turretAngle whatever the hull is doing ($bodyAngle)',
    ({ bodyAngle, turretAngle }) => {
      // The whole reason the two rotations can be independent at all. `applyPose`
      // storing a hull-RELATIVE turret angle (bodyAngle + turretAngle, or the
      // difference) is the exact defect entities.ts records having shipped once; every
      // row here dies on it except the two where bodyAngle is 0.
      const { scene, dispose } = render({ bodyAngle, turretAngle });
      const rendered = renderedGunAngle(scene);
      expect(Math.cos(rendered)).toBeCloseTo(Math.cos(turretAngle), 9);
      expect(Math.sin(rendered)).toBeCloseTo(Math.sin(turretAngle), 9);
      dispose();
    },
  );

  it('turns the hull without the gun following it', () => {
    // Hull-only motion, which is what an arrow key and a touch drag both produce. The
    // hull must move on screen and the barrel must not.
    const held = 40 * DEG;
    const a = render({ bodyAngle: 0, turretAngle: held });
    const gunA = renderedGunAngle(a.scene);
    const hullA = (a.scene.children.find((c) => c instanceof THREE.Group) as THREE.Group)
      .rotation.y;
    a.dispose();
    const b = render({ bodyAngle: 100 * DEG, turretAngle: held });
    const gunB = renderedGunAngle(b.scene);
    const hullB = (b.scene.children.find((c) => c instanceof THREE.Group) as THREE.Group)
      .rotation.y;
    b.dispose();
    expect(gunB).toBeCloseTo(gunA, 9);
    expect(Math.abs(hullB - hullA)).toBeCloseTo(100 * DEG, 9);
  });

  it('opens with the gun aligned to the hull, not aiming off at nothing', () => {
    expect(INITIAL_PREVIEW_POSE.turretAngle).toBe(INITIAL_PREVIEW_POSE.bodyAngle);
    const { scene, dispose } = render(INITIAL_PREVIEW_POSE);
    expect(renderedGunAngle(scene)).toBeCloseTo(INITIAL_PREVIEW_POSE.bodyAngle, 9);
    dispose();
  });
});

describe('dragging right turns the tank the way a turntable does', () => {
  it('swings the near face of the hull toward the right of the screen', () => {
    // The SIGN, checked where it is visible rather than restated as the formula that
    // produced it. The preview camera sits on +z (framing.ts's VIEW_DIR) looking at
    // the origin, so screen-right is +x and the surface facing the player is the +z
    // side. A rightward drag must carry that surface toward +x. Flipping the sign in
    // preview-controls.ts's drag maths sends it to -x and fails this.
    const canvas = document.createElement('canvas');
    const rect = { left: 0, top: 0, width: 260, height: 190 };
    canvas.getBoundingClientRect = () =>
      ({ ...rect, right: 260, bottom: 190, x: 0, y: 0, toJSON: () => rect }) as DOMRect;
    let pose = { bodyAngle: 0, turretAngle: 0 };
    const controls = createPreviewControls(canvas, {
      camera: createPreviewCamera(260 / 190),
      initialPose: pose,
      reducedMotion: true,
      onPose: (p) => {
        pose = p;
      },
      raf: () => 0,
      cancelRaf: () => {},
    });
    const press = new MouseEvent('pointerdown', { clientX: 130, clientY: 95, bubbles: true, cancelable: true });
    Object.defineProperty(press, 'pointerId', { value: 1 });
    Object.defineProperty(press, 'pointerType', { value: 'touch' });
    canvas.dispatchEvent(press);
    const move = new MouseEvent('pointermove', { clientX: 230, clientY: 95, bubbles: true, cancelable: true });
    Object.defineProperty(move, 'pointerId', { value: 1 });
    Object.defineProperty(move, 'pointerType', { value: 'touch' });
    canvas.dispatchEvent(move);
    controls.dispose();

    // A 100px drag, so the hull has turned by a known amount and not merely "some".
    expect(pose.bodyAngle).toBeCloseTo(-100 * HULL_DRAG_RAD_PER_PX, 9);

    const { scene, dispose } = render(pose);
    scene.updateMatrixWorld(true);
    const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
    // The point of the hull that faced the camera at rest.
    const near = group.localToWorld(new THREE.Vector3(0, 0, 1));
    expect(near.x).toBeGreaterThan(0.2);
    expect(near.z).toBeGreaterThan(0);
    dispose();
  });
});
