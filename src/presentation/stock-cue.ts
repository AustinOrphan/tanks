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

/**
 * How big a pip may be, for a strip of `slots` entries each holding `total` stocks, on a
 * viewport too narrow to show them at full size -- or `null` when no legible size fits and the
 * arm must fall back to the shipped digit.
 *
 * THE ARM OVERFLOWED A PHONE AND THE OVERFLOW WAS SILENT (issue #835). The strip is a flex row
 * of `white-space: nowrap` entries with no wrapping or scrolling, so at four players the last
 * pip was simply clipped off the screen: 345px of strip in a 390px viewport at three stocks,
 * and versus stock is configurable to five, which puts it near 450px.
 *
 * MEASURED, NOT DERIVED. Every figure below is real Chromium layout at a 390px viewport against
 * the real stylesheet, calibrated against the page measurement in the issue: the harness reads
 * 261.1px for the four-player three-stock strip where the page reads 345px, so the surrounding
 * topbar is 83.9px, and the issue's 338px budget is 254.1px in harness terms -- where 261.1 is
 * duly 7px over, which is what makes the calibration a calibration rather than a fudge.
 *
 *   slots  stocks   10px/3px   largest that fits
 *     2     3-5       fits        10/3
 *     3     3-4       fits        10/3
 *     3      5      over by 17     9/2
 *     4      3      over by  7     9/2
 *     4      4      over by 59     7/2
 *     4      5      over by 111    6/1
 *
 * THE LAST TWO ROWS ARE WHY THIS RETURNS `null` RATHER THAN A SMALLER NUMBER. Shrinking fits
 * them arithmetically, at 7px and 6px with about ONE pixel of margin -- fragile against any
 * change to a label or a font, and self-defeating: `pips` is the arm that turns the count into
 * shape, and twenty 6px dots do not read as a count. Below 8px the arm stops doing its job, so
 * it hands the strip back to the digit, which states the count exactly and always fits.
 *
 * Only consulted on a narrow viewport. At desktop widths the strip has room and every arm draws
 * at its full size, which is where the #230 comparison is mostly read.
 */
export function narrowPipSize(slots: number, total: number): { pip: number; gap: number } | null {
  if (slots <= 2) return { pip: 10, gap: 3 };
  if (slots === 3) return total <= 4 ? { pip: 10, gap: 3 } : { pip: 9, gap: 2 };
  // Four players. Three stocks still carries a 9px pip; four and five do not reach 8px.
  if (total <= 3) return { pip: 9, gap: 2 };
  return null;
}

/**
 * The widest viewport that counts as narrow for the rule above, matching the phone tier the
 * measurement was taken at. A media query rather than a layout read: the strip is rebuilt on
 * every status that moves, and measuring it each time would force a reflow in the HUD path.
 */
export const NARROW_STRIP_QUERY = '(max-width: 480px)';
