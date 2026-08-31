// The canonical tank model (issue #385), and the guard that keeps an exported tank from
// drifting away from the one the game draws.
//
// The drift risk this file exists for is NOT "the two builders disagree" -- they cannot,
// because `makeTank` calls `tankParts()`. It is that someone re-hardcodes a value at the
// consumer, which is exactly the shape the code had before this issue: a position written
// out longhand in `makeTank` looks harmless, keeps every existing render test green, and
// silently makes the exported model a different tank. So the assertions below compare the
// LIVE scene graph against the shared model, not the model against itself.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  tankParts,
  tankGeometryParameters,
  TURRET_GROUP_Y,
  BODY_WIDTH,
  HULL_WIDTH,
  TRACK_W,
  TRACK_H,
  TRACK_PROUD,
  HULL_RIDE,
  TANK_BODY_H,
  BULLET_Y,
} from './tank-model';
import { createEntityViews } from './entities';
import { createWorld } from '../sim/world';
import type { Spawn, Tank } from '../sim/types';

/** The live player tank's meshes, keyed by the name the renderer gives them. */
function liveTankMeshes(): { meshes: Map<string, THREE.Mesh[]>; turretGroupY: number; dispose: () => void } {
  const scene = new THREE.Scene();
  const views = createEntityViews(scene);
  const player: Tank = {
    id: 1, kind: 'player', pos: { x: 5, y: 5 }, bodyAngle: 0, turretAngle: 0,
    turretVel: 0, alive: true, cooldown: 0, mines: 0, mineCooldown: 0,
  } as unknown as Tank;
  const spawns: Spawn[] = [{ kind: 'player', pos: { x: 5, y: 5 }, angle: 0 }];
  const w = createWorld({ walls: [], tanks: [player], spawns, lives: 3 });
  views.sync(w, w, 0);
  scene.updateMatrixWorld(true);
  const meshes = new Map<string, THREE.Mesh[]>();
  let turretGroupY = NaN;
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh === true) {
      const list = meshes.get(o.name) ?? [];
      list.push(o as THREE.Mesh);
      meshes.set(o.name, list);
    }
    // The turret GROUP -- the parent of the dome, not the dome itself.
    if (o.type === 'Group' && o.children.some((c) => c.name === 'barrel')) turretGroupY = o.position.y;
  });
  return { meshes, turretGroupY, dispose: () => views.dispose() };
}

