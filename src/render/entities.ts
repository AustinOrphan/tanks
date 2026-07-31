import * as THREE from 'three';
import type { World } from '../sim/world';
import type { Wall, TankKind } from '../sim/types';
import { lerpAngle, lerpVec2 } from './interpolate';
import { BULLET_RADIUS } from '../sim/constants';
import { angleOf } from '../sim/types';
import type { TextureSet } from './textures';
import { blastRadiusAt } from '../sim/mines';
import { MINE_TIMER } from '../sim/constants';
import { MINE_BLAST_EXPAND_TICKS, MINE_BLAST_HOLD_TICKS } from '../sim/constants';

export interface EntityViews {
  sync(prev: World, curr: World, alpha: number): void;
  dispose(): void;
}

const TANK_COLORS: Record<TankKind, number> = {
  player: 0x3d7bd6,
  brown: 0x8a5a2b,
  grey: 0x8890a0,
  teal: 0x2bb0a6,
};

const TANK_BODY_H = 0.4;
const TURRET_H = 0.28;
/** How much of the turret ring is deliberately seated into the hull. */
const TURRET_SEAT = 0.03;
/** Shell centerline: match the gun bore height so shots leave the barrel, not the deck. */
export const BULLET_Y = 0.65;
/** Centre of the fireball: sat on the deck, so its lower half is buried like a real one. */
const BLAST_Y = 0.2;
/**
 * How long the fireball sits at full size before it starts to fade, in ticks.
 *
 * Purely visual, which is why it lives here and not in sim/constants: it splits the
 * SIM's hold phase into a beat at full opacity and a fade, without changing how long
 * the blast kills for. Must stay below MINE_BLAST_HOLD_TICKS, or the fade has no ticks
 * left to happen in and the blast vanishes instantly.
 */
const BLAST_LINGER_TICKS = 2;
/**
 * Vertical squash of the fireball, as a fraction of its radius.
 *
 * A charge going off ON the ground vents sideways -- it cannot dig down, so it spreads
 * further than it rises. A true sphere reads as a ball hovering on the felt.
 *
 * Cosmetic, and safe to be cosmetic: the sim is 2D, so lethality is a circle in the
 * horizontal plane. Only the y axis -- the one the sim does not have -- is scaled here.
 * The x/z extent stays exactly blastRadiusAt, so the fireball's footprint is still
 * precisely what it kills.
 */
const BLAST_FLATTEN = 0.7;
/**
 * Turret radius. 0.36 is 90% of the hull's 0.80 depth -- close to flush without
 * overhanging the sides. Chosen from two rendered sweeps, 0.26-0.44 then 0.32-0.38.
 */
/**
 * Hull dimensions, in world units, along the tank's own axes: +x is forward.
 *
 * The sim collides tanks as a CIRCLE of radius TANK_RADIUS, so nothing here can make the
 * collision wrong -- but it can make it MISLEADING, and it did: the hull was drawn 0.8
 * wide against a circle 1.0 across, so a tank looked like it should slip through gaps
 * that stop it.
 *
 * HULL_WIDTH is now EXACTLY TANK_RADIUS * 2, tracks included. Not approximately: any
 * other value is the visual over- or under-stating the collider, and there is no reason
 * to pick one. The test asserts the equality, so drift in either direction fails --
 * including too WIDE, which lies the opposite way and would otherwise pass unnoticed.
 */
export const HULL_LEN = 1.0;
export const HULL_WIDTH = 1.0;
/** Width of ONE track. The two of them make up the hull's full width at the edges. */
export const TRACK_W = 0.25;
/** Tracks are shorter than the body is tall and sit on the ground; the body rides above. */
export const TRACK_H = 0.34;
/**
 * How much darker the tracks are than the hull paint.
 *
 * Too dark and they read as the tank's own shadow rather than as part of it -- which is
 * exactly what 0.45 did at play distance. Chosen from a sweep of 0.45/0.70/0.90 shot
 * through the real camera; the height mattered far less than the shade.
 */
