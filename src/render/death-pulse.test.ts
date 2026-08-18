// Same reasoning as particles.test.ts: Three builds meshes, materials and vector
// maths on the CPU, so a Scene needs no GL context and this is jsdom-testable.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createWorld, type World } from '../sim/world';
import type { Tank, Spawn } from '../sim/types';
import type { SimEvent } from '../sim/events';
import { createDeathPulseSystem } from './death-pulse';
import { IDENTITY_RING_COLORS, TEAM_COLORS } from './entities';
import { makeSpawnRing } from './spawn-anim';

function makeTank(
  id: number,
  kind: Tank['kind'],
  x: number,
  y: number,
  extra: Partial<Tank> = {},
): Tank {
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
    ...extra,
  };
}

/** tank-destroyed events carry the exact fields death-pulse.ts reads, `by` filled in
 * with an arbitrary-but-valid value since nothing under test consumes it. */
function destroyedEvent(
  tankId: number,
  kind: Tank['kind'],
  x: number,
  y: number,
): SimEvent {
  return { type: 'tank-destroyed', tankId, kind, by: { source: 'shell', ownerId: 0 }, pos: { x, y } };
}

/** Death rings are pooled, so "active" means visible, exactly as particles.test.ts's activeMeshes. */
function deathRings(scene: THREE.Scene): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] {
  return scene.children.filter(
    (c): c is THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> =>
      (c as THREE.Mesh).isMesh && c.visible && c.name === 'death-ring',
  );
}

function setup(): { scene: THREE.Scene; dp: ReturnType<typeof createDeathPulseSystem> } {
  const scene = new THREE.Scene();
  return { scene, dp: createDeathPulseSystem(scene) };
}

describe('death pulse: where and what colour a ring spawns', () => {
  it("spawns exactly one death-ring at the event's position, coloured by identity slot", () => {
    // Mutation this catches: reading the tank's live `pos` off `world` (or a
    // hardcoded identityColor(0)) instead of the event's own `pos` -- the dead tank's
    // world position (99,99) is deliberately different from the event's death
    // position (5,8), and controlledBy 1 (not 0).
    const { scene, dp } = setup();
    const deadTank = makeTank(1, 'player', 99, 99, { controlledBy: 1, alive: false });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 5, y: 8 }, angle: 0 }];
    const world = createWorld({ walls: [], tanks: [deadTank], spawns, lives: 3 });
    const events = [destroyedEvent(1, 'player', 5, 8)];

    dp.spawn(events, world, { enemyEnabled: false });

    const rings = deathRings(scene);
    expect(rings.length).toBe(1);
    expect(rings[0].position.x).toBe(5);
    expect(rings[0].position.z).toBe(8);
    expect(rings[0].material.color.getHex()).toBe(IDENTITY_RING_COLORS[1]);
  });

  it('colours a teams-mode death by TEAM, not by identity slot', () => {
    // Mutation this catches: resolveOwnerColor's dispatch reading identityColor
    // unconditionally instead of switching on world.mode === 'teams'.
    const { scene, dp } = setup();
    const deadTank = makeTank(2, 'player', 4, 6, { controlledBy: 1, team: 1, alive: false });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 4, y: 6 }, angle: 0 }];
    const world = createWorld({ walls: [], tanks: [deadTank], spawns, lives: 3, mode: 'teams' });
    const events = [destroyedEvent(2, 'player', 4, 6)];

    dp.spawn(events, world, { enemyEnabled: false });

    const rings = deathRings(scene);
    expect(rings.length).toBe(1);
    expect(rings[0].material.color.getHex()).toBe(TEAM_COLORS[1]);
    expect(rings[0].material.color.getHex()).not.toBe(IDENTITY_RING_COLORS[1]);
  });

  it("names its mesh death-ring, distinct from spawn-anim's own spawn-ring", () => {
    // Mutation this catches: reusing makeSpawnRing's mesh.name unchanged instead of
    // renaming it, which would make a same-frame respawn ring indistinguishable.
    const { scene, dp } = setup();
    const unrelatedSpawnRing = makeSpawnRing(0x123456);
    scene.add(unrelatedSpawnRing);
    const deadTank = makeTank(1, 'player', 1, 1, { controlledBy: 0, alive: false });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 1, y: 1 }, angle: 0 }];
    const world = createWorld({ walls: [], tanks: [deadTank], spawns, lives: 3 });
    const events = [destroyedEvent(1, 'player', 1, 1)];

    dp.spawn(events, world, { enemyEnabled: false });

    const names = scene.children.filter((c) => (c as THREE.Mesh).isMesh && c.visible).map((c) => c.name);
    expect(names).toContain('death-ring');
    expect(names).toContain('spawn-ring'); // the unrelated ring is untouched
    expect(deathRings(scene).length).toBe(1);
    expect(deathRings(scene)[0].name).not.toBe('spawn-ring');
  });

  it('skips an event whose tankId is not found in world.tanks, without throwing', () => {
    // Mutation this catches: dropping the `if (!tank) continue` guard and calling
    // resolveOwnerColor(world, undefined), which would throw and drop every
    // subsequent event in the same frame's list too.
    const { scene, dp } = setup();
    const world = createWorld({ walls: [], tanks: [], spawns: [{ kind: 'player', pos: { x: 0, y: 0 }, angle: 0 }], lives: 3 });
    const events = [destroyedEvent(999, 'player', 0, 0)];

    expect(() => dp.spawn(events, world, { enemyEnabled: false })).not.toThrow();
    expect(deathRings(scene).length).toBe(0);
  });
});

