// @vitest-environment jsdom
import { defaultSlots } from './versus-setup';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type Hud, type HudOptions } from './hud';
import { browserHistoryHost, type HistoryHost } from './navigation';
import { isPauseHotkey } from './loop';
import type { VersusConfig } from './versus-config';
import { createVersusSetupStore } from './versus-setup-store';
import { createMemoryStorage } from './storage';
import { installComputedStyleCache } from './computed-style-cache';

/**
 * The HUD's layer stack (issue #318): the replace-run question it opens over the menu (issue
 * #226), Back, Escape and the browser's history out of a layer, the semantic action dispatcher
 * (issue #494), and the modal isolation of a blocking overlay (issue #327).
 *
 * WHY THE REST OF THIS FILE MOVED OUT (issue #1093). A mutation entry runs its scoped test files
 * whole, and the harness kills a run at 180s (`SUBPROCESS_TIMEOUT_MS`, `tools/mutate/run.mjs`).
 * This file held 150 tests under 16 describes, and 115 entries ran all of them, though most are
 * killed by tests in one describe. The other describes are now `hud.versus-setup`, `hud.roving`,
 * `hud.relaunch`, `hud.ui-kit`, `hud.developer-mode` and `hud.arrival` (`.test.ts` each), and
 * each entry is scoped to the files its killers are in.
 */

// Keeps `display` across focus moves, which jsdom 30.1.2 recomputes (issue #1093).
installComputedStyleCache();

let hud: Hud | null = null;

function mount(opts: HudOptions = {}): { hud: Hud; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  hud = createHud(root, opts);
  return { hud, root };
}

afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

/*
 * ISSUE #226: the replace-run confirmation.
 *
 * Here rather than with the menu composition it belongs to, because every property it has
 * is a layer-stack property: it is this file's first `overlay`, a route may not open
 * under it, Back cancels it, a surface change dismisses it, and answering it has to
 * restore the control that asked.
 */
