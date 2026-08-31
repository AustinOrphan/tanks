import * as THREE from 'three';
import type { World } from '../sim/world';
import type { Wall, TankKind, Tank } from '../sim/types';
import { lerpAngle, lerpVec2 } from './interpolate';
import { BULLET_RADIUS, TANK_RADIUS, RESPAWN_SHIELD_TICKS } from '../sim/constants';
import { configFor, wallConfigFor } from '../sim/config';
import { createSkinTexture } from './skins';
import { skinScroll, DEFAULT_SPAWN_ANIM, type SkinId, type SpawnAnimId } from '../game/customization';
import { angleOf } from '../sim/types';
import type { TextureSet } from './textures';
import { blastRadiusAt } from '../sim/mines';
import {
  FUSE_WARNING_SECONDS, mineWarningFrame, makeMineLitRing, litStepFor, litInnerFraction,
  makeMineGlowMesh, makeMineLitMesh, disposeMineGlowMesh, glowRadius, glowOpacity,
  type MineWarnStyle, heatColor, heatIntensity, cookoffScale, slumpScale,
  styleBodyGrowthDuringTrip, beadHeight, spikeHeight, mastHeight, LANCE_HEIGHT,
  makeLanceMesh, makeBeadSprite, makeSpikeMesh, makeMastMesh, disposeMineVert,
} from './mine-warning';
import { MINE_TIMER } from '../sim/constants';
import { MINE_BLAST_EXPAND_TICKS, MINE_BLAST_HOLD_TICKS } from '../sim/constants';
import { SPAWN_ANIMATORS, makeSpawnRing, ENTRANCE_SECONDS } from './spawn-anim';
import {
  TANK_BODY_H, TURRET_H, TURRET_SEAT,
  HULL_LEN, HULL_WIDTH, TRACK_W, TRACK_H, TRACK_SHADE, HULL_CORNER, HULL_NOSE,
  HULL_BEVEL, TRACK_BEVEL, HULL_RIDE, TRACK_PROUD, TRACK_OVERHANG, TURRET_R,
  STRIPE_TURRET_MODE, BULLET_Y, BARREL_OUT, MUZZLE_LEN, MUZZLE_FLARE,
  BARREL_R, TURRET_GROUP_Y,
  turretProfile, barrelProfile,
  tankParts, type TankPart,
  type StripeTurretMode,
} from './tank-model';

/**
 * The tank's dimensions and shape now live in `tank-model.ts` (issue #385), so an
 * exporter can build the same geometry without importing this module's textures, skins
 * and spawn effects.
 *
 * RE-EXPORTED rather than left for callers to re-import: these names are part of this
 * module's published surface -- `entities.test.ts` imports sixteen of them by this path,
 * and `aimray.ts` takes `BULLET_Y` -- and the move is meant to relocate the definition,
 * not change who can see it.
 */
export {
  TANK_BODY_H, TURRET_H, TURRET_SEAT,
  HULL_LEN, HULL_WIDTH, TRACK_W, TRACK_H, TRACK_SHADE, HULL_CORNER, HULL_NOSE,
  HULL_BEVEL, TRACK_BEVEL, HULL_RIDE, TRACK_PROUD, TRACK_OVERHANG, TURRET_R,
  STRIPE_TURRET_MODE, BULLET_Y, BARREL_OUT, MUZZLE_LEN, MUZZLE_FLARE,
  type StripeTurretMode,
};


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
  setPlayerStyle(
    hex: string | null,
    skin: SkinId,
    accentHex: string | null,
    slot?: number,
    spawnAnim?: SpawnAnimId,
  ): void;
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

/**
 * Player IDENTITY colours -- WHO is driving, indexed by co-op SLOT (`Tank.controlledBy`).
 * Deliberately a separate palette from `customization.ts`'s `PALETTE` (hull paint, WHAT
 * style): the owner's brief draws the line explicitly -- "the ring says WHO, the hull
 * says WHAT STYLE" -- so a player who paints their hull orange must not have their own
 * identity colour collide with that choice by construction, which ties both palettes to
 * the same list would risk.
 *
 * Slot 0: a bright cyan-blue. Slot 1: a saturated amber-orange -- the blue/orange axis
 * Okabe-Ito uses for CVD safety (chosen for hue separation under protanopia,
 * deuteranopia AND tritanopia -- unlike a red/green pair, which collapses under the
 * first two), though these two exact hexes are not lifted from that palette (its
 * #0072B2/#E69F00 read too dark unlit against this scene's ground). It is also the
 * owner's own first suggestion ("P1 blue-white, P2 orange"). Neither value equals any
 * roster kind's own `color` (config/data/tank-defs.json)
 * or the co-op placeholder hull swatch (`UNSTYLED_SLOT_HEX` below) -- pinned by
 * entities.test.ts's identity-ring distinctness sweep, which diffs all 4 ring hexes,
 * pairwise, against each other AND against every roster colour and the placeholder.
 *
 * Slot 2: a bright vermillion. Slot 3: a reddish-purple pushed toward violet. Both are
 * the remaining Okabe-Ito-adjacent hues past blue/orange (its own vermillion #D55E00
 * and reddish-purple #CC79A7), re-brightened the same way slots 0/1 were. Neither is a
 * clean win: RGB-distance-and-hue-angle checked by hand (not asserted -- the sweep below
 * is inequality-only) against the existing two rings, the roster and the placeholder,
 * slot 2 sits only ~20 degrees of hue from slot 1's own orange (both are inherently
 * warm/red hues in this part of the palette -- Okabe-Ito's own orange and vermillion are
 * just as close, ~18 degrees apart), and slot 3's hue was moved OFF the literal
 * reddish-purple hue and toward violet specifically because the true reddish-purple
 * territory (~320-330 degrees) already sits close to `UNSTYLED_SLOT_HEX`'s own hue
 * (~323 degrees). Every other pairing (roster, placeholder) measured with a wide margin.
 */
