/**
 * The gameplay topbar the game ships, and the alternatives still selectable beside it
 * (issue #552).
 *
 * The owner's notes on the bar were questions -- "the campaign top bar does not really
 * need an enemy count I think", "it should not show the denominator of levels, but just
 * the current level, probably, I think", "Maybe we should have 'campaign' in the top
 * bar?" -- so six arms were built behind `?dev=1&topbar=` and captured side by side, the
 * way #542's menu transitions and #516/#356's cue arms were settled.
 *
 * THE COMPARISON IS OVER AND `spare-chips` WON. The ruling, with its reasons:
 *
 *  - the enemy count "might just be noise and unnecessary", so it goes;
 *  - `Level: 1` without the denominator, and NOT to save space -- "I don't want to
 *    necessarily reveal how many levels there are";
 *  - "I like the chips", so CAMPAIGN / PRACTICE / VS on every kind.
 *
 * Deliberately NOT the #526/#536 pattern of retiring the flag once a winner is chosen.
 * Those retired theirs because the winner became unconditional and a flag toggling
 * always-on behaviour is a lie. Here the alternatives stay genuinely selectable -- and
 * `full` in particular has to stay reachable, because it is how anyone gets the
 * pre-ruling bar back, which is what makes a regression report about the new default
 * answerable rather than a matter of memory.
 *
 * THE ARM NAMES STILL DESCRIBE REMOVALS FROM `full`, because that is the vocabulary the
 * ruling was made in and the strings in the URLs the owner already has. What INVERTED is
 * the departures table below: it is keyed off the shipped bar, and the shipped bar is now
 * the spare one. So `enemies-only` still means "the arm that removes only the enemy
 * count" and is written here as the two restorations that leaves.
 *
 * DEPARTURES, NOT DESCRIPTIONS. `topbarDepartures` says what an arm CHANGES about the
 * shipped bar, and the shipped arm changes nothing -- so the default is not a row that
 * restates the bar and can drift from it, it is the absence of every override. That is
 * the same property `menu-transition.ts` gets from mapping the shipped treatment to
 * `null` instead of writing it a stylesheet rule of its own, and it MOVED with the ruling
 * exactly as that one did when `rise` took it from `fade` (#549): `full` used to hold it
 * and now names three restorations. Arrived at differently, because these arms differ in
 * TEXT (`Level: 1` against `Level: 1/5`, `VS` against no chip at all) and no stylesheet
 * can write text.
 *
 * A module of its own rather than a block in `devflags.ts` or `hud.ts`, for the reason
 * `menu-transition.ts` and `presentation/blocked-fire.ts` both exist: the flag parser and
 * the HUD both have to name these arms, and `devflags.ts` importing `hud.ts` (5275 lines,
 * and it pulls in the stylesheet) to learn six strings would be the wrong direction. It
 * is not in `src/presentation/`, whose rule is vocabulary more than one LAYER reads; both
 * readers here are in `src/game/`.
 */

/**
 * The six arms. `spare-chips` is the shipped bar; the other five stay selectable behind
 * the dev flag, and `full` among them is the pre-ruling bar restored.
 */
export type TopbarTreatment =
  | 'full'
  | 'spare'
  | 'mode-chips'
  | 'spare-chips'
  | 'enemies-only'
  | 'denominator-only';

/**
 * The arm the game ships, and therefore the one that departs from nothing.
 *
 * A named constant rather than a literal inside `topbarDepartures`, for the reason
 * `SHIPPED_MENU_TRANSITION` is one: the property being guarded is "whatever is DEFAULT
 * changes nothing", and that property has now had to move once -- `full` held it while
 * the comparison ran, `spare-chips` holds it since the ruling. Every guard is written
 * against this constant, so the next ruling moves the guard with the default rather than
 * leaving it pointed at an arm that is no longer shipped.
 *
 * Annotated as `TopbarTreatment` rather than left to infer `'spare-chips'`, so a
 * comparison against it stays a runtime question: inferred, TypeScript would narrow past
 * the check in `topbarDepartures` and could fold a guard written against this constant
 * into a tautology.
 */
export const SHIPPED_TOPBAR_TREATMENT: TopbarTreatment = 'spare-chips';

/**
 * Exported so a consumer's suite can assert one case PER ARM rather than per remembered
 * case -- the shape `MENU_TRANSITIONS` and `BLOCKED_FIRE_CUES` established after an arm
 * was added to a union twice without any table noticing.
 */
export const TOPBAR_TREATMENTS: ReadonlySet<TopbarTreatment> = new Set<TopbarTreatment>([
  'full',
  'spare',
  'mode-chips',
  'spare-chips',
  'enemies-only',
  'denominator-only',
]);

export function isTopbarTreatment(raw: string): raw is TopbarTreatment {
  return (TOPBAR_TREATMENTS as ReadonlySet<string>).has(raw);
}

