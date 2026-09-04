/**
 * The gameplay-topbar comparison's vocabulary (issue #552).
 *
 * The owner's notes on the bar are questions, not a ruling: "the campaign top bar does
 * not really need an enemy count I think and it should not show the denominator of
 * levels, but just the current level, probably, I think", "Maybe we should have
 * 'campaign' in the top bar?", and on the chip, "Maybe even we could have 'vs' in there
 * too for versus idk". Every one of them carries an explicit hedge. So the arms here are a
 * COMPARISON to rule from -- the way #542's four menu transitions and #516/#356's cue
 * arms were settled -- and not an implementation of the notes as read.
 *
 * WHAT EACH ARM SAYS, and which question it isolates:
 *
 *  - `full` -- today, unchanged. The control.
 *  - `spare` -- no enemy count, and `Level: 1` without the denominator. Both content
 *    removals together, which is how the notes pose them.
 *  - `mode-chips` -- CAMPAIGN / PRACTICE / VS on every kind, and versus's level chip
 *    gone. The chip stops being an exception marker and becomes a field that is always
 *    populated; the leading slot then holds a `VS` where versus's level chip was.
 *  - `spare-chips` -- both of the above, because a spare bar and a mode readout may only
 *    work as a pair: the chip is what a bar with two readings left can still be read by.
 *  - `enemies-only` / `denominator-only` -- ONE removal each. They are not partial
 *    versions of `spare`: the two removals are different losses (the enemy count is a
 *    restatement of a board the player can see; the denominator is the only thing that
 *    says how long the campaign is), and judging them as a package cannot tell a ruling
 *    about one from a ruling about the other.
 *
 * DEPARTURES, NOT DESCRIPTIONS. `topbarDepartures` says what an arm CHANGES about the
 * shipped bar, and the shipped arm changes nothing -- so `full` is not a row that
 * restates today's bar and can drift from it, it is the absence of every override. That
 * is the same property `menu-transition.ts` gets from mapping the shipped treatment to
 * `null` instead of writing it a stylesheet rule of its own, arrived at differently
 * because these arms differ in TEXT (`Level: 1` against `Level: 1/5`, `VS` against no
 * chip at all) and no stylesheet can write text.
 *
 * A module of its own rather than a block in `devflags.ts` or `hud.ts`, for the reason
 * `menu-transition.ts` and `presentation/blocked-fire.ts` both exist: the flag parser and
 * the HUD both have to name these arms, and `devflags.ts` importing `hud.ts` (5275 lines,
 * and it pulls in the stylesheet) to learn six strings would be the wrong direction. It
 * is not in `src/presentation/`, whose rule is vocabulary more than one LAYER reads; both
 * readers here are in `src/game/`.
 */

/**
 * The six arms. `full` is the control and the shipped bar; the other five are the
 * candidates the owner rules between.
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
 * changes nothing", and if this comparison ends in a ruling the default moves. Every
 * guard is written against this constant, so a future ruling moves the guard with the
 * default rather than leaving it pointed at an arm that is no longer shipped.
 *
 * Annotated as `TopbarTreatment` rather than left to infer `'full'`, so a comparison
 * against it stays a runtime question: inferred, TypeScript would narrow past the check
 * in `topbarDepartures` and could fold a guard written against this constant into a
 * tautology.
 */
export const SHIPPED_TOPBAR_TREATMENT: TopbarTreatment = 'full';

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
 */
export interface TopbarDepartures {
  /**
   * Drop the enemy count from a board session's bar (question 1). Lives stays: it is the
   * run's own resource and is not restated anywhere on screen, while the enemy count is
   * a number for a board the player is looking at.
   */
  readonly dropEnemies: boolean;
  /**
   * Show `Level: 3` where the shipped bar shows `Level: 3/5` (question 2). Position
   * without scale -- the chip stops saying how long the campaign is.
   */
  readonly dropDenominator: boolean;
  /**
   * Label every kind (CAMPAIGN / PRACTICE / VS) instead of marking the exception
   * (PRACTICE alone), and drop versus's level chip (questions 4 and 5).
   *
   * ONE switch for both halves, deliberately: the second is what the first is FOR on a
   * versus bar. A `VS` in the leading slot is the replacement for an ordinal that arm
   * argues versus should not be carrying, so an arm that dropped the chip without
   * labelling the kind would leave a hole where the eye has learned to look, and judging
   * that would answer neither question.
   */
  readonly modeChips: boolean;
}

/** The shipped bar: every switch false, so not one of `applyStatus`'s four overrides runs. */
const NO_DEPARTURES: TopbarDepartures = {
  dropEnemies: false,
  dropDenominator: false,
  modeChips: false,
};

const DEPARTURES: Record<TopbarTreatment, TopbarDepartures> = {
  full: NO_DEPARTURES,
  spare: { dropEnemies: true, dropDenominator: true, modeChips: false },
  'mode-chips': { dropEnemies: false, dropDenominator: false, modeChips: true },
  'spare-chips': { dropEnemies: true, dropDenominator: true, modeChips: true },
  'enemies-only': { dropEnemies: true, dropDenominator: false, modeChips: false },
  'denominator-only': { dropEnemies: false, dropDenominator: true, modeChips: false },
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
 * The word each kind's chip carries under `modeChips`.
 *
 * Practice keeps the word it already has, so the arm changes the OTHER two kinds and not
 * the one the chip was introduced for (#324 step S6). The stored casing is the markup's
 * -- `.hud-practice` sets `text-transform: uppercase`, so these render as CAMPAIGN,
 * PRACTICE and VS on screen while a screen reader gets the written form.
 *
 * `VS` rather than `Versus` because the chip's whole job in that arm is to sit in the
 * leading slot where versus's level chip was, and a versus bar already carries a per-slot
 * stock strip; the narrow viewports are where a long word would cost a wrap, and 360px is
 * the width the comparison has to survive.
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
