// Three.js builds and transforms its scene graph on the CPU -- only the actual
// draw needs a GL context -- so the sim -> three mapping IS testable headlessly,
// and it is the layer where a silent sign error breaks the whole game while the
// suite stays green.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createEntityViews } from './entities';
import { createWorld, type World } from '../sim/world';
import type { Tank, Spawn } from '../sim/types';

function makeTank(id: number, kind: Tank['kind'], x: number, y: number): Tank {
  return {
    id,
    kind,
    pos: { x, y },
    bodyAngle: 0,
    turretAngle: 0,
    alive: true,
    desiredMove: { x: 0, y: 0 },
    activeMineIds: [],
    fireCooldown: 0,
    mineCooldown: 0,
    aiState: 'idle',
    aiTimer: 0,
  };
}

function makeWorld(): World {
  const player = makeTank(1, 'player', 5, 5);
  const spawns: Spawn[] = [{ kind: 'player', pos: { x: 5, y: 5 }, angle: 0 }];
  return createWorld({ walls: [], tanks: [player], spawns, lives: 3 });
}

/**
 * Recover the gun's heading as a SIM angle from the rendered scene graph.
 *
 * The barrel is parked at the turret's local +x. Reading its world position
 * relative to the tank group and mapping three's (x, z) back to the sim's
 * (x, y) inverts the whole render transform -- so this measures what a player
 * actually sees, not what the code intended.
 */
function renderedGunAngle(scene: THREE.Scene): number {
  scene.updateMatrixWorld(true);
  const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
  const turret = group.children.find((c) => c instanceof THREE.Group) as THREE.Group;
  const barrel = turret.children.find(
    (c) => (c as THREE.Mesh).geometry instanceof THREE.CylinderGeometry,
  ) as THREE.Mesh;

  const gunPos = new THREE.Vector3();
  barrel.getWorldPosition(gunPos);
  const tankPos = new THREE.Vector3();
  group.getWorldPosition(tankPos);

  return Math.atan2(gunPos.z - tankPos.z, gunPos.x - tankPos.x);
}

const DEG = Math.PI / 180;

describe('entity views — turret aiming', () => {
  // The turret is a CHILD of the tank group, so writing the absolute
  // turretAngle onto it composed with the body rotation and aimed the barrel
  // at bodyAngle + turretAngle. Since moveTank sets bodyAngle to the driving
  // direction, the barrel pointed at the crosshair only while driving due east.
  it.each([
    { bodyAngle: 0, turretAngle: 0 },
    { bodyAngle: 0, turretAngle: 90 * DEG },
    { bodyAngle: 90 * DEG, turretAngle: 0 },
    { bodyAngle: 90 * DEG, turretAngle: 90 * DEG },
    { bodyAngle: 180 * DEG, turretAngle: 45 * DEG },
    { bodyAngle: -90 * DEG, turretAngle: 30 * DEG },
    { bodyAngle: 45 * DEG, turretAngle: 45 * DEG },
    { bodyAngle: 135 * DEG, turretAngle: -60 * DEG },
  ])(
    'points the barrel at turretAngle $turretAngle regardless of bodyAngle $bodyAngle',
    ({ bodyAngle, turretAngle }) => {
      const scene = new THREE.Scene();
      const views = createEntityViews(scene);
      const w = makeWorld();
      w.tanks[0].bodyAngle = bodyAngle;
      w.tanks[0].turretAngle = turretAngle;

      views.sync(w, w, 0);

      const rendered = renderedGunAngle(scene);
      // Compare as a direction, so the ±π wrap is not a false failure.
      expect(Math.cos(rendered)).toBeCloseTo(Math.cos(turretAngle), 9);
      expect(Math.sin(rendered)).toBeCloseTo(Math.sin(turretAngle), 9);

      views.dispose();
    },
  );

  it('places the tank at its sim position, mapping sim y to three z', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks[0].pos = { x: 3, y: 17 };

    views.sync(w, w, 0);
    scene.updateMatrixWorld(true);

    const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
    expect(group.position.x).toBeCloseTo(3, 9);
    expect(group.position.z).toBeCloseTo(17, 9);
    expect(group.position.y).toBeCloseTo(0, 9);

    views.dispose();
  });
});

describe('entity views — interpolation discontinuities', () => {
  it('snaps rather than lerps across a round boundary', () => {
    // resetArena teleports every tank back to spawn within one tick while
    // keeping its id and reviving it. Lerping that drew the tank streaking
    // across the arena for a frame, on every life lost.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);

    const prev = makeWorld();
    prev.tanks[0].pos = { x: 15.5, y: 15 };
    prev.roundStartTick = 0;

    const curr = makeWorld();
    curr.tanks[0].pos = { x: 11, y: 15 };
    curr.roundStartTick = 480; // resetArena re-anchored the round

    views.sync(prev, curr, 0.5);
    scene.updateMatrixWorld(true);

    const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
    expect(group.position.x).toBeCloseTo(11, 9); // curr pose, not the 13.25 midpoint

    views.dispose();
  });

  it('interpolates normally within a round', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);

    const prev = makeWorld();
    prev.tanks[0].pos = { x: 10, y: 5 };
    const curr = makeWorld();
    curr.tanks[0].pos = { x: 11, y: 5 };
    // same roundStartTick on both -> ordinary motion

    views.sync(prev, curr, 0.5);
    scene.updateMatrixWorld(true);

    const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
    expect(group.position.x).toBeCloseTo(10.5, 9);

    views.dispose();
  });

  it('clamps alpha, so an overshooting accumulator cannot extrapolate', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);

    const prev = makeWorld();
    prev.tanks[0].pos = { x: 10, y: 5 };
    const curr = makeWorld();
    curr.tanks[0].pos = { x: 11, y: 5 };

    views.sync(prev, curr, 2.5); // would extrapolate to x=12.5 unclamped
    scene.updateMatrixWorld(true);

    const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
    expect(group.position.x).toBeCloseTo(11, 9);

    views.dispose();
  });
});
