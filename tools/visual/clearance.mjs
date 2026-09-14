/**
 * The topbar-clearance verdict (issue #687), kept apart from the browser that measures it so
 * the verdict itself has unit tests and mutation entries. `verify.mjs` supplies the rects.
 *
 * WHAT IS CHECKED IS A RELATIONSHIP, NOT A NUMBER. The toast rail and the shell-capacity
 * flash used to sit at `top: 64px` and `top: 56px`, each a guess at how tall the topbar was.
 * The guesses held at every width with no display cutout -- the topbar is 33-52px tall there
 * -- and failed at every width with one: measured in Chromium with a 47px top inset, the bar
 * grew to 74-87px and both overlays landed inside it. So a failure here means "this overlay
 * starts above the bar's rendered bottom edge", never "this overlay is not at Npx".
 *
 * Each case needs its preconditions to hold, or it passes by measuring nothing. So a match
 * whose topbar is not shown, and an inset the page never applied, are failures of their own
 * rather than silent passes.
 *
 * Input, one per viewport and inset:
 *   { viewport, inset, height,
 *     menu:  { topbar: Box, toasts: Box },
 *     match: { topbar: Box, toasts: Box, capacity: Box } }
 * where Box is { top, bottom, display, paddingTop } in CSS pixels from getBoundingClientRect
 * and getComputedStyle.
 */

const px = (value) => Number.parseFloat(value);

/** Every way one measurement breaks the contract, as readable lines; empty means it holds. */
export function clearanceFailures(m) {
  const failures = [];
  const where = `${m.viewport} inset=${m.inset}`;
  const { topbar, toasts, capacity } = m.match;

  if (topbar.display === 'none') {
    failures.push(`${where}: the match topbar is not shown, so nothing was cleared`);
    return failures;
  }
  // The inset is applied through the topbar's own padding, so a bar whose padding did not
  // grow means the override never reached the page and the inset case measured a 0px inset.
  if (m.inset > 0 && px(topbar.paddingTop) < m.inset) {
    failures.push(`${where}: topbar padding-top ${topbar.paddingTop} ignores the ${m.inset}px inset`);
  }
  for (const [name, box] of [
    ['toast rail', toasts],
    ['capacity flash', capacity],
  ]) {
    if (box.top < topbar.bottom) {
      failures.push(`${where}: ${name} top ${box.top} overlaps the topbar, whose bottom is ${topbar.bottom}`);
    }
  }
  // Pushed clear of the bar but not into the arena's centre, where the player is aiming.
  if (capacity.top >= m.height / 2) {
    failures.push(`${where}: capacity flash top ${capacity.top} is not above the centre of a ${m.height}px viewport`);
  }

  // With no topbar the rail is anchored to the display edge, and a cutout still owns that.
  if (m.menu.topbar.display !== 'none') {
    failures.push(`${where}: the menu topbar is shown, so the no-topbar case was not measured`);
  } else if (m.menu.toasts.top < m.inset) {
    failures.push(`${where}: menu toast rail top ${m.menu.toasts.top} is inside the ${m.inset}px inset`);
  }
  return failures;
}