export const IDENTITY_RING_COLORS: readonly number[] = [0x3fd0ff, 0xff8a1e, 0xff4d2e, 0x9d3bff];
/**
 * Ring/tint colour for any slot beyond the identity palette. Unreached today -- N-player
 * caps at 4 (devflags.ts's `players`) -- defined so a hypothetical 5th slot degrades to a
 * colour rather than `undefined` reaching a THREE material constructor.
 */
const IDENTITY_COLOR_FALLBACK = 0xffffff;
function identityColor(slot: number): number {
  return IDENTITY_RING_COLORS[slot] ?? IDENTITY_COLOR_FALLBACK;
}

/**
 * Team colours (n-player arc PR 4) -- 'teams' mode's alternative to IDENTITY_RING_COLORS
 * at the SAME lookup site (syncTanks' ring creation, shellTintFor), dispatched on
 * `world.mode === 'teams'`. Where per-slot identity answers "which of 4 players",
 * teams answers "which SIDE" -- knowing your teammate's shell apart from an
 * opponent's matters more than telling two teammates apart.
 *
 * THREE, not two, since issue #281: four-player Teams may use two or three teams
 * (2v2 or 2v1v1), and `Tank.team` is now the CONFIGURED team rather than the derived
 * `slot % 2`. Before the third entry existed `teamColor(2)` fell through to
 * `IDENTITY_COLOR_FALLBACK` -- white, which is also the unstyled-slot placeholder -- so a
 * 2v1v1 match rendered one whole side as "no identity".
 *
 * The third hue was picked by MEASUREMENT, and the first measurement was WRONG in a way
 * worth recording. Ranking candidates by RGB distance chose a magenta `#ff4fd8`, which
 * sits 97 away from everything -- and only **10 degrees of hue** from `UNSTYLED_SLOT_HEX`.
 * This file's own note on `IDENTITY_RING_COLORS` above already says that ~320-330 degree
 * territory is spoken for, and that slot 3's hue was moved off it for exactly that reason.
 * RGB distance is the wrong metric here; HUE SEPARATION is the one the palette is actually
 * reasoned about in.
 *
 * Re-picked on that basis: the largest unoccupied hue gap among the saturated colours is 78
 * degrees, between olive (75) and the green tank (154). `#4eff3b` sits at its midpoint, 39
 * degrees from the nearest saturated neighbour, and carries the SAME saturation and value
 * as the two existing team hues (0.77 / 1.00) so the trio reads as one set.
 *
 * RED AND GREEN IS THE WORST PAIR FOR A DEUTERANOPE, and that is accepted rather than
 * overlooked: the constraint set leaves no hue that is both well separated here and
 * colour-blind-safe against red. It is why `TEAM_LABELS` exists and why the stock readout
 * carries the letter -- the issue requires the reinforcement precisely so the hue is not
 * load-bearing on its own. A vivid red/blue/green trio, verified distinct
 * from every roster colour, both identity-ring hues and the unstyled-slot placeholder
 * by entities.test.ts's sweep -- same reuse-the-mechanism, new-colour-source shape PR1
 * itself used for IDENTITY_RING_COLORS' own placeholder swatch.
 */
export const TEAM_COLORS: readonly [number, number, number] = [0xff3b3b, 0x3b82ff, 0x4eff3b];

/**
 * Single letters for the same three sides, and the reason they exist (issue #281).
 *
 * The issue asks for team choice to be "reinforce[d] ... with label/marker in addition to
 * color". A hue alone fails three readers at once: a colour-blind player, a player on a
 * forced-colours palette (issue #368 replaces authored hues outright), and anyone reading a
 * screenshot in greyscale. A letter survives all three, and it is the same A/B/C the setup
 * pane's team selector shows -- so the readout and the control that set it agree.
 */
export const TEAM_LABELS: readonly [string, string, string] = ['A', 'B', 'C'];
function teamColor(team: number): number {
  return TEAM_COLORS[team] ?? IDENTITY_COLOR_FALLBACK;
}

/**
 * The shared team/identity dispatch, factored out (issue #200's death-pulse work) so
 * `syncTanks`'s ring/spawn-ring sites, `shellTintFor` and `death-pulse.ts`'s own ring
 * all agree on one function instead of three copies of `curr.mode === 'teams' ?
 * teamColor(...) : identityColor(...)` -- `loop.ts::deathVignetteColor` used to keep a
 * FOURTH copy that indexed `TEAM_COLORS`/`IDENTITY_RING_COLORS` directly rather than
 * calling `teamColor`/`identityColor`, which is why it fell back to
 * `SINGLE_PLAYER_DEATH_VIGNETTE` (red) instead of `IDENTITY_COLOR_FALLBACK` (white) on
 * an out-of-range slot -- unreached today (`players` caps at 4, matching both
 * palettes' length) and not pinned by any test, so folding it into this fallback
 * changes no observed behaviour. `tank.team ?? 0`/`tank.controlledBy ?? 0` mirror the
 * defensive fallbacks the three existing call sites already use.
 */
export function resolveOwnerColor(world: World, tank: Tank): number {
  return world.mode === 'teams' ? teamColor(tank.team ?? 0) : identityColor(tank.controlledBy ?? 0);
}

