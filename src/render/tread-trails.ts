import * as THREE from 'three';
import type { Tank, Vec2 } from '../sim/types';
import type { World } from '../sim/world';
import { HULL_WIDTH, TRACK_W, identityApplies, resolveOwnerColor } from './entities';

/**
 * Fading tread-print decals left behind a moving tank (issue #231).
 *
 * Pooled and scene-attached, the same shape as `particles.ts` and `death-pulse.ts`:
 * a decal is a detached mesh, not a child of the tank's own `TankView.group`, so it
 * survives exactly where the tank was when it printed even after the tank has moved
 * on (or, per `entities.ts`'s own `syncTanks` teardown, been disposed on death).
 *
 * UNLIKE particles/death-pulse, this system is not event-driven: there is no
 * `SimEvent` for "a tank moved". `sync(prev, curr)` is driven by WORLD STATE instead,
 * called every render frame with the same `(prev, curr)` pair `entities.sync` gets.
 *
 * `prev` is read for exactly one field -- `roundStartTick`, to detect a round
 * boundary or level switch, the same signal `entities.ts`'s own `snap` uses. It is
 * NEVER read for tank position. That is deliberate, not an oversight: `death-pulse.ts`'s
 * own doc comment explains why a stateless diff of `prev` against `curr` is wrong for
 * a per-frame consumer -- a >=2-tick catch-up frame only ever exposes the LAST tick's
 * world, so `prev.tanks` can be several ticks stale. This module keeps its OWN anchor
 * per tank (`anchors`, keyed by id) precisely so emission is driven by the tank's
 * actual accumulated path across frames, never by a single frame's `prev` snapshot.
 *
 * RESIDUAL: because only `curr.bodyAngle` is available at emission time (not an
 * interpolated heading across the skipped ticks), a multi-tick catch-up frame that
 * both turns and drives far enough to cross several `EMIT_SPACING` boundaries in one
 * `sync` call prints every decal in that batch at the SAME (latest) heading, cutting
 * the corner slightly rather than following the true turned path. Invisible at a
 * healthy frame rate (at most one tick's worth of turn between calls); a documented
 * simplification, not a bug, the same way death-pulse.ts documents its own.
 */
export interface TreadTrailSystem {
  /**
   * Tracks each alive tank's world-space position and, once it has moved
   * `EMIT_SPACING` from its last print, emits a left/right decal pair there. A
   * stationary tank (including one only turning in place -- see `moveTank`'s own
   * "a turn costs ground" comment in collision.ts, which means turning in place is
   * governed by the SAME distance rule as driving, not a special case) accumulates
   * no distance and prints nothing, which is what keeps a parked tank from
   * overdrawing its own footprint frame after frame.
   *
   * On a round boundary or level switch (`prev.roundStartTick !== curr.roundStartTick`,
   * `entities.ts`'s own `snap` signal), every active decal is recycled immediately
   * and every tracked anchor is dropped -- old marks would otherwise sit at
   * coordinates that belong to a board that no longer exists.
   */
  sync(prev: World, curr: World): void;
  /** Ages every active decal by dt, fading it out; recycles any decal whose own
   * clock has run out. `dt` is the same real-seconds delta particles.update and
   * deathPulse.update take, already zeroed by `animationDt` while `paused` -- so a
   * paused game neither ages nor (per `sync` reading a frozen, non-ticking world)
   * emits new decals. */
  update(dt: number): void;
  dispose(): void;
}

interface Decal {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  life: number;
  maxLife: number;
}

