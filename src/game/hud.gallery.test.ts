// @vitest-environment jsdom
//
// The gallery workbench PANE (issue #730) -- the half gallery-workbench.test.ts does not
// cover: reaching it, both ways out of it, and the open/close hooks `route-ui.ts` hangs a
// WebGL renderer on. Each case names the production change it would catch.
import { describe, it, expect, afterEach } from 'vitest';
import { createHud, type Hud, type HudOptions } from './hud';

let hud: Hud | null = null;
afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

function mount(opts: HudOptions = { developerMode: true, galleryWorkbench: true }): {
  hud: Hud;
  root: HTMLElement;
  events: string[];
} {
  const root = document.createElement('div');
  document.body.appendChild(root);
  hud = createHud(root, opts);
  hud.setState('main-menu');
  const events: string[] = [];
  hud.onGalleryOpen(() => events.push('open'));
  hud.onGalleryClose(() => events.push('close'));
  return { hud, root, events };
}

const q = <T extends HTMLElement>(root: HTMLElement, sel: string): T => root.querySelector<T>(sel) as T;
/** hud.selftest.test.ts's predicate: a pane mid-fade-out still lacks its hidden class. */
const isOpen = (el: HTMLElement, hidden: string): boolean =>
  !el.classList.contains(hidden) && !el.classList.contains('ui-surface--leaving');
const galleryOpen = (root: HTMLElement): boolean => isOpen(q(root, '.hud-gallery'), 'hud-gallery--hidden');
const devToolsOpen = (root: HTMLElement): boolean => isOpen(q(root, '.hud-devtools'), 'hud-devtools--hidden');

function openFromShell(root: HTMLElement): void {
  q<HTMLButtonElement>(root, '.hud-devtools-open').click();
  q<HTMLButtonElement>(root, '.hud-gallery-open').click();
}

describe('the gallery workbench pane (issue #730)', () => {
  it('is offered in Developer Tools only on a page that binds the workbench', () => {
    // Would catch: the entry shown unconditionally, opening an empty pane in every test HUD.
    const withIt = mount();
    expect(q<HTMLButtonElement>(withIt.root, '.hud-gallery-open').hidden).toBe(false);
    hud?.dispose();
    document.body.innerHTML = '';
    const without = mount({ developerMode: true });
    expect(q<HTMLButtonElement>(without.root, '.hud-gallery-open').hidden).toBe(true);
  });

  it('opens from Developer Tools, replacing the shell, and fires open exactly once', () => {
    const { root, events } = mount();
    openFromShell(root);
    expect(galleryOpen(root)).toBe(true);
    expect(devToolsOpen(root), 'the shell must not stay on screen under the pane').toBe(false);
    q<HTMLButtonElement>(root, '.hud-gallery-open').click(); // a second press on a hidden opener
    expect(events).toEqual(['open']);
  });

  it('hands out an empty body for the route UI to build into', () => {
    const { hud: h, root } = mount();
    expect(h.galleryBody).toBe(q(root, '.hud-gallery-body'));
    expect(h.galleryBody.childElementCount).toBe(0);
  });

  it('Back closes it and lands on the menu, the sibling contract every developer pane keeps', () => {
    // Would catch: Back that hid the pane without firing close, which leaves the renderer.
    const { hud: h, root, events } = mount();
    openFromShell(root);
    h.back();
    expect(galleryOpen(root)).toBe(false);
    expect(devToolsOpen(root), 'Back is a sibling exit, not a return to the shell').toBe(false);
    expect(events).toEqual(['open', 'close']);
  });

  it('Developer Tools returns to the shell and still fires close', () => {
    // The route back the issue asks for. It goes through `openLayer`'s REPLACE path, which
    // releases the outgoing layer rather than closing it -- so without the layer's `release`
    // this test sees the shell open and no close, and the renderer would keep drawing.
    const { root, events } = mount();
    openFromShell(root);
    q<HTMLButtonElement>(root, '.hud-gallery-devtools').click();
    expect(devToolsOpen(root)).toBe(true);
    expect(galleryOpen(root)).toBe(false);
    expect(events).toEqual(['open', 'close']);
  });

  it('a surface change closes it and fires close', () => {
    // Would catch: setState's close-all using a bare class add for this pane, as it does for
    // panes that hold nothing -- the path a match starting under the pane takes.
    const { hud: h, root, events } = mount();
    openFromShell(root);
    h.setState('playing');
    expect(galleryOpen(root)).toBe(false);
    expect(events).toEqual(['open', 'close']);
  });

  it('reopens, and fires open and close once per visit', () => {
    const { hud: h, root, events } = mount();
    for (let i = 0; i < 3; i++) {
      openFromShell(root);
      h.back();
    }
    expect(events).toEqual(['open', 'close', 'open', 'close', 'open', 'close']);
  });
});

describe('openGalleryWorkbench: the boot path for a ?gallery= link (issue #730)', () => {
  it('opens the pane with no opener on a developer page that binds the workbench', () => {
    const { hud: h, root, events } = mount();
    expect(h.openGalleryWorkbench()).toBe(true);
    expect(galleryOpen(root)).toBe(true);
    expect(events).toEqual(['open']);
    h.back();
    expect(events).toEqual(['open', 'close']);
  });

  it('opens nothing outside developer mode, or on a page without the workbench', () => {
    // Would catch: a link opening a developer pane on the player's page.
    for (const opts of [{ galleryWorkbench: true }, { developerMode: true }] satisfies HudOptions[]) {
      const { hud: h, root, events } = mount(opts);
      expect(h.openGalleryWorkbench(), JSON.stringify(opts)).toBe(false);
      expect(galleryOpen(root)).toBe(false);
      expect(events).toEqual([]);
      h.dispose();
      hud = null;
      document.body.innerHTML = '';
    }
  });
});
