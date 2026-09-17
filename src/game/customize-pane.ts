import { blurIfPointer } from './ui';
import { renderCustomizeChoices, type CustomizeChoices } from './customize-choices';
import type { PaneHost, Surface } from './pane-host';

/**
 * The Customize pane (issue #556): the first surface extracted whole from `hud.ts`, against the
 * seam in `docs/superpowers/specs/2026-09-16-hud-pane-host-design.md`.
 *
 * WHAT IT OWNS. The pane's markup inside its container, the preview canvas and rotate buttons it
 * hands out, the three choice rows (through `customize-choices.ts`), its open and close
 * chokepoint and the subscribers it fires, what a sibling replacing it has to release, and its
 * Back and opener listeners.
 *
 * WHAT `hud.ts` KEEPS, and why. The container `<div>` stays in the one template, with its role,
 * label and hidden class: where the pane sits in the document is the host's decision, and so is
 * its place in `PANEL_FAMILY`'s paint order. `hud.ts` also keeps the `LAYERS` row, the pane's
 * slot in `setState`'s ordered close, the navigation-key exception for the preview, and the ten
 * `Hud` members, each delegating here. The Main Menu opener is looked up, and shown or hidden,
 * by `hud.ts`, because it is Main Menu markup; the pane wires its click.
 *
 * THE SHARED-STATE COST is `CustomizeHost` below: five host members, plus the container's surface
 * and the opener. Nothing here reads or writes a `hud.ts` binding.
 *
 * THE MARKUP IS INTERPOLATED, NOT WRITTEN. `hud.ts` places `CUSTOMIZE_BODY` where these lines used
 * to be, so the string it assigns to `innerHTML` is unchanged character for character, and one
 * parse builds the DOM, as before.
 */

/**
 * The four rotate buttons' icons, built from two halves so the pairs cannot drift apart:
 * an arc arrow (mirrored for the left-hand button by a transform, NOT by a second
 * hand-written path -- a mirrored copy is where an asymmetric pair comes from) over the
 * silhouette of the part it turns.
 *
 * `currentColor` throughout, so the buttons' own hover/active colours carry the icon
 * with them, and `aria-hidden` because the accessible name lives on the button.
 */
const ROTATE_ARROW =
  '<path d="M5 9a9 7 0 0 1 14 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  '<path d="M19 11.4l-2.3-3.8h4.6z" fill="currentColor"/>';
const ROTATE_HULL = '<rect x="7" y="13.5" width="10" height="7.5" rx="2" fill="currentColor"/>';
const ROTATE_TURRET =
  '<circle cx="10.5" cy="17.2" r="3.4" fill="currentColor"/>' +
  '<rect x="13" y="16.2" width="6.5" height="2" rx="1" fill="currentColor"/>';

function rotateIcon(part: 'hull' | 'turret', dir: 'left' | 'right'): string {
  const arrow =
    dir === 'right'
      ? ROTATE_ARROW
      : `<g transform="translate(24,0) scale(-1,1)">${ROTATE_ARROW}</g>`;
  return (
    '<svg class="hud-rotate-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    arrow +
    (part === 'hull' ? ROTATE_HULL : ROTATE_TURRET) +
    '</svg>'
  );
}

const ROTATE_ICON = {
  hullLeft: rotateIcon('hull', 'left'),
  hullRight: rotateIcon('hull', 'right'),
  turretLeft: rotateIcon('turret', 'left'),
  turretRight: rotateIcon('turret', 'right'),
};

/**
 * Everything between the container's opening tag and its `</div>`, verbatim: newlines,
 * indentation and HTML comments included, because comments are DOM nodes. Moved from `hud.ts`,
 * which interpolates it at the same position.
 */