export const TRACK_SHADE = 0.7;
/** Corner radius of the hull body in plan. */
export const HULL_CORNER = 0.3;
/** Width of the hull's front shoulder, as a fraction of its mid-body width. */
export const HULL_NOSE = 1; //0.85;
/** Edge bevel on the hull body. */
export const HULL_BEVEL = 0.035;
/** Edge bevel on the tracks. Smaller: they are narrow, and a big bevel eats the face. */
export const TRACK_BEVEL = 0.025;
/**
 * Ground clearance under the hull body.
 *
 * The body used to start at 55% of the track's height, which put most of its mass ABOVE
 * the track and made the tank read as stacked slabs -- a pancake stack rather than a
 * hull. Dropping it to a small clearance sets the body ALONGSIDE the track run, which is
 * how a real tank is arranged and what stops the tracks looking like a plinth.
 */
export const HULL_RIDE = 0.14;
/**
 * How far the tracks stand PROUD of the body, from 0 to 1.
 *
 *   0    tracks entirely under the hull -- realistic, and nearly invisible from above
 *   0.5  half proud, half tucked
 *   1    tracks entirely outside the body -- toy-tank, most readable from overhead
 *
 * The total footprint is HULL_WIDTH either way; this only decides how it is divided
 * between body and track. Which matters because the game camera looks down at ~50deg:
 * anything tucked under the hull is hidden at exactly the angle the game is played from.
 */
export const TRACK_PROUD = 0.25;
/** How far the tracks overhang the body front and back. */
export const TRACK_OVERHANG = 0.05;

export const TURRET_R = 0.36;
/**
 * How far the barrel protrudes BEYOND the turret.
 *
 * The barrel is positioned from this rather than absolutely, so growing the turret
 * does not silently shorten the gun -- at a fixed position, going 0.26 -> 0.38 ate a
 * third of the visible barrel.
 *
 * 0.50 chosen at PLAY distance, not in close-up. The barrel is the shipped aim
 * indicator -- aimRay exists only as a dev flag because of that -- and at 0.40 it read
 * as a nub from the real camera even though it looked generous up close.
 */
export const BARREL_OUT = 0.50;
/** Length of the flared muzzle at the tip. */
export const MUZZLE_LEN = 0.18;
/** How much wider the muzzle is than the barrel behind it. */
export const MUZZLE_FLARE = 1.40;

/** A rectangle with rounded corners, centred on the origin, in the shape's own XY. */
function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const rad = Math.min(r, w / 2, h / 2);
  const x = -w / 2;
  const y = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x + rad, y);
  s.lineTo(x + w - rad, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rad);
  s.lineTo(x + w, y + h - rad);
  s.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  s.lineTo(x + rad, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - rad);
  s.lineTo(x, y + rad);
  s.quadraticCurveTo(x, y, x + rad, y);
  return s;
}

/**
 * A box with rounded corners in-plane AND bevelled edges along the extrusion, centred
 * on the origin, whose finished size is exactly (w, h, depth).
 *
 * The bevel is subtracted from the shape and the extrusion depth first, because
 * ExtrudeGeometry ADDS bevelSize outward and bevelThickness at each end. Without that
 * correction every rounded part comes out larger than asked, which matters here: the
 * hull's width is asserted to equal the sim's collision diameter exactly.
 */
function roundedBox(w: number, h: number, depth: number, corner: number, bevel: number): THREE.ExtrudeGeometry {
  const b = Math.min(bevel, w / 4, h / 4, depth / 4);
  const shape = roundedRect(w - b * 2, h - b * 2, Math.max(0.001, corner - b));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: depth - b * 2,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 2,
    curveSegments: 6,
  });
  geo.translate(0, 0, -depth / 2 + b);
  return geo;
}

