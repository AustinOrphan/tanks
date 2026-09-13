/**
 * How the Versus Setup pane presents its Start and Back controls (issue #668).
 *
 * THE SHIPPED LAYOUT IS THE ABSENCE OF A VALUE, as with every other arm flag here: `null`
 * means the pinned bar carrying both buttons, so the default cannot drift from what players
 * see by someone editing a name.
 *
 * MEASURED, which is why there is only one alternative rather than the four that were drawn.
 * Start sat 1462px down an 844px screen -- 1.73 screens of scrolling to begin a match, and
 * 2.66 at 320x568. Four shapes were built into the running page and photographed:
 *
 *  - two columns of map cards: 1.46 screens, and it CLIPS the board descriptions (the text
 *    column halves to 89px). Rejected on measurement, having been the first recommendation.
 *  - collapsing the map list behind a summary row: 1.05 screens, at the cost of a tap.
 *  - pinning the actions: Start reachable from the first frame at any scroll position.
 *  - pinning Start and lifting Back into a sticky header: the same, plus the pane title
 *    stays on screen.
 *
 * The last two are the ones kept. Pinning won because the title turned out to be the weaker
 * prize than it sounded: the shipped layout shows it at rest anyway, so a header only
 * preserves it AFTER a scroll -- and on a 320px screen the full-size header wrapped
 * "Versus Setup" onto two lines, taking 94px and 31% of the screen against the bar's 15%.
 * `header` is the compact form of that idea, which holds 49px at both widths.
 */
export const VERSUS_ACTION_LAYOUTS = ['header'] as const;

export type VersusActionLayout = (typeof VERSUS_ACTION_LAYOUTS)[number];

export function isVersusActionLayout(value: unknown): value is VersusActionLayout {
  return typeof value === 'string'
    && (VERSUS_ACTION_LAYOUTS as readonly string[]).includes(value);
}