// Feel constants (CLAUDE.md's "numbers that are feel, not measurement"): cheap to
// retune by eye, kept in this one place. The three the tests reason about
// arithmetically (EMIT_SPACING, LIFETIME_SECONDS, MAX_TRAILS) are exported so
// tread-trails.test.ts imports them rather than re-declaring literals that would
// silently drift out of sync with a future retune.
//
// World-space distance between successive decal PAIRS along a tank's path. Small
// enough that consecutive prints overlap (TREAD_LEN below is slightly larger) and
// read as a continuous track rather than dashes; distance-based rather than
// frame-count-based, which is what makes emission frame-rate independent -- the same
// physical spacing results whether the distance is covered in one render frame or a
// hundred (see the accumulate-then-carry-remainder walk in `sync` below).
export const EMIT_SPACING = 0.25;
// How long a single decal takes to fade to fully transparent.
export const LIFETIME_SECONDS = 2.0;
// Quad size, in world units. Longer than EMIT_SPACING so neighbouring prints overlap
// a hair (hides the seam); narrower than TRACK_W (one physical tread's width) so the
// mark reads as a print of the tread, not the tread itself.
const TREAD_LEN = 0.32;
const TREAD_W = 0.16;
export const TREAD_COLOR = 0x2a2018; // dark disturbed-earth brown, independent of tank paint

/**
 * How far a VS trail mark is pulled from the neutral earth toward its owner's identity
 * colour (issue #284). A BLEND, not a replacement, and the number is the whole design:
 *
 * The trail layer has to stay subordinate to tanks, rings, shells and hazards -- it is the
 * quietest thing on the board and covers the most of it. At 1.0 a trail would print the
 * same colour as the identity ring that is supposed to be the loud signal; at 0 there is no
 * identity at all. 0.35 keeps the mark unmistakably earth-toned while the hue still reads
 * as the owner's, which `tread-trails.test.ts` pins as a MEASURED relationship rather than
 * a taste claim: every tinted mark stays nearer the neutral than the ring colour it leans
 * toward, on every channel.
 */
export const TREAD_IDENTITY_BLEND = 0.35;

/**
 * Per-channel lerp between two packed 0xRRGGBB values.
 *
 * sRGB space, deliberately, matching how `TREAD_COLOR` and the identity palettes are
 * authored and how THREE reads a hex into a MeshBasicMaterial here. A linear-light mix
 * would be more correct photometrically and would land somewhere else entirely for the
 * same 0.35, which is exactly why the constant and the space are stated together.
 */
export function blendHex(from: number, to: number, t: number): number {
  const mix = (shift: number): number => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * t) & 0xff;
  };
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

/**
 * The colour one tank's next trail mark should print.
 *
 * Neutral unless identity applies at all -- `identityApplies` is entities.ts's own gate,
 * imported rather than re-derived, so campaign stays neutral for the SAME reason identity
 * rings do (one player-kind tank is below the threshold) rather than by a separate mode
 * check that could drift from it. Enemy tanks are neutral in every mode: they have no slot
 * and no team, and `resolveOwnerColor` would hand them slot 0's colour.
 */
export function treadColorFor(world: World, tank: Tank): number {
  if (tank.kind !== 'player' || !identityApplies(world)) return TREAD_COLOR;
  return blendHex(TREAD_COLOR, resolveOwnerColor(world, tank), TREAD_IDENTITY_BLEND);
}
const TREAD_OPACITY = 0.5; // peak opacity of a fresh decal
// Just off the felt, matching the RING_Y/IDENTITY_RING_Y precedent (spawn-anim.ts,
// entities.ts) for a flat ground-hugging mesh, low enough to sit under the identity
// ring (0.03) and spawn ring (0.06) so it never visually competes with them.
const TREAD_Y = 0.015;

// Perpendicular offset from the tank's centre line to one tread's contact line.
// EXACTLY the offset entities.ts places its own `track` meshes at (side * (HULL_WIDTH
// / 2 - TRACK_W / 2)) -- imported, not re-derived, so a decal always sits directly
// under the tread that printed it even if either constant is retuned later.
const TREAD_OFFSET = HULL_WIDTH / 2 - TRACK_W / 2;

