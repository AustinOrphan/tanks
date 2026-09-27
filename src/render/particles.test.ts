// No `@vitest-environment` pragma: Three computes meshes, materials and vector
// maths on the CPU, so a Scene needs no GL context. That is the same property
// framing.test.ts relies on, and it is why this file can exist at all while
// scene.ts and renderer.ts still cannot be tested.
import { readFileSync } from 'node:fs';

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import type { SimEvent } from '../sim/events';
import { createParticleSystem } from './particles';

const EVENT_Y = 0.5;

/** Particles are pooled, so "active" is the visible subset, not every child. */
function activeMeshes(scene: THREE.Scene): THREE.Mesh[] {
  return scene.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh && c.visible);
}

function setup(rng?: () => number): { scene: THREE.Scene; ps: ReturnType<typeof createParticleSystem> } {
  const scene = new THREE.Scene();
  return { scene, ps: rng ? createParticleSystem(scene, rng) : createParticleSystem(scene) };
}

/**
 * A tiny deterministic generator for the injected-rng tests below -- NOT a spy on
 * `Math.random` (the negative control needs that to be the real, unmocked thing), and
 * not mulberry32 either: the specific algorithm is irrelevant, only that re-creating it
 * from the same seed replays the exact same sequence.
 */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s / 0xffffffff;
  };
}

/** A snapshot of every active particle's observable state, order-independent so pool
 * hand-out order (which can vary run to run for reasons unrelated to the rng seam)
 * cannot make two otherwise-identical runs look different. */
