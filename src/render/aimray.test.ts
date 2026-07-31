// The aim ray predicts the shell's path, so it must lie ON that path. Orientation and
// visibility are pinned in the real-browser suite (tools/gl/harness.ts); this pins the
// one thing that suite was not asserting: the height.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createAimRay } from './aimray';
import { BULLET_Y } from './entities';

describe('createAimRay', () => {
  it('draws the ray at shell flight height, not near the ground', () => {
    // RAY_Y was a hardcoded 0.35 -- the OLD shell height, kept by coincidence when
    // BULLET_Y moved to the barrel centreline (0.65). A ray below the muzzle diverges
    // on screen from the path the shell actually takes, which is the exact confusion
    // this dev overlay exists to remove.
    const scene = new THREE.Scene();
    const ray = createAimRay(scene);
    const line = scene.children.find((c) => c instanceof THREE.Line) as THREE.Line;
    expect(line).toBeDefined();
    const pos = (line.geometry as THREE.BufferGeometry).getAttribute('position');
    // Population: both endpoints of the one line segment. Precision 6, not 9:
    // BufferGeometry stores float32, so 0.65 reads back as 0.6499999761... -- a
    // 2.4e-8 storage artefact, five orders of magnitude below the 0.30 drift this
    // test exists to catch.
    expect(pos.count).toBe(2);
    expect(pos.getY(0)).toBeCloseTo(BULLET_Y, 6);
    expect(pos.getY(1)).toBeCloseTo(BULLET_Y, 6);
    ray.dispose();
  });
});
