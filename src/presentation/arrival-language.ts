/**
 * How ARRIVAL and DESTRUCTION speak, as a vocabulary (issue #230).
 *
 * The shipped pair share one language: every spawn entrance grows its ring outward (warp
 * 0.4->2.0, beacon 0.5->1.7, rise a bump) and so does the death pulse. The issue's first
 * complaint is exactly that -- they are "easy to miss and hard to tell apart at normal
 * speed".
 *
 * `opposed` gives them contrary ones. An arrival CONVERGES: a thin ring gathers from wide
 * and lands on the tank as it materialises. A destruction DETONATES: a fat band with a
 * held attack, thrown outward on an ease-out. Opposed in direction AND in weight, because
 * direction alone reads in a still frame and much less well in motion, which is where the
 * complaint lives.
 *
 * Here rather than in `render/` for the reason issue #473 moved the identity palette and
 * #653 kept the marker vocabulary here: `game/devflags.ts` must validate the value, and a
 * game module importing a Three.js module to learn a semantic is the coupling those moves
 * removed. The animation itself stays in `render/spawn-anim.ts` and `render/death-pulse.ts`.
 */
export const ARRIVAL_LANGUAGES = ['opposed'] as const;
export type ArrivalLanguage = (typeof ARRIVAL_LANGUAGES)[number];

/** The parse-side guard (`asArrivalLanguage`, devflags.ts). */
export function isArrivalLanguage(value: unknown): value is ArrivalLanguage {
  return typeof value === 'string' && (ARRIVAL_LANGUAGES as readonly string[]).includes(value);
}