/**
 * How many player-kind tanks a world has to have before identity rings/shell tints draw
 * at all. Below this, both are the single-player game exactly as shipped before this
 * feature -- byte-identical, not merely visually similar -- which is the stated
 * requirement. Held by the three single-player negative-control tests below this
 * threshold, and verified once manually by md5-comparing gallery renders against an
 * unmodified checkout (a method, not a checked-in tool -- rerun it if this area moves).
 */
const MULTIPLAYER_THRESHOLD = 2;

/**
 * The ONE gate identity colour hangs on, exported so a fourth consumer cannot assemble its
 * own copy of `countPlayerTanks(...) >= MULTIPLAYER_THRESHOLD`.
 *
 * Issue #284 is why it is exported rather than left local: tread trails need exactly this
 * predicate, and `resolveOwnerColor`'s own comment records what happened the last time a
 * call site rebuilt the identity logic instead of calling into it -- a fourth copy that
 * indexed the palettes directly and fell back to the wrong colour. `sync` below now calls
 * this too, so there is one definition rather than one plus a re-derivation.
 */
export function identityApplies(world: World): boolean {
  return countPlayerTanks(world.tanks) >= MULTIPLAYER_THRESHOLD;
}
function countPlayerTanks(tanks: readonly { kind: TankKind }[]): number {
  let n = 0;
  for (const t of tanks) if (t.kind === 'player') n++;
  return n;
}

/**
 * Ring geometry, in world units. The tank's own collision footprint is a circle of
 * TANK_RADIUS (0.5) -- see HULL_WIDTH's own comment on why the hull mesh matches that
 * exactly. INNER_R clears it with margin (rather than sitting flush) so the ring never
 * hides under the hull's rounded-corner geometry or the tracks' TRACK_OVERHANG from
 * directly overhead; OUTER_R is thick enough to read as a band rather than a hairline
 * at the game's own camera distance (VIEWS.game in tools/gallery/subjects.ts). Both are
 * exported so entities.test.ts can pin the "outside the hull" invariant directly rather
 * than trusting the multiplier.
 */
export const IDENTITY_RING_INNER_R = TANK_RADIUS * 1.3;
export const IDENTITY_RING_OUTER_R = TANK_RADIUS * 1.6;
/** Just off the felt, at track level, matching the RING_Y precedent in minedebug.ts. */
const IDENTITY_RING_Y = 0.03;
const IDENTITY_RING_SEGMENTS = 48;
const IDENTITY_RING_OPACITY = 0.85;

/**
 * One player's identity ring: an unlit, additively-blended flat annulus, matching the
 * treatment particles.ts already uses for glow (sparks, muzzle flash) rather than
 * inventing a new one -- see the comment on ParticleSystem's material. Unlit because a
 * lit ring would dim on the far side of the tank from the key light, which is exactly
 * the side a teammate most needs it legible from; additive blending is what turns a
 * flat colour into a "glow" over the dark ground plane cheaply, with no extra lights.
 */
function makeIdentityRing(color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(IDENTITY_RING_INNER_R, IDENTITY_RING_OUTER_R, IDENTITY_RING_SEGMENTS),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: IDENTITY_RING_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  mesh.name = 'identity-ring';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = IDENTITY_RING_Y;
  return mesh;
}

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









function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Mine body centre height; the body spans 0..2*MINE_Y. Exported for the #276 fill's height. */
export const MINE_Y = 0.09;
/** How many full bright/dark cycles a mine goes through over its whole fuse. */
const MINE_PULSE_TURNS = 6;
/**
 * The pre-#276 fuse pulse: quadratic phase, so the RATE climbs linearly and a mine that
 * ticks lazily when dropped is strobing by the time its window opens. Extracted so the
 * warning window can ramp on FROM its value rather than cutting to a different brightness.
 */
function fusePulseAt(elapsed: number): number {
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * MINE_PULSE_TURNS * elapsed * elapsed);
}
/** The mine body's radius. Exported because the #276 warning geometry is sized against it. */
export const MINE_R = 0.28;
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

/** A mine's body plus its two lazily-created warning cues (issue #276). */
interface MineView {
  mesh: THREE.Mesh;
  /** Fuse-urgency outline. Its geometry is rebuilt only when the thickness step changes. */
  ring: THREE.Mesh | null;
  ringStep: number;
  /** Proximity-trip fill, scaled from the middle outward. */
  fill: THREE.Mesh | null;
  /** A style variant's vertical proximity element (lance/spike/mast) plus its bead. */
  vert: THREE.Object3D | null;
  bead: THREE.Sprite | null;
}

/** A player tank's live entrance/invincibility animation -- see spawn-anim.ts. */
interface SpawnViewState {
  variant: SpawnAnimId;
  elapsed: number;
  ring: THREE.Mesh;
}

interface TankView {
  group: THREE.Group;
  turret: THREE.Object3D;
  /** Body/tracks/turret, scaled by the spawn animation -- see makeTank's own comment. */
  visual: THREE.Group;
  kind: TankKind;
  gen: number;
  ring: THREE.Mesh | null;
  spawn: SpawnViewState | null;
}

/**
 * Sets opacity on the tank's own painted materials -- body, tracks, turret, barrel --
 * without touching either ring (identity or spawn), which stay MeshBasicMaterial and so
 * are skipped by the `instanceof` check below. That is what lets this run every spawn-anim
 * frame without having to know each part's name.
 */
function setTankOpacity(view: TankView, k: number): void {
  view.group.traverse((child) => {
    const mat = (child as THREE.Mesh).material;
    if (mat instanceof THREE.MeshStandardMaterial) {
      mat.transparent = true;
      mat.opacity = k;
    }
  });
}