// Budget derivation (the acceptance criterion's "explicit object/draw-call budget"):
// one THREE.Mesh per decal is one draw call. A continuously-moving tank reaches a
// STEADY STATE of `2 sides * speed * LIFETIME_SECONDS / EMIT_SPACING` live decals --
// the oldest ages out at the same rate a new one prints. At the fastest
// `movementSpeed` tier any shipped tank kind currently selects (MEDIUM == TANK_SPEED
// == 3.0 world units/second, src/sim/config/data/balance.json's `tank.speed`; no
// tank-defs.json kind selects the faster FAST/VERY_FAST tiers -- balance.ts's own
// comment calls those "unselected vocabulary"), that is 2 * 3.0 * 2.0 / 0.25 = 48
// decals per tank. Co-op caps at 4 players (devflags.ts's players=1..4), so the
// lifetime-bound worst case of every player driving at once is 4 * 48 = 192 --
// comfortably under the cap below, which exists only to bound a STRESS case (a full
// co-op roster plus several AI enemies all driving at once), not to shape ordinary
// play. Past ~7 continuously-moving tanks (7 * 48 = 336 < 360 <= 8 * 48 = 384) the cap
// binds and the OLDEST decal recycles before its natural lifetime elapses, shortening
// visible trails under that load -- a deliberate degradation, not a bug.
export const MAX_TRAILS = 360;

