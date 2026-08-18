// Same reasoning as particles.test.ts: Three builds meshes, materials and vector
// maths on the CPU, so a Scene needs no GL context and this is jsdom-testable.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createWorld, type World } from '../sim/world';
import type { Tank, Spawn } from '../sim/types';
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
  it('spawns exactly one death-ring at the tank\'s PREV position, coloured by identity slot', () => {
    // Mutation this catches: reading curr's position (or curr's colour lookup) instead
    // of prev's -- prev and curr positions are deliberately different (5,8) vs (99,99),
    // and controlledBy 1 (not 0) so a hardcoded identityColor(0) also fails this.
    const { scene, dp } = setup();
    const prevTank = makeTank(1, 'player', 5, 8, { controlledBy: 1 });
    const currTank = makeTank(1, 'player', 99, 99, { controlledBy: 1, alive: false });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 5, y: 8 }, angle: 0 }];
    const prev = createWorld({ walls: [], tanks: [prevTank], spawns, lives: 3 });
    const curr = createWorld({ walls: [], tanks: [currTank], spawns, lives: 3 });

    dp.spawn(prev, curr, { enemyEnabled: false });

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
    const prevTank = makeTank(2, 'player', 4, 6, { controlledBy: 1, team: 1 });
    const currTank = makeTank(2, 'player', 4, 6, { controlledBy: 1, team: 1, alive: false });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 4, y: 6 }, angle: 0 }];
    const prev = createWorld({ walls: [], tanks: [prevTank], spawns, lives: 3, mode: 'teams' });
    const curr = createWorld({ walls: [], tanks: [currTank], spawns, lives: 3, mode: 'teams' });

    dp.spawn(prev, curr, { enemyEnabled: false });

    const rings = deathRings(scene);
    expect(rings.length).toBe(1);
    expect(rings[0].material.color.getHex()).toBe(TEAM_COLORS[1]);
    expect(rings[0].material.color.getHex()).not.toBe(IDENTITY_RING_COLORS[1]);
  });

  it('names its mesh death-ring, distinct from spawn-anim\'s own spawn-ring', () => {
    // Mutation this catches: reusing makeSpawnRing's mesh.name unchanged instead of
    // renaming it, which would make a same-frame respawn ring indistinguishable.
    const { scene, dp } = setup();
    const unrelatedSpawnRing = makeSpawnRing(0x123456);
    scene.add(unrelatedSpawnRing);
    const prevTank = makeTank(1, 'player', 1, 1, { controlledBy: 0 });
    const currTank = makeTank(1, 'player', 1, 1, { controlledBy: 0, alive: false });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 1, y: 1 }, angle: 0 }];
    const prev = createWorld({ walls: [], tanks: [prevTank], spawns, lives: 3 });
    const curr = createWorld({ walls: [], tanks: [currTank], spawns, lives: 3 });

    dp.spawn(prev, curr, { enemyEnabled: false });

    const names = scene.children.filter((c) => (c as THREE.Mesh).isMesh && c.visible).map((c) => c.name);
    expect(names).toContain('death-ring');
    expect(names).toContain('spawn-ring'); // the unrelated ring is untouched
    expect(deathRings(scene).length).toBe(1);
    expect(deathRings(scene)[0].name).not.toBe('spawn-ring');
  });
});

describe('death pulse: enemy gating', () => {
  function enemyDeathWorlds(): { prev: World; curr: World } {
    const prevTank = makeTank(3, 'brown', 2, 3);
    const currTank = makeTank(3, 'brown', 2, 3, { alive: false });
    const spawns: Spawn[] = [
      { kind: 'player', pos: { x: 0, y: 0 }, angle: 0 },
      { kind: 'brown', pos: { x: 2, y: 3 }, angle: 0 },
    ];
    const player = makeTank(1, 'player', 0, 0);
    return {
      prev: createWorld({ walls: [], tanks: [player, prevTank], spawns, lives: 3 }),
      curr: createWorld({ walls: [], tanks: [player, currTank], spawns, lives: 3 }),
    };
  }

  it('spawns no ring for an enemy death when enemyEnabled is false', () => {
    // Mutation this catches: dropping the enemy gate so an enemy death rings
    // unconditionally.
    const { scene, dp } = setup();
    const { prev, curr } = enemyDeathWorlds();
    dp.spawn(prev, curr, { enemyEnabled: false });
    expect(deathRings(scene).length).toBe(0);
  });

  it('spawns a ring for an enemy death when enemyEnabled is true', () => {
    const { scene, dp } = setup();
    const { prev, curr } = enemyDeathWorlds();
    dp.spawn(prev, curr, { enemyEnabled: true });
    expect(deathRings(scene).length).toBe(1);
  });

  it('spawns a player ring regardless of enemyEnabled', () => {
    // Mutation this catches: gating the player branch on enemyEnabled too.
    const { scene, dp } = setup();
    const prevTank = makeTank(1, 'player', 0, 0);
    const currTank = makeTank(1, 'player', 0, 0, { alive: false });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 0, y: 0 }, angle: 0 }];
    const prev = createWorld({ walls: [], tanks: [prevTank], spawns, lives: 3 });
    const curr = createWorld({ walls: [], tanks: [currTank], spawns, lives: 3 });
    dp.spawn(prev, curr, { enemyEnabled: false });
    expect(deathRings(scene).length).toBe(1);
  });
});

