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
 * here is the timing contract (when the ring thickens, when the fill is full), and that is
 * worth testing at exact values without a WebGL context. The mesh factories below are the
 * dumb half.
 *
 * THE TWO STATES ARE ON DIFFERENT CHANNELS ON PURPOSE, which is what makes them
 * distinguishable without relying on colour, and readable in a still frame:
 *
 *   - FUSE URGENCY is an OUTLINE that THICKENS as the fuse runs out, blinking faster as it
 *     goes. Geometry (stroke weight) plus timing (blink rate).
 *   - PROXIMITY TRIP is a FILL that grows from the middle OUTWARD. Geometry (filled area),
 *     monotone in time-to-blast, with no blink at all.
 *
 * So a single frame with no motion still separates them (outline vs fill), and a player who
 * cannot resolve the outline still gets an accelerating blink. Neither state is carried by
 * hue: both are driven off the same warning colour.
 *
 * Both are functions of MINE STATE, never of a wall clock -- two machines replaying the same
 * world draw the same frame, and a paused game stops rather than continuing to flash. That
 * is the same discipline entities.ts's fuse pulse already follows.
 */
export interface MineWarningFrame {
  /**
   * The fuse-urgency ring, or null when the mine is not inside its final fuse window.
   * `inner` is the ring's inner radius as a fraction of its outer radius, so a SMALLER
   * number is a THICKER stroke; `on` is the blink's square wave.
   */
  fuse: { inner: number; on: boolean } | null;
  /**
   * The proximity fill as a fraction of the mine's radius, or null when the mine has not
   * been tripped. 0 on the tick it is tripped, 1 on the last frame before the blast.
   */
  proximity: { fill: number } | null;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The fuse window, in seconds -- the same threshold mines.ts latches its event on. */
export const FUSE_WARNING_SECONDS = MINE_FUSE_WARNING_TICKS * DT;

/**
 * Ring stroke at window entry and at expiry, as a fraction of the ring's own outer radius,
 * together with how far that outer radius reaches as a multiple of the mine's radius.
 *
 * CONTAINED WITHIN THE MINE (owner ruling on PR #396). An earlier revision put both cues on
 * the GROUND around the mine, at 2.2x and 3.0x its radius, so a warning painted a patch of
 * arena wider than the object it belonged to. The ruling: keep them on or within the mine's
 * visible top surface, accepting that they are smaller and a little harder to see.
 *
 * 0.54 is chosen off the dome's own profile rather than picked. The body is a lathe whose
 * elliptical dome falls away from its apex fast: at 0.5x the mine's radius the surface is
 * 0.008 below the apex, at 0.54x about 0.017, and by 0.79x it is 0.046 -- far enough that a
 * flat disc laid at apex height would visibly float off the curve at its rim. 0.54 keeps the
 * cues inside the flat part of the crown, so they read as markings ON the mine.
 */
const RING_INNER_THIN = 0.85;
const RING_INNER_THICK = 0.5;
export const RING_OUTER_SCALE = 0.54;

/**
 * Blink cycles across the whole fuse window. Phase is QUADRATIC in urgency, so the rate
 * climbs linearly rather than stepping -- the same shape as entities.ts's body pulse.
 *
 * Deliberately low. Instantaneous rate peaks at `4 * TURNS` Hz (d/dt of TURNS*u^2 with u
 * running 0->1 over FUSE_WARNING_SECONDS), so 1.5 turns caps the blink at 6 Hz. A faster
 * blink reads as more urgent and is easy to reach for, but photosensitivity guidance treats
 * sustained flashing above ~3 Hz as a real hazard, and this is a small outline rather than a
 * full-screen flash only because it was kept small. #289 owns the global reduced-flash
 * preference; when it lands, this is one of the things it should be able to turn off.
 */
const BLINK_TURNS = 1.5;

/**
 * Project one mine's warning state.
 *
 * A detonated mine has no warning frame: entities.ts stops drawing it entirely, and the
 * blast is its own effect. That is also what ends the proximity fill exactly at the blast
 * rather than letting it linger.
 */
export function mineWarningFrame(mine: Mine): MineWarningFrame {
  if (mine.detonated) return { fuse: null, proximity: null };

  let fuse: MineWarningFrame['fuse'] = null;
  if (mine.timer <= FUSE_WARNING_SECONDS) {
    // 0 the tick the window is entered, 1 at expiry.
    //
    // The HIGH clamp is the one that does work, and it is not decorative: stepMines
    // subtracts dt BEFORE it checks expiry, so a mine is observable at a negative timer for
    // one tick, which drives this ratio past 1. Unclamped, `inner` overshoots
    // RING_INNER_THICK and the ring starts growing THINNER again at the exact moment it
    // should be most urgent. The LOW bound is unreachable here -- this branch only runs
    // while `timer <= FUSE_WARNING_SECONDS`, so the ratio is never negative -- and survives
    // only because clamp01 is the shared helper. Do not read it as guarding anything;
    // replacing it with Math.min(1, ...) is an equivalent mutant.
    const urgency = clamp01(1 - mine.timer / FUSE_WARNING_SECONDS);
    const inner = RING_INNER_THIN + (RING_INNER_THICK - RING_INNER_THIN) * urgency;
    const phase = BLINK_TURNS * urgency * urgency;
    fuse = { inner, on: phase - Math.floor(phase) < 0.5 };
  }

  let proximity: MineWarningFrame['proximity'] = null;
  if (mine.proximityDelayLeft !== undefined) {
    // WHY THE -1: stepMines decrements FIRST and detonates when the counter reaches 0, so
    // the values that are ever RENDERED run DELAY down to 1 and never 0. Dividing by
    // DELAY - 1 puts full fill on that last drawn frame, which is the frame the blast
    // starts on -- the acceptance criterion's "final proximity frame agrees with the
    // blast-start tick". Dividing by DELAY instead would top out at 29/30 and the fill
    // would visibly never complete.
    const span = MINE_PROXIMITY_DELAY_TICKS - 1;
    const fill = span <= 0 ? 1 : clamp01((MINE_PROXIMITY_DELAY_TICKS - mine.proximityDelayLeft) / span);
    proximity = { fill };
  }

  return { fuse, proximity };
}

/** Warning colour, shared by both states -- the DISTINCTION is never the hue. */
export const MINE_WARNING_COLOR = 0xffb43a;

/**
 * How far the proximity fill reaches at full, as a multiple of the mine body's radius.
 *
 * Matched to RING_OUTER_SCALE so a completed fill exactly reaches the fuse ring's outer
 * edge: the two cues then share one footprint on the crown and cannot be told apart by SIZE,
 * only by their shapes -- an annulus that thickens versus a disc that grows. That is what
 * keeps them distinguishable now that neither may spread onto the arena floor.
 *
 * This replaces a 3.0 reach that deliberately extended past a tank standing on the mine.
 * The owner ruling on PR #396 traded that visibility away for containment; the cost is
 * stated rather than hidden -- see the module comment on what a hull now hides.
 */
export const FILL_OUTER_SCALE = 0.54;

const RING_SEGMENTS = 48;
/** Quantisation of the ring's thickness. Invisible at eight steps across a 0.5 s window. */
export const RING_STEPS = 8;

/**
 * The ring's thickness lives in GEOMETRY -- RingGeometry bakes both radii, and scaling a
 * ring scales its radius rather than its stroke -- so a changing thickness means a new
 * geometry. Two ways to avoid rebuilding one every frame: share a ladder of geometries
 * across mines, or give each mine its own and rebuild only when its quantised step changes.
 *
 * THE SECOND, deliberately. A shared ladder is fewer objects, but entities.ts disposes a
 * removed mine with `disposeObject`, which TRAVERSES and disposes geometry -- so the first
 * mine to detonate would free a geometry its neighbours were still drawing with. Making the
 * geometry per-mine keeps disposal uniform with every other view in that file, at a cost of
 * at most RING_STEPS small allocations per mine per fuse, and only for mines actually inside
 * their final window.
 */
export function ringInnerForStep(step: number): number {
  const t = step / (RING_STEPS - 1);
  return RING_INNER_THIN + (RING_INNER_THICK - RING_INNER_THIN) * t;
}

/** One ring at a quantised thickness step, owned by the caller and disposed with it. */
export function makeMineWarningRing(outerRadius: number, step: number): THREE.RingGeometry {
  return new THREE.RingGeometry(outerRadius * ringInnerForStep(step), outerRadius, RING_SEGMENTS);
}

/** Which thickness step a frame's `inner` quantises onto. */
export function ringStepFor(inner: number): number {
  const t = (inner - RING_INNER_THIN) / (RING_INNER_THICK - RING_INNER_THIN);
  const step = Math.round(clamp01(t) * (RING_STEPS - 1));
  // `+ 0` normalises -0 to 0. The divisor above is negative (THICK < THIN), so the thinnest
  // frame divides 0 by a negative and yields -0, which survives clamp and round. Harmless as
  // an array index, but it leaks into any test or log that compares with Object.is.
  return step + 0;
}

/**
 * The fuse ring's mesh. Flat on the ground, depth-tested normally: it lives entirely
 * OUTSIDE the body radius (see RING_INNER_THICK), so ordinary occlusion is correct for it
 * and a tank driving over the mine properly covers it.
 *
 * Geometry is assigned by the caller from the frame's thickness step; the placeholder here
 * is replaced on the first sync rather than being drawn.
 */
export function makeMineWarningRingMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1, 8),
    new THREE.MeshBasicMaterial({
      color: MINE_WARNING_COLOR,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.name = 'mine-fuse-warning';
  return mesh;
}

/**
 * The proximity fill's mesh: a unit disc the caller scales by the frame's fill fraction, and
 * positions just above the mine's dome (see FILL_Y in entities.ts for why the HEIGHT is what
 * makes this cue visible at all).
 *
 * Depth-tested normally on purpose. An earlier version cleared the body with
 * `depthTest: false` instead; a normal-speed capture showed it drawing over the TANK that
 * had walked onto the mine, which reads as a rendering bug rather than a warning. Lifting
 * the disc above the dome gets the same visibility without that, and a tank on top of the
 * mine correctly hides it.
 */
export function makeMineWarningFillMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(1, 32),
    new THREE.MeshBasicMaterial({
      color: MINE_WARNING_COLOR,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 3;
  mesh.name = 'mine-proximity-fill';
  return mesh;
}