/** Bevelled extrusion of an arbitrary plan shape, centred in z like roundedBox(). */
function beveledExtrude(shape: THREE.Shape, depth: number, bevel: number): THREE.ExtrudeGeometry {
  const b = Math.min(bevel, depth / 4);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: depth - b * 2,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 2,
    curveSegments: 8,
  });
  geo.translate(0, 0, -depth / 2 + b);
  return geo;
}

/**
 * Hull plan: a rounded rear with a tapered nose.
 *
 * +x is forward. `nose` sets the shoulder width at the front relative to the mid-body.
 */
function hullPlan(len: number, width: number, round: number, nose: number): THREE.Shape {
  const halfL = len / 2;
  const halfW = width / 2;
  const shoulderW = halfW * clamp01(nose);
  const r = Math.min(round, halfW * 0.9, halfL * 0.45);
  const s = new THREE.Shape();
  s.moveTo(-halfL + r, -halfW);
  s.lineTo(halfL - r, -shoulderW);
  s.quadraticCurveTo(halfL, -shoulderW, halfL, 0);
  s.quadraticCurveTo(halfL, shoulderW, halfL - r, shoulderW);
  s.lineTo(-halfL + r, halfW);
  s.quadraticCurveTo(-halfL, halfW, -halfL, halfW - r);
  s.lineTo(-halfL, -halfW + r);
  s.quadraticCurveTo(-halfL, -halfW, -halfL + r, -halfW);
  return s;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const MINE_Y = 0.09;
/** How many full bright/dark cycles a mine goes through over its whole fuse. */
const MINE_PULSE_TURNS = 6;
const MINE_ARMED_LO = new THREE.Color(0x3a0a0a);
const MINE_ARMED_HI = new THREE.Color(0xff3322);
const MINE_IDLE_LO = new THREE.Color(0x000000);
const MINE_IDLE_HI = new THREE.Color(0x2a0808);
const WALL_H = 1.0;

function indexById<T extends { id: number }>(arr: T[]): Map<number, T> {
  const m = new Map<number, T>();
  for (const e of arr) m.set(e.id, e);
  return m;
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
  });
  obj.parent?.remove(obj);
}

