// Three builds InstancedMesh buffers and matrix maths on the CPU, so a Scene needs no GL
// context and this is jsdom-testable, like tread-trails.test.ts.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createWorld, type World } from '../sim/world';
import type { Bullet, BulletType, Wall } from '../sim/types';
import { BULLET_RADIUS } from '../sim/constants';
import { BULLET_Y } from './tank-model';
import {
  DASH_COLOR, DASH_GAP, DASH_LEAD, DASH_LEN, MAX_SHELL_TRAIL_DASHES, createShellTrailSystem,
} from './shell-trail';
import { MAX_TRAIL_SEGMENTS } from '../presentation/shell-trail';

/** A shell whose type is its fresh budget: 2 ricochet, 1 normal, 0 fast -- a shell that has not bounced. */
function shell(id: number, x: number, y: number, vx: number, vy: number, bouncesLeft: number, extra: Partial<Bullet> = {}): Bullet {
  const type: BulletType = bouncesLeft === 2 ? 'ricochet' : bouncesLeft === 0 ? 'fast' : 'normal';
  return { id, ownerId: 1, type, pos: { x, y }, vel: { x: vx, y: vy }, bouncesLeft, alive: true, ...extra };
}

function worldOf(bullets: Bullet[], walls: Wall[] = []): World {
  const w = createWorld({ walls, tanks: [], spawns: [], lives: 3 });
  w.bullets = bullets;
  return w;
}

function setup() {
  const scene = new THREE.Scene();
  const trail = createShellTrailSystem(scene);
  const mesh = scene.children.find((c) => c.name === 'shell-trail') as THREE.InstancedMesh;
  return { scene, trail, mesh };
}

/** World (x, y) of dash i, read back from the instance buffer (three's z is world y). */
function dashAt(mesh: THREE.InstancedMesh, i: number): { x: number; y: number; h: number; yaw: number } {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  m.decompose(p, q, new THREE.Vector3());
  const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
  return { x: p.x, y: p.z, h: p.y, yaw: e.y };
}

// Positions are compared to 5 places, not 9: InstancedMesh stores its matrices in a
// Float32Array, so a dash at 1.595 reads back as 1.5950000286 (measured, on the first run).
const TAIL = BULLET_RADIUS * 2.25;
const back = (i: number) => TAIL + DASH_LEAD + DASH_LEN / 2 + i * (DASH_LEN + DASH_GAP);

/** A solid wall whose face toward -x is the plane x = face. */
const wallRightOf = (face: number): Wall => ({
  id: 1, kind: 'solid', destroyed: false, aabb: { minX: face, minY: -5, maxX: face + 0.3, maxY: 5 },
});

describe('shell bounce-trail system (issue #688)', () => {
  it('draws one dash per bounce left, and none for a shell with no bounces left (issue #774)', () => {
    const { trail } = setup();
    for (const [bounces, dashes] of [[0, 0], [1, 1], [2, 2]]) {
      const w = worldOf([shell(1, 0, 0, 6, 0, bounces)]);
      trail.sync(w, w, 0);
      expect(trail.drawnDashes(), `${bounces} bounces left`).toBe(dashes);
    }
    const mixed = worldOf([shell(1, 0, 0, 6, 0, 2), shell(2, 3, 0, 6, 0, 1), shell(3, 6, 0, 6, 0, 0)]);
    trail.sync(mixed, mixed, 0);
    expect(trail.drawnDashes()).toBe(3);
  });

  it('lays the row out behind the shell along its heading, at shell height', () => {
    const { trail, mesh } = setup();
    const w = worldOf([shell(1, 5, 2, 0, 6, 2)]);
    trail.sync(w, w, 0);
    for (let i = 0; i < 2; i++) {
      const d = dashAt(mesh, i);
      expect(d.x).toBeCloseTo(5, 5);
      expect(d.y, `dash ${i}`).toBeCloseTo(2 - back(i), 5);
      expect(d.h).toBeCloseTo(BULLET_Y, 5);
      // Heading +y in the world is a world angle of pi/2, so rotation.y is -pi/2.
      expect(d.yaw).toBeCloseTo(-Math.PI / 2, 5);
    }
  });

  it('turns the row with the shell the frame its heading turns', () => {
    const { trail, mesh } = setup();
    const out = worldOf([shell(1, 0, 0, 6, 0, 1)]);
    trail.sync(out, out, 0);
    expect(dashAt(mesh, 0).x).toBeLessThan(0);
    const turned = worldOf([shell(1, 0, 0, -6, 0, 1)]);
    trail.sync(turned, turned, 0);
    expect(trail.drawnDashes()).toBe(1);
    expect(dashAt(mesh, 0).x).toBeCloseTo(back(0), 5);
  });

  it('follows the interpolated shell, not the tick position', () => {
    const { trail, mesh } = setup();
    const prev = worldOf([shell(1, 0, 0, 6, 0, 1)]);
    const curr = worldOf([shell(1, 1, 0, 6, 0, 1)]);
    trail.sync(prev, curr, 0.25);
    expect(dashAt(mesh, 0).x).toBeCloseTo(0.25 - back(0), 5);
    const fresh = worldOf([]);
    trail.sync(fresh, curr, 0.25);
    expect(dashAt(mesh, 0).x, 'a shell new this tick has no lerp partner').toBeCloseTo(1 - back(0), 5);
  });

  it('draws nothing for a dead shell, and forgets a shell that has left the world', () => {
    const { trail } = setup();
    const w = worldOf([shell(1, 0, 0, 6, 0, 2, { alive: false })]);
    trail.sync(w, w, 0);
    expect(trail.drawnDashes()).toBe(0);
    const live = worldOf([shell(1, 0, 0, 6, 0, 2)]);
    trail.sync(live, live, 0);
    const gone = worldOf([]);
    trail.sync(live, gone, 0);
    expect(trail.drawnDashes()).toBe(0);
  });

  it('uses one colour for every owner, so the trail carries no identity hue', () => {
    const { trail, mesh } = setup();
    const w = worldOf([shell(1, 0, 0, 6, 0, 1, { ownerId: 1 }), shell(2, 3, 0, 6, 0, 1, { ownerId: 2 })]);
    trail.sync(w, w, 0);
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.color.getHex()).toBe(DASH_COLOR);
    // One material and no per-instance colour buffer: nothing here could vary by owner.
    expect(Array.isArray(mesh.material)).toBe(false);
    expect(mesh.instanceColor).toBeNull();
  });

  it('is bounded: a fixed buffer, one object, and later shells dropped past the cap', () => {
    const { scene, trail, mesh } = setup();
    expect(scene.children.filter((c) => c.name === 'shell-trail')).toHaveLength(1);
    const buffer = mesh.instanceMatrix;
    // 70 two-dash shells want 140 dashes, past the 128 cap.
    const many = Array.from({ length: 70 }, (_, i) => shell(i + 1, i, 0, 6, 0, 2));
    const w = worldOf(many);
    trail.sync(w, w, 0);
    expect(MAX_SHELL_TRAIL_DASHES).toBe(128);
    expect(trail.drawnDashes()).toBe(MAX_SHELL_TRAIL_DASHES);
    expect(MAX_SHELL_TRAIL_DASHES % MAX_TRAIL_SEGMENTS, 'the cap holds whole rows').toBe(0);
    expect(mesh.instanceMatrix, 'the instance buffer is never reallocated').toBe(buffer);
    expect(scene.children).toHaveLength(1);
  });

  it('removes its mesh on dispose', () => {
    const { scene, trail } = setup();
    trail.dispose();
    expect(scene.children).toHaveLength(0);
  });
});

