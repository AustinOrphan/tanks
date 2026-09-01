// @vitest-environment jsdom
// Dev-only is not untested: this is one of the arms issue #356's ruling will be made from,
// so a ring that draws at the wrong moment does not merely look wrong, it corrupts the
// comparison. Three.js builds its scene graph on the CPU, so the wiring is reachable
// headlessly; whether any of it reaches the framebuffer is covered in tools/gl/harness.ts.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createBlockedFireRingSystem } from './blocked-fire-ring';
import { createWorld, type World } from '../sim/world';
import type { Tank } from '../sim/types';
import type { SimEvent } from '../sim/events';

function tank(id: number, kind: string, alive = true): Tank {
  return {
    id, kind, pos: { x: id, y: 0 }, bodyAngle: 0, turretAngle: 0, alive,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  } as unknown as Tank;
}
const world = (tanks: Tank[]): World => createWorld({ walls: [], tanks, spawns: [], lives: 3 });
const blocked = (ownerId: number): SimEvent =>
  ({ type: 'fire-blocked', ownerId, reason: 'shell-cap' }) as SimEvent;
const rings = (s: THREE.Scene) => s.children.filter((o) => o.name === 'blocked-fire-ring' && o.visible);

describe('blocked-fire ring (issue #356)', () => {
  it('draws nothing unless the flag names it', () => {
    // The default every arm shares: none may become the cue by being wired first.
    const scene = new THREE.Scene();
    const sys = createBlockedFireRingSystem(scene);
    const w = world([tank(1, 'player')]);
    for (const cue of [null, undefined, 'haptic', 'audio', 'haptic+audio'] as const) {
      sys.spawn([blocked(1)], w, cue as never);
    }
    expect(rings(scene)).toHaveLength(0);
  });

  it('draws for the refused PLAYER, on that tank', () => {
    const scene = new THREE.Scene();
    const sys = createBlockedFireRingSystem(scene);
    sys.spawn([blocked(3)], world([tank(1, 'player'), tank(3, 'player')]), 'ring');
    const [r] = rings(scene);
    expect(r).toBeDefined();
    // On the refused tank, not the first one: tank(3) sits at x = 3 by construction.
    expect(r.position.x).toBe(3);
  });

  it('ignores an AI refusal and a dead tank', () => {
    // `fire-blocked` is emitted for whoever was refused, AI included. Ringing an enemy
    // would report the ENEMY's ammunition to the player. Dropping either guard fails here.
    const scene = new THREE.Scene();
    const sys = createBlockedFireRingSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'brown')]), 'ring');
    sys.spawn([blocked(2)], world([tank(2, 'player', false)]), 'ring');
    expect(rings(scene)).toHaveLength(0);
  });

  it('CLOSES inward and fades, rather than expanding like a death pulse', () => {
    // The design claim, asserted rather than described. An expanding ring reads as a
    // discharge, which is the opposite of a shot that did not happen. Reversing the scale
    // term makes this fail.
    const scene = new THREE.Scene();
    const sys = createBlockedFireRingSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'ring');
    const r = rings(scene)[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    const start = r.scale.x;
    sys.update(0.06);
    const mid = r.scale.x;
    sys.update(0.06);
    expect(mid).toBeLessThan(start);
    expect(r.scale.x).toBeLessThan(mid);
    expect(r.material.opacity).toBeLessThan(1);
  });

  it('retires the ring at the end of its life and reuses it', () => {
    const scene = new THREE.Scene();
    const sys = createBlockedFireRingSystem(scene);
    const w = world([tank(1, 'player')]);
    sys.spawn([blocked(1)], w, 'ring');
    sys.update(1);
    expect(rings(scene)).toHaveLength(0);
    // Pooled, not leaked: a second refusal reuses the retired mesh rather than adding one.
    const meshes = scene.children.length;
    sys.spawn([blocked(1)], w, 'ring');
    expect(rings(scene)).toHaveLength(1);
    expect(scene.children.length).toBe(meshes);
  });

  it('reduced motion keeps the cue but removes the travel', () => {
    // #453's policy. A cue that still appears and fades is information; a contraction is
    // motion, and the preference is about motion.
    const scene = new THREE.Scene();
    const sys = createBlockedFireRingSystem(scene);
    sys.setReducedMotion(true);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'ring');
    const r = rings(scene)[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    const start = r.scale.x;
    sys.update(0.06);
    expect(r.scale.x).toBe(start);
    expect(r.material.opacity).toBeLessThan(1);
  });

  it('snaps an ALREADY-AIRBORNE ring to rest when reduced motion turns on mid-flight', () => {
    // The case the test above cannot see: it sets the preference BEFORE spawning, so it
    // passes whether `update` skips the scale term or applies a rest scale. The preference
    // is a live media query and can flip while a ring is in the air.
    //
    // Negative control: restoring `if (!reducedMotion) r.mesh.scale.setScalar(...)` fails
    // this. That guard freezes the ring at its current scale -- so it stops contracting
    // rather than reaching rest, and stays visibly oversized for the rest of its life.
    const scene = new THREE.Scene();
    const sys = createBlockedFireRingSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'ring');
    const r = rings(scene)[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    sys.update(0.06);
    const midFlight = r.scale.x;
    expect(midFlight).toBeGreaterThan(1);

    sys.setReducedMotion(true);
    sys.update(0.06);
    expect(r.scale.x).toBe(1);
    // Still a cue, still fading: reduced motion removes the travel, not the information.
    expect(r.material.opacity).toBeLessThan(1);
    expect(rings(scene)).toHaveLength(1);
  });

  it('dispose empties the scene', () => {
    const scene = new THREE.Scene();
    const sys = createBlockedFireRingSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'ring');
    sys.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
