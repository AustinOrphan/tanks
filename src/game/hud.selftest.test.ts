// @vitest-environment jsdom
//
// The controller self-test PANE (issue #599) -- the half `controller-selftest.test.ts` does
// not cover: reaching it, leaving it, what a gamepad may do while it is up, and what Copy
// writes. Each case names the production change it would catch.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type Hud } from './hud';
import type { PadDiagnostic } from '../input/gamepad-diagnostics';
import { STANDARD_PROFILE } from '../input/gamepad-profile';

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

/**
 * Opens the pane and waits for its body, which `hud.ts` loads when the pane first opens
 * (issue #1013). Awaits the REAL import, the seam the page uses, and is bounded by
 * `vi.waitFor`, so a body that never lands fails here instead of leaving every later
 * assertion reading an empty list.
 */
async function openSelfTestLoaded(root: HTMLElement): Promise<void> {
  openSelfTest(root);
  await vi.waitFor(() => {
    const body = root.querySelector('.hud-selftest-pads');
    expect(body, 'the self-test body was never built').not.toBeNull();
  });
}

/**
 * Every dynamic import in flight has landed, plus a macrotask, so the HUD's `.then` has run:
 * an assertion of ABSENCE after this is not merely early.
 */
async function settled(): Promise<void> {
  await vi.dynamicImportSettled();
  await new Promise((r) => setTimeout(r, 0));
}

function pad(overrides: Partial<PadDiagnostic> = {}): PadDiagnostic {
  return {
    // `support` defaults to the standard verdict since issue #596: these fixtures describe a
    // standard-mapping pad, and the pane now renders what Tanks will do with it beside what
    // the browser reported. An override is how the refused cases are posed.
    support: overrides.support ?? { kind: 'standard', profile: STANDARD_PROFILE },
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

  it('renders the pads it is pushed, and keeps rendering them frame after frame', async () => {
    const { hud: h, root } = mountDev();
    await openSelfTestLoaded(root);
    h.setPadDiagnostics([pad({ axes: [0.5, 0] })]);
    expect(q(root, '.hud-selftest-pad-name').textContent).toBe('Index 0 — Test Pad');
    expect(
      Array.from(root.querySelectorAll('.hud-selftest-channel-value')).map((n) => n.textContent),
    ).toEqual(['0.50', '0.00', '0.00']);
  });
});