function makeGeometry(): THREE.PlaneGeometry {
  // Built flat (XZ plane, facing +Y) ONCE via geo.rotateX, rather than leaving the
  // default XY-facing plane and rotating each MESH's `rotation.x` to lay it down: a
  // mesh also needs `rotation.y = -bodyAngle` to align with the tank's heading, and
  // Three's default XYZ Euler order composes those two as Rx then Ry, which tips a
  // Y-rotated, X-rotated plane up onto its edge instead of turning it flat on the
  // ground (visible at bodyAngle values away from 0, so a quick zero-angle check does
  // not catch it). Pre-rotating the GEOMETRY means every decal mesh only ever sets
  // `rotation.y`, matching how `entities.ts` orients the tank's own group.
  const geo = new THREE.PlaneGeometry(TREAD_LEN, TREAD_W);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export function createTreadTrailSystem(scene: THREE.Scene): TreadTrailSystem {
  const geo = makeGeometry();
  const pool: Decal[] = [];
  const active: Decal[] = [];
  // Last print anchor per tank id, in world space. Absent for a tank never yet seen
  // (or just revived/teleported) -- the very next tick only records its position,
  // it does not print from nowhere.
  const anchors = new Map<number, Vec2>();

  function makeDecal(): Decal {
    const mat = new THREE.MeshBasicMaterial({
      color: TREAD_COLOR,
      transparent: true,
      opacity: TREAD_OPACITY,
      // Same reasoning as particles.ts: a fading decal that writes depth punches an
      // opaque-shaped hole in the ground it sits just above once it has faded, and
      // would z-fight against the ground plane's own coplanar-ish geometry otherwise.
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'tread-decal';
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, life: LIFETIME_SECONDS, maxLife: LIFETIME_SECONDS };
  }

  function acquire(): Decal {
    if (active.length >= MAX_TRAILS) {
      // Recycle the OLDEST active decal rather than dropping the new emission -- the
      // issue asks for a bounded pool that reuses, not one that silently stops
      // leaving marks once busy. `active[0]` is always the oldest: every decal
      // shares the same `maxLife` and starts fully fresh, so elapsed life -- and
      // therefore expiry order -- is exactly creation order, and `update` below only
      // ever removes from the FRONT of that order (see its own comment). Moving the
      // reused decal to the back keeps that invariant true for the next call too.
      const oldest = active.shift() as Decal;
      active.push(oldest);
      return oldest;
    }
    const d = pool.pop() ?? makeDecal();
    active.push(d);
    return d;
  }

  function emitPair(x: number, y: number, bodyAngle: number, colorHex: number): void {
    // Perpendicular to the tank's heading (cos, sin), NOT to its direction of travel
    // -- a tread's footprint is fixed to the HULL, so it stays correct even while
    // reversing or mid-turn, when travel direction and heading briefly disagree.
    const perpX = -Math.sin(bodyAngle);
    const perpY = Math.cos(bodyAngle);
    for (const side of [-1, 1]) {
      const d = acquire();
      d.mesh.position.set(x + side * TREAD_OFFSET * perpX, TREAD_Y, y + side * TREAD_OFFSET * perpY);
      d.mesh.rotation.y = -bodyAngle;
      d.mesh.material.opacity = TREAD_OPACITY;
      // Set per EMISSION, not per decal: decals are pooled and reused, so a mark
      // recycled from another player's trail would otherwise keep that player's tint.
      d.mesh.material.color.setHex(colorHex);
      d.mesh.visible = true;
      d.life = LIFETIME_SECONDS;
      d.maxLife = LIFETIME_SECONDS;
    }
  }

  function clearAll(): void {
    for (const d of active) {
      d.mesh.visible = false;
      pool.push(d);
    }
    active.length = 0;
    anchors.clear();
  }

  function sync(prev: World, curr: World): void {
    // Same signal entities.ts's own `snap` uses: a round restart re-anchors this tick
    // (world.ts's resetArena), and a level switch hands render() a brand-new World
    // whose tick/roundStartTick never lines up with the old one's -- either way, old
    // decals belong to a board that no longer applies.
    if (prev.roundStartTick !== curr.roundStartTick) {
      clearAll();
    }
    for (const t of curr.tanks) {
      if (!t.alive) {
        // Tanks are never removed from world.tanks (death-pulse.ts's own comment),
        // only flipped `alive: false` -- so this is the one place a dead tank's
        // anchor is ever dropped. A later respawn is a fresh sighting (see the `if
        // (!anchor)` branch below), not a resumed trail from its death point.
        anchors.delete(t.id);
        continue;
      }
      const anchor = anchors.get(t.id);
      if (!anchor) {
        anchors.set(t.id, { x: t.pos.x, y: t.pos.y });
        continue;
      }
      // Resolved once per tank per sync rather than inside the emit loop: every mark in
      // one walk belongs to the same tank, and the identity gate reads the whole world.
      const tint = treadColorFor(curr, t);
      let dx = t.pos.x - anchor.x;
      let dy = t.pos.y - anchor.y;
      let dist = Math.hypot(dx, dy);
      // Walk the anchor forward in FIXED EMIT_SPACING steps, printing at each one,
      // and keep whatever distance is left over (< EMIT_SPACING) for the next call --
      // rather than snapping the anchor straight to `t.pos` after printing once. That
      // carry-over is what makes a slow mover (well under EMIT_SPACING per frame)
      // still print at the same physical spacing as a fast one: distance accumulates
      // across as many frames as it takes, instead of resetting the reference point
      // every frame and never reaching the threshold from a moving-target anchor.
      while (dist >= EMIT_SPACING) {
        const k = EMIT_SPACING / dist;
        anchor.x += dx * k;
        anchor.y += dy * k;
        emitPair(anchor.x, anchor.y, t.bodyAngle, tint);
        dx = t.pos.x - anchor.x;
        dy = t.pos.y - anchor.y;
        dist = Math.hypot(dx, dy);
      }
    }
  }

  function update(dt: number): void {
    // Iterating back-to-front and splicing only at `i` never disturbs the relative
    // order of the untouched elements before it, so `active[0]` staying "the oldest"
    // (acquire()'s own invariant) survives this loop across any number of calls.
    for (let i = active.length - 1; i >= 0; i--) {
      const d = active[i];
      d.life -= dt;
      if (d.life <= 0) {
        d.mesh.visible = false;
        active.splice(i, 1);
        pool.push(d);
        continue;
      }
      d.mesh.material.opacity = TREAD_OPACITY * (d.life / d.maxLife);
    }
  }

  function dispose(): void {
    for (const d of active) {
      d.mesh.material.dispose();
      scene.remove(d.mesh);
    }
    for (const d of pool) {
      d.mesh.material.dispose();
      scene.remove(d.mesh);
    }
    active.length = 0;
    pool.length = 0;
    anchors.clear();
    geo.dispose();
  }

  return { sync, update, dispose };
}
