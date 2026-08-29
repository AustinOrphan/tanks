import * as THREE from 'three';
import type { Mine } from '../sim/types';
import { DT, MINE_FUSE_WARNING_TICKS, MINE_PROXIMITY_DELAY_TICKS } from '../sim/constants';

/**
 * The two mine warnings, made visible (issue #276).
 *
 * The simulation already owns both phases and their exact timing (issue #275): the fuse's
 * final window latches `mine-fuse-warning`, and tripping an armed mine stamps
 * `proximityDelayLeft` and fires `mine-triggered`. This module is the PROJECTION of those
 * two states and nothing else -- it reads `Mine` and returns numbers, and never feeds
 * anything back.
 *
 * WHY A PURE FRAME FUNCTION, the same split spawn-anim.ts uses: the interesting content
 * here is the timing contract (how far the glow has grown, how much of the mine is lit),
 * and that is worth testing at exact values without a WebGL context. The mesh factories
 * below are the dumb half.
 *
 * THE TWO STATES ARE ON DIFFERENT CHANNELS ON PURPOSE, which is what makes them
 * distinguishable without relying on colour and readable in a still frame:
 *
 *   - FUSE URGENCY is a glow that grows from UNDERNEATH the mine, spilling out around its
 *     base. Light on the ground, not on the object.
 *   - PROXIMITY TRIP illuminates the MINE ITSELF, starting at its outer edge and closing
 *     inward until the whole body is lit.
 *
 * One is light under the mine and the other is light on it, and each encodes its progress
 * as a SIZE rather than as a flash: a single frame with no motion says both which warning
 * it is and how far along it is.
 *
 * NO BLINK, deliberately (owner ruling on PR #396). Two earlier revisions gave the fuse an
 * accelerating blink, capped at 6 Hz because sustained flashing above ~3 Hz is a
 * photosensitivity hazard. A monotone glow removes that hazard rather than bounding it, and
 * costs nothing legible -- the growth already carries the urgency.
 *
 * Both are functions of MINE STATE, never of a wall clock: two machines replaying the same
 * world draw the same frame, and a paused game holds its warning instead of animating on.
 */