describe('the self-test takes the pad off the menu (issue #599)', () => {
  it('consumes and drops every gamepad action except Back while the pane is open', async () => {
    // THE POINT OF THE PANE. `gamepad-menu.ts` reads button 0 as Confirm and the left stick
    // as the four directions, so without this a tester pressing the two buttons they most
    // need to identify would activate a control or walk the focus ring instead of seeing
    // the readout move. `act` returning false would hand the action to the page, which is
    // the same defect one layer up.
    //
    // The body is awaited, because before it loads Copy does nothing whatever presses it
    // (issue #1013), and the field staying hidden would then prove nothing about `act`.
    const { hud: h, root } = mountDev();
    await openSelfTestLoaded(root);
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

  it('the KEYBOARD is untouched: Tab order and Enter still reach Copy Report', async () => {
    // The suppression is on `act`, which only the gamepad poller calls. A guard placed on
    // the pane's own key handling instead would take the keyboard with it and leave the
    // report uncopyable.
    const { root } = mountDev();
    await openSelfTestLoaded(root);
    const copy = q<HTMLButtonElement>(root, '.hud-selftest-copy');
    copy.focus();
    copy.click();
    expect(shown(q(root, '.hud-selftest-report'))).toBe(true);
  });
});

describe('the copyable report (issue #599)', () => {
  it('fills the field from the LAST frame pushed, reveals it, and selects it', async () => {
    // Selection is the path that always works: the async Clipboard API is origin- and
    // permission-gated and absent here, so a Copy that only called it would do nothing at
    // all on an insecure context.
    const { hud: h, root } = mountDev();
    await openSelfTestLoaded(root);
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

  it('empties the field on close, so a second visit never presents a stale snapshot', async () => {
    // The report is pad state from whenever Copy was last pressed. Retained across a visit
    // it would be indistinguishable from a fresh reading of hardware that has since been
    // unplugged -- the worst possible thing to paste into a compatibility issue.
    const { hud: h, root } = mountDev();
    await openSelfTestLoaded(root);
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

describe('the self-test body loads when its pane first opens (issue #1013)', () => {
  // `controller-selftest.ts` is loaded by a dynamic import on the pane's first open, so an
  // ordinary page never downloads it. These cases pin what that must not change: nothing is
  // built before an open, the open builds the body once, a frame or a Copy that arrives
  // during the load is handled, and a close or teardown during the load builds nothing. The
  // module adds no listener of its own, so "no listener behind" is "no body built".
  const list = (root: HTMLElement): HTMLElement => q(root, '.hud-selftest-list');

  it('an ordinary page builds no body, even after every import has settled', async () => {
    // Negative control: building the body at construction, as before #1013, leaves the empty
    // state and the pad list here. Settled FIRST, so a build deferred past construction by a
    // tick is caught too.
    const root = document.createElement('div');
    document.body.appendChild(root);
    hud = createHud(root, {});
    hud.setState('main-menu');
    await settled();
    expect(list(root).childElementCount).toBe(0);
  });

  it('a developer page builds no body until the pane opens', async () => {
    // Same negative control as the ordinary page: the developer entry is not what loads it.
    const { root } = mountDev();
    q<HTMLButtonElement>(root, '.hud-devtools-open').click();
    await settled();
    expect(list(root).childElementCount).toBe(0);
  });

  it('THE CONTROL: the open loads the body, the empty state and the pad list, once it lands', async () => {
    // Without this, the absences above could pass because the body is never built at all.
    // Negative control: an open that does not start the load.
    const { root } = mountDev();
    openSelfTest(root);
    expect(list(root).childElementCount, 'the body is loaded, not built in the open itself').toBe(0);
    await settled();
    expect(Array.from(list(root).children).map((c) => c.className)).toEqual([
      'hud-selftest-empty',
      'hud-selftest-pads',
    ]);
  });

  it('paints the LATEST frame pushed before the body loaded', async () => {
    // `route-ui.ts` pushes one frame synchronously on open, before any import can land, and
    // then one per animation frame. Negative controls: a push before the body exists that is
    // dropped, one that is held but never painted, and one that keeps the FIRST frame held.
    const { hud: h, root } = mountDev();
    openSelfTest(root);
    h.setPadDiagnostics([pad({ id: 'Old Frame' })]);
    h.setPadDiagnostics([pad({ id: 'Newest Frame' })]);
    await settled();
    const names = Array.from(root.querySelectorAll('.hud-selftest-pad-name')).map((n) => n.textContent);
    expect(names).toEqual(['Index 0 — Newest Frame']);
  });

  it('Copy pressed before the body loaded throws nothing and writes nothing', async () => {
    // jsdom reports a throw from a click listener as a window `error` event, not as a throw
    // from `click()`, so the event is what is listened for: `expect(click).not.toThrow()`
    // would pass with the throw in place. Negative control: Copy with no guard for a body
    // that does not exist yet.
    const { root } = mountDev();
    openSelfTest(root);
    const report = q<HTMLTextAreaElement>(root, '.hud-selftest-report');
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      errors.push(e.error);
      e.preventDefault();
    };
    window.addEventListener('error', onError);
    try {
      q<HTMLButtonElement>(root, '.hud-selftest-copy').click();
    } finally {
      window.removeEventListener('error', onError);
    }
    expect(errors).toEqual([]);
    expect(shown(report)).toBe(false);
    expect(report.value).toBe('');
    // The same press once the body is there does write, so the absence above is the load's.
    await settled();
    q<HTMLButtonElement>(root, '.hud-selftest-copy').click();
    expect(shown(report)).toBe(true);
  });

  it('a close during the load builds no body into the closed pane', async () => {
    // Negative controls: the resolved load ignoring the generation, and a close that does not
    // spend one.
    const { hud: h, root } = mountDev();
    openSelfTest(root);
    h.back();
    await settled();
    expect(list(root).childElementCount).toBe(0);
  });

  it('a close and reopen during the load builds the body once, for the reopen', async () => {
    // The superseded load and the reopen's both land; only the second may build. Negative
    // control: the resolved load ignoring the generation, which builds two bodies side by side.
    const { hud: h, root } = mountDev();
    openSelfTest(root);
    h.back();
    openSelfTest(root);
    await settled();
    expect(list(root).querySelectorAll('.hud-selftest-pads')).toHaveLength(1);
    expect(list(root).childElementCount).toBe(2);
  });

  it('a teardown during the load builds nothing into the discarded tree', async () => {
    // `dispose` never runs the pane's close. Negative control: a teardown that does not spend
    // the generation itself.
    const { hud: h, root } = mountDev();
    openSelfTest(root);
    const discarded = list(root);
    h.dispose();
    hud = null;
    await settled();
    expect(discarded.childElementCount).toBe(0);
  });

  it('builds the body once: a second visit keeps the same rows', async () => {
    // As before #1013, when it was built once at construction. A rebuild per open would throw
    // away the rows and repaint the empty state over a pad that is connected. Negative
    // control: an open that loads and builds whether or not a body exists.
    const { hud: h, root } = mountDev();
    await openSelfTestLoaded(root);
    h.setPadDiagnostics([pad()]);
    const pads = q(root, '.hud-selftest-pads');
    const row = q(root, '.hud-selftest-pad');
    h.back();
    openSelfTest(root);
    await settled();
    expect(q(root, '.hud-selftest-pads')).toBe(pads);
    expect(q(root, '.hud-selftest-pad')).toBe(row);
  });

  describe('a load that fails', () => {
    // The module made to fail as a stale chunk name or a dropped connection would. Mocked
    // per case and restored after, so no other case loads a failing module.
    afterEach(() => {
      vi.doUnmock('./controller-selftest');
      vi.resetModules();
    });
    function failLoads(): void {
      vi.doMock('./controller-selftest', () => {
        throw new Error('offline');
      });
      vi.resetModules();
    }

    it('is reported in the pane, and the next open builds the body in its place', async () => {
      // Negative controls: no rejection handler (the failure is an unhandled rejection and the
      // pane stays blank), and a retry that leaves the old failure line beside the new body.
      const { hud: h, root } = mountDev();
      failLoads();
      openSelfTest(root);
      await settled();
      expect(Array.from(list(root).children).map((c) => c.className)).toEqual([
        'hud-selftest-line hud-selftest-failed',
      ]);
      expect(q(root, '.hud-selftest-failed').textContent).toContain('could not be loaded');
      vi.doUnmock('./controller-selftest');
      vi.resetModules();
      h.back();
      openSelfTest(root);
      await settled();
      expect(Array.from(list(root).children).map((c) => c.className)).toEqual([
        'hud-selftest-empty',
        'hud-selftest-pads',
      ]);
    });

    it('after the pane closed reports nothing into it', async () => {
      // Negative control: the failure path ignoring the generation.
      const { hud: h, root } = mountDev();
      failLoads();
      openSelfTest(root);
      h.back();
      await settled();
      expect(list(root).childElementCount).toBe(0);
    });
  });
});
