import { setSelected } from './ui';
import {
  ACCENTS,
  PALETTE,
  SKINS,
  type AccentId,
  type HullColorId,
  type SkinId,
} from '../presentation/customization';

/**
 * The Customize pane's three choice rows: hull colour, skin and accent (issue #556).
 *
 * Its own module for the reason `legal.ts` and `devtools-menu.ts` are: `hud.ts` is the largest
 * file in the repository, and this is the part of a pane that needs nothing from its closure.
 * `hud.ts` still owns the PANE -- its markup, its surface, its layer row, its open and close
 * callbacks, and the preview canvas -- because those are the navigation core every pane shares.
 * This owns what the three rows hold: one button per catalogue entry, which one is marked, and
 * who hears about a pick.
 *
 * THE SHARED-STATE COST IS THREE ELEMENTS IN AND NOTHING ELSE. The rows are handed over already
 * in the document; nothing here reads or writes a `hud.ts` binding, and `hud.ts` reaches back in
 * only through the returned object. The one ordering fact the pane depends on -- selection is
 * repainted before the pane takes focus and before its open callbacks run -- stays at its call
 * site in `showCustomize`, through `renderSelection`.
 *
 * STRUCTURE IS BUILT ONCE. The palette, skin list and accent list are frozen constants, so every
 * button exists from construction and the setters only move the selection ring.
 */

/** The three row containers, already in the document. Filled here, in this order. */
export interface CustomizeRows {
  readonly hull: HTMLElement;
  readonly skin: HTMLElement;
  readonly accent: HTMLElement;
}

export interface CustomizeChoices {
  /** Mark the stored hull colour. The HUD shows what was STORED, not what was clicked. */
  setHullColor(id: HullColorId): void;
  onPickHullColor(cb: (id: HullColorId) => void): void;
  setSkin(id: SkinId): void;
  onPickSkin(cb: (id: SkinId) => void): void;
  setAccentColor(id: AccentId): void;
  onPickAccentColor(cb: (id: AccentId) => void): void;
  /** Repaint all three rows' selection rings: hull, then skin, then accent. */
  renderSelection(): void;
}

export function renderCustomizeChoices(rows: CustomizeRows): CustomizeChoices {
  const pickHullCbs: Array<(id: HullColorId) => void> = [];
  let currentHull: HullColorId = PALETTE[0].id;

  // One button per palette entry, built once: the palette is a frozen constant.
  // Their click closures are deliberately NOT in hud.ts's dispose() removeEventListener
  // list: nothing outside this subtree holds them, so el.remove() reclaims all of
  // it -- the explicit removals there cover elements tests re-dispatch into.
  for (const swatch of PALETTE) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ui-selectable hud-swatch';
    b.dataset.hull = swatch.id;
    // TITLE IS NOT A NAME (issue #629). These buttons have no text -- the colour IS the
    // content -- so before this their only accessible name came from `title`, which is a
    // tooltip: some screen readers ignore it entirely and none of them promise it. The
    // row is named "Hull" by an <h2> a sighted reader can see, but a <section> with no
    // accessible name announces nothing, so the context has to travel on the control.
    // `title` stays for the sighted pointer user it already served.
    b.setAttribute('aria-label', `Hull: ${swatch.label}`);
    b.title = swatch.label;
    b.style.background = swatch.hex;
    b.addEventListener('click', (e) => {
      for (const cb of pickHullCbs) cb(swatch.id);
      if ((e as MouseEvent).detail > 0) b.blur();
    });
    rows.hull.appendChild(b);
  }

  function renderSwatchSelection(): void {
    for (const b of Array.from(rows.hull.children) as HTMLButtonElement[]) {
      setSelected(b, b.dataset.hull === currentHull);
    }
  }

  const pickSkinCbs: Array<(id: SkinId) => void> = [];
  let currentSkin: SkinId = SKINS[0].id;

  // One button per skin, built once, like the swatches above -- and like them,
  // the click closures live and die with the subtree.
  for (const skin of SKINS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ui-btn ui-selectable hud-skin';
    b.dataset.skin = skin.id;
    b.textContent = skin.label;
    b.addEventListener('click', (e) => {
      for (const cb of pickSkinCbs) cb(skin.id);
      if ((e as MouseEvent).detail > 0) b.blur();
    });
    rows.skin.appendChild(b);
  }

  function renderSkinSelection(): void {
    for (const b of Array.from(rows.skin.children) as HTMLButtonElement[]) {
      setSelected(b, b.dataset.skin === currentSkin);
    }
  }

  const pickAccentCbs: Array<(id: AccentId) => void> = [];
  let currentAccent: AccentId = ACCENTS[0].id;

  // One button per accent entry, built once, exactly like the hull swatches above --
  // reusing `.hud-swatch` rather than a new class, since it IS the same control: a
  // colour circle with a selection ring. `auto`'s hex is null (it has none of its own --
  // it derives from whatever hull is picked), so it gets a fixed neutral fill instead of
  // a palette hex, distinguishing it from any real hull or accent colour on screen.
  for (const accentSwatch of ACCENTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ui-selectable hud-swatch';
    b.dataset.accent = accentSwatch.id;
    // Named "Accent: X" rather than "X", and here the context is load-bearing rather than
    // symmetrical: accents share the "Skin" section with the skin buttons, so a bare
    // colour name would sit in a group whose heading says nothing about accents.
    b.setAttribute('aria-label', `Accent: ${accentSwatch.label}`);
    b.title = accentSwatch.label;
    b.style.background = accentSwatch.hex ?? '#4a4f58';
    b.addEventListener('click', (e) => {
      for (const cb of pickAccentCbs) cb(accentSwatch.id);
      if ((e as MouseEvent).detail > 0) b.blur();
    });
    rows.accent.appendChild(b);
  }

  function renderAccentSelection(): void {
    for (const b of Array.from(rows.accent.children) as HTMLButtonElement[]) {
      setSelected(b, b.dataset.accent === currentAccent);
    }
  }

  return {
    setHullColor(id: HullColorId): void {
      currentHull = id;
      renderSwatchSelection();
    },
    onPickHullColor(cb: (id: HullColorId) => void): void {
      pickHullCbs.push(cb);
    },
    setSkin(id: SkinId): void {
      currentSkin = id;
      renderSkinSelection();
    },
    onPickSkin(cb: (id: SkinId) => void): void {
      pickSkinCbs.push(cb);
    },
    setAccentColor(id: AccentId): void {
      currentAccent = id;
      renderAccentSelection();
    },
    onPickAccentColor(cb: (id: AccentId) => void): void {
      pickAccentCbs.push(cb);
    },
    renderSelection(): void {
      renderSwatchSelection();
      renderSkinSelection();
      renderAccentSelection();
    },
  };
}
