// No `@vitest-environment` pragma: Three computes meshes, materials and vector
// maths on the CPU, so a Scene needs no GL context. That is the same property
// framing.test.ts relies on, and it is why this file can exist at all while
// scene.ts and renderer.ts still cannot be tested.
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import type { SimEvent } from '../sim/events';
import { createParticleSystem } from './particles';

const EVENT_Y = 0.5;

/** Particles are pooled, so "active" is the visible subset, not every child. */
function activeMeshes(scene: THREE.Scene): THREE.Mesh[] {
  return scene.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh && c.visible);
}

function setup(): { scene: THREE.Scene; ps: ReturnType<typeof createParticleSystem> } {
  const scene = new THREE.Scene();
  return { scene, ps: createParticleSystem(scene) };
}

/** burst() draws four randoms per particle: theta, up, speed, life. */
function mockRandomCycle(values: number[]): void {
  let i = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    const v = values[i % values.length];
    i += 1;
    return v;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('particles: where a burst is drawn', () => {
  it('draws every particle at exactly the event position, sim y mapping to three z', () => {
    // CLAUDE.md singles this out: particles draw bursts at exactly ev.pos, so a
    // wrong position is a visible defect no presence check catches. The
    // coordinates are deliberately asymmetric -- (3, 7), not (3, 3) -- so that
    // swapping x and z is detectable at all.
    const { scene, ps } = setup();
    ps.spawn([{ type: 'explosion', pos: { x: 3, y: 7 } }]);
    const meshes = activeMeshes(scene);
    expect(meshes.length).toBe(24);
    for (const m of meshes) {
      expect(m.position.x).toBe(3);
      expect(m.position.y).toBe(EVENT_Y);
      expect(m.position.z).toBe(7);
    }
  });

  it('draws each burst at its own event position, not all at the last one', () => {
    const { scene, ps } = setup();
    ps.spawn([
      { type: 'fire', ownerId: 1, bulletType: 'normal', pos: { x: -5, y: 2 }, angle: 0 },
      { type: 'ricochet', ownerId: 1, pos: { x: 11, y: -4 }, bounceIndex: 1 },
    ]);
    const xs = new Set(activeMeshes(scene).map((m) => m.position.x));
    expect(xs).toEqual(new Set([-5, 11]));
  });
});

describe('particles: which events burst, and how much', () => {
  // Population: all 10 SimEvent kinds. Five burst, five deliberately do not.
  const bursting: Array<[SimEvent, number]> = [
    [{ type: 'fire', ownerId: 1, bulletType: 'normal', pos: { x: 0, y: 0 }, angle: 0 }, 5],
    [{ type: 'ricochet', ownerId: 1, pos: { x: 0, y: 0 }, bounceIndex: 0 }, 6],
    [{ type: 'explosion', pos: { x: 0, y: 0 } }, 24],
    [{ type: 'wall-destroyed', wallId: 1, ownerId: 1, pos: { x: 0, y: 0 } }, 16],
    [{ type: 'mine-detonate', mineId: 1, ownerId: 1, pos: { x: 0, y: 0 } }, 40],
  ];

  for (const [ev, count] of bursting) {
    it(`${ev.type} spawns ${count} particles`, () => {
      const { scene, ps } = setup();
      ps.spawn([ev]);
      expect(activeMeshes(scene).length).toBe(count);
    });
  }

  it('tank-destroyed spawns nothing, because the kill sites already push explosion', () => {
    // Both kill sites emit `explosion` at the same position on the same tick.
    // Handling tank-destroyed too doubled every kill into a 48-particle burst.
    const { scene, ps } = setup();
    ps.spawn([{ type: 'tank-destroyed', tankId: 1, kind: 'brown', by: { source: 'shell', ownerId: 9 }, pos: { x: 0, y: 0 } }]);
    expect(activeMeshes(scene).length).toBe(0);
  });

  it('the four non-visual events spawn nothing', () => {
    const { scene, ps } = setup();
    ps.spawn([
      { type: 'mine-dropped', mineId: 1, ownerId: 1, pos: { x: 0, y: 0 } },
      { type: 'mine-armed', mineId: 1, ownerId: 1, pos: { x: 0, y: 0 } },
      { type: 'win' },
      { type: 'lose' },
    ]);
    expect(activeMeshes(scene).length).toBe(0);
  });
});

describe('particles: the pool', () => {
  it('recycles dead particles instead of allocating new scene children', () => {
    const { scene, ps } = setup();
    ps.spawn([{ type: 'explosion', pos: { x: 0, y: 0 } }]);
    const allocatedFirst = scene.children.length;
    expect(allocatedFirst).toBe(24);

    // Longest possible life for this burst is 0.6 * 1.3; run well past it.
    ps.update(2);
    expect(activeMeshes(scene).length).toBe(0);

    ps.spawn([{ type: 'explosion', pos: { x: 0, y: 0 } }]);
    expect(activeMeshes(scene).length).toBe(24);
    // The whole point of the pool: the second burst reused the first's meshes.
    expect(scene.children.length).toBe(allocatedFirst);
  });

  it('stops allocating at the cap instead of growing without bound', () => {
    const { scene, ps } = setup();
    // 40 per mine-detonate; 20 of them is 800, well past the 500 cap.
    const burst: SimEvent = { type: 'mine-detonate', mineId: 1, ownerId: 1, pos: { x: 0, y: 0 } };
    ps.spawn(Array.from({ length: 20 }, () => burst));
    expect(activeMeshes(scene).length).toBe(500);
    expect(scene.children.length).toBe(500);
  });
});

describe('particles: update', () => {
  it('fades a particle in proportion to the life it has left', () => {
    mockRandomCycle([0.5]); // life = 0.6 * (0.7 + 0.6*0.5) = 0.6 exactly
    const { scene, ps } = setup();
    ps.spawn([{ type: 'explosion', pos: { x: 0, y: 0 } }]);
    ps.update(0.3); // half the life gone
    const m = activeMeshes(scene)[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    expect(m.material.opacity).toBeCloseTo(0.5, 6);
  });

  it('never lets a particle sink below the ground', () => {
    // Reachable, not hypothetical: sampling the shipped constants at 60Hz,
    // 46,696 of 1,000,000 particles cross y = 0.02 before expiring (population:
    // 200k trials each of the 5 bursting kinds). It happens for explosion,
    // wall-destroyed and mine-detonate; fire and ricochet never fall that far
    // (min y 0.427 and 0.347). This fixture is the reachable case: a low launch
    // angle with a long life.
    mockRandomCycle([0, 0, 0, 1]); // theta, up, speed, life
    const { scene, ps } = setup();
    ps.spawn([{ type: 'explosion', pos: { x: 0, y: 0 } }]);
    let sank = false;
    for (let i = 0; i < 40; i++) {
      ps.update(1 / 60);
      for (const m of activeMeshes(scene)) {
        if (m.position.y < 0.02) sank = true;
      }
    }
    expect(sank).toBe(false);
    // and the fixture really did drive them to the floor, so the assertion above
    // is not vacuously true
    const settled = activeMeshes(scene);
    expect(settled.length).toBeGreaterThan(0);
    expect(Math.min(...settled.map((m) => m.position.y))).toBeCloseTo(0.02, 6);
  });

  it('recycles a particle the moment its life runs out', () => {
    mockRandomCycle([0.5]); // life exactly 0.6
    const { scene, ps } = setup();
    ps.spawn([{ type: 'explosion', pos: { x: 0, y: 0 } }]);
    ps.update(0.59);
    expect(activeMeshes(scene).length).toBe(24);
    ps.update(0.02);
    expect(activeMeshes(scene).length).toBe(0);
  });
});

describe('particles: dispose', () => {
  it('removes every mesh it added from the scene, active and pooled alike', () => {
    const { scene, ps } = setup();
    ps.spawn([{ type: 'explosion', pos: { x: 0, y: 0 } }]);
    ps.update(2); // retire that burst into the pool
    ps.spawn([{ type: 'fire', ownerId: 1, bulletType: 'normal', pos: { x: 0, y: 0 }, angle: 0 }]);
    expect(scene.children.length).toBeGreaterThan(0);

    ps.dispose();
    // Both lists have to be drained: emptying only `active` leaves the pooled
    // meshes parented to the scene for the life of the page.
    expect(scene.children.length).toBe(0);
  });
});
