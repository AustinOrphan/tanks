import * as THREE from 'three';
import { BULLET_RADIUS, SHELL_MUZZLE_FORWARD, TANK_RADIUS } from '../sim/constants';

/**
 * The tank's SHAPE, and the one place it is defined (issue #385).
 *
 * `entities.ts` builds the tank the game renders; this module owns the geometry that tank
 * is made of, and `entities.ts` imports it back. The split exists because branding,
 * documentation and logo work need the same shape OUTSIDE a browser, and the alternative
 * -- an exporter carrying its own copy of the numbers -- is a model that drifts from the
 * game silently and is discovered wrong by whoever traced a logo from it.
 *
 * WHY THE DEFINITIONS MOVED HERE RATHER THAN THE BUILDER MOVING TO THEM. `entities.ts`
 * must depend on this module (it calls `tankParts`), so this module cannot depend back
 * without a cycle whose const-initialisation order would be load-bearing and unpinned.
 * Everything the shape needs therefore lives here, and `entities.ts` re-exports the names
 * it used to own, so its existing consumers are untouched by the move.
 *
 * WHAT IS HERE AND WHAT IS NOT. Geometry and transforms only. Materials, skins, identity
 * rings, spawn effects and every per-tank decision stay in `entities.ts`, because none of
 * them is part of the canonical model. That division is also what keeps this module
 * importable from a `vite-node` tool: nothing here touches a texture, a canvas or a WebGL
 * context.
 */

/** Clamp to [0, 1]. A private copy; `entities.ts` keeps its own for the mine fuse. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Radial segments in the turret's lathe. */
export const TURRET_SEGMENTS = 20;
/** Radial segments in the barrel's lathe. */
export const BARREL_SEGMENTS = 16;

export const TANK_BODY_H = 0.4;

export const TURRET_H = 0.28;

/** How much of the turret ring is deliberately seated into the hull. */
export const TURRET_SEAT = 0.03;

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
 * RACING STRIPES RUN THE WHOLE TANK AS ONE STRIPE. The verdict, after seeing both rendered:
 * "I like continuous stripes actually."
 *
 *   'body'  SHIPPED. One continuous field. Every part is projected at world scale
 *           (k = 1), so the SAME pair of stripes runs from the nose, up over the turret
 *           and out along the gun at one constant width of 0.084 world units. It reads
 *           as one striped object, which is what a racing stripe on a real vehicle is:
 *           one unbroken line down the whole body.
 *
 *   'part'  BUILT AND REJECTED, kept because it is the arrangement that shipped before
 *           and someone will otherwise wonder whether it was considered. Each part's
 *           stripe is normalised to that part's own half-width, so the pair covers the
 *           same FRACTION of hull, turret and barrel -- which means the three sets are
 *           the same size relative to their part and do NOT line up with each other.
 *           Measured in world units the stripe is 0.084 wide on the hull, 0.069 on the
 *           turret and 0.025 on the barrel: the gun's are 3.4x NARROWER than the hull's,
 *           and the mismatch steps visibly where the barrel leaves the turret. Clearest
 *           in the `top` view, which is how the choice was made.
 *
 * Normalising to HULL_HALF_W is what makes 'body' work: `projectPlanarUV` divides by
 * `acrossHalf`, so handing it the hull's own half-width leaves the scale factor at 1 and
 * every part lands in the hull's world-space v.
 */
export type StripeTurretMode = 'part' | 'body';

export const STRIPE_TURRET_MODE: StripeTurretMode = 'body';

/**
 * Height of the barrel's centreline, and therefore of every shell in flight.
 *
 * DERIVED, because it has to equal the gun it comes out of: this is the same stack the
 * turret group is positioned by in createTankView. It was a hardcoded 0.35 against a
 * barrel at 0.65 -- shells flew a third of a tank's height BELOW the muzzle. A hardcoded
 * 0.65 is right today and silently wrong the day any of these four terms is retuned.
 * (Declared here, below HULL_RIDE, because a module-level const cannot read one
 * declared after it.)
 */
export const BULLET_Y = HULL_RIDE + TANK_BODY_H + TURRET_H / 2 - TURRET_SEAT;

/**
 * How far the barrel protrudes BEYOND the turret.
 *
 * The barrel is positioned from this rather than absolutely, so growing the turret
 * does not silently shorten the gun -- at a fixed position, going 0.26 -> 0.38 ate a
 * third of the visible barrel.
 *
 * DERIVED from the sim's SHELL_MUZZLE_FORWARD -- the muzzle PLANE, not the shell's spawn
 * centre. The sim decides where the gun ends, and the drawn opening has to be that same
 * plane or the render lies about where the gun fires from. To lengthen the gun, change
 * SHELL_MUZZLE_FORWARD, which moves the opening, the spawn and the flash together.
 *
 * DELIBERATELY NOT SHELL_SPAWN_FORWARD (issue #237). That constant is now the shell's
 * CENTRE, one bullet-radius behind the opening, so deriving the barrel from it would
 * silently shorten the drawn gun by exactly that radius -- the regression this comment
 * used to warn about, arriving through the fix rather than through a retune. The reach
 * was chosen at PLAY distance, not in
 * close-up: the barrel is the shipped aim indicator (aimRay is a dev flag precisely
 * because of that), and a shorter one read as a nub from the real camera even though
 * it looked generous up close.
 */
