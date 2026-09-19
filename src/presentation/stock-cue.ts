/**
 * How the versus stock strip marks a stock just lost (issue #230).
 *
 * A TEMPORARY OPEN-QUESTION FLAG, not a rollback lever: once one arm is chosen it ships
 * unconditionally and this module and its `?dev=1&stockCue=` flag are deleted.
 *
 * THE SHIPPED STRIP IS THE ABSENCE OF A VALUE, as with every other arm flag here: `null` draws
 * no cue at all, which is what players see today -- a stock loss is announced to assistive
 * technology (issue #629) but nothing on screen marks it beyond the digit changing.
 *
 * The three arms are the shortlist from four mockups posted on #230 (the fourth, an inverted
 * chip, was dropped). Each carries the loss on a channel other than colour, and each has a
 * reduced-motion form that keeps the information and drops the movement:
 *
 *  - `pips`   -- the digit becomes one pip per stock the match started with. Remaining stocks
 *                are filled, lost ones hollow, and the pip that just emptied swells and bursts
 *                a ring. Shape carries the count, and it stays readable after the cue ends.
 *  - `marks`  -- the same idea as `pips`, with the pip replaced by the slot's own IDENTITY
 *                outline (issue #234's `shape`: circle, triangle, square, starburst). One
 *                channel does both jobs -- which player, and how many stocks -- so the entry
 *                states its identity once instead of three times, and the separate leading
 *                marker is suppressed while this arm runs. Proposed after #833 paired the
 *                strip with the ground ring and the pairing turned out to say "P1" twice.
 *
 *                THE TRADE IS COUNTING AGAINST RECOGNITION, and it is the thing to judge: a
 *                count wants uniform simple units, which is exactly why `pips` is a dot,
 *                while identity wants maximally distinct ones. Five starbursts in a row may
 *                read as texture rather than as a number, and that is what a capture has to
 *                answer rather than an argument.
 *  - `strike` -- the old number, struck through, lifts away above the new one.
 *  - `badge`  -- a small outlined "−1" appears under the entry and drifts down as it fades.
 *
 * Cue state is drawn with borders and text, never `background`: forced colours drops a
 * background, which in the mockups made a filled pip identical to a hollow one and erased a
 * strike line drawn as a fill.
 */
export const STOCK_CUES = ['pips', 'marks', 'strike', 'badge'] as const;

export type StockCue = (typeof STOCK_CUES)[number];

export function isStockCue(value: unknown): value is StockCue {
  return typeof value === 'string' && (STOCK_CUES as readonly string[]).includes(value);
}

/**
 * How long a stock-loss cue runs, in milliseconds.
 *
 * `--hud-duration-slow`, the same length as the campaign life-loss pulse (`hud-lives--hit`), so
 * the two losses read at one tempo. The HUD needs the number as well as the stylesheet: the strip
 * is rebuilt whenever the status moves, and a cue still running when that happens is re-attached
 * with a negative `animation-delay` for the time already spent, then dropped once this has passed.
 * `hud.css.test.ts` pins that the token and this constant agree.
 */
export const STOCK_CUE_MS = 700;
