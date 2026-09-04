/**
 * The menu-transition EXPERIMENT's vocabulary (issue #542).
 *
 * The owner's report on the shipped build was "transitions between menus seem to not
 * work? Or at least I haven't seen them in action?" -- and nothing is broken. Issue
 * #364's one motion contract animates a 150ms opacity crossfade between two full-bleed
 * surfaces that occupy the same rectangle, with no movement at all. Whether that is a
 * defect or a deliberately subliminal softening was never written down, so this issue
 * settles it by COMPARISON rather than by argument: four named treatments, selectable
 * with `?dev=1&menuTransition=<id>`, judged side by side.
 *
 * A tiny module of its own rather than a block in `devflags.ts` or `hud.ts`, for the
 * reason `presentation/blocked-fire.ts` exists: the flag parser and the HUD both need to
 * name these arms, and `devflags.ts` importing `hud.ts` (4966 lines, and it pulls in the
 * stylesheet) to learn four strings would be the wrong direction entirely. It is NOT
 * in `src/presentation/`, whose rule is vocabulary that more than one LAYER reads; both
 * readers here are in `src/game/`.
 *
 * Everything each treatment actually does lives in `hud.css`. This file names the arms
 * and maps each to its modifier class; it deliberately holds no duration, distance, or
 * scale, because issue #364's first criterion is that `--ui-transition-duration` is the
 * single definition of how long a transition takes and `hud.ts` READS it from the
 * stylesheet rather than mirroring it. A number here would be exactly the second,
 * driftable copy that criterion forbids.
 */

/**
 * The four arms, and what each one isolates.
 *
 * `fade` is the CONTROL: today's shipped 150ms opacity crossfade, unchanged. Nothing may
 * be adopted that has not been compared against it.
 *
 * `fade-long` is the same crossfade at a longer duration and is the arm that makes the
 * comparison mean anything. It separates DURATION from MOVEMENT: if a longer fade reads
 * as well as either moving arm, the answer to this issue is one token's value and no new
 * keyframes at all. It is not a lesser version of `rise`/`settle`; it is what stops the
 * moving arms from taking credit for being slower.
 *
 * `rise` and `settle` add movement at the control's OWN 150ms, deliberately: the
 * hypothesis under test is that the eye reads position and size far better than opacity
 * at short durations, and an arm that changed both movement and duration at once could
 * not tell the two apart. One variable per arm, so each result names its own cause.
 */
export type MenuTransition = 'fade' | 'fade-long' | 'rise' | 'settle';

/**
 * Exported so a consumer's suite can assert one row PER ARM rather than per remembered
 * case -- the shape `BLOCKED_FIRE_CUES` established after an arm was added to its union
 * twice without any table noticing.
 */
export const MENU_TRANSITIONS: ReadonlySet<MenuTransition> = new Set<MenuTransition>([
  'fade',
  'fade-long',
  'rise',
  'settle',
]);

export function isMenuTransition(raw: string): raw is MenuTransition {
  return (MENU_TRANSITIONS as ReadonlySet<string>).has(raw);
}

/**
 * The `hud` root's modifier class for a treatment, or `null` when the treatment needs no
 * class at all.
 *
 * `fade` MAPS TO NULL, and that is the whole design of the control rather than an
 * optimisation. The acceptance criterion is that an absent flag and `menuTransition=fade`
 * are indistinguishable; the only way to make that true by construction instead of by
 * inspection is for `fade` to be the shipped path itself -- same DOM, same classes, same
 * cascade -- rather than a rule that restates the shipped values and can drift from them
 * the first time the token moves. `menu-transition.test.ts` asserts the identity; a
 * `.hud--menu-transition-fade` rule would make that assertion about a copy.
 *
 * `null` for an unknown treatment cannot happen through `MenuTransition`, but the
 * parameter is widened to accept the parser's `null` (absent or unrecognised flag) so
 * every caller has one call rather than a null check plus a call.
 */
export function menuTransitionClass(treatment: MenuTransition | null): string | null {
  if (treatment === null || treatment === 'fade') return null;
  return `hud--menu-transition-${treatment}`;
}