describe('death pulse: enemy gating', () => {
  function enemyDeathWorldAndEvents(): { world: World; events: SimEvent[] } {
    const deadTank = makeTank(3, 'brown', 2, 3, { alive: false });
    const spawns: Spawn[] = [
      { kind: 'player', pos: { x: 0, y: 0 }, angle: 0 },
      { kind: 'brown', pos: { x: 2, y: 3 }, angle: 0 },
    ];
    const player = makeTank(1, 'player', 0, 0);
    return {
      world: createWorld({ walls: [], tanks: [player, deadTank], spawns, lives: 3 }),
      events: [destroyedEvent(3, 'brown', 2, 3)],
    };
  }

  it('spawns no ring for an enemy death when enemyEnabled is false', () => {
    // Mutation this catches: dropping the enemy gate so an enemy death rings
    // unconditionally.
    const { scene, dp } = setup();
    const { world, events } = enemyDeathWorldAndEvents();
    dp.spawn(events, world, { enemyEnabled: false });
    expect(deathRings(scene).length).toBe(0);
  });

  it('spawns a ring for an enemy death when enemyEnabled is true', () => {
    const { scene, dp } = setup();
    const { world, events } = enemyDeathWorldAndEvents();
    dp.spawn(events, world, { enemyEnabled: true });
    expect(deathRings(scene).length).toBe(1);
  });

  it('spawns a player ring regardless of enemyEnabled', () => {
    // Mutation this catches: gating the player branch on enemyEnabled too.
    const { scene, dp } = setup();
    const deadTank = makeTank(1, 'player', 0, 0, { alive: false });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 0, y: 0 }, angle: 0 }];
    const world = createWorld({ walls: [], tanks: [deadTank], spawns, lives: 3 });
    const events = [destroyedEvent(1, 'player', 0, 0)];
    dp.spawn(events, world, { enemyEnabled: false });
    expect(deathRings(scene).length).toBe(1);
  });
});

describe("death pulse: its own clock", () => {
  function playerDeathWorldAndEvents(): { world: World; events: SimEvent[] } {
    const deadTank = makeTank(1, 'player', 0, 0, { alive: false });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 0, y: 0 }, angle: 0 }];
    return {
      world: createWorld({ walls: [], tanks: [deadTank], spawns, lives: 3 }),
      events: [destroyedEvent(1, 'player', 0, 0)],
    };
  }

  it('expires and recycles a ring once update(dt) exceeds its own lifetime', () => {
    // Mutation this catches: update() never decrementing `life`, which would leave
    // the ring visible forever.
    const { scene, dp } = setup();
    const { world, events } = playerDeathWorldAndEvents();
    dp.spawn(events, world, { enemyEnabled: false });
    expect(deathRings(scene).length).toBe(1);

    dp.update(10); // any real feel-tuned lifetime is well under 10s
    expect(deathRings(scene).length).toBe(0);
  });

  it('recycles instead of allocating a new scene child on the next death', () => {
    const { scene, dp } = setup();
    const { world, events } = playerDeathWorldAndEvents();
    dp.spawn(events, world, { enemyEnabled: false });
    const allocatedFirst = scene.children.length;
    dp.update(10);
    expect(deathRings(scene).length).toBe(0);

    dp.spawn(events, world, { enemyEnabled: false });
    expect(deathRings(scene).length).toBe(1);
    expect(scene.children.length).toBe(allocatedFirst);
  });
});

