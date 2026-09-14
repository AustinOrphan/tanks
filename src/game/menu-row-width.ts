/**
 * One width for every button in a Main Menu row (issue #706).
 *
 * THE DEFECT. `.hud-menu-play` and `.hud-menu-utilities` size each button to its own label,
 * so Versus and Practice rendered 89 and 98 px wide side by side, and Customize 16 px wider
 * than Records and Settings. At #686's 44 px floor those are blocks, and the mismatch between
 * neighbours was the most visible thing on the menu.
 *
 * WHY SCRIPT AND NOT CSS. The rows must keep `flex-wrap: wrap`: at 320 px the three utilities
 * already fold onto two lines, and in developer mode Developer Tools (143 px) is a fourth
 * button that folds at 390 px too. Measured on the built bundle, all before this change.
 * "As wide as the widest sibling" and "wraps when it does not fit" cannot both be said in
 * CSS: an equal-column grid does not wrap, `repeat(auto-fit, ...)` needs a known column width,
 * and flex growth fills the line rather than matching a sibling. So the widest label is
 * MEASURED, once per change, and handed to the stylesheet as `--hud-menu-col`.
 *
 * WHEN IT RUNS. On every size change of any button in either row, through a ResizeObserver,
 * rather than from the state changes that show or hide them. A surface is revealed by the
 * transition runner, possibly after `setState` returns, and a row measured while its panel
 * is still `display: none` reads every width as 0. A hidden button reports 0 and a shown one
 * reports its width, so every show, hide and membership change arrives here on its own.
 * Viewport size alone does not change a label's width: the menu's type is in px, from a
 * system font stack.
 *
 * WHY IT SETTLES. Each run clears the variable, reads the natural widths, and sets the
 * variable again in one synchronous pass, so no frame is painted in between. The observer
 * then sees the same final size it reported last time and does not fire again.
 */

/** The custom property a row's buttons read their width from. */
export const MENU_COL_VAR = '--hud-menu-col';

/**
 * Give every button in `row` the width of its widest visible sibling.
 *
 * The variable is REMOVED before measuring, or a button would report the width it was last
 * given rather than the width its label needs. That is the paused Main Menu: Settings alone
 * in the row, which would otherwise keep the Developer Tools width it had a moment before.
 * A row with nothing visible has the variable removed and not set, so a stale width cannot
 * outlive the buttons it was measured from.
 */
export function equalizeRowWidths(row: HTMLElement): void {
  row.style.removeProperty(MENU_COL_VAR);
  let widest = 0;
  for (const child of Array.from(row.children)) {
    const width = child.getBoundingClientRect().width;
    if (width > widest) widest = width;
  }
  // Rounded UP: a label measured at 98.4 px given 98 px would wrap or clip.
  if (widest > 0) row.style.setProperty(MENU_COL_VAR, `${Math.ceil(widest)}px`);
}

type ResizeObserverCtor = new (callback: () => void) => {
  observe(target: Element): void;
  disconnect(): void;
};

/**
 * Equalize `rows` now and whenever any of their buttons changes size.
 *
 * `Observer` defaults to the page's `ResizeObserver`; a page without one (jsdom, and nothing
 * the game supports) gets the single run and no observer.
 */
export function equalizeMenuRows(
  rows: readonly HTMLElement[],
  Observer: ResizeObserverCtor | undefined = globalThis.ResizeObserver,
): { dispose(): void } {
  const run = (): void => {
    for (const row of rows) equalizeRowWidths(row);
  };
  run();
  if (typeof Observer !== 'function') return { dispose() {} };
  const observer = new Observer(run);
  for (const row of rows) {
    for (const child of Array.from(row.children)) observer.observe(child);
  }
  return { dispose: () => observer.disconnect() };
}
