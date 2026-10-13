/**
 * How the versus stock strip draws each player's stocks, and how it marks one just lost
 * (issues #230, #1022).
 *
 * THE RULING ON #230 SHIPPED `marks`: an FFA entry draws one copy of its slot's own identity
 * outline (issue #234's `shape`: circle, triangle, square, starburst) per stock the match started
 * with, held ones filled and lost ones hollow, so one channel states both which player and how
 * many stocks are left, and the row replaces the separate leading mark. The accepted risk is the
 * one the comparison named: a count wants uniform simple units and identity wants distinct ones,
 * so five starbursts in a row may read as texture rather than as a number. The comparison's other
 * arms, `strike` and `badge`, went with its `?dev=1&stockCue=` flag (issue #1022).
 *
 * `pips` STAYS, AS A DRAWING ROUTINE AND NOT AS A CHOICE: the same row with a neutral dot for its
 * unit. It is what a teams entry draws beside its A/B/C letter, and what an FFA entry draws when
 * the identity marker is not `shape`. `stockRowFor` is the one rule that picks between them.
 *
 * Every entry marks a loss the same way: the unit that just emptied swells, and the
 * reduced-motion form keeps the information and drops the movement (`hud.css`).
 *
 * Cue state is drawn with borders and text, never `background`: forced colours drops a
 * background, which in the #230 mockups made a filled pip identical to a hollow one.
 */
import type { IdentityMarkerStyle } from './identity-marker';

/** Which row draws one stock entry: the slot's identity outline per stock, or a neutral pip. */
export type StockRow = 'marks' | 'pips';

/**
 * Which row draws one stock entry, the strip's one rule (issue #1022): `marks` for an entry with
 * no team whose resolved marker is `shape`, and `pips` for every other combination.
 *
 * `marker` is the HUD's resolved `identityMarker` option. The page's HUD is handed `shape` when
 * the flag is absent, `null` for the reversal value `solid` and the named style otherwise
 * (`identity-marker-flag.ts`); an injected HUD built without the option has `null`.
 *
 *  - A TEAMS ENTRY DRAWS PIPS. `marks` spends the SLOT's outline, and a teams player shares a
 *    side, not a slot: two teammates in one colour drawn with two outlines would claim to be
 *    different sides, and the A/B/C letter beside the number already answers the question the
 *    outline would ask (PR #836's fallback, a week before the ruling).
 *  - ANY MARKER BUT `shape` DRAWS PIPS. The ruling reserved `marks` for a `shape` marker that is
 *    on by default, so that the strip's outlines never appear without the ground ring's. With
 *    the marker reversed (`?dev=1&identityMarker=solid`) there is no outline on the ground to
 *    pair with, and `arcs` and `roof` state identity in another vocabulary (the ring's arcs, the
 *    crown's blades); those two keep the leading mark beside their pips until issue #1023
 *    removes them.
 *
 * Both readings are derived from the code and the ruling's own condition rather than ruled on
 * directly, and a later ruling can reverse either.
 */
