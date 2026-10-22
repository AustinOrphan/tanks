// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createHud, type Hud, type HudOptions } from './hud';
import { isMuteHotkey, isPauseHotkey } from './loop';
import type { TypedOutcome } from './app-state';
import { ZERO_STATS } from './stats';
import { installComputedStyleCache } from './computed-style-cache';

/**
 * Moving focus with the arrows and a pad: the roving tabindex (issue #115), with the
 * whole-panel walks, and spatial focus that follows the drawn layout (issue #495).
 * Split from `hud.navigation.test.ts` (issue #1093), whose header says why.
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

describe('createHud roving-tabindex focus navigation (issue #115)', () => {
  it('every focus-target container names itself from its own heading', () => {
    // The seven tabindex="-1" containers are what panel-open transitions focus; a bare
    // div's accessible name is the flattened text of everything inside it, so each one
    // carries aria-labelledby pointing at its own h1. Derived from the DOM, not a list:
    // an eighth focusable container added without the attribute fails here. Breaks if
    // an aria-labelledby is dropped, its id target renamed, or the target moves outside
    // the container it names.
    const { root } = mount();
    const containers = Array.from(root.querySelectorAll<HTMLElement>('[tabindex="-1"]'));
    expect(containers.length, '12 panel containers carry tabindex=-1 (panel + 11 panes: ' +
      'controller assignment landing added the 6th (docs/superpowers/plans/2026-08-17-' +
      'controller-assignment.md), the versus setup pane the 7th (docs/superpowers/specs/' +
      '2026-08-21-versus-setup-menu-design.md), and issue #226 the 8th, 9th and 10th -- ' +
      'Settings, About & Legal, and the replace-run confirmation), and issue #243 the ' +
      '11th -- the Developer Tools shell, and issue #325 the 12th -- the match-failure ' +
      'alert, which is an OVERLAY rather than a route but takes focus the same way), and ' +
      'issue #599 the 13th -- the controller self-test, its own layer inside the developer ' +
      'shell rather than more of that pane, and issue #246 the 14th -- the configuration ' +
      'menu, its own layer for the same reason, and issue #730 the 15th -- the gallery ' +
      'workbench, its own layer for the same reason, and issue #754 the 16th -- the ' +
      'controller layout, opened from Settings, its own layer for the same reason').toBe(16);
    for (const c of containers) {
      const ref = c.getAttribute('aria-labelledby');
      expect(ref, `${c.className} has no aria-labelledby`).toBeTruthy();
      const target = root.querySelector(`#${ref}`);
      expect(target, `${c.className}'s aria-labelledby (#${ref}) resolves to nothing`).not.toBeNull();
      expect(c.contains(target), `${c.className}'s label lives outside the container it names`).toBe(true);
      expect(target!.tagName, `${c.className}'s label is not its heading`).toBe('H1');
    }
  });

  /** A real keydown, dispatched at whatever currently holds focus -- exactly what a
   * browser delivers to `document.activeElement`, and what makes this reach the
   * capture-phase `window` listener `onNavKeyDown` registers (a bubbling event fired at
   * any connected descendant of `window` passes through it during capture, regardless
   * of which node it is dispatched at). */
  function pressActive(key: string): void {
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  }

  /** Keyboard activation: MouseEvent detail 0, the same convention `blurIfPointer`
   * relies on elsewhere in this file (see 'does not keep keyboard focus after a
   * pointer interaction' above) -- so entering a subpanel through this traversal does
   * not blur the button the way a real pointer click would. */
  function activate(el: HTMLElement): void {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  }

  /**
   * Independently re-derives the exact predicate hud.ts's own (unexported)
   * `focusableControls` applies, straight from the DOM rather than a maintained list --
   * `button, [tabindex]`, filtered to not-disabled and not hidden by `display: none` on
   * itself OR ON ANY ANCESTOR up to (not including) `container`. That ancestor walk
   * matters: since issue #226 the three Main Menu regions hide as GROUPS on the win/lose
   * panel, and `getComputedStyle` on a child inside one reports the child's OWN resolved
   * display, not `none` (measured directly below), so a check that only looked at the
   * element itself would disagree with a correct production predicate exactly where a
   * hidden wrapper is involved -- which is exactly the drift this independent oracle
   * exists to catch, not paper over by copying the bug.
   */
  function controlsOf(container: HTMLElement): HTMLElement[] {
    const hiddenWithin = (el: HTMLElement): boolean => {
      for (let n: HTMLElement | null = el; n && n !== container; n = n.parentElement) {
        if (getComputedStyle(n).display === 'none') return true;
      }
      return false;
    };
    return Array.from(container.querySelectorAll<HTMLElement>('button, [tabindex]')).filter(
      (el) => !(el instanceof HTMLButtonElement && el.disabled) && !hiddenWithin(el),
    );
  }

  /**
   * The openers that live on the MAIN PANEL, and the pane each opens.
   *
   * Panel-level only, deliberately, and that is a statement about the layer stack rather
   * than about this test's convenience: a pane opened from inside ANOTHER pane replaces
   * it (`openLayer`), so the opener is gone by the time Back runs and `restoreFocus`
   * leaves the destination's own arrival. The walk below asserts that Back restores the opener,
   * which is true exactly for the openers listed here. The three pane-to-pane moves
   * issue #226 adds -- the Records tabs, Settings -> Controllers, Settings -> About --
   * have their own tests, and issue #327 owns the covering-layer contract that would let
   * them nest.
   */
  const OPEN_TO_PANEL: Record<string, string> = {
    'hud-customize-open': 'hud-customize',
    'hud-records-open': 'hud-stats',
    'hud-levelselect-open': 'hud-levelselect',
    'hud-controllers-open': 'hud-controllers',
    'hud-versus-open': 'hud-versus-setup',
    'hud-settings-open': 'hud-settings',
    'hud-about-open': 'hud-about',
  };
  const BACK_OF_PANEL: Record<string, string> = {
    'hud-customize': 'hud-customize-back',
    'hud-stats': 'hud-stats-back',
    'hud-achievements': 'hud-achievements-back',
    'hud-levelselect': 'hud-levelselect-back',
    'hud-controllers': 'hud-controllers-back',
    'hud-versus-setup': 'hud-versus-back',
    'hud-settings': 'hud-settings-back',
    'hud-about': 'hud-about-back',
  };

  it('reaches every visible, enabled control from the title screen using arrow keys alone', () => {
    // The issue's own falsifiable assertion. 3 of 5 levels unlocked: exercises a
    // reachable level button AND a locked one that must be SKIPPED, not merely
    // disabled-but-focusable.
    const { hud: h, root } = mount();
    h.setLevelSelect(3, 5);
    h.setContinueAvailable(true); // Continue must be one of the reachable controls counted below
    // The versus setup pane's Versus button is a bare click passthrough (onVersusOpen's
    // own doc comment on the Hud interface) -- unlike every sibling panel's own open
    // button, clicking it does NOT open the pane by itself; the real subscriber
    // (loop.ts) decides that. Wiring the SAME one-liner loop.ts will use is what lets
    // `walk` below enter this pane exactly like every other one, by an ACTUAL open
    // transition rather than a special case.
    h.onVersusOpen(() => h.showVersusSetup(true));
    h.setState('main-menu'); // splash -> title: focuses Continue, the menu's primary action

    let totalControls = 0;
    const visited = new Set<HTMLElement>();

    // WHERE EACH ARRIVAL LANDS (issue #919), spelled out for the panels this walk enters: the
    // surface's primary action where it has one, its container where it has none. The full
    // per-surface table, with its population, is `hud.reachability.test.ts`'s.
    const ARRIVAL_IN: Record<string, string> = {
      'hud-panel': '.hud-continue', // a run exists (setContinueAvailable above)
      'hud-levelselect': '.hud-level-btn[aria-label="Level 1"]',
      'hud-versus-setup': '.hud-versus-start',
    };
    const arrivalOf = (container: HTMLElement): HTMLElement => {
      const primary = ARRIVAL_IN[container.className.split(' ')[0]];
      return primary === undefined ? container : (container.querySelector(primary) as HTMLElement);
    };

    // Walks ONE panel's flat control list forward with ArrowDown, entering and leaving
    // every subpanel it finds along the way via its own open/Back buttons (never via
    // arrows -- activation is a separate, native concern; see the report). Recursive
    // because a subpanel is walked exactly the same way the title panel is.
    //
    // EVERY panel-open transition -- the first splash -> title and a subpanel's own open
    // button -- lands on that panel's primary action, or on its CONTAINER when it declares
    // none (issue #919; see `ARRIVAL_IN` above). So `walk` starts from wherever the arrival
    // put focus -- index -1 for a container, whose first ArrowDown reaches controls[0] -- and
    // steps forward round the whole cycle back to it.
    function walk(container: HTMLElement): void {
      const arrival = arrivalOf(container);
      expect(document.activeElement, `${container.className} did not arrive where it should`).toBe(arrival);
      const controls = controlsOf(container);
      expect(controls.length, `${container.className} exposed no reachable controls`).toBeGreaterThan(0);
      totalControls += controls.length;
      const start = controls.indexOf(arrival); // -1 for a container
      for (let i = 0; i < controls.length; i++) {
        pressActive('ArrowDown');
        const active = document.activeElement as HTMLElement;
        expect(active, `step ${i} in .${container.className.split(' ')[0]} landed on the wrong control`).toBe(
          controls[(start + 1 + i) % controls.length],
        );
        visited.add(active);
        const openCls = Array.from(active.classList).find((c) => c in OPEN_TO_PANEL);
        if (openCls) {
          activate(active); // opens the subpanel: focus lands on ITS arrival
          const subPanel = root.querySelector(`.${OPEN_TO_PANEL[openCls]}`) as HTMLElement;
          walk(subPanel);
          const back = root.querySelector(`.${BACK_OF_PANEL[OPEN_TO_PANEL[openCls]]}`) as HTMLButtonElement;
          activate(back); // leave -- restores focus to the control that opened it (issue #318)
          expect(
            document.activeElement,
            'Back did not return focus to the control that opened the subpanel',
          ).toBe(active);
          // Focus is on control i again, so the loop's own next ArrowDown reaches i+1
          // with no replay. Until issue #318 Back landed on the CONTAINER (index -1)
          // and this loop had to replay i + 1 presses to get back to where it was.
        }
      }
      // One more step proves the list is a closed CYCLE, not just a reachable line --
      // the walk came round to where it started and goes on rather than dead-ending.
      pressActive('ArrowDown');
      expect(document.activeElement, `${container.className} did not wrap round its cycle`).toBe(
        controls[(start + 1) % controls.length],
      );
    }

    walk(root.querySelector('.hud-panel') as HTMLElement);

    // Denominator: 42, the live sum of controlsOf().length over the title panel and all
    // four subpanels, counted as `walk` actually visits each one (not asserted as a bare
    // literal -- see below). It decomposes as 10 (title: Continue, New Game, the three
    // open buttons, Levels-open, panel Mute, the scheme, fire-mode and haptics toggles) +
    // 24 (Customize: the preview canvas, its 4 rotate buttons, PALETTE.length 6 hull
    // swatches, SKINS.length 7 skin buttons, ACCENTS.length 5 accent swatches, Back) + 3
    // (Stats: Reset stats, Reset progress, Back) + 1 (Achievements: Back -- the list
    // itself is plain divs, not focusable) + 4 (Levels: the 3 unlocked buttons this
    // test's own `setLevelSelect(3, 5)` leaves reachable, plus Back). The volume slider is
    // excluded by design -- see the roving-focus doc comment in hud.ts -- and its − and +
    // steppers (issue #918) are counted, at 91 below.
    // 42 since the haptics toggle (issue #112's deferred HUD control) landed: 41 + the
    // toggle beside the fire-mode toggle in the title panel's settings row.
    // 44 since the controller assignment panel landed (docs/superpowers/plans/
    // 2026-08-17-controller-assignment.md): 42 + 1 (the title panel's own new
    // Controllers-open button) + 1 (the Controllers panel's own Back button -- this test
    // never calls hud.setControllers, so its rows are empty and Back is its only
    // reachable control; row-button reachability is covered by hud.css.test.ts's
    // buttons.length sweep and this file's own controller-row rendering tests instead).
    // 64 since issue #271 added a sixth board OFFERED AT N=2, the count this fixture's
    // versus pane defaults to; it was 63 when the versus setup pane landed
    // (docs/superpowers/specs/2026-08-21-versus-setup-menu-design.md).
    //
    // 70 since issue #260 made who's-playing a set of per-slot ROLE controls. That block
    // used to contribute 0 reachable controls here: it rendered a DEVICE preview, and
    // this test never calls hud.setControllers, so the session's assignment was length 0
    // against the pane's default 2 players -- a mismatch, which rendered every candidate
    // DISABLED and therefore unreachable by the roving walk. The role buttons are
    // enabled unconditionally, so the same block now contributes 2 slots x
    // [Human/Bot/Off] = 6. Start is still reachable because the default slots
    // (Human, Bot) raise no problem and so leave it enabled -- a fixture whose defaults
    // refused Start would pin 69, not 70.
    //
    // 44 + 1 (the title panel's own new Versus-open button) + 25 (the versus pane's OWN
    // reachable controls, measured against this test's own fixture -- 2 Mode + 3 Players
    // + 7 Map (versusMapChoices(2): the five migrated boards, vs-duel-01, plus Random --
    // a board curated for another count would NOT appear here) + 5 Stock + 0 friendly
    // fire (absent -- the pane defaults to FFA) + 6 who's-playing role buttons
    // + Start + Back = 2+3+7+5+0+6+1+1 = 25).
    // 72 since issue #281, DOWN by one, and the direction is the point: this sweep counts
    // visible and ENABLED controls, and Teams is no longer offered at two players ("not a
    // distinct option for two players because it is equivalent to FFA"). This fixture is at
    // the pane's default count, so the Teams button is disabled here and correctly drops
    // out of arrow-key navigation -- a disabled control that stayed reachable would be the
    // defect.
    //
    // It was 73 since issue #267, when the one BOT slot (`defaultSlots(2)` is
    // `[human, bot]`) gained Easy/Normal/Hard. The per-slot TEAM buttons do not appear
    // here at all, because they render only under Teams -- which this fixture cannot now
    // reach at two players.
    //
    // 76 SINCE ISSUE #226, up 4 from 72, and every part of that delta was the Main Menu and
    // Settings restructure. Re-measured per container at this fixture's state rather than
    // adjusted: 8 (Main Menu) + 24 (Customize) + 3 (Records/Stats) + 4 (Levels) + 27
    // (Versus setup) + 9 (Settings) + 1 (About & Legal) = 76.
    //
    // Itemised against the 72:
    //   -4  the Main Menu drops from 12 to 8. OUT: Stats-open and Achievements-open (one
    //       Records entry replaces both), Controllers-open (pause-only now), and the four
    //       settings-row controls (panel Mute, scheme, fire mode, haptics -- moved into
    //       the Settings pane). IN: Records, Settings, and the About & Legal footer.
    //       Continue, the campaign start button, Versus and Practice are unchanged.
    //   -1  the Controllers pane is no longer walked FROM HERE: its opener is pause-only,
    //       and the Settings -> Controls entry that replaces it is a pane-to-pane move,
    //       which this walk deliberately does not follow (see OPEN_TO_PANEL).
    //   -1  the Achievements pane likewise: it is a TAB of Records now, reached from
    //       inside the Stats pane rather than from the menu. Its own tests cover it.
    //   +9  the Settings pane: Mute, aim scheme, fire mode, haptics, Controllers, Reset
    //       stats, Reset progress, About & Legal, Back. The volume slider is excluded for
    //       the same reason the retired ones were -- `input[type=range]` matches neither
    //       `button` nor `[tabindex]`.
    //   +1  the About & Legal pane: Back. Its three paragraphs are prose, not controls.
    //
    // The Records pane holds at 3: the two reset buttons it gave up were replaced,
    // one for one, by the two tab buttons.
    //
    // 77 SINCE ISSUE #289: the Settings pane goes from 9 to 10 with the motion toggle,
    // which is the first control its Accessibility section has ever held. That the walk
    // reaches it is the assertion that matters here -- a section rendering with a control
    // the arrows cannot land on is the failure `refreshSettingsSections` and
    // `focusableControls` share a predicate to prevent.
    //
    // 78 SINCE ISSUE #540: 11 in the Settings pane, the extra one being the render-quality
    // toggle beside it in Accessibility. Same assertion, same reason.
    //
    // 85 SINCE ISSUE #117: the About & Legal pane goes from 1 to 8, so the "+1 ... Back. Its
    // three paragraphs are prose, not controls" line above is superseded -- the pane now
    // holds Back, five document disclosures (Privacy, Credits, Third-party notices, Code
    // licence, Content licence) and two outbound links. MEASURED at 85, not derived: the two
    // links are `<a>` elements, and whether `focusableControls` reaches them at all depends
    // on the explicit `tabindex="0"` `renderLegalLinks` sets, since its selector is
    // `'button, [tabindex]'` and a bare `<a href>` matches neither. That is the assertion
    // this number is really making -- delete that one attribute and this figure drops to 83
    // while the links stay clickable by mouse, which is the controller-reachability half of
    // issue #117's acceptance criteria going quiet.
    //
    // The five disclosures are `LEGAL_DOCUMENTS.length` and the two links are
    // `LEGAL_LINKS.length`, both generated by `npm run legal` from the repository's markdown,
    // so this figure moves when a DOCUMENT is added to `LEGAL_SOURCES` in
    // tools/legal/parse.mjs -- not when a document's text changes. The document bodies
    // themselves contribute nothing either way: every link inside them is flattened to text
    // by the generator, so an open licence adds no control, and a collapsed one is
    // `display: none` and excluded by `isHiddenWithin` regardless.
    //
    // 86 since issue #227's controller-rumble toggle, which sits in the Settings pane's
    // Controls section beside device haptics. Reachable here because this fixture never
    // pushes a relevance verdict: per-device hiding is a `--hidden` class the page applies,
    // so the untouched HUD offers every control and this figure stays a property of the
    // MARKUP. A fixture that pushed a no-touch, no-vibration verdict would reach 83.
    //
    // 87 since issue #754's Controller Layout entry, beside Controllers in the same section. The
    // layout pane's own controls do not count: the pane is not open in this walk.
    //
    // 89 since issue #1035: the Versus setup pane's Map row at this fixture's default two
    // players gains two cards, vs-tri-01 and vs-quad-01, the dedicated boards now offered at
    // the lower counts they measure suitable at. Seven Map controls become nine (Random,
    // five campaign boards, vs-duel-01, and the two), so that pane goes from 27 to 29.
    //
    // 91 since issue #918: Settings' Audio section gains the − and + volume steppers, the
    // controller's path to the level. The slider between them still does not count; it is an
    // `<input type="range">`, outside the walk on purpose.
    //
    // 92 since issue #1058: Settings' Accessibility section gains the Player colors toggle,
    // after Quality, so the Settings pane goes from 15 to 16. Not capability-gated, so a
    // relevance verdict would not take it out either.
    expect(totalControls, 'recount the panels above if this moves').toBe(92);
    expect(visited.size, 'a control was reached more than once under a different identity').toBe(
      totalControls,
    );
    // A RAISED BUDGET, not a hung test. Every ArrowDown re-derives the active panel's controls
    // through `getComputedStyle`, and since jsdom 30.1.2 empties its computed-style cache on
    // each focus move, every step re-runs the cascade for the whole panel: 0.97s in CI before
    // that bump, 7.3s after, against the 5s default.
  }, 20_000);

  it('steps through every button the Levels panel draws, because none of them is inert', () => {
    // Was "skips locked level buttons". Issue #555 stopped drawing them, so the walk has
    // nothing to skip -- and that is the assertion now: every `.hud-level-btn` in the DOM
    // is reachable and enabled, where before two of the four were neither.
    const { hud: h, root } = mount();
    h.setLevelSelect(2, 4); // 4-level campaign, 2 unlocked -- so 2 buttons, not 4
    h.setState('main-menu');

    let active = document.activeElement as HTMLElement;
    // Bounded like the other walks: a regression that stops the arrows moving focus must
    // FAIL here, not spin a CI worker forever (it did, on 2026-09-02, when a unified
    // key-consume rule briefly let a focused button keep the arrows).
    let steps = 0;
    while (!(active instanceof HTMLElement && active.classList.contains('hud-levelselect-open')) && steps < 40) {
      pressActive('ArrowDown');
      active = document.activeElement as HTMLElement;
      steps += 1;
    }
    expect(active.classList.contains('hud-levelselect-open'), 'the walk never reached the Levels opener').toBe(true);
    activate(active); // open Levels -- the arrival lands on Level 1, the pane's primary action

    const levelBtns = Array.from(
      root.querySelectorAll('.hud-level-btn'),
    ) as HTMLButtonElement[];
    // 2, not 4: the campaign's length is not in this DOM at all (issue #555).
    expect(levelBtns).toHaveLength(2);
    expect(document.activeElement, 'opening Levels did not focus Level 1 (issue #919)').toBe(levelBtns[0]);
    // 2 level buttons + Back, and the walk lands on ALL of them, from Level 1 round to it
    // again -- a grid that still drew locked entries would either add unreachable nodes
    // here or focus a disabled one.
    const reached: HTMLButtonElement[] = [];
    for (let i = 0; i < 3; i++) {
      pressActive('ArrowDown');
      reached.push(document.activeElement as HTMLButtonElement);
    }
    expect(reached).toEqual([levelBtns[1], root.querySelector('.hud-levelselect-back'), levelBtns[0]]);
    expect(reached.some((b) => b.disabled), 'a disabled level button was focused').toBe(false);
  });

  it('moves focus backward with ArrowUp, undoing an ArrowDown step', () => {
    // A spot check, not a re-sweep of the whole panel -- the traversal test above
    // already proves the forward order for every control; this pins one adjacent pair
    // (of however many the title panel exposes) to check that reversing the direction
    // key reverses the step, not the full sweep that test performs.
    const { hud: h } = mount();
    h.setLevelSelect(3, 5);
    h.setState('main-menu');
    pressActive('ArrowDown');
    const first = document.activeElement;
    pressActive('ArrowDown');
    const second = document.activeElement;
    expect(second).not.toBe(first);
    pressActive('ArrowUp');
    expect(document.activeElement, 'ArrowUp did not undo the previous ArrowDown').toBe(first);
  });

  it('treats S/W as Down/Up, the same production call ArrowDown/ArrowUp reach', () => {
    const { hud: h } = mount();
    h.setState('main-menu');
    pressActive('s');
    const afterS = document.activeElement;
    pressActive('ArrowDown');
    const afterArrowDown = document.activeElement;
    expect(afterArrowDown, 's did not move focus the same way ArrowDown does').not.toBe(afterS);
    pressActive('w');
    expect(document.activeElement, 'w did not undo the previous step, as ArrowUp does').toBe(
      afterS,
    );
  });

  it('focuses Resume on entering pause, and Escape-to-resume and M-to-mute stay live there (issue #919)', () => {
    // RE-ARGUED, not reversed. This pinned the pause panel's CONTAINER, against an earlier
    // draft that focused Resume and silently killed Escape-to-resume and M-to-mute the
    // instant the panel opened: `isPauseHotkey`/`isMuteHotkey` (game/loop.ts) then ignored
    // any key whose target sat inside a button. Their guard now asks `consumesKey`, under
    // which a button keeps only Space and Enter -- so Resume can take focus, which is the
    // owner's #919 ruling, and this is the case that proves both keys survive it. It
    // constructs the SAME kind of event those guards read, rather than trusting the class
    // name alone.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.setState('playing');
    h.setState('paused');
    const active = document.activeElement as HTMLElement;
    expect(active, 'pause did not focus Resume').toBe(root.querySelector('.hud-action'));
    expect(active.textContent).toBe('Resume');
    const ev = (key: string): KeyboardEvent =>
      ({ key, repeat: false, target: active }) as unknown as KeyboardEvent;
    expect(isPauseHotkey(ev('Escape')), 'Escape-to-resume is dead while paused').toBe(true);
    expect(isMuteHotkey(ev('m')), 'M-to-mute is dead while paused').toBe(true);
  });

  it('reaches Resume, then Settings, then Controllers, then Quit from the pause panel', () => {
    // Was "two ArrowDowns" before the controller assignment panel landed (docs/
    // superpowers/plans/2026-08-17-controller-assignment.md), and three until issue #226
    // gave the pause panel a Settings entry -- which sits in the utilities region, and so
    // in DOM order before Controllers and Quit. Each is a real, reachable stop. Since
    // issue #919 the arrival is already on Resume, so the walk begins one stop later and
    // wraps back to Resume to close the cycle.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.setState('playing');
    h.setState('paused');
    expect(document.activeElement, 'pause did not arrive on Resume').toBe(root.querySelector('.hud-action'));
    pressActive('ArrowDown');
    expect(document.activeElement, 'the first ArrowDown did not reach Settings').toBe(
      root.querySelector('.hud-settings-open'),
    );
    pressActive('ArrowDown');
    expect(document.activeElement, 'the second ArrowDown did not reach Controllers').toBe(
      root.querySelector('.hud-controllers-open'),
    );
    pressActive('ArrowDown');
    expect(document.activeElement, 'the third ArrowDown did not reach Quit').toBe(
      root.querySelector('.hud-quit'),
    );
    pressActive('ArrowDown');
    expect(document.activeElement, 'the fourth ArrowDown did not wrap back to Resume').toBe(
      root.querySelector('.hud-action'),
    );
  });

  it('Back returns focus to the control that opened the subpanel, and the menu hotkeys stay alive there (issue #318)', () => {
    // Two contracts in one place, on purpose. Back lands on the Customize BUTTON now,
    // not on the panel container -- which is only legal because loop.ts's hotkey guard
    // stopped treating a button as a control that consumes M and Escape. Until #318
    // this test pinned the container, as the workaround for that broader guard.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const opener = root.querySelector('.hud-customize-open') as HTMLButtonElement;
    opener.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    expect(document.activeElement, 'Customize declares no primary action, so its container takes focus').toBe(
      root.querySelector('.hud-customize'),
    );
    (root.querySelector('.hud-customize-back') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }),
    );
    const active = document.activeElement as HTMLElement;
    expect(active, 'Back left focus somewhere other than the control that opened the pane').toBe(opener);
    const ev = (key: string): KeyboardEvent =>
      ({ key, repeat: false, target: active }) as unknown as KeyboardEvent;
    expect(isMuteHotkey(ev('m')), 'M is dead at the menu after Back').toBe(true);
  });

  it('auto-focuses the action button, the outcome\'s primary action, on win and lose (issue #919)', () => {
    const { hud: h, root } = mount();
    const action = root.querySelector('.hud-action') as HTMLButtonElement;
    h.setState('main-menu');
    h.setState('playing');
    h.setState('outcome-win');
    expect(document.activeElement, 'win did not focus its action button').toBe(action);
    h.setState('playing');
    h.setState('outcome-lose');
    expect(document.activeElement, 'lose did not focus its action button').toBe(action);
  });

  it('reaches Retry, then Choose Level, then Main Menu on a PRACTICE end screen', () => {
    /*
     * The keyboard and D-pad half of issue #323's third action. `Choose Level` is a
     * button on a panel that had two, so the roving order is the thing that can silently
     * be wrong about it in either direction: skipping it strands a pad-only player on an
     * action they cannot reach, and reaching it while it is hidden is the ancestor-walk
     * bug the test below this one exists for, in its simplest form -- this button carries
     * its own `--hidden` modifier rather than sitting inside a hidden wrapper, so it is
     * `focusableControls`' OWN display check that has to exclude it.
     */
    const { hud: h, root } = mount();
    h.setLevelSelect(3, 5); // there is a level choice to make, so the button is offered
    h.setState('main-menu');
    h.setState('playing');
    h.setState('outcome-lose');
    const practiceLost: TypedOutcome = { kind: 'practice-result', cleared: false };
    h.setOutcome({
      tally: 'solo', attempt: ZERO_STATS, action: 'campaign-levels', typedOutcome: practiceLost,
    });
    expect((root.querySelector('.hud-action') as HTMLElement).textContent).toBe('Retry');

    // The arrival is already on Retry (issue #919), so the walk starts one stop later.
    expect(document.activeElement, 'the end screen did not arrive on Retry').toBe(
      root.querySelector('.hud-action'),
    );
    pressActive('ArrowDown');
    expect(document.activeElement, 'the first ArrowDown did not reach Choose Level').toBe(
      root.querySelector('.hud-choose-level'),
    );
    pressActive('ArrowDown');
    expect(document.activeElement, 'the second ArrowDown did not reach Main Menu').toBe(
      root.querySelector('.hud-quit'),
    );
    pressActive('ArrowDown');
    expect(document.activeElement, 'the third ArrowDown did not wrap back to Retry').toBe(
      root.querySelector('.hud-action'),
    );
  });

  it('never walks focus onto Choose Level on a screen that does not offer it', () => {
    // The negative control for the traversal above, and the bug class the pause panel
    // has been bitten by before: the button is in the DOM on every screen and is hidden
    // by a class, so a roving order that walked the markup rather than the rendering
    // would hand a campaign game-over an invisible stop between Start New Campaign and
    // Main Menu. Walked further than there are visible controls so the order has to WRAP,
    // which is where an unexcluded control shows up first.
    const { hud: h, root } = mount();
    h.setLevelSelect(3, 5);
    h.setState('main-menu');
    h.setState('playing');
    h.setState('outcome-lose');
    const campaignOver: TypedOutcome = { kind: 'campaign-over' };
    h.setOutcome({
      tally: 'solo', attempt: ZERO_STATS, action: 'campaign-levels', typedOutcome: campaignOver,
    });
    const choose = root.querySelector('.hud-choose-level') as HTMLElement;
    expect(choose.isConnected, 'test invalid: the button is not in the DOM to be skipped').toBe(true);
    const reachable = [root.querySelector('.hud-action'), root.querySelector('.hud-quit')];
    for (let i = 0; i < 6; i++) {
      pressActive('ArrowDown');
      expect(document.activeElement, `press ${i + 1} landed on a hidden Choose Level`).not.toBe(choose);
      expect(reachable, `press ${i + 1} left the two-control order`).toContain(document.activeElement);
    }
  });

  it('never walks focus into a Main Menu region while its wrapper is display:none', () => {
    // The bug the ancestor-walking `isHiddenWithin` in hud.ts exists to catch. It used
    // to be `.hud-panel-settings` hiding the audio row as a group; since issue #226 the
    // group hides are the three Main Menu REGIONS, which is a wider version of the same
    // shape -- each control's OWN `display` still resolves to something other than
    // `none`, so a check that only looked at the control itself would walk the roving
    // order onto six invisible buttons on every win/lose screen instead of three.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.setState('playing');
    // Controls here: the action button and, since issue #323, the Main Menu button --
    // which is the point of the change and NOT what this test is about. The roving order
    // legitimately has two members now, so the assertion below names the SET rather than
    // a single element; what must still hold is that nothing inside a hidden region is
    // ever reachable, however many visible controls there happen to be.
    h.setState('outcome-win');
    for (const cls of ['hud-menu-play', 'hud-menu-utilities', 'hud-menu-footer']) {
      const region = root.querySelector(`.${cls}`) as HTMLElement;
      expect(getComputedStyle(region).display, `test invalid: .${cls} is not actually hidden`).toBe(
        'none',
      );
    }
    // The half that makes this test about the ANCESTOR walk rather than about the
    // controls: these two carry no `--hidden` of their own, so their own resolved
    // `display` is not `none` and only the wrapper excludes them. (The play region's two
    // buttons both have their own modifiers as well -- Versus is Main-Menu-only and
    // Practice also needs a level choice -- so they cannot make this point and are
    // deliberately not asked to.)
    for (const sel of ['.hud-settings-open', '.hud-about-open']) {
      const inner = root.querySelector(sel) as HTMLElement;
      expect(
        getComputedStyle(inner).display,
        `test invalid: ${sel} now also resolves display:none, which would make this pass for the wrong reason`,
      ).not.toBe('none');
    }
    // Walk further than there are visible controls, so the order has to WRAP rather than
    // run off the end into a hidden region. Six presses over a two-control order visits
    // each of them three times and would land on a hidden button on the very first
    // overflow if `isHiddenWithin` stopped walking ancestors.
    const reachable = [root.querySelector('.hud-action'), root.querySelector('.hud-quit')];
    for (let i = 0; i < 6; i++) {
      pressActive('ArrowDown');
      expect(
        reachable,
        `press ${i + 1}: focus walked onto a control inside a hidden region`,
      ).toContain(document.activeElement);
    }
  });

  it('does not intercept arrow keys while playing, so input.ts still drives the tank', () => {
    // The state-aware boundary this whole feature has to respect: no panel is visible
    // while playing, so `activePanelContainer` must return null and the handler must
    // return before calling preventDefault -- otherwise input.ts's own window listener,
    // which registers AFTER this one in a real boot and so runs strictly later, would
    // never see the key at all.
    const { hud: h } = mount();
    h.setState('main-menu');
    h.setState('playing');
    document.body.focus();
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented, 'a playing-state ArrowDown was swallowed by the HUD nav').toBe(
      false,
    );
  });

  it('leaves the volume slider in full control of its own arrow keys', () => {
    // input.ts's WIDGET_KEYS already gives a focused range input every arrow key for
    // its own value adjustment (see its doc comment on Right Arrow strafing instead of
    // moving the slider); this file's roving nav must not re-litigate that. Production
    // change that would break this: dropping the `e.target instanceof HTMLInputElement`
    // early return in `onNavKeyDown`.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    // In the Settings pane since issue #226, so the pane has to be open for the slider to
    // be the control the roving handler is deciding about.
    (root.querySelector('.hud-settings-open') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }),
    );
    const slider = root.querySelector('.hud-settings-volume') as HTMLInputElement;
    slider.focus();
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      slider.dispatchEvent(ev);
      expect(document.activeElement, `${key} moved focus off the slider`).toBe(slider);
      expect(ev.defaultPrevented, `${key} was swallowed instead of left to the slider`).toBe(false);
    }
  });

  it('leaves ArrowLeft/ArrowRight on the preview canvas for its own rotation scheme', () => {
    // render/preview-controls.ts binds its own keydown DIRECTLY to the canvas (not at
    // window), so this file cannot see whether that scheme still fires -- what it CAN
    // pin is that its own capture-phase handler, which runs strictly before a
    // target-bound listener ever sees the event, gets out of the way for Left/Right and
    // does not for the axis the canvas never claims. Production change that would break
    // this: dropping the `e.target === previewCanvasEl` carve-out for lateral keys.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    (root.querySelector('.hud-customize-open') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }),
    );
    // LOAD-BEARING, not clarity: showCustomize(true) focuses the PANE (customizeView),
    // never the canvas -- nothing in hud.ts ever calls previewCanvas.focus(). Delete
    // this line and the assertion below tests the wrong element.
    h.previewCanvas.focus();
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      h.previewCanvas.dispatchEvent(ev);
      expect(document.activeElement, `${key} moved focus off the canvas`).toBe(h.previewCanvas);
      expect(ev.defaultPrevented, `${key} was claimed by the HUD nav instead of the canvas`).toBe(
        false,
      );
    }
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    h.previewCanvas.dispatchEvent(down);
    expect(document.activeElement, 'ArrowDown did not move focus off the canvas').not.toBe(
      h.previewCanvas,
    );
  });
});

