// The mine warning cues driven through the REAL entity views (issue #276), rather than
// through the frame function alone. createEntityViews only needs a THREE.Scene -- no
// renderer, no canvas -- so the sync path is testable headlessly, and that is the layer
// where "a paused game holds its frame" and "the meshes are disposed" actually live.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createEntityViews } from './entities';
import { FUSE_WARNING_SECONDS } from './mine-warning';
import type { World } from '../sim/world';
import type { Mine } from '../sim/types';
import { MINE_TIMER, MINE_PROXIMITY_DELAY_TICKS } from '../sim/constants';

function mine(over: Partial<Mine> = {}): Mine {
  return { id: 1, ownerId: 2, pos: { x: 0, y: 0 }, timer: MINE_TIMER, armed: true, detonated: false, ...over };
}

function world(mines: Mine[]): World {
  return {
    tick: 0, nextId: 100, seed: 3, tanks: [], bullets: [], mines, blasts: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: 0, unarmedTrigger: 'none',
    corpseBlocksShells: false, muzzleClearsTanks: true, coopAttempts: true,
    mode: 'campaign-coop', friendlyFire: false,
  };
}

const ring = (s: THREE.Scene) => s.children.find((c) => c.name === 'mine-fuse-warning');
const fill = (s: THREE.Scene) => s.children.find((c) => c.name === 'mine-proximity-fill');

function views() {
  const scene = new THREE.Scene();
  return { scene, v: createEntityViews(scene) };
}

describe('mine warning cues through createEntityViews (issue #276)', () => {
  it('draws NEITHER cue for an ordinary armed mine', () => {
    const { scene, v } = views();
    v.sync(world([mine()]), world([mine()]), 0);
    expect(ring(scene)).toBeUndefined();
    expect(fill(scene)).toBeUndefined();
    v.dispose();
  });

  it('adds the fuse ring only once the fuse enters its final window', () => {
    const { scene, v } = views();
    const before = world([mine({ timer: FUSE_WARNING_SECONDS * 2 })]);
    v.sync(before, before, 0);
    expect(ring(scene)).toBeUndefined();

    const during = world([mine({ timer: FUSE_WARNING_SECONDS * 0.5 })]);
    v.sync(during, during, 0);
    expect(ring(scene)).toBeDefined();
    v.dispose();
  });

  it('adds the proximity fill on the tick the mine is tripped, not later', () => {
    // The acceptance criterion "the first proximity-trigger frame aligns with
    // mine-triggered". The mesh must exist on the FIRST tripped sync.
    const { scene, v } = views();
    const w = world([mine({ proximityDelayLeft: MINE_PROXIMITY_DELAY_TICKS })]);
    v.sync(w, w, 0);
    expect(fill(scene)).toBeDefined();
    v.dispose();
  });

  it('HOLDS its frame when the same world is synced twice -- pause and single-step', () => {
    // The criterion "pause/resume and single-step do not desynchronize effects". Both cues
    // are projections of mine state, so re-syncing an unchanged world must be a no-op. This
    // is what fails if anything in the path ever starts reading a wall clock or a frame
    // counter: those advance between the two calls below while the world does not.
    const { scene, v } = views();
    const w = world([mine({ timer: FUSE_WARNING_SECONDS * 0.4, proximityDelayLeft: 12 })]);
    v.sync(w, w, 0);
    const r1 = ring(scene) as THREE.Mesh;
    const f1 = fill(scene) as THREE.Mesh;
    const snapshot = {
      visible: r1.visible,
      ringGeo: r1.geometry.uuid,
      fillScale: f1.scale.x,
    };

    v.sync(w, w, 0);
    const r2 = ring(scene) as THREE.Mesh;
    const f2 = fill(scene) as THREE.Mesh;
    expect(r2.visible).toBe(snapshot.visible);
    expect(r2.geometry.uuid).toBe(snapshot.ringGeo); // not even rebuilt
    expect(f2.scale.x).toBe(snapshot.fillScale);
    v.dispose();
  });

  it('the illumination CLOSES IN as the countdown runs, ending as a full disc', () => {
    // Geometry-driven, not scale-driven: the annulus keeps the mine's radius as its outer
    // edge and its inner edge shrinks. An earlier revision grew a scaled disc from the
    // centre, so asserting `scale.x` here would pass against the design the owner replaced.
    const { scene, v } = views();
    const inners: number[] = [];
    for (const left of [MINE_PROXIMITY_DELAY_TICKS, 20, 10, 1]) {
      const w = world([mine({ proximityDelayLeft: left })]);
      v.sync(w, w, 0);
      const mesh = fill(scene) as THREE.Mesh;
      const p = mesh.geometry.getAttribute('position');
      let min = Infinity;
      for (let i = 0; i < p.count; i++) min = Math.min(min, Math.hypot(p.getX(i), p.getY(i)));
      inners.push(min);
    }
    for (let i = 1; i < inners.length; i++) expect(inners[i]).toBeLessThan(inners[i - 1]);
    expect(inners[inners.length - 1]).toBeCloseTo(0, 6); // whole mine lit on the last frame
    v.dispose();
  });

  it('removes BOTH cues when the mine detonates, so nothing outlives the blast', () => {
    // A detonated mine is skipped by syncMines entirely, so this also covers the cues being
    // torn down with the body rather than lingering on the felt.
    const { scene, v } = views();
    const live = world([mine({ timer: FUSE_WARNING_SECONDS * 0.2, proximityDelayLeft: 2 })]);
    v.sync(live, live, 0);
    expect(ring(scene)).toBeDefined();
    expect(fill(scene)).toBeDefined();

    const gone = world([mine({ timer: 0, proximityDelayLeft: 1, detonated: true })]);
    v.sync(gone, gone, 0);
    expect(ring(scene)).toBeUndefined();
    expect(fill(scene)).toBeUndefined();
    v.dispose();
  });

  it('drops the ring again if the mine somehow leaves its warning window', () => {
    // Defensive, and cheap: the teardown branch is the one that is never exercised in
    // ordinary play (a fuse only runs down), so nothing else would catch it rotting.
    const { scene, v } = views();
    const during = world([mine({ timer: FUSE_WARNING_SECONDS * 0.5 })]);
    v.sync(during, during, 0);
    expect(ring(scene)).toBeDefined();

    const after = world([mine({ timer: FUSE_WARNING_SECONDS * 3 })]);
    v.sync(after, after, 0);
    expect(ring(scene)).toBeUndefined();
    v.dispose();
  });

  it('dispose() leaves no warning meshes behind', () => {
    const { scene, v } = views();
    const w = world([mine({ timer: FUSE_WARNING_SECONDS * 0.3, proximityDelayLeft: 5 })]);
    v.sync(w, w, 0);
    v.dispose();
    expect(ring(scene)).toBeUndefined();
    expect(fill(scene)).toBeUndefined();
  });
});
