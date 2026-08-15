import * as THREE from 'three';
import type { World } from '../sim/world';
import type { Wall, TankKind } from '../sim/types';
import { lerpAngle, lerpVec2 } from './interpolate';
import { BULLET_RADIUS, SHELL_SPAWN_FORWARD } from '../sim/constants';
import { configFor, wallConfigFor } from '../sim/config';
import { createSkinTexture } from './skins';
import { skinScroll, type SkinId } from '../game/customization';
import { angleOf } from '../sim/types';
import type { TextureSet } from './textures';
import { blastRadiusAt } from '../sim/mines';
import { MINE_TIMER } from '../sim/constants';
import { MINE_BLAST_EXPAND_TICKS, MINE_BLAST_HOLD_TICKS } from '../sim/constants';

export interface EntityViews {
  /** `dt` drives animated skins; omitting it freezes them, which is what tests want. */
  sync(prev: World, curr: World, alpha: number, dt?: number): void;
  /**
   * The paint shop: override a co-op SLOT's hull colour (a CSS hex, null for the
   * roster default), skin, and the skin's accent tone (a CSS hex, null for `auto` --
   * derive the tone from the hull, as skins.ts always has). Takes effect on the next
   * sync via the same rebuild path a kind change uses -- live, even for the tank
   * already standing behind the menu.
   *
   * `slot` is `Tank.controlledBy` (0-based), trailing and defaulting to 0 -- every
   * shipped call site styles P1 and stays unchanged. A slot that has never been
   * styled falls back to today's roster default at slot 0, or a neutral placeholder
   * swatch at any other slot -- see `styleFor` in entities.ts.
   */
  setPlayerStyle(hex: string | null, skin: SkinId, accentHex: string | null, slot?: number): void;
  dispose(): void;
}

// Entity colour is presentation, so it comes from each resolved config's `color`
// (a CSS hex string) rather than literal tables here -- the pure sim never reads it.
// Parsed on use into the 0xRRGGBB THREE expects.
function cssHex(color: string): number {
  return parseInt(color.slice(1), 16);
}
function tankColor(kind: TankKind): number {
  return cssHex(configFor(kind).color);
}

const TANK_BODY_H = 0.4;
const TURRET_H = 0.28;
/** How much of the turret ring is deliberately seated into the hull. */
const TURRET_SEAT = 0.03;
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
 * DERIVED from the sim's SHELL_SPAWN_FORWARD: the sim decides where a shell is born,
 * and the drawn muzzle has to be that same point or the render lies about where the
 * gun fires from. To lengthen the gun, change SHELL_SPAWN_FORWARD -- which correctly
 * moves the spawn point with it. The reach was chosen at PLAY distance, not in
 * close-up: the barrel is the shipped aim indicator (aimRay is a dev flag precisely
 * because of that), and a shorter one read as a nub from the real camera even though
 * it looked generous up close.
 */
