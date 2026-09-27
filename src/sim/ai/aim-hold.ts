import type { Tank } from '../types';
import { angleDelta } from '../types';
import type { ResolvedTankConfig } from '../config';
import { AI_AIM_BREAK, TICK_HZ } from '../constants';

/**
 * The aim-hold layer (issue #344): an AI tank commits to an aim angle for a span and
 * slews toward that, instead of re-solving `aimLead` from scratch every tick and chasing
 * the result.
 *
 * Measured before this layer existed, over 60 seeds x 2 arenas x 2 player policies: the
 * turret was perfectly still on only 42.53% of live ticks for teal and 72.93% for brown,
 * micro-correcting on the rest at 60Hz, which reads as a gun that shimmers rather than
 * tracks.
 *
 * It is not aim error: setting AI_AIM_SPREAD to zero moved the micro-nudge rate by at most
 * 1.3 points. The motion is `aimLead` genuinely tracking a moving player, so the fix belongs
 * on the target, not on the slew and not on the error term.
 *
 * Total rotation is deliberately not the metric: the turret must cover the player's
 * bearing change either way. What changes is the distribution -- dwell, then a deliberate
 * correction, instead of continuous nudging.
 *
 * The span is a plain countdown, not a seeded roll, so this adds no RNG stream and cannot
 * desync an existing one.
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
 * Split from `holdAimFor`, as commitHeading is from commitMove, because the bot that drives
 * a player slot (decidePlayerInput, player-profile.ts) is forbidden from writing to the
 * world, so it would keep its own state and call this directly.
 *
 * The break test uses `angleDelta`, not a raw subtraction, so a hold survives the +/-pi
 * seam: a raw subtraction would read two angles either side of it as most of a full turn
 * and re-solve every time a tank tracked through due west.
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