export function stockRowFor(team: number | undefined, marker: IdentityMarkerStyle | null): StockRow {
  return team === undefined && marker === 'shape' ? 'marks' : 'pips';
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
 * viewport too narrow to show them at full size -- or the one-pip fallback when no legible size
 * fits (see `PipLayout`).
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
 * (That harness, a bare strip against 254.1px, had drifted from the page by issue #1055 and now
 * measures the real HUD instead; every rung this rule takes still fits there, the tightest being
 * four players at three stocks with 9.9px to spare.)
 *
 *   slots  stocks   10px/3px   largest that fits
 *     2     3-5       fits        10/3
 *     3     3-4       fits        10/3
 *     3      5      over by 17     9/2
 *     4      3      over by  7     9/2
 *     4      4      over by 59     7/2
 *     4      5      over by 111    6/1
 *
 * THE LAST TWO ROWS ARE WHY THIS FALLS BACK RATHER THAN SHRINKING FURTHER. They fit
 * arithmetically at 7px and 6px with about ONE pixel of margin -- fragile against any change to
 * a label or a font, and self-defeating: pips exist to turn the count into shape, and twenty
 * 6px dots do not read as a count. Below 8px the row stops doing its job.
 *
 * What it falls back TO is one full-size pip plus the digit, not a bare digit -- see
 * `PipLayout`. The shape channel survives and so does the cue's target.
 *
 * Only consulted on a narrow viewport. At desktop widths the strip has room and every row draws
 * at its full size.
 *
 * A TEAMS ENTRY IS LAID OUT BY THIS SAME RULE (issue #1055). Every teams entry draws pips
 * (`stockRowFor`), after a `P1 A ` label, so it carries a space and a letter the table above
 * never measured. Measured on the real HUD at a 390px viewport
 * (`tools/hud/strip-width.mjs`), lettered A, B, A, B, the widest split: the letter fits at every
 * rung this rule already takes, so a teams entry needs no rule of its own. Spare is the room left
 * inside the topbar's content box, which ends at 380px. Teams is offered at three and four
 * players only, so these 10 configurations are the whole population:
 *
 *   slots  stocks        rung   strip px   spare px
 *     3      1          10/3      163.2      166.6
 *     3      2          10/3      202.2      127.6
 *     3      3          10/3      241.2       88.6
 *     3      4          10/3      280.2       49.6
 *     3      5           9/2      292.2       37.6
 *     4      1           9/2      217.0      112.8
 *     4      2           9/2      261.0       68.8
 *     4      3           9/2      305.0       24.8
 *     4      4     one+digit      275.4       54.4
 *     4      5     one+digit      275.4       54.4
 *
 * The one-pip fallback stays at four players at four and five stocks. It fits, with 54.4px to
 * spare; #1055 leaves a rung that fits unchanged; and this rule is shared with the FFA entries
 * that draw pips, where every row at the 8px floor overflows four players at four stocks (8/2 by
 * 18.1px, 8/1 by 6.1px, measured with the leading mark beside each entry). For
 * teams alone, an 8px row with a 1px gap would fit 4x4 with 8.8px to spare, while an 8/2 row
 * overflows it by 3.2px; at 4x5 every 8px row overflows (8/2 by 43.2px, 8/1 by 27.2px). Those
 * rows were measured on the same page by drawing a full row in place of each fallback.
 * Everything here holds at the default UI scale (100%) only; the strip is under the player's UI
 * scale since #1048, so 125% and 150% need measuring of their own.
 */
export function narrowPipLayout(slots: number, total: number): PipLayout {
  if (slots <= 2) return { kind: 'row', pip: 10, gap: 3 };
  if (slots === 3) {
    return total <= 4 ? { kind: 'row', pip: 10, gap: 3 } : { kind: 'row', pip: 9, gap: 2 };
  }
  // Four players. Three stocks still carries a 9px pip; four and five do not reach 8px.
  if (total <= 3) return { kind: 'row', pip: 9, gap: 2 };
  return { kind: 'one', pip: 10 };
}

/**
 * How the pips row draws one entry.
 *
 * `row` is the row proper: one pip per stock the match started with, at the given size.
 *
 * `one` is the crowded fallback: a SINGLE pip, at full size, followed by the count as a digit.
 * A bare digit was the first answer and it was wrong twice over. It drops the shape channel
 * entirely, which is the one thing pips exist to provide -- and it leaves the loss cue
 * with nothing to animate, because the cue IS the pip swelling and bursting a ring. An entry
 * that cannot burst is not a degraded row, it is the absence of one, and #230 would have been
 * ranking a blank.
 *
 * Measured on the real HUD at 390px (issue #1055), one full-size pip plus the digit leaves 39.4px
 * inside the topbar's content box at four FFA players and 54.4px at four teams, so the glyph does
 * not even need shrinking to fit. The count stays exact, the shape stays present, and the cue
 * keeps its target.
 */
export type PipLayout =
  | { kind: 'row'; pip: number; gap: number }
  | { kind: 'one'; pip: number };

/**
 * How the `marks` row draws one entry on a narrow viewport, for a strip of `slots` entries each
 * holding `total` stocks: at the stylesheet's own size, as a smaller row, or as the crowded
 * fallback (issue #1021) -- the `marks` analogue of `narrowPipLayout` above.
 *
 * MEASURED, NOT DERIVED: real Chromium layout at a 390px viewport against the real stylesheet,
 * on the page and budget `tools/hud/strip-width.mjs` then used for the pips table (254.1px, the
 * same calibration; issue #1055 replaced that harness with a measurement of the real HUD, where
 * every layout this rule takes still fits). The full-size mark is `0.62em` of the strip's `1rem`,
 * 9.9px at the default UI scale, with a 2px gap. Figures are px over budget, negative is spare;
 * the closest row of each group is the one shown:
 *
 *   slots  stocks   full/2px    9/2     8/2     8/1    one+digit
 *     2     1-5      -97.2
 *     3     1-4      -54.5
 *     3      5       -18.8
 *     4     1-3      -35.6
 *     4      4        12.0    -2.5   -18.5   -30.5     -82.8
 *     4      5        59.7    41.5    21.5     5.5     -82.8
 *
 * A mark is narrower than a pip, so the derivation in the issue expected 3x5 to sit about 4px
 * over and 4x4 about 46px over; real layout puts 3x5 18.8px INSIDE the budget and 4x4 only
 * 12px over. Only two configurations of the fifteen need handling.
 *
 * Four players at four stocks carries an 8px row with a 2px gap, 18.5px inside the budget. The
 * 9px row fits by 2.5px, which is the one-pixel fragility the pips table refused; a 1px gap
 * fits at 9px too, but it closes the space that keeps five squares from reading as one bar.
 *
 * Four players at five stocks falls back. 8px marks overflow by 5.5px even at a 1px gap, and
 * only 7px fits -- below the 8px floor #838 set for pips, which no measurement here has shown
 * the four outlines read apart under. The fallback is #838's: one full-size mark, then the
 * count as a digit, which keeps the slot's outline and gives the loss cue its target.
 *
 * Only consulted on a narrow viewport; the desktop strip draws every mark at its full size.
 * Measured at the default UI scale (100%) only. Since #1048 `.hud-versus-stocks` is sized
 * `calc(1rem * var(--hud-ui-scale))` (`hud.css`), and the full-size marks follow it in `em`; at
 * scale 1 that is numerically the `1rem` this table was measured against, so it holds there.
 * At 125% and 150% the `em`-sized marks grow while the `px`-sized narrow row does not, and
 * nothing has measured either scale on a phone.
 */
export function narrowMarkLayout(slots: number, total: number): MarkLayout {
  if (slots <= 3 || total <= 3) return { kind: 'full' };
  if (total === 4) return { kind: 'row', mark: 8, gap: 2 };
  return { kind: 'one' };
}

/**
 * How the marks row draws one entry.
 *
 * `full` is the row at the stylesheet's own size. `row` is the same row with a smaller mark and
 * gap, set through `--hud-mark` and `--hud-mark-gap` on the row so the stylesheet keeps the only
 * definition of the default. `one` is the crowded fallback: a single full-size mark in the
 * slot's outline, filled while the player has stock, followed by the count as a digit.
 */
export type MarkLayout =
  | { kind: 'full' }
  | { kind: 'row'; mark: number; gap: number }
  | { kind: 'one' };

/**
 * The widest viewport that counts as narrow for the rules above, matching the phone tier the
 * measurement was taken at. A media query rather than a layout read: the strip is rebuilt on
 * every status that moves, and measuring it each time would force a reflow in the HUD path.
 */
export const NARROW_STRIP_QUERY = '(max-width: 480px)';
