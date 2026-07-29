// @vitest-environment jsdom
// The overlay is dev-only, but "dev-only" is not "untested": a broken overlay sends you
// chasing a sim bug that is not there. Three.js builds its scene graph on the CPU, so
// this is all reachable headlessly.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createMineDebug, MINE_KILL_RADIUS } from './minedebug';
import { createWorld, type World } from '../sim/world';
import { MINE_PROXIMITY_RADIUS, MINE_BLAST_RADIUS, TANK_RADIUS, MINE_TIMER } from '../sim/constants';

function worldWithMines(...mines: { id: number; x: number; y: number; timer?: number; detonated?: boolean }[]): World {
  const w = createWorld({ walls: [], tanks: [], spawns: [], lives: 3 });
  for (const m of mines) {
    w.mines.push({
      id: m.id, ownerId: 1, pos: { x: m.x, y: m.y },
      timer: m.timer ?? MINE_TIMER, armed: false, detonated: m.detonated ?? false,
    });
  }
  return w;
}
const rings = (scene: THREE.Scene): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Mesh).geometry instanceof THREE.RingGeometry) out.push(o as THREE.Mesh);
  });
  return out;
};
const sprites = (scene: THREE.Scene): THREE.Sprite[] => {
  const out: THREE.Sprite[] = [];
  scene.traverse((o) => { if (o instanceof THREE.Sprite) out.push(o); });
  return out;
};

describe('mine debug overlay', () => {
  it('draws nothing at all when both flags are off', () => {
    // The default path for every real player. If this regresses, the overlay ships.
    const scene = new THREE.Scene();
    const d = createMineDebug(scene, { reach: false, timer: false });
    d.sync(worldWithMines({ id: 1, x: 0, y: 0 }, { id: 2, x: 4, y: 4 }));
    expect(rings(scene)).toHaveLength(0);
    expect(sprites(scene)).toHaveLength(0);
    // Nothing is ADDED either, not merely nothing visible. Counting rings alone let the
    // disabled short-circuit be deleted and still pass: with both flags off the per-mine
    // group comes out empty, so it drew nothing while still allocating and attaching a
    // Group for every mine, every frame.
    expect(scene.children).toHaveLength(0);
    d.dispose();
  });

  it('rings BOTH radii, at their true sim values', () => {
    const scene = new THREE.Scene();
    const d = createMineDebug(scene, { reach: true, timer: false });
    d.sync(worldWithMines({ id: 1, x: 3, y: -2 }));

    const rs = rings(scene);
    expect(rs).toHaveLength(2); // trigger AND kill, not one standing in for both
    const outer = rs.map((r) => (r.geometry as THREE.RingGeometry).parameters.outerRadius).sort((a, b) => a - b);
    expect(outer[0]).toBeCloseTo(MINE_PROXIMITY_RADIUS, 9);
    expect(outer[1]).toBeCloseTo(MINE_BLAST_RADIUS + TANK_RADIUS, 9);
    // The two must be genuinely different, or the test passes on an overlay that draws
    // the same circle twice -- which is exactly the confusion the rings exist to dispel.
    expect(outer[0]).toBeLessThan(outer[1]);
    expect(MINE_KILL_RADIUS).toBeCloseTo(outer[1], 9);
    d.dispose();
  });

  it('lies flat on the ground at the mine, mapping sim y to three z', () => {
    const scene = new THREE.Scene();
    const d = createMineDebug(scene, { reach: true, timer: false });
    d.sync(worldWithMines({ id: 1, x: 3, y: -2 }));
    const group = rings(scene)[0].parent!;
    expect(group.position.x).toBeCloseTo(3, 9);
    expect(group.position.z).toBeCloseTo(-2, 9); // sim y -> three z
    expect(group.position.y).toBeGreaterThan(0); // lifted off the felt, or it z-fights
    expect(group.position.y).toBeLessThan(0.2);
    expect(rings(scene)[0].rotation.x).toBeCloseTo(-Math.PI / 2, 9); // flat, not upright
    d.dispose();
  });

  it('gives every live mine its own rings, and takes them away when it goes', () => {
    const scene = new THREE.Scene();
    const d = createMineDebug(scene, { reach: true, timer: false });
    d.sync(worldWithMines({ id: 1, x: 0, y: 0 }, { id: 2, x: 5, y: 5 }));
    expect(rings(scene)).toHaveLength(4); // 2 per mine

    d.sync(worldWithMines({ id: 2, x: 5, y: 5 }));
    expect(rings(scene)).toHaveLength(2);

    d.sync(worldWithMines());
    expect(rings(scene)).toHaveLength(0);
    d.dispose();
  });

  it('drops the rings of a mine that has detonated', () => {
    // It is off the board the moment it goes off; leaving its rings up draws a threat
    // that no longer exists.
    const scene = new THREE.Scene();
    const d = createMineDebug(scene, { reach: true, timer: false });
    d.sync(worldWithMines({ id: 1, x: 0, y: 0 }));
    expect(rings(scene)).toHaveLength(2);
    d.sync(worldWithMines({ id: 1, x: 0, y: 0, detonated: true }));
    expect(rings(scene)).toHaveLength(0);
    d.dispose();
  });

  it('shows the fuse only under its own flag, independent of the rings', () => {
    const scene = new THREE.Scene();
    const d = createMineDebug(scene, { reach: false, timer: true });
    d.sync(worldWithMines({ id: 1, x: 0, y: 0, timer: 1.5 }));
    expect(sprites(scene)).toHaveLength(1);
    expect(rings(scene)).toHaveLength(0); // timer must not drag the rings in with it
    expect(sprites(scene)[0].position.y).toBeGreaterThan(0.2); // above the mine, not inside it
    d.dispose();
  });

  it('clears everything on dispose', () => {
    const scene = new THREE.Scene();
    const d = createMineDebug(scene, { reach: true, timer: true });
    d.sync(worldWithMines({ id: 1, x: 0, y: 0 }, { id: 2, x: 4, y: 0 }));
    expect(rings(scene).length + sprites(scene).length).toBeGreaterThan(0);
    d.dispose();
    expect(rings(scene)).toHaveLength(0);
    expect(sprites(scene)).toHaveLength(0);
  });
});