describe('death pulse: its own clock', () => {
  function playerDeathWorlds(): { prev: World; curr: World } {
    const prevTank = makeTank(1, 'player', 0, 0);
    const currTank = makeTank(1, 'player', 0, 0, { alive: false });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 0, y: 0 }, angle: 0 }];
    return {
      prev: createWorld({ walls: [], tanks: [prevTank], spawns, lives: 3 }),
      curr: createWorld({ walls: [], tanks: [currTank], spawns, lives: 3 }),
    };
  }

  it('expires and recycles a ring once update(dt) exceeds its own lifetime', () => {
    // Mutation this catches: update() never decrementing `life`, which would leave
    // the ring visible forever.
    const { scene, dp } = setup();
    const { prev, curr } = playerDeathWorlds();
    dp.spawn(prev, curr, { enemyEnabled: false });
    expect(deathRings(scene).length).toBe(1);

    dp.update(10); // any real feel-tuned lifetime is well under 10s
    expect(deathRings(scene).length).toBe(0);
  });

  it('recycles instead of allocating a new scene child on the next death', () => {
    const { scene, dp } = setup();
    const { prev, curr } = playerDeathWorlds();
    dp.spawn(prev, curr, { enemyEnabled: false });
    const allocatedFirst = scene.children.length;
    dp.update(10);
    expect(deathRings(scene).length).toBe(0);

    dp.spawn(prev, curr, { enemyEnabled: false });
    expect(deathRings(scene).length).toBe(1);
    expect(scene.children.length).toBe(allocatedFirst);
  });
});

describe('death pulse: no re-fire while staying dead', () => {
  it('does not spawn a second ring for a tank that was already dead in prev', () => {
    // Mutation this catches: dropping the `!p.alive` skip (or the `currAlive.has`
    // check) in spawn -- either one would treat "dead in both frames" as a fresh
    // death and add a second ring every tick a corpse sits in the world.
    const { scene, dp } = setup();
    const prevAlive = makeTank(1, 'player', 0, 0);
    const currDead = makeTank(1, 'player', 0, 0, { alive: false });
    const currDead2 = makeTank(1, 'player', 0, 0, { alive: false });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 0, y: 0 }, angle: 0 }];
    const worldAlive = createWorld({ walls: [], tanks: [prevAlive], spawns, lives: 3 });
    const worldDead = createWorld({ walls: [], tanks: [currDead], spawns, lives: 3 });
    const worldDead2 = createWorld({ walls: [], tanks: [currDead2], spawns, lives: 3 });

    // Frame 1: the actual death transition.
    dp.spawn(worldAlive, worldDead, { enemyEnabled: false });
    expect(deathRings(scene).length).toBe(1);

    // Frame 2: the tank is dead in BOTH prev and curr -- no new death occurred.
    dp.spawn(worldDead, worldDead2, { enemyEnabled: false });
    expect(deathRings(scene).length).toBe(1); // not 2
  });
});

describe('death pulse: dispose', () => {
  it('removes every mesh it added from the scene, active and pooled alike', () => {
    const { scene, dp } = setup();
    const prevTank = makeTank(1, 'player', 0, 0);
    const currTank = makeTank(1, 'player', 0, 0, { alive: false });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 0, y: 0 }, angle: 0 }];
    const prev = createWorld({ walls: [], tanks: [prevTank], spawns, lives: 3 });
    const curr = createWorld({ walls: [], tanks: [currTank], spawns, lives: 3 });
    dp.spawn(prev, curr, { enemyEnabled: false });
    dp.update(10); // retire into the pool
    dp.spawn(prev, curr, { enemyEnabled: false });
    expect(scene.children.length).toBeGreaterThan(0);

    dp.dispose();
    // Both lists have to be drained: emptying only `active` leaves the pooled
    // meshes parented to the scene for the life of the page.
    expect(scene.children.length).toBe(0);
  });
});