export const CUSTOMIZE_BODY = `
      <h1 id="hud-customize-title">Customize</h1>
      <!-- The live preview: render/preview.ts builds a SECOND small WebGL scene against
           this canvas, using the SAME tank-building code (render/entities.ts) and skin
           textures (render/skins.ts) the game itself uses -- not a depiction of the
           tank, the tank. Owned as markup here, driven from game/loop.ts via
           onCustomizeOpen/onCustomizeClose (hud.ts stays free of three.js, see the Hud
           interface doc comment on previewCanvas).

           It USED to be aria-hidden, on the reasoning that it only repaints choices
           already exposed as labelled buttons below. That stopped being true when it
           became interactive: render/preview-controls.ts gives it a keyboard scheme,
           and a focusable element inside an aria-hidden subtree is a focus trap for a
           screen-reader user -- tabbable but unannounced. So it is now a labelled,
           focusable control instead, and the label states the scheme, which is also
           one of two places a keyboard-only player could learn it. tabindex is what
           puts it in the pane's tab order at all; a canvas has none by default.
           No explicit role: it is a focusable element with an accessible name, which
           is enough to be announced. An img role would contradict the tabindex (an
           image is not interactive) and an application role hands the whole key
           stream over for the sake of two arrows.

           A focus-gated <p> used to sit here spelling out the keyboard scheme, because
           shift+arrows had no discoverability path for a sighted keyboard user. The row
           of buttons below replaces it and does the job better: it is on screen for
           everyone rather than only for whoever tabs to the canvas, it works for touch
           (which had no path to the scheme at all), and it teaches the hull/turret split
           by showing it as four controls. So the pane is back to no prose. -->
      <canvas class="hud-preview" tabindex="0" title="Drag to turn the hull. Point to aim the turret. Arrow keys turn the hull, shift+arrows turn the turret." aria-label="Tank preview. Drag to turn the hull, or use the left and right arrow keys. Move the pointer over it to aim the turret, or hold shift with the arrow keys."></canvas>
      <!-- The rotate cluster: hull left/right, turret left/right, in that order, with
           hold-to-repeat (render/preview-controls.ts, which reads the data attributes
           below -- an unrecognised pair leaves a button INERT, which is why the exact
           four are pinned in hud.test.ts).

           Four buttons and not a slider: a slider is a linear control for a circular
           quantity, so it needs endpoints that do not exist, wraps badly at 0/360, and
           eats width in a 260px pane.

           Icons only, no visible text: this is a control cluster, not prose, and the
           pane is pinned at two labelled sections. The accessible name is on the button
           via aria-label; the SVGs are aria-hidden so a screen reader reads the name
           once. Each icon carries the SHAPE of what it turns -- a hull plate, or a
           turret with its barrel -- under an arc arrow pointing the way the tank will
           go, which is the same direction the matching arrow key and drag send it. -->
      <div class="hud-preview-rotate">
        <button class="hud-rotate-btn" type="button" data-rotate-part="hull" data-rotate-dir="left" aria-label="Turn hull left" title="Turn hull left (hold to keep turning)">${ROTATE_ICON.hullLeft}</button>
        <button class="hud-rotate-btn" type="button" data-rotate-part="hull" data-rotate-dir="right" aria-label="Turn hull right" title="Turn hull right (hold to keep turning)">${ROTATE_ICON.hullRight}</button>
        <button class="hud-rotate-btn" type="button" data-rotate-part="turret" data-rotate-dir="left" aria-label="Turn turret left" title="Turn turret left (hold to keep turning)">${ROTATE_ICON.turretLeft}</button>
        <button class="hud-rotate-btn" type="button" data-rotate-part="turret" data-rotate-dir="right" aria-label="Turn turret right" title="Turn turret right (hold to keep turning)">${ROTATE_ICON.turretRight}</button>
      </div>
      <section class="hud-customize-section">
        <h2>Hull</h2>
        <div class="hud-swatches"></div>
      </section>
      <section class="hud-customize-section">
        <h2>Skin</h2>
        <div class="hud-skins"></div>
        <div class="hud-accents"></div>
      </section>
      <button class="ui-btn ui-btn--slab hud-customize-back" type="button">Back</button>
    `;

/** The host members this pane calls: its shared-state cost. Pinned by `pane-host.test.ts`. */
export type CustomizeHost = Pick<PaneHost, 'enterSurface' | 'closeSurface' | 'isSurfaceOpen' | 'open' | 'back'>;

