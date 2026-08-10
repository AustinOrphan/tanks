// No `@vitest-environment` pragma on purpose: this file runs under the global
// `environment: 'node'`, where any DOM reference is a ReferenceError. That is
// what keeps frame.ts free of the DOM -- purity.test.ts scans only src/sim/, so
// nothing else guards it.
import { describe, it, expect } from 'vitest';
import { DT } from '../sim/constants';
import { animationDt, planFrame, renderAlpha, MAX_FRAME_DT } from './frame';
import type { GameState } from './state';

describe('planFrame', () => {
  it('banks a short frame instead of ticking', () => {
    const p = planFrame(0, DT / 3);
    expect(p.ticks).toBe(0);
    expect(p.acc).toBeCloseTo(DT / 3, 12);
  });

  it('ticks once when the accumulator reaches EXACTLY one step', () => {
    // The only way to land exactly on DT is to carry it in: a real clock
    // essentially never hits the boundary by subtraction (measured 20 of 3600
    // vsync frames, each recovered on the next). Reaching it through `acc` is
    // also the only construction that separates `>=` from `>`.
    const p = planFrame(DT, 0);
    expect(p.ticks).toBe(1);
  });

  it('runs the WHOLE debt on a slow frame, not one tick of it', () => {
    // 100ms owes 6 ticks. Capping at 1 is permanent slow motion on any machine
    // that cannot hold 60fps.
    const p = planFrame(0, 0.1);
    expect(p.ticks).toBe(6);
  });

  it('carries the leftover into the next frame', () => {
    // 0.02s = 1 tick (0.01667) with 0.00333 left over.
    const first = planFrame(0, 0.02);
    expect(first.ticks).toBe(1);
    expect(first.acc).toBeGreaterThan(0);
    // Carrying it forward is what makes the next 0.014 reach a tick at all:
    // 0.00333 + 0.014 = 0.01733 > DT. Discarding the remainder would yield 0.
    const second = planFrame(first.acc, 0.014);
    expect(second.ticks).toBe(1);
  });

  it('starts from the accumulator it is given', () => {
    // Ignoring `acc` and planning from dt alone loses every partial frame.
    expect(planFrame(DT * 0.9, DT * 0.9).ticks).toBe(1);
  });

  it('leaves the accumulator strictly below one step, at every dt tried', () => {
    // Population: the 9 dt values below, from a third of a tick to twice the
    // clamp. This is the invariant renderAlpha divides by, so a leftover of a
    // whole step would render past the pose it is interpolating toward.
    for (const dt of [DT / 3, DT, 0.02, 0.033, 0.05, 0.1, 0.25, 0.4, 0.5]) {
      const p = planFrame(0, dt);
      expect(p.acc).toBeGreaterThanOrEqual(0);
      expect(p.acc).toBeLessThan(DT);
    }
  });

  it('caps a long stall at MAX_FRAME_DT worth of ticks', () => {
    // A 2s stall uncapped is 120 ticks in one frame, which takes longer than a
    // frame to run, which grows the debt further.
    expect(planFrame(0, 2).ticks).toBe(Math.floor(MAX_FRAME_DT / DT));
    expect(planFrame(0, 2).ticks).toBe(15);
    expect(planFrame(0, 60).ticks).toBe(15);
  });

  it('is a ceiling, not a floor: an ordinary frame passes through untouched', () => {
    // Inverting the comparison makes every ordinary frame a 0.25s frame, i.e.
    // 15 ticks each, and the game runs 15x too fast.
    expect(planFrame(0, DT).dt).toBeCloseTo(DT, 12);
    expect(planFrame(0, DT).ticks).toBe(1);
  });

  it('does not clamp below one step', () => {
    // A clamp under DT starves the sim: at 0.005 a 60Hz frame owes 0 ticks
    // most frames and the game runs at a fraction of speed.
    expect(planFrame(0, 0.02).ticks).toBe(1);
    expect(planFrame(0, 0.02).dt).toBeCloseTo(0.02, 12);
  });

  it('cannot be walked backwards by a non-monotonic clock', () => {
    // Without the guard a negative dt drives acc negative, and it never climbs
    // back to DT: the sim stops permanently.
    const p = planFrame(0, -1);
    expect(p.dt).toBe(0);
    expect(p.acc).toBeGreaterThanOrEqual(0);
    expect(planFrame(p.acc, DT).ticks).toBe(1);
  });
});

describe('renderAlpha', () => {
  it('is the fraction of a step the leftover fills', () => {
    // Negative control for the tsc guard: `alpha = 0` and `alpha = 1` stop
    // compiling (TS6133, `acc` unread), but `DT / acc` keeps acc referenced and
    // compiles -- it yields Infinity at acc 0, which entities.sync silently
    // clamps to 1, so it must be caught here at the value.
    expect(renderAlpha(0, true)).toBe(0);
    expect(renderAlpha(DT / 2, true)).toBeCloseTo(0.5, 12);
    expect(renderAlpha(DT * 0.25, true)).toBeCloseTo(0.25, 12);
  });

  it('is 1 when not simulating, so a static pose renders at its current pose', () => {
    expect(renderAlpha(DT / 2, false)).toBe(1);
    expect(renderAlpha(0, false)).toBe(1);
  });
});

describe('animationDt: the render animation clock', () => {
  // The rule this pins is a DECISION, so both halves have to be able to fail, and they
  // fail to different mutations: dropping the carve-out (`return dt`) kills the paused
  // case, and widening it to every non-simulating state (`state === 'playing' ? dt : 0`)
  // kills the splash/title/win/lose cases.
  const STATES: GameState[] = ['splash', 'title', 'playing', 'win', 'lose', 'paused'];

  it('stops dead while the game is PAUSED -- particles as well as skins', () => {
    expect(animationDt(0.02, 'paused')).toBe(0);
    expect(animationDt(MAX_FRAME_DT, 'paused')).toBe(0);
  });

  it.each(STATES.filter((s) => s !== 'paused'))('runs at the real delta while %s', (state) => {
    expect(animationDt(0.02, state)).toBeCloseTo(0.02, 12);
  });

  it('is exactly ONE state of the six that stops it', () => {
    // Enumerated from the union rather than sampled: STATES is typed `GameState[]`, so
    // a seventh state added to state.ts is a decision to make here, not a silent gap --
    // though only if someone adds it to this list, which tsc cannot force.
    const stopped = STATES.filter((s) => animationDt(0.02, s) === 0);
    expect(stopped).toEqual(['paused']);
  });

  it('passes the frame plan\'s delta through rather than substituting a step of its own', () => {
    // Catches a clock that ignores its argument and returns a fixed 1/60 -- which would
    // look right on a 60Hz monitor and be wrong on every other refresh rate.
    expect(animationDt(0.007, 'playing')).toBeCloseTo(0.007, 12);
    expect(animationDt(0.1, 'title')).toBeCloseTo(0.1, 12);
  });
});
