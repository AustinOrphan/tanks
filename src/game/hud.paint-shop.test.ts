// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createHud, type Hud } from './hud';
import { SKINS, ACCENTS } from '../presentation/customization';
import { installComputedStyleCache } from './computed-style-cache';

/**
 * The paint shop. Split from `hud.controls.test.ts` (issue #1093), with the controller
 * assignment panel (`hud.controller-panel.test.ts`); `hud.transitions.test.ts`'s header says
 * why.
 */

// Keeps `display` across focus moves, which jsdom 30.1.2 recomputes (issue #1093).
installComputedStyleCache();

let hud: Hud | null = null;

function mount(): { hud: Hud; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  hud = createHud(root);
  return { hud, root };
}

afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

describe('hud: the paint shop', () => {
  const pane = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-customize') as HTMLElement;
  const openBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-customize-open') as HTMLButtonElement;
  // `.hud-swatch` is the shared circle-button class for BOTH the hull row and the
  // accent row (they are the same control), so scope by the dataset attribute each
  // row alone sets -- `data-hull` here, `data-accent` for the accent row below.
  const swatches = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll('.hud-swatch[data-hull]'));
  const accentSwatches = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll('.hud-swatch[data-accent]'));

  it('opens from the title with one swatch per palette entry, current one marked', () => {
    const { hud: h, root } = mount();
    h.setHullColor('red');
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(pane(root).classList.contains('hud-customize--hidden')).toBe(false);
    expect(swatches(root).length).toBeGreaterThanOrEqual(6);
    const selected = swatches(root).filter((b) => b.classList.contains('ui-selectable--on'));
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.hull).toBe('red');
  });

  it('reports a pick by id and re-marks the selection', () => {
    const { hud: h, root } = mount();
    const picks: string[] = [];
    h.onPickHullColor((id) => picks.push(id));
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    const purple = swatches(root).find((b) => b.dataset.hull === 'purple')!;
    purple.dispatchEvent(new MouseEvent('click'));
    expect(picks).toEqual(['purple']);
    h.setHullColor('purple'); // the loop echoes the accepted pick back
    expect(purple.classList.contains('ui-selectable--on')).toBe(true);
  });

  it('offers one skin button per SKINS entry, current one marked, and reports picks', () => {
    const { hud: h, root } = mount();
    const skins = (): HTMLButtonElement[] => Array.from(root.querySelectorAll('.hud-skin'));
    const picks: string[] = [];
    h.onPickSkin((id) => picks.push(id));
    h.setSkin('camo');
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    // One button per entry in the REAL skin list, labelled from it.
    expect(skins().map((b) => b.dataset.skin)).toEqual(SKINS.map((sk) => sk.id));
    expect(skins().map((b) => b.textContent)).toEqual(SKINS.map((sk) => sk.label));
    const selected = skins().filter((b) => b.classList.contains('ui-selectable--on'));
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.skin).toBe('camo');

    const checker = skins().find((b) => b.dataset.skin === 'checker')!;
    checker.dispatchEvent(new MouseEvent('click'));
    expect(picks).toEqual(['checker']);
    h.setSkin('checker'); // the loop echoes the accepted pick back
    expect(checker.classList.contains('ui-selectable--on')).toBe(true);
    expect(skins().filter((b) => b.classList.contains('ui-selectable--on'))).toHaveLength(1);
  });

  it('offers one accent swatch per ACCENTS entry, current one marked, and reports picks', () => {
    const { hud: h, root } = mount();
    const picks: string[] = [];
    h.onPickAccentColor((id) => picks.push(id));
    h.setAccentColor('black');
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    // One button per entry in the REAL accent list, `auto` first.
    expect(accentSwatches(root).map((b) => b.dataset.accent)).toEqual(
      ACCENTS.map((a) => a.id),
    );
    const selected = accentSwatches(root).filter((b) =>
      b.classList.contains('ui-selectable--on'),
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.accent).toBe('black');

    const gold = accentSwatches(root).find((b) => b.dataset.accent === 'gold')!;
    gold.dispatchEvent(new MouseEvent('click'));
    expect(picks).toEqual(['gold']);
    h.setAccentColor('gold'); // the loop echoes the accepted pick back
    expect(gold.classList.contains('ui-selectable--on')).toBe(true);
    expect(
      accentSwatches(root).filter((b) => b.classList.contains('ui-selectable--on')),
    ).toHaveLength(1);
  });

  it('is a title-screen affair: hidden everywhere else, closed by any state change', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    h.setState('playing');
    expect(pane(root).classList.contains('hud-customize--hidden')).toBe(true);
    for (const s of ['paused', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-customize-open--hidden'), s).toBe(true);
    }
  });

  // The accent-hint feature (a <p> shown only for solid+explicit-accent) was removed
  // along with the rest of the panel's prose: the design feedback asked for exactly two
  // labelled sections (Hull, Skin) with the rest self-explanatory once the panel has a
  // real preview. The preview does not resolve the ambiguity the hint used to name (a
  // solid-skin tank still shows no visible change when an accent is picked) any more
  // than the old background tank did -- it makes the absence of change more vivid,
  // not less confusing on its own -- but the selection ring still confirms the pick
  // registered, and that instruction is explicit enough on its own to cut this
  // narrow an edge case. See the PR body for the fuller argument.

  it('has exactly two labelled sections -- Hull and Skin -- and no prose at rest', () => {
    const { root } = mount();
    const headings = Array.from(pane(root).querySelectorAll('h2')).map((h) => h.textContent);
    expect(headings).toEqual(['Hull', 'Skin']);
    // BACK to "no <p> at all". It was briefly relaxed to allow one focus-gated hint
    // spelling out the keyboard scheme; the rotate cluster teaches the same thing to
    // everyone, including touch, so the exception is gone with the element. Adding any
    // paragraph to this pane fails here.
    expect(Array.from(pane(root).querySelectorAll('p'))).toEqual([]);
    // ...and the cluster really is icons, with no visible words of its own -- the check
    // that stops "no prose" being satisfied by moving the prose into the buttons.
    const cluster = pane(root).querySelector('.hud-preview-rotate') as HTMLElement;
    expect(cluster.textContent?.trim()).toBe('');
  });

  it('gives the preview four rotate buttons, one per part and direction', () => {
    // The exact four, as ATTRIBUTE PAIRS: preview-controls.ts parses these and drops
    // anything it does not recognise, so a typo here is an inert button and nothing
    // else in the tree would say so. Sorted, because the assertion is about the set.
    const { hud: h } = mount();
    const pairs = h.previewRotateButtons
      .map((b) => `${b.dataset.rotatePart}:${b.dataset.rotateDir}`)
      .sort();
    expect(pairs).toEqual(['hull:left', 'hull:right', 'turret:left', 'turret:right']);
    // Real buttons, so they are focusable and announced without a role of their own,
    // and type=button so they cannot submit anything.
    for (const b of h.previewRotateButtons) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('type')).toBe('button');
      // An accessible name that says both halves: which part, and which way.
      const label = b.getAttribute('aria-label') ?? '';
      expect(label, 'no accessible name').toMatch(/hull|turret/i);
      expect(label).toMatch(/left|right/i);
      expect(label.toLowerCase()).toContain(b.dataset.rotatePart!);
      expect(label.toLowerCase()).toContain(b.dataset.rotateDir!);
      // The icon must not be read out as well -- the name already says it.
      const icon = b.querySelector('svg');
      expect(icon, 'the button has no icon at all').not.toBeNull();
      expect(icon!.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('orders the cluster hull-pair then turret-pair, left before right', () => {
    // The order is the layout: hud.css puts the extra gap before the THIRD child, so a
    // reordering silently moves the visual grouping onto the wrong pair.
    const { hud: h } = mount();
    expect(h.previewRotateButtons.map((b) => `${b.dataset.rotatePart}:${b.dataset.rotateDir}`)).toEqual(
      ['hull:left', 'hull:right', 'turret:left', 'turret:right'],
    );
    // ...and they sit under the canvas, in the pane, not somewhere else in the HUD.
    expect(h.previewCanvas.nextElementSibling).toBe(
      h.previewRotateButtons[0].parentElement,
    );
  });

  it('mirrors the left icon from the right one rather than hand-drawing a second path', () => {
    // The pair is drawn once and flipped by a transform. A hand-written mirror is where
    // an asymmetric pair comes from, and nothing else in the suite looks at these
    // glyphs -- they are exactly the "file no test reads" case. Asserted as the
    // relationship: the two icons of a pair must differ ONLY by that transform.
    const { hud: h } = mount();
    const svg = (part: string, dir: string): string =>
      h.previewRotateButtons
        .find((b) => b.dataset.rotatePart === part && b.dataset.rotateDir === dir)!
        .innerHTML;
    for (const part of ['hull', 'turret']) {
      const right = svg(part, 'right');
      const left = svg(part, 'left');
      expect(left).not.toBe(right);
      expect(left).toContain('scale(-1,1)');
      expect(right).not.toContain('scale(-1,1)');
      // Strip the wrapper the mirror adds and the two are the same drawing.
      expect(left.replace(/<g transform="[^"]*">|<\/g>/g, '')).toBe(right);
    }
    // ...and the two PARTS are drawn differently, or all four buttons would look alike.
    expect(svg('hull', 'right')).not.toBe(svg('turret', 'right'));
  });

  it('puts the skin buttons AND the accent swatches inside the Skin section', () => {
    const { root } = mount();
    const sections = Array.from(pane(root).querySelectorAll('.hud-customize-section'));
    const skinSection = sections.find((s) => s.querySelector('h2')?.textContent === 'Skin');
    expect(skinSection).toBeDefined();
    expect(skinSection!.querySelector('.hud-skins')).not.toBeNull();
    expect(skinSection!.querySelector('.hud-accents')).not.toBeNull();
  });

  it('exposes a preview canvas element, present even before the panel first opens', () => {
    const { hud: h, root } = mount();
    expect(h.previewCanvas).toBeInstanceOf(HTMLCanvasElement);
    expect(h.previewCanvas.classList.contains('hud-preview')).toBe(true);
    expect(root.contains(h.previewCanvas)).toBe(true);
  });

  it('makes the preview a focusable, named control rather than decoration', () => {
    // It became interactive in the "rotate the tank" change (render/preview-controls.ts
    // gives it a keyboard scheme), and three markup facts carry that:
    //
    // - tabindex, because a canvas element has NO default tab stop, so without it the
    //   keyboard scheme is unreachable and the whole feature is mouse-only;
    // - no aria-hidden, because the canvas used to carry it and a FOCUSABLE element
    //   inside an aria-hidden subtree is a tab stop a screen reader cannot announce;
    // - an accessible name that states the scheme, which for a keyboard-only player is
    //   the only place it is written down (the pane carries no prose -- see the
    //   two-sections test above).
    const { hud: h } = mount();
    expect(h.previewCanvas.getAttribute('tabindex')).toBe('0');
    expect(h.previewCanvas.hasAttribute('aria-hidden')).toBe(false);
    const label = h.previewCanvas.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/drag/i);
    expect(label).toMatch(/arrow/i);
    expect(label).toMatch(/turret/i);
    // The sighted-mouse equivalent of the same sentence.
    expect(h.previewCanvas.getAttribute('title') ?? '').toMatch(/drag/i);
  });

  it('fires onCustomizeOpen/onCustomizeClose exactly on the Back-button round trip', () => {
    const { hud: h, root } = mount();
    const opens: number[] = [];
    const closes: number[] = [];
    h.onCustomizeOpen(() => opens.push(1));
    h.onCustomizeClose(() => closes.push(1));
    h.setState('main-menu');
    expect(opens).toHaveLength(0);
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(0);
    root.querySelector('.hud-customize-back')!.dispatchEvent(new MouseEvent('click'));
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(1);
  });

  it('unhides the pane BEFORE firing onCustomizeOpen, not after', () => {
    // Load-bearing for the live preview, even though jsdom cannot see the actual
    // consequence: game/loop.ts's onCustomizeOpen handler builds the preview and reads
    // hud.previewCanvas.clientWidth (via render/preview.ts's fit()) to size it. A
    // canvas still carrying `hud-customize--hidden` at that moment lays out at 0x0 in a
    // real browser, and fit()'s `|| 1` fallback would silently produce a 1x1 preview --
    // wrong, not broken, so nothing would throw and no GL check builds a canvas in that
    // exact hidden state to catch it. This pins the ORDERING that prevents it: by the
    // time the callback runs, the pane's hidden class is already gone.
    const { hud: h, root } = mount();
    let hiddenWhenCallbackFired: boolean | null = null;
    h.onCustomizeOpen(() => {
      hiddenWhenCallbackFired = pane(root).classList.contains('hud-customize--hidden');
    });
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(hiddenWhenCallbackFired).toBe(false);
  });

  it('fires onCustomizeClose on ANY state change while open, not just Back -- the leak this guards', () => {
    // The common exit from the panel is Start (setState('playing')), which never
    // touches the Back button. A caller building a live WebGL preview off open/close
    // (game/loop.ts does) would leak a context down this path if it only fired here.
    const { hud: h, root } = mount();
    const closes: number[] = [];
    h.onCustomizeClose(() => closes.push(1));
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(closes).toHaveLength(0);
    h.setState('playing');
    expect(closes).toHaveLength(1);
  });

  it('does not fire onCustomizeClose again for state changes AFTER the one that closed it', () => {
    // setState's guard is `wasOpen`, checked fresh each call -- without it, every
    // subsequent state change (not just the one that actually closed the panel) would
    // re-fire the close callback, and a caller disposing a WebGL context on it would
    // call dispose() on an already-disposed preview.
    const { hud: h, root } = mount();
    const closes: number[] = [];
    h.onCustomizeClose(() => closes.push(1));
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    h.setState('playing'); // closes it -- one close
    h.setState('main-menu');
    h.setState('paused');
    expect(closes).toHaveLength(1);
  });
});
