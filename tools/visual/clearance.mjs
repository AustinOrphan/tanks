/**
 * The topbar-clearance verdict (issue #687), kept apart from the browser that measures it so
 * the verdict itself has unit tests and mutation entries. `verify.mjs` supplies the rects and
 * each chip's selector, and measures through `CLEARANCE_SELECTORS` below.
 *
 * WHAT IS CHECKED IS A RELATIONSHIP, NOT A NUMBER. The toast rail and the shell-capacity
 * flash used to sit at `top: 64px` and `top: 56px`, each a guess at how tall the topbar was.
 * The guesses held at every width with no display cutout -- the topbar is 33-52px tall there
 * -- and failed at every width with one: measured in Chromium with a 47px top inset, the bar
 * grew to 74-87px and both overlays landed inside it. So a failure here means "this overlay
 * overlaps what it must clear", never "this overlay is not at Npx".
 *
 * The two overlays owe different things:
 * - The toast rail starts at or below the bar's rendered bottom edge.
 * - The capacity flash overlaps neither a topbar chip nor the drawn board, and stays inside
 *   the safe area. Below the bar is not enough: in a short landscape viewport the board
 *   starts under the bar (measured at 844x390: bar bottom 52, board top 48), so a flash just
 *   below the bar is drawn on the arena. It also must not move the chips when it shows -- a
 *   flash that claims room in the bar's flex row is the permanent counter issue #356 rules
 *   out.
 *
 * Each case needs its preconditions to hold, or it passes by measuring nothing. So a match
 * whose topbar is not shown, an inset the page never applied, a flash with no text, and a
 * board that was not found are failures of their own rather than silent passes.
 *
 * Input, one per viewport and inset:
 *   { viewport, inset: { top, left, right }, width, height,
 *     menu:  { topbar: Box, toasts: Box },
 *     match: { topbar: Box, toasts: Box, capacity: Box, chips: Chip[], chipsStaged: Chip[] },
 *     board: Rect | null }
 * where Rect is { top, bottom, left, right } and Box adds { display, paddingTop, paddingLeft,
 * paddingRight }, all in CSS pixels from getBoundingClientRect and getComputedStyle. A Chip is a
 * Rect plus the `selector` that matched it and nothing else on the page. `chips` are the bar's
 * shown children before the flash's text is staged and `chipsStaged` after; `board` is the
 * painted board's bounding box, from a screenshot with the HUD hidden.
 *
 * Each line names the state it measured, `match` or `menu`, beside the viewport and inset, and
 * names the element it is about by the selector it was measured through, so a reader can paste
 * it into `document.querySelector`. The board is the one thing judged that has no selector: it
 * is found in a screenshot, so its lines name it by its rectangle.
 */

/**
 * The elements measured, one copy shared by the measurement and its lines (issue #1068).
 * `verify.mjs` hands this object to the in-page measurement as its argument, because a function
 * run through `page.evaluate` cannot close over a module constant, and the lines below print the
 * same strings. A rename here reaches both; `verify.mjs`'s `settle()` and the hit sweep still
 * spell `.hud-topbar` themselves. `clearance-measure.test.ts` ties it to the HUD's own markup.
 */
export const CLEARANCE_SELECTORS = Object.freeze({
  topbar: '.hud-topbar',
  toasts: '.hud-toasts',
  capacity: '.hud-capacity',
});

const px = (value) => Number.parseFloat(value);

/** Sub-pixel slack for rects that meet at an edge, and for rounding between two readings. */
const EPSILON = 0.5;

const overlaps = (a, b) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > EPSILON &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > EPSILON;

const rect = (r) => `${r.left},${r.top} to ${r.right},${r.bottom}`;

/** "top 59", "left 59, right 21", or "0": which safe-area insets this case applied. */
export function insetLabel(inset) {
  const sides = ['top', 'left', 'right'].filter((side) => inset[side] > 0);
  return sides.length === 0 ? '0' : sides.map((side) => `${side} ${inset[side]}`).join(', ');
}

/** Every way one measurement breaks the contract, as readable lines; empty means it holds. */
export function clearanceFailures(m) {
  const failures = [];
  const where = `${m.viewport} inset=${insetLabel(m.inset)}`;
  const inMatch = `${where} state=match`;
  const inMenu = `${where} state=menu`;
  const S = CLEARANCE_SELECTORS;
  const { topbar, toasts, capacity } = m.match;

  if (topbar.display === 'none') {
    failures.push(`${inMatch}: the match topbar ${S.topbar} is not shown, so nothing was cleared`);
    return failures;
  }
  // Every inset is applied through the topbar's own padding, so a bar whose padding did not
  // grow means the override never reached the page and the case measured a 0px inset.
  for (const [side, padding] of [
    ['top', topbar.paddingTop],
    ['left', topbar.paddingLeft],
    ['right', topbar.paddingRight],
  ]) {
    if (m.inset[side] > 0 && px(padding) < m.inset[side]) {
      failures.push(`${inMatch}: topbar ${S.topbar} padding-${side} ${padding} ignores the ${m.inset[side]}px ${side} inset`);
    }
  }
  if (toasts.top < topbar.bottom) {
    failures.push(`${inMatch}: toast rail ${S.toasts} top ${toasts.top} overlaps topbar ${S.topbar}, whose bottom is ${topbar.bottom}`);
  }

  if (capacity.right - capacity.left < 1 || capacity.bottom - capacity.top < 1) {
    failures.push(`${inMatch}: capacity flash ${S.capacity} has no box, so its text was never staged and nothing was judged`);
  } else {
    for (const chip of m.match.chips) {
      if (overlaps(capacity, chip)) {
        failures.push(`${inMatch}: capacity flash ${S.capacity} ${rect(capacity)} overlaps topbar chip ${chip.selector} at ${rect(chip)}`);
      }
    }
    if (m.board === null) {
      failures.push(`${inMatch}: the board was not found in the screenshot, so the flash was not judged against it`);
    } else if (overlaps(capacity, m.board)) {
      failures.push(`${inMatch}: capacity flash ${S.capacity} ${rect(capacity)} overlaps the drawn board at ${rect(m.board)}`);
    }
    if (
      capacity.top < m.inset.top ||
      capacity.left < m.inset.left ||
      capacity.right > m.width - m.inset.right
    ) {
      failures.push(`${inMatch}: capacity flash ${S.capacity} ${rect(capacity)} is outside the safe area of a ${m.width}px viewport`);
    }
  }
  const { chips, chipsStaged } = m.match;
  const moved =
    chips.length !== chipsStaged.length ||
    chips.some((chip, i) =>
      ['top', 'bottom', 'left', 'right'].some((edge) => Math.abs(chip[edge] - chipsStaged[i][edge]) > EPSILON),
    );
  if (moved) {
    failures.push(`${inMatch}: showing capacity flash ${S.capacity} moved the chips of topbar ${S.topbar}, so it claims room in the bar`);
  }

  // With no topbar the rail is anchored to the display edge, and a cutout still owns that.
  if (m.menu.topbar.display !== 'none') {
    failures.push(`${inMenu}: the menu topbar ${S.topbar} is shown, so the no-topbar case was not measured`);
  } else if (m.menu.toasts.top < m.inset.top) {
    failures.push(`${inMenu}: menu toast rail ${S.toasts} top ${m.menu.toasts.top} is inside the ${m.inset.top}px top inset`);
  }
  return failures;
}