/**
 * Undoes `setTankOpacity`'s `transparent = true` once the spawn animation is fully done.
 * `setTankOpacity(view, 1)` alone restores full opacity but leaves the material in the
 * transparent render pass forever -- a steady-state divergence from a tank that never
 * animated, reachable on every respawn. Called once, from the Done branch, after opacity
 * is back at 1.
 */
function resetTankTransparency(view: TankView): void {
  view.group.traverse((child) => {
    const mat = (child as THREE.Mesh).material;
    if (mat instanceof THREE.MeshStandardMaterial) {
      mat.transparent = false;
      mat.needsUpdate = true;
    }
  });
}

/**
 * The spawn ring's arc is a fraction of a full circle (Beacon's depleting timer); every
 * other variant always passes 1 (a full ring), which the ring's default geometry already
 * is. Rebuilt only when `arc` actually changes -- tracked on the mesh's own `userData`,
 * since a per-frame rebuild at a constant value would churn a geometry for nothing.
 */
function applyRingArc(mesh: THREE.Mesh, arc: number): void {
  if (arc >= 1 || mesh.userData.spawnRingArc === arc) return;
  mesh.userData.spawnRingArc = arc;
  const p = (mesh.geometry as THREE.RingGeometry).parameters;
  const old = mesh.geometry;
  mesh.geometry = new THREE.RingGeometry(
    p.innerRadius,
    p.outerRadius,
    p.thetaSegments,
    p.phiSegments,
    p.thetaStart,
    arc * Math.PI * 2,
  );
  old.dispose();
}

