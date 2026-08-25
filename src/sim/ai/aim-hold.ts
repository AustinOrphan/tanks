import type { Tank } from '../types';
import { angleDelta } from '../types';
import type { ResolvedTankConfig } from '../config';
import { AI_AIM_BREAK, TICK_HZ } from '../constants';

/**
 * The aim-hold layer (issue #344): an AI tank commits to an aim ANGLE for a span and
 * slews toward that, instead of re-solving `aimLead` from scratch every tick and chasing
 * the result. Movement got this treatment in issue #222; this is the same shape for aim.
 *
 * The defect it closes, measured over 60 seeds x 2 arenas x 2 player policies
 * (evasion.measure.test.ts's turret columns): the turret was perfectly still on only
 * 42.53% of live ticks for teal and 72.93% for brown, micro-correcting on the rest at
 * 60Hz, which reads as a gun that shimmers rather than tracks.
 *
 * It is NOT aim error. Setting AI_AIM_SPREAD to zero moves the micro-nudge rate by at
 * most 1.3 points, in both directions (brown 17.08% -> 18.21%, teal 30.91% -> 29.88%) --
 * with no aim jitter at all the turret micro-adjusts just as much. The motion is
 * `aimLead` genuinely tracking a moving player, re-solved every tick with no memory of
 * where the tank had already decided to point. So the fix belongs on the TARGET, not on
 * the slew and not on the error term.
 *
 * Total rotation is deliberately NOT the metric: the turret must cover the player's
 * bearing change either way, so no tracking fix can reduce it. What changes is the
 * DISTRIBUTION -- dwell, then a deliberate correction, instead of continuous nudging.
 *
 * Deterministic and draw-free: the span is a plain countdown, not a seeded roll, so this
 * adds no RNG stream and cannot desync an existing one.
 */
export function holdAimFor(
  tank: Tank,
  cfg: ResolvedTankConfig,
  solution: number,
): { angle: number; nextHeld: number | null; nextHeldTicks: number } {
  return holdAim(
    tank.aiAimHeld ?? null,
    tank.aiAimHeldTicks ?? 0,
    Math.round(cfg.ai.aimHoldTime * TICK_HZ),
    AI_AIM_BREAK,
    solution,
  );
}

/**
 * `holdAimFor`'s logic with the held state passed in explicitly rather than read off the
 * `Tank`, mirroring commitHeading beside commitMove: the bot that drives a PLAYER slot
 * (decidePlayerInput, player-profile.ts) is forbidden from writing to the world, so it
 * would keep its own state and call this directly.
 *
 * The break test uses `angleDelta`, not a raw subtraction, so a hold survives the +/-pi
 * seam: an angle a hair under +pi and one a hair over -pi are two hundredths of a radian
 * apart, and a raw subtraction would read them as most of a full turn and re-solve every
 * time a tank tracked through due west.
 */
export function holdAim(
  held: number | null,
  ticks: number,
  spanTicks: number,
  breakRad: number,
  solution: number,
): { angle: number; nextHeld: number | null; nextHeldTicks: number } {
  if (held !== null && ticks > 0 && Math.abs(angleDelta(held, solution)) < breakRad) {
    return { angle: held, nextHeld: held, nextHeldTicks: ticks - 1 };
  }
  return { angle: solution, nextHeld: solution, nextHeldTicks: spanTicks };
}
