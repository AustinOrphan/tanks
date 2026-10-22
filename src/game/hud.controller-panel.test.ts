// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type Hud } from './hud';
import { installComputedStyleCache } from './computed-style-cache';

/**
 * The controller assignment panel. Split from `hud.controls.test.ts` (issue #1093), with the
 * paint shop (`hud.paint-shop.test.ts`), so the entries killed by these cases stop running all
 * of that file's tests; `hud.transitions.test.ts`'s header says why.
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

describe('hud: controller assignment panel (docs/superpowers/plans/2026-08-17-controller-assignment.md)', () => {
  const openBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-controllers-open') as HTMLButtonElement;
  const view = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-controllers') as HTMLElement;
  const backBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-controllers-back') as HTMLButtonElement;
  const heading = (root: HTMLElement): string =>
    (root.querySelector('.hud-controllers-title') as HTMLElement).textContent ?? '';
  // Scoped to view(root), NOT a bare `root.querySelectorAll` -- the versus setup
  // pane's who's-playing preview REUSES this exact class (renderControllerRowsInto,
  // hud.ts), so an unscoped query here would double-count its rows too the moment
  // both panels' markup exists in the same document, which is every test in this
  // file (mount() builds the whole HUD up front).
  const rows = (root: HTMLElement): HTMLElement[] =>
    Array.from(view(root).querySelectorAll('.hud-controller-row'));
  const currentOf = (row: HTMLElement): HTMLElement =>
    row.querySelector('.hud-controller-row-current') as HTMLElement;
  const candidateButtons = (row: HTMLElement): HTMLButtonElement[] =>
    Array.from(row.querySelectorAll('.hud-controller-source-btn'));

  it('is CONTEXTUAL, not a permanent Main Menu destination (issue #226)', () => {
    // The ruling: "Controllers are contextual to VS/setup or Controls settings, not a
    // permanent top-level destination." So the panel button on the menu is gone and the
    // two contextual entries remain: the pause panel, which is the owner's original "in
    // case controllers disconnect" case, and Settings -> Controls, which is the durable
    // one and is itself reachable from both the Main Menu and Pause.
    //
    // 'playing' is excluded from this per-button check, matching the established
    // convention (see 'hud: level select panel's own equivalent test): setState's
    // early-return for playing/splash hides the whole .hud-panel wrapper rather than
    // toggling each button's own class, so the button's OWN class is not the right
    // oracle there.
    const { hud: h, root } = mount();
    h.setState('paused');
    expect(openBtn(root).classList.contains('hud-controllers-open--hidden')).toBe(false);
    for (const s of ['main-menu', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-controllers-open--hidden'), s).toBe(true);
    }
    // The durable entry, and it opens the SAME pane -- a second Controllers destination
    // would be the peer this issue removed, wearing a different hat.
    h.setState('main-menu');
    const fromSettings = root.querySelector('.hud-settings-controllers') as HTMLButtonElement;
    expect(fromSettings.closest('.hud-settings-section')!.getAttribute('data-section')).toBe(
      'controls',
    );
    fromSettings.dispatchEvent(new MouseEvent('click'));
    expect(view(root).classList.contains('hud-controllers--hidden')).toBe(false);
  });

  it('renders one row per slot, with the current source\'s label per SlotSource kind', () => {
    const { hud: h, root } = mount();
    h.setDetectedPads([{ padIndex: 2, id: 'Xbox Wireless Controller' }]);
    h.setControllers([
      { kind: 'keyboard' },
      { kind: 'gamepad', padIndex: 2 }, // connected -- matches the detected pad above
      { kind: 'gamepad', padIndex: 7 }, // NOT in the detected list -- disconnected
      { kind: 'bot' },
      { kind: 'none' },
    ]);
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    const rs = rows(root);
    expect(rs).toHaveLength(5);
    expect(currentOf(rs[0]).textContent).toBe('Keyboard / Mouse / Touch');
    expect(currentOf(rs[1]).textContent).toBe('Xbox Wireless Controller (index 2)');
    expect(currentOf(rs[1]).classList.contains('hud-controller-row-current--disconnected')).toBe(false);
    // Falls back to "Controller N" when the id is unknown -- unreachable once
    // disconnected (a pad's id cannot be read once unplugged), and dimmed.
    expect(currentOf(rs[2]).textContent).toBe('Controller 7 (index 7) — disconnected');
    expect(currentOf(rs[2]).classList.contains('hud-controller-row-current--disconnected')).toBe(true);
    expect(currentOf(rs[3]).textContent).toBe('Bot');
    expect(currentOf(rs[4]).textContent).toBe('Unassigned');
  });

  it('one candidate button per Keyboard/Bot/None plus one per DETECTED pad, the current one selected', () => {
    const { hud: h, root } = mount();
    h.setBotAssignmentAllowed(true);
    h.setDetectedPads([{ padIndex: 0, id: 'Pad A' }, { padIndex: 1, id: 'Pad B' }]);
    h.setControllers([{ kind: 'gamepad', padIndex: 1 }]);
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    const btns = candidateButtons(rows(root)[0]);
    // 3 fixed (Keyboard/Bot/None) + 2 detected pads = 5.
    expect(btns.map((b) => b.textContent)).toEqual(['Keyboard', 'Bot', 'None', 'Pad A (index 0)', 'Pad B (index 1)']);
    // Only the slot's CURRENT source (gamepad padIndex 1) carries the selection ring.
    expect(btns.map((b) => b.classList.contains('ui-selectable--on')))
      .toEqual([false, false, false, false, true]);
  });

  it('clicking a candidate button fires onReassignSlot with the SLOT and the candidate SlotSource', () => {
    const { hud: h, root } = mount();
    h.setBotAssignmentAllowed(true);
    h.setDetectedPads([{ padIndex: 3, id: 'Pad' }]);
    h.setControllers([{ kind: 'keyboard' }, { kind: 'gamepad', padIndex: 3 }]);
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    const calls: Array<[number, unknown]> = [];
    h.onReassignSlot((slot, source) => calls.push([slot, source]));
    const row1Buttons = candidateButtons(rows(root)[1]);
    row1Buttons[1].dispatchEvent(new MouseEvent('click')); // 'Bot'
    expect(calls).toEqual([[1, { kind: 'bot' }]]);
    const row0Buttons = candidateButtons(rows(root)[0]);
    row0Buttons[3].dispatchEvent(new MouseEvent('click')); // the one detected pad
    expect(calls).toEqual([[1, { kind: 'bot' }], [0, { kind: 'gamepad', padIndex: 3 }]]);
  });

  describe('a pad the browser reports but Tanks cannot read (issue #597)', () => {
    const unmapped = {
      padIndex: 1,
      id: 'HuiJia USB GamePad',
      unsupported: { code: 'unknown-mapping', mapping: '', id: 'HuiJia USB GamePad' },
    } as const;
    const reasonLine = (root: HTMLElement): HTMLElement =>
      view(root).querySelector('.hud-controllers-unsupported') as HTMLElement;
    const helpLine = (root: HTMLElement): HTMLElement =>
      view(root).querySelector('.hud-controllers-help') as HTMLElement;

    it('is a DISABLED candidate, labelled as unsupported, pointing at a visible reason', () => {
      // Negative controls: offering it as an ordinary choice leaves it enabled and unlabelled;
      // never showing the reason leaves the line hidden and the pointer dangling.
      const { hud: h, root } = mount();
      h.setDetectedPads([{ padIndex: 0, id: 'Xbox Wireless Controller' }, unmapped]);
      h.setControllers([{ kind: 'keyboard' }]);
      h.setState('main-menu');
      openBtn(root).dispatchEvent(new MouseEvent('click'));
      const btns = candidateButtons(rows(root)[0]);
      expect(btns.map((b) => b.textContent)).toEqual([
        'Keyboard',
        'None',
        'Xbox Wireless Controller (index 0)',
        'HuiJia USB GamePad (index 1) — not supported',
      ]);
      expect(btns.map((b) => b.disabled)).toEqual([false, false, false, true]);
      expect(btns.map((b) => b.getAttribute('aria-describedby'))).toEqual([null, null, null, 'hud-controllers-unsupported']);
      expect(reasonLine(root).classList.contains('hud-controllers-unsupported--hidden')).toBe(false);
      expect(reasonLine(root).id).toBe('hud-controllers-unsupported');
      expect(reasonLine(root).textContent).toBe(
        "HuiJia USB GamePad (index 1) isn't supported: Tanks can't read its buttons in this browser.",
      );
    });

    it('cannot be chosen: pressing its candidate reassigns nothing', () => {
      // Negative control: wiring the reassign listener onto every candidate lets a
      // synthetic click through and assigns a pad that reads no input.
      const { hud: h, root } = mount();
      h.setDetectedPads([unmapped]);
      h.setControllers([{ kind: 'keyboard' }]);
      h.setState('main-menu');
      openBtn(root).dispatchEvent(new MouseEvent('click'));
      const calls: unknown[] = [];
      h.onReassignSlot((slot, source) => calls.push([slot, source]));
      const btns = candidateButtons(rows(root)[0]);
      btns[btns.length - 1].dispatchEvent(new MouseEvent('click'));
      expect(calls).toEqual([]);
    });

    it('says why in its own words when a profile matched but the pad lacks the controls', () => {
      const { hud: h, root } = mount();
      h.setDetectedPads([
        {
          padIndex: 2,
          id: '',
          unsupported: { code: 'insufficient-controls', profileId: 'p', axes: 2, buttons: 4, requiredAxes: 4, requiredButtons: 16 },
        },
      ]);
      h.setControllers([{ kind: 'keyboard' }]);
      h.setState('main-menu');
      openBtn(root).dispatchEvent(new MouseEvent('click'));
      expect(reasonLine(root).textContent).toBe(
        "Controller 2 (index 2) isn't supported: it has too few buttons or sticks for Tanks.",
      );
    });

    it('marks a slot whose ASSIGNED pad cannot be read, rather than showing it as working', () => {
      // Negative control: the current-source label without the unsupported check reads
      // "HuiJia USB GamePad (index 1)", the same as a pad that works.
      const { hud: h, root } = mount();
      h.setDetectedPads([unmapped]);
      h.setControllers([{ kind: 'gamepad', padIndex: 1 }]);
      h.setState('main-menu');
      openBtn(root).dispatchEvent(new MouseEvent('click'));
      expect(currentOf(rows(root)[0]).textContent).toBe('HuiJia USB GamePad (index 1) — not supported');
    });

    it('shows no unsupported line when every listed pad is readable, and the help line always', () => {
      // Negative control: a reason line shown unconditionally is a persistent warning for
      // players with nothing wrong, which the issue rules out.
      const { hud: h, root } = mount();
      h.setDetectedPads([{ padIndex: 0, id: 'Xbox Wireless Controller' }]);
      h.setControllers([{ kind: 'keyboard' }]);
      h.setState('main-menu');
      openBtn(root).dispatchEvent(new MouseEvent('click'));
      expect(reasonLine(root).classList.contains('hud-controllers-unsupported--hidden')).toBe(true);
      expect(candidateButtons(rows(root)[0]).some((b) => b.disabled)).toBe(false);
      expect(helpLine(root).textContent).toBe(
        'Only controllers your browser reports appear here. Not listed? Press a button on it, or reconnect it.',
      );
      // Unplugging the unreadable pad clears the line on the next detection push.
      h.setDetectedPads([unmapped]);
      expect(reasonLine(root).classList.contains('hud-controllers-unsupported--hidden')).toBe(false);
      h.setDetectedPads([]);
      expect(reasonLine(root).classList.contains('hud-controllers-unsupported--hidden')).toBe(true);
    });
  });

  it('re-rendering (setControllers/setDetectedPads) REPLACES rows, never appends', () => {
    const { hud: h, root } = mount();
    h.setControllers([{ kind: 'keyboard' }]);
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(rows(root)).toHaveLength(1);
    h.setControllers([{ kind: 'keyboard' }, { kind: 'bot' }, { kind: 'none' }]);
    expect(rows(root)).toHaveLength(3);
    h.setControllers([{ kind: 'bot' }]);
    expect(rows(root)).toHaveLength(1);
  });

  it('the heading branches on which screen opened it: "Choose who\'s playing" at title, "Controllers" at pause', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(heading(root)).toBe("Choose who's playing");
    backBtn(root).dispatchEvent(new MouseEvent('click'));
    h.setState('playing');
    h.setState('paused');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(heading(root)).toBe('Controllers');
  });

  it('Back routes to shownState, not a hardcoded \'title\' -- opening from PAUSED and clicking ' +
    'Back must return to the live round, not abandon it', () => {
    // Fake timers from the START, not after the click: Back now CROSSFADES rather than
    // cutting, and a timer installed after the click cannot advance one scheduled
    // before it. The closing pane keeps its `--hidden` off for the transition it is
    // leaving on, so the assertion below reads the SETTLED state. Where Back lands is
    // what this test is for; the mid-transition frame is owned by `crossfades a panel
    // CLOSE, not only its open`.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      h.setState('playing');
      h.setState('paused');
      openBtn(root).dispatchEvent(new MouseEvent('click'));
      expect(view(root).classList.contains('hud-controllers--hidden')).toBe(false);
      backBtn(root).dispatchEvent(new MouseEvent('click'));
      vi.advanceTimersByTime(1000);
      expect(view(root).classList.contains('hud-controllers--hidden')).toBe(true);
      // Landed back on PAUSED, not title -- the pause panel's own Resume button is
      // visible again, and the title-only Continue/New Game pair is not.
      expect((root.querySelector('.hud-action') as HTMLButtonElement).textContent).toBe('Resume');
    } finally {
      vi.useRealTimers();
    }
  });

  it('onControllersOpen/onControllersClose fire once per ACTUAL transition, matching onCustomizeOpen/Close\'s own contract', () => {
    const { hud: h, root } = mount();
    let opens = 0;
    let closes = 0;
    h.onControllersOpen(() => { opens += 1; });
    h.onControllersClose(() => { closes += 1; });
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(opens).toBe(1);
    expect(closes).toBe(0);
    backBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(opens).toBe(1);
    expect(closes).toBe(1);
    // A redundant close (setState while already closed) must not fire again.
    h.setState('playing');
    expect(closes).toBe(1);
  });

  it('is closed unconditionally by ANY state change -- setState\'s close chokepoint, not just Back ' +
    '-- and fires onControllersClose either way, so a caller cleaning up a live listener never misses it', () => {
    const { hud: h, root } = mount();
    let closes = 0;
    h.onControllersClose(() => { closes += 1; });
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    h.setState('playing'); // NOT via Back -- e.g. Resume from the pause-opened panel
    expect(view(root).classList.contains('hud-controllers--hidden')).toBe(true);
    expect(closes).toBe(1);
  });

  /**
   * The Controllers section of About & Legal, as text: the `h2` whose heading is "Controllers"
   * plus every following sibling up to the next `h2`. Read this way rather than by a class of
   * its own, because the section deliberately reuses `.hud-about-subtitle`/`-subline`/`-line`
   * -- adding a fourth class would mean touching four selector inventories in hud.css.test.ts
   * for no styling difference.
   */
  const controllerHelp = (root: HTMLElement): string => {
    const about = root.querySelector('.hud-about') as HTMLElement;
    const heads = Array.from(about.querySelectorAll('h2'));
    const start = heads.find((h) => (h.textContent ?? '').trim() === 'Controllers');
    expect(start, 'About & Legal has no Controllers section').toBeDefined();
    const out: string[] = [];
    for (let n = start!.nextElementSibling; n && n.tagName !== 'H2'; n = n.nextElementSibling) {
      out.push(n.textContent ?? '');
    }
    return out.join(' ');
  };

  it('About & Legal explains the Gamepad API boundary, while the pane keeps its one line (issue #597)', () => {
    const { root } = mount();
    const help = controllerHelp(root);
    // The three facts the issue's scope asks a help destination to carry.
    expect(help, 'the browser boundary').toContain('Gamepad API');
    expect(help, 'why a controller may not be listed').toMatch(/press a button/i);
    expect(help, 'visible-but-unreadable is distinct from absent').toMatch(/not supported/i);
    expect(help, 'adapters vary, without naming any').toMatch(/adapter/i);

    // ...and the pane is NOT where this went. Its single constant line is unchanged, which is
    // the half of #597 that shipped in PR #714 and the reason the scope says to point at a
    // help destination instead of growing the panel.
    const pane = root.querySelector('.hud-controllers-help') as HTMLElement;
    expect(pane.textContent).toBe(
      'Only controllers your browser reports appear here. Not listed? Press a button on it, or reconnect it.',
    );
  });

  it('THE HARDWARE-MANUAL GUARD: the help names no product, vendor or adapter model', () => {
    // This is the assertion the section exists to be held to. The ruling chose generic
    // Gamepad-API help over waiting for #595 to verify real hardware, and the argument against
    // that choice was that generic help drifts into a compatibility table the moment someone
    // adds "except on brand X". #595 owns every product-specific claim; this keeps the boundary
    // mechanical instead of relying on a reviewer noticing.
    //
    // NOTE on what is NOT in the list: bare "switch". The copy says "an adapter with a mode
    // switch", so banning that word would fail on correct copy -- the console is banned as
    // "nintendo" and "switch pro" instead. An assertion that cannot help but fire is worse
    // than none.
    const NAMES = [
      'xbox', 'playstation', 'dualshock', 'dualsense', 'nintendo', 'switch pro',
      'gamecube', 'wii', 'logitech', '8bitdo', 'mayflash', 'steam deck', 'sony', 'microsoft',
    ];
    const { root } = mount();
    const help = controllerHelp(root).toLowerCase();
    const found = NAMES.filter((n) => help.includes(n));
    expect(found, 'a product name here makes this a hardware manual -- that is #595\'s').toEqual([]);
    // The control for the guard itself: it must be reading real copy, not an empty string.
    // Without this, deleting the whole section would satisfy the assertion above.
    expect(help.length, 'the guard must be scanning actual help text').toBeGreaterThan(200);
  });
});