export function createEntityViews(scene: THREE.Scene, textures?: TextureSet): EntityViews {
  const tankViews = new Map<number, { group: THREE.Group; turret: THREE.Object3D }>();
  const bulletViews = new Map<number, THREE.Group>();
  const blastViews = new Map<number, THREE.Mesh>();
  const mineViews = new Map<number, THREE.Mesh>();
  const wallViews = new Map<number, THREE.Mesh>();

  /**
   * Barrel radius. Must exceed the shell's, with wall thickness to spare -- see the
   * assertion in entities.test.ts, which exists because this was wrong.
   */
  const BARREL_R = BULLET_RADIUS * 1.3;
  /** Rounds the top edge, so the turret is a cylinder with a crown rather than a can. */
  const TURRET_FILLET = 0.09;

  /**
   * The turret: a cylinder with a rounded top edge.
   *
   * It was a box, which read as a crate balanced on the hull -- and at this camera angle
   * a square turret and a square hull are one silhouette. Round it and the turret
   * separates from the body, which is what makes the tank legible when it rotates.
   */
  function turretGeometry(): THREE.LatheGeometry {
    const half = TURRET_H / 2;
    const pts: THREE.Vector2[] = [
      new THREE.Vector2(0, -half),
      new THREE.Vector2(TURRET_R, -half),
      new THREE.Vector2(TURRET_R, half - TURRET_FILLET),
    ];
    const STEPS = 5;
    for (let i = 1; i <= STEPS; i++) {
      const a = (i / STEPS) * (Math.PI / 2);
      pts.push(
        new THREE.Vector2(
          TURRET_R - TURRET_FILLET + TURRET_FILLET * Math.cos(a),
          half - TURRET_FILLET + TURRET_FILLET * Math.sin(a),
        ),
      );
    }
    pts.push(new THREE.Vector2(0, half));
    return new THREE.LatheGeometry(pts, 20);
  }

  /**
   * The gun: a tube from inside the turret to the muzzle, with the last MUZZLE_LEN
   * stepped out into a flare.
   *
   * One lathe rather than two cylinders, so the step is a real edge in the silhouette
   * rather than a seam between meshes that can drift apart.
   */
  function barrelGeometry(): THREE.LatheGeometry {
    const breech = TURRET_R * 0.3; // seated inside the turret
    const muzzle = TURRET_R + BARREL_OUT;
    const flareStart = muzzle - MUZZLE_LEN;
    const rMuzzle = BARREL_R * MUZZLE_FLARE;
    return new THREE.LatheGeometry(
      [
        new THREE.Vector2(0, breech), // closed at the breech
        new THREE.Vector2(BARREL_R, breech),
        new THREE.Vector2(BARREL_R, flareStart),
        new THREE.Vector2(rMuzzle, flareStart), // step out
        new THREE.Vector2(rMuzzle, muzzle),
        new THREE.Vector2(0, muzzle), // and closed at the tip
      ],
      16,
    );
  }

  function makeTank(kind: TankKind): { group: THREE.Group; turret: THREE.Object3D } {
    const group = new THREE.Group();
    const color = TANK_COLORS[kind];

    // Painted steel: rough enough to stay matte, metallic enough to pick up the rim.
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.25 });
    // The hull is a body riding between two tracks, rather than one box.
    //
    // A single box gave the tank no ground contact to read: it was a brick with a turret,
    // and at this camera angle the hull and turret were one silhouette. Tracks are what
    // say "this thing drives", and they carry the width so the body can stay narrower and
    // sit higher, which separates it from the ground.
    const bodyWidth = HULL_WIDTH - TRACK_W * TRACK_PROUD * 2;
    const bodyH = TANK_BODY_H;
    // Rounded in plan and bevelled at the edges. A hard-edged box reads as a placeholder
    // at any distance; the corners are what make it look built rather than blocked out.
    // Shape is (length, width) and extrudes along its own +z, so rotating -90deg about x
    // stands the extrusion up into height.
    const bodyGeo = beveledExtrude(hullPlan(HULL_LEN, bodyWidth, HULL_CORNER, HULL_NOSE), bodyH, HULL_BEVEL);
    bodyGeo.rotateX(-Math.PI / 2);
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.name = 'hull';
    body.position.y = HULL_RIDE + bodyH / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Tracks: darker and rougher than the painted hull, because they are steel that
    // spends its life in the dirt. Same colour family so the tank still reads as one
    // object at a glance.
    const trackMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).multiplyScalar(TRACK_SHADE),
      roughness: 0.95,
      metalness: 0.35,
    });
    for (const side of [-1, 1]) {
      // TRACK SHAPED: a stadium in side profile -- fully rounded front and back, like the
      // run of a real track round its drive sprockets. The corner radius is half the
      // height, which is what turns a rounded rectangle into a stadium; anything less
      // reads as a box with softened corners.
      const trackGeo = roundedBox(
        HULL_LEN + TRACK_OVERHANG * 2,
        TRACK_H,
        TRACK_W,
        TRACK_H / 2,
        TRACK_BEVEL,
      );
      const track = new THREE.Mesh(trackGeo, trackMat);
      track.name = 'track';
      track.position.set(0, TRACK_H / 2, side * (HULL_WIDTH / 2 - TRACK_W / 2));
      track.castShadow = true;
      track.receiveShadow = true;
      group.add(track);
    }

    const turret = new THREE.Group();
    // + TURRET_H / 2, because the dome is CENTRED on the turret group's origin. Placing
    // that origin at the hull top buried half the turret in the hull -- 43% of its height
    // at these proportions. TURRET_SEAT is the deliberate part: a little of the turret
    // ring sunk in, so it looks seated rather than balanced on top.
    turret.position.y = HULL_RIDE + bodyH + TURRET_H / 2 - TURRET_SEAT;
    // The turret reads as the same paint, less worn -- smoother, so the highlight that
    // separates it from the hull below sits on the turret rather than the body.
    const turretMat = new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.35 });
    const dome = new THREE.Mesh(turretGeometry(), turretMat);
    dome.name = 'turret';
    dome.castShadow = true;
    turret.add(dome);
    // The bore has to clear the shell it fires. It did not: the barrel was radius 0.07
    // against a shell of BULLET_RADIUS 0.10, so the round was WIDER than the tube it
    // came out of -- visible the moment shells were drawn at their true size.
    const barrel = new THREE.Mesh(barrelGeometry(), turretMat);
    // The profile is built along the lathe's own +y from breech to muzzle, so rotating
    // -90deg about z lays it along local +x already positioned -- no offset to keep in
    // step with the length, which is how the barrel got shorter when the turret grew.
    barrel.rotation.z = -Math.PI / 2;
    barrel.name = 'barrel';
    barrel.castShadow = true;
    turret.add(barrel);
    group.add(turret);

    scene.add(group);
    return { group, turret };
  }

  /** Visual proportions of a shell. The sim's BULLET_RADIUS (0.1) is its collision size;
   *  drawn dead-on it is nearly invisible, so the body is scaled up and given length. */
  const SHELL_R = BULLET_RADIUS * 1.0;
  const SHELL_BODY_LEN = BULLET_RADIUS * 4.5;

  /**
   * A shell: a cylinder with a rounded nose, pointed along its own velocity.
   *
   * Built as a Group rather than one mesh so the nose can be a hemisphere. The parts are
   * laid out along local +x and the group is then yawed, which keeps the orientation maths
   * in one place and matching the barrel (entities.ts lays that along +x too).
   */
  function makeBullet(): THREE.Group {
    const group = new THREE.Group();
    // Brass: the one genuinely metallic thing on the board, and small enough that it
    // needs the specular to be visible at all against the felt.
    const mat = new THREE.MeshStandardMaterial({
      color: 0xf5f0d0, emissive: 0x444422, roughness: 0.3, metalness: 0.7,
    });

    const body = new THREE.Mesh(new THREE.CylinderGeometry(SHELL_R, SHELL_R, SHELL_BODY_LEN, 14), mat);
    body.rotation.z = Math.PI / 2; // lay the cylinder along local +x
    body.castShadow = true;
    group.add(body);

    // A COMPLETE sphere at the tip, half of it buried in the body, is what makes the
    // rounded nose. The obvious economy -- SphereGeometry(r, ..., 0, Math.PI) for "just
    // the half you can see" -- is a single-sided open shell: from directly overhead, which
    // is the angle this game is played at, you look straight into its hollow interior and
    // every shell reads as a piece of macaroni. Screenshot the top view before changing it.
    const nose = new THREE.Mesh(new THREE.SphereGeometry(SHELL_R, 14, 10), mat);
    nose.position.x = SHELL_BODY_LEN / 2;
    nose.castShadow = true;
    group.add(nose);

    // No tail cap is added: CylinderGeometry is closed unless openEnded is passed, so an
    // extra disc there was redundant geometry and a second single-sided surface.

    scene.add(group);
    return group;
  }

  /**
   * The visible fireball. Built at unit radius and scaled per frame, so growth costs a
   * scale assignment rather than a geometry rebuild every tick.
   */
  function makeBlast(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshStandardMaterial({
        color: 0xff8844,
        emissive: 0xff5511,
        transparent: true,
        opacity: 1,
        depthWrite: false, // it is a glow, not a solid: do not let it occlude what is inside it
      }),
    );
    scene.add(mesh);
    return mesh;
  }

  const MINE_R = 0.28;
  /**
   * Height of the straight side wall, before the dome starts.
   *
   * A third of the puck's total height; the dome is the other two thirds. The two must
   * sum to MINE_Y * 2, which is the height the original cylinder had -- the silhouette
   * changed shape, not size.
   */
  const MINE_BASE_H = (MINE_Y * 2) / 3;
  /**
   * How far the dome rises above the side wall.
   *
   * FLATTENED, not hemispherical: at 0.08 against a 0.28 radius the dome is under a third
   * as tall as it is wide. A full hemisphere would read as a ball half-sunk in the felt;
   * a mine is a squat thing you could drive over.
   */
  const MINE_DOME_H = MINE_Y * 2 - MINE_BASE_H;

  /**
   * A mine: a short cylindrical base capped by a low, wide dome.
   *
   * The original was a plain cylinder, whose hard rim catches the light as a bright ring
   * and reads as a disc cut out and laid on the surface. Doming the top is what makes it
   * read as an object sitting ON the ground.
   *
   * Built as a lathe rather than a cylinder plus a sphere section so it is one closed
   * surface with no seam to misalign, and so the dome's height is a single number.
   */
  function mineGeometry(): THREE.LatheGeometry {
    const half = MINE_Y;
    const shoulder = -half + MINE_BASE_H; // where the side wall ends and the dome begins
    const pts: THREE.Vector2[] = [
      new THREE.Vector2(0, -half), // bottom centre
      new THREE.Vector2(MINE_R, -half), // out to the rim
      new THREE.Vector2(MINE_R, shoulder), // up the side
    ];
    // Elliptical dome: full radius at the shoulder, narrowing to the apex on the axis.
    // Wide semi-axis MINE_R, short semi-axis MINE_DOME_H -- the flattening IS that ratio.
    const DOME_STEPS = 10;
    for (let i = 1; i <= DOME_STEPS; i++) {
      const a = (i / DOME_STEPS) * (Math.PI / 2);
      pts.push(new THREE.Vector2(MINE_R * Math.cos(a), shoulder + MINE_DOME_H * Math.sin(a)));
    }
    return new THREE.LatheGeometry(pts, 24);
  }

  function makeMine(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      mineGeometry(),
      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.45, metalness: 0.55 }),
    );
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  }

  function makeWall(wall: Wall): THREE.Mesh {
    const w = wall.aabb.maxX - wall.aabb.minX;
    const d = wall.aabb.maxY - wall.aabb.minY;
    const geo = new THREE.BoxGeometry(w, WALL_H, d);
    const mat =
      wall.kind === 'destructible'
        // Destructible reads as crate timber: fully matte, no metal, and PLANK GROOVES --
        // the cue that says this is the wall a shell can open, carried by the surface
        // rather than by hue alone.
        ? new THREE.MeshStandardMaterial({
            color: 0xb08040,
            roughness: 1.0,
            metalness: 0.0,
            normalMap: textures?.timberNormal ?? null,
            normalScale: new THREE.Vector2(0.9, 0.9),
          })
        // ...and solid as poured concrete with rebar sheen and aggregate relief.
        : new THREE.MeshStandardMaterial({
            color: 0x565b66,
            roughness: 0.8,
            metalness: 0.3,
            normalMap: textures?.concreteNormal ?? null,
            normalScale: new THREE.Vector2(0.55, 0.55),
          });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(
      (wall.aabb.minX + wall.aabb.maxX) / 2,
      WALL_H / 2,
      (wall.aabb.minY + wall.aabb.maxY) / 2,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }

  function syncTanks(prev: World, curr: World, alpha: number, snap: boolean): void {
    const prevMap = indexById(prev.tanks);
    const seen = new Set<number>();
    for (const t of curr.tanks) {
      if (!t.alive) continue;
      seen.add(t.id);
      let view = tankViews.get(t.id);
      if (!view) {
        view = makeTank(t.kind);
        tankViews.set(t.id, view);
      }
      // New id (no prev): snap to curr pose, do not lerp from a garbage origin.
      // `snap` covers the other discontinuity: resetArena teleports every tank
      // back to its spawn within one tick while keeping its id and reviving it,
      // so a plain lerp drew the tank streaking across the arena for a frame on
      // every life lost. A tick can move a tank at most TANK_SPEED*DT, so any
      // round-boundary jump is a teleport by definition, not motion.
      const p = snap ? undefined : prevMap.get(t.id);
      const pos = p ? lerpVec2(p.pos, t.pos, alpha) : t.pos;
      const bodyA = p ? lerpAngle(p.bodyAngle, t.bodyAngle, alpha) : t.bodyAngle;
      const turretA = p ? lerpAngle(p.turretAngle, t.turretAngle, alpha) : t.turretAngle;
      view.group.position.set(pos.x, 0, pos.y);
      view.group.rotation.y = -bodyA;
      // The turret is a CHILD of group, so its world heading composes with the
      // body's. turretAngle is an absolute world angle (angleOf(aim - pos)), so
      // it has to be expressed relative to the parent -- writing it directly
      // aimed the barrel at bodyAngle + turretAngle, i.e. anywhere but the
      // crosshair the moment the tank was driving in any direction but +x.
      view.turret.rotation.y = -(turretA - bodyA);
    }
    for (const [id, view] of tankViews) {
      if (!seen.has(id)) {
        disposeObject(view.group);
        tankViews.delete(id);
      }
    }
  }

  function syncBullets(prev: World, curr: World, alpha: number): void {
    const prevMap = indexById(prev.bullets);
    const seen = new Set<number>();
    for (const b of curr.bullets) {
      if (!b.alive) continue;
      seen.add(b.id);
      let mesh = bulletViews.get(b.id);
      if (!mesh) {
        mesh = makeBullet();
        bulletViews.set(b.id, mesh);
      }
      const p = prevMap.get(b.id);
      const pos = p && p.alive ? lerpVec2(p.pos, b.pos, alpha) : b.pos;
      mesh.position.set(pos.x, BULLET_Y, pos.y);
      // Same convention as the turret: world (x, y) -> three (x, z), and a world angle
      // maps to rotation.y = -angle, because a CCW turn in the sim's xy-plane is
      // clockwise about three's +y. A shell's heading is its velocity; it never has
      // zero velocity while alive, so there is no degenerate case to guard.
      mesh.rotation.y = -angleOf(b.vel);
    }
    for (const [id, mesh] of bulletViews) {
      if (!seen.has(id)) {
        disposeObject(mesh);
        bulletViews.delete(id);
      }
    }
  }

  /**
   * Draw each live blast at the radius the SIM says it currently has.
   *
   * The radius comes from blastRadiusAt, the same function the damage uses, so what you
   * see is what kills you -- a separate visual curve here would be a lie that no test
   * could catch. It is interpolated between the two ticks like every other quantity,
   * because at 60Hz a 5-tick expansion stepped discretely reads as a stutter.
   */
  function syncBlasts(prev: World, curr: World, alpha: number): void {
    const prevMap = indexById(prev.blasts);
    const seen = new Set<number>();
    for (const b of curr.blasts) {
      seen.add(b.id);
      let mesh = blastViews.get(b.id);
      if (!mesh) {
        mesh = makeBlast();
        blastViews.set(b.id, mesh);
      }
      const p = prevMap.get(b.id);
      // A blast in its first frame has no previous tick: grow it from nothing rather
      // than popping in at full age-0 size.
      const from = p ? blastRadiusAt(p.age) : 0;
      const radius = from + (blastRadiusAt(b.age) - from) * alpha;
      mesh.position.set(b.pos.x, BLAST_Y, b.pos.y);
      const r = Math.max(radius, 1e-4);
      mesh.scale.set(r, r * BLAST_FLATTEN, r);
      // Solid while it expands, then it SITS at full size for a beat before dissipating.
      // Fading straight from the moment it stops growing loses the punch -- the blast
      // wants to arrive, hang, and then go. It still reaches zero exactly at the end of
      // its life, so it is never invisible while it is still killing.
      const held = b.age - MINE_BLAST_EXPAND_TICKS + alpha;
      const fading = held - BLAST_LINGER_TICKS;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.opacity = fading <= 0 ? 1 : Math.max(0, 1 - fading / (MINE_BLAST_HOLD_TICKS - BLAST_LINGER_TICKS));
    }
    for (const [id, mesh] of blastViews) {
      if (!seen.has(id)) {
        disposeObject(mesh);
        blastViews.delete(id);
      }
    }
  }

  function syncMines(_prev: World, curr: World, _alpha: number): void {
    const seen = new Set<number>();
    for (const m of curr.mines) {
      if (m.detonated) continue;
      seen.add(m.id);
      let mesh = mineViews.get(m.id);
      if (!mesh) {
        mesh = makeMine();
        mineViews.set(m.id, mesh);
      }
      mesh.position.set(m.pos.x, MINE_Y, m.pos.y);
      // The fuse, made visible: the mine pulses, and pulses FASTER as it runs out.
      //
      // Driven entirely by mine.timer, never by a clock. The sim owns the countdown, so
      // the blink is a projection of world state like everything else here -- two
      // machines replaying the same world blink in step, and a paused game does not
      // keep flashing.
      //
      // Phase is quadratic in elapsed fuse, which makes the RATE climb linearly: the
      // mine ticks lazily when dropped and is strobing by the time it goes off.
      const elapsed = clamp01(1 - m.timer / MINE_TIMER);
      const pulse = 0.5 - 0.5 * Math.cos(2 * Math.PI * MINE_PULSE_TURNS * elapsed * elapsed);
      const mat = mesh.material as THREE.MeshStandardMaterial;
      // Armed stays the loud one. An unarmed mine still burns its fuse -- it detonates on
      // expiry whether or not it ever armed -- so it pulses too, but dimly, and the
      // black-vs-red base still says at a glance which one can be set off by walking near.
      const lo = m.armed ? MINE_ARMED_LO : MINE_IDLE_LO;
      const hi = m.armed ? MINE_ARMED_HI : MINE_IDLE_HI;
      mat.emissive.copy(lo).lerp(hi, pulse);
    }
    for (const [id, mesh] of mineViews) {
      if (!seen.has(id)) {
        disposeObject(mesh);
        mineViews.delete(id);
      }
    }
  }

  function syncWalls(curr: World): void {
    for (const wall of curr.walls) {
      const existing = wallViews.get(wall.id);
      if (wall.destroyed) {
        if (existing) {
          disposeObject(existing);
          wallViews.delete(wall.id);
        }
        continue;
      }
      if (!existing) {
        wallViews.set(wall.id, makeWall(wall));
      }
    }
  }

  function sync(prev: World, curr: World, alpha: number): void {
    // Clamp at the boundary rather than trusting the caller. alpha is in [0,1)
    // today only because loop.ts's accumulator drains below DT before
    // computing it; any future change there (variable DT, a pause/resume path,
    // a max-steps clamp) would silently turn interpolation into extrapolation,
    // with entities overshooting and snapping back every tick.
    const a = Math.min(1, Math.max(0, alpha));
    // resetArena re-anchors roundStartTick, which is the one signal that
    // distinguishes a round boundary (teleports) from ordinary motion.
    const snap = prev.roundStartTick !== curr.roundStartTick;
    syncWalls(curr);
    syncTanks(prev, curr, a, snap);
    syncBullets(prev, curr, a);
    syncMines(prev, curr, a);
    syncBlasts(prev, curr, a);
  }

  function dispose(): void {
    for (const v of tankViews.values()) disposeObject(v.group);
    for (const m of bulletViews.values()) disposeObject(m);
    for (const m of mineViews.values()) disposeObject(m);
    for (const m of blastViews.values()) disposeObject(m);
    for (const m of wallViews.values()) disposeObject(m);
    tankViews.clear();
    bulletViews.clear();
    mineViews.clear();
    blastViews.clear();
    wallViews.clear();
  }

  return { sync, dispose };
}