export interface CustomizePane extends Omit<CustomizeChoices, 'renderSelection'> {
  /**
   * The live preview's canvas, handed out so `route-ui.ts` can build a WebGL scene on it while
   * the pane is open. `hud.ts` stays free of three.js.
   */
  readonly previewCanvas: HTMLCanvasElement;
  /** The rotate cluster's four buttons, whose data attributes `render/preview-controls.ts` reads. */
  readonly previewRotateButtons: readonly HTMLButtonElement[];
  /** The pane just became visible. Fired only on an actual transition. */
  onCustomizeOpen(cb: () => void): void;
  /** The pane just closed, by any path. Fired only on an actual transition. */
  onCustomizeClose(cb: () => void): void;
  /**
   * The single open/close chokepoint: the Back button, `back()`, and `setState`'s unconditional
   * close all come through here, so a subscriber that builds the preview on open cannot leak a
   * WebGL context down another path.
   */
  show(open: boolean, instant?: boolean): void;
  /**
   * A sibling pane is replacing this one (issue #558). The incoming pane fades this surface out,
   * so only the subscribers are released, and only if the pane was on screen.
   */
  release(): void;
  /** Remove the opener and Back listeners this pane added. */
  dispose(): void;
}

export function createCustomizePane(
  host: CustomizeHost,
  surface: Surface,
  opener: HTMLButtonElement,
): CustomizePane {
  const root = surface.el;
  const previewCanvas = root.querySelector('.hud-preview') as HTMLCanvasElement;
  const previewRotateButtons = Array.from(
    root.querySelectorAll('.hud-preview-rotate .hud-rotate-btn'),
  ) as HTMLButtonElement[];
  const backBtn = root.querySelector('.hud-customize-back') as HTMLButtonElement;
  const choices = renderCustomizeChoices({
    hull: root.querySelector('.hud-swatches') as HTMLElement,
    skin: root.querySelector('.hud-skins') as HTMLElement,
    accent: root.querySelector('.hud-accents') as HTMLElement,
  });
  const openCbs: Array<() => void> = [];
  const closeCbs: Array<() => void> = [];

  // Guarded on the ACTUAL transition so a caller building or disposing the live preview off these
  // never sees a redundant open or a redundant dispose.
  function show(open: boolean, instant = false): void {
    // Read BEFORE the transition begins: during a crossfade "not hidden" alone is the wrong
    // question, and `isSurfaceOpen` already discounts a surface that is fading out.
    const wasOpen = host.isSurfaceOpen(surface);
    if (open) {
      host.enterSurface(surface, () => {
        choices.renderSelection();
        root.focus(); // the pane, not the canvas: the roving focus starts from the container
        if (!wasOpen) for (const cb of openCbs) cb();
      });
    } else {
      host.closeSurface(
        surface,
        () => {
          if (wasOpen) for (const cb of closeCbs) cb();
        },
        instant,
      );
    }
  }

  const handleOpen = (): void => {
    host.open(opener);
  };
  const handleBack = (): void => {
    host.back();
  };
  opener.addEventListener('click', handleOpen);
  opener.addEventListener('click', blurIfPointer);
  backBtn.addEventListener('click', handleBack);
  backBtn.addEventListener('click', blurIfPointer);

  return {
    setHullColor: choices.setHullColor,
    onPickHullColor: choices.onPickHullColor,
    setSkin: choices.setSkin,
    onPickSkin: choices.onPickSkin,
    setAccentColor: choices.setAccentColor,
    onPickAccentColor: choices.onPickAccentColor,
    previewCanvas,
    previewRotateButtons,
    onCustomizeOpen(cb) {
      openCbs.push(cb);
    },
    onCustomizeClose(cb) {
      closeCbs.push(cb);
    },
    show,
    release() {
      // Guarded on the surface being open for the same reason `show` guards on `wasOpen`: a
      // release that fired for a pane that was never on screen would tear down a preview nobody
      // built.
      if (host.isSurfaceOpen(surface)) for (const cb of closeCbs) cb();
    },
    dispose() {
      opener.removeEventListener('click', handleOpen);
      opener.removeEventListener('click', blurIfPointer);
      backBtn.removeEventListener('click', handleBack);
      backBtn.removeEventListener('click', blurIfPointer);
    },
  };
}
