// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type Hud } from './hud';
import { installComputedStyleCache } from './computed-style-cache';

/**
 * Developer mode's entry, indicator and exit (issue #243). Split from `hud.navigation.test.ts` (issue #1093), whose header says why.
 */

// Keeps `display` across focus moves, which jsdom 30.1.2 recomputes (issue #1093).
installComputedStyleCache();

let hud: Hud | null = null;

afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

describe('developer mode: entry, indicator and exit (issue #243)', () => {
  const badge = (r: HTMLElement): HTMLButtonElement => r.querySelector('.hud-devbadge') as HTMLButtonElement;
  const entry = (r: HTMLElement): HTMLButtonElement => r.querySelector('.hud-devtools-open') as HTMLButtonElement;
  const pane = (r: HTMLElement): HTMLElement => r.querySelector('.hud-devtools') as HTMLElement;
  const exitBtn = (r: HTMLElement): HTMLButtonElement => r.querySelector('.hud-devtools-exit') as HTMLButtonElement;
  const backBtn = (r: HTMLElement): HTMLButtonElement => r.querySelector('.hud-devtools-back') as HTMLButtonElement;
  /*
   * ANCESTOR-AWARE ON PURPOSE. jsdom's `getComputedStyle` reports an element's OWN
   * resolved display and does not account for a hidden ancestor, so a badge sitting
   * inside a `display: none` topbar still reads as displayed.
   *
   * MEASURED while writing these: with the badge moved into the topbar -- the exact
   * regression the persistence sweep below names, and the most natural wrong
   * implementation -- the naive `getComputedStyle(el).display !== 'none'` passed on
   * every surface. Walking to the root is what makes these assertions about what a
   * player would actually see.
   */
  const shown = (el: HTMLElement): boolean => {
    for (let n: HTMLElement | null = el; n !== null && n !== document.body; n = n.parentElement) {
      if (getComputedStyle(n).display === 'none') return false;
    }
    return true;
  };

  function mountDev(opts: Parameters<typeof createHud>[1] = {}): { hud: Hud; root: HTMLElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    hud = createHud(root, opts);
    return { hud, root };
  }

  it('shows neither the entry nor the indicator without the gate', () => {
    // `createHud(root)` -- the shape ~200 existing tests use. The control here is the
    // whole feature: developer UI must be absent from an ordinary page, and absent is
    // what every one of those tests silently asserts by never seeing it.
    const { root } = mountDev();
    expect(shown(badge(root)), 'the indicator must not appear on an ordinary page').toBe(false);
    expect(shown(entry(root)), 'nor the menu entry').toBe(false);
  });

  it('shows exactly one entry and the indicator when the gate is on', () => {
    const { hud: h, root } = mountDev({ developerMode: true });
    h.setState('main-menu');
    expect(shown(badge(root))).toBe(true);
    // "Exactly one", asserted by counting rather than by finding one: a second entry
    // added elsewhere on the menu surface is the thing the issue rules out, and a
    // `querySelector` would keep passing beside it.
    expect(root.querySelectorAll('.hud-devtools-open')).toHaveLength(1);
    expect(shown(entry(root))).toBe(true);
  });

  it('keeps the menu entry to the MENU, while the indicator carries the gate into gameplay', () => {
    // The entry sits in the Main Menu footer and obeys that footer's existing rule, so it
    // is gone during a match -- which is precisely why the issue asks for a persistent
    // indicator as well as an entry, and why one control could not have served both.
    const { hud: h, root } = mountDev({ developerMode: true });
    h.setState('playing');
    expect(shown(entry(root)), 'the menu entry does not belong to a live match').toBe(false);
    expect(shown(badge(root)), 'the indicator does').toBe(true);
  });

  it('derives visibility from the gate, not from whether any flag differs from its default', () => {
    // A bare `?dev=1` parses to exactly DEV_FLAGS_OFF, so a HUD handed only flag values
    // could not tell it from an ordinary page. This is that case: the gate on, nothing
    // else supplied. It is the issue's acceptance criterion stated as a fixture.
    const { root } = mountDev({ developerMode: true });
    expect(shown(badge(root)), 'the gate alone must be enough').toBe(true);
  });

  it('opens the tools from the menu entry, and Back returns to the menu', () => {
    const { hud: h, root } = mountDev({ developerMode: true });
    h.setState('main-menu');
    expect(shown(pane(root))).toBe(false);
    entry(root).dispatchEvent(new MouseEvent('click'));
    expect(shown(pane(root))).toBe(true);
    backBtn(root).dispatchEvent(new MouseEvent('click'));
    // `ui-surface--leaving` rather than a settled `display: none`: closing is a crossfade,
    // so the pane is still on screen for the duration and these tests assert closure by the
    // outgoing class (see 'the pane is not on its way out' in hud.navigation.test.ts). Focus is
    // the other half -- Back must restore the control that opened it, which is the issue's
    // requirement.
    expect(pane(root).classList.contains('ui-surface--leaving'), 'the pane is not closing').toBe(true);
    expect(document.activeElement, 'Back must restore the invoking control').toBe(entry(root));
  });

  it('reopens the tools from the persistent indicator, and Back returns to where it was pressed', () => {
    // The two openers record their OWN control, which is what makes the badge usable
    // during a match: Back has to return to the surface the badge was pressed over, not
    // to the Main Menu the other opener lives on.
    const { hud: h, root } = mountDev({ developerMode: true });
    h.setState('playing');
    badge(root).dispatchEvent(new MouseEvent('click'));
    expect(shown(pane(root))).toBe(true);
    backBtn(root).dispatchEvent(new MouseEvent('click'));
    // Settled `display: none` here, and the LEAVING class in the menu case above -- the two
    // are different on purpose and this asserts what each path actually does. Closing over
    // gameplay runs the instant transition (see `cleanupHide`'s doc comment in hud.ts), so
    // the pane is gone in the same frame rather than fading; asserting the leaving class
    // here would fail, and accepting either would stop measuring the difference.
    expect(shown(pane(root)), 'the pane closes').toBe(false);
    expect(document.activeElement, 'and the badge that opened it is restored').toBe(badge(root));
  });

  it('calls the injected exit exactly once, and does not act on its own', () => {
    const exitDeveloperMode = vi.fn();
    const { root } = mountDev({ developerMode: true, exitDeveloperMode });
    entry(root).dispatchEvent(new MouseEvent('click'));
    expect(exitDeveloperMode, 'nothing fires from merely opening the pane').not.toHaveBeenCalled();
    exitBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(exitDeveloperMode).toHaveBeenCalledTimes(1);
  });

  it('does not offer Exit when nothing is wired to it', () => {
    // A visible control that silently does nothing is worse than an absent one, and this
    // is the case that produces it: the gate on, the seam unbound.
    const { root } = mountDev({ developerMode: true });
    expect(exitBtn(root).hidden, 'an unwired Exit must not be offered').toBe(true);
    const wired = document.createElement('div');
    document.body.appendChild(wired);
    const h2 = createHud(wired, { developerMode: true, exitDeveloperMode: () => {} });
    expect((wired.querySelector('.hud-devtools-exit') as HTMLButtonElement).hidden).toBe(false);
    h2.dispose();
  });

  it('keeps the indicator on screen across every surface, menus and gameplay alike', () => {
    // "Persistent" is the requirement, and the topbar could not have satisfied it: that
    // bar is gameplay-status-only since issue #226 and is hidden at the Main Menu. This
    // sweeps the surfaces rather than sampling two, so a surface added later that buries
    // the badge fails here.
    const { hud: h, root } = mountDev({ developerMode: true });
    const surfaces = ['launch', 'main-menu', 'playing', 'paused', 'outcome-win', 'outcome-lose'] as const;
    for (const s of surfaces) {
      h.setState(s);
      expect(shown(badge(root)), `the indicator vanished on ${s}`).toBe(true);
    }
  });

  it('puts the entry where a GAMEPAD can reach it, at the Main Menu and at Pause', () => {
    /*
     * The acceptance criterion this exists for is "focus, back and activation behaviour for
     * keyboard, touch AND controller". Arrow/D-pad navigation walks `focusableControls`
     * within `activePanelContainer()`, and the DEV badge is a sibling of the panes on the
     * HUD ROOT -- inside no panel at all. It is therefore reachable by pointer and by Tab,
     * and never by a gamepad, which is fine for an indicator but cannot be the only way in.
     *
     * MEASURED before the entry moved out of the Main Menu footer: at `paused` the walk
     * found 4 controls and Developer Tools was not among them, so a controller player who
     * had started a match had no route to the tools at all. `playing` has no active panel
     * by design -- the pad is driving -- so Pause is the mid-session surface that matters.
     *
     * NO MANIFEST ENTRY, deliberately. The proving mutation is a DOM RELOCATION -- the
     * button back inside `.hud-menu-footer`, which is Main-Menu-only -- and that is two
     * hunks in two places, which the harness's single find/replace cannot express. It was
     * applied BY HAND and this test failed on it with
     * `expected [ 'hud-action', ...(3) ] to include 'hud-devtools-open'`. Every proxy
     * available as one hunk pins a different property: dropping the button into a fresh
     * container leaves it visible everywhere (measured: SURVIVES), and rewriting the
     * utilities row's own class hides Settings at Pause too, so it would be killed by
     * unrelated tests and would stop being about this entry at all.
     */
    const reachable = (r: HTMLElement): string[] => {
      const active = ['.hud-panel', '.hud-devtools', '.hud-settings', '.hud-about']
        .map((sel) => r.querySelector(sel) as HTMLElement)
        .find((c) => c !== null && !c.classList.contains('ui-surface--leaving') && shown(c));
      if (active === undefined) return [];
      return Array.from(active.querySelectorAll<HTMLElement>('button, [tabindex]'))
        .filter((e) => !(e instanceof HTMLButtonElement && e.disabled) && shown(e))
        .map((e) => Array.from(e.classList).find((c) => c.startsWith('hud-')) ?? e.tagName);
    };
    const { hud: h, root } = mountDev({ developerMode: true });

    h.setState('main-menu');
    expect(reachable(root), 'the menu walk must offer the tools').toContain('hud-devtools-open');
    h.setState('paused');
    expect(reachable(root), 'and so must Pause, or a gamepad is locked out mid-session')
      .toContain('hud-devtools-open');

    // The badge is deliberately NOT in either walk -- it floats over every surface and
    // belongs to no panel. Asserted so its absence stays a decision rather than a bug, and
    // so that making it panel-owned (which would break the float) fails here.
    expect(reachable(root)).not.toContain('hud-devbadge');
  });

  it('is a real control, not a decoration: the indicator is a focusable button', () => {
    // The issue requires activating it to reopen the shell, so it has to be reachable by
    // keyboard and controller like any other control -- which a <div> would not be.
    const { root } = mountDev({ developerMode: true });
    expect(badge(root).tagName).toBe('BUTTON');
    badge(root).focus();
    expect(document.activeElement).toBe(badge(root));
  });
});
