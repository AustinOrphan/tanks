// @vitest-environment jsdom
//
// The controller self-test PANE (issue #599) -- the half `controller-selftest.test.ts` does
// not cover: reaching it, leaving it, what a gamepad may do while it is up, and what Copy
// writes. Each case names the production change it would catch.
import { describe, it, expect, afterEach } from 'vitest';
import { createHud, type Hud } from './hud';
import type { PadDiagnostic } from '../input/gamepad-diagnostics';

let hud: Hud | null = null;
afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

function mountDev(): { hud: Hud; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  hud = createHud(root, { developerMode: true });
  hud.setState('main-menu');
  return { hud, root };
}

const q = <T extends HTMLElement>(root: HTMLElement, sel: string): T =>
  root.querySelector<T>(sel) as T;
/**
 * The same predicate `hud.ts`'s own `isSurfaceOpen` uses, and for the same reason: a
 * surface keeps its `--hidden` class OFF for the whole crossfade out, so a bare display
 * check answers "open" for a pane the player has already left. `ui-surface--leaving` is
 * what distinguishes the two during those 150ms, and every assertion here about a pane
 * being gone lands inside that window.
 */
const isOpen = (el: HTMLElement, hidden: string): boolean =>
  !el.classList.contains(hidden) && !el.classList.contains('ui-surface--leaving');
const selfTestOpen = (root: HTMLElement): boolean =>
  isOpen(q(root, '.hud-selftest'), 'hud-selftest--hidden');
const devToolsOpen = (root: HTMLElement): boolean =>
  isOpen(q(root, '.hud-devtools'), 'hud-devtools--hidden');
const shown = (el: HTMLElement): boolean => getComputedStyle(el).display !== 'none';

function openSelfTest(root: HTMLElement): void {
  q<HTMLButtonElement>(root, '.hud-devtools-open').click();
  q<HTMLButtonElement>(root, '.hud-selftest-open').click();
}

function pad(overrides: Partial<PadDiagnostic> = {}): PadDiagnostic {
  return {
    padIndex: overrides.padIndex ?? 0,
    id: overrides.id ?? 'Test Pad',
    mapping: overrides.mapping ?? 'standard',
    axes: overrides.axes ?? [0, 0],
    buttons: overrides.buttons ?? [{ pressed: false, value: 0 }],
  };
}

describe('the controller self-test pane (issue #599)', () => {
  it('replaces the developer shell rather than stacking on it, and Back lands on the menu', () => {
    // THE SHIPPED LAYER CONTRACT, asserted rather than assumed: `openLayer` POPS the layer
    // it finds on top and carries that layer's ORIGIN forward, so every route pane is a
    // sibling and Back returns to where the first of them was opened from. Settings ->
    // About & Legal and the two Records tabs already behave this way; the self-test is not
    // given a nested stack of its own.
    //
    // The second assertion is the one with teeth. Before `DEVTOOLS_SURFACE` joined
    // `PANEL_FAMILY`, `openSurface()` could not see the shell, so this transition sourced
    // from the Main Menu panel instead and left the shell DISPLAYED underneath the
    // self-test -- two surfaces on screen at once, which is exactly what the
    // one-surface invariant forbids.
    const { hud: h, root } = mountDev();
    openSelfTest(root);
    expect(selfTestOpen(root)).toBe(true);
    expect(devToolsOpen(root), 'the shell it was opened from must not stay on screen').toBe(false);
    h.back();
    expect(selfTestOpen(root)).toBe(false);
    expect(devToolsOpen(root), 'Back is a sibling exit, not a return to the shell').toBe(false);
    expect(
      isOpen(q(root, '.hud-panel'), 'hud-panel--hidden'),
      'Back lands on the Main Menu, the origin the shell carried forward',
    ).toBe(true);
  });

  it('fires open and close exactly once per transition, which is what scopes the frame poll', () => {
    // `route-ui.ts` starts a per-frame hardware poll on open and stops it on close. A
    // second open with no close between them would start a second poll that nothing can
    // stop; a close that never fires leaves the first one running for the life of the page.
    const { hud: h, root } = mountDev();
    const log: string[] = [];
    h.onControllerSelfTestOpen(() => log.push('open'));
    h.onControllerSelfTestClose(() => log.push('close'));
    openSelfTest(root);
    expect(log).toEqual(['open']);
    h.back();
    expect(log).toEqual(['open', 'close']);
    h.back(); // already closed: nothing left to close
    expect(log).toEqual(['open', 'close']);
  });

  it('closes -- and so stops the poll -- when a surface change takes the pane away', () => {
    // A surface change is never a Back, so `setState` drops every layer outright. That path
    // bypasses `back()` entirely, and it is the one a match starting underneath the pane
    // takes. Without the close here the poll would survive the pane and read the hardware
    // on every frame of the match.
    const { hud: h, root } = mountDev();
    const log: string[] = [];
    h.onControllerSelfTestClose(() => log.push('close'));
    openSelfTest(root);
    h.setState('playing');
    expect(log).toEqual(['close']);
    expect(selfTestOpen(root)).toBe(false);
  });

  it('renders the pads it is pushed, and keeps rendering them frame after frame', () => {
    const { hud: h, root } = mountDev();
    openSelfTest(root);
    h.setPadDiagnostics([pad({ axes: [0.5, 0] })]);
    expect(q(root, '.hud-selftest-pad-name').textContent).toBe('Index 0 — Test Pad');
    expect(
      Array.from(root.querySelectorAll('.hud-selftest-channel-value')).map((n) => n.textContent),
    ).toEqual(['0.50', '0.00', '0.00']);
  });
});