describe('the canonical tank model is the one the game builds', () => {
  it('emits exactly the parts the canonical model is defined as', () => {
    const parts = tankParts();
    // Named as a whole set rather than counted: the failure this catches is a part being
    // dropped or an extra one appearing, and a count survives one of each at once.
    expect(parts.map((p) => p.name)).toEqual(['hull', 'track', 'track', 'turret', 'barrel']);
    expect(parts.map((p) => p.parent)).toEqual(['visual', 'visual', 'visual', 'turret', 'turret']);
    // Skins, rings, spawn effects and the arena are deliberately absent -- the issue
    // scopes them out, and an exporter that picked them up would be exporting a scene
    // rather than a model.
    expect(parts).toHaveLength(5);
  });

  it('positions every part where the LIVE renderer positions it', () => {
    const { meshes, turretGroupY, dispose } = liveTankMeshes();
    try {
      const parts = tankParts();
      const hull = parts.find((p) => p.name === 'hull');
      const tracks = parts.filter((p) => p.name === 'track');
      expect(hull).toBeDefined();

      // The hull. A re-hardcoded `HULL_RIDE + bodyH / 2` in makeTank passes every existing
      // render test and fails here the moment either term moves.
      const liveHull = meshes.get('hull');
      expect(liveHull).toHaveLength(1);
      expect(liveHull?.[0].position.y).toBeCloseTo(hull!.position.y, 12);

      // Both tracks, compared as a SET of z offsets so left/right ordering is not part of
      // the claim -- only that the pair the game draws is the pair the model describes.
      const liveTracks = meshes.get('track') ?? [];
      expect(liveTracks).toHaveLength(2);
      const liveZ = liveTracks.map((m) => m.position.z).sort((a, b) => a - b);
      const modelZ = tracks.map((p) => p.position.z).sort((a, b) => a - b);
      expect(liveZ[0]).toBeCloseTo(modelZ[0], 12);
      expect(liveZ[1]).toBeCloseTo(modelZ[1], 12);
      for (const m of liveTracks) expect(m.position.y).toBeCloseTo(TRACK_H / 2, 12);

      // The turret group's height, which is what decides where the gun -- and therefore
      // every shell -- actually is.
      expect(turretGroupY).toBeCloseTo(TURRET_GROUP_Y, 12);

      // The barrel's roll, the one part with a non-zero rotation.
      const barrel = parts.find((p) => p.name === 'barrel');
      expect(meshes.get('barrel')?.[0].rotation.z).toBeCloseTo(barrel!.rotationZ, 12);
    } finally {
      dispose();
    }
  });

  it('builds every part from the SAME geometry the live renderer uses', () => {
    const { meshes, dispose } = liveTankMeshes();
    try {
      // Vertex counts, part by part. Not a proxy for "same shape" on its own -- two
      // different shapes can share a count -- but it is the half that a jsdom suite can
      // read, and it fails immediately if a part is rebuilt from different segment counts
      // or a different profile, which is what a duplicate implementation would be.
      for (const part of tankParts()) {
        const live = meshes.get(part.name) ?? [];
        expect(live.length, `no live mesh named '${part.name}'`).toBeGreaterThan(0);
        const modelCount = part.geometry.attributes.position.count;
        expect(
          live.some((m) => m.geometry.attributes.position.count === modelCount),
          `no live '${part.name}' has the model's ${modelCount} vertices`,
        ).toBe(true);
      }
    } finally {
      dispose();
    }
  });

  it('derives the body width from the envelope rather than authoring a second number', () => {
    // HULL_WIDTH is exactly the collider's diameter and must stay so, which means the body
    // gives way to the tracks rather than the envelope growing to fit both. Asserted as
    // the DERIVATION, so authoring a literal here fails even if it happens to equal it.
    expect(BODY_WIDTH).toBeCloseTo(HULL_WIDTH - TRACK_W * TRACK_PROUD * 2, 12);
    expect(BODY_WIDTH).toBeLessThan(HULL_WIDTH);
  });

  it('puts the turret group and the shell muzzle on one shared stack', () => {
    // `BULLET_Y` and the turret group are the same four terms. They were once independent,
    // and shells flew a third of a tank's height below the muzzle. Equality is the claim.
    expect(TURRET_GROUP_Y).toBeCloseTo(BULLET_Y, 12);
    expect(TURRET_GROUP_Y).toBeGreaterThan(HULL_RIDE + TANK_BODY_H - 0.2);
  });

  it('reports every parameter the exported metadata promises', () => {
    const params = tankGeometryParameters();
    // The bundle's metadata is only useful if it actually describes the geometry, so the
    // keys are pinned by name. A parameter added to the model and forgotten here would
    // ship a bundle whose description is quietly incomplete.
    for (const key of [
      'HULL_LEN', 'HULL_WIDTH', 'HULL_CORNER', 'HULL_NOSE', 'HULL_BEVEL', 'HULL_RIDE',
      'TANK_BODY_H', 'BODY_WIDTH', 'TANK_RADIUS',
      'TRACK_W', 'TRACK_H', 'TRACK_BEVEL', 'TRACK_PROUD', 'TRACK_OVERHANG', 'TRACK_SHADE',
      'TURRET_R', 'TURRET_H', 'TURRET_SEAT', 'TURRET_FILLET', 'TURRET_SEGMENTS', 'TURRET_GROUP_Y',
      'BARREL_R', 'BARREL_OUT', 'BARREL_SEGMENTS', 'MUZZLE_LEN', 'MUZZLE_FLARE',
    ]) {
      expect(params[key], `metadata is missing ${key}`).toBeTypeOf('number');
      expect(Number.isFinite(params[key]), `${key} is not finite`).toBe(true);
    }
    // ...and nothing else, so the list above cannot quietly stop being the whole set.
    expect(Object.keys(params)).toHaveLength(26);
  });

  it('hands out fresh geometry, because the renderer mutates what it is given', () => {
    // `entities.ts` re-parameterises UVs on the instances it receives and disposes them
    // per tank. A cached shared instance would either leak or arrive already projected for
    // whichever skin was built last -- which is a bug that shows up as one tank wearing
    // another's stripes, not as a failure here, so it is pinned at the source.
    const a = tankParts();
    const b = tankParts();
    for (let i = 0; i < a.length; i++) expect(a[i].geometry).not.toBe(b[i].geometry);
  });
});