describe('hud: spatial focus follows the drawn layout (issue #495)', () => {
  const ROW_SELECTOR =
    '.hud-versus-mode-row, .hud-versus-players-row, .hud-versus-map-row, .hud-versus-stock-row, .hud-versus-slot-row, .hud-levels';
  /**
   * A desktop-like layout drawn by hand, since jsdom lays nothing out: each Versus option
   * row and each slot card is one visual row, everything else is one control per row, and
   * a control's column is its index among the buttons of its row. `perRow` wraps a row
   * into several, standing in for a narrow viewport.
   */
  function drawn(root: HTMLElement, perRow = Infinity): (el: HTMLElement) => DOMRect {
    const rowEls: Element[] = [];
    return (el) => {
      const rowEl = el.closest(ROW_SELECTOR) ?? el.parentElement ?? root;
      let r = rowEls.indexOf(rowEl);
      if (r < 0) {
        r = rowEls.length;
        rowEls.push(rowEl);
      }
      const siblings = Array.from(rowEl.querySelectorAll<HTMLElement>('button'));
      const i = Math.max(0, siblings.indexOf(el));
      const wrapRow = Math.floor(i / perRow);
      const col = i % perRow;
      return new DOMRect(col * 110, r * 1000 + wrapRow * 50, 100, 40);
    };
  }
  function mountDrawn(perRow?: number): { hud: Hud; root: HTMLElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = createHud(root, { measure: drawn(root, perRow) });
    hud = h;
    return { hud: h, root };
  }
  const press = (key: string): void => {
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  };
  const active = (): HTMLElement => document.activeElement as HTMLElement;

  it('a segmented row walks Left/Right within itself and wraps at its ends; Up/Down leave it for the neighbouring row', () => {
    // The Map row is the segment with the most options (9 since issue #1035 offered
    // vs-tri-01 and vs-quad-01 at two players); Mode has one enabled button at two players,
    // which is why it is not the subject here.
    const { hud: h, root } = mountDrawn();
    h.setState('main-menu');
    h.showVersusSetup(true);
    const maps = Array.from(root.querySelectorAll<HTMLButtonElement>('.hud-versus-map-row button')).filter((b) => !b.disabled);
    const players = Array.from(root.querySelectorAll<HTMLButtonElement>('.hud-versus-players-row button')).filter((b) => !b.disabled);
    const stocks = Array.from(root.querySelectorAll<HTMLButtonElement>('.hud-versus-stock-row button')).filter((b) => !b.disabled);
    expect(maps.length, 'the Map segment population').toBe(9);
    maps[0].focus();
    press('ArrowRight');
    expect(active()).toBe(maps[1]);
    maps[maps.length - 1].focus();
    press('ArrowRight');
    expect(active(), 'Right at the end of the segment left it').toBe(maps[0]);
    press('ArrowLeft');
    expect(active(), 'Left at the start of the segment left it').toBe(maps[maps.length - 1]);
    maps[0].focus();
    press('ArrowDown');
    expect(active(), 'Down did not leave the segment for the Stock row').toBe(stocks[0]);
    press('ArrowUp');
    expect(active()).toBe(maps[0]);
    press('ArrowUp');
    expect(active(), 'Up did not leave the segment for the Players row').toBe(players[0]);
  });

  it('the slot cards navigate as a grid: Down lands on the nearest column of the next card', () => {
    const { hud: h, root } = mountDrawn();
    h.setState('main-menu');
    h.showVersusSetup(true);
    const card = (slot: number): HTMLElement[] =>
      Array.from(root.querySelectorAll<HTMLButtonElement>(`.hud-versus-slot-row[data-slot="${slot}"] button`)).filter((b) => !b.disabled);
    expect([card(0).length, card(1).length], 'the two cards: a human card and a bot card with its difficulty options').toEqual([3, 6]);
    card(0)[2].focus();
    press('ArrowDown');
    expect(active(), 'Down did not land on the same column of the next card').toBe(card(1)[2]);
    press('ArrowRight');
    expect(active()).toBe(card(1)[3]);
    press('ArrowUp');
    expect(active(), 'Up did not return to the nearest column of the shorter card above').toBe(card(0)[2]);
    press('ArrowUp');
    expect(active(), 'Up from the first card did not reach the Stock row above it').not.toBe(card(0)[2]);
  });

  it('a row that wraps behaves as the grid it has become: the Levels grid at three per row', () => {
    const { hud: h, root } = mountDrawn(3);
    h.setLevelSelect(5, 5);
    h.setState('main-menu');
    (root.querySelector('.hud-levelselect-open') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    const levels = Array.from(root.querySelectorAll<HTMLElement>('.hud-levels button'));
    expect(levels.length, 'the level population').toBe(5);
    levels[0].focus();
    press('ArrowDown');
    expect(active(), 'Down did not drop to the wrapped row').toBe(levels[3]);
    press('ArrowRight');
    expect(active()).toBe(levels[4]);
    press('ArrowRight');
    expect(active(), 'Right at the wrapped row end did not wrap within it').toBe(levels[3]);
    levels[2].focus();
    press('ArrowRight');
    expect(active(), 'Right at the first row end left the row').toBe(levels[0]);
  });

  it('the re-derived walk: Right along each row then Down reaches every control of the Versus pane exactly once -- population stated', () => {
    const { hud: h, root } = mountDrawn();
    h.setState('main-menu');
    h.showVersusSetup(true);
    const pane = root.querySelector('.hud-versus-setup') as HTMLElement;
    const population = Array.from(pane.querySelectorAll<HTMLElement>('button, [tabindex]')).filter(
      (el) => !(el instanceof HTMLButtonElement && el.disabled) && Number(el.getAttribute('tabindex') ?? 0) >= 0 && getComputedStyle(el).display !== 'none',
    );
    press('ArrowDown'); // from the container: enters at the first control
    const first = active();
    const visited = new Set<HTMLElement>([first]);
    let rowStart = first;
    for (let steps = 0; steps < 200; steps++) {
      press('ArrowRight');
      if (active() === rowStart) {
        press('ArrowDown');
        if (active() === first) break;
        rowStart = active();
      }
      visited.add(active());
    }
    expect(visited.size, 'the walk did not cover the pane').toBe(population.length);
    // 29 since issue #1035: the Map row gains vs-tri-01 and vs-quad-01 at two players.
    expect(population.length, 'the population this walk covers').toBe(29);
    // A RAISED BUDGET, for the reason the title-screen walk above has one: 0.5s in CI before
    // jsdom 30.1.2 and 6.8s after, because jsdom now recomputes every style per focus move.
  }, 20_000);

  it('negative control: with jsdom\'s empty rects the same Right leaves the segment in document order', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    const maps = Array.from(root.querySelectorAll<HTMLButtonElement>('.hud-versus-map-row button')).filter((b) => !b.disabled);
    const stocks = Array.from(root.querySelectorAll<HTMLButtonElement>('.hud-versus-stock-row button')).filter((b) => !b.disabled);
    maps[maps.length - 1].focus();
    press('ArrowRight');
    expect(active(), 'the fallback should walk document order').toBe(stocks[0]);
  });
});