describe('hud: the replace-run confirmation (issue #226)', () => {
  const q = (root: HTMLElement, sel: string): HTMLButtonElement =>
    root.querySelector(sel) as HTMLButtonElement;
  const click = (root: HTMLElement, sel: string): void => {
    q(root, sel).dispatchEvent(new MouseEvent('click'));
  };
  const confirmOpen = (root: HTMLElement): boolean =>
    !(root.querySelector('.hud-confirm') as HTMLElement).classList.contains('hud-confirm--hidden');

  it('is announced as a modal, and earns that claim: focus cannot rove out of it into the menu behind', () => {
    // `aria-modal="true"` is a promise that nothing outside this is reachable while it is
    // open, so it is asserted TOGETHER with the behaviour that makes it true rather than
    // on its own. The menu stays on screen behind the scrim -- that is what a modal IS --
    // so the load-bearing property is that the roving focus walks the confirmation's own
    // controls and never lands on a menu button. Asserted through the arrow keys, which
    // is the same path a D-pad takes (issues #494, #495).
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      const confirm = root.querySelector('.hud-confirm') as HTMLElement;
      expect(confirm.getAttribute('role')).toBe('alertdialog');
      expect(confirm.getAttribute('aria-modal')).toBe('true');

      h.setContinueAvailable(true); // only a run that would be LOST is worth asking about
      click(root, '.hud-new-game');
      vi.advanceTimersByTime(1000); // let the crossfade finish, so nothing is mid-transition
      expect(confirmOpen(root), 'the confirmation did not open').toBe(true);

      const inside = [...confirm.querySelectorAll('button')];
      expect(inside.map((b) => b.className.includes('hud-confirm-cancel') || b.className.includes('hud-confirm-accept')))
        .toEqual([true, true]);
      for (let i = 0; i < 6; i++) {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
        );
        expect(confirm.contains(document.activeElement), `step ${i} left the confirmation`).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('is asked only when an active run would be lost', () => {
    // The acceptance criterion, both ways round. With no run the same button is "Start
    // Campaign" and starting is not destructive, so a confirmation there would be
    // friction with nothing to protect.
    const { hud: h, root } = mount();
    const starts: number[] = [];
    h.onNewGame(() => starts.push(1));
    h.setState('main-menu');

    click(root, '.hud-new-game');
    expect(confirmOpen(root), 'no run, and it still asked').toBe(false);
    expect(starts, 'the direct path did not start a campaign').toEqual([1]);

    h.setContinueAvailable(true);
    click(root, '.hud-new-game');
    expect(confirmOpen(root), 'a run would be replaced and it did not ask').toBe(true);
    expect(starts, 'opening the question already started the campaign').toEqual([1]);
  });

  it('names the run it would replace', () => {
    // "Are you sure?" over an unnamed loss is the wording that gets clicked through. The
    // body is written at OPEN, from the summary the menu is already showing, so it cannot
    // describe a run the player is not looking at.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.setContinueAvailable(true);
    h.setCampaignRun({ mission: 4, lives: 1 });
    click(root, '.hud-new-game');
    const body = root.querySelector('.hud-confirm-body') as HTMLElement;
    expect(body.textContent).toBe(
      'Mission 4 -- 1 life left. Starting a new campaign replaces it. This cannot be undone.',
    );
  });

  it('Cancel starts nothing and returns to the menu; Confirm starts exactly one campaign', () => {
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      const starts: number[] = [];
      h.onNewGame(() => starts.push(1));
      h.setState('main-menu');
      h.setContinueAvailable(true);

      click(root, '.hud-new-game');
      click(root, '.hud-confirm-cancel');
      vi.advanceTimersByTime(1000);
      expect(starts, 'Cancel started a campaign').toEqual([]);
      expect(confirmOpen(root), 'Cancel left the question up').toBe(false);
      expect(
        (root.querySelector('.hud-panel') as HTMLElement).classList.contains('hud-panel--hidden'),
        'Cancel did not return to the menu',
      ).toBe(false);
      // ...and focus is back on the control that asked, so a keyboard player who cancels
      // is standing where they were rather than at the top of the panel.
      expect(document.activeElement).toBe(q(root, '.hud-new-game'));

      click(root, '.hud-new-game');
      click(root, '.hud-confirm-accept');
      vi.advanceTimersByTime(1000);
      expect(starts, 'Confirm did not start exactly one campaign').toEqual([1]);
      expect(confirmOpen(root), 'Confirm left the question up').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a BLOCKING layer: no route opens under an unanswered question', () => {
    // The one structural difference between an overlay and a route (`navigation.ts`):
    // a route may never be pushed over an overlay. Without it a menu button reached by
    // the keyboard behind the confirmation would open a pane UNDER it, and the Back that
    // dismissed the question would land on a screen the player never asked for.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.setContinueAvailable(true);
    click(root, '.hud-new-game');
    expect(confirmOpen(root)).toBe(true);

    click(root, '.hud-records-open');
    expect(
      (root.querySelector('.hud-stats') as HTMLElement).classList.contains('hud-stats--hidden'),
      'a route opened under the confirmation',
    ).toBe(true);
    expect(confirmOpen(root), 'the confirmation was replaced by a route').toBe(true);

    // NEGATIVE CONTROL: the same click with no question up really does open the pane, so
    // the assertion above is about the overlay and not about a broken Records button.
    expect(h.back()).toBe(true);
    click(root, '.hud-records-open');
    expect(
      (root.querySelector('.hud-stats') as HTMLElement).classList.contains('hud-stats--hidden'),
    ).toBe(false);
  });

  it('Back cancels it, and a surface change dismisses it rather than letting it outlive the menu', () => {
    const { hud: h, root } = mount();
    const starts: number[] = [];
    h.onNewGame(() => starts.push(1));
    h.setState('main-menu');
    h.setContinueAvailable(true);

    click(root, '.hud-new-game');
    expect(h.back(), 'Back did not consume the confirmation').toBe(true);
    expect(starts, 'Back answered the question').toEqual([]);

    click(root, '.hud-new-game');
    h.setState('playing');
    expect(confirmOpen(root), 'the question survived a surface change').toBe(false);
    expect(h.back(), 'the confirmation was left on the layer stack').toBe(false);
    expect(starts, 'a surface change answered the question').toEqual([]);
  });

  it('arrives on the safe answer, so a blind Confirm keeps the run (issue #919)', () => {
    // RE-ARGUED for #919. `act('confirm')` used to land focus on the first control of a
    // freshly arrived pane rather than activate it, so the first control was what a hurried
    // player reached and the destructive answer was put second. The arrival now lands on
    // the dialog's declared primary action, which is that SAFE answer, so one blind Confirm
    // activates Keep playing: the question closes and the run survives.
    //
    // The ORDER still matters after #919: focus that escapes the dialog is parked on its
    // CONTAINER by the modal trap (`onModalFocusIn`), and a Confirm there lands on the first
    // control. With the destructive answer first, that Confirm would put focus on it and the
    // next would replace the run.
    const { hud: h, root } = mount();
    const starts: number[] = [];
    h.onNewGame(() => starts.push(1));
    h.setState('main-menu');
    h.setContinueAvailable(true);
    click(root, '.hud-new-game');

    expect(document.activeElement, 'the arrival did not land on the safe answer').toBe(
      q(root, '.hud-confirm-cancel'),
    );
    // Focus escapes to the page behind, and the trap parks it on the dialog itself.
    q(root, '.hud-new-game').focus();
    expect(document.activeElement, 'the trap did not park escaped focus on the dialog').toBe(
      q(root, '.hud-confirm'),
    );
    expect(h.act('confirm'), 'the dialog did not take Confirm on its container').toBe(true);
    expect(document.activeElement, 'Confirm on the dialog container did not land on the safe answer').toBe(
      q(root, '.hud-confirm-cancel'),
    );
    expect(starts, 'Confirm on the dialog container replaced the run').toEqual([]);
    expect(h.act('confirm'), 'the pane did not take the action').toBe(true);
    expect(starts, 'a single blind Confirm replaced the run').toEqual([]);
    // Answered, not merely ignored: the question is off the stack and focus is back on the
    // button that asked it.
    expect(document.activeElement, 'Keep playing did not return to the button that asked').toBe(
      q(root, '.hud-new-game'),
    );
    expect(h.back(), 'a blind Confirm on the safe answer left the question open').toBe(false);
  });
});

describe('hud: navigation layers -- origin, Back and focus restoration (issue #318)', () => {
  const click = (el: Element, detail = 0): void => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
  };
  const q = (root: HTMLElement, sel: string): HTMLElement => root.querySelector(sel) as HTMLElement;
  const isHidden = (root: HTMLElement, sel: string, cls: string): boolean => q(root, sel).classList.contains(cls);
  const cfg = (players: 2 | 3 | 4): VersusConfig => ({
    mode: 'ffa',
    players,
    arenaId: 'arena-02',
    stock: 3,
    friendlyFire: false,
    slots: defaultSlots(players),
  });
  function mountWith(opts: Parameters<typeof createHud>[1]): { hud: Hud; root: HTMLElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    hud = createHud(root, opts);
    return { hud, root };
  }

  it('Controllers opened from PAUSED returns to paused, focuses the Controllers button, and the narrowed pause hotkey accepts that target', () => {
    // The one Back that could never hard-code its destination is now the ordinary case:
    // the layer records the surface it was pushed over. And the control it returns focus
    // to is a BUTTON, which is only a working place to leave a paused player because
    // loop.ts's guard no longer treats a button as a control that consumes Escape.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      h.setState('playing');
      h.setState('paused');
      const opener = q(root, '.hud-controllers-open');
      click(opener);
      expect(isHidden(root, '.hud-controllers', 'hud-controllers--hidden')).toBe(false);
      expect(document.activeElement, 'opening focuses the pane container').toBe(q(root, '.hud-controllers'));
      click(q(root, '.hud-controllers-back'));
      vi.advanceTimersByTime(1000);
      expect(isHidden(root, '.hud-controllers', 'hud-controllers--hidden')).toBe(true);
      expect(q(root, '.hud-action').textContent, 'Back abandoned the paused round').toBe('Resume');
      expect(document.activeElement, 'Back did not return focus to the Controllers button').toBe(opener);
      const escape = { key: 'Escape', repeat: false, target: opener } as unknown as KeyboardEvent;
      expect(isPauseHotkey(escape), 'Escape is dead on the restored opener').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pane opened programmatically (showVersusSetup(true) at the title) falls back to the menu\'s own arrival on Back', () => {
    // The post-match "Versus Setup" reopen (loop.ts) invokes no control, so there is
    // nothing to restore focus to: the destination's own arrival stands -- its primary
    // action since issue #919, Start Campaign here with no run. Kills an unguarded
    // `opener.focus()` -- a null opener would throw there.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(document.activeElement).toBe(q(root, '.hud-versus-start'));
    click(q(root, '.hud-versus-back'));
    expect(document.activeElement).toBe(q(root, '.hud-new-game'));
  });

  it('Back falls back to the menu\'s own arrival when the opener was hidden while the pane was up', () => {
    // `setLevelSelect(1, 1)` hides the Levels button ("the sandbox is not a choice") and
    // can land while the Levels pane is open. Focusing a hidden button would strand a
    // keyboard player with no visible position, so the destination's own arrival stands:
    // its primary action since issue #919, Start Campaign here with no run.
    const { hud: h, root } = mount();
    h.setLevelSelect(2, 3);
    h.setState('main-menu');
    const opener = q(root, '.hud-levelselect-open');
    expect(opener.classList.contains('hud-levelselect-open--hidden')).toBe(false);
    click(opener);
    h.setLevelSelect(1, 1);
    click(q(root, '.hud-levelselect-back'));
    expect(opener.classList.contains('hud-levelselect-open--hidden'), 'the fixture no longer hides the opener').toBe(true);
    expect(document.activeElement).toBe(q(root, '.hud-new-game'));
  });

  it('hud.back() pops one layer and reports true; with nothing open it reports false and changes no class', () => {
    // The controller seam (issue #319 maps gamepad B here). `false` is what lets the
    // caller fall through to its own Back meaning, so a `back()` that reported true
    // with nothing open would swallow every gamepad Back at the Main Menu.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const surfaces = ['.hud-panel', '.hud-stats', '.hud-customize', '.hud-achievements',
      '.hud-levelselect', '.hud-controllers', '.hud-versus-setup', '.hud-settings',
      '.hud-about', '.hud-confirm'];
    const snapshot = (): string[] => surfaces.map((sel) => q(root, sel).className);
    const before = snapshot();
    expect(h.back()).toBe(false);
    expect(snapshot()).toEqual(before);
    const opener = q(root, '.hud-records-open');
    click(opener);
    expect(h.back()).toBe(true);
    expect(q(root, '.hud-stats').classList.contains('ui-surface--leaving'), 'the pane is not on its way out').toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('a pointer-initiated Back click still lands focus on the opener', () => {
    // `blurIfPointer` blurs the clicked BACK button after its handler; the restore has
    // already moved focus to the opener by then, so it survives. The spec names the
    // invoking control without a modality.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const opener = q(root, '.hud-about-open');
    click(opener, 1);
    click(q(root, '.hud-about-back'), 1);
    expect(document.activeElement).toBe(opener);
  });

  it('entering gameplay from an open pane empties the stack: hud.back() then has nothing to pop', () => {
    // Every surface change resets the stack, so a layer can never outlive the surface it
    // opened over -- a ghost layer here would swallow the first Escape of the match.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    click(q(root, '.hud-records-open'));
    expect(h.back(), 'the pane did not open').toBe(true);
    click(q(root, '.hud-records-open'));
    h.setState('playing');
    expect(isHidden(root, '.hud-stats', 'hud-stats--hidden')).toBe(true);
    expect(h.back(), 'gameplay entry left a layer on the stack').toBe(false);
  });

  it('Back fires no start, pick, reset, quit, pause, setup or open callback, leaves no reset armed, and writes nothing to the retained VS store', () => {
    // The HUD-level proof of "Back never resets a run or changes persisted settings":
    // hud.ts reaches no store, run or state machine itself, so what it must not do is
    // fire the callbacks through which the page does. Population: all six Back buttons
    // and `hud.back()`. The two negative controls at the end prove the spies and the
    // store counter are live.
    const storage = createMemoryStorage();
    const real = createVersusSetupStore(storage);
    let writes = 0;
    const { hud: h, root } = mountWith({
      versusSetup: {
        get: () => real.get(),
        set: (setup) => {
          writes += 1;
          real.set(setup);
        },
        clear: () => real.clear(),
      },
    });
    const fired: string[] = [];
    h.onStartRestart(() => fired.push('start'));
    h.onNewGame(() => fired.push('new-game'));
    h.onLevelSelect((level) => fired.push(`pick:${level}`));
    h.onResetStats(() => fired.push('reset-stats'));
    h.onResetProgress(() => fired.push('reset-progress'));
    h.onQuitToTitle(() => fired.push('quit'));
    h.onPauseTap(() => fired.push('pause'));
    h.onVersusStart(() => fired.push('versus-start'));
    h.onVersusOpen(() => fired.push('versus-open'));
    h.onCampaignOpen(() => fired.push('campaign-open'));
    h.setLevelSelect(3, 3);
    h.setState('main-menu');
    // Population: every pane with an opener and a Back button. Achievements is reached
    // through the Records tab inside the Stats pane since issue #226, and Controllers
    // through Settings -> Controls, which is why those two rows name an opener that lives
    // inside another pane rather than on the menu.
    const pairs: Array<[string, string]> = [
      ['.hud-records-open', '.hud-stats-back'],
      ['.hud-customize-open', '.hud-customize-back'],
      ['.hud-stats .hud-records-tab-achievements', '.hud-achievements-back'],
      ['.hud-levelselect-open', '.hud-levelselect-back'],
      ['.hud-settings-open', '.hud-settings-back'],
      ['.hud-settings-controllers', '.hud-controllers-back'],
      ['.hud-about-open', '.hud-about-back'],
    ];
    for (const [open, back] of pairs) {
      click(q(root, open));
      click(q(root, back));
    }
    h.showVersusSetup(true); // the sixth pane, opened without its passthrough button
    click(q(root, '.hud-versus-back'));
    h.showVersusSetup(true);
    expect(h.back()).toBe(true);
    expect(fired).toEqual([]);
    expect(writes).toBe(0);
    expect(root.querySelector('.hud-danger--armed')).toBeNull();
    // Negative controls: a role click writes once, Start fires once.
    h.showVersusSetup(true);
    click(q(root, '.hud-versus-slot-row[data-slot="1"] .hud-versus-role-btn[data-role="bot"]'));
    expect(writes).toBe(1);
    click(q(root, '.hud-versus-start'));
    expect(fired).toEqual(['versus-start']);
  });

  it('showVersusSetup(true, cfg) twice keeps the pane open and reseeds from the second config', () => {
    // Before issue #318 the second call ran a transition from the pane to ITSELF, which
    // marked the one surface LEAVING then ENTERING and hid it when the crossfade
    // settled -- measured failing on the pre-#318 tree with exactly this case. The
    // stack reports the pane as already on top, and the HUD re-renders in place.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      h.showVersusSetup(true, cfg(2));
      h.showVersusSetup(true, cfg(4));
      vi.advanceTimersByTime(1000);
      expect(isHidden(root, '.hud-versus-setup', 'hud-versus-setup--hidden'), 'the second open hid the pane').toBe(false);
      expect(root.querySelectorAll('.hud-versus-slot-row'), 'the second config did not reseed the pane').toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a pane opened while a different pane is up replaces it through that pane's own close, so its close callback fires once", () => {
    // Covering Customize would leave its live preview alive with no close callback;
    // refusing would break the transition contract's "second navigation wins". Replacing
    // does neither: the covered pane leaves through the same path its Back uses.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      let opens = 0;
      let closes = 0;
      h.onCustomizeOpen(() => {
        opens += 1;
      });
      h.onCustomizeClose(() => {
        closes += 1;
      });
      h.setState('main-menu');
      click(q(root, '.hud-customize-open'));
      expect(opens).toBe(1);
      h.showVersusSetup(true);
      vi.advanceTimersByTime(1000);
      expect(closes, "the covered pane's close callback").toBe(1);
      expect(isHidden(root, '.hud-customize', 'hud-customize--hidden')).toBe(true);
      expect(isHidden(root, '.hud-versus-setup', 'hud-versus-setup--hidden')).toBe(false);
      // ...and the replacement kept the ORIGINAL origin: Back lands on the title.
      click(q(root, '.hud-versus-back'));
      vi.advanceTimersByTime(1000);
      expect(isHidden(root, '.hud-versus-setup', 'hud-versus-setup--hidden')).toBe(true);
      expect(isHidden(root, '.hud-panel', 'hud-panel--hidden')).toBe(false);
      expect(closes, 'a second close fired for a pane that was already closed').toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hud: Escape is Back while a layer is open (issue #318)', () => {
  const click = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  };
  const q = (root: HTMLElement, sel: string): HTMLElement => root.querySelector(sel) as HTMLElement;
  /** A key pressed where the browser would deliver it: at the focused element, bubbling. */
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  };

  it('Escape closes the top pane, restores the opener, and never reaches a bubble-phase window listener; with no pane it reaches it and changes no surface', () => {
    // The bubble-phase window listener stands in for route-host's `onHostKey`, which
    // forwards to the session's pause hotkey. An Escape that closed a pane and ALSO
    // reached it would resume a paused round underneath the pane it just closed.
    const seen: string[] = [];
    const bubble = (e: KeyboardEvent): void => {
      seen.push(e.key);
    };
    window.addEventListener('keydown', bubble);
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      const opener = q(root, '.hud-customize-open');
      click(opener);
      expect(document.activeElement).toBe(q(root, '.hud-customize'));
      press('Escape', { repeat: true });
      expect(q(root, '.hud-customize').classList.contains('ui-surface--leaving'), 'an auto-repeat Escape was claimed').toBe(false);
      expect(seen, 'the repeat should fall through').toEqual(['Escape']);
      press('Escape');
      expect(q(root, '.hud-customize').classList.contains('ui-surface--leaving'), 'Escape did not close the pane').toBe(true);
      expect(document.activeElement, 'Escape did not restore the opener').toBe(opener);
      expect(seen, 'the Escape that closed a pane leaked to the bubble listener').toEqual(['Escape']);
      press('Escape');
      expect(seen, 'Escape with nothing to close must fall through').toEqual(['Escape', 'Escape']);
      expect(q(root, '.hud-panel').classList.contains('hud-panel--hidden')).toBe(false);
      expect(h.back(), 'a second Escape popped something').toBe(false);
    } finally {
      window.removeEventListener('keydown', bubble);
    }
  });

  it('Escape with Controllers open over Pause returns to Pause and fires onControllersClose exactly once; a second Escape is not consumed', () => {
    // The spec's "from Pause with no deeper overlay, resume": the first Escape consumes
    // the layer, the second is the session's. Both halves through one chokepoint, so
    // the close callback (route-ui's gamepad listeners) fires once, not twice and not
    // never.
    vi.useFakeTimers();
    const seen: string[] = [];
    const bubble = (e: KeyboardEvent): void => {
      seen.push(e.key);
    };
    window.addEventListener('keydown', bubble);
    try {
      const { hud: h, root } = mount();
      let closes = 0;
      h.onControllersClose(() => {
        closes += 1;
      });
      h.setState('main-menu');
      h.setState('playing');
      h.setState('paused');
      const opener = q(root, '.hud-controllers-open');
      click(opener);
      press('Escape');
      vi.advanceTimersByTime(1000);
      expect(q(root, '.hud-controllers').classList.contains('hud-controllers--hidden')).toBe(true);
      expect(q(root, '.hud-action').textContent, 'Escape abandoned the paused round').toBe('Resume');
      expect(document.activeElement).toBe(opener);
      expect(closes).toBe(1);
      expect(seen).toEqual([]);
      press('Escape');
      expect(seen, 'the second Escape is the session\'s').toEqual(['Escape']);
      expect(closes).toBe(1);
      expect(q(root, '.hud-action').textContent).toBe('Resume');
    } finally {
      window.removeEventListener('keydown', bubble);
      vi.useRealTimers();
    }
  });
});

describe('hud: the browser-history mirror (issue #318)', () => {
  const click = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  };
  const q = (root: HTMLElement, sel: string): HTMLElement => root.querySelector(sel) as HTMLElement;

  /** A host whose `back()` lands synchronously, so the test needs no timers. */
  function fakeHost(): HistoryHost & { calls: string[]; pop: (state: unknown) => void } {
    const calls: string[] = [];
    let listener: ((state: unknown) => void) | null = null;
    let state: unknown = null;
    return {
      calls,
      get state() {
        return state;
      },
      pushState(next) {
        calls.push('push');
        state = next;
      },
      replaceState(next) {
        calls.push('replace');
        state = next;
      },
      back() {
        calls.push('back');
        state = null;
        listener?.(null);
      },
      onPopState(cb) {
        listener = cb;
        return () => {
          listener = null;
        };
      },
      pop(next) {
        listener?.(next);
      },
    };
  }

  it('opening a pane pushes one entry, Back retires it with one back(), and a browser Back closes the pane through its own chokepoint', () => {
    // Kills a HUD that never syncs the mirror: the pane would open with no history
    // entry, so the browser's Back would leave the page with a pane still up.
    const host = fakeHost();
    const root = document.createElement('div');
    document.body.appendChild(root);
    hud = createHud(root, { history: host });
    const h = hud;
    let closes = 0;
    h.onCustomizeClose(() => {
      closes += 1;
    });
    h.setState('main-menu');
    expect(host.calls, 'the mirror pushed with nothing open').toEqual([]);
    const opener = q(root, '.hud-customize-open');
    click(opener);
    expect(host.calls).toEqual(['push']);
    click(q(root, '.hud-customize-back'));
    expect(host.calls, 'Back must retire the entry with exactly one back()').toEqual(['push', 'back']);
    expect(closes).toBe(1);

    // The browser's own Back: the host lands on the base entry and reports it.
    click(opener);
    expect(host.calls).toEqual(['push', 'back', 'push']);
    host.pop(null);
    expect(q(root, '.hud-customize').classList.contains('ui-surface--leaving'), 'the browser Back did not close the pane').toBe(true);
    expect(closes, 'the close callback must fire once for a browser Back too').toBe(2);
    expect(document.activeElement).toBe(opener);
    expect(host.calls, 'a browser Back that emptied the stack must traverse nothing itself').toEqual(['push', 'back', 'push']);
    expect(h.back()).toBe(false);
  });

  it('a real jsdom history: the browser\'s Back closes the open pane and restores its opener, and location.search survives', async () => {
    // Through `browserHistoryHost(window)`, the adapter production wires. jsdom fires
    // popstate asynchronously after two chained tasks, hence the two awaited turns.
    // `?dev=1` selects developer mode and the storage namespace, so the entry the mirror
    // pushes must never carry a URL of its own.
    const before = window.location.href;
    window.history.replaceState(null, '', `${window.location.pathname}?dev=1#top`);
    try {
      const root = document.createElement('div');
      document.body.appendChild(root);
      hud = createHud(root, { history: browserHistoryHost(window) });
      const h = hud;
      h.setState('main-menu');
      const opener = q(root, '.hud-records-open');
      click(opener);
      expect(window.history.state).toEqual({ tanks: 'layer' });
      expect(window.location.search).toBe('?dev=1');
      expect(window.location.hash).toBe('#top');
      window.history.back();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(q(root, '.hud-stats').classList.contains('ui-surface--leaving'), 'the browser Back did not close the pane').toBe(true);
      expect(document.activeElement).toBe(opener);
      expect(window.history.state).toBeNull();
      expect(window.location.search).toBe('?dev=1');
      expect(h.back()).toBe(false);
    } finally {
      window.history.replaceState(null, '', before);
    }
  });
});

describe('hud: the semantic action dispatcher (issue #494)', () => {
  const q = (root: HTMLElement, sel: string): HTMLElement => root.querySelector(sel) as HTMLElement;
  const click = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  };
  /** A key pressed where the browser would deliver it: at the focused element, bubbling. */
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  };
  const controls = (root: HTMLElement, sel: string): HTMLElement[] =>
    Array.from(q(root, sel).querySelectorAll<HTMLElement>('button, [tabindex]')).filter(
      (el) => !(el instanceof HTMLButtonElement && el.disabled) && getComputedStyle(el).display !== 'none',
    );

  it('a direction walks the active panel like the arrows do, and reports unconsumed with nothing shown', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const panelControls = controls(root, '.hud-panel');
    expect(panelControls.length, 'the Main Menu has controls to walk').toBeGreaterThan(2);
    // The arrival is on Start Campaign (issue #919), the first control of a menu with no run,
    // so the walk starts at index 0 rather than entering from the container.
    expect(document.activeElement, 'the walk does not start where this case assumes').toBe(panelControls[0]);
    expect(panelControls[0]).toBe(q(root, '.hud-new-game'));
    expect(h.act('down')).toBe(true);
    expect(document.activeElement).toBe(panelControls[1]);
    expect(h.act('down')).toBe(true);
    expect(document.activeElement).toBe(panelControls[2]);
    expect(h.act('up')).toBe(true);
    expect(document.activeElement).toBe(panelControls[1]);
    expect(h.act('up')).toBe(true);
    expect(document.activeElement).toBe(panelControls[0]);
    expect(h.act('left'), 'Left walks backwards').toBe(true);
    expect(document.activeElement, 'Left did not wrap to the last control').toBe(panelControls[panelControls.length - 1]);
    expect(h.act('right')).toBe(true);
    expect(document.activeElement).toBe(panelControls[0]);
    h.setState('playing');
    const before = document.activeElement;
    expect(h.act('down'), 'a direction with nothing shown was consumed').toBe(false);
    expect(document.activeElement).toBe(before);
  });

  it('confirm on a focused container lands on the first control instead of activating it; confirm on the arrival\'s primary activates it once', () => {
    // Issue #919's ruling, both halves, on one Main Menu with no run. Confirm on a CONTAINER
    // stays inert: it lands focus on the first control and fires nothing -- which is how a
    // pane with no primary action, or focus that has fallen to a container, keeps a gamepad
    // from firing whatever happens to be first (New Game, here). A surface with a primary
    // action arrives with it focused, so there one Confirm activates it. Each half is the
    // other's negative control: the same verb, from the two places focus can rest.
    const { hud: h, root } = mount();
    let newGames = 0;
    h.onNewGame(() => {
      newGames += 1;
    });
    h.setState('main-menu');
    q(root, '.hud-panel').focus();
    expect(h.act('confirm')).toBe(true);
    expect(document.activeElement, 'confirm on the container did not land on the first control').toBe(
      controls(root, '.hud-panel')[0],
    );
    expect(newGames, 'confirm on the container activated a control').toBe(0);

    h.setState('playing');
    h.setState('main-menu');
    expect(document.activeElement, 'the arrival did not land on Start Campaign').toBe(
      q(root, '.hud-new-game'),
    );
    expect(h.act('confirm')).toBe(true);
    expect(newGames, 'confirm on the arrival\'s primary did not activate it exactly once').toBe(1);
  });

  it('back pops the layer and reports whether it did; pause is never the HUD\'s', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    click(q(root, '.hud-customize-open'));
    expect(q(root, '.hud-customize').classList.contains('hud-customize--hidden')).toBe(false);
    expect(h.act('pause'), 'pause was consumed by the HUD').toBe(false);
    expect(q(root, '.hud-customize').classList.contains('hud-customize--hidden'), 'pause changed a surface').toBe(false);
    expect(h.act('back')).toBe(true);
    expect(q(root, '.hud-customize').classList.contains('ui-surface--leaving')).toBe(true);
    expect(document.activeElement).toBe(q(root, '.hud-customize-open'));
    expect(h.act('back'), 'back with nothing open was consumed').toBe(false);
  });

  it('Escape is Back with a volume slider focused, while ArrowDown stays with the slider (the consume model)', () => {
    // The product-visible half of issue #494's ruling: the slider consumes only the keys
    // that move it. ArrowDown is the negative control -- the same handler, a key the
    // slider DOES keep, so the roving focus must not take it.
    //
    // SETTINGS, where the slider lives (issue #226). This case opened Customize until the
    // jsdom 30.1.2 bump and focused the slider on the hidden Settings pane, which only an
    // older jsdom allowed; `focus()` now refuses an element that is not rendered, as
    // browsers do, and the precondition below is what caught it.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    click(q(root, '.hud-settings-open'));
    const slider = q(root, '.hud-settings-volume') as HTMLInputElement;
    slider.focus();
    expect(document.activeElement, 'precondition: focus did not land on the slider').toBe(slider);
    press('ArrowDown');
    expect(document.activeElement, 'the roving focus took an arrow the slider consumes').toBe(slider);
    press('Escape');
    expect(q(root, '.hud-settings').classList.contains('ui-surface--leaving'), 'Escape at a slider did not pop the layer').toBe(true);
  });

  it('focus survives a Controllers re-render: the same candidate when it still exists, the same row when it does not', () => {
    const { hud: h, root } = mount();
    h.setDetectedPads([{ padIndex: 3, id: 'Pad' }]);
    h.setControllers([{ kind: 'keyboard' }, { kind: 'none' }]);
    h.setState('main-menu');
    click(q(root, '.hud-controllers-open'));
    const row1 = (): HTMLElement => q(root, '.hud-controller-row[data-slot="1"]');
    const padBtn = row1().querySelector('[data-candidate="gamepad-3"]') as HTMLElement;
    expect(padBtn, 'the pad candidate is rendered').not.toBeNull();
    padBtn.focus();
    h.setDetectedPads([{ padIndex: 3, id: 'Pad' }]); // a hotplug event for the same pad: a full re-render
    expect(document.activeElement, 'focus fell off the re-rendered row').not.toBe(padBtn);
    expect(document.activeElement).toBe(row1().querySelector('[data-candidate="gamepad-3"]'));
    h.setDetectedPads([]); // the focused pad unplugs: its button is gone
    expect(row1().querySelector('[data-candidate="gamepad-3"]')).toBeNull();
    expect(document.activeElement, 'focus did not stay on the same row').toBe(row1().querySelector('button'));
    // Negative control: with focus outside the rows a re-render moves nothing.
    (document.activeElement as HTMLElement).blur();
    h.setDetectedPads([{ padIndex: 3, id: 'Pad' }]);
    expect(document.activeElement).toBe(document.body);
  });

  it('focus survives a Versus Setup re-render on the same role button of the same row', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    const rowBtn = (): HTMLElement | null =>
      root.querySelector('.hud-versus-slot-row[data-slot="1"] button[data-role="bot"]');
    const before = rowBtn();
    expect(before, 'the role button is rendered').not.toBeNull();
    before!.focus();
    h.setDetectedPads([{ padIndex: 0, id: 'Pad' }]); // a hotplug repaints every row
    expect(rowBtn(), 'the rows were not re-rendered').not.toBe(before);
    expect(document.activeElement).toBe(rowBtn());
  });
});

