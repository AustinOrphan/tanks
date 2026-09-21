/**
 * The destroyed-hull decoration VOCABULARY (issue #232): which removal arms exist. Renderer-
 * independent, and here rather than in `render/` for the reason `shell-trail.ts` gives:
 * `game/devflags.ts` validates the flag's values, and a game module must not import Three.js
 * to learn a semantic. The geometry, the pool and the lifetime are `render/wreck.ts`.
 *
 * THE PROBLEM. A destroyed tank leaves nothing behind, so a board carries no history of what
 * happened on it: a player who looks away misses the kill entirely, and in versus there is no
 * trace of where a slot went down. #232 asks for a temporary hull silhouette at the death
 * position -- decoration, never an obstacle.
 *
 * AN EXPERIMENT, NOT A DEFAULT. `?dev=1&wreck=sink` draws it; without the flag nothing is
 * built and the shipped render is untouched. The issue closes on a chosen arm, not on this
 * module shipping.
 *
 * A FEEL CHOICE, AND DELIBERATELY AN ARM RATHER THAN A DECISION. #232 lists "fade, crumble,
 * sink, or otherwise" without picking, and "clearly inert and distinguishable from a living or
 * respawning tank" is a look rather than a threshold. The three arms differ only in what the
 * hull DOES on its way out, over the same lifetime, in the same place:
 *
 *  - `sink` -- the hull settles into the felt as it dims, so the board reclaims it. The
 *    strongest "this is over" reading, and the one most clearly not a tank, because no live
 *    tank ever goes below the floor.
 *  - `fade` -- the hull holds its pose and only dims. The quietest, and the only arm that is
 *    motionless by construction, so its reduced-motion form is its own form.
 *  - `tilt` -- the hull rolls onto its side. The most legible at a distance, since the
 *    silhouette itself changes rather than only its tone, and the most likely to read as
 *    debris rather than as a tank that stopped moving.
 *
 * `crumble` -- breaking into several settling pieces -- is NOT here. It is the only one of the
 * issue's suggestions that changes the pool's shape, because one death becomes several objects
 * and the cap stops meaning what it says. Building a one-piece imitation of it and calling it
 * `crumble` would put a fake option in front of the ruling.
 */
export const WRECK_EFFECTS = ['sink', 'fade', 'tilt'] as const;
export type WreckEffect = (typeof WRECK_EFFECTS)[number];

/** Whether a value is one of the arms, for the dev flag's reject-to-null parser. */
export function isWreckEffect(value: unknown): value is WreckEffect {
  return typeof value === 'string' && (WRECK_EFFECTS as readonly string[]).includes(value);
}
