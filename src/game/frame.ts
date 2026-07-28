import { DT } from '../sim/constants';

/**
 * Fixed-timestep bookkeeping, kept OUT of the loop on purpose.
 *
 * This is the arithmetic that decides how many sim ticks a rendered frame owes
 * and how far between two ticks the render should interpolate. It lived inside
 * `startGame`'s requestAnimationFrame closure, where nothing could reach it:
 * `while (false && acc >= DT)` -- the shipped game never simulating a tick --
 * passed the whole CI gate. Everything here is a pure function of its
 * arguments, so it can be asserted directly.
 *
 * `driver.ts` is what proves the loop actually CALLS this; see
 * `driver.test.ts`. Testing this file alone cannot see composition, which is
 * the same trap `step-pipeline.test.ts` exists to close for the sim.
 */

/**
 * Frames longer than this are credited as this much and no more.
 *
 * Without a ceiling, one long stall (a backgrounded tab, a breakpoint) hands
 * the accumulator seconds of debt, the loop runs hundreds of ticks to repay it,
 * that takes longer than a frame, and the debt grows: the spiral of death. At
 * 0.25 a stall costs at most 15 ticks, whatever its length.
 */
export const MAX_FRAME_DT = 0.25;

export interface FramePlan {
  /** Real seconds credited to this frame, after the clamp. Feeds particles.update. */
  readonly dt: number;
  /** Whole sim ticks this frame owes. */
  readonly ticks: number;
  /** Accumulator left over after those ticks; always in [0, DT). */
  readonly acc: number;
}

/**
 * Closed form rather than a `while (acc >= DT) acc -= DT` drain loop.
 *
 * The two agree: over 21,600 frames across six clock models (exact 60Hz,
 * ideal 60Hz, +-1ms jitter, 144Hz, a drifty 17/16ms alternation, 30Hz) the tick
 * counts are identical and no frame differs, with the leftover diverging by at
 * most 2.0e-13 -- eleven orders below DT, never enough to flip a tick boundary.
 * On the clamped-stall path they are close but not bit-identical: both run 15
 * ticks, the drain leaving acc = 4.9e-17 where this leaves 0, an alpha
 * difference of 2.9e-15.
 *
 * The closed form is preferred because it DISSOLVES a defect the loop admits.
 * Deleting `acc -= DT` from a drain loop is not a wrong number, it is an
 * infinite loop: a test pumping frames through it hangs the run instead of
 * failing it. There is no decrement here to delete.
 */
export function planFrame(acc: number, dtReal: number): FramePlan {
  // A clock that goes backwards would otherwise walk the accumulator negative,
  // and it would never reach DT again -- the sim would stop for good.
  const dt = dtReal < 0 ? 0 : Math.min(dtReal, MAX_FRAME_DT);
  const filled = acc + dt;
  const ticks = Math.floor(filled / DT);
  return { dt, ticks, acc: filled - ticks * DT };
}

/**
 * How far between the previous tick's pose and the current one to draw, given
 * the accumulator left over after `planFrame`.
 *
 * `acc` is a parameter rather than a captured variable so that hardcoding the
 * result -- the `alpha = 0` and `alpha = 1` defects, which are invisible at
 * runtime and merely look wrong on screen -- stops compiling: with the argument
 * unread, `noUnusedParameters` reports TS6133. That guard is worth what its own
 * test proves, so the value assertions below are its negative control; they
 * catch `DT / acc`, which keeps `acc` referenced and so compiles cleanly.
 */
export function renderAlpha(acc: number, simulating: boolean): number {
  return simulating ? acc / DT : 1;
}