export interface MineWarningFrame {
  /**
   * The under-mine glow, or null when the mine is not inside its final fuse window.
   * `growth` runs 0 at the moment the window opens to 1 at expiry.
   */
  fuse: { growth: number } | null;
  /**
   * How much of the mine is lit by a proximity trip, or null when it has not been tripped.
   * 0 on the tick it is tripped, 1 on the last frame before the blast -- at which point the
   * whole body is illuminated.
   */
  proximity: { lit: number } | null;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The fuse window, in seconds -- the same threshold mines.ts latches its event on. */
export const FUSE_WARNING_SECONDS = MINE_FUSE_WARNING_TICKS * DT;

/** Warning colour, shared by both states -- the DISTINCTION is never the hue. */
export const MINE_WARNING_COLOR = 0xffb43a;

/**
 * How far the fuse glow reaches, as a multiple of the mine's radius, at window entry and at
 * expiry.
 *
 * It DOES extend past the mine's footprint, and that is what "emanating from underneath"
 * means: light spilling out from beneath the object. The owner ruling that pulled an earlier
 * revision inward was about a hard-edged decal two to three times the mine's width; a soft
 * additive halo reads as illumination rather than as a patch of painted arena, which is why
 * the same objection does not apply here.
 */
export const GLOW_START_SCALE = 0.7;
export const GLOW_END_SCALE = 1.6;

/** Opacity of the under-mine glow at window entry and at expiry: it brightens as it spreads. */
const GLOW_OPACITY_MIN = 0.15;
const GLOW_OPACITY_MAX = 0.85;

/**
 * Project one mine's warning state.
 *
 * A detonated mine has no warning frame: entities.ts stops drawing it entirely and the blast
 * is its own effect. That is also what ends the illumination exactly at the blast rather
 * than letting it linger.
 */
export function mineWarningFrame(mine: Mine): MineWarningFrame {
  if (mine.detonated) return { fuse: null, proximity: null };

  let fuse: MineWarningFrame['fuse'] = null;
  if (mine.timer <= FUSE_WARNING_SECONDS) {
    // 0 the tick the window is entered, 1 at expiry.
    //
    // The HIGH clamp is the one that does work: stepMines subtracts dt BEFORE it checks
    // expiry, so a mine is observable at a negative timer for one tick, which drives this
    // ratio past 1. Unclamped the glow keeps growing past its authored reach at the exact
    // moment it should be largest and steadiest. The LOW bound is unreachable here -- this
    // branch only runs while `timer <= FUSE_WARNING_SECONDS` -- and survives only because
    // clamp01 is the shared helper.
    fuse = { growth: clamp01(1 - mine.timer / FUSE_WARNING_SECONDS) };
  }

  let proximity: MineWarningFrame['proximity'] = null;
  if (mine.proximityDelayLeft !== undefined) {
    // WHY THE -1: stepMines decrements FIRST and detonates when the counter reaches 0, so
    // the values ever RENDERED run DELAY down to 1 and never 0. Dividing by DELAY - 1 puts
    // full illumination on that last drawn frame, which is the frame the blast starts on --
    // the acceptance criterion's "final proximity frame agrees with the blast-start tick".
    // Dividing by DELAY tops out at 29/30 and the mine visibly never finishes lighting.
    const span = MINE_PROXIMITY_DELAY_TICKS - 1;
    const lit = span <= 0 ? 1 : clamp01((MINE_PROXIMITY_DELAY_TICKS - mine.proximityDelayLeft) / span);
    proximity = { lit };
  }

  return { fuse, proximity };
}

/** The glow's radius in world units, for a frame's growth and the mine's own radius. */
export function glowRadius(growth: number, mineRadius: number): number {
  return mineRadius * (GLOW_START_SCALE + (GLOW_END_SCALE - GLOW_START_SCALE) * clamp01(growth));
}

/** The glow's opacity for a frame's growth. */
export function glowOpacity(growth: number): number {
  return GLOW_OPACITY_MIN + (GLOW_OPACITY_MAX - GLOW_OPACITY_MIN) * clamp01(growth);
}

/**
 * The INNER edge of the proximity illumination, as a fraction of the mine's radius.
 *
 * Runs 1 (a hairline at the rim) down to 0 (the whole body lit), which is the direction
 * asked for: the light starts at the OUTSIDE and closes inward. The previous revision grew
 * a disc from the centre outward -- the same numbers read the other way round -- so this is
 * the one place a sign error silently reproduces the old behaviour while every timing
 * assertion still passes.
 */
export function litInnerFraction(lit: number): number {
  return 1 - clamp01(lit);
}

const RING_SEGMENTS = 48;
/** Quantisation of the illuminated annulus. Invisible at eight steps across a 0.5 s window. */
export const RING_STEPS = 8;

/**
 * The illuminated part of the mine lives in GEOMETRY -- a ring bakes both radii, and scaling
 * one scales its radius rather than its width -- so a changing inner edge means a new
 * geometry. Two ways to avoid rebuilding one every frame: share a ladder across mines, or
 * give each mine its own and rebuild only when its quantised step changes.
 *
 * THE SECOND, deliberately. entities.ts disposes a removed mine with `disposeObject`, which
 * TRAVERSES and disposes geometry, so the first mine to detonate would free a geometry its
 * neighbours were still drawing with. Per-mine geometry keeps disposal uniform with every
 * other view in that file, at a cost of at most RING_STEPS small allocations per mine per
 * trip, and only for mines actually tripped.
 */
export function litStepFor(innerFraction: number): number {
  const step = Math.round((1 - clamp01(innerFraction)) * (RING_STEPS - 1));
  return step + 0;
}

/** The inner fraction a quantised step represents -- the inverse of `litStepFor`. */
export function litInnerForStep(step: number): number {
  return 1 - step / (RING_STEPS - 1);
}

/** One illuminated annulus at a quantised step, owned by the caller and disposed with it. */
export function makeMineLitRing(mineRadius: number, step: number): THREE.RingGeometry {
  const inner = mineRadius * litInnerForStep(step);
  // A hairline rather than a degenerate zero-width ring at step 0: RingGeometry with
  // inner === outer produces no visible surface, so the first frame of a trip would show
  // nothing and the cue would appear to start late.
  return new THREE.RingGeometry(Math.min(inner, mineRadius * 0.985), mineRadius, RING_SEGMENTS);
}

/** Resolution of the glow's falloff texture. 64 is ample for a soft radial ramp. */
const GLOW_TEX_SIZE = 64;

/**
 * The glow's radial falloff, as a DataTexture rather than a flat colour.
 *
 * WITHOUT THIS IT IS NOT A GLOW. A flat additive disc has a hard rim, and a hard rim reads
 * as a painted decal lying on the felt -- which is the exact quality the owner objected to
 * in the previous revision, arriving again by a different route. Light has no edge, so the
 * alpha ramps from opaque at the centre to zero at the circumference and the disc has no
 * discernible boundary at all.
 *
 * `DataTexture` over a canvas gradient because this module has to build in the headless
 * test environment, which has no `document` -- the same reason textures.ts writes raw pixel
 * arrays. Squared falloff rather than linear: linear still leaves a faintly visible disc
 * edge, since alpha is falling at its fastest right where the eye is looking for a boundary.
 */
function makeGlowTexture(): THREE.DataTexture {
  const n = GLOW_TEX_SIZE;
  const px = new Uint8ClampedArray(n * n * 4);
  const c = (n - 1) / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const d = Math.hypot(x - c, y - c) / c;
      const fade = d >= 1 ? 0 : (1 - d) * (1 - d);
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
      px[i + 3] = Math.round(255 * fade);
    }
  }
  const t = new THREE.DataTexture(px, n, n, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/**
 * The under-mine glow's mesh: an additive disc laid just off the felt, scaled per frame.
 *
 * ADDITIVE and sitting BELOW the mine rather than above it. It is light spilling out from
 * underneath, so the mine's own body correctly hides the middle and what the player sees is
 * a halo around the base -- which is the effect. Additive blending is what makes it read as
 * light rather than as a painted disc, the same treatment particles.ts uses for sparks and
 * muzzle flash.
 */
export function makeMineGlowMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(1, 32),
    new THREE.MeshBasicMaterial({
      color: MINE_WARNING_COLOR,
      map: makeGlowTexture(),
      transparent: true,
      opacity: GLOW_OPACITY_MIN,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.name = 'mine-fuse-warning';
  return mesh;
}

/**
 * Disposes a glow mesh's geometry, material AND its falloff texture.
 *
 * Needed as its own function because `Material.dispose()` does NOT release a texture bound
 * to `map` -- entities.ts's generic `disposeObject` would free the geometry and material and
 * silently leak one 64x64 RGBA buffer per mine that ever burned its fuse down.
 */
export function disposeMineGlowMesh(mesh: THREE.Mesh): void {
  const mat = mesh.material as THREE.MeshBasicMaterial;
  mat.map?.dispose();
  mat.dispose();
  mesh.geometry.dispose();
  mesh.parent?.remove(mesh);
}

/**
 * The proximity illumination's mesh: an annulus on the mine's crown whose geometry the
 * caller replaces as the lit edge closes inward.
 *
 * Depth-tested normally and laid just clear of the dome apex. Clearing the apex is what
 * makes it visible at all -- an earlier revision laid this on the felt, where an opaque
 * 0.28-wide body hid it for more than half the reaction window.
 */
export function makeMineLitMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1, 8),
    new THREE.MeshBasicMaterial({
      color: MINE_WARNING_COLOR,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 3;
  mesh.name = 'mine-proximity-fill';
  return mesh;
}

// ---------------------------------------------------------------------------
// EXPERIMENTAL STYLE VARIANTS (owner playtest round, PR #396).
//
// Three candidate systems from a judged design pass, selectable with the
// `mineWarn` dev flag. The shipped default (glow + outside-in illumination
// above) is untouched while the owner compares them; the losers and this
// comment are deleted once a ruling lands.
//
// All three share one grammar the judging converged on: a mine dying of old
// age changes ITSELF (heat, shape), while a mine YOU tripped emits something
// vertical -- and vertical is the load-bearing choice, not flavour. Any alive
// tank inside the trigger radius trips an armed mine, owner included
// (src/sim/mines.ts stepMines' proximity loop has no owner exemption), so a
// hull parked on a mine is BY RULE in the proximity state, and a vertical
// element rises through it where every crown/ground mark was hidden. The one
// occluded-fuse case left is the owner camping their own UNARMED mine -- the
// player who placed it.
// ---------------------------------------------------------------------------

/** The selectable variants. `null`/absent = the shipped default treatment above. */
export type MineWarnStyle = 'lance' | 'slump' | 'spike';
export const MINE_WARN_STYLES: ReadonlySet<string> = new Set<MineWarnStyle>(['lance', 'slump', 'spike']);

/**
 * The shared heat ramp: emissive colour along a fixed 3-stop LUT from the body
 * pulse's own bright pole through orange to near-white.
 *
 * SEEDED AT THE PULSE'S BRIGHT POLE on purpose: the pre-existing armed pulse
 * oscillates below 0xff3322, so a ramp that STARTS there can only ever step
 * upward at window entry, never dip -- the monotone guarantee holds across the
 * handover without needing to know the pulse's phase.
 */
const HEAT_LUT: readonly [number, number, number][] = [
  [0xff / 255, 0x33 / 255, 0x22 / 255],
  [0xff / 255, 0x88 / 255, 0x33 / 255],
  [0xff / 255, 0xf4 / 255, 0xe0 / 255],
];

/** Heat colour for a fuse growth, writing into `out` (no per-frame allocation). */
export function heatColor(growth: number, out: THREE.Color): THREE.Color {
  const g = clamp01(growth) * 2;
  const i = g < 1 ? 0 : 1;
  const t = g - i;
  const a = HEAT_LUT[i];
  const b = HEAT_LUT[i + 1];
  return out.setRGB(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}

/** Emissive intensity for a fuse growth: 1 at window entry, 2.5 at expiry. */
export function heatIntensity(growth: number): number {
  return 1 + 1.5 * clamp01(growth);
}

/** Uniform cook-off swell (lance/spike fuse): scale 1.0 at entry, 1.10 at expiry. */
export function cookoffScale(growth: number): number {
  return 1 + 0.10 * clamp01(growth);
}

/**
 * The slump fuse (failing pressure vessel): the mine spreads WIDE and squashes
 * FLAT. Horizontal spread is the one axis the overhead camera does not
 * compress, which is why the judging rated this the strongest 25px fuse read.
 */
export function slumpScale(growth: number): { xz: number; y: number } {
  const g = clamp01(growth);
  return { xz: 1 + 0.45 * g, y: 1 - 0.5 * g };
}

/**
 * The fuse growth FROZEN at the moment the mine was tripped -- a pure function
 * of mine state, not view memory: elapsed-since-trip is
 * (DELAY - proximityDelayLeft) ticks, so the timer AT the trip is
 * `timer + elapsed * DT`, and the frozen growth is the growth at that timer.
 *
 * Why freeze at all: the fuse keeps burning underneath a trip window, so an
 * unfrozen body would keep swelling while the vertical counts down -- two
 * moving channels for one certain outcome, which the judging flagged as the
 * reverse-snap hazard's sibling. Frozen, the vertical is the sole mover.
 */
export function frozenFuseGrowth(mine: Mine): number {
  if (mine.proximityDelayLeft === undefined) return 0;
  const elapsed = (MINE_PROXIMITY_DELAY_TICKS - mine.proximityDelayLeft) * DT;
  const timerAtTrip = mine.timer + elapsed;
  if (timerAtTrip > FUSE_WARNING_SECONDS) return 0;
  return clamp01(1 - timerAtTrip / FUSE_WARNING_SECONDS);
}

/** What the BODY shows during a trip, per style -- see each style's rationale. */
export function styleBodyGrowthDuringTrip(style: MineWarnStyle, mine: Mine): number {
  // spike: the body slams to full heat at the trip and holds -- "committed".
  // lance/slump: the body freezes where the fuse left it; the vertical carries time.
  return style === 'spike' ? 1 : frozenFuseGrowth(mine);
}

// ---- lance: fixed full-height lance, a bright bead DESCENDS it ----

export const LANCE_HEIGHT = 1.3;
export const LANCE_RADIUS = 0.05;

/**
 * Bead altitude for a lit fraction: top of the lance at the trip tick, touching
 * the crown exactly on the last rendered frame before the blast. Altitude IS
 * time remaining, and the lance is the visible denominator -- the still-frame
 * clock the judged field kept converging on.
 */
export function beadHeight(lit: number, crownY: number): number {
  return crownY + (LANCE_HEIGHT - crownY) * (1 - clamp01(lit));
}

/**
 * The lance: an open 8-sided additive cylinder whose vertex colours fade to
 * black at the top, so the additive blend dissolves it into the sky with no
 * hard tip -- the no-shader version of a light column.
 */
export function makeLanceMesh(): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(LANCE_RADIUS, LANCE_RADIUS, LANCE_HEIGHT, 8, 1, true);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // y runs -H/2..H/2; brightness 1 at the base fading to 0 at the top.
    const t = 1 - (pos.getY(i) / LANCE_HEIGHT + 0.5);
    colors[i * 3] = t;
    colors[i * 3 + 1] = t;
    colors[i * 3 + 2] = t;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color: MINE_WARNING_COLOR,
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  mesh.name = 'mine-warn-vert';
  return mesh;
}

/** The striker bead: a sprite (auto-billboards) on the shared radial falloff. */
export function makeBeadSprite(): THREE.Sprite {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      color: 0xffe9b0,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  sprite.scale.set(0.16, 0.16, 1);
  sprite.name = 'mine-warn-bead';
  return sprite;
}

// ---- spike: a soft vertical light vent RISES out of the mine ----

/**
 * Vent height for a lit fraction: a 0.45-unit floor from the trip tick, 1.4 at the blast.
 *
 * The floor is calibration from a capture, not taste: grown from zero, the vent's soft
 * radial falloff kept it illegible against the hull until past mid-window -- but
 * spike-presence is this style's binary state discriminator, so it must be readable from
 * the FIRST tripped frame. A one-step appearance is the same one-way step the lance makes
 * and is not an oscillation; growth above the floor stays the monotone progress channel.
 */
export function spikeHeight(lit: number): number {
  return 0.45 + 0.95 * clamp01(lit);
}

/**
 * Two crossed additive planes (an X in plan, so it reads at any camera yaw
 * without billboarding), each carrying the radial falloff stretched vertically
 * into a soft streak. The caller scales Y to spikeHeight and anchors the base
 * at the mine's crown.
 */
export function makeSpikeMesh(): THREE.Group {
  const group = new THREE.Group();
  const tex = makeGlowTexture();
  for (const ry of [0, Math.PI / 2]) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.24, 1),
      new THREE.MeshBasicMaterial({
        map: tex,
        color: MINE_WARNING_COLOR,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    mesh.position.y = 0.5; // unit plane, base at group origin
    mesh.rotation.y = ry;
    group.add(mesh);
  }
  group.name = 'mine-warn-vert';
  return group;
}

// ---- slump's mast: a striker rod TELESCOPES up out of the dome ----

/**
 * Mast height: ease-OUT (fast first), so the tip clears a parked hull within
 * roughly the first fifth of the window -- the point of the vertical channel
 * is the occluded case, so it must escape EARLY, not at its leisure.
 */
export function mastHeight(lit: number): number {
  const q = clamp01(lit);
  return 1.1 * (1 - (1 - q) * (1 - q));
}

/** Rod + octahedron tip + glow sprite; the caller scales the rod to mastHeight. */
export function makeMastMesh(): THREE.Group {
  const group = new THREE.Group();
  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 1, 6),
    new THREE.MeshBasicMaterial({
      color: MINE_WARNING_COLOR,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  rod.position.y = 0.5;
  rod.name = 'mast-rod';
  const tip = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.06),
    new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  tip.position.y = 1;
  tip.name = 'mast-tip';
  group.add(rod);
  group.add(tip);
  group.name = 'mine-warn-vert';
  return group;
}

/**
 * Dispose a vertical group/mesh including any textures bound to sprite or
 * plane materials -- the same Material.dispose-does-not-free-textures trap
 * disposeMineGlowMesh exists for.
 */
export function disposeMineVert(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material & { map?: THREE.Texture | null };
    if (mat) {
      mat.map?.dispose();
      mat.dispose();
    }
  });
  obj.parent?.remove(obj);
}
