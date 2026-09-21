// @vitest-environment jsdom
// The wreck decoration (issue #232). Three.js builds its scene graph on the CPU, so the
// pooling, the lifetime, the orientation snapshot and the per-arm behaviour are all reachable
// headlessly; whether any of it reaches the framebuffer is tools/gl/harness.ts's question, as
// .claude/rules/rendering.md says.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createWreckSystem } from './wreck';
import { WRECK_EFFECTS, type WreckEffect } from '../presentation/wreck';
import { createWorld, type World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import type { Tank } from '../sim/types';

function tank(id: number, x: number, y: number, extra: Partial<Tank> = {}): Tank {
  return {
    id, kind: 'player', pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive: false,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...extra,
  } as unknown as Tank;
}

const world = (tanks: Tank[]): World => createWorld({ walls: [], tanks, spawns: [], lives: 3 });

const destroyed = (tankId: number, x: number, y: number): SimEvent =>
  ({ type: 'tank-destroyed', tankId, kind: 'player', by: 'shell', pos: { x, y } } as unknown as SimEvent);

const wrecks = (scene: THREE.Scene): THREE.Mesh[] =>
  scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.name === 'wreck');
const visible = (scene: THREE.Scene): THREE.Mesh[] => wrecks(scene).filter((m) => m.visible);

describe('one wreck per destruction, at the death position and heading', () => {
  it('spawns at the EVENT position, not the tank\'s current one', () => {
    // The sim records where the death happened; a tank object can be moved by a respawn
    // before the next frame. Fixture deliberately disagrees: tank at (9,9), event at (2,3).
    const scene = new THREE.Scene();
    const sys = createWreckSystem(scene);
    sys.spawn([destroyed(1, 2, 3)], world([tank(1, 9, 9)]));
    const m = visible(scene)[0];
    expect(m.position.x).toBe(2);
    expect(m.position.z).toBe(3);
  });

  it('SNAPSHOTS the heading, so a respawn cannot swing an existing wreck', () => {
    // THE trap this module's header names. A destroyed tank stays in world.tanks and its
    // bodyAngle is overwritten on respawn; a wreck holding the tank would follow it.
    const scene = new THREE.Scene();
    const sys = createWreckSystem(scene);
    const t = tank(1, 0, 0, { bodyAngle: 1 });
    sys.spawn([destroyed(1, 0, 0)], world([t]));
    const m = visible(scene)[0];
    expect(m.rotation.y).toBeCloseTo(-1, 10);

    // The slot respawns facing the other way. The wreck must not move.
    t.bodyAngle = -2.5;
    sys.update(0.016);
    expect(m.rotation.y, 'a reference would now read 2.5').toBeCloseTo(-1, 10);
  });

  it('fires once per event, however many frames pass without one', () => {
    // The duplicate-at-high-refresh criterion. A prev/curr diff would re-fire on every
    // zero-tick frame; reading events cannot.
    const scene = new THREE.Scene();
    const sys = createWreckSystem(scene);
    const w = world([tank(1, 0, 0)]);
    sys.spawn([destroyed(1, 0, 0)], w);
    for (let i = 0; i < 10; i++) sys.spawn([], w);
    expect(visible(scene)).toHaveLength(1);
  });

  it('ignores every other event type, and an event naming no tank', () => {
    const scene = new THREE.Scene();
    const sys = createWreckSystem(scene);
    sys.spawn([{ type: 'shot-fired' } as unknown as SimEvent], world([tank(1, 0, 0)]));
    expect(visible(scene)).toHaveLength(0);
    // A tankId not in the world is unreachable in practice; it must not throw either.
    expect(() => sys.spawn([destroyed(99, 0, 0)], world([tank(1, 0, 0)]))).not.toThrow();
    expect(visible(scene)).toHaveLength(0);
  });
});

