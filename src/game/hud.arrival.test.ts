// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type Hud, type HudOptions } from './hud';
import { installComputedStyleCache } from './computed-style-cache';

/**
 * Where focus lands when a surface opens, and why a confirm pressed for the screen before cannot
 * press it (issue #919). Split from `hud.navigation.test.ts` (issue #1093), whose header says why.
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

describe('hud: arrival lands on the primary action, and a Confirm from the screen before cannot press it (issue #919)', () => {
  const q = (root: HTMLElement, sel: string): HTMLElement => root.querySelector(sel) as HTMLElement;
  const at = (ms: number): void => {
    vi.setSystemTime(ms);
  };
  /**
   * A key as the browser delivers it to the focused element, followed by the browser's own
   * activation when the event was not cancelled: Enter clicks a focused button on `keypress`,
   * Space on `keyup`. jsdom performs neither, so this does, and reports whether the event was
   * cancelled. Its `timeStamp` is the faked clock's, as a real event's is the real one's.
   */
  function browserKey(type: 'keydown' | 'keypress' | 'keyup', name: 'Enter' | ' ', repeat = false): boolean {
    const target = document.activeElement as HTMLElement;
    const e = new KeyboardEvent(type, { key: name, repeat, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    const activates = (type === 'keypress' && name === 'Enter') || (type === 'keyup' && name === ' ');
    if (activates && !e.defaultPrevented && target instanceof HTMLButtonElement) target.click();
    return e.defaultPrevented;
  }

  it('a Main Menu with a run arrives on Continue Campaign, never on the Start New Campaign beside it', () => {
    const { hud: h, root } = mount();
    h.setContinueAvailable(true);
    h.setState('main-menu');
    expect(document.activeElement, 'the menu did not arrive on Continue').toBe(q(root, '.hud-continue'));
    expect(q(root, '.hud-new-game').textContent, 'the fixture lost its destructive label').toBe(
      'Start New Campaign',
    );
    hud?.dispose();
    document.body.innerHTML = '';
    // NEGATIVE CONTROL: with no run there is no Continue, and Start Campaign takes the arrival.
    const fresh = mount();
    fresh.hud.setState('main-menu');
    expect(document.activeElement).toBe(q(fresh.root, '.hud-new-game'));
    expect(q(fresh.root, '.hud-new-game').textContent).toBe('Start Campaign');
  });

  it('the Main Menu arrival follows Continue when the run is reported after the surface, until the player moves', () => {
    // `route-host.ts` repaints whether a run exists AFTER `setState` has made the arrival, so
    // the menu's shape changes under a focus nobody has moved yet.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    expect(document.activeElement).toBe(q(root, '.hud-new-game'));
    h.setContinueAvailable(true);
    expect(document.activeElement, 'focus stayed on what just became Start New Campaign').toBe(
      q(root, '.hud-continue'),
    );
    h.setContinueAvailable(false);
    expect(document.activeElement, 'focus stayed on a Continue that is now hidden').toBe(
      q(root, '.hud-new-game'),
    );
    // NEGATIVE CONTROL: once the player has moved, the menu changing under them moves nothing.
    const versus = q(root, '.hud-versus-open');
    versus.focus();
    h.setContinueAvailable(true);
    expect(document.activeElement, 'a repaint moved the player back to the primary').toBe(versus);
  });

  it('the Main Menu arrival follow picks up a focus the browser dropped to <body>', () => {
    // A browser takes focus off a control it is about to hide, so the Continue that a finished
    // run hides leaves <body> focused; jsdom never does this itself, so the case blurs. A
    // dropped focus is one the player did not move, so the follow still places it.
    // NEGATIVE CONTROL: the next case, where the same dropped focus under an open pane is left.
    const { hud: h, root } = mount();
    h.setContinueAvailable(true);
    h.setState('main-menu');
    expect(document.activeElement).toBe(q(root, '.hud-continue'));
    (document.activeElement as HTMLElement).blur();
    h.setContinueAvailable(false);
    expect(document.activeElement, 'a dropped focus was left on <body>').toBe(q(root, '.hud-new-game'));
  });

  it('the Main Menu arrival follow never reaches under an open pane, even from <body>', () => {
    // A click on empty space drops focus to <body> while Settings is open; a repaint of the run
    // must not then put focus on a menu button the pane hides.
    // NEGATIVE CONTROL: the previous case, where a dropped focus on the menu itself is placed.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    q(root, '.hud-settings-open').click();
    expect(document.activeElement, 'Settings did not arrive on its container').toBe(q(root, '.hud-settings'));
    (document.activeElement as HTMLElement).blur();
    h.setContinueAvailable(true);
    expect(document.activeElement, 'a repaint pulled focus onto the menu under an open pane').toBe(
      document.body,
    );
  });

  it('the match-failure alert arrives on Retry when one is offered, and on its way out when none is', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const failure = { title: 'Match failed', detail: 'A transient failure.', action: 'Back to menu' };
    h.showMatchFailure(failure);
    expect(document.activeElement, 'with no retry, the arrival did not land on the dismiss').toBe(
      q(root, '.hud-alert-dismiss'),
    );
    h.back();
    h.showMatchFailure(failure, () => {});
    expect(document.activeElement, 'with a retry, the arrival did not land on Retry').toBe(
      q(root, '.hud-alert-retry'),
    );
  });

  it('Versus Setup arrives on its container when Start is refused, and Confirm there only lands focus', () => {
    const { hud: h, root } = mount();
    const starts: unknown[] = [];
    h.onVersusStart((config) => starts.push(config));
    h.setState('main-menu');
    h.showVersusSetup(true);
    // NEGATIVE CONTROL first: the default setup is startable, so Start takes the arrival.
    expect(document.activeElement).toBe(q(root, '.hud-versus-start'));
    q(root, '.hud-versus-slot-row[data-slot="0"] .hud-versus-role-btn[data-role="bot"]').click();
    h.back();
    h.showVersusSetup(true); // the refused all-bot setup is retained
    const start = q(root, '.hud-versus-start') as HTMLButtonElement;
    expect(start.disabled, 'the fixture did not refuse Start').toBe(true);
    expect(document.activeElement, 'a refused Start took the arrival').toBe(q(root, '.hud-versus-setup'));
    expect(h.act('confirm')).toBe(true);
    expect(starts, 'Confirm on the container started a match').toEqual([]);
  });

  // The browser's focus scroll judges the box the entrance still holds 16px low (`focusInView`),
  // and moved Versus Setup 4px under a Start already in view. Its negative controls are the
  // manifest entries `hud-arrival-focus-takes-the-browser-scroll` and
  // `hud-menu-arrival-follow-takes-the-browser-scroll`.
  it('an arrival, and the Main Menu arrival\'s follow, focus without the browser\'s focus scroll', () => {
    const { hud: h, root } = mount();
    const unscrolled = [[{ preventScroll: true }]];
    h.setState('main-menu');
    const cont = q(root, '.hud-continue');
    const follow = vi.spyOn(cont, 'focus');
    h.setContinueAvailable(true);
    expect(document.activeElement).toBe(cont);
    expect(follow.mock.calls, 'the follow took the browser\'s focus scroll').toEqual(unscrolled);
    const start = q(root, '.hud-versus-start');
    const arrival = vi.spyOn(start, 'focus');
    h.showVersusSetup(true);
    expect(document.activeElement).toBe(start);
    expect(arrival.mock.calls, 'the arrival took the browser\'s focus scroll').toEqual(unscrolled);
  });

  it('Versus Setup scrolls its pane to a Start out of view, and leaves one in view where it is', () => {
    // jsdom lays nothing out, so the pane states Chromium's geometry at 1280x800 and records
    // every scroll written to it: an 800px pane, Start 49px tall.
    const { hud: h, root } = mount();
    const pane = q(root, '.hud-versus-setup');
    const bar = q(root, '.hud-versus-actions');
    const start = q(root, '.hud-versus-start');
    const set = (el: HTMLElement, props: Record<string, unknown>): void => {
      for (const [key, value] of Object.entries(props)) {
        Object.defineProperty(el, key, { configurable: true, value });
      }
    };
    const writes: number[] = [];
    let scrollTop = 0;
    pane.style.overflowY = 'auto';
    set(pane, { clientHeight: 800 });
    Object.defineProperty(pane, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        writes.push(v);
        scrollTop = v;
      },
    });
    // As shipped: the sticky bar stuck at the pane's foot holds Start at 739..788.
    set(bar, { offsetParent: pane, offsetTop: 715, clientTop: 0 });
    set(start, { offsetParent: bar, offsetTop: 24, offsetHeight: 49 });
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(document.activeElement).toBe(start);
    expect(writes, 'the arrival scrolled a pane whose Start was in view').toEqual([]);
    h.back();
    // NEGATIVE CONTROL: unpinned, Start sits at 915..964, 164px past the pane's view.
    set(start, { offsetParent: pane, offsetTop: 915 });
    h.showVersusSetup(true);
    expect(document.activeElement).toBe(start);
    expect(writes, 'the arrival left Start out of view').toEqual([164]);
  });

  it('an Enter that opens a pane cannot press its primary with the repeats, keypress or release of that Enter', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { hud: h, root } = mount();
      const picks: number[] = [];
      h.onLevelSelect((i) => picks.push(i));
      h.setLevelSelect(3, 5);
      at(1_000);
      h.setState('main-menu');
      q(root, '.hud-levelselect-open').focus();
      at(2_000);
      expect(browserKey('keydown', 'Enter'), 'a fresh press on Practice was cancelled').toBe(false);
      expect(browserKey('keypress', 'Enter'), 'the press did not reach Practice').toBe(false);
      const level1 = q(root, '.hud-level-btn[aria-label="Level 1"]');
      expect(document.activeElement, 'Level Select did not arrive on Level 1').toBe(level1);
      at(2_500); // the key auto-repeats on Level 1, then is released there
      expect(browserKey('keydown', 'Enter', true), 'a repeat reached Level 1').toBe(true);
      expect(browserKey('keypress', 'Enter', true), 'a repeat\'s keypress reached Level 1').toBe(true);
      expect(browserKey('keyup', 'Enter'), 'the release reached Level 1').toBe(true);
      expect(picks, 'the Enter that opened Level Select also started Level 1').toEqual([]);
      // NEGATIVE CONTROL: the next press, made on Level Select, starts Level 1 once.
      at(3_000);
      expect(browserKey('keydown', 'Enter')).toBe(false);
      expect(browserKey('keypress', 'Enter')).toBe(false);
      expect(picks).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a Space held through the end of a match cannot press Retry with its repeats or its release', () => {
    // Space lays a mine in play, so a round that ends with it held lands focus on the
    // outcome's primary with the key still down -- and Space clicks on its release.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { hud: h, root } = mount();
      let restarts = 0;
      h.onStartRestart(() => {
        restarts += 1;
      });
      at(1_000);
      h.setState('main-menu');
      h.setState('playing');
      (document.activeElement as HTMLElement).blur();
      at(2_000);
      browserKey('keydown', ' '); // held down in play
      at(3_000);
      h.setState('outcome-lose');
      const action = q(root, '.hud-action');
      expect(document.activeElement, 'the end screen did not arrive on its action').toBe(action);
      at(3_200);
      expect(browserKey('keydown', ' ', true), 'a repeat reached the end screen').toBe(true);
      at(3_600);
      expect(browserKey('keyup', ' '), 'the release reached the end screen').toBe(true);
      expect(restarts, 'the Space held through the round pressed the end screen\'s action').toBe(0);
      // NEGATIVE CONTROL: a Space pressed on the end screen presses its action once.
      at(4_000);
      expect(browserKey('keydown', ' ')).toBe(false);
      expect(browserKey('keyup', ' ')).toBe(false);
      expect(restarts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The outcome is the one surface the GAME opens, on the frame the match ends, so a fresh press
  // in its first quarter-second (`OUTCOME_CONFIRM_GRACE_MS`) was made for the match. Both
  // outcomes, each spelled out, one with each Confirm key.
  it('a Space pressed in the moment a match is lost cannot press the outcome, and one after can', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { hud: h, root } = mount();
      let restarts = 0;
      h.onStartRestart(() => {
        restarts += 1;
      });
      at(1_000);
      h.setState('main-menu');
      h.setState('playing');
      at(5_000);
      h.setState('outcome-lose'); // the frame of the final death
      expect(document.activeElement, 'the end screen did not arrive on its action').toBe(q(root, '.hud-action'));
      at(5_100); // a mine laid a tenth of a second later
      expect(browserKey('keydown', ' '), 'a press 100ms after the match ended reached the outcome').toBe(true);
      expect(browserKey('keyup', ' '), 'its release reached the outcome').toBe(true);
      expect(restarts, 'a Space pressed for the match pressed the outcome\'s action').toBe(0);
      // NEGATIVE CONTROL: the same Space 400ms after the arrival, past the window, presses it once.
      at(5_400);
      expect(browserKey('keydown', ' ')).toBe(false);
      expect(browserKey('keyup', ' ')).toBe(false);
      expect(restarts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an Enter pressed in the moment a match is won cannot press the outcome, and one after can', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { hud: h, root } = mount();
      let restarts = 0;
      h.onStartRestart(() => {
        restarts += 1;
      });
      at(1_000);
      h.setState('main-menu');
      h.setState('playing');
      at(5_000);
      h.setState('outcome-win'); // the frame of the winning kill
      expect(document.activeElement, 'the end screen did not arrive on its action').toBe(q(root, '.hud-action'));
      at(5_100);
      expect(browserKey('keydown', 'Enter'), 'a press 100ms after the match ended reached the outcome').toBe(true);
      expect(browserKey('keypress', 'Enter'), 'its keypress reached the outcome').toBe(true);
      expect(restarts, 'an Enter pressed for the match pressed the outcome\'s action').toBe(0);
      // NEGATIVE CONTROL: the same Enter 400ms after the arrival, past the window, presses it once.
      at(5_400);
      expect(browserKey('keydown', 'Enter')).toBe(false);
      expect(browserKey('keypress', 'Enter')).toBe(false);
      expect(restarts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a screen the player opened takes a fresh press at once: only the outcome has a reaction window', () => {
    // NEGATIVE CONTROL for the two cases above, on a panel state and on a layer: the same
    // press, 10ms after the arrival, is the player's.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { hud: h, root } = mount();
      let restarts = 0;
      h.onStartRestart(() => {
        restarts += 1;
      });
      const picks: number[] = [];
      h.onLevelSelect((i) => picks.push(i));
      h.setLevelSelect(3, 5);
      at(1_000);
      h.setState('main-menu');
      h.setState('playing');
      at(2_000);
      h.setState('paused');
      expect(document.activeElement, 'Pause did not arrive on Resume').toBe(q(root, '.hud-action'));
      at(2_010);
      expect(browserKey('keydown', 'Enter'), 'a press 10ms after Pause arrived was cancelled').toBe(false);
      expect(browserKey('keypress', 'Enter')).toBe(false);
      expect(restarts, 'a fresh Enter on Resume did not press it').toBe(1);

      h.setState('main-menu');
      at(3_000);
      q(root, '.hud-levelselect-open').click(); // a pointer opens it: no key is down
      expect(document.activeElement, 'Level Select did not arrive on Level 1').toBe(
        q(root, '.hud-level-btn[aria-label="Level 1"]'),
      );
      at(3_010);
      expect(browserKey('keydown', ' '), 'a press 10ms after Level Select arrived was cancelled').toBe(false);
      expect(browserKey('keyup', ' ')).toBe(false);
      expect(picks, 'a fresh Space on Level 1 did not start it').toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a held Enter that arms a two-press reset cannot fire it with its own auto-repeat', () => {
    // The armed "Really reset?" is a new question; a held Enter clicks on every repeat.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { hud: h, root } = mount();
      let resets = 0;
      h.onResetProgress(() => {
        resets += 1;
      });
      at(1_000);
      h.setState('main-menu');
      q(root, '.hud-settings-open').click();
      const reset = q(root, '.hud-reset-progress');
      reset.focus();
      at(2_000);
      expect(browserKey('keydown', 'Enter'), 'a fresh press on the reset was cancelled').toBe(false);
      expect(browserKey('keypress', 'Enter'), 'the press did not reach the reset').toBe(false);
      expect(reset.textContent, 'the first press did not arm the reset').toBe('Really reset?');
      at(2_500); // the same key, still held, auto-repeats on the armed control
      expect(browserKey('keydown', 'Enter', true), 'a repeat reached the armed reset').toBe(true);
      expect(browserKey('keypress', 'Enter', true), 'a repeat\'s keypress reached the armed reset').toBe(true);
      expect(browserKey('keyup', 'Enter')).toBe(true);
      expect(resets, 'one held Enter both armed and fired the reset').toBe(0);
      // NEGATIVE CONTROL: a second press, made on the armed control, fires the reset once.
      at(3_000);
      expect(browserKey('keydown', 'Enter')).toBe(false);
      expect(browserKey('keypress', 'Enter')).toBe(false);
      expect(resets).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a keydown queued behind an arrival cannot press the new primary', () => {
    // Pressed while the frame that opened the screen was running, delivered after it.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { hud: h } = mount();
      let restarts = 0;
      h.onStartRestart(() => {
        restarts += 1;
      });
      at(1_000);
      h.setState('main-menu');
      at(2_000);
      const queued = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      at(2_010);
      h.setState('outcome-win'); // arrives, on its action, after the press was made
      document.activeElement!.dispatchEvent(queued);
      expect(queued.defaultPrevented, 'a press made before the arrival reached its primary').toBe(true);
      expect(browserKey('keypress', 'Enter'), 'its keypress reached the primary').toBe(true);
      expect(restarts).toBe(0);
      // NEGATIVE CONTROL: the same key pressed after the arrival presses the action.
      at(2_500);
      browserKey('keydown', 'Enter');
      expect(browserKey('keypress', 'Enter')).toBe(false);
      expect(restarts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
