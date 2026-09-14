import * as THREE from 'three';
import type { World } from '../sim/world';
import type { Bullet } from '../sim/types';
import { BULLET_RADIUS } from '../sim/constants';
import { BULLET_Y } from './tank-model';
import { MAX_TRAIL_SEGMENTS, trailSegmentsFor } from '../presentation/shell-trail';

/**
 * The `segments` shell bounce-trail (issue #688): a row of neutral dashes behind each live
 * shell, one more than its remaining ricochets. The vocabulary and the three constraints it
 * honours -- no hue, state rather than history, no motion of its own -- are in
 * `presentation/shell-trail.ts`; this file is only the drawing.
 *
 * ONE INSTANCED MESH. Every dash on the board is an instance of one flat quad with one
 * material, so the whole treatment is a single draw call whatever the shell count, and a frame
 * writes matrices into a buffer allocated once at construction. No mesh, material, geometry or
 * array is created per frame, which is the issue's "no unbounded per-frame allocation" asked
 * of the drawing itself rather than of a pool that could still grow.
 *
 * DETACHED, NOT A CHILD OF THE SHELL. `entities.ts`'s `syncBullets` disposes a shell's group
 * the frame the bullet leaves the world; dashes parented to it would go with it and could not
 * be counted or bounded as one population. Here each frame re-derives every dash from
 * `curr.bullets`, so a shell that is gone simply contributes none -- there is no per-shell
 * state to leak or strand across a level switch or round restart.
 *
 * RESIDUAL: the row trails the shell's CURRENT heading. On the frame a shell ricochets its
 * heading turns, so for the first ~0.9 world units of the new leg (0.15s at the normal shell's
 * speed of 6) the row points back through the wall it just left rather than along the path it
 * came in on. A history trail would follow the corner, and would also be invisible in a posed
 * still and need per-shell state; this experiment takes the state form deliberately.
 */
export interface ShellTrailSystem {
  /**
   * Lay out every live shell's dashes for this frame, at the same interpolated position
   * `entities.ts` draws the shell at (a lerp from the previous tick when the shell existed
   * then, its current position when it did not).
   */
  sync(prev: World, curr: World, alpha: number): void;
  /** How many dashes the last `sync` drew. The evidence and the tests read the budget here. */
  drawnDashes(): number;
  dispose(): void;
}

// Feel constants, in world units; retune by eye with `npm run gallery -- --elements shelltrail
// --shellTrail segments`. The shell itself is 0.45 long plus a 0.1 nose (entities.ts's
// SHELL_BODY_LEN and SHELL_R), so a full three-dash row is about 1.7 shell-lengths.
/** Along-flight length of one dash. */
export const DASH_LEN = 0.2;
/** Clear space between two dashes. Wide enough that the count survives a phone's downscale. */
export const DASH_GAP = 0.12;
/** Clear space between the shell's tail and the first dash, so the row reads as behind it. */
export const DASH_LEAD = 0.08;
/** Across-flight width: a little narrower than the shell (diameter 0.2), so it reads as its wake. */
const DASH_W = BULLET_RADIUS * 1.2;
/** Where the shell's tail is, behind its centre. Matches SHELL_BODY_LEN / 2 in entities.ts. */
const SHELL_TAIL = BULLET_RADIUS * 2.25;
/** Off-white, and the same for every owner -- see presentation/shell-trail.ts on hue. */
export const DASH_COLOR = 0xf2eee0;
const DASH_OPACITY = 0.85;

/**
 * Budget. One draw call regardless; this caps the instance BUFFER. Every shipped tank kind
 * holds at most 5 live shells (`tank-defs.json`'s `maxActiveProjectiles`, 5 or 1 per kind, and
 * `balance.json`'s player `shells.cap` of 5), and each shell draws at most MAX_TRAIL_SEGMENTS
 * (3) dashes, so a tank's worst case is 15 dashes. 192 = 64 shells x 3: the cap binds only
 * once more than 64 shells are live at once, which takes 13 tanks all at their 5-shell cap.
 * Past it the LATER shells in `curr.bullets` draw no dashes that frame -- the shells
 * themselves still render -- a deliberate degradation rather than a growing buffer.
 */
export const MAX_SHELL_TRAIL_DASHES = 64 * MAX_TRAIL_SEGMENTS;

export function createShellTrailSystem(scene: THREE.Scene): ShellTrailSystem {
  // Built flat once (XZ, facing +y) and long along +x, the shell's own local axis, so an
  // instance only ever needs a yaw -- the tread-trails.ts reasoning about Euler order.
  const geo = new THREE.PlaneGeometry(DASH_LEN, DASH_W);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: DASH_COLOR,
    transparent: true,
    opacity: DASH_OPACITY,
    // A translucent overlay: writing depth would cut holes in whatever draws after it.
    depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX_SHELL_TRAIL_DASHES);
  mesh.name = 'shell-trail';
  // The instances range over the whole board, and the base geometry's bounding sphere sits
  // at the origin, so frustum culling against it would drop the row whenever the origin
  // leaves view.
  mesh.frustumCulled = false;
  mesh.count = 0;
  scene.add(mesh);

  // Scratch, reused every frame.
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const at = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);

  /** The same shell on the previous tick, found without building a per-frame index. */
  function previous(prev: World, id: number): Bullet | undefined {
    for (const b of prev.bullets) if (b.id === id) return b;
    return undefined;
  }

  function sync(prev: World, curr: World, alpha: number): void {
    let n = 0;
    for (const b of curr.bullets) {
      if (!b.alive) continue;
      const segments = trailSegmentsFor(b.bouncesLeft);
      if (n + segments > MAX_SHELL_TRAIL_DASHES) break;
      const p = previous(prev, b.id);
      const x = p && p.alive ? p.pos.x + (b.pos.x - p.pos.x) * alpha : b.pos.x;
      const y = p && p.alive ? p.pos.y + (b.pos.y - p.pos.y) * alpha : b.pos.y;
      const speed = Math.hypot(b.vel.x, b.vel.y);
      // A live shell always moves (syncBullets relies on the same fact); guard anyway, since a
      // zero vector has no "behind".
      if (speed === 0) continue;
      const dx = b.vel.x / speed;
      const dy = b.vel.y / speed;
      // world (x, y) -> three (x, z); a world angle a is rotation.y = -a, as for the shell.
      q.setFromAxisAngle(up, -Math.atan2(dy, dx));
      for (let i = 0; i < segments; i++) {
        const back = SHELL_TAIL + DASH_LEAD + DASH_LEN / 2 + i * (DASH_LEN + DASH_GAP);
        at.set(x - dx * back, BULLET_Y, y - dy * back);
        m.compose(at, q, one);
        mesh.setMatrixAt(n++, m);
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }

  function dispose(): void {
    scene.remove(mesh);
    mesh.dispose();
    geo.dispose();
    mat.dispose();
  }

  return { sync, drawnDashes: () => mesh.count, dispose };
}