describe('the pool is bounded and replaces deterministically', () => {
  it('never exceeds the cap, and drops the OLDEST rather than the newest death', () => {
    const scene = new THREE.Scene();
    const sys = createWreckSystem(scene);
    const tanks = Array.from({ length: 12 }, (_, i) => tank(i + 1, 0, 0));
    const w = world(tanks);
    // Twelve deaths at distinct x, one frame apart, against a cap of 8.
    for (let i = 0; i < 12; i++) sys.spawn([destroyed(i + 1, i, 0)], w);

    const shown = visible(scene);
    expect(shown.length).toBeLessThanOrEqual(8);
    expect(shown.length, 'the cap is reached, not merely respected').toBe(8);
    // The survivors are the LAST eight deaths: x = 4..11. A newest-dropped policy would
    // leave 0..7 instead, which is the same count and the wrong deaths.
    expect(shown.map((m) => m.position.x).sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('reuses meshes rather than growing the scene without bound', () => {
    const scene = new THREE.Scene();
    const sys = createWreckSystem(scene);
    const w = world([tank(1, 0, 0)]);
    for (let i = 0; i < 6; i++) sys.spawn([destroyed(1, i, 0)], w);
    const built = wrecks(scene).length;
    // Expire them all, then spawn six more: the scene must not hold twelve.
    sys.update(99);
    expect(visible(scene)).toHaveLength(0);
    for (let i = 0; i < 6; i++) sys.spawn([destroyed(1, i, 0)], w);
    expect(wrecks(scene).length, 'recycled, not rebuilt').toBe(built);
  });
});

describe('every arm leaves, and they differ on the way', () => {
  it('expires on the same clock whichever arm is chosen', () => {
    // Population: all three shipped arms. An arm that never recycled would accumulate.
    let checked = 0;
    for (const effect of WRECK_EFFECTS) {
      const scene = new THREE.Scene();
      const sys = createWreckSystem(scene, effect);
      sys.spawn([destroyed(1, 0, 0)], world([tank(1, 0, 0)]));
      expect(visible(scene), effect).toHaveLength(1);
      sys.update(5.9);
      expect(visible(scene), `${effect} still alive just before the lifetime`).toHaveLength(1);
      sys.update(0.2);
      expect(visible(scene), `${effect} gone after it`).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(3);
    expect(WRECK_EFFECTS).toHaveLength(3);
  });

  it('moves the hull for sink and tilt, and only the opacity for fade', () => {
    // The discriminating case: what actually distinguishes the three options being ruled on.
    const at = (effect: WreckEffect) => {
      const scene = new THREE.Scene();
      const sys = createWreckSystem(scene, effect);
      sys.spawn([destroyed(1, 0, 0)], world([tank(1, 0, 0)]));
      sys.update(3);
      const m = visible(scene)[0];
      return { y: m.position.y, roll: m.rotation.z, opacity: (m.material as THREE.MeshBasicMaterial).opacity };
    };
    const sink = at('sink');
    const fade = at('fade');
    const tilt = at('tilt');

    expect(sink.y, 'sink settles into the felt').toBeLessThan(fade.y);
    expect(tilt.roll, 'tilt rolls onto its side').toBeGreaterThan(0);
    expect(fade.roll, 'fade does not move').toBe(0);
    expect(fade.y).toBe(tilt.y);
    // All three are on their way out, or none of them is a removal effect.
    for (const [name, s] of [['sink', sink], ['fade', fade], ['tilt', tilt]] as const) {
      expect(s.opacity, name).toBeGreaterThan(0);
      expect(s.opacity, name).toBeLessThan(1);
    }
  });

  it('reduced motion holds the movement arms still and keeps the fade', () => {
    // Issue #289's rule as death-pulse.ts applies it: calm the movement, keep the cue. A
    // wreck that vanished entirely under reduced motion would delete the information.
    for (const effect of ['sink', 'tilt'] as const) {
      const scene = new THREE.Scene();
      const sys = createWreckSystem(scene, effect);
      sys.setReducedMotion(true);
      sys.spawn([destroyed(1, 0, 0)], world([tank(1, 0, 0)]));
      sys.update(3);
      const m = visible(scene)[0];
      expect(m.position.y, `${effect} does not sink`).toBeCloseTo(0.02, 10);
      expect(m.rotation.z, `${effect} does not roll`).toBe(0);
      const opacity = (m.material as THREE.MeshBasicMaterial).opacity;
      expect(opacity, `${effect} still fades`).toBeGreaterThan(0);
      expect(opacity, `${effect} still fades`).toBeLessThan(1);
    }
  });

  it('takes the policy MID-FLIGHT, not only at the next death', () => {
    // death-pulse.ts's sibling contract. A player who turns the setting on wants the movement
    // to stop NOW; a wreck that keeps sinking for its remaining seconds is the one on screen
    // when they changed it. Settled by reading the flag per update rather than latching it at
    // spawn, which is invisible to a test that sets the policy first.
    const scene = new THREE.Scene();
    const sys = createWreckSystem(scene, 'sink');
    sys.spawn([destroyed(1, 0, 0)], world([tank(1, 0, 0)]));
    sys.update(2);
    const m = visible(scene)[0];
    const sunkTo = m.position.y;
    expect(sunkTo, 'the wreck never sank, so the toggle proves nothing').toBeLessThan(0.02);

    sys.setReducedMotion(true);
    sys.update(2);
    expect(m.position.y, 'the wreck kept sinking after the policy changed').toBe(sunkTo);
  });
});

describe('housekeeping', () => {
  it('dispose clears the scene of every wreck, active or pooled', () => {
    const scene = new THREE.Scene();
    const sys = createWreckSystem(scene);
    const w = world([tank(1, 0, 0)]);
    for (let i = 0; i < 3; i++) sys.spawn([destroyed(1, i, 0)], w);
    sys.update(99); // two into the pool, one still active on the next spawn
    sys.spawn([destroyed(1, 0, 0)], w);
    expect(wrecks(scene).length).toBeGreaterThan(0);
    sys.dispose();
    expect(wrecks(scene)).toHaveLength(0);
  });

  it('clear retires every wreck, so a new board does not inherit the old one\'s dead', () => {
    // Issue #232's "round reset, arena change". Six seconds outlives a cleared level, and the
    // coordinates a wreck marks mean nothing on the next arena -- which is the defect issue
    // #531's announcement exists to prevent, not a tidiness preference.
    const scene = new THREE.Scene();
    const sys = createWreckSystem(scene);
    const w = world([tank(1, 0, 0), tank(2, 0, 0)]);
    sys.spawn([destroyed(1, 3, 4), destroyed(2, 5, 6)], w);
    expect(visible(scene)).toHaveLength(2);

    sys.clear();
    expect(visible(scene), 'a wreck survived the board it died on').toHaveLength(0);

    // And the meshes are recycled rather than leaked: the next death reuses one of them.
    const before = wrecks(scene).length;
    sys.spawn([destroyed(1, 1, 1)], w);
    expect(visible(scene)).toHaveLength(1);
    expect(wrecks(scene), 'clear leaked its meshes instead of pooling them').toHaveLength(before);
  });
});
