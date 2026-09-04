/**
 * The menu-transition vocabulary (issue #542).
 *
 * The owner's report on the shipped build was "transitions between menus seem to not
 * work? Or at least I haven't seen them in action?" -- and nothing was broken. Issue
 * #364's one motion contract animated a 150ms opacity crossfade between two full-bleed
 * surfaces occupying the same rectangle, with no movement at all. Whether that was a
 * defect or a deliberately subliminal softening had never been written down, so the issue
 * settled it by COMPARISON: four named treatments, judged side by side.
 *
 * THE COMPARISON IS OVER AND `rise` WON. The owner's ruling on the clips: "I think rise
 * is the way to go. Default to that and leave the rest selectable still via flags or
 * whatever." So the shipped transition is now the crossfade PLUS a 16px upward translate
 * on the entering content, and `?dev=1&menuTransition=` keeps naming the alternatives.
 *
 * Deliberately NOT the #526/#536 pattern of retiring the flag once a winner is chosen.
 * Those retired theirs because the winner became unconditional and a flag toggling
 * always-on behaviour is a lie. Here the alternatives stay genuinely selectable, so the
 * flag still means something -- and `fade` in particular has to stay reachable, because
 * it is how anyone gets the pre-#542 behaviour back.
 *
 * A tiny module of its own rather than a block in `devflags.ts` or `hud.ts`, for the
 * reason `presentation/blocked-fire.ts` exists: the flag parser and the HUD both need to
 * name these treatments, and `devflags.ts` importing `hud.ts` (4966 lines, and it pulls
 * in the stylesheet) to learn four strings would be the wrong direction entirely. It is
 * NOT in `src/presentation/`, whose rule is vocabulary that more than one LAYER reads;
 * both readers here are in `src/game/`.
 *
 * Everything each treatment actually does lives in `hud.css`. This file names them and
 * maps each to its modifier class; it deliberately holds no duration, distance, or
 * scale, because issue #364's first criterion is that `--ui-transition-duration` is the
 * single definition of how long a transition takes and `hud.ts` READS it from the
 * stylesheet rather than mirroring it. A number here would be exactly the second,
 * driftable copy that criterion forbids.
 */

/**
 * The four treatments, and what each one is for now that the comparison has ruled.
 *
 * `rise` SHIPS: opacity plus a 16px upward translate on the entering content, at the same
 * 150ms the crossfade always ran at. It is the no-flag path, so selecting it explicitly
 * and omitting the flag are the same thing -- see `menuTransitionClass`.
 *
 * `fade` is the pre-#542 transition: opacity only, 150ms, no movement. It stays because
 * it is the one way to get the old behaviour back, which is what makes a regression
 * report about the new default answerable rather than a matter of memory.
 *
 * `fade-long` is that same crossfade at double the duration. It was the arm that made the
 * comparison mean anything -- it separated DURATION from MOVEMENT, so `rise` could not
 * take credit for merely being slower -- and it stays selectable for the same reason
 * `fade` does.
 *
 * `settle` is the movement `rise` was chosen over: a slight scale up rather than a
 * translate, matched to `rise` by amplitude so the two differed in KIND of movement
 * rather than in amount of it.
 */
export type MenuTransition = 'fade' | 'fade-long' | 'rise' | 'settle';

/**
 * The treatment the game ships, and therefore the one with no class and no rule.
 *
 * A named constant rather than a literal inside `menuTransitionClass`, because the
 * property it stands for is "whatever is DEFAULT is the thing with no class of its own",
 * and that property has already had to move once. `fade` held it while the experiment
 * ran; `rise` holds it now. Every guard that protects it -- the mapping, the mounted-DOM
 * identity, and the stylesheet's rule count -- is written against this constant rather
 * than against a spelled-out name, so a future ruling moves the guard with the default
 * instead of leaving it pointed at a treatment that is no longer the shipped one.
 *
 * Annotated as `MenuTransition` rather than left to infer the literal `'rise'`, so a
 * comparison against it stays a runtime question. Inferred, TypeScript would narrow
 * `treatment` past the check below and could fold a guard written against this constant
 * into a tautology -- which is the one thing a guard meant to survive the default moving
 * must not become.
 */
export const SHIPPED_MENU_TRANSITION: MenuTransition = 'rise';

/**
 * Exported so a consumer's suite can assert one row PER TREATMENT rather than per
 * remembered case -- the shape `BLOCKED_FIRE_CUES` established after an arm was added to
 * its union twice without any table noticing.
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
 * `SHIPPED_MENU_TRANSITION` MAPS TO NULL, and that is the whole design rather than an
 * optimisation. What has to be true is that an absent flag and the shipped treatment
 * named explicitly are indistinguishable; the only way to make that true by construction
 * instead of by inspection is for the shipped treatment to BE the shipped path -- same
 * DOM, same classes, same cascade -- rather than a rule that restates the shipped values
 * and can drift from them the first time the token or the keyframes move.
 * `menu-transition.test.ts` asserts the identity; a `.hud--menu-transition-rise` rule
 * would make that assertion about a copy.
 *
 * This inverted when `rise` was adopted. `fade` used to be the treatment with no class,
 * and now carries one -- an explicit rule that turns the shipped movement back off. That
 * direction matters: the DEFAULT is what must never be restated, and an alternative
 * saying "not the default" is a genuine rule with something of its own to say.
 *
 * `null` for an unknown treatment cannot happen through `MenuTransition`, but the
 * parameter is widened to accept the parser's `null` (absent or unrecognised flag) so
 * every caller has one call rather than a null check plus a call.
 */
export function menuTransitionClass(treatment: MenuTransition | null): string | null {
  if (treatment === null || treatment === SHIPPED_MENU_TRANSITION) return null;
  return `hud--menu-transition-${treatment}`;
}