describe('modal isolation: a blocking overlay is really modal (issue #327)', () => {
  /**
   * THE DEFECT. The confirmation carries `role="alertdialog" aria-modal="true"`, which tells
   * assistive technology that everything outside it is unavailable. Nothing made that true:
   * MEASURED before this landed, `src/` contained no Tab handler, no focus containment and
   * no `inert` at all, so focus left the dialog into the panes behind it, the on-screen
   * driving controls, and -- with the gate on -- the DEV badge, every one of which is a
   * sibling of every pane on the HUD root.
   */
  function mountDev(opts: Parameters<typeof createHud>[1] = {}): { hud: Hud; root: HTMLElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    hud = createHud(root, opts);
    return { hud, root };
  }

  const click = (b: HTMLButtonElement): void => {
    b.dispatchEvent(new MouseEvent('click'));
  };

  const openConfirm = (h: Hud, root: HTMLElement): HTMLElement => {
    h.setState('main-menu');
    h.setContinueAvailable(true); // the confirmation appears only when there is a run to replace
    click(root.querySelector('.hud-new-game') as HTMLButtonElement);
    const dialog = root.querySelector('.hud-confirm') as HTMLElement;
    expect(dialog.classList.contains('hud-confirm--hidden'), 'it did not open').toBe(false);
    return dialog;
  };

  /** Every focusable control that is NOT inside the given container, by inert-ancestor. */
  const reachableOutside = (root: HTMLElement, container: HTMLElement): string[] =>
    Array.from(root.querySelectorAll<HTMLElement>('button, [tabindex], input, select, textarea'))
      .filter((c) => !container.contains(c))
      .filter((c) => c.closest('[inert]') === null)
      .map((c) => Array.from(c.classList).find((x) => x.startsWith('hud-')) ?? c.tagName);

  it('isolates everything outside the dialog, including the DEV badge', () => {
    const { hud: h, root } = mountDev({ developerMode: true });
    const dialog = openConfirm(h, root);
    // The badge is called out because it is the newest sibling of every pane (issue #243)
    // and would otherwise be the easiest place for focus to escape to.
    expect(reachableOutside(root, dialog), 'focus can still leave the dialog').toEqual([]);
    expect((root.querySelector('.hud-devbadge') as HTMLElement).closest('[inert]')).not.toBeNull();
  });

  it('leaves the live region announceable, which is why it is exempt', () => {
    // `inert` removes a subtree from the accessibility tree, so isolating the one
    // `aria-live` region would silence every announcement for as long as the dialog is up.
    // It holds nothing focusable, so exempting it costs no containment.
    const { hud: h, root } = mountDev();
    openConfirm(h, root);
    const toasts = root.querySelector('.hud-toasts') as HTMLElement;
    expect(toasts.hasAttribute('inert'), 'the live region must keep announcing').toBe(false);
    expect(toasts.getAttribute('aria-live')).toBe('polite');
  });

  it('pulls focus back when something lands outside the open dialog', () => {
    // The containment half: `inert` governs Tab and the accessibility tree, and this covers
    // focus that is already outside when the dialog opens, or moved programmatically.
    const { hud: h, root } = mountDev({ developerMode: true });
    const dialog = openConfirm(h, root);
    const outside = root.querySelector('.hud-devbadge') as HTMLButtonElement;
    outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(document.activeElement, 'focus was allowed to rest outside the dialog').toBe(dialog);
  });

  it('does NOT trap a route, because a full-screen destination is not a dialog', () => {
    // The line `navigation.ts` already draws: an overlay is the blocking kind. The eight
    // content panes are destinations, and trapping one would strand a player whose only way
    // out is a Back button the trap would keep them from reaching.
    const { hud: h, root } = mountDev({ developerMode: true });
    h.setState('main-menu');
    click(root.querySelector('.hud-settings-open') as HTMLButtonElement);
    const pane = root.querySelector('.hud-settings') as HTMLElement;
    expect(pane.classList.contains('hud-settings--hidden')).toBe(false);
    expect(root.querySelector('[inert]'), 'a route must not isolate anything').toBeNull();
  });

  it('releases the isolation when the dialog is dismissed', () => {
    const { hud: h, root } = mountDev({ developerMode: true });
    openConfirm(h, root);
    expect(root.querySelector('[inert]')).not.toBeNull();
    click(root.querySelector('.hud-confirm-cancel') as HTMLButtonElement);
    expect(root.querySelector('[inert]'), 'the HUD stayed inert').toBeNull();
  });

  it('releases it when a surface change empties the stack, not only on Back', () => {
    // `resetLayers` drops every layer without popping it, so a dialog left by a state change
    // -- a session starting under it -- would otherwise leave the whole HUD permanently
    // inert, with no dialog on screen to explain why nothing responds.
    const { hud: h, root } = mountDev({ developerMode: true });
    openConfirm(h, root);
    expect(root.querySelector('[inert]')).not.toBeNull();
    h.setState('playing');
    expect(root.querySelector('[inert]'), 'a surface change must release the isolation').toBeNull();
  });
});
