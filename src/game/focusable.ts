/**
 * Which controls inside a container can take focus, and how to put focus back (issue #556).
 *
 * WHY THESE LEFT `hud.ts`. Three pure DOM queries in a dependency chain -- `captureFocus` over
 * `focusableControls` over `isHiddenWithin` -- and not one of them reads a binding of
 * `createHud`'s closure. Inside it they were reachable only by building a panel and driving it,
 * so the rules deciding what the keyboard and the D-pad can reach had no direct test: a control
 * wrongly included or excluded could be caught only by noticing focus land in the wrong place.
 *
 * They are also the shared cost of three panes: `captureFocus` is called by Controllers and by
 * Versus Setup, `isHiddenWithin` by Settings. Moving them is what lets those panes be extracted
 * without the host handing each of them a focus helper of its own.
 *
 * A LEAF MODULE. It imports nothing, so a pane module that uses it does not reach `hud.ts`.
 */

/**
 * Whether `el` sits inside a hidden subtree of `container`.
 *
 * Walks up from `el` to (not including) `container`, so a control whose own `display` resolves
 * to something other than `none` but sits inside a hidden WRAPPER -- since issue #226 the three
 * Main Menu regions on the win/lose panel, which hide as groups rather than control by control
 * -- is still excluded. Measured: `getComputedStyle` on a `<button>` inside a `display:none`
 * ancestor reports the button's OWN resolved display (e.g. `inline-block`), not `none` --
 * computed style is per-element, not "as rendered" -- so `focusableControls` checking only the
 * control itself would have walked the roving order onto three invisible buttons on every
 * win/lose screen.
 *
 * Deliberately does NOT also check for issue #364's `--leaving`. That was written here first and
 * removed after measuring: the class lands only on the seven surface elements, and those are
 * exactly the CONTAINERS this walk stops before, so the branch cannot be taken. Proved rather
 * than argued -- with it replaced by a `throw`, all 212 cases in hud.test.ts still pass. Keeping
 * a surface that is fading out from taking the keyboard is `activePanelContainer`'s job, one
 * level up, where it is reachable.
 */
export function isHiddenWithin(el: HTMLElement, container: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node && node !== container; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') return true;
  }
  return false;
}

/**
 * Every control in `container` focus may land on, in document order.
 *
 * `button, [tabindex]` rather than a full focusable-element sweep: those are the two shapes this
 * UI builds. A disabled button is excluded -- a locked level is the case that produced the rule
 * -- and so is a negative `tabindex`, which nothing carries today.
 */
export function focusableControls(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('button, [tabindex]')).filter((el) => {
    if (el instanceof HTMLButtonElement && el.disabled) return false; // locked levels
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) < 0) return false; // none today, but future-proof
    return !isHiddenWithin(el, container);
  });
}

/**
 * Remember which control inside `container` holds focus so a re-render can put it back
 * (issue #494). The Controllers and Versus Setup rows are rebuilt from scratch on every hotplug
 * and reassignment, and `replaceChildren` sends the focus of a removed button to `<body>` -- a
 * gamepad player who pressed Confirm on a pad candidate then had nothing focused and nowhere to
 * go. Controls are matched by their data attributes within their `data-slot` row: the same
 * candidate on the same row when it still exists, else the first control of the same row (the
 * pad whose button was focused just unplugged), else the first control in the container. Returns
 * the restore step, so a renderer captures before its `replaceChildren` and restores after its
 * loop with no wrapper.
 */
export function captureFocus(container: HTMLElement): () => void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !container.contains(active)) return () => {};
  const rowOf = (el: HTMLElement): string | null => el.closest<HTMLElement>('[data-slot]')?.dataset.slot ?? null;
  const keyOf = (el: HTMLElement): string =>
    `${rowOf(el)}|${JSON.stringify(Object.entries(el.dataset).sort())}`;
  const row = rowOf(active);
  const key = keyOf(active);
  return () => {
    const controls = focusableControls(container);
    const same = controls.find((el) => keyOf(el) === key);
    const sameRow = row === null ? undefined : controls.find((el) => rowOf(el) === row);
    (same ?? sameRow ?? controls[0])?.focus();
  };
}
