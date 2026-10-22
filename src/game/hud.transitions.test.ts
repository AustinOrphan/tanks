// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type Hud } from './hud';
import { installComputedStyleCache } from './computed-style-cache';

/**
 * The HUD's one interruptible transition contract (issue #364). Split from `hud.surfaces.test.ts`
 * (issue #1093), as the controller assignment panel and the paint shop were split from
 * `hud.controls.test.ts`: `leaving-surface-still-counted-as-open` names one case in each of the
 * three, and ran both whole files for them, which projected its runs on `main` past the 60s
 * that issue #1093 holds every navigation-scoped entry to.
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

/*
 * The one interruptible transition contract (issue #364).
 *
 * These run with FAKE TIMERS on purpose. `hud.ts` imports `./hud.css` and vitest is
 * configured with `css: true`, so the stylesheet IS in the jsdom document here and
 * `--ui-transition-duration` reads `150ms` -- every transition below is genuinely
 * deferred, not accidentally synchronous. That was measured before these were written,
 * not assumed: a suite where the duration resolved to 0 would let every "instant"
 * assertion pass against unfixed production.
 */
describe('createHud application transition contract', () => {
  const surface = (root: HTMLElement, sel: string): HTMLElement =>
    root.querySelector(sel) as HTMLElement;
  const hidden = (root: HTMLElement, sel: string, cls: string): boolean =>
    surface(root, sel).classList.contains(cls);
  /** Through the REAL control, like the rest of this suite -- the show* helpers the
   * contract routes through are internal to createHud and not on the Hud interface. */
  const click = (root: HTMLElement, sel: string): void => {
    (root.querySelector(sel) as HTMLButtonElement).dispatchEvent(new MouseEvent('click'));
  };

  it('reads its duration from the stylesheet rather than mirroring it', () => {
    // Criterion 1, as a BEHAVIOUR rather than a string comparison: "one place defines the
    // duration" is only true if moving that one place moves the timer. A `const 150` in
    // hud.ts would satisfy any assertion that merely compared two numbers, and would fail
    // this.
    vi.useFakeTimers();
    try {
      const { hud, root } = mount();
      document.documentElement.style.setProperty('--ui-transition-duration', '400ms');
      hud.setState('main-menu');
      click(root, '.hud-records-open');

      vi.advanceTimersByTime(399);
      expect(
        hidden(root, '.hud-panel', 'hud-panel--hidden'),
        'the outgoing panel settled on the OLD 150ms, so the stylesheet is not the source',
      ).toBe(false);
      vi.advanceTimersByTime(2);
      expect(hidden(root, '.hud-panel', 'hud-panel--hidden')).toBe(true);
    } finally {
      document.documentElement.style.removeProperty('--ui-transition-duration');
      vi.useRealTimers();
    }
  });

  it('moves focus at the START of the transition, not at its end', () => {
    // Criterion 4, asserted at transition start with NO timer advance.
    vi.useFakeTimers();
    try {
      const { hud, root } = mount();
      hud.setState('main-menu');
      click(root, '.hud-records-open');
      expect(document.activeElement).toBe(surface(root, '.hud-stats'));
      // ...and the animation has demonstrably not finished, or "at the start" is vacuous.
      expect(hidden(root, '.hud-panel', 'hud-panel--hidden')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves an interrupted transition to the SECOND destination only', () => {
    // Criterion 3. Two navigations inside one transition window.
    vi.useFakeTimers();
    try {
      const { hud, root } = mount();
      hud.setState('main-menu');
      click(root, '.hud-records-open');
      // The Achievements TAB inside the pane that is still fading in -- a second
      // navigation arriving inside the first one's window, which is the interrupt this
      // criterion is about. Scoped to `.hud-stats` because the same tab exists in the
      // Achievements pane too.
      click(root, '.hud-stats .hud-records-tab-achievements'); // interrupts, before any timer runs
      vi.advanceTimersByTime(1000);

      expect(hidden(root, '.hud-achievements', 'hud-achievements--hidden')).toBe(false);
      expect(
        hidden(root, '.hud-stats', 'hud-stats--hidden'),
        'the intermediate screen was left visible',
      ).toBe(true);
      expect(hidden(root, '.hud-panel', 'hud-panel--hidden')).toBe(true);
      // No half-applied transition state survives the interruption.
      for (const sel of ['.hud-panel', '.hud-stats', '.hud-achievements']) {
        expect(surface(root, sel).classList.contains('ui-surface--leaving'), sel).toBe(false);
        expect(surface(root, sel).classList.contains('ui-surface--entering'), sel).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes every transition instant under the RESOLVED reduced-motion policy', () => {
    // Criterion 5, with its own negative control in the same test: the `false` branch must
    // leave the outgoing surface displayed and a timer pending, or the `true` branch is
    // measuring a suite that was synchronous anyway.
    vi.useFakeTimers();
    try {
      const { hud, root } = mount();
      hud.setState('main-menu');
      vi.advanceTimersByTime(1000); // settle the mount, so the counts below start from rest

      // The SAME click, measured on both branches. A raw count would not isolate the
      // transition: opening this panel also schedules one unrelated 0ms timer that is
      // there either way, so the honest quantity is the DIFFERENCE the policy makes.
      hud.setReducedMotion(false);
      const before = vi.getTimerCount();
      click(root, '.hud-records-open');
      const withMotion = vi.getTimerCount() - before;
      expect(
        hidden(root, '.hud-panel', 'hud-panel--hidden'),
        'NEGATIVE CONTROL: motion on, the outgoing panel must still be displayed',
      ).toBe(false);
      vi.advanceTimersByTime(1000);
      click(root, '.hud-stats-back');
      vi.advanceTimersByTime(1000);

      hud.setReducedMotion(true);
      const armed = vi.getTimerCount();
      click(root, '.hud-records-open');
      const reduced = vi.getTimerCount() - armed;

      // The outgoing surface is gone in the same frame -- no advance between.
      expect(hidden(root, '.hud-panel', 'hud-panel--hidden')).toBe(true);
      expect(hidden(root, '.hud-stats', 'hud-stats--hidden')).toBe(false);
      expect(surface(root, '.hud-panel').classList.contains('ui-surface--leaving')).toBe(false);
      expect(
        withMotion - reduced,
        'reduced motion did not remove exactly the transition timer',
      ).toBe(1);
      // Criterion 5's "and every criterion above still holds" -- focus, at zero duration.
      expect(document.activeElement).toBe(surface(root, '.hud-stats'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaks no timers and fires no duplicate callbacks under repeated fast navigation', () => {
    // Criterion 6, asserted rather than observed. The timer count is a DELTA: the HUD
    // arms an unrelated 4000ms reset and its toast timers, so an absolute count would be
    // measuring those. The callback halves are the "no listener left attached" half --
    // Customize's callbacks build and dispose a live WebGL preview in loop.ts, so an
    // unbalanced pair is a real leak that no timer count would show.
    vi.useFakeTimers();
    try {
      const { hud, root } = mount();
      hud.setState('main-menu');
      let opens = 0;
      let closes = 0;
      hud.onCustomizeOpen(() => void opens++);
      hud.onCustomizeClose(() => void closes++);

      vi.advanceTimersByTime(1000); // from rest: the mount's own timers are not the subject
      const idle = vi.getTimerCount();
      expect(idle, 'the baseline itself was not at rest').toBe(0);
      for (let i = 0; i < 4; i++) {
        click(root, '.hud-customize-open');
        click(root, '.hud-customize-back');
      }
      vi.advanceTimersByTime(1000);

      expect(vi.getTimerCount(), 'a transition timer outlived the burst').toBe(idle);
      expect(opens, 'open fired a different number of times than close').toBe(closes);
      expect(opens).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('THE GAP (issue #558): a Records tab switch never paints the Main Menu', () => {
    // The defect, measured MID-transition rather than once settled -- settled is where it
    // hides. `openLayer`'s replace branch pops the outgoing tab and calls its `close()`,
    // and every pane's close is defined as "return to the Main Menu" (`closeSurface`
    // swaps to `PANEL_SURFACE`). The following `open()` drains that outstanding chain
    // before starting its own, so the panel lands genuinely open and is then crossfaded
    // straight back out: the player sees the menu they already left flash between two
    // panes that `openLayer`'s own doc comment calls "siblings over the same origin".
    //
    // Reduced motion masks it completely -- the class work settles inside one synchronous
    // step and never lands visible -- so this runs on the ordinary animated path, which
    // is what every player without a motion preference gets.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      vi.advanceTimersByTime(1000);
      const panelEl = surface(root, '.hud-panel');

      click(root, '.hud-records-open');
      vi.advanceTimersByTime(1000);
      expect(panelEl.classList.contains('hud-panel--hidden'), 'Records did not open').toBe(true);

      // The switch, read at its MIDPOINT: no timer advance, so whatever the swap put on
      // screen is still on screen.
      click(root, '.hud-stats .hud-records-tab-achievements');
      expect(
        panelEl.classList.contains('hud-panel--hidden'),
        'the Main Menu was painted between two Records tabs',
      ).toBe(true);

      // ...and back again, because the defect was symmetric in both directions.
      vi.advanceTimersByTime(1000);
      click(root, '.hud-achievements .hud-records-tab-stats');
      expect(
        panelEl.classList.contains('hud-panel--hidden'),
        'the Main Menu was painted switching back',
      ).toBe(true);

      // The denominator: the tabs really did move. Without this the assertions above
      // would pass on a build where the click did nothing at all.
      vi.advanceTimersByTime(1000);
      expect(surface(root, '.hud-stats').classList.contains('hud-stats--hidden')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still RELEASES the replaced pane, which is why the close was not simply dropped', () => {
    // The trap in the obvious fix. Deleting the outgoing layer's teardown from the replace
    // branch removes the flash and also skips every pane's non-visual release: `customize`
    // hands out a live `TankPreview` -- a WebGL context and its listeners -- to
    // `onCustomizeClose` subscribers, and a replace that never told them would leak it for
    // the rest of the page's life, silently.
    //
    // NOT the only cover for that: hud.navigation.test.ts's "a pane opened while a
    // different pane is up..." already counts the same callback over the same gesture, and
    // is the older of the two. What this one adds is the SURFACE half beside it -- that
    // the same replace also never paints the menu -- so the two halves of issue #558's fix
    // are asserted against one gesture rather than inferred from two.
    //
    // Reached through the public API rather than a synthetic call: `showVersusSetup` is
    // what `route-ui.ts` uses for the post-match reopen, and firing it over an open
    // Customize pane is exactly the replace path.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      let closes = 0;
      h.onCustomizeClose(() => {
        closes += 1;
      });
      h.setState('main-menu');
      vi.advanceTimersByTime(1000);

      click(root, '.hud-customize-open');
      vi.advanceTimersByTime(1000);
      expect(closes, 'opening the pane already reported a close').toBe(0);

      h.showVersusSetup(true);
      expect(closes, 'the replaced pane was never told it had been replaced').toBe(1);

      // ...and the flash is still absent on this path too, which is the whole point of
      // releasing rather than closing.
      expect(
        surface(root, '.hud-panel').classList.contains('hud-panel--hidden'),
        'the Main Menu was painted between two panes',
      ).toBe(true);
      vi.advanceTimersByTime(1000);
    } finally {
      vi.useRealTimers();
    }
  });


  it('opens an extracted pane from the surface on screen, never by naming the Main Menu (issue #556)', () => {
    // `enterSurface` is the one open `pane-host.ts` gives an extracted pane. Every open a player
    // can make of Customize starts at the Main Menu, where "the surface on screen" and "the Main
    // Menu" are the same surface, so no other case here can tell the two apart. A pane opened over
    // another pane can: the outgoing surface has to leave with the transition, or both stay
    // painted, which is what `openSurface`'s own comment records as measured once.
    //
    // Reached by clicking the Customize opener while Versus Setup is up. No player path does that
    // today; the contract is the host's, and the next pane opened from another pane relies on it.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      vi.advanceTimersByTime(1000);
      h.showVersusSetup(true);
      vi.advanceTimersByTime(1000);
      expect(hidden(root, '.hud-versus-setup', 'hud-versus-setup--hidden'), 'Versus Setup did not open').toBe(false);

      click(root, '.hud-customize-open');
      vi.advanceTimersByTime(1000);
      expect(hidden(root, '.hud-customize', 'hud-customize--hidden'), 'Customize did not open').toBe(false);
      expect(
        hidden(root, '.hud-versus-setup', 'hud-versus-setup--hidden'),
        'Versus Setup stayed painted under the pane that replaced it',
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('reports the versus setup pane opening and closing exactly once per transition (issue #785)', () => {
    // `route-ui.ts` holds two pad hotplug listeners from open to close. A second open with no
    // close would hold a second pair nothing removes; a missing close leaves them on the page.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      const log: string[] = [];
      h.onVersusSetupOpen(() => log.push('open'));
      h.onVersusSetupClose(() => log.push('close'));
      h.setState('main-menu');
      vi.advanceTimersByTime(1000);

      h.showVersusSetup(true);
      h.showVersusSetup(true); // already on top: a re-render, not a second open
      vi.advanceTimersByTime(1000);
      h.back();
      h.back();
      vi.advanceTimersByTime(1000);
      expect(log).toEqual(['open', 'close']);

      h.showVersusSetup(true);
      vi.advanceTimersByTime(1000);
      click(root, '.hud-versus-back');
      vi.advanceTimersByTime(1000);
      expect(log, 'the Back button and back() disagree').toEqual(['open', 'close', 'open', 'close']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the versus setup pane when a surface change takes it away (issue #785)', () => {
    // `setState` drops every layer without a Back, which is how a match started from the pane
    // leaves it.
    const { hud: h } = mount();
    const log: string[] = [];
    h.onVersusSetupClose(() => log.push('close'));
    h.setState('main-menu');
    h.showVersusSetup(true);
    h.setState('playing');
    expect(log).toEqual(['close']);
  });

  it('closes the versus setup pane when another pane replaces it (issue #785)', () => {
    // The replace path RELEASES rather than closes, so it needs its own row in the layer table.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      const log: string[] = [];
      h.onVersusSetupClose(() => log.push('close'));
      h.setState('main-menu');
      vi.advanceTimersByTime(1000);
      h.showVersusSetup(true);
      vi.advanceTimersByTime(1000);
      click(root, '.hud-customize-open');
      vi.advanceTimersByTime(1000);
      expect(hidden(root, '.hud-customize', 'hud-customize--hidden'), 'Customize did not open').toBe(false);
      expect(log, 'the replaced pane kept its listeners').toEqual(['close']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles rather than orphans an outstanding transition when the HUD is disposed', () => {
    // The other half of criterion 6: a HUD torn down mid-transition must leave no timer
    // behind. `dispose` settles rather than drops, so the surface it was hiding is hidden
    // -- an element about to be reused must not keep a `--leaving` class.
    vi.useFakeTimers();
    try {
      const { hud, root } = mount();
      hud.setState('main-menu');
      vi.advanceTimersByTime(1000);
      // Held BEFORE the teardown: dispose empties the root, so querying after it returns
      // null and every assertion below would throw rather than measure.
      const panelEl = surface(root, '.hud-panel');
      const statsEl = surface(root, '.hud-stats');

      click(root, '.hud-records-open');
      expect(panelEl.classList.contains('ui-surface--leaving'), 'nothing was in flight').toBe(
        true,
      );

      // Again a CONTRAST, not an absolute: the same unrelated 0ms timer the criterion-5
      // test accounts for is still outstanding here and is not this teardown's to clear.
      // What dispose owes is the transition timer, and that is exactly one.
      const armed = vi.getTimerCount();
      hud.dispose();
      expect(armed - vi.getTimerCount(), 'dispose orphaned the transition timer').toBe(1);
      // SETTLED, not dropped: the surface the transition was hiding is hidden, and no
      // half-applied class rides on an element that is about to be reused.
      expect(panelEl.classList.contains('hud-panel--hidden')).toBe(true);
      expect(panelEl.classList.contains('ui-surface--leaving')).toBe(false);
      expect(statsEl.classList.contains('ui-surface--entering')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('crossfades a panel CLOSE, not only its open', () => {
    // The half the contract shipped without. Every panel Back handler is
    // `showX(false)` followed SYNCHRONOUSLY by `setState('main-menu')`, and `setState`
    // runs a transition of its own -- which drains the outstanding one before it begins.
    // So the close crossfade was started and collapsed in the same tick, and Back was its
    // own interrupter. Measured in the shipped build before this test was written: the
    // open applied `ui-surface-out/0.15s`, the close applied no `ui-surface-*` class at
    // all. Asserted on the frame AFTER the click with no timer advance, because a settled
    // read cannot tell a 150ms crossfade from a cut.
    vi.useFakeTimers();
    try {
      const { hud, root } = mount();
      hud.setState('main-menu');
      vi.advanceTimersByTime(1000);
      click(root, '.hud-records-open');
      vi.advanceTimersByTime(1000); // settle the OPEN, so what follows is only the close

      click(root, '.hud-stats-back');
      expect(
        surface(root, '.hud-stats').classList.contains('ui-surface--leaving'),
        'the closing panel is not marked leaving -- the close was a cut',
      ).toBe(true);
      expect(
        surface(root, '.hud-panel').classList.contains('ui-surface--entering'),
        'the menu arriving underneath is not marked entering',
      ).toBe(true);
      // Still painted: `display: none` cannot be animated out of, so the outgoing surface
      // keeps its `--hidden` off for the whole fade.
      expect(hidden(root, '.hud-stats', 'hud-stats--hidden')).toBe(false);

      vi.advanceTimersByTime(1000);
      expect(hidden(root, '.hud-stats', 'hud-stats--hidden')).toBe(true);
      expect(surface(root, '.hud-stats').classList.contains('ui-surface--leaving')).toBe(false);
      expect(surface(root, '.hud-panel').classList.contains('ui-surface--entering')).toBe(false);
      // The destination is unchanged by any of this: Back still lands on the menu.
      expect(hidden(root, '.hud-panel', 'hud-panel--hidden')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('crossfades the title screen into the menu, and the backdrop with it', () => {
    // Criterion 2's screen-to-screen and backdrop halves, in the one navigation that
    // actually moves between two DIFFERENT elements: launch -> main-menu. The four
    // panel-family states share the single `.hud-panel` element, so they are a content
    // change rather than a surface change; see setState's own comment.
    vi.useFakeTimers();
    try {
      const { hud, root } = mount();
      hud.setState('launch');
      vi.advanceTimersByTime(1000);
      expect(hidden(root, '.hud-splash', 'hud-splash--hidden')).toBe(false);

      hud.setState('main-menu');
      // Mid-transition: the title screen is still painted, and both it and the arriving
      // menu carry the contract's classes. This is the crossfade, not a cut.
      expect(hidden(root, '.hud-splash', 'hud-splash--hidden')).toBe(false);
      expect(surface(root, '.hud-splash').classList.contains('ui-surface--leaving')).toBe(true);
      expect(hidden(root, '.hud-panel', 'hud-panel--hidden')).toBe(false);
      expect(surface(root, '.hud-panel').classList.contains('ui-surface--entering')).toBe(true);
      // The backdrop arrives on the SAME transition rather than cutting in under it.
      expect(hidden(root, '.ui-app-ground', 'ui-app-ground--hidden')).toBe(false);
      expect(surface(root, '.ui-app-ground').classList.contains('ui-surface--entering')).toBe(true);

      vi.advanceTimersByTime(1000);
      expect(hidden(root, '.hud-splash', 'hud-splash--hidden')).toBe(true);
      expect(surface(root, '.hud-splash').classList.contains('ui-surface--leaving')).toBe(false);
      expect(surface(root, '.hud-panel').classList.contains('ui-surface--entering')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never runs a transition on gameplay entry', () => {
    // Criterion 2's boundary, and the issue's explicit rule: no transition may run during
    // gameplay entry or exit in a way that delays the countdown or the first input. The
    // menu is gone in the same frame the game starts, with nothing left painted over it.
    vi.useFakeTimers();
    try {
      const { hud, root } = mount();
      hud.setState('main-menu');
      vi.advanceTimersByTime(1000);

      const idle = vi.getTimerCount();
      hud.setState('playing');
      expect(hidden(root, '.hud-panel', 'hud-panel--hidden')).toBe(true);
      expect(hidden(root, '.ui-app-ground', 'ui-app-ground--hidden')).toBe(true);
      expect(surface(root, '.hud-panel').classList.contains('ui-surface--leaving')).toBe(false);
      expect(vi.getTimerCount() - idle, 'gameplay entry scheduled a transition').toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