/**
 * What an arm CHANGES about the shipped bar. Every field false is the shipped bar.
 *
 * Three switches rather than six descriptions, because the arms are combinations of the
 * same three ideas and the two single-removal arms exist precisely so the combinations
 * can be taken apart. A table of six full descriptions would let two arms disagree about
 * what they share.
 *
 * All three read as RESTORATIONS now, which is the ruling's shape: the shipped bar is the
 * spare one, so every alternative is something put back.
 */
export interface TopbarDepartures {
  /**
   * Put the enemy count back on a board session's bar.
   *
   * The shipped bar drops it, on the ruling that it "might just be noise and
   * unnecessary": it is a number for a board the player is looking at, and the emptying
   * board is the same information said better. Lives stays, because it is the run's own
   * resource and is restated nowhere else on screen.
   */
  readonly restoreEnemies: boolean;
  /**
   * Show `Level: 3/5` where the shipped bar shows `Level: 3`.
   *
   * The denominator did NOT go to save space. The comparison measured what it was worth
   * in bar width and the ruling dismissed the question: space was never the motive, "I
   * don't want to necessarily reveal how many levels there are." Worth knowing that the
   * topbar is not the only
   * place that says so -- `setLevelSelect` renders one button per level up to `total`,
   * locked ones included, so the Levels panel still shows a five-level campaign as five
   * buttons. Concealing campaign length properly is that panel's change to make, and a
   * separate one; this is the bar reading as position rather than as progress.
   */
  readonly restoreDenominator: boolean;
  /**
   * Go back to the chip that marks the EXCEPTION -- PRACTICE alone -- instead of the
   * shipped chip that reads out the mode on every kind, and give versus its level chip
   * back with it.
   *
   * ONE switch for both halves, deliberately: the second is what the first is FOR on a
   * versus bar. The shipped `VS` sits in the leading slot where the ordinal was, so an
   * arm that restored the exception-marker chip without restoring the ordinal would leave
   * a hole where the eye has learned to look, and `full` would not be the pre-ruling bar.
   *
   * Versus losing the ordinal under the shipped bar is a DESIGN choice, not a fix. The
   * versus a player reaches through Versus Setup runs a one-level system and has never
   * shown a level chip at all; only `?dev=1&mode=ffa`, a versus world on the campaign
   * level system, has one, and there the ordinal is genuinely true.
   */
  readonly exceptionChip: boolean;
}

/** The shipped bar: every switch false, so not one of `applyStatus`'s three overrides runs. */
const NO_DEPARTURES: TopbarDepartures = {
  restoreEnemies: false,
  restoreDenominator: false,
  exceptionChip: false,
};

const DEPARTURES: Record<TopbarTreatment, TopbarDepartures> = {
  full: { restoreEnemies: true, restoreDenominator: true, exceptionChip: true },
  spare: { restoreEnemies: false, restoreDenominator: false, exceptionChip: true },
  'mode-chips': { restoreEnemies: true, restoreDenominator: true, exceptionChip: false },
  'spare-chips': NO_DEPARTURES,
  'enemies-only': { restoreEnemies: false, restoreDenominator: true, exceptionChip: true },
  'denominator-only': { restoreEnemies: true, restoreDenominator: false, exceptionChip: true },
};

/**
 * What this arm changes about the shipped bar; nothing, for the shipped arm.
 *
 * `null` -- an absent or unrecognised flag -- is the shipped bar too, so every caller has
 * one call rather than a null check plus a call, exactly as `menuTransitionClass` takes
 * the parser's `null`.
 */
export function topbarDepartures(treatment: TopbarTreatment | null): TopbarDepartures {
  if (treatment === null) return NO_DEPARTURES;
  return DEPARTURES[treatment];
}

/**
 * The word each kind's chip carries on the shipped bar.
 *
 * Practice keeps the word it already had, and keeps it through the SAME element and the
 * same `.hud-practice` class it has carried since #324 step S6 -- the chip was never
 * duplicated or replaced, it was generalised. So the ruling changes the other two kinds
 * and leaves untouched the one the chip was introduced for. The `exceptionChip` arms then
 * write this same `Practice` back, which is why `full` reproduces the pre-ruling markup
 * character for character rather than merely looking like it.
 *
 * The stored casing is the markup's -- `.hud-practice` sets `text-transform: uppercase`,
 * so these render as CAMPAIGN, PRACTICE and VS on screen while a screen reader gets the
 * written form.
 *
 * `VS` rather than `Versus` because the chip's job on a versus bar is to sit in the
 * leading slot where the level chip was, and that bar already carries a per-slot stock
 * strip; the narrow viewports are where a long word would cost a wrap, and 360px is the
 * width this has to survive.
 *
 * Keyed by the session kind's own three literals, and bound at the HUD to
 * `Record<HudSessionKind, string>` so a fourth kind is a compile error there rather than
 * a chip that silently renders nothing.
 */
export const MODE_CHIP_LABELS = {
  campaign: 'Campaign',
  practice: 'Practice',
  versus: 'VS',
} as const;