export const BARREL_OUT = SHELL_SPAWN_FORWARD - TURRET_R;
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
  // `kind` travels with the view: loadArena numbers ids by grid scan, so a level
  // switch can hand the same id to a DIFFERENT kind, and a view reused on id alone
  // draws the old tank's mesh and colour under the new tank's position. `gen` is the
  // paint-shop generation: bumping it forces the same rebuild path, which is how a
  // swatch click repaints the tank already standing behind the menu.
  const tankViews = new Map<number, { group: THREE.Group; turret: THREE.Object3D; kind: TankKind; gen: number }>();

  /** One co-op SLOT's paint-shop state -- see `styleFor` and `setPlayerStyle` below. */
  interface PlayerStyle {
    hex: string | null;
    // The one skin texture, owned HERE: disposeObject deliberately skips material maps
    // (walls borrow the shared TextureSet), so per-style disposal happens on change.
    skinMap: THREE.DataTexture | null;
    /** Which skin `skinMap` was painted for -- the stripe skin needs its own UVs. */
    skin: SkinId;
    // Resolved once per restyle, not per frame: sync runs at 60fps.
    scroll: { u: number; v: number } | null;
    gen: number;
  }
  /**
   * Per co-op SLOT (`Tank.controlledBy`, defaulting to 0) rather than one global
   * player style -- issue: couch co-op foundation. Absent for a slot that has never
   * been styled; `styleFor` fills in the default. Was four module-level singletons
   * (`playerHex`/`playerSkinMap`/`playerSkin`/`colorGen`) keyed to slot 0 implicitly;
   * this is the one piece of this PR that is load-bearing rather than inert plumbing,
   * since it is what makes per-player customization structurally possible later.
   */
  const playerStyles = new Map<number, PlayerStyle>();
  /**
   * A hue for an unstyled co-op slot >= 1, distinct from P1's roster default and
   * every roster kind's own colour (pinned by entities.test.ts's diff-against-
   * `configFor` sweep) -- a feel value, implementer's pick, same treatment CLAUDE.md
   * gives `TANK_TURN_RATE`.
   */
  const UNSTYLED_SLOT_HEX = '#c23b8f';
  /** The bit-identical-to-boot default for slot 0: no hex override, no skin map. */
  const DEFAULT_SLOT_0_STYLE: PlayerStyle = { hex: null, skinMap: null, skin: 'solid', scroll: null, gen: 0 };
  /** The placeholder for any other slot until it is explicitly styled. */
  const DEFAULT_OTHER_SLOT_STYLE: PlayerStyle = {
    hex: UNSTYLED_SLOT_HEX, skinMap: null, skin: 'solid', scroll: null, gen: 0,
  };

  /**
   * Resolves the style for a co-op slot. Lookup order: an entry for THIS slot wins;
   * slot 0 with no entry falls back to today's roster default (bit-identical boot
   * state, before `setPlayerStyle` is ever called); any other slot with no entry
   * gets the neutral placeholder swatch, so a second player reads as visibly
   * distinct from P1 before anyone styles it.
   */
  function styleFor(slot: number): PlayerStyle {
    return playerStyles.get(slot) ?? (slot === 0 ? DEFAULT_SLOT_0_STYLE : DEFAULT_OTHER_SLOT_STYLE);
  }
  /**
   * One two-tone texture PER ENEMY KIND, shared by every tank of that kind -- issue
   * #137. A kind's colour never changes at runtime (it is roster data, not a paint
   * shop choice), so there is nothing to regenerate per tank or per frame; minting
   * once and caching by kind is exactly what `enemySkinMapFor` below does. Owned HERE
   * for the same reason `playerSkinMap` is: `disposeObject` deliberately skips
   * material maps, so these five (today) textures need their OWN disposal path --
   * `dispose()` below -- or they leak one per kind for the life of the game.
   * Never scrolled: enemies stay on STATIC two-tone, deliberately -- see the SkinDef
   * comment on why two-tone itself does not carry a `scroll`.
   */
  const enemySkinMaps = new Map<TankKind, THREE.DataTexture>();

  /** Mint (once) and return the two-tone texture for a non-player kind. */
  function enemySkinMapFor(kind: TankKind): THREE.DataTexture {
    let tex = enemySkinMaps.get(kind);
    if (!tex) {
      tex = createSkinTexture('two-tone', configFor(kind).color, null)!;
      enemySkinMaps.set(kind, tex);
    }
    return tex;
  }
  const bulletViews = new Map<number, THREE.Group>();
  const blastViews = new Map<number, THREE.Mesh>();
  const mineViews = new Map<number, THREE.Mesh>();
  const wallViews = new Map<number, { mesh: THREE.Mesh; signature: string }>();

  /**
   * Barrel radius. Must exceed the shell's, with wall thickness to spare -- see the
   * assertion in entities.test.ts, which exists because this was wrong.
   */
  const BARREL_R = BULLET_RADIUS * 1.3;
  /** Rounds the top edge, so the turret is a cylinder with a crown rather than a can. */
  const TURRET_FILLET = 0.09;

  /**
   * The turret's lathe profile, in (radius, height) -- split out from the geometry so the
   * BARREL can measure it. Matching the barrel's texel density to the turret's needs the
   * turret's circumference and profile arc length, and re-deriving either by hand would
   * go stale the moment TURRET_R or TURRET_FILLET moved.
   */
  function turretProfile(): THREE.Vector2[] {
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
  function turretGeometry(): THREE.LatheGeometry {
    return new THREE.LatheGeometry(turretProfile(), 20);
  }

  /** Total arc length of a lathe profile, which is the world span its `v` runs over. */
  function profileLength(pts: THREE.Vector2[]): number {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += pts[i].distanceTo(pts[i - 1]);
    return total;
  }

  /**
   * The hull body's half-width, which is the reference every other part is normalised
   * to when the stripe skin is projected. Kept here so the stripe stays the same
   * FRACTION of each part rather than a constant width -- see STRIPE_HALF_V in skins.ts.
   */
  const HULL_HALF_W = (HULL_WIDTH - TRACK_W * TRACK_PROUD * 2) / 2;

  /**
   * Project a part's UVs FLAT: u from the `along` world axis, v from the `across` one.
   *
   * BOTH AXES ARE LOAD-BEARING, and for more skins than this function was written for.
   * It began as the stripe skin's private fix and its comment said so; that is no longer
   * true and the stale version actively invited a regression. Today it is called from:
   *
   *   - `projectBodyUV`, for the HULL, on EVERY mapped skin. u is the hull's length and
   *     v its width, so checker's squares, camo's patches, clouds' puffs and flow's
   *     bands all read their position along the tank off u. Collapsing u to a constant
   *     turns the checker hull into horizontal bands -- and used to leave the whole
   *     suite green, which is why `entities.test.ts` now pins the u extent.
   *   - the TURRET and BARREL, for `stripes` only. A hard-edged band wrapped around a
   *     lathe axis arrives as PIE SLICES radiating from the turret's centre, which is
   *     what a blue/stripes tank measured as at play distance while its hull carried two
   *     clean bands. Every other skin keeps the lathe wrap on those parts, deliberately:
   *     it is what makes the checker's turret a pinwheel and the flow's a swirl.
   *
   * `across` is divided by `acrossHalf`, which is what lets the caller choose between
   * scaling a pattern to each part and running one field across the whole tank. See
   * STRIPE_TURRET_MODE, which is exactly that choice.
   */
  function projectPlanarUV(
    geo: THREE.BufferGeometry,
    along: 'x' | 'y' | 'z',
    across: 'x' | 'y' | 'z',
    acrossHalf: number,
  ): void {
    const pos = geo.attributes.position;
    const get = (i: number, axis: 'x' | 'y' | 'z'): number =>
      axis === 'x' ? pos.getX(i) : axis === 'y' ? pos.getY(i) : pos.getZ(i);
    const k = HULL_HALF_W / acrossHalf;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = get(i, along);
      uv[i * 2 + 1] = get(i, across) * k;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }

  /**
   * The `acrossHalf` a striped part is normalised by, which IS the option switch.
   *
   * 'part' hands each part its own half-width, so the stripes scale to the part. 'body'
   * hands every part the hull's, so the scale factor is 1 everywhere and one field of
   * stripes runs across the whole tank.
   */
  function stripeAcrossFor(partHalf: number): number {
    return STRIPE_TURRET_MODE === 'part' ? partHalf : HULL_HALF_W;
  }

  /**
   * Project the hull body from ABOVE, so the whole body is ONE continuous surface.
   *
   * This is the fix for "the skins on the hull should be continuous not broken up like
   * panels". An ExtrudeGeometry carries THREE different UV parameterisations, and the
   * third is the one that is easy to miss:
   *
   *  - the CAPS come from `WorldUVGenerator.generateTopUV`, which is the shape's own
   *    (x, y) -- for the hull, (length, width). That is the one that was already right.
   *  - the BEVEL RING and SIDE WALLS come from `generateSideWallUV`, which returns
   *    `(x, 1 - z)` or `(y, 1 - z)` -- and it CHOOSES BETWEEN THEM PER QUAD, on
   *    `Math.abs(a_y - b_y) < Math.abs(a_x - b_x)`. So the perimeter's own u axis flips
   *    between the shape's x and y depending on which way that stretch of the outline
   *    happens to run, and its v is the EXTRUSION DEPTH, a different space again.
   *
   * Three spaces on one mesh, one of them switching per facet, is exactly the panelled
   * read reported from the render: on camo you can see a blotch stop dead at the top edge and an
   * unrelated patch start on the shoulder below it. PR #101 found this for `stripes` and
   * projected the whole body planar -- but only for that one skin.
   *
   * Projecting from above reproduces the cap UVs EXACTLY (the cap is already (x, z) once
   * the extrusion is stood up) and brings the bevel and the walls into that same space,
   * so the pattern is a continuous function of position across every edge.
   *
   * A PLAIN top-down projection is not enough on its own, and the render says so. A
   * near-vertical wall has almost no extent when projected onto the ground plane, so the
   * whole skirt collapses to the single line of texels at the hull's outline and gets
   * drawn as vertical streaks. It IS continuous -- the seam is gone -- but on `checker`
   * the skirt became vertical columns instead of squares and on `camo` a picket fence.
   * Both are in the PR's `after-planar` renders. So the skirt is unrolled as well.
   */
  function projectBodyUV(geo: THREE.BufferGeometry): void {
    projectPlanarUV(geo, 'x', 'z', HULL_HALF_W);
    unrollSkirtUV(geo);
  }

  /**
   * Unroll the hull's skirt outward, so the sides carry the pattern at its true size.
   *
   * Push each vertex's UV outward along its own horizontal normal by how far it sits
   * BELOW the hull's top face. Think of it as folding the skirt flat outward around the
   * top edge: a point 0.2 units down the side is drawn with the texture 0.2 units beyond
   * the outline, which is exactly where that patch of paint would be if you unfolded it.
   *
   * Continuous with the top BY CONSTRUCTION, which is the property that matters: on the
   * top face the drop is 0, so the UV is exactly the planar one, and the offset grows
   * smoothly from the shared edge. It is also continuous across the bevel/wall junction,
   * for a reason worth stating because it is not obvious -- the horizontal component of
   * the normal is NORMALISED, so a 45deg bevel facet and the vertical wall below it
   * resolve to the SAME outward direction and the same offset at the ring they share.
   * Two facets differing only in tilt cannot disagree here; only ones differing in plan
   * azimuth can, and those are the rounded corners, where the offsets differ by at most
   * the drop times the angle between adjacent facet normals.
   *
   * The one discontinuity is the BOTTOM cap, which is offset 0 while the bottom bevel
   * ring around it is offset by the full body height. That is the underside of the hull,
   * 0.14 units off the ground and facing away from a camera that looks down at it, so it
   * is never drawn. Stated rather than fixed.
   */
  function unrollSkirtUV(geo: THREE.BufferGeometry): void {
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const keyAt = (i: number): string =>
      `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;

    // The outward direction is AVERAGED over every vertex sharing a position, and that is
    // load-bearing rather than tidy. ExtrudeGeometry is non-indexed, so
    // `computeVertexNormals` gives every triangle its own FACET normal and a position on
    // a rounded corner carries several. Offsetting each by its own facet normal splits
    // the UV at those corners; averaging first makes co-located vertices agree exactly,
    // so the corners close.
    //
    // Measured max UV gap between co-located vertices, WITH THE POPULATION STATED because
    // the two differ by 4x and an earlier draft quoted the smaller one bare:
    //
    //   per-facet, visible surface only (normal.y > -0.1, 729 of 1248 vertices)  0.102506
    //   per-facet, all 1248 vertices                                             0.400000
    //   averaged (shipped), either population                                    0.000000
    //
    // The all-vertices figure is larger because it includes the bottom cap, whose own
    // discontinuity is discussed below and is never drawn.
    let top = -Infinity;
    const dir = new Map<string, { x: number; z: number }>();
    for (let i = 0; i < pos.count; i++) {
      top = Math.max(top, pos.getY(i));
      const k = keyAt(i);
      const acc = dir.get(k) ?? { x: 0, z: 0 };
      acc.x += nrm.getX(i);
      acc.z += nrm.getZ(i);
      dir.set(k, acc);
    }

    for (let i = 0; i < pos.count; i++) {
      const acc = dir.get(keyAt(i))!;
      const len = Math.hypot(acc.x, acc.z);
      if (len < 1e-6) continue; // a purely horizontal face has no outward direction to push along
      const drop = top - pos.getY(i);
      uv.setXY(i, uv.getX(i) + (acc.x / len) * drop, uv.getY(i) + (acc.z / len) * drop);
    }
    uv.needsUpdate = true;
  }

  /**
   * The gun: a tube from inside the turret to the muzzle, with the last MUZZLE_LEN
   * stepped out into a flare.
   *
   * One lathe rather than two cylinders, so the step is a real edge in the silhouette
   * rather than a seam between meshes that can drift apart.
   */
  function barrelProfile(): THREE.Vector2[] {
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
  const BARREL_SEAM_PHI = Math.PI / 2;

  function barrelGeometry(): THREE.LatheGeometry {
    return new THREE.LatheGeometry(barrelProfile(), 16, BARREL_SEAM_PHI);
  }

  /**
   * Re-scale a lathe part's UVs so its pattern is the SAME WORLD SIZE as the turret's.
   *
   * The design feedback: "just change the barrel skin so it meshes with the existing turret
   * appearances of those skins." The turret's mapping is kept exactly as it is -- the
   * checker's pinwheel and the flow's swirl are the liked look, and nothing here touches
   * the turret. What was wrong is the BARREL, and the defect is density, not topology.
   *
   * `LatheGeometry` writes `u = i / segments` and `v = j / (points.length - 1)`, so BOTH
   * axes are normalised to the part regardless of how big the part is:
   *
   *  - u spans one full texture repeat around the circumference, whatever that
   *    circumference is. The turret is 2*PI*0.36 = 2.26 units around; the barrel tube is
   *    2*PI*0.13 = 0.82. So the identical tile was being packed 2.8x tighter on the gun,
   *    which is why flow's soft swirl arrived on the barrel as fine corduroy ribbing.
   *  - v is INDEX-based, not arc-length based, so the barrel's five profile segments each
   *    got a fifth of the tile no matter their length -- the 0.05-unit flare step and the
   *    0.4-unit tube were given the same share.
   *
   * So u is scaled by the radius ratio, and v is rebuilt from real arc length along the
   * profile and divided by the TURRET's arc length. Both then read "one texture repeat
   * per N world units" with the same N the turret uses, which is what makes the two parts
   * look like the same material. `radiusRef` is the tube's radius: the flare is wider and
   * so comes out slightly stretched, which is invisible over its 0.18 units.
   *
   * Exact, not approximate: `v * (n - 1)` recovers the profile index j because that is
   * literally how three wrote it, so the arc length looked up is the right one.
   */
  function matchLatheToTurret(
    geo: THREE.BufferGeometry,
    profile: THREE.Vector2[],
    radiusRef: number,
  ): void {
    const uScale = radiusRef / TURRET_R;
    const turretLen = profileLength(turretProfile());
    const cum: number[] = [0];
    for (let i = 1; i < profile.length; i++) {
      cum.push(cum[i - 1] + profile[i].distanceTo(profile[i - 1]));
    }
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const last = profile.length - 1;
    for (let i = 0; i < uv.count; i++) {
      const j = Math.round(uv.getY(i) * last);
      uv.setXY(i, uv.getX(i) * uScale, cum[j] / turretLen);
    }
    uv.needsUpdate = true;
  }

  function makeTank(kind: TankKind, controlledBy?: number): { group: THREE.Group; turret: THREE.Object3D } {
    const group = new THREE.Group();
    // Resolved per-tank from its OWN slot -- see styleFor -- not off a single global,
    // so two player-kind tanks in the same world can carry different paint.
    const style = kind === 'player' ? styleFor(controlledBy ?? 0) : null;
    const color = kind === 'player' && style?.hex ? cssHex(style.hex) : tankColor(kind);

    // Painted steel: rough enough to stay matte, metallic enough to pick up the rim.
    // A patterned skin rides as a map on the hull and turret ONLY -- tracks keep
    // their solid shade for grounding. The map already carries the tint, so mapped
    // materials use white (color multiplies the map; tinting twice goes muddy).
    //
    // EVERY kind is mapped now, not just the player -- issue #137. Enemies wear a
    // two-tone texture keyed by their own KIND (`enemySkinMapFor`), so their identity
    // colour lives in the painted texture, exactly like the player's chosen skin does;
    // the ternary below (and its two neighbours, `color` above and `resolvedSkin`
    // right after) are the player-specific branches left in this function, each for
    // the same reason: the player's texture is a paint-shop CHOICE while an enemy's is
    // fixed roster data.
    const skinMap = kind === 'player' ? style!.skinMap : enemySkinMapFor(kind);
    // The skin id THIS tank is actually wearing -- the player's own pick, or `two-tone`
    // for every enemy. Resolved per tank, off its OWN slot's style (not a single
    // module-level slot) because a co-op player's UV treatment must follow ITS OWN
    // skin, which is what `striped` below now keys on.
    const resolvedSkin: SkinId = kind === 'player' ? style!.skin : 'two-tone';
    const matColor = skinMap ? 0xffffff : color;
    const bodyMat = new THREE.MeshStandardMaterial({
      color: matColor,
      map: skinMap,
      roughness: 0.72,
      metalness: 0.25,
    });
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
    // Only a MAPPED tank is re-projected -- which, since issue #137, is every tank:
    // enemies now carry a two-tone map too, so their hulls get the same continuous UV
    // treatment the player's always has. Geometry is rebuilt whenever the style changes
    // (setPlayerStyle bumps its slot's own gen; an enemy's kind never changes once
    // built, so its geometry is built once and never re-touched by a restyle).
    const mapped = skinMap !== null;
    // The stripe skin is the one pattern whose DIRECTION matters, so its turret and
    // barrel are projected flat. Every other skin -- including `two-tone`, which is
    // what every enemy wears -- keeps each part's own lathe wrap on the TURRET, which
    // is what makes the checker's turret a pinwheel and the flow's a swirl; the design
    // feedback asked for both of those to stay untouched. Keyed on the tank's own RESOLVED skin
    // rather than on `kind`, deliberately: `kind === 'player'` was equivalent to "is
    // this the tank whose skin might be stripes" only while stripes was player-only.
    // Now that every kind carries a skin, the question this gate answers is "is THIS
    // tank's skin stripes", and only the player's skin is ever stripes -- an enemy's
    // resolved skin is always `two-tone`, which two-tone's own painter comment explains
    // does not need planar UVs at all. MEASURED, not just argued: because no enemy can
    // wear stripes today, this form and the old `kind === 'player' && playerSkin ===
    // 'stripes'` are equivalent over every reachable state -- reverting to the old form
    // passes the full entities.test.ts suite (50 of 50) unchanged. The re-keying is a
    // semantic tidy-up pinned by nothing until an enemy CAN wear stripes; if that day
    // comes, this comment is the reminder that the gate must follow the skin.
    const striped = mapped && resolvedSkin === 'stripes';

    const bodyGeo = beveledExtrude(hullPlan(HULL_LEN, bodyWidth, HULL_CORNER, HULL_NOSE), bodyH, HULL_BEVEL);
    bodyGeo.rotateX(-Math.PI / 2);
    // EVERY mapped skin gets this now, not just `stripes` -- see projectBodyUV for why
    // the hull was arriving in panels and what the three parameterisations were.
    if (mapped) projectBodyUV(bodyGeo);
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
    const turretMat = new THREE.MeshStandardMaterial({
      color: matColor,
      map: skinMap,
      roughness: 0.42,
      metalness: 0.35,
    });
    const domeGeo = turretGeometry();
    // `stripeAcross` is the ONE knob that separates the two racing-stripe options, and
    // it is deliberately the same number for the turret and the barrel -- see
    // STRIPE_TURRET_MODE.
    if (striped) projectPlanarUV(domeGeo, 'x', 'z', stripeAcrossFor(TURRET_R));
    const dome = new THREE.Mesh(domeGeo, turretMat);
    dome.name = 'turret';
    dome.castShadow = true;
    turret.add(dome);
    // The bore has to clear the shell it fires. It did not: the barrel was radius 0.07
    // against a shell of BULLET_RADIUS 0.10, so the round was WIDER than the tube it
    // came out of -- visible the moment shells were drawn at their true size.
    const barrelGeo = barrelGeometry();
    // The barrel's lathe runs along its own +y (the mesh is rotated -90deg about z to
    // lay it along the turret's +x), so in GEOMETRY space the along-axis is y and the
    // horizontal across-axis is z -- which is what puts the stripe on its top and
    // bottom rather than its flanks.
    if (striped) projectPlanarUV(barrelGeo, 'y', 'z', stripeAcrossFor(BARREL_R));
    // Every other skin: keep the lathe wrap the turret has, at the turret's world scale.
    else if (mapped) matchLatheToTurret(barrelGeo, barrelProfile(), BARREL_R);
    const barrel = new THREE.Mesh(barrelGeo, turretMat);
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
    // Hue comes from the wall's resolved config (config/walls.ts), like tank body
    // colour; the material TREATMENT (roughness/metalness/normal maps are render
    // assets, not sim data) stays here per kind.
    const mat =
      wall.kind === 'destructible'
        // Destructible reads as crate timber: fully matte, no metal, and PLANK GROOVES --
        // the cue that says this is the wall a shell can open, carried by the surface
        // rather than by hue alone.
        ? new THREE.MeshStandardMaterial({
            color: cssHex(wallConfigFor(wall.kind).color),
            roughness: 1.0,
            metalness: 0.0,
            normalMap: textures?.timberNormal ?? null,
            normalScale: new THREE.Vector2(0.9, 0.9),
          })
        // ...and solid as poured concrete with rebar sheen and aggregate relief.
        : new THREE.MeshStandardMaterial({
            color: cssHex(wallConfigFor(wall.kind).color),
            roughness: 0.8,
            metalness: 0.3,
            normalMap: textures?.concreteNormal ?? null,
            normalScale: new THREE.Vector2(0.55, 0.55),
          });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'wall';
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
      const slot = t.controlledBy ?? 0;
      // The paint generation only matters for the PLAYER: rebuilding every enemy on
      // a swatch click churned ~25 geometries per click for tanks whose colour never
      // changes (measured in review; bounded but pointless). Compared per-SLOT now,
      // not against one shared counter, so restyling one co-op player does not
      // rebuild a tank driven by a different slot.
      if (view && (view.kind !== t.kind || (t.kind === 'player' && view.gen !== styleFor(slot).gen))) {
        disposeObject(view.group);
        tankViews.delete(t.id);
        view = undefined;
      }
      if (!view) {
        const gen = t.kind === 'player' ? styleFor(slot).gen : 0;
        view = { ...makeTank(t.kind, t.controlledBy), kind: t.kind, gen };
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

  /**
   * Everything that makes two walls "the same wall" for rendering purposes. A level
   * switch hands sync() a WHOLE NEW WORLD whose wall ids overlap the old one's, so id
   * alone said "already drawn" about walls that were somewhere else entirely -- the
   * old level stayed on screen while the sim ran the new one, shells sailing through
   * drawn walls and stopping at invisible ones.
   */
  function wallSignature(wall: Wall): string {
    return `${wall.aabb.minX},${wall.aabb.minY},${wall.aabb.maxX},${wall.aabb.maxY},${wall.kind}`;
  }

  function syncWalls(curr: World): void {
    const seen = new Set<number>();
    for (const wall of curr.walls) {
      const existing = wallViews.get(wall.id);
      if (wall.destroyed) {
        if (existing) {
          disposeObject(existing.mesh);
          wallViews.delete(wall.id);
        }
        continue;
      }
      seen.add(wall.id);
      if (existing && existing.signature !== wallSignature(wall)) {
        disposeObject(existing.mesh);
        wallViews.delete(wall.id);
      }
      if (!wallViews.has(wall.id)) {
        wallViews.set(wall.id, { mesh: makeWall(wall), signature: wallSignature(wall) });
      }
    }
    // Ids the new world does not have at all -- the other half of the level switch.
    for (const [id, view] of [...wallViews]) {
      if (!seen.has(id)) {
        disposeObject(view.mesh);
        wallViews.delete(id);
      }
    }
  }

  function sync(prev: World, curr: World, alpha: number, dt = 0): void {
    // Animated skins drift their texture offset; speed is per-skin DATA in the skin
    // defs. RepeatWrapping makes the offset cyclic, so no clamping is needed. Every
    // STYLED slot animates independently -- an unstyled slot (styleFor's synthetic
    // default) never has a skinMap, so this loop is a no-op for it.
    if (dt > 0) {
      for (const style of playerStyles.values()) {
        if (style.skinMap && style.scroll) {
          style.skinMap.offset.x = (style.skinMap.offset.x + style.scroll.u * dt) % 1;
          style.skinMap.offset.y = (style.skinMap.offset.y + style.scroll.v * dt) % 1;
        }
      }
    }
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
    for (const style of playerStyles.values()) style.skinMap?.dispose();
    playerStyles.clear();
    // Five enemy kinds, five textures (today) -- disposing only the player's maps, as
    // this used to, leaked one DataTexture per enemy KIND for the life of the game.
    // `dispose()` only runs once per createEntityViews instance (teardown), so unlike
    // a slot's skinMap these are never replaced mid-game and need no per-restyle
    // disposal path of their own.
    for (const tex of enemySkinMaps.values()) tex.dispose();
    enemySkinMaps.clear();
    for (const v of tankViews.values()) disposeObject(v.group);
    for (const m of bulletViews.values()) disposeObject(m);
    for (const m of mineViews.values()) disposeObject(m);
    for (const m of blastViews.values()) disposeObject(m);
    for (const v of wallViews.values()) disposeObject(v.mesh);
    tankViews.clear();
    bulletViews.clear();
    mineViews.clear();
    blastViews.clear();
    wallViews.clear();
  }

  return {
    sync,
    setPlayerStyle(hex: string | null, skin: SkinId, accentHex: string | null, slot: number = 0): void {
      const prev = playerStyles.get(slot);
      prev?.skinMap?.dispose();
      playerStyles.set(slot, {
        hex,
        skinMap: createSkinTexture(skin, hex ?? configFor('player').color, accentHex),
        skin,
        scroll: skinScroll(skin),
        // Bumped from THIS slot's own previous gen (0 if never styled), not a shared
        // counter -- styling slot 1 must not force slot 0's tank to rebuild too.
        gen: (prev?.gen ?? 0) + 1,
      });
    },
    dispose,
  };
}