export const BARREL_OUT = SHELL_MUZZLE_FORWARD - TURRET_R;

/** Length of the flared muzzle at the tip. */
export const MUZZLE_LEN = 0.18;

/** How much wider the muzzle is than the barrel behind it. */
export const MUZZLE_FLARE = 1.40;

/** A rectangle with rounded corners, centred on the origin, in the shape's own XY. */
export function roundedRect(w: number, h: number, r: number): THREE.Shape {
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
export function roundedBox(w: number, h: number, depth: number, corner: number, bevel: number): THREE.ExtrudeGeometry {
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
export function beveledExtrude(shape: THREE.Shape, depth: number, bevel: number): THREE.ExtrudeGeometry {
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
export function hullPlan(len: number, width: number, round: number, nose: number): THREE.Shape {
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

/**
 * Barrel radius. Must exceed the shell's, with wall thickness to spare -- see the
 * assertion in entities.test.ts, which exists because this was wrong.
 */
export const BARREL_R = BULLET_RADIUS * 1.3;

/** Rounds the top edge, so the turret is a cylinder with a crown rather than a can. */
export const TURRET_FILLET = 0.09;

/**
 * The turret's lathe profile, in (radius, height) -- split out from the geometry so the
 * BARREL can measure it. Matching the barrel's texel density to the turret's needs the
 * turret's circumference and profile arc length, and re-deriving either by hand would
 * go stale the moment TURRET_R or TURRET_FILLET moved.
 */
export function turretProfile(): THREE.Vector2[] {
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
  return pts;
}

/**
 * The turret: a cylinder with a rounded top edge.
 *
 * It was a box, which read as a crate balanced on the hull -- and at this camera angle
 * a square turret and a square hull are one silhouette. Round it and the turret
 * separates from the body, which is what makes the tank legible when it rotates.
 */
export function turretGeometry(): THREE.LatheGeometry {
  return new THREE.LatheGeometry(turretProfile(), TURRET_SEGMENTS);
}

/**
 * The gun: a tube from inside the turret to the muzzle, with the last MUZZLE_LEN
 * stepped out into a flare.
 *
 * One lathe rather than two cylinders, so the step is a real edge in the silhouette
 * rather than a seam between meshes that can drift apart.
 */
export function barrelProfile(): THREE.Vector2[] {
  const breech = TURRET_R * 0.3; // seated inside the turret
  const muzzle = TURRET_R + BARREL_OUT;
  const flareStart = muzzle - MUZZLE_LEN;
  const rMuzzle = BARREL_R * MUZZLE_FLARE;
  return [
    new THREE.Vector2(0, breech), // closed at the breech
    new THREE.Vector2(BARREL_R, breech),
    new THREE.Vector2(BARREL_R, flareStart),
    new THREE.Vector2(rMuzzle, flareStart), // step out
    new THREE.Vector2(rMuzzle, muzzle),
    new THREE.Vector2(0, muzzle), // and closed at the tip
  ];
}

/**
 * Where the barrel's UV seam falls, as a lathe angle.
 *
 * `matchLatheToTurret` scales u to a FRACTION of a texture repeat, which means u no
 * longer meets itself at the meridian where the lathe closes -- there is a seam, and it
 * has to go somewhere. The barrel mesh is rotated -90deg about z, which sends lathe
 * local +x to world -y, so phi = PI/2 puts the seam on the gun's UNDERSIDE, where the
 * game's ~50deg overhead camera never looks.
 *
 * PI/2 is exactly 4 of the barrel's 16 segments, so this is a relabelling of which
 * vertex starts the ring: the SURFACE IS UNCHANGED, only the seam moves. Pick an angle
 * that is not a whole number of segments and the silhouette rotates with it.
 */
export const BARREL_SEAM_PHI = Math.PI / 2;

export function barrelGeometry(): THREE.LatheGeometry {
  return new THREE.LatheGeometry(barrelProfile(), BARREL_SEGMENTS, BARREL_SEAM_PHI);
}

/**
 * The body is narrower than the hull envelope by however much the tracks stand proud.
 *
 * Derived rather than authored: `HULL_WIDTH` is exactly `TANK_RADIUS * 2` and must stay
 * so, which means the body gives way to the tracks rather than the envelope growing.
 */
export const BODY_WIDTH = HULL_WIDTH - TRACK_W * TRACK_PROUD * 2;

/**
 * The turret group's height above the ground plane.
 *
 * The same stack `BULLET_Y` is built from, and deliberately so: the gun the shells leave
 * and the gun that is drawn have to be the same gun.
 */
export const TURRET_GROUP_Y = HULL_RIDE + TANK_BODY_H + TURRET_H / 2 - TURRET_SEAT;

/** The hull body, already stood up: the extrude is built in XY and rotated onto the deck. */
export function hullGeometry(): THREE.ExtrudeGeometry {
  const geo = beveledExtrude(
    hullPlan(HULL_LEN, BODY_WIDTH, HULL_CORNER, HULL_NOSE),
    TANK_BODY_H,
    HULL_BEVEL,
  );
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/**
 * One track: a stadium in side profile -- fully rounded front and back, like the run of a
 * real track round its drive sprockets. The corner radius is half the height, which is
 * what turns a rounded rectangle into a stadium; anything less reads as a box with
 * softened corners.
 */
export function trackGeometry(): THREE.ExtrudeGeometry {
  return roundedBox(HULL_LEN + TRACK_OVERHANG * 2, TRACK_H, TRACK_W, TRACK_H / 2, TRACK_BEVEL);
}

/** Which of `entities.ts`'s two nested groups a part belongs under. */
export type TankPartParent = 'visual' | 'turret';

export interface TankPart {
  /**
   * The mesh name the game gives this part, reused verbatim by the exporter so a node in
   * an exported file can be matched against the live scene graph by name.
   */
  readonly name: 'hull' | 'track' | 'turret' | 'barrel';
  readonly geometry: THREE.BufferGeometry;
  readonly position: THREE.Vector3;
  readonly rotationZ: number;
  readonly parent: TankPartParent;
}

/**
 * Every part of the canonical tank, with its transform, in one call.
 *
 * FRESH GEOMETRY ON EVERY CALL, deliberately: `entities.ts` mutates the UVs of the
 * instances it is handed (`projectBodyUV`, `unrollSkirtUV`, `matchLatheToTurret`) and
 * disposes them per tank, so a shared cached instance would either leak or arrive already
 * re-parameterised for whichever skin was built last.
 *
 * The parts are returned rather than assembled, because `entities.ts` nests them under
 * groups carrying the spawn animation's scale and the aim rotation -- gameplay concerns
 * the canonical model has no business reproducing. `parent` records the nesting so an
 * exporter can rebuild the same hierarchy without the reasons for it.
 */
export function tankParts(): TankPart[] {
  const parts: TankPart[] = [
    {
      name: 'hull',
      geometry: hullGeometry(),
      position: new THREE.Vector3(0, HULL_RIDE + TANK_BODY_H / 2, 0),
      rotationZ: 0,
      parent: 'visual',
    },
  ];
  for (const side of [-1, 1]) {
    parts.push({
      name: 'track',
      geometry: trackGeometry(),
      position: new THREE.Vector3(0, TRACK_H / 2, side * (HULL_WIDTH / 2 - TRACK_W / 2)),
      rotationZ: 0,
      parent: 'visual',
    });
  }
  parts.push({
    name: 'turret',
    geometry: turretGeometry(),
    position: new THREE.Vector3(0, 0, 0),
    rotationZ: 0,
    parent: 'turret',
  });
  parts.push({
    name: 'barrel',
    geometry: barrelGeometry(),
    // The profile runs along the lathe's own +y from breech to muzzle, so rotating -90deg
    // about z lays it along local +x already positioned -- no offset to keep in step with
    // the length, which is how the barrel got shorter when the turret grew.
    position: new THREE.Vector3(0, 0, 0),
    rotationZ: -Math.PI / 2,
    parent: 'turret',
  });
  return parts;
}

/**
 * The authored numbers behind the shape, for the exporter's metadata.
 *
 * Emitted rather than described so a reader of an exported bundle can tell which revision
 * of the tank they have without diffing meshes, and so a change to any of them appears in
 * the generated metadata as a value rather than as a silently different model.
 */
export function tankGeometryParameters(): Record<string, number> {
  return {
    HULL_LEN, HULL_WIDTH, HULL_CORNER, HULL_NOSE, HULL_BEVEL, HULL_RIDE,
    TANK_BODY_H, BODY_WIDTH, TANK_RADIUS,
    TRACK_W, TRACK_H, TRACK_BEVEL, TRACK_PROUD, TRACK_OVERHANG, TRACK_SHADE,
    TURRET_R, TURRET_H, TURRET_SEAT, TURRET_FILLET, TURRET_SEGMENTS, TURRET_GROUP_Y,
    BARREL_R, BARREL_OUT, BARREL_SEGMENTS, MUZZLE_LEN, MUZZLE_FLARE,
  };
}
