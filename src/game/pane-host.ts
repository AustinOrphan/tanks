/**
 * What `hud.ts` hands an extracted pane (issue #556).
 *
 * `hud.ts` was one closure holding every application surface. A pane module takes a HOST: the
 * few navigation functions it actually calls, and nothing else. It never takes a `hud.ts`
 * binding, so a pane cannot reach into the closure's mutable state from another file. That
 * reach is the coupling #556 warns a split must not spread. The seam is specified in
 * `docs/superpowers/specs/2026-09-16-hud-pane-host-design.md`.
 *
 * EACH PANE DECLARES ITS OWN `Pick<PaneHost, ...>`. The compiler then refuses a call to a member
 * the pane did not declare, and the key list is the pane's shared-state cost in one line.
 * `pane-host.test.ts` pins every pane's key list from source, because a cast reaches past a
 * `Pick` at run time.
 *
 * A LEAF MODULE. It imports nothing, and in particular nothing from `hud.ts`, so a pane module
 * that imports it does not import the file that imports the pane.
 *
 * THE ROSTER GROWS WITH THE PANES THAT NEED IT. A member no pane calls is an implementation no
 * test reaches, so a mutation of it could only survive.
 */

/** One application surface: its element, and the class that hides it. */
export interface Surface {
  readonly el: HTMLElement;
  readonly hidden: string;
}

export interface PaneHost {
  /**
   * Show `to`, fading out whatever surface the player is on now. `onBegin` runs as the
   * transition starts, so focus lands before the animation ends.
   *
   * The only way a pane opens itself. It is `hud.ts`'s `swapSurface(openSurface(), to, ...)`,
   * and there is deliberately no raw `swapSurface` here. A pane naming its own source surface
   * was measured wrong: see `openSurface` in `hud.ts`.
   */
  enterSurface(to: Surface, onBegin?: () => void, instant?: boolean): void;
  /**
   * Put `from` away and return to the Main Menu. A no-op when `from` is not the open surface,
   * though `onBegin` still runs, so a pane's own open/closed guard decides what it means.
   */
  closeSurface(from: Surface, onBegin?: () => void, instant?: boolean): void;
  /** Whether `surface` is the one on screen: shown and not fading out. */
  isSurfaceOpen(surface: Surface): boolean;
  /**
   * Push THIS pane's layer, recording the control that opened it. `hud.ts` binds the layer id,
   * so no pane module names one. Returns whether the layer was pushed or refreshed.
   */
  open(opener: HTMLElement | null): boolean;
  /** Pop the top layer: the pane's own close, the origin re-rendered, focus restored. */
  back(): boolean;
}