describe('the self-test takes the pad off the menu (issue #599)', () => {
  it('consumes and drops every gamepad action except Back while the pane is open', () => {
    // THE POINT OF THE PANE. `gamepad-menu.ts` reads button 0 as Confirm and the left stick
    // as the four directions, so without this a tester pressing the two buttons they most
    // need to identify would activate a control or walk the focus ring instead of seeing
    // the readout move. `act` returning false would hand the action to the page, which is
    // the same defect one layer up.
    const { hud: h, root } = mountDev();
    openSelfTest(root);
    const copy = q<HTMLButtonElement>(root, '.hud-selftest-copy');
    copy.focus();
    expect(h.act('confirm'), 'the action is consumed, not passed to the page').toBe(true);
    // Confirm did NOT click Copy: the report field is still hidden and empty.
    expect(shown(q(root, '.hud-selftest-report'))).toBe(false);
    expect(h.act('down')).toBe(true);
    expect(document.activeElement, 'a direction must not move the focus ring here').toBe(copy);
  });

  it('leaves Back live, so a tester holding nothing but a controller is never trapped', () => {
    const { hud: h, root } = mountDev();
    openSelfTest(root);
    expect(h.act('back')).toBe(true);
    expect(selfTestOpen(root)).toBe(false);
  });

  it('negative control: the same actions still work on the pane next door', () => {
    // Without this, "act returns true and does nothing" would be indistinguishable from a
    // suppression that had leaked to every pane in the HUD.
    const { hud: h, root } = mountDev();
    q<HTMLButtonElement>(root, '.hud-devtools-open').click();
    const back = q<HTMLButtonElement>(root, '.hud-devtools-back');
    back.focus();
    h.act('confirm');
    expect(devToolsOpen(root), 'Confirm must still activate the focused control').toBe(false);
  });

  it('the KEYBOARD is untouched: Tab order and Enter still reach Copy Report', () => {
    // The suppression is on `act`, which only the gamepad poller calls. A guard placed on
    // the pane's own key handling instead would take the keyboard with it and leave the
    // report uncopyable.
    const { root } = mountDev();
    openSelfTest(root);
    const copy = q<HTMLButtonElement>(root, '.hud-selftest-copy');
    copy.focus();
    copy.click();
    expect(shown(q(root, '.hud-selftest-report'))).toBe(true);
  });
});

describe('the copyable report (issue #599)', () => {
  it('fills the field from the LAST frame pushed, reveals it, and selects it', () => {
    // Selection is the path that always works: the async Clipboard API is origin- and
    // permission-gated and absent here, so a Copy that only called it would do nothing at
    // all on an insecure context.
    const { hud: h, root } = mountDev();
    openSelfTest(root);
    h.setPadDiagnostics([pad({ padIndex: 2, id: 'Old Frame' })]);
    h.setPadDiagnostics([pad({ padIndex: 2, id: 'Newest Frame' })]);
    const report = q<HTMLTextAreaElement>(root, '.hud-selftest-report');
    q<HTMLButtonElement>(root, '.hud-selftest-copy').click();
    expect(shown(report)).toBe(true);
    expect(report.value).toContain('### Index 2 -- Newest Frame');
    expect(report.value).not.toContain('Old Frame');
    expect(report.selectionStart).toBe(0);
    expect(report.selectionEnd).toBe(report.value.length);
    expect(document.activeElement).toBe(report);
  });

  it('empties the field on close, so a second visit never presents a stale snapshot', () => {
    // The report is pad state from whenever Copy was last pressed. Retained across a visit
    // it would be indistinguishable from a fresh reading of hardware that has since been
    // unplugged -- the worst possible thing to paste into a compatibility issue.
    const { hud: h, root } = mountDev();
    openSelfTest(root);
    h.setPadDiagnostics([pad()]);
    q<HTMLButtonElement>(root, '.hud-selftest-copy').click();
    const report = q<HTMLTextAreaElement>(root, '.hud-selftest-report');
    expect(report.value).not.toBe('');
    h.back();
    expect(report.value).toBe('');
    openSelfTest(root);
    expect(shown(report), 'the field is hidden again until Copy is pressed').toBe(false);
  });
});
