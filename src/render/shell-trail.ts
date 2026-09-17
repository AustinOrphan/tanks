import * as THREE from 'three';
import type { World } from '../sim/world';
import type { Bullet, Wall } from '../sim/types';
import { BULLET_RADIUS, bulletConfig } from '../sim/constants';
import { BULLET_Y } from './tank-model';
import { MAX_TRAIL_SEGMENTS, trailSegmentsFor } from '../presentation/shell-trail';

/**
 * The `segments` shell bounce-trail (issues #688, #774): a row of neutral dashes behind each
 * live shell, one per remaining ricochet and none for a shell with none left. The vocabulary
 * and the three constraints it honours -- no hue, state rather than history, no motion of its
 * own -- are in `presentation/shell-trail.ts`; this file is only the drawing.
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
 * AROUND THE CORNER, NOT THROUGH THE WALL (issue #774). The row trails the shell's CURRENT
 * heading, so on the new leg after a ricochet it used to point back through the wall the shell
 * had just left, for as long as the wall was closer than the row's length. Under the direct
 * count only a shell that has bounced AND still has a bounce to come draws a row there -- a
 * ricochet shell after its first bounce, with one dash -- and dropping a dash that lands in the
 * wall would draw that shell as a zero, the one misreading the count must not allow.
 *
 * So a shell that has bounced (its `bouncesLeft` is below its type's budget, the sim's own
 * reckoning in `stepBullets`) looks straight back for the nearest live wall face within the
 * row's reach. It flew straight from that face since the bounce, so the face is where it
 * turned: dashes nearer than the face stay on the current leg, and dashes beyond it are laid
 * back along the leg it came in on, the current heading reflected in the face. Still state,
 * not history: nothing is remembered between frames, and a posed still folds the same way.
 * A dash that would straddle the corner moves wholly onto the leg holding its centre.
 *
 * RESIDUALS. A shell that has NOT bounced is laid straight even with a wall close behind it --
 * a tank firing with its back to a wall -- since it did not come off that wall. A destructible
 * wall destroyed after the bounce leaves no face to fold at, so that row is laid straight.
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
// SHELL_BODY_LEN and SHELL_R).
//
// LARGER FOR #774. At the real game camera the first experiment's dashes (0.2 by 0.12) came out
// a few pixels long at 1280x800 and smaller on a phone. With at most two dashes the row can
// spend the length three used to share: a full two-dash row is still about 1.1 world units.
/** Along-flight length of one dash. */
export const DASH_LEN = 0.3;
/** Clear space between two dashes. Wide enough that the count survives a phone's downscale. */
export const DASH_GAP = 0.16;
/** Clear space between the shell's tail and the first dash, so the row reads as behind it. */
export const DASH_LEAD = 0.1;
/** Across-flight width: most of the shell's diameter (0.2), so it reads as its wake. */
export const DASH_W = BULLET_RADIUS * 1.6;
/** Where the shell's tail is, behind its centre. Matches SHELL_BODY_LEN / 2 in entities.ts. */
const SHELL_TAIL = BULLET_RADIUS * 2.25;
/** Off-white, and the same for every owner -- see presentation/shell-trail.ts on hue. */
export const DASH_COLOR = 0xf2eee0;
const DASH_OPACITY = 0.95;

/**
 * Budget. One draw call regardless; this caps the instance BUFFER. Every shipped tank kind
 * holds at most 5 live shells (`tank-defs.json`'s `maxActiveProjectiles`, 5 or 1 per kind, and
 * `balance.json`'s player `shells.cap` of 5), and each shell draws at most MAX_TRAIL_SEGMENTS
 * (2) dashes, so a tank's worst case is 10 dashes. 128 = 64 shells x 2: the cap binds only
 * once more than 64 two-dash shells are live at once, which takes 13 tanks all at their
 * 5-shell cap firing ricochet shells. Past it the LATER shells in `curr.bullets` draw no dashes
 * that frame -- the shells themselves still render -- a deliberate degradation rather than a
 * growing buffer.
 */
export const MAX_SHELL_TRAIL_DASHES = 64 * MAX_TRAIL_SEGMENTS;

/** Where the row's last dash ends behind the shell's centre, for `segments` dashes. */
function rowReach(segments: number): number {
  return SHELL_TAIL + DASH_LEAD + segments * (DASH_LEN + DASH_GAP) - DASH_GAP;
}

/** Scratch for `wallBehind`: distance to the face and its outward normal. */
const behind = { d: 0, nx: 0, ny: 0 };

/**
 * The nearest live wall face straight behind (x, y) along (bx, by), within `reach`. Writes
 * `behind` and returns true, or returns false. An axis-aligned slab test like the sim's
 * `raySegmentVsAABB`, but allocation-free, since it runs for every bounced shell every frame. A
 * ray that starts inside a wall crosses no face and finds nothing.
 */
function wallBehind(walls: readonly Wall[], x: number, y: number, bx: number, by: number, reach: number): boolean {
  let found = false;
  let best = reach;
  for (const wall of walls) {
    if (wall.destroyed) continue;
    const a = wall.aabb;
    let tmin = 0;
    let tmax = best;
    let nx = 0;
    let ny = 0;
    if (bx === 0) {
      if (x < a.minX || x > a.maxX) continue;
    } else {
      let t1 = (a.minX - x) / bx;
      let t2 = (a.maxX - x) / bx;
      let n = -1;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; n = 1; }
      if (t1 > tmin) { tmin = t1; nx = n; ny = 0; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) continue;
    }
    if (by === 0) {
      if (y < a.minY || y > a.maxY) continue;
    } else {
      let t1 = (a.minY - y) / by;
      let t2 = (a.maxY - y) / by;
      let n = -1;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; n = 1; }
      if (t1 > tmin) { tmin = t1; nx = 0; ny = n; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) continue;
    }
    if (nx === 0 && ny === 0) continue;
    found = true;
    best = tmin;
    behind.d = tmin;
    behind.nx = nx;
    behind.ny = ny;
  }
  return found;
}

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
      if (segments === 0) continue;
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
      // A shell that has bounced may have the wall it left closer than its row (see the header).
      const bounced = b.bouncesLeft < bulletConfig[b.type].bounces;
      const folds = bounced && wallBehind(curr.walls, x, y, -dx, -dy, rowReach(segments));
      const corner = folds ? behind.d : Infinity;
      // The leg it came in on: the current heading reflected in the face it left.
      const dot = dx * behind.nx + dy * behind.ny;
      const ix = folds ? dx - 2 * dot * behind.nx : dx;
      const iy = folds ? dy - 2 * dot * behind.ny : dy;
      for (let i = 0; i < segments; i++) {
        let back = SHELL_TAIL + DASH_LEAD + DASH_LEN / 2 + i * (DASH_LEN + DASH_GAP);
        if (back - DASH_LEN / 2 < corner && back + DASH_LEN / 2 > corner) {
          back = back <= corner ? corner - DASH_LEN / 2 : corner + DASH_LEN / 2;
        }
        const onIncoming = back > corner;
        const hx = onIncoming ? ix : dx;
        const hy = onIncoming ? iy : dy;
        if (onIncoming) {
          const beyond = back - corner;
          at.set(x - dx * corner - ix * beyond, BULLET_Y, y - dy * corner - iy * beyond);
        } else {
          at.set(x - dx * back, BULLET_Y, y - dy * back);
        }
        // world (x, y) -> three (x, z); a world angle a is rotation.y = -a, as for the shell.
        q.setFromAxisAngle(up, -Math.atan2(hy, hx));
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