describe('death pulse: frame/tick mismatch (issue #200 final-review defect)', () => {
  // The driver calls render(), and therefore deathPulse.spawn(), once per FRAME --
  // not once per sim TICK. These two tests reproduce the two symptoms that a
  // stateless prev/curr world diff produced under that mismatch, and pin the
  // event-driven fix against both.

  it('A: a 0-tick frame (no new events) does not re-fire an already-rung death', () => {
    // Mutation this catches: reverting to a stateless alive->dead world diff (reading
    // `world` for who is newly dead instead of `events`) -- a 0-tick frame hands the
    // renderer the SAME world twice in a row, so a diff-based spawn would see "still
    // dead" and (if it tracked no prior state) re-fire, producing a second coincident
    // ring for one death.
    const { scene, dp } = setup();
    const deadTank = makeTank(1, 'player', 0, 0, { alive: false });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 0, y: 0 }, angle: 0 }];
    const world = createWorld({ walls: [], tanks: [deadTank], spawns, lives: 3 });

    // Frame 1: the tick that actually killed the tank -- one tank-destroyed event.
    dp.spawn([destroyedEvent(1, 'player', 0, 0)], world, { enemyEnabled: false });
    expect(deathRings(scene).length).toBe(1);

    // Frame 2: a 0-tick frame. The driver hands the SAME world again, but frameEvents
    // is empty -- no tick ran, so nothing new happened.
    dp.spawn([], world, { enemyEnabled: false });
    expect(deathRings(scene).length).toBe(1); // not 2
  });

  it('B: a multi-tick frame with two intermediate deaths rings BOTH, not just the last', () => {
    // Mutation this catches: only reading the last event in the list (or diffing
    // prev/curr worlds, which only ever exposes the frame's FINAL tick) -- a
    // multi-tick frame (<=30Hz, post-stall catch-up) can carry more than one death in
    // its frameEvents, and each one has to ring independently.
    const { scene, dp } = setup();
    const deadX = makeTank(1, 'player', 1, 1, { controlledBy: 0, alive: false });
    const deadY = makeTank(2, 'player', 9, 9, { controlledBy: 1, alive: false });
    const spawns: Spawn[] = [
      { kind: 'player', pos: { x: 1, y: 1 }, angle: 0 },
      { kind: 'player', pos: { x: 9, y: 9 }, angle: 0 },
    ];
    const world = createWorld({ walls: [], tanks: [deadX, deadY], spawns, lives: 3 });
    const events = [destroyedEvent(1, 'player', 1, 1), destroyedEvent(2, 'player', 9, 9)];

    dp.spawn(events, world, { enemyEnabled: false });

    const rings = deathRings(scene);
    expect(rings.length).toBe(2);
    const positions = rings.map((r) => ({ x: r.position.x, z: r.position.z }));
    expect(positions).toEqual(
      expect.arrayContaining([
        { x: 1, z: 1 },
        { x: 9, z: 9 },
      ]),
    );
  });
});

describe('death pulse: dispose', () => {
  it('removes every mesh it added from the scene, active and pooled alike', () => {
    const { scene, dp } = setup();
    const deadTank = makeTank(1, 'player', 0, 0, { alive: false });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 0, y: 0 }, angle: 0 }];
    const world = createWorld({ walls: [], tanks: [deadTank], spawns, lives: 3 });
    const events = [destroyedEvent(1, 'player', 0, 0)];
    dp.spawn(events, world, { enemyEnabled: false });
    dp.update(10); // retire into the pool
    dp.spawn(events, world, { enemyEnabled: false });
    expect(scene.children.length).toBeGreaterThan(0);

    dp.dispose();
    // Both lists have to be drained: emptying only `active` leaves the pooled
    // meshes parented to the scene for the life of the page.
    expect(scene.children.length).toBe(0);
  });
});
