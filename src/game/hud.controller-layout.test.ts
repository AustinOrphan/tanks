// @vitest-environment jsdom
//
// The controller layout PANE (issue #754) -- the half `controller-layout.test.ts` does not
// cover: reaching it from Settings, leaving it, the open/close chokepoint the page's capture
// hangs off, and what Escape and Back do while a capture waits.
import { describe, it, expect, afterEach } from 'vitest';
import { createHud, type Hud } from './hud';
import { layoutModel, type LayoutRequest } from './controller-layout';
import { BINDABLE_ACTIONS, RECOMMENDED_LAYOUT, STANDARD_PROFILE } from '../input/gamepad-profile';

let hud: Hud | null = null;
afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

function mount(): { hud: Hud; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  hud = createHud(root);
  hud.setState('main-menu');
  return { hud, root };
}

const q = <T extends HTMLElement>(root: HTMLElement, sel: string): T => root.querySelector<T>(sel) as T;
/** `hud.ts`'s own `isSurfaceOpen` predicate: a pane fading out is not open. */
const isOpen = (el: HTMLElement, hidden: string): boolean =>
  !el.classList.contains(hidden) && !el.classList.contains('ui-surface--leaving');
const layoutOpen = (root: HTMLElement): boolean => isOpen(q(root, '.hud-layout'), 'hud-layout--hidden');

function openLayout(root: HTMLElement): void {
  q<HTMLButtonElement>(root, '.hud-settings-open').click();
  q<HTMLButtonElement>(root, '.hud-settings-layout').click();
}

const escape = (): void => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};

const standard = (capturing: 'fire' | null = null) => layoutModel(STANDARD_PROFILE, RECOMMENDED_LAYOUT, capturing, '');
/** Something stored, so Reset is enabled and reachable. */
const southpaw = (capturing: 'fire' | null = null) =>
  layoutModel(STANDARD_PROFILE, { preset: 'southpaw', bindings: {} }, capturing, '');

const pressActive = (key: string): void => {
  (document.activeElement as HTMLElement).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
};

/** The pane's controls in drawn order: the preset, the five rows, Cancel while a capture waits, Reset, Back. */
const controlsInOrder = (root: HTMLElement, waiting: boolean): HTMLElement[] =>
  [
    '.hud-layout-preset',
    ...BINDABLE_ACTIONS.map((action) => `.hud-layout-bind[data-action="${action}"]`),
    ...(waiting ? ['.hud-layout-cancel'] : []),
    '.hud-layout-reset',
    '.hud-layout-back',
  ].map((sel) => q<HTMLElement>(root, sel));