function snapshotParticles(scene: THREE.Scene): Array<[number, number, number, number, number]> {
  return activeMeshes(scene)
    .map((m): [number, number, number, number, number] => [
      m.position.x,
      m.position.y,
      m.position.z,
      m.scale.x,
      (m as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.opacity,
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
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
    // docs/agent/testing-and-review.md singles this out: particles draw bursts at exactly
    // ev.pos, so a wrong position is a visible defect no presence check catches. The
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

  it('draws no burst for a respawn, discriminated against another event in the same batch', () => {
    // The identity spawn ring (entities.ts, #199) is the single source of truth for a
    // respawn's look now -- the old cyan burst here was ad-hoc and is removed (#201).
    // Not presence-only (docs/agent/testing-and-review.md): a `fire` in the same spawn()
    // call proves the absence isn't an accident of the fixture -- the fire burst still
    // draws while the respawn at a distinct position draws nothing.
    const { scene, ps } = setup();
    ps.spawn([
      { type: 'fire', ownerId: 9, bulletType: 'normal', pos: { x: -8, y: 4 }, angle: 0 },
      { type: 'respawn', tankId: 1, controlledBy: 0, pos: { x: 6, y: -3 } },
    ]);
    const atRespawnPos = activeMeshes(scene).filter((m) => m.position.x === 6 && m.position.z === -3);
    expect(atRespawnPos.length).toBe(0);
    expect(activeMeshes(scene).length).toBe(5); // only the fire burst
  });
});

describe('particles: which events burst, and how much', () => {
  // Population: the five kinds that burst, with the count each draws. The whole union is swept
  // below -- this list is only the ones whose SIZE is worth pinning.
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

  /**
   * One of every `SimEvent` kind, keyed by its own `type` (issue #929).
   *
   * SUPERSEDES 'the five non-visual events spawn nothing', which named five of them by hand and
   * had fallen three behind the union: `mine-triggered`, `mine-fuse-warning` and `fire-blocked`
   * were never swept here. So had the comment in particles.ts, and so had the "all 11 SimEvent
   * kinds" note above -- three hand-kept lists drifting from the same union, which is the case
   * for deriving rather than listing.
   *
   * `Record<SimEvent['type'], SimEvent>` is what makes this hold: a new event kind that is not
   * given a fixture here does not compile, so it cannot join the sweep by omission.
   */
  const ONE_OF_EACH: Record<SimEvent['type'], SimEvent> = {
    fire: { type: 'fire', ownerId: 1, bulletType: 'normal', pos: { x: 0, y: 0 }, angle: 0 },
    ricochet: { type: 'ricochet', ownerId: 1, pos: { x: 0, y: 0 }, bounceIndex: 0 },
    explosion: { type: 'explosion', pos: { x: 0, y: 0 } },
    'wall-destroyed': { type: 'wall-destroyed', wallId: 1, ownerId: 1, pos: { x: 0, y: 0 } },
    'mine-detonate': { type: 'mine-detonate', mineId: 1, ownerId: 1, pos: { x: 0, y: 0 } },
    'mine-dropped': { type: 'mine-dropped', mineId: 1, ownerId: 1, pos: { x: 0, y: 0 } },
    'mine-armed': { type: 'mine-armed', mineId: 1, ownerId: 1, pos: { x: 0, y: 0 } },
    'mine-triggered': { type: 'mine-triggered', mineId: 1, ownerId: 1, pos: { x: 0, y: 0 } },
    'mine-fuse-warning': { type: 'mine-fuse-warning', mineId: 1, ownerId: 1, pos: { x: 0, y: 0 } },
    'tank-destroyed': { type: 'tank-destroyed', tankId: 1, kind: 'brown', by: { source: 'shell', ownerId: 9 }, pos: { x: 0, y: 0 } },
    'fire-blocked': { type: 'fire-blocked', ownerId: 1, reason: 'shell-cap' },
    respawn: { type: 'respawn', tankId: 1, controlledBy: 0, pos: { x: 0, y: 0 } },
    win: { type: 'win' },
    lose: { type: 'lose' },
  };

  /** The kinds this layer draws for. Everything else in the union must draw nothing. */
  const DRAWS = new Set<SimEvent['type']>(['fire', 'ricochet', 'explosion', 'wall-destroyed', 'mine-detonate']);

  it('draws for exactly the events it means to, swept across the whole SimEvent union', () => {
    // BOTH DIRECTIONS in one pass. A kind that quietly starts drawing is as much a defect as one
    // that stops: `tank-destroyed` is in the union precisely because handling it once doubled
    // every kill into a 48-particle burst, and nothing but a sweep like this would have said so.
    const drew: string[] = [];
    for (const type of Object.keys(ONE_OF_EACH) as SimEvent['type'][]) {
      const { scene, ps } = setup();
      ps.spawn([ONE_OF_EACH[type]]);
      if (activeMeshes(scene).length > 0) drew.push(type);
    }
    expect(drew.sort()).toEqual([...DRAWS].sort());
  });

  it('sweeps every kind the union declares, so the fixture map cannot fall behind it', () => {
    // The fixture map is exhaustive by its TYPE; this is the count that makes a silent
    // truncation visible too, and the number to update deliberately when the union grows.
    expect(Object.keys(ONE_OF_EACH).length, 'a SimEvent kind was added or removed').toBe(14);
    for (const [type, ev] of Object.entries(ONE_OF_EACH)) {
      expect(ev.type, `the fixture keyed ${type} carries the wrong type`).toBe(type);
    }
  });

  it('closes its switch with the exhaustiveness guard, not a default (issue #929)', () => {
    // STRUCTURAL, and it says so: the real guarantee is a COMPILE error, which no Vitest run can
    // observe -- the same reason `capture.test.ts` reads its own source. Measured rather than
    // assumed: adding a `shield-broken` kind to `SimEvent` errors in audio/director.ts,
    // game/haptics.ts and now render/particles.ts; before this change the same probe produced
    // ZERO errors from particles.ts, which is the asymmetry issue #929 names.
    const src = readFileSync(new URL('./particles.ts', import.meta.url), 'utf8');
    expect(src, 'the visual channel no longer fails the build on a new event kind')
      .toMatch(/const _exhaustive: never = ev;/);
    // And the cases are NAMED rather than swept up by a default, or the guard is unreachable and
    // a new kind silently draws nothing again.
    expect(src, 'a bare default returned, so a new event kind falls through it')
      .not.toMatch(/^\s*default:\s*$\n\s*break;/m);
    for (const type of ['mine-triggered', 'mine-fuse-warning', 'fire-blocked']) {
      expect(src, `${type} is no longer named in the switch`).toMatch(new RegExp(`case '${type}':`));
    }
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

describe('particles: injected rng seam', () => {
  // The gallery's moment-scene.ts needs two independent renders of the same moment to
  // come back byte-identical; burst()'s direction/speed/lifetime draws are the only
  // source of cross-render variance in this file (see particles.ts's own doc comment
  // on createParticleSystem's second parameter).
  const run = (rng?: () => number) => {
    const { scene, ps } = setup(rng);
    ps.spawn([
      { type: 'explosion', pos: { x: 2, y: -3 } },
      { type: 'mine-detonate', mineId: 1, ownerId: 1, pos: { x: 5, y: 1 } },
    ]);
    ps.update(0.1);
    ps.update(0.05);
    return snapshotParticles(scene);
  };

  it('an injected deterministic rng makes two identical spawn+update sequences produce identical particle states', () => {
    // Mutation that reds this (verified live, then reverted -- see this task's report):
    // reverting burst()'s four `rng()` calls back to `Math.random()` breaks this, since
    // the injected generator would then be constructed but never consulted.
    const a = run(seededRng(12345));
    const b = run(seededRng(12345));
    expect(a).toEqual(b);
  });

  it('NEGATIVE CONTROL: with the default Math.random, the same sequences differ', () => {
    // Proves the positive test above is not vacuously true (e.g. from a snapshot bug
    // that always compares equal). Would fail if burst() stopped drawing per-particle
    // randomness at all (e.g. a fixed direction/speed/life) -- unmocked Math.random,
    // no rng argument passed, matching every shipped game call site's default.
    const a = run();
    const b = run();
    expect(a).not.toEqual(b);
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

describe('particles under reduced motion (issue #651)', () => {
  it('draws ONE particle, not the whole coincident burst', () => {
    // The material is additively blended, so N particles at the same point and opacity 1 sum
    // past every channel and clip. Measured through the gallery on the kill moment: the
    // 24-particle reduced burst rendered as a small WHITE core over an unchanged background
    // -- orange pixels flat at the pre-explosion baseline of 5180 while full motion reached
    // 18689 -- so it was a white FLASH rather than a calmer explosion. One particle keeps the
    // burst's own colour.
    const { scene, ps } = setup();
    ps.setReducedMotion(true);
    ps.spawn([{ type: 'explosion', pos: { x: 3, y: 7 } }]);
    expect(activeMeshes(scene).length).toBe(1);
  });

  it('draws ONE and never zero, because some events have no other visual cue', () => {
    // The other half, and the reason this is not "spawn nothing": an event carried by audio
    // and haptics alone is what the accessibility direction rules out, and `ricochet` has no
    // second cue at all -- no ring, no disappearing wall, nothing but these particles.
    const { scene, ps } = setup();
    ps.setReducedMotion(true);
    for (const ev of [
      { type: 'ricochet', pos: { x: 1, y: 1 } },
      { type: 'fire', pos: { x: 2, y: 2 } },
      { type: 'wall-destroyed', pos: { x: 3, y: 3 } },
    ] as SimEvent[]) {
      const before = activeMeshes(scene).length;
      ps.spawn([ev]);
      expect(activeMeshes(scene).length, `${ev.type} drew nothing`).toBe(before + 1);
    }
  });

  it('keeps the burst COLOUR, which is what the coincident stack was destroying', () => {
    // An explosion is orange and a fire flash is gold. Stacked additively they were both
    // white; one particle each keeps them distinguishable.
    const { scene, ps } = setup();
    ps.setReducedMotion(true);
    ps.spawn([{ type: 'explosion', pos: { x: 0, y: 0 } }]);
    const boom = activeMeshes(scene)[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    expect(boom.material.color.getHex()).toBe(0xff6a2b);
    expect(boom.material.opacity).toBe(1);
  });

  it('holds every particle at the event position instead of flying it outward', () => {
    // Sparks, explosions and debris ignored the preference entirely -- `grep reducedMotion`
    // returned nothing in this file. Both the velocity integration and the gravity that acts
    // on it are what stop; the burst stays where the event was.
    const { scene, ps } = setup();
    ps.setReducedMotion(true);
    ps.spawn([{ type: 'explosion', pos: { x: 3, y: 7 } }]);
    for (let i = 0; i < 10; i++) ps.update(1 / 60);
    expect(activeMeshes(scene).length, 'the one particle must still be alive').toBe(1);
    for (const m of activeMeshes(scene)) {
      expect(m.position.x).toBe(3);
      expect(m.position.y).toBe(EVENT_Y);
      expect(m.position.z).toBe(7);
    }
  });

  it('negative control: at full motion the same burst has moved by then', () => {
    // Without this, "held at the event position" would pass on a system that never moved
    // anything, and the preference would be measuring nothing.
    const { scene, ps } = setup();
    ps.spawn([{ type: 'explosion', pos: { x: 3, y: 7 } }]);
    for (let i = 0; i < 10; i++) ps.update(1 / 60);
    const moved = activeMeshes(scene).filter(
      (m) => m.position.x !== 3 || m.position.y !== EVENT_Y || m.position.z !== 7,
    );
    expect(moved.length, 'no particle moved at full motion').toBeGreaterThan(0);
  });

  it('keeps the fade and the lifetime, measured on the one particle it draws', () => {
    // The cross-system count comparison this replaced stopped meaning anything once the
    // counts differed by design (1 against 24). So the claim is measured directly on the
    // particle: it fades monotonically, and it expires inside the band production declares
    // for an explosion -- `life * (0.7 + rng() * 0.6)` over `life = 0.6`, so 0.42s to 0.78s,
    // which is 26 to 47 frames at 1/60. A policy that shortened or stretched the effect
    // lands outside that band.
    const { scene, ps } = setup(seededRng(7));
    ps.setReducedMotion(true);
    ps.spawn([{ type: 'explosion', pos: { x: 0, y: 0 } }]);
    const mesh = activeMeshes(scene)[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    let frames = 0;
    let last = mesh.material.opacity;
    while (activeMeshes(scene).length > 0 && frames < 200) {
      ps.update(1 / 60);
      frames += 1;
      if (activeMeshes(scene).length === 0) break;
      expect(mesh.material.opacity, `frame ${frames}: the fade must keep going`).toBeLessThan(last);
      last = mesh.material.opacity;
    }
    expect(frames, 'expired outside the declared lifetime band').toBeGreaterThanOrEqual(26);
    expect(frames, 'expired outside the declared lifetime band').toBeLessThanOrEqual(47);
    expect(activeMeshes(scene).length, 'it must be recycled, not left on screen').toBe(0);
  });

  it('resumes at full motion, rather than staying calm for the life of the page', () => {
    const { scene, ps } = setup();
    ps.setReducedMotion(true);
    ps.spawn([{ type: 'explosion', pos: { x: 3, y: 7 } }]);
    ps.update(1 / 60);
    ps.setReducedMotion(false);
    for (let i = 0; i < 10; i++) ps.update(1 / 60);
    const moved = activeMeshes(scene).filter((m) => m.position.x !== 3 || m.position.z !== 7);
    expect(moved.length).toBeGreaterThan(0);
  });
});
