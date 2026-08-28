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