describe('the controller layout pane (issue #754)', () => {
  it('opens from Settings, replacing it, and Back lands where Settings was opened from', () => {
    const { hud: h, root } = mount();
    openLayout(root);
    expect(layoutOpen(root)).toBe(true);
    expect(isOpen(q(root, '.hud-settings'), 'hud-settings--hidden'), 'Settings must not stay on screen').toBe(false);
    h.back();
    expect(layoutOpen(root)).toBe(false);
    expect(isOpen(q(root, '.hud-panel'), 'hud-panel--hidden'), 'Back lands on the Main Menu').toBe(true);
  });

  it('fires open and close exactly once per transition, through Back and the Back button alike', () => {
    // `route-ui.ts` holds a capture, a settings subscription and two hotplug listeners from
    // open to close. A second open with no close would hold a second set nothing releases.
    const { hud: h, root } = mount();
    const log: string[] = [];
    h.onControllerLayoutOpen(() => log.push('open'));
    h.onControllerLayoutClose(() => log.push('close'));
    openLayout(root);
    h.back();
    h.back();
    expect(log).toEqual(['open', 'close']);
    openLayout(root);
    q<HTMLButtonElement>(root, '.hud-layout-back').click();
    expect(log).toEqual(['open', 'close', 'open', 'close']);
  });

  it('closes when a surface change takes the pane away', () => {
    // `setState` drops every layer without a Back. Without the close, a capture would keep
    // reading pads over a match that started underneath the pane.
    const { hud: h, root } = mount();
    const log: string[] = [];
    h.onControllerLayoutClose(() => log.push('close'));
    openLayout(root);
    h.setState('playing');
    expect(log).toEqual(['close']);
    expect(layoutOpen(root)).toBe(false);
  });

  it('paints what the page pushes and forwards what the body asks', () => {
    const { hud: h, root } = mount();
    const requests: LayoutRequest[] = [];
    h.onControllerLayoutRequest((r) => requests.push(r));
    openLayout(root);
    h.setControllerLayout(standard());
    const fire = q<HTMLButtonElement>(root, '.hud-layout-bind[data-action="fire"]');
    expect(fire.textContent).toBe('Fire: RT / R2');
    fire.click();
    expect(requests).toEqual([{ kind: 'capture', action: 'fire' }]);
  });

  it('Escape while a capture waits cancels it and keeps the pane', () => {
    const { hud: h, root } = mount();
    const requests: LayoutRequest[] = [];
    h.onControllerLayoutRequest((r) => requests.push(r));
    openLayout(root);
    h.setControllerLayout(standard('fire'));
    escape();
    expect(requests).toEqual([{ kind: 'cancel' }]);
    expect(layoutOpen(root), 'Escape left the pane instead of stopping the capture').toBe(true);
  });

  it('Escape with nothing waiting leaves the pane, and asks for nothing', () => {
    const { hud: h, root } = mount();
    const requests: LayoutRequest[] = [];
    h.onControllerLayoutRequest((r) => requests.push(r));
    openLayout(root);
    h.setControllerLayout(standard());
    escape();
    expect(requests).toEqual([]);
    expect(layoutOpen(root)).toBe(false);
  });

  it('the Back button leaves even while a capture waits', () => {
    const { hud: h, root } = mount();
    const log: string[] = [];
    h.onControllerLayoutClose(() => log.push('close'));
    openLayout(root);
    h.setControllerLayout(standard('fire'));
    q<HTMLButtonElement>(root, '.hud-layout-back').click();
    expect(layoutOpen(root)).toBe(false);
    expect(log).toEqual(['close']);
  });

  it('is a panel a controller can act in: Confirm with nothing focused lands inside the pane', () => {
    // `act` looks for the active panel container. A pane missing from that list would hand a
    // controller's Confirm to whatever surface is listed first, or to nothing.
    const { hud: h, root } = mount();
    openLayout(root);
    h.setControllerLayout(standard());
    (document.activeElement as HTMLElement | null)?.blur();
    expect(h.act('confirm')).toBe(true);
    expect(q(root, '.hud-layout').contains(document.activeElement), 'focus went outside the pane').toBe(true);
  });

  it('the arrow keys reach the preset, every row, Reset and Back in order, from the container', () => {
    // Keyboard reach is the pane's own to prove: `hud.navigation.test.ts`'s walk stops at the
    // openers on the Main Menu, so a row that stopped being focusable would fail no test there.
    const { hud: h, root } = mount();
    openLayout(root);
    h.setControllerLayout(southpaw());
    expect(document.activeElement, 'the pane opens focused as a container').toBe(q(root, '.hud-layout'));
    for (const control of controlsInOrder(root, false)) {
      pressActive('ArrowDown');
      expect(document.activeElement).toBe(control);
    }
  });

  it("a controller's D-pad reaches the same controls, Cancel included while a capture waits", () => {
    const { hud: h, root } = mount();
    openLayout(root);
    h.setControllerLayout(southpaw('fire'));
    (document.activeElement as HTMLElement | null)?.blur();
    for (const control of controlsInOrder(root, true)) {
      expect(h.act('down')).toBe(true);
      expect(document.activeElement).toBe(control);
    }
  });
});