export function createEntityViews(
  scene: THREE.Scene,
  textures?: TextureSet,
  /**
   * Experimental mine-warning variant (the `mineWarn` dev flag); null/absent =
   * the shipped default treatment. See mine-warning.ts's style section.
   */
  mineWarnStyle: MineWarnStyle | null = null,
): EntityViews {
  // `kind` travels with the view: loadArena numbers ids by grid scan, so a level
  // switch can hand the same id to a DIFFERENT kind, and a view reused on id alone
  // draws the old tank's mesh and colour under the new tank's position. `gen` is the
  // paint-shop generation: bumping it forces the same rebuild path, which is how a
  // swatch click repaints the tank already standing behind the menu.
  // `ring` travels WITH the view rather than in a map of its own, deliberately: it is
  // disposed for free whenever `view.group` is (disposeObject traverses children), so
  // there is no second lifecycle to keep in step with tankViews' own rebuild/eviction
  // paths -- a stale ring reference after a rebuild would otherwise be a real bug class,
  // the same one `view.group`'s own re-creation on a kind/gen change already had to
  // solve once.
  const tankViews = new Map<number, TankView>();

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
    /**
     * Which spawn-entrance/invincibility animator this slot's tank plays -- the render
     * seam #201 adds. Read at the entrance trigger site below instead of the hardcoded
     * DEFAULT_SPAWN_ANIM; the player-facing picker UI that writes something other than
     * the default through setPlayerStyle is still deferred.
     */
    spawnAnim: SpawnAnimId;
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
  const DEFAULT_SLOT_0_STYLE: PlayerStyle = {
    hex: null, skinMap: null, skin: 'solid', scroll: null, gen: 0, spawnAnim: DEFAULT_SPAWN_ANIM,
  };
  /** The placeholder for any other slot until it is explicitly styled. */
  const DEFAULT_OTHER_SLOT_STYLE: PlayerStyle = {
    hex: UNSTYLED_SLOT_HEX, skinMap: null, skin: 'solid', scroll: null, gen: 0, spawnAnim: DEFAULT_SPAWN_ANIM,
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
  /**
   * A mine's view is three objects now, not one: the body, plus the two warning cues from
   * issue #276. `ring` and `fill` are created LAZILY -- most mines spend most of their life
   * in neither state, and an always-present pair would be two invisible draw calls per mine
   * per frame for the sake of avoiding one allocation.
   */
  const mineViews = new Map<number, MineView>();
  const wallViews = new Map<number, { mesh: THREE.Mesh; signature: string }>();




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

  function makeTank(
    kind: TankKind,
    controlledBy?: number,
  ): { group: THREE.Group; turret: THREE.Object3D; visual: THREE.Group } {
    const group = new THREE.Group();
    // Everything that should shrink/grow with the spawn animation's tankScale --
    // body, tracks, turret -- lives under this SEPARATE group rather than directly
    // under `group`. Rings (identity, spawn) are added straight to `group` as
    // siblings of `visual`, so scaling `visual` alone leaves them at their own
    // authored world-space radius: `group`'s own scale is never touched, which is
    // what stops three's parent x child scale composition from also shrinking a
    // ring that happens to share the tank's origin. `visual`'s local origin
    // coincides with `group`'s (no offset), so scaling it reproduces exactly the
    // "shrink toward the ground point" look scaling `group` itself used to give.
    const visual = new THREE.Group();
    group.add(visual);
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

    // GEOMETRY AND TRANSFORMS BOTH COME FROM `tank-model.ts` (issue #385), so the tank an
    // exporter writes and the tank the game draws cannot diverge. Sharing only the shapes
    // would still leave two copies of where each part SITS, and where the parts sit is
    // half of what a canonical model is. What stays here is everything that model
    // excludes: materials, skins, the UV work below, and the per-tank decisions above.
    const parts = tankParts();
    const partFor = (name: TankPart['name']): TankPart => {
      const found = parts.find((q) => q.name === name);
      if (found === undefined) throw new Error(`tankParts() is missing '${name}'`);
      return found;
    };
    const hullPart = partFor('hull');
    const bodyGeo = hullPart.geometry;
    // EVERY mapped skin gets this now, not just `stripes` -- see projectBodyUV for why
    // the hull was arriving in panels and what the three parameterisations were.
    if (mapped) projectBodyUV(bodyGeo);
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.name = 'hull';
    body.position.copy(hullPart.position);
    body.castShadow = true;
    body.receiveShadow = true;
    visual.add(body);

    // Tracks: darker and rougher than the painted hull, because they are steel that
    // spends its life in the dirt. Same colour family so the tank still reads as one
    // object at a glance.
    const trackMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).multiplyScalar(TRACK_SHADE),
      roughness: 0.95,
      metalness: 0.35,
    });
    // The two tracks, in the order `tankParts` emits them (-z first). Indexed rather than
    // re-derived from `side`, so their positions come from the shared model as well.
    const trackParts = parts.filter((q) => q.name === 'track');
    let trackIndex = 0;
    for (const side of [-1, 1]) {
      void side;
      // TRACK SHAPED: a stadium in side profile -- fully rounded front and back, like the
      // run of a real track round its drive sprockets. The corner radius is half the
      // height, which is what turns a rounded rectangle into a stadium; anything less
      // reads as a box with softened corners.
      const trackPart = trackParts[trackIndex++];
      const trackGeo = trackPart.geometry;
      const track = new THREE.Mesh(trackGeo, trackMat);
      track.name = 'track';
      track.position.copy(trackPart.position);
      track.castShadow = true;
      track.receiveShadow = true;
      visual.add(track);
    }

    const turret = new THREE.Group();
    // + TURRET_H / 2, because the dome is CENTRED on the turret group's origin. Placing
    // that origin at the hull top buried half the turret in the hull -- 43% of its height
    // at these proportions. TURRET_SEAT is the deliberate part: a little of the turret
    // ring sunk in, so it looks seated rather than balanced on top.
    turret.position.y = TURRET_GROUP_Y;
    // The turret reads as the same paint, less worn -- smoother, so the highlight that
    // separates it from the hull below sits on the turret rather than the body.
    const turretMat = new THREE.MeshStandardMaterial({
      color: matColor,
      map: skinMap,
      roughness: 0.42,
      metalness: 0.35,
    });
    const domeGeo = partFor('turret').geometry as THREE.LatheGeometry;
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
    const barrelPart = partFor('barrel');
    const barrelGeo = barrelPart.geometry as THREE.LatheGeometry;
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
    barrel.rotation.z = barrelPart.rotationZ;
    barrel.name = 'barrel';
    barrel.castShadow = true;
    turret.add(barrel);
    visual.add(turret);

    scene.add(group);
    return { group, turret, visual };
  }

  /** Visual proportions of a shell. The sim's BULLET_RADIUS (0.1) is its collision size;
   *  drawn dead-on it is nearly invisible, so the body is scaled up and given length. */
  const SHELL_R = BULLET_RADIUS * 1.0;
  const SHELL_BODY_LEN = BULLET_RADIUS * 4.5;

  /** The untinted shell's own emissive -- a dim brass glint, not a signal of anything. */
  const SHELL_EMISSIVE = 0x444422;
  /**
   * How strongly a tinted shell's owner colour reads over the brass body. ABOVE 1,
   * deliberately, not swept against a lower value: a shell is small and moving, so the
   * choice was to go bold rather than risk a hint nobody can read in flight -- the
   * tint's whole job is disambiguation, the same one the ring does. Confirmed at 1.15
   * in gallery-out/coop-game: the identity hue reads as the shell's dominant colour,
   * not a background tinge -- a tinted shell reads as "whose" before it reads as
   * "brass". Retune by eye (`npm run gallery -- --elements coop`) if that trade looks
   * wrong; nothing else depends on the exact number.
   */
  const SHELL_TINT_INTENSITY = 1.15;

  /**
   * A shell: a cylinder with a rounded nose, pointed along its own velocity.
   *
   * Built as a Group rather than one mesh so the nose can be a hemisphere. The parts are
   * laid out along local +x and the group is then yawed, which keeps the orientation maths
   * in one place and matching the barrel (entities.ts lays that along +x too).
   *
   * `tint` is the owner's identity colour (IDENTITY_RING_COLORS), or null for the
   * standard untinted brass -- resolved once by the caller at the shell VIEW's creation
   * tick (syncBullets), never re-touched per frame, because a shell's owner cannot
   * change over its life.
   */
  function makeBullet(tint: number | null): THREE.Group {
    const group = new THREE.Group();
    // Brass: the one genuinely metallic thing on the board, and small enough that it
    // needs the specular to be visible at all against the felt. A tinted shell keeps
    // the same brass BODY colour -- only the emissive glow carries the owner's hue --
    // but that glow is bold (SHELL_TINT_INTENSITY), not a hint: at this scale a subtle
    // tint reads as brass full stop, and the whole point is a shell that visibly says
    // whose it is while still being recognisably a shell shape.
    const mat = new THREE.MeshStandardMaterial({
      color: 0xf5f0d0,
      emissive: tint ?? SHELL_EMISSIVE,
      emissiveIntensity: tint !== null ? SHELL_TINT_INTENSITY : 1,
      roughness: 0.3,
      metalness: 0.7,
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

  /**
   * The two cues are at DIFFERENT heights now, and the difference is the design.
   *
   * The fuse glow lies on the felt UNDER the mine, so the body hides its middle and the
   * player sees light spilling out around the base. The proximity illumination lies on the
   * mine's CROWN, just clear of the dome apex (the body spans 0..2*MINE_Y), so it reads as
   * the mine itself lighting up. One is light under the object, the other is light on it.
   */
  const GLOW_Y = 0.02;
  const CROWN_Y = MINE_Y * 2 + 0.003;


  function makeWarningRing(): THREE.Mesh {
    const mesh = makeMineGlowMesh();
    scene.add(mesh);
    return mesh;
  }

  function makeWarningFill(): THREE.Mesh {
    const mesh = makeMineLitMesh();
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

  function syncTanks(
    prev: World,
    curr: World,
    alpha: number,
    snap: boolean,
    multiPlayer: boolean,
    dt: number,
  ): void {
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
        view = { ...makeTank(t.kind, t.controlledBy), kind: t.kind, gen, ring: null, spawn: null };
        tankViews.set(t.id, view);
      }
      // Identity ring: WHO, not WHAT style -- see IDENTITY_RING_COLORS. Only a
      // player-kind tank ever gets one, and only once a second player exists in the
      // world; below that threshold this is a no-op every tick, which is what keeps
      // single-player pixel-identical to before this feature (the negative-control
      // tests pin the no-op; a manual gallery md5-compare verified the pixels once).
      // Recomputed from the
      // CURRENT world every sync rather than latched at tank-view creation, since
      // `multiPlayer` is a property of the world, not of this one tank.
      //
      // n-player arc PR 4: `curr.mode === 'teams'` colours by TEAM (teamColor) instead
      // of by SLOT (identityColor) -- same site, alternative colour source, mirroring
      // PR1's own placeholder-swatch shape. `t.team` is always defined here in real
      // play (loadArena only reaches a 'teams' world with it stamped); `?? 0` is a
      // defensive fallback for a hand-built fixture, not a reachable campaign state.
      if (t.kind === 'player') {
        if (multiPlayer && !view.ring) {
          const color = resolveOwnerColor(curr, t);
          view.ring = makeIdentityRing(color);
          view.group.add(view.ring);
        } else if (!multiPlayer && view.ring) {
          disposeObject(view.ring);
          view.ring = null;
        }
      }
      // New id (no prev): snap to curr pose, do not lerp from a garbage origin.
      // `snap` covers the second discontinuity: resetArena teleports every tank
      // back to its spawn within one tick while keeping its id and reviving it,
      // so a plain lerp drew the tank streaking across the arena for a frame on
      // every life lost. A tick can move a tank at most TANK_SPEED*DT, so any
      // round-boundary jump is a teleport by definition, not motion.
      //
      // `revived` is the third, and the one `snap` cannot see (issue #239). A VS
      // stock respawn keeps the tank's id and does NOT restart the round, so
      // `roundStartTick` is unchanged and this tank alone teleports -- from
      // wherever it died to whichever spawn point was selected for it. Lerping
      // that drew the tank, and the spawn ring parented to it, travelling across
      // the arena from the death point to the respawn.
      //
      // Deliberately PER TANK, and that is the whole difficulty: `snap` is a
      // property of the world, so reusing it here would freeze every other tank
      // in the arena for a frame whenever anyone respawned. `!prevT.alive` is
      // read rather than a dead->alive edge, because `t.alive` is already true --
      // the loop skips the dead above.
      const prevT = prevMap.get(t.id);
      const revived = !!prevT && !prevT.alive;
      const p = snap || revived ? undefined : prevT;
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

      // Spawn animation: entrance ring + fade-in, then a live invincibility overlay
      // read off shieldUntilTick every frame (never latched), then restore-and-clear.
      // Enemies are out of scope here -- their death effect is a separate issue.
      if (t.kind === 'player') {
        // `revived` above is the same edge, read for the same reason -- one dead
        // `prevT` and a tank the loop already proved alive.
        const enteredRespawn = revived;
        const enteredRound = curr.roundStartTick !== prev.roundStartTick;
        if ((enteredRespawn || enteredRound) && !view.spawn) {
          // Per-slot selection: the player-facing picker UI that writes anything but the
          // default is still deferred (#201's own brief), but the render seam reads the
          // stored variant now, so tooling (the gallery's --spawn-anim) can already reach it.
          const variant = styleFor(slot).spawnAnim;
          const color = resolveOwnerColor(curr, t);
          const ring = makeSpawnRing(color);
          view.group.add(ring);
          view.spawn = { variant, elapsed: 0, ring };
        }
        if (view.spawn) {
          // Captured locally: `view.spawn`'s own narrowing does not survive the
          // `view.spawn = null` assignment in the Done branch below, even on a path
          // that never reaches it -- TS drops property narrowing across any
          // assignment to that property within the same scope.
          const spawn = view.spawn;
          spawn.elapsed += dt;
          const shieldLeft = (t.shieldUntilTick ?? 0) - curr.tick;
          let frame;
          if (spawn.elapsed < ENTRANCE_SECONDS) {
            frame = SPAWN_ANIMATORS[spawn.variant]('entrance', spawn.elapsed / ENTRANCE_SECONDS, 0);
          } else if (shieldLeft > 0) {
            const p = 1 - shieldLeft / RESPAWN_SHIELD_TICKS; // 0 fresh -> 1 ending
            frame = SPAWN_ANIMATORS[spawn.variant]('invincible', p, 0);
          } else {
            // Done: restore solid, drop the ring, clear state.
            setTankOpacity(view, 1);
            resetTankTransparency(view);
            view.visual.scale.setScalar(1);
            // disposeObject already detaches the ring (obj.parent?.remove(obj)); a
            // second view.group.remove(spawn.ring) here would be a no-op.
            disposeObject(spawn.ring);
            view.spawn = null;
            frame = null;
          }
          if (frame) {
            setTankOpacity(view, frame.tankOpacity);
            view.visual.scale.setScalar(frame.tankScale);
            spawn.ring.scale.setScalar(frame.ring.radius);
            (spawn.ring.material as THREE.MeshBasicMaterial).opacity = frame.ring.opacity;
            applyRingArc(spawn.ring, frame.ring.arc);
          }
        }
      }
    }
    for (const [id, view] of tankViews) {
      if (!seen.has(id)) {
        disposeObject(view.group);
        tankViews.delete(id);
      }
    }
  }

  /**
   * The identity colour a shell owned by `ownerId` should glow, or null for the
   * standard untinted brass. Resolved by looking the owner up in `curr.tanks` --
   * `Bullet` carries only `ownerId` (types.ts), never the owner's kind or slot
   * directly -- and returning null for any owner that is not a player-kind tank,
   * which covers every enemy shell. A DEAD player owner still resolves to its colour
   * on purpose: a shell must not lose its firer's identity mid-flight because the
   * firer died a tick after shooting -- pinned by the dead-owner test. (An owner id
   * absent from the world entirely also returns null; unreachable today, since tanks
   * are never removed from the array.) The caller gates this on `multiPlayer` first,
   * so it is never even reached at playerCount 1.
   */
  function shellTintFor(curr: World, ownerId: number): number | null {
    const owner = curr.tanks.find((t) => t.id === ownerId);
    if (!owner || owner.kind !== 'player') return null;
    // n-player arc PR 4: teams mode tints by TEAM, mirroring the ring dispatch above --
    // see its own comment for why `t.team ?? 0`'s fallback is defensive, not reachable.
    return resolveOwnerColor(curr, owner);
  }

  function syncBullets(prev: World, curr: World, alpha: number, multiPlayer: boolean): void {
    const prevMap = indexById(prev.bullets);
    const seen = new Set<number>();
    for (const b of curr.bullets) {
      if (!b.alive) continue;
      seen.add(b.id);
      let mesh = bulletViews.get(b.id);
      if (!mesh) {
        // Resolved ONCE, at creation -- a shell's owner never changes over its life,
        // exactly mirroring how tankViews captures `kind`/`gen` once rather than
        // re-deriving them every frame.
        const tint = multiPlayer ? shellTintFor(curr, b.ownerId) : null;
        mesh = makeBullet(tint);
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
      let view = mineViews.get(m.id);
      if (!view) {
        view = { mesh: makeMine(), ring: null, ringStep: -1, fill: null, vert: null, bead: null };
        mineViews.set(m.id, view);
      }
      const mesh = view.mesh;
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
      // The two #276 warnings, projected from the same mine state (render/mine-warning.ts).
      // Both are driven by the SIM's countdowns, never a wall clock, so a paused game holds
      // its warning frame instead of animating on.
      const warn = mineWarningFrame(m);
      /**
       * INSIDE THE FINAL FUSE WINDOW THE BODY STOPS PULSING and ramps to its brightest
       * instead (owner ruling on PR #396: "drop the blinking").
       *
       * Not an aesthetic tidy-up -- without it the ruling cannot be honoured. The pulse
       * above is six accelerating cycles across the whole fuse, so by the last half second
       * it is a strobe, and it is on the mine BODY rather than on any cue this issue added.
       * Captured frames made that concrete: 25 ticks before detonation the mine was a
       * full-brightness flash and 1 tick before it was a dark trough. Whatever the warning
       * cue does, the warning READS as blinking while the body behind it is doing that.
       *
       * So the window's own ramp takes over: monotone, brightest at expiry, and continuous
       * with wherever the pulse happened to be when the window opened, so the handover is
       * not itself a visible jump. Outside the window the accelerating pulse is untouched --
       * that is the mine's pre-existing "armed and counting" language, not this issue's.
       */
      const pulse = warn.fuse
        ? 1 - (1 - fusePulseAt(1 - FUSE_WARNING_SECONDS / MINE_TIMER)) * (1 - warn.fuse.growth)
        : fusePulseAt(elapsed);
      const mat = mesh.material as THREE.MeshStandardMaterial;
      // Armed stays the loud one. An unarmed mine still burns its fuse -- it detonates on
      // expiry whether or not it ever armed -- so it pulses too, but dimly, and the
      // black-vs-red base still says at a glance which one can be set off by walking near.
      const lo = m.armed ? MINE_ARMED_LO : MINE_IDLE_LO;
      const hi = m.armed ? MINE_ARMED_HI : MINE_IDLE_HI;
      mat.emissive.copy(lo).lerp(hi, pulse);

      if (mineWarnStyle) {
        // STYLE VARIANT BODY (playtest round -- see mine-warning.ts). The fuse channel is
        // the body itself: heat (all styles) plus a silhouette change (swell or slump).
        // During a trip the fuse channel FREEZES (or slams to max, for spike) so the
        // vertical below is the sole moving channel -- frozenFuseGrowth's rationale.
        const bodyGrowth = warn.proximity
          ? styleBodyGrowthDuringTrip(mineWarnStyle, m)
          : warn.fuse
            ? warn.fuse.growth
            : null;
        if (bodyGrowth !== null) {
          heatColor(bodyGrowth, mat.emissive);
          mat.emissiveIntensity = heatIntensity(bodyGrowth);
          if (mineWarnStyle === 'slump') {
            const sl = slumpScale(bodyGrowth);
            mesh.scale.set(sl.xz, sl.y, sl.xz);
            // The lathe spans +/-MINE_Y about its origin; without this the squashed base
            // floats and the swollen base sinks. position.y follows the Y scale exactly.
            mesh.position.y = MINE_Y * sl.y;
          } else {
            const sc = cookoffScale(bodyGrowth);
            mesh.scale.set(sc, sc, sc);
            mesh.position.y = MINE_Y * sc;
          }
        } else {
          mat.emissiveIntensity = 1;
          mesh.scale.set(1, 1, 1);
          mesh.position.y = MINE_Y;
        }
      } else {
        mat.emissiveIntensity = 1;
        mesh.scale.set(1, 1, 1);
      }

      if (warn.fuse && !mineWarnStyle) {
        // The glow is a unit disc, so its growth is pure SCALE -- no geometry churn at all,
        // unlike the illumination below whose inner edge has to be rebuilt.
        if (!view.ring) view.ring = makeWarningRing();
        const r = glowRadius(warn.fuse.growth, MINE_R);
        view.ring.scale.set(r, r, 1);
        view.ring.position.set(m.pos.x, GLOW_Y, m.pos.y);
        (view.ring.material as THREE.MeshBasicMaterial).opacity = glowOpacity(warn.fuse.growth);
      } else if (view.ring) {
        // disposeMineGlowMesh, not disposeObject: the glow's falloff texture is bound to
        // `map`, and Material.dispose() does not release it.
        disposeMineGlowMesh(view.ring);
        view.ring = null;
      }

      if (warn.proximity && !mineWarnStyle) {
        if (!view.fill) {
          view.fill = makeWarningFill();
          view.ringStep = -1;
        }
        // Closes in from the OUTSIDE: the annulus keeps the mine's radius as its outer edge
        // and its INNER edge shrinks to zero, so the last frame is a full disc -- the whole
        // mine lit. That lives in geometry, so it is rebuilt at most RING_STEPS times.
        const step = litStepFor(litInnerFraction(warn.proximity.lit));
        if (step !== view.ringStep) {
          view.fill.geometry.dispose();
          view.fill.geometry = makeMineLitRing(MINE_R, step);
          view.ringStep = step;
        }
        view.fill.position.set(m.pos.x, CROWN_Y, m.pos.y);
      } else if (view.fill) {
        disposeObject(view.fill);
        view.fill = null;
      }

      if (mineWarnStyle && warn.proximity) {
        // The vertical proximity element. Appears in ONE step at the trip tick (a one-way
        // appearance, not an oscillation) and is torn down with the mine at the blast.
        if (!view.vert) {
          view.vert = mineWarnStyle === 'lance' ? makeLanceMesh()
            : mineWarnStyle === 'spike' ? makeSpikeMesh()
            : makeMastMesh();
          scene.add(view.vert);
          if (mineWarnStyle === 'lance') {
            view.bead = makeBeadSprite();
            scene.add(view.bead);
          }
        }
        const q = warn.proximity.lit;
        if (mineWarnStyle === 'lance') {
          // Fixed denominator: the lance stands full height from tick one; only the bead
          // moves, touching the crown exactly on the last frame before the blast.
          view.vert.position.set(m.pos.x, LANCE_HEIGHT / 2, m.pos.y);
          view.bead!.position.set(m.pos.x, beadHeight(q, MINE_Y * 2), m.pos.y);
        } else if (mineWarnStyle === 'spike') {
          const h = Math.max(1e-4, spikeHeight(q));
          view.vert.scale.set(1, h, 1);
          view.vert.position.set(m.pos.x, MINE_Y * 2, m.pos.y);
        } else {
          const h = Math.max(1e-4, mastHeight(q));
          const rod = view.vert.getObjectByName('mast-rod')!;
          const tip = view.vert.getObjectByName('mast-tip')!;
          rod.scale.set(1, h, 1);
          rod.position.y = h / 2;
          tip.position.y = h;
          view.vert.position.set(m.pos.x, MINE_Y * 2, m.pos.y);
        }
      } else if (view.vert) {
        disposeMineVert(view.vert);
        view.vert = null;
        if (view.bead) {
          disposeMineVert(view.bead);
          view.bead = null;
        }
      }
    }
    for (const [id, view] of mineViews) {
      if (!seen.has(id)) {
        disposeMineView(view);
        mineViews.delete(id);
      }
    }
  }

  /** Removes a mine's body AND both warning cues -- see MineView on why they are separate. */
  function disposeMineView(view: MineView): void {
    disposeObject(view.mesh);
    if (view.ring) disposeMineGlowMesh(view.ring);
    if (view.fill) disposeObject(view.fill);
    if (view.vert) disposeMineVert(view.vert);
    if (view.bead) disposeMineVert(view.bead);
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
    // Identity rings and shell tints both gate on this ONE flag, computed from the
    // CURRENT world so a level switch or (hypothetically) a shrinking player count is
    // picked up on the very next sync, the same way `snap` is. At playerCount 1 this
    // is false on every call, which is what keeps single-player pixel-identical to the
    // game before this feature -- see IDENTITY_RING_COLORS' own comment.
    const multiPlayer = identityApplies(curr);
    syncWalls(curr);
    syncTanks(prev, curr, a, snap, multiPlayer, dt);
    syncBullets(prev, curr, a, multiPlayer);
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
    for (const v of mineViews.values()) disposeMineView(v);
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
    setPlayerStyle(
      hex: string | null,
      skin: SkinId,
      accentHex: string | null,
      slot: number = 0,
      spawnAnim: SpawnAnimId = DEFAULT_SPAWN_ANIM,
    ): void {
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
        spawnAnim,
      });
    },
    dispose,
  };
}