describe('shell bounce-trail after a bounce (issue #774)', () => {
  // A ricochet shell with one bounce left has spent one: it came off a wall. Here it has just
  // left the face at x = 0.2 heading -x at 45 degrees, so it came in heading +x at 45 degrees.
  const s = Math.SQRT1_2;
  const bounced = (x: number, y: number) =>
    shell(1, x, y, -6 * s, 6 * s, 1, { type: 'ricochet' });

  it("lays a bounced shell's dash back along the leg it came in on, never inside the wall", () => {
    const { trail, mesh } = setup();
    // 0.1 past the face along its heading: the dash (centre back(0) behind) is past the corner.
    const x = 0.2 - 0.1 * s;
    const y = 0.1 * s;
    const w = worldOf([bounced(x, y)], [wallRightOf(0.2)]);
    trail.sync(w, w, 0);
    expect(trail.drawnDashes(), 'the count survives the bounce').toBe(1);
    const d = dashAt(mesh, 0);
    // The whole dash is on the open side of the face.
    expect(d.x + (DASH_LEN / 2) * s).toBeLessThanOrEqual(0.2 + 1e-5);
    // Along the incoming leg, heading +x at 45 degrees: behind the corner means down and left.
    const corner = { x: 0.2, y: 0 };
    const beyond = back(0) - 0.1;
    expect(d.x).toBeCloseTo(corner.x - s * beyond, 5);
    expect(d.y).toBeCloseTo(corner.y - s * beyond, 5);
    expect(d.yaw).toBeCloseTo(-Math.PI / 4, 5);
  });

  it('leaves a bounced shell with no wall within its reach laid straight', () => {
    const { trail, mesh } = setup();
    const w = worldOf([bounced(-3, 3)], [wallRightOf(0.2)]);
    trail.sync(w, w, 0);
    const d = dashAt(mesh, 0);
    expect(d.x).toBeCloseTo(-3 + s * back(0), 5);
    expect(d.y).toBeCloseTo(3 - s * back(0), 5);
  });

  it('lays a shell that has not bounced straight, even with a wall close behind it', () => {
    const { trail, mesh } = setup();
    // A fresh normal shell (budget 1, one left) flying -x away from a face 0.1 behind it: it
    // did not come off that wall, so there is no leg to fold onto.
    const w = worldOf([shell(1, 0.1, 0, -6, 0, 1)], [wallRightOf(0.2)]);
    trail.sync(w, w, 0);
    expect(dashAt(mesh, 0).x).toBeCloseTo(0.1 + back(0), 5);
  });

  it('moves a dash that would straddle the corner wholly onto one leg', () => {
    const { trail, mesh } = setup();
    // Straight back from the shell the corner falls inside the dash: centre back(0), corner
    // back(0) - DASH_LEN / 4. The centre is past the corner, so the dash goes onto the incoming
    // leg, starting exactly at the corner.
    const corner = back(0) - DASH_LEN / 4;
    const w = worldOf([bounced(0.2 - s * corner, s * corner)], [wallRightOf(0.2)]);
    trail.sync(w, w, 0);
    const d = dashAt(mesh, 0);
    expect(d.x).toBeCloseTo(0.2 - s * (DASH_LEN / 2), 5);
    expect(d.y).toBeCloseTo(-s * (DASH_LEN / 2), 5);
    expect(d.yaw).toBeCloseTo(-Math.PI / 4, 5);
  });
});
