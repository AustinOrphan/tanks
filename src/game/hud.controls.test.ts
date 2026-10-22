// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, steppedVolume, VOLUME_ANNOUNCE_MS, type GameplayStatus, type Hud } from './hud';
import { focusableControls } from './focusable';
import { ACHIEVEMENTS } from './achievements';
import { DEFAULT_VOLUME } from '../audio/manifest';
import { settingRelevance } from './control-relevance';
import { NO_CAPABILITIES } from './capabilities';
import { installComputedStyleCache } from './computed-style-cache';

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

// The one volume slider since issue #226, in Settings -> Audio. It used to have a twin
// in the topbar; the mirror-writing those two needed is what disappeared with it.
const volumeSlider = (root: HTMLElement): HTMLInputElement =>
  root.querySelector('.hud-settings-volume') as HTMLInputElement;

describe('createHud volume control', () => {
  it('bakes NO level into the markup -- the page is the only source (issue #324)', () => {
    const { root } = mount();

    // The markup carried `value="${DEFAULT_VOLUME}"` until issue #324, so that a slider
    // nobody had pushed to still agreed with the engine. Since issue #320 the level is a
    // persisted SETTING, which made that default a guess: a returning player who chose
    // 0.2 saw 0.6 until the first push landed, and the control lied about the state it
    // controls for exactly as long as that took.
    //
    // Removing it also takes `hud.ts`'s last import from the audio layer, which is why
    // the dependency allowlist no longer lists this file (dependency-direction.test.ts).
    // The engine-agreement property did not disappear, it moved: `settings.ts` resolves
    // an unset preference to DEFAULT_VOLUME (settings.test.ts pins the constant), and
    // `route-host.ts` pushes the resolved value in the same synchronous call that builds
    // this DOM -- so no frame can render between the two.
    expect(volumeSlider(root).hasAttribute('value')).toBe(false);
  });

  it('setVolume shows the persisted level, and there is exactly ONE slider to show it on', () => {
    // The page pushes the stored value through here at boot -- so a returning player who
    // set 0.2 must not see 0.6. Since issue #324 that push is the ONLY thing that ever
    // gives this slider a level; the markup no longer carries one (see above).
    //
    // The count is the other half, and it is what issue #226 made assertable: while the
    // topbar carried a twin, "setVolume moves BOTH sliders" was a real obligation and
    // dropping either write left one control silently stale. One control cannot drift
    // from itself, so the guard that replaces it is that a second one has not come back.
    const { hud, root } = mount();
    hud.setVolume(0.2);
    expect(volumeSlider(root).value).toBe('0.2');
    expect(root.querySelectorAll('input[type="range"]').length).toBe(1);
  });

  it('keeps DEFAULT_VOLUME on the step grid the browser will snap to', () => {
    // Real browsers sanitize <input type="range"> onto the `step` grid; jsdom does not.
    // Still load-bearing after issue #324 removed the markup default, because the value
    // the page pushes is the resolved SETTING, which is DEFAULT_VOLUME whenever the player
    // has never chosen one -- so an off-grid default would be snapped on arrival, and the
    // real HUD would display 0.33 while the engine ran at 0.3333..., a lie below the
    // resolution of every other test here.
    const { root } = mount();
    const step = Number(volumeSlider(root).step);

    // Tolerance, not equality: 0.6 / 0.01 is 59.999999999999993 in binary
    // floating point, so an exact `toBe(Math.round(...))` would fail on a
    // value that is perfectly on-grid.
    const steps = DEFAULT_VOLUME / step;
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
  });

  it('opts out of Firefox form-value restoration', () => {
    const { root } = mount();
    expect(volumeSlider(root).getAttribute('autocomplete')).toBe('off');
  });

  it('reports slider movement to subscribers', () => {
    const { hud: h, root } = mount();
    const seen: number[] = [];
    h.onVolumeChange((v) => seen.push(v));

    const slider = volumeSlider(root);
    slider.value = '0.3';
    slider.dispatchEvent(new Event('input'));

    expect(seen).toEqual([0.3]);
  });
});

describe('the volume steppers: a controller reaches the level (issue #918)', () => {
  // The owner's ruling of 2026-10-13: − and + buttons beside the slider, in the button walk,
  // with the slider kept as the pointer control and still outside that walk.
  const down = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-settings-volume-down') as HTMLButtonElement;
  const up = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-settings-volume-up') as HTMLButtonElement;

  it('steps to the next tenth in its direction, snapping a level between tenths', () => {
    // Literal cases rather than a loop over a computed grid, so each one fails by name.
    expect(steppedVolume(0.5, 1)).toBe(0.6);
    expect(steppedVolume(0.5, -1)).toBe(0.4);
    // Off the grid, where a slider drag leaves it: the NEARER tenth that way, not a full step.
    expect(steppedVolume(0.37, 1)).toBe(0.4);
    expect(steppedVolume(0.37, -1)).toBe(0.3);
    // Whole percent, not float addition: 0.7 + 0.1 is 0.7999999999999999.
    expect(steppedVolume(0.7, 1)).toBe(0.8);
    expect(steppedVolume(0.3, -1)).toBe(0.2);
  });

  it('stops at either end of the range', () => {
    expect(steppedVolume(1, 1)).toBe(1);
    expect(steppedVolume(0.95, 1)).toBe(1);
    expect(steppedVolume(0, -1)).toBe(0);
    expect(steppedVolume(0.05, -1)).toBe(0);
  });

  it('a press moves the slider and reports the new level, through the slider\'s own subscribers', () => {
    const { hud: h, root } = mount();
    h.setVolume(0.5);
    const seen: number[] = [];
    h.onVolumeChange((v) => seen.push(v));

    up(root).click();
    expect(seen, 'the + press reported no level').toEqual([0.6]);
    expect(volumeSlider(root).value, 'the slider did not move with the + press').toBe('0.6');

    down(root).click();
    down(root).click();
    expect(seen).toEqual([0.6, 0.5, 0.4]);
    expect(volumeSlider(root).value).toBe('0.4');
  });

  it('a press at either end reports nothing, since the level did not change', () => {
    // Negative control for the case above: the same press, at a bound.
    const { hud: h, root } = mount();
    const seen: number[] = [];
    h.onVolumeChange((v) => seen.push(v));

    h.setVolume(1);
    up(root).click();
    h.setVolume(0);
    down(root).click();
    expect(seen).toEqual([]);
  });

  it('a pad walks onto both steppers in Settings and its Confirm raises the level', () => {
    // The point of the ruling: before #918 nothing in Settings changed the volume for a
    // player holding only a controller. Entered the way a pad enters it -- the pane's
    // container takes the arrival, and Down walks -- rather than by focusing a button.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      vi.advanceTimersByTime(1000);
      h.setVolume(0.5);
      (root.querySelector('.hud-settings-open') as HTMLButtonElement).click();
      vi.advanceTimersByTime(1000);
      const pane = root.querySelector('.hud-settings') as HTMLElement;
      const controls = focusableControls(pane);
      expect(controls, 'the − stepper is not in the walk').toContain(down(root));
      expect(controls, 'the + stepper is not in the walk').toContain(up(root));
      expect(controls, 'the slider joined the walk; it is the pointer control').not.toContain(
        volumeSlider(root),
      );

      const seen: number[] = [];
      h.onVolumeChange((v) => seen.push(v));
      for (let i = 0; i < controls.length && document.activeElement !== up(root); i++) h.act('down');
      expect(document.activeElement, 'the pad never reached the + stepper').toBe(up(root));
      expect(h.act('confirm')).toBe(true);
      expect(seen, 'the pad\'s Confirm on + did not raise the level').toEqual([0.6]);
      // A pad's Confirm is a keyboard activation (`click()` reports detail 0), so focus stays
      // on the stepper and the next press steps again -- ten presses cross the whole range.
      expect(document.activeElement, 'the Confirm took focus off the stepper').toBe(up(root));
      h.act('confirm');
      expect(seen).toEqual([0.6, 0.7]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops focus from either stepper clicked with the mouse, as every HUD button does', () => {
    // A focused control claims the arrows and Space; a mouse player who clicks a stepper must
    // not be left with them claimed. `blurIfPointer`, the rule every other button here
    // follows. Both steppers spelled out, since each registers its own listener. Negative
    // control: the pad case above, where the same press is a keyboard activation.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    (root.querySelector('.hud-settings-open') as HTMLButtonElement).click();
    for (const [name, btn] of [['−', down(root)], ['+', up(root)]] as const) {
      btn.focus();
      expect(document.activeElement, `precondition: focus did not land on ${name}`).toBe(btn);
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      expect(document.activeElement, `the ${name} stepper kept focus after a mouse click`).not.toBe(btn);
    }
  });

  it('keeps the three read-only developer outputs out of the walk, and a pad Down out of one re-enters it', () => {
    // #918's other criterion. Each <textarea> holds text to copy, which a pad cannot do, and
    // is filled by a button that is in the walk; a Copy press focuses its field, so the next
    // pad Down has to land back on a control rather than nowhere -- shown for the diagnostics
    // output (the self-test pane takes the pad off the menu, so only Back answers there).
    // Revealed by lifting the hidden class, which is all the filling code does to visibility.
    vi.useFakeTimers();
    try {
      const root = document.createElement('div');
      document.body.appendChild(root);
      const h = createHud(root, { developerMode: true });
      hud = h;
      for (const [field, pane] of [
        ['.hud-diag-out', '.hud-devtools'],
        ['.hud-devcfg-copyfield', '.hud-devcfg'],
        ['.hud-selftest-report', '.hud-selftest'],
      ] as const) {
        const out = root.querySelector(field) as HTMLTextAreaElement;
        out.className = out.className.replace(/\S+--hidden/, '');
        expect(focusableControls(root.querySelector(pane) as HTMLElement), `${field} joined the walk`).not.toContain(out);
      }

      h.setState('main-menu');
      vi.advanceTimersByTime(1000);
      (root.querySelector('.hud-devtools-open') as HTMLButtonElement).click();
      vi.advanceTimersByTime(1000);
      const devtools = root.querySelector('.hud-devtools') as HTMLElement;
      const diag = root.querySelector('.hud-diag-out') as HTMLTextAreaElement;
      diag.focus();
      expect(document.activeElement, 'precondition: the output did not take focus').toBe(diag);
      expect(h.act('down')).toBe(true);
      expect(document.activeElement, 'a pad Down from the output did not re-enter the walk').toBe(
        focusableControls(devtools)[0],
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what a screen reader hears of the volume (follow-up to issue #918)', () => {
  // The slider's own value is 0..1; `aria-valuetext` is what a screen reader says instead. A
  // stepper press leaves focus on the button, so the result is announced through the page's
  // one live region (`.hud-announce`), once the presses stop.
  const valueText = (root: HTMLElement): string | null => volumeSlider(root).getAttribute('aria-valuetext');
  const announced = (root: HTMLElement): string =>
    (root.querySelector('.hud-announce') as HTMLElement).textContent ?? '';
  const up = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-settings-volume-up') as HTMLButtonElement;

  it('the slider speaks its level as a percentage, wherever the level moves', () => {
    // Three writers, one case each: the page's push, a stepper press and a slider drag.
    const { hud: h, root } = mount();
    h.setVolume(0.6);
    expect(valueText(root), 'the page push left the slider reading its raw value').toBe('60%');
    up(root).click();
    expect(valueText(root), 'a stepper press left the old percentage').toBe('70%');
    volumeSlider(root).value = '0.33';
    volumeSlider(root).dispatchEvent(new Event('input'));
    expect(valueText(root), 'a drag left the old percentage').toBe('33%');
  });

  it('a stepper press announces the level it ended on, once the presses stop', () => {
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setVolume(0.5);
      up(root).click();
      vi.advanceTimersByTime(VOLUME_ANNOUNCE_MS - 150);
      up(root).click();
      // The first press's wait has run out by now, so an announcer that did not restart its
      // wait on the second press would already have spoken "Volume 60%".
      vi.advanceTimersByTime(VOLUME_ANNOUNCE_MS - 100);
      expect(announced(root), 'a press spoke before the burst ended').toBe('');
      vi.advanceTimersByTime(100);
      expect(announced(root)).toBe('Volume 70%');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a slider drag announces nothing: the focused slider speaks its own value', () => {
    // Negative control for the case above: the same level change, from the slider.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setVolume(0.5);
      volumeSlider(root).value = '0.8';
      volumeSlider(root).dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(VOLUME_ANNOUNCE_MS * 4);
      expect(announced(root)).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a press at either end speaks the level it stayed at, and reports nothing', () => {
    // Silence at the limit would leave a screen-reader user unsure the press landed. The level
    // did not move, so the subscribers hear nothing -- only the reader is answered. Both ends,
    // spelled out, since each is reached by its own button.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      const down = root.querySelector('.hud-settings-volume-down') as HTMLButtonElement;
      const seen: number[] = [];
      h.onVolumeChange((v) => seen.push(v));
      h.setVolume(1);
      up(root).click();
      vi.advanceTimersByTime(VOLUME_ANNOUNCE_MS);
      expect(announced(root), 'a + press at full volume went unanswered').toBe('Volume 100%');
      h.setVolume(0);
      down.click();
      vi.advanceTimersByTime(VOLUME_ANNOUNCE_MS);
      expect(announced(root), 'a − press at silence went unanswered').toBe('Volume 0%');
      expect(seen, 'a press at an end reported a level that did not change').toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pending announcement does not outlive the HUD', () => {
    // A HUD disposed inside the wait must not leave a timer writing into the region it
    // discarded -- the leak rule every other HUD timer follows.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      const region = root.querySelector('.hud-announce') as HTMLElement;
      h.setVolume(0.5);
      up(root).click();
      h.dispose();
      hud = null;
      vi.advanceTimersByTime(VOLUME_ANNOUNCE_MS * 4);
      expect(region.textContent, 'the announcement fired after dispose').toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createHud stats', () => {
  /** A campaign-board status; the two numbers are what these cases are about. */
  const board = (lives: number, enemies: number): GameplayStatus => ({
    kind: 'campaign',
    mission: 1,
    missions: 1,
    lives,
    enemies,
  });

  it('renders lives and enemies remaining', () => {
    const { hud: h, root } = mount();

    h.setStatus(board(2, 1));

    expect((root.querySelector('.hud-lives') as HTMLElement).textContent).toBe('2');
    expect((root.querySelector('.hud-enemies') as HTMLElement).textContent).toBe('1');
  });

  it('does not rewrite the text node when the value is unchanged', () => {
    // loop.ts pushes a status on every simulated frame. textContent's setter replaces the
    // text node even for an identical string, invalidating layout at 60 Hz for values
    // that change a handful of times per round. The two pushes here are DISTINCT objects
    // carrying the same numbers, which is what a per-frame projection actually hands over
    // -- an identity check on the status would pass this case while writing every frame.
    const { hud: h, root } = mount();
    h.setStatus(board(3, 3));
    const node = (root.querySelector('.hud-lives') as HTMLElement).firstChild;

    h.setStatus(board(3, 3));

    expect((root.querySelector('.hud-lives') as HTMLElement).firstChild).toBe(node);
  });

  it('a versus status leaves the two numbers alone rather than blanking them', () => {
    // The control for the memo above, and a statement about what `GameplayStatus`'s
    // versus arm means: it has no lives and no enemy count, so there is nothing to write
    // -- and the elements are hidden by their own class anyway. Blanking them would be
    // invisible work that the memo would then have to un-do on the way back.
    const { hud: h, root } = mount();
    h.setStatus(board(2, 1));
    h.setStatus({ kind: 'versus', mission: 1, missions: 1, stocks: [{ slot: 0, stock: 3 }] });
    expect((root.querySelector('.hud-lives') as HTMLElement).textContent).toBe('2');
    expect((root.querySelector('.hud-enemies') as HTMLElement).textContent).toBe('1');
  });
});

describe('createHud mute button', () => {
  // In Settings -> Audio since issue #226, and nowhere else: the topbar chip is gone.
  const muteBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-settings-mute') as HTMLButtonElement;

  it('starts unmuted and says so', () => {
    const { root } = mount();
    expect(muteBtn(root).getAttribute('aria-pressed')).toBe('false');
    expect(muteBtn(root).textContent).toBe('Mute (M)');
  });

  it('reflects mute state, so a muted game is distinguishable from a broken one', () => {
    const { hud: h, root } = mount();

    h.setMuted(true);
    expect(muteBtn(root).getAttribute('aria-pressed')).toBe('true');
    expect(muteBtn(root).textContent).toBe('Muted (M)');

    h.setMuted(false);
    expect(muteBtn(root).getAttribute('aria-pressed')).toBe('false');
    expect(muteBtn(root).textContent).toBe('Mute (M)');
  });

  it('notifies subscribers when clicked', () => {
    const { hud: h, root } = mount();
    let clicks = 0;
    h.onMuteToggle(() => clicks++);

    muteBtn(root).dispatchEvent(new MouseEvent('click'));

    expect(clicks).toBe(1);
  });
});

describe('createHud does not keep keyboard focus after a pointer interaction', () => {
  // Mute and the slider live in Settings -> Audio (issue #226), so each case opens Settings
  // first and checks that focus LANDED before it acts. `focus()` refuses an element that is
  // not rendered -- browsers always did, jsdom does from 30.1.2 -- and on the hidden pane the
  // two "drops focus" cases passed with focus never having arrived: with the blur listener
  // deleted they still passed under jsdom 30.1.2 (measured), so they asserted nothing.
  // Negative control for each precondition: drop the `.hud-settings-open` click inside
  // `openSettings`, and under jsdom 30.1.2 the precondition fails before the action runs.
  const openSettings = (): HTMLElement => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    (root.querySelector('.hud-settings-open') as HTMLButtonElement).click();
    return root;
  };

  it('drops focus from the mute button when it is clicked with the mouse', () => {
    // A focused HUD control legitimately claims Space/Enter/arrows, so a mouse player who
    // clicks Mute would silently lose arrow-key driving and the Space mine-drop until they
    // clicked elsewhere. Keyboard activation reports detail 0 and must KEEP focus, so
    // anyone tabbing through the HUD still has it work.
    const root = openSettings();
    const btn = root.querySelector('.hud-settings-mute') as HTMLButtonElement;

    btn.focus();
    expect(document.activeElement, 'precondition: focus did not land on Mute').toBe(btn);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(document.activeElement).not.toBe(btn);
  });

  it('keeps focus when the mute button is activated from the keyboard', () => {
    const root = openSettings();
    const btn = root.querySelector('.hud-settings-mute') as HTMLButtonElement;

    btn.focus();
    expect(document.activeElement, 'precondition: focus did not land on Mute').toBe(btn);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(document.activeElement).toBe(btn);
  });

  it('drops focus from the volume slider when the drag ends', () => {
    const root = openSettings();
    const slider = volumeSlider(root);

    slider.focus();
    expect(document.activeElement, 'precondition: focus did not land on the slider').toBe(slider);
    slider.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(document.activeElement).not.toBe(slider);
  });
});

describe('hud: the fire-mode toggle', () => {
  it('shows the current mode, labelled so all three modes read as different', () => {
    const { hud: h, root } = mount();
    const toggle = () => root.querySelector('.hud-firemode-toggle') as HTMLButtonElement;

    h.setFireMode('tap');
    expect(toggle().textContent).toMatch(/tap/i);
    const tapLabel = toggle().textContent;
    const tapAria = toggle().getAttribute('aria-label');

    h.setFireMode('double');
    expect(toggle().textContent).toMatch(/double/i);
    expect(toggle().textContent).not.toBe(tapLabel);
    const doubleLabel = toggle().textContent;
    expect(toggle().getAttribute('aria-label')).not.toBe(tapAria);

    h.setFireMode('button');
    expect(toggle().textContent).toMatch(/button/i);
    expect(toggle().textContent).not.toBe(tapLabel);
    expect(toggle().textContent).not.toBe(doubleLabel);
  });

  it('taps the toggle and reports the NEXT mode in the cycle, from a real click at the button', () => {
    // Same composition-blindness reasoning as the Pause/Mine/Fire/scheme-toggle tests:
    // drive a real event at a real element rather than only invoking the callback.
    const { hud: h, root } = mount();
    const seen: string[] = [];
    h.onFireModeChange((m) => seen.push(m));
    h.setFireMode('tap');

    const toggle = root.querySelector('.hud-firemode-toggle') as HTMLButtonElement;
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen, 'the toggle is not wired to anything').toEqual(['double']);

    // The button does NOT flip its own label -- it only reports the choice. The loop
    // echoes the ACCEPTED value back via setFireMode, same convention as the scheme
    // toggle, so the label must not move until that echo arrives.
    expect(root.querySelector('.hud-firemode-toggle')!.textContent).toMatch(/tap/i);

    h.setFireMode('double'); // the loop's echo
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen).toEqual(['double', 'button']);

    h.setFireMode('button'); // the loop's echo
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen, 'the third click did not wrap back to tap').toEqual(['double', 'button', 'tap']);
  });

  it('lives in the Settings pane, under Controls', () => {
    const { root } = mount();
    const toggle = root.querySelector('.hud-firemode-toggle') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    const section = toggle.closest('.hud-settings-section') as HTMLElement;
    expect(section, 'the toggle is not inside a Settings section').not.toBeNull();
    expect(section.dataset.section).toBe('controls');
  });
});

describe('hud: the haptics toggle', () => {
  it('shows the current state, labelled so on/off read as different', () => {
    const { hud: h, root } = mount();
    const toggle = () => root.querySelector('.hud-haptics-toggle') as HTMLButtonElement;

    h.setHaptics(true);
    expect(toggle().textContent).toMatch(/on/i);
    const onLabel = toggle().textContent;
    const onAria = toggle().getAttribute('aria-label');

    h.setHaptics(false);
    expect(toggle().textContent).toMatch(/off/i);
    // Not just different case of the same string -- genuinely distinct copy, same
    // discipline as the scheme and fire-mode toggles.
    expect(toggle().textContent).not.toBe(onLabel);
    expect(toggle().getAttribute('aria-label')).not.toBe(onAria);
  });

  it('taps the toggle and reports the OTHER state, from a real click at the button', () => {
    // Same composition-blindness reasoning as the Pause/Mine/Fire/scheme/fire-mode
    // toggle tests: drive a real event at a real element rather than only invoking the
    // callback directly.
    const { hud: h, root } = mount();
    const seen: boolean[] = [];
    h.onHapticsChange((on) => seen.push(on));
    h.setHaptics(true);

    const toggle = root.querySelector('.hud-haptics-toggle') as HTMLButtonElement;
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen, 'the toggle is not wired to anything').toEqual([false]);

    // The button does NOT flip its own label -- it only reports the choice. The loop
    // echoes the ACCEPTED value back via setHaptics, same convention as the scheme and
    // fire-mode toggles, so the label must not move until that echo arrives.
    expect(root.querySelector('.hud-haptics-toggle')!.textContent).toMatch(/on/i);

    h.setHaptics(false); // the loop's echo
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen).toEqual([false, true]);
  });

  it('lives in the Settings pane, under Controls rather than Accessibility', () => {
    // The placement is a decision, not an accident: device vibration is feedback FROM an
    // input device and lives under `input` in the settings model, while Accessibility
    // holds the presentation policies -- the motion control issue #289 added, and the
    // UI-scale one #290 will.
    const { root } = mount();
    const toggle = root.querySelector('.hud-haptics-toggle') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    const section = toggle.closest('.hud-settings-section') as HTMLElement;
    expect(section, 'the toggle is not inside a Settings section').not.toBeNull();
    expect(section.dataset.section).toBe('controls');
  });
});

/*
 * ISSUE #289: the Settings -> Accessibility motion control.
 *
 * The gap it closes is not a missing policy -- `effective-settings.ts` has resolved
 * `presentation.motion` since #320 and `transitionMs` has honoured it since #364 -- but a
 * missing CONTROL. A player whose device asks for reduced motion lost every menu
 * transition with nothing anywhere to say so or override it.
 */
describe('hud: the motion toggle (issue #289)', () => {
  const toggle = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-motion-toggle') as HTMLButtonElement;

  it('shows the current preference, labelled so all three read as different', () => {
    const { hud: h, root } = mount();

    h.setMotion('system');
    const systemLabel = toggle(root).textContent;
    const systemAria = toggle(root).getAttribute('aria-label');

    h.setMotion('full');
    const fullLabel = toggle(root).textContent;
    expect(fullLabel).not.toBe(systemLabel);
    expect(toggle(root).getAttribute('aria-label')).not.toBe(systemAria);

    h.setMotion('reduced');
    expect(toggle(root).textContent).not.toBe(systemLabel);
    expect(toggle(root).textContent).not.toBe(fullLabel);

    // ...and in PLAYER language, not the stored ids. 'system' in particular is an
    // implementation word: the label has to say what it does, and the three labels being
    // merely distinct would be satisfied by printing the raw ids.
    h.setMotion('system');
    expect(toggle(root).textContent).toMatch(/device/i);
    h.setMotion('full');
    expect(toggle(root).textContent).toMatch(/full/i);
    expect(toggle(root).textContent).not.toMatch(/system/i);
    h.setMotion('reduced');
    expect(toggle(root).textContent).toMatch(/reduced/i);
  });

  it('puts the resolved policy on the HUD root, the only view the stylesheet has of it (issue #631)', () => {
    // THE MECHANISM, not the label. Until issue #631 there was no CSS selector for the
    // resolved preference at all, so hud.css keyed its reduced-motion rules off
    // `@media (prefers-reduced-motion: reduce)` -- the raw OS query, which cannot see the
    // in-app setting and disagreed with it in both directions.
    //
    // `transitionMs()` never needed a selector because a transition is a DURATION and can
    // be driven to zero from TypeScript. A keyframe animation cannot. This class is the
    // whole bridge, and a mutation that severs it (`reduced-motion-class-never-reaches-the-root`)
    // SURVIVED until this test existed: every assertion in the suite was about the
    // stylesheet's text, which stays perfectly correct while nothing ever matches it.
    // `.hud`, not the container: `createHud` builds its own root inside whatever element it
    // is handed, and that inner one is what every `.hud--*` selector in the stylesheet
    // hangs off. Asserting on the container passes an element that never carries any HUD
    // class at all -- which is how the first draft of this test failed for the wrong
    // reason and, had the toggle been written against the container, would have PASSED for
    // the wrong reason.
    const { hud: h } = mount();
    const hudEl = document.querySelector('.hud') as HTMLElement;
    expect(hudEl, 'no .hud root to check').not.toBeNull();
    expect(hudEl.classList.contains('hud--reduced-motion'), 'set before anyone asked').toBe(false);

    h.setReducedMotion(true);
    expect(hudEl.classList.contains('hud--reduced-motion'), 'the stylesheet cannot see the policy').toBe(true);

    // Back off again -- a one-way toggle would leave a player who turned motion back on
    // with a permanently still HUD, and is the likelier bug of the two.
    h.setReducedMotion(false);
    expect(hudEl.classList.contains('hud--reduced-motion'), 'the class never comes off').toBe(false);
  });

  it('reports the RESOLVED policy on Match device, which is the state its own name cannot say', () => {
    // The owner's report is the case: with the device asking for reduced motion, a menu
    // that never animates and a control reading "Match device" leave nothing on screen to
    // connect the two. `setReducedMotion` carries the resolved answer, and it must move
    // the label whenever it moves -- including with no click at all, which is what an OS
    // preference flipping while the pane is open looks like.
    const { hud: h, root } = mount();
    h.setMotion('system');

    h.setReducedMotion(false);
    const followingFull = toggle(root).textContent ?? '';
    h.setReducedMotion(true);
    const followingReduced = toggle(root).textContent ?? '';
    expect(followingReduced).not.toBe(followingFull);
    expect(followingReduced).toMatch(/reduced/i);
    expect(followingFull).not.toMatch(/reduced/i);

    // NEGATIVE CONTROL: the two states a player picked deliberately already say what they
    // do, and must NOT pick up a suffix that repeats it or -- worse -- contradicts it.
    // Without this, a label that simply appended the resolved policy everywhere would pass
    // the assertions above while rendering "Motion: Full (reduced)".
    for (const resolved of [false, true]) {
      h.setMotion('full');
      h.setReducedMotion(resolved);
      const full = toggle(root).textContent;
      h.setReducedMotion(!resolved);
      expect(toggle(root).textContent, 'Full moved with a policy it does not follow').toBe(full);
    }
  });

  it('taps the toggle and reports the NEXT preference in the cycle, from a real click at the button', () => {
    // Same composition-blindness reasoning as the scheme and fire-mode toggles: drive a
    // real event at a real element rather than only invoking the callback.
    const { hud: h, root } = mount();
    const seen: string[] = [];
    h.onMotionChange((p) => seen.push(p));
    h.setMotion('system');

    toggle(root).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen, 'the toggle is not wired to anything').toEqual(['full']);

    // The button does NOT flip its own label -- it only reports the choice. The page
    // echoes the ACCEPTED value back via setMotion once the store has taken it, same
    // convention as the scheme and fire-mode toggles, so the label must not move until
    // that echo arrives.
    expect(toggle(root).textContent).toMatch(/device/i);

    h.setMotion('full'); // the page's echo
    toggle(root).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen).toEqual(['full', 'reduced']);

    h.setMotion('reduced'); // the page's echo
    toggle(root).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen, 'the third click did not wrap back to following the device').toEqual([
      'full',
      'reduced',
      'system',
    ]);
  });

  it('lives in the Settings pane, under Accessibility', () => {
    // Where the issue puts it, and the reason the Accessibility section was declared empty
    // for as long as it was. A motion policy is presentation, not input -- it belongs
    // beside the UI-scale control #290 adds, not with the touch controls.
    const { root } = mount();
    expect(toggle(root)).not.toBeNull();
    const section = toggle(root).closest('.hud-settings-section') as HTMLElement;
    expect(section, 'the toggle is not inside a Settings section').not.toBeNull();
    expect(section.dataset.section).toBe('accessibility');
  });
});

/*
 * ISSUE #540: the Settings -> Accessibility render-quality control.
 *
 * The gap it closes is the same shape as #289's: the presets have existed in
 * `render/quality.ts` since #113 and `?dev=1&quality=` has selected one since, but nothing
 * a player can reach ever did. That was tolerable while the presets tuned antialiasing and
 * shadow resolution; PR #546 made `low` drop the muzzle-smoke effect outright, so the
 * preset became a performance lever with no handle on it.
 */
describe('hud: the quality toggle (issue #540)', () => {
  const toggle = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-quality-toggle') as HTMLButtonElement;

  it('shows the current preset, labelled so all three read as different', () => {
    const { hud: h, root } = mount();

    h.setQuality('high');
    const highLabel = toggle(root).textContent;
    const highAria = toggle(root).getAttribute('aria-label');

    h.setQuality('medium');
    const mediumLabel = toggle(root).textContent;
    expect(mediumLabel).not.toBe(highLabel);
    expect(toggle(root).getAttribute('aria-label')).not.toBe(highAria);

    h.setQuality('low');
    expect(toggle(root).textContent).not.toBe(highLabel);
    expect(toggle(root).textContent).not.toBe(mediumLabel);

    // ...and each names its own preset, not merely a distinct string. Three labels that
    // were only different would be satisfied by 'A', 'B', 'C'.
    h.setQuality('high');
    expect(toggle(root).textContent).toMatch(/high/i);
    h.setQuality('medium');
    expect(toggle(root).textContent).toMatch(/medium/i);
    h.setQuality('low');
    expect(toggle(root).textContent).toMatch(/low/i);
  });

  it('says WHEN the choice takes effect, which the label cannot show', () => {
    // The one honest thing this control has to carry. A session builds its renderer once
    // (loop.ts), and two of the preset's knobs cannot move afterwards at all -- a GL
    // context's antialias is fixed at creation, and `low` decides whether the muzzle-smoke
    // system was ever constructed -- so a change made during a match lands on the next
    // one. Without this the control looks broken in exactly the case a player is most
    // likely to try it: paused, mid-match, on a device that is struggling.
    const { hud: h, root } = mount();
    for (const preset of ['high', 'medium', 'low'] as const) {
      h.setQuality(preset);
      expect(toggle(root).title, preset).toMatch(/next match/i);
      expect(toggle(root).getAttribute('aria-label'), preset).toMatch(/next match/i);
    }
    // NEGATIVE CONTROL: the hint is not ONLY the timing sentence -- each preset still
    // describes what it does, or the promise of when would be all a player ever read.
    h.setQuality('low');
    const low = toggle(root).title;
    h.setQuality('high');
    expect(toggle(root).title, 'every preset shares one hint').not.toBe(low);
  });

  it('taps the toggle and reports the NEXT preset in the cycle, from a real click at the button', () => {
    // Same composition-blindness reasoning as the toggles above: a real event at a real
    // element, not just the callback. The cycle runs DOWNWARDS from the default, because
    // the player who comes looking for this control wants a cheaper picture than the one
    // they have -- and it wraps, so nothing is unreachable.
    const { hud: h, root } = mount();
    const seen: string[] = [];
    h.onQualityChange((p) => seen.push(p));
    h.setQuality('high');

    toggle(root).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen, 'the toggle is not wired to anything').toEqual(['medium']);

    // The button does NOT flip its own label -- it reports the choice and waits for the
    // page's echo, the convention every Settings control here follows. `setQuality`
    // refuses an id the store rejected, so a self-flipping label could show a preset that
    // was never stored and keep showing it until something else repainted.
    expect(toggle(root).textContent).toMatch(/high/i);

    h.setQuality('medium'); // the page's echo
    toggle(root).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen).toEqual(['medium', 'low']);

    h.setQuality('low'); // the page's echo
    toggle(root).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen, 'the third click did not wrap back to the shipped preset').toEqual([
      'medium',
      'low',
      'high',
    ]);
  });

  it('lives in the Settings pane, under Accessibility, beside the motion toggle', () => {
    // Where it goes and why: it answers "how much of this do you want drawn", which is
    // the question the motion control next to it answers for movement. Declaring a sixth
    // Settings section is issue #226's call, not this control's.
    const { root } = mount();
    expect(toggle(root)).not.toBeNull();
    const section = toggle(root).closest('.hud-settings-section') as HTMLElement;
    expect(section, 'the toggle is not inside a Settings section').not.toBeNull();
    expect(section.dataset.section).toBe('accessibility');
    expect(
      root.querySelector('.hud-motion-toggle')!.closest('.hud-settings-section'),
      'the two presentation policies were split across sections',
    ).toBe(section);
  });
});

describe('hud: the owner-palette toggle (issue #1058)', () => {
  const toggle = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-owner-palette-toggle') as HTMLButtonElement;
  /**
   * What #586 rules out of every visible or spoken string: the control is named for what it
   * does, not for a condition a player would have to name to find it.
   */
  const DEFICIENCY_WORDS = /colou?r[\s-]*blind|deficien|protan|deut(?:er)?an|tritan/i;

  it('shows the stored palette, labelled Player colors: Classic and Player colors: High contrast', () => {
    const { hud: h, root } = mount();

    h.setOwnerPalette('classic');
    expect(toggle(root).textContent).toBe('Player colors: Classic');
    const classicAria = toggle(root).getAttribute('aria-label');

    h.setOwnerPalette('high-contrast');
    expect(toggle(root).textContent).toBe('Player colors: High contrast');
    expect(toggle(root).getAttribute('aria-label')).not.toBe(classicAria);

    // Back again: a label that only ever moved one way would pass the two reads above.
    h.setOwnerPalette('classic');
    expect(toggle(root).textContent).toBe('Player colors: Classic');
  });

  it('says WHEN the choice takes effect, which the label cannot show', () => {
    // A session reads the palette once, when it is built (loop.ts), so a change made from
    // Pause lands on the next match. The same sentence the quality toggle beside it carries.
    const { hud: h, root } = mount();
    for (const id of ['classic', 'high-contrast'] as const) {
      h.setOwnerPalette(id);
      expect(toggle(root).title, id).toMatch(/Takes effect when the next match starts\./);
      expect(toggle(root).getAttribute('aria-label'), id).toMatch(
        /Takes effect when the next match starts\./,
      );
    }
    // NEGATIVE CONTROL: the hint is not ONLY the timing sentence -- each palette still says
    // what it looks like.
    h.setOwnerPalette('classic');
    const classic = toggle(root).title;
    h.setOwnerPalette('high-contrast');
    expect(toggle(root).title, 'both palettes share one hint').not.toBe(classic);
  });

  it('names what it does, never a color-vision deficiency, in every state', () => {
    // KNOWN-BAD CONTROLS, synthetic: the pattern has to be able to match the strings it
    // exists to refuse, or every assertion below passes over nothing.
    for (const bad of ['Colour-blind mode', 'color blind', 'Deuteranopia', 'Protanopia', 'Tritan', 'colour deficiency']) {
      expect(bad, bad).toMatch(DEFICIENCY_WORDS);
    }
    const { hud: h, root } = mount();
    const other = { classic: 'High contrast', 'high-contrast': 'Classic' } as const;
    for (const id of ['classic', 'high-contrast'] as const) {
      h.setOwnerPalette(id);
      const text = toggle(root).textContent ?? '';
      const title = toggle(root).title;
      const aria = toggle(root).getAttribute('aria-label') ?? '';
      for (const [what, value] of [['label', text], ['title', title], ['aria-label', aria]]) {
        expect(value, `${id} ${what}`).not.toMatch(DEFICIENCY_WORDS);
      }
      // The spoken form opens with the visible label, as the Motion and Quality toggles' do,
      // and ends by saying where a tap goes.
      expect(aria.startsWith(`${text}. `), `${id}: ${aria}`).toBe(true);
      expect(aria.endsWith(`Tap to switch to Player colors: ${other[id]}.`), `${id}: ${aria}`).toBe(
        true,
      );
    }
  });

  it('taps the toggle and reports the OTHER palette, from a real click at the button', () => {
    const { hud: h, root } = mount();
    const seen: string[] = [];
    h.onOwnerPaletteChange((id) => seen.push(id));
    h.setOwnerPalette('classic');

    toggle(root).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen, 'the toggle is not wired to anything').toEqual(['high-contrast']);
    // The button does NOT flip its own label: it reports the choice and waits for the page's
    // echo of what the store accepted, the convention every Settings control here follows.
    expect(toggle(root).textContent).toBe('Player colors: Classic');

    h.setOwnerPalette('high-contrast'); // the page's echo
    toggle(root).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen, 'the second click did not wrap back to Classic').toEqual([
      'high-contrast',
      'classic',
    ]);
  });

  it('lives in the Settings pane, under Accessibility, after the quality toggle', () => {
    const { root } = mount();
    expect(toggle(root)).not.toBeNull();
    const section = toggle(root).closest('.hud-settings-section') as HTMLElement;
    expect(section, 'the toggle is not inside a Settings section').not.toBeNull();
    expect(section.dataset.section).toBe('accessibility');
    const quality = root.querySelector('.hud-quality-toggle') as HTMLElement;
    expect(toggle(root).parentElement, 'not in the same row as Motion and Quality').toBe(
      quality.parentElement,
    );
    // Node-wise order, not an element query: Quality comes first, then Player colors.
    expect(
      quality.compareDocumentPosition(toggle(root)) & Node.DOCUMENT_POSITION_FOLLOWING,
      'Player colors sits before Quality',
    ).toBeTruthy();
  });

  it('stays offered on a device with no touch, no vibration and no pad', () => {
    // Nothing gates a color choice on a capability, so the verdict that hides the touch
    // pair and the haptics toggle on a desktop must leave this one in the walk.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    (root.querySelector('.hud-settings-open') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click'),
    );
    const pane = root.querySelector('.hud-settings') as HTMLElement;
    expect(focusableControls(pane)).toContain(root.querySelector('.hud-scheme-toggle'));
    h.setControlRelevance(settingRelevance(NO_CAPABILITIES));
    // NEGATIVE CONTROL: the verdict was applied -- it did take the scheme toggle out.
    expect(focusableControls(pane)).not.toContain(root.querySelector('.hud-scheme-toggle'));
    expect(focusableControls(pane)).toContain(toggle(root));
  });
});

/*
 * ISSUE #226: Settings as the one durable home for a preference.
 *
 * The per-control half of the menu restructure -- which section holds which control, that
 * a section with none does not render, and that audio has exactly one home. The
 * composition half is in hud.surfaces.test.ts and the layer-stack half in
 * hud.navigation.test.ts.
 */
describe('hud: the Settings sections (issue #226)', () => {
  const sections = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll('.hud-settings-section'));
  const shown = (root: HTMLElement): (string | undefined)[] =>
    sections(root)
      .filter((el) => !el.classList.contains('hud-settings-section--hidden'))
      .map((el) => el.dataset.section);

  it('declares the issue\'s five sections, and every one of them now has a control to show', () => {
    // The issue names Audio, Controls, Accessibility, Data, About & Legal, and then:
    // "Only sections with relevant controls should render." Accessibility shipped declared
    // and EMPTY, which is how that rule came to be exercised on the build itself; issue
    // #289's motion toggle is the control it was declared for, so all five render now.
    // The rule has not gone anywhere -- the test below measures it on a section emptied
    // out, which is the state #227's capability hiding will produce at runtime.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    (root.querySelector('.hud-settings-open') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click'),
    );
    expect(sections(root).map((el) => el.dataset.section)).toEqual([
      'audio',
      'controls',
      'accessibility',
      'data',
      'about',
    ]);
    expect(shown(root)).toEqual(['audio', 'controls', 'accessibility', 'data', 'about']);
  });

  it('collapses a section whose last control is hidden, and brings it back -- the rule reads the DOM, not a list', () => {
    // The property that makes this a rule rather than a list of section names: with EVERY
    // control in Accessibility hidden the section must be gone on the next open, with
    // nothing in hud.ts changed, and it must return when they do.
    //
    // Hidden rather than removed, and by `display: none` specifically, because that is
    // exactly what a `--hidden` class resolves to and what #227 will do to a control the
    // device cannot use. It is also the same predicate `focusableControls` gives the
    // roving focus, so a section that renders always has somewhere for a D-pad to land.
    //
    // The section's controls are read out of the DOM rather than named: it held one
    // (issue #289's motion toggle) until #540's quality toggle landed beside it, and a
    // test that hid a chosen button would silently stop emptying the section the next
    // time one arrives -- which is precisely how it would stop measuring the rule.
    //
    // The second half is the negative control: without it a `refreshSettingsSections` that
    // hid EVERY section, or one that had simply learned Accessibility's name, would pass
    // the first assertion.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const open = (): void => {
      (root.querySelector('.hud-settings-open') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click'),
      );
    };
    const a11y = sections(root).find((el) => el.dataset.section === 'accessibility')!;
    const controls = [...a11y.querySelectorAll('.hud-settings-controls > *')] as HTMLElement[];
    expect(controls.length, 'Accessibility has no controls to hide').toBeGreaterThan(0);

    for (const c of controls) c.style.display = 'none';
    open();
    expect(shown(root)).toEqual(['audio', 'controls', 'data', 'about']);

    for (const c of controls) c.style.display = '';
    h.back();
    open();
    expect(shown(root)).toEqual(['audio', 'controls', 'accessibility', 'data', 'about']);
  });

  it('reaches Settings from the Main Menu AND from Pause, and Back returns to the origin', () => {
    // "Settings opened from Pause returns to Pause over the same session." The layer
    // stack records the surface a layer was pushed over, so this is the origin rule
    // rather than a second Settings; the test is here because it is the criterion.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      const title = (): string =>
        (root.querySelector('.hud-title') as HTMLElement).textContent ?? '';
      for (const origin of ['main-menu', 'paused'] as const) {
        h.setState(origin);
        const opener = root.querySelector('.hud-settings-open') as HTMLButtonElement;
        opener.dispatchEvent(new MouseEvent('click'));
        expect(
          (root.querySelector('.hud-settings') as HTMLElement).classList.contains(
            'hud-settings--hidden',
          ),
          `Settings did not open from ${origin}`,
        ).toBe(false);
        (root.querySelector('.hud-settings-back') as HTMLButtonElement).dispatchEvent(
          new MouseEvent('click'),
        );
        vi.advanceTimersByTime(1000);
        expect(title(), `Back from Settings left ${origin}`).toBe(
          origin === 'paused' ? 'Paused' : 'TANKS!',
        );
        expect(document.activeElement, `Back did not restore the opener from ${origin}`).toBe(
          opener,
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hud: the topbar carries gameplay status only (issue #226)", () => {
  it('hides the whole bar at Launch and at the Main Menu, and shows it over the board', () => {
    // The gap the issue names: "the persistent top bar can leak gameplay status into
    // application screens". It used to hide at Launch alone, so an abandoned session's
    // Lives, Enemies and Level chip sat above a menu offering to start a different match.
    // Everything left in the bar is in-match status now that the audio pair moved to
    // Settings, so the rule is the surface.
    //
    // Population: all six HudSurface values. The outcome screens keep the bar because
    // they are read OVER the board the numbers describe.
    const { hud: h, root } = mount();
    const bar = root.querySelector('.hud-topbar') as HTMLElement;
    const hidden = (): boolean => bar.classList.contains('hud-topbar--hidden');
    for (const state of ['launch', 'main-menu'] as const) {
      h.setState(state);
      expect(hidden(), `the topbar showed at ${state}`).toBe(true);
    }
    for (const state of ['playing', 'paused', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(state);
      expect(hidden(), `the topbar was hidden at ${state}`).toBe(false);
    }
  });

  it('carries no audio control at all: Settings is the one durable home', () => {
    // The issue's scope line -- "remove menu-embedded and always-visible top-bar
    // mute/volume controls" -- and its acceptance criterion, "audio controls have one
    // durable home and no always-visible gameplay/menu slider". Asserted over the whole
    // HUD rather than over the bar, because a control moved from the bar back onto the
    // pause panel would satisfy a bar-scoped check and break the criterion.
    const { root } = mount();
    const sliders = Array.from(root.querySelectorAll('input[type="range"]'));
    expect(sliders.map((el) => el.className)).toEqual(['hud-settings-volume']);
    const mutes = Array.from(root.querySelectorAll('button')).filter((b) =>
      /^Mute|^Muted/.test(b.textContent ?? ''),
    );
    expect(mutes.map((b) => Array.from(b.classList).join('.'))).toEqual([
      'ui-btn.ui-btn--sm.hud-settings-mute',
    ]);
    for (const el of [...sliders, ...mutes]) {
      expect(
        el.closest('.hud-settings'),
        `${el.className} is not inside the Settings pane`,
      ).not.toBeNull();
    }
  });
});

describe('hud: the stats page', () => {
  const statsView = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-stats') as HTMLElement;
  // ONE Main Menu entry since issue #226: Records, which opens the Stats tab. The
  // Achievements button that used to sit beside it on the menu is a tab inside the pane.
  const openBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-records-open') as HTMLButtonElement;
  const cell = (root: HTMLElement, row: string, col: 0 | 1): string => {
    const tr = Array.from(root.querySelectorAll('.hud-stats-table tr')).find(
      (r) => r.querySelector('th')?.textContent === row,
    );
    return tr?.querySelectorAll('td')[col]?.textContent ?? '(no row)';
  };
  const SOME = {
    shotsFired: 10, shellKills: 4, mineKills: 1, deaths: 2, selfKills: 1,
    friendlyFireKills: 3, minesLaid: 2, wallsDestroyed: 5, ricochets: 7,
  };
  const NONE = {
    shotsFired: 0, shellKills: 0, mineKills: 0, deaths: 0, selfKills: 0,
    friendlyFireKills: 0, minesLaid: 0, wallsDestroyed: 0, ricochets: 0,
  };

  it('names the two scopes for what they ARE: Lifetime and the current attempt', () => {
    // Issue #322's terminology half. The second column read "This run" and had never been
    // run-sized: `stats.attempt()` is zeroed on every world build, and stats.ts names this
    // exact wording as the ambiguous use of `run` that issue #153 asks to remove. The
    // store has two scopes and no third -- there is no run-sized tally to label.
    //
    // "Level attempt", the SAME words the ending screens use (owner ruling). An earlier
    // version of this said "Current attempt" and reasoned that Records is reachable from
    // the Main Menu only, so naming a level the player is not looking at would be wrong.
    // That reasoning was about the moment, not the scope -- and it produced two names for
    // one thing, which is the ambiguity this issue exists to remove.
    const { hud: h, root } = mount();
    h.setStats({ lifetime: SOME, attempt: NONE });
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));

    // `th[scope="col"]`, not `td`, since issue #629 gave this table real column headers:
    // the header row used to be built out of DATA cells, so these two names headed
    // nothing and every figure below them was announced bare. Reading them through the
    // scoped selector means this test now also fails if they regress to `td` -- the
    // wording it pins is only worth anything while it is attached to the column.
    const header = Array.from(
      root.querySelectorAll('.hud-stats-table thead th[scope="col"]'),
    ).map((c) => c.textContent);
    expect(header).toEqual(['Lifetime', 'Level attempt']);

    // The rule that survived the rename: whatever the scope is called, it is not a RUN.
    // `run()` is a real third scope now, and it is not what this column holds.
    expect(header.join(' '), 'a per-attempt tally is still called a run').not.toMatch(/\brun\b/i);

    // The columns are not merely LABELLED right, they are the right way round -- a header
    // fix that left the cells swapped would pass every assertion above.
    expect(cell(root, 'Shell kills', 0), 'lifetime column').toBe('4');
    expect(cell(root, 'Shell kills', 1), 'current-attempt column').toBe('0');
  });

  it('says so when nothing has been played, and gets out of the way once something has', () => {
    // Issue #322's empty state. Eleven rows of zeros do not distinguish "you have not
    // played" from "this is not being counted", and Records is the one screen a new
    // player opens to find out which.
    const { hud: h, root } = mount();
    const line = (): HTMLElement => root.querySelector('.hud-stats-empty') as HTMLElement;
    const shown = (): boolean => !line().classList.contains('hud-stats-empty--hidden');
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));

    h.setStats({ lifetime: NONE, attempt: NONE });
    expect(shown(), 'a fresh save got no explanation for its zeros').toBe(true);

    // THE NEGATIVE CONTROL, and the reason the line is keyed on LIFETIME: Records opens
    // from the Main Menu, where no attempt is in progress, so the attempt column is zero
    // on every single open. A line keyed on that column would never go away.
    h.setStats({ lifetime: SOME, attempt: NONE });
    expect(shown(), 'the line outlived the first match, or is keyed on the wrong column').toBe(
      false,
    );

    // ...and the table is still there underneath in both states -- hiding it would take
    // away the one thing that says WHAT gets tracked.
    expect(cell(root, 'Shell kills', 0)).toBe('4');
  });

  it('reopens on the tab you last used, and starts a fresh document on Stats', () => {
    // Issue #322's "restore the originating tab". Records is one destination with two
    // tabs, and the menu button opened `stats` unconditionally -- so a player comparing
    // achievements across runs re-clicked the tab on every visit.
    const openRecords = (root: HTMLElement): void => {
      openBtn(root).dispatchEvent(new MouseEvent('click'));
    };
    const showing = (root: HTMLElement): string =>
      root.querySelector('.hud-achievements')!.classList.contains('hud-achievements--hidden')
        ? 'stats'
        : 'achievements';

    const { hud: h, root } = mount();
    h.setState('main-menu');

    // First visit lands on Stats, which is also the negative control for the assertion
    // after it: a button hardcoded to `achievements` would pass that one and fail this.
    openRecords(root);
    expect(showing(root), 'the first visit did not open on Stats').toBe('stats');

    // Switch tab, leave, come back.
    (root.querySelector('.hud-stats .hud-records-tab-achievements') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));
    expect(showing(root)).toBe('achievements');
    (root.querySelector('.hud-achievements-back') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));
    openRecords(root);
    expect(showing(root), 'Records forgot the tab within one visit to the menu').toBe(
      'achievements',
    );

    // ...and switching back is remembered too, so this is a memory rather than a one-way
    // latch onto whichever tab was touched first.
    (root.querySelector('.hud-achievements .hud-records-tab-stats') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));
    (root.querySelector('.hud-stats-back') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));
    openRecords(root);
    expect(showing(root)).toBe('stats');
  });

  it('does NOT retain the tab across documents, which is what keeps it out of storage', () => {
    // The owner ruling: the memory lasts the sitting and is gone on reload. A second
    // `createHud` on the same document IS that reload -- fresh module state, same
    // `localStorage`. So this is the assertion that fails the moment someone "improves"
    // the convenience by routing it through `storage.ts`: a preference the player never
    // set would decide the first screen of a visit days later.
    const first = mount();
    first.hud.setState('main-menu');
    openBtn(first.root).dispatchEvent(new MouseEvent('click'));
    (first.root.querySelector('.hud-stats .hud-records-tab-achievements') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));
    expect(
      first.root.querySelector('.hud-achievements')!.classList.contains('hud-achievements--hidden'),
    ).toBe(false);

    const second = mount();
    second.hud.setState('main-menu');
    openBtn(second.root).dispatchEvent(new MouseEvent('click'));
    expect(
      second.root.querySelector('.hud-achievements')!.classList.contains('hud-achievements--hidden'),
      'the tab survived into a new document, so it is being persisted',
    ).toBe(true);
  });

  it('opens from the title, shows both columns, and Back returns to the menu', () => {
    // Fake timers from the START, not after the click: Back now CROSSFADES rather than
    // cutting, and a timer installed after the click cannot advance one scheduled
    // before it. The closing pane keeps its `--hidden` off for the transition it is
    // leaving on, so the assertion below reads the SETTLED state. Where Back lands is
    // what this test is for; the mid-transition frame is owned by `crossfades a panel
    // CLOSE, not only its open`.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setStats({ lifetime: SOME, attempt: NONE });
      h.setState('main-menu');
      openBtn(root).dispatchEvent(new MouseEvent('click'));
      expect(statsView(root).classList.contains('hud-stats--hidden')).toBe(false);
      expect(cell(root, 'Shell kills', 0)).toBe('4'); // lifetime column
      expect(cell(root, 'Shell kills', 1)).toBe('0'); // run column
      (root.querySelector('.hud-stats-back') as HTMLButtonElement).dispatchEvent(new MouseEvent('click'));
      vi.advanceTimersByTime(1000);
      expect(statsView(root).classList.contains('hud-stats--hidden')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('derives both accuracies, and shows -- when the denominator is zero', () => {
    const { hud: h, root } = mount();
    h.setStats({ lifetime: SOME, attempt: NONE });
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(cell(root, 'Accuracy', 0)).toBe('40%'); // 4 shell kills / 10 shots
    expect(cell(root, 'Mine accuracy', 0)).toBe('50%'); // 1 mine kill / 2 laid
    expect(cell(root, 'Accuracy', 1)).toBe('--'); // 0 shots this run
  });

  it('fires onRecordsOpen on an open of either tab, never on a close, and in time for the render', () => {
    // The hook the page paints Records through (issue #324, step S5): the pane re-renders
    // only while visible, so an open is the one instant a page-owned store can be read
    // into it. Asserted by pushing FROM the callback and reading the RENDERED cell rather
    // than by counting the call -- what has to be true is that the numbers the callback
    // supplies are the ones on screen when the pane settles, which a count cannot say.
    const { hud: h, root } = mount();
    h.setStats({ lifetime: NONE, attempt: NONE });
    let opens = 0;
    h.onRecordsOpen(() => {
      opens += 1;
      h.setStats({ lifetime: SOME, attempt: NONE });
    });
    h.setState('main-menu');
    expect(opens, 'nothing fires until the pane opens').toBe(0);
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(opens).toBe(1);
    expect(cell(root, 'Shell kills', 0), 'the pane drew the callback\'s numbers').toBe('4');
    // The Achievements tab is the same Records entry, reached by REPLACING the top layer,
    // so it opens through the same hook rather than inheriting whatever Stats was told.
    (root.querySelector('.hud-records-tab-achievements') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click'),
    );
    expect(opens).toBe(2);
    // ...and Back is not an open. Without this the hook could be fired from anything that
    // touches the pane and still satisfy the counts above.
    (root.querySelector('.hud-achievements-back') as HTMLButtonElement).dispatchEvent(new MouseEvent('click'));
    expect(opens).toBe(2);
  });

  it('the Records button lives on the title panel only', () => {
    const { hud: h, root } = mount();
    for (const s of ['paused', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-records-open--hidden'), s).toBe(true);
    }
    h.setState('main-menu');
    expect(openBtn(root).classList.contains('hud-records-open--hidden')).toBe(false);
  });

  it('carries NO destructive action: the resets live under Settings -> Data (issue #226)', () => {
    // The issue's ruling: "Destructive reset/import actions live under Data, not
    // Records." A page whose purpose is reading progress should not put deleting it one
    // mis-click away, and the two reset buttons were the whole of `.hud-stats-actions`
    // beside Back.
    const { hud: h, root } = mount();
    h.setStats({ lifetime: SOME, attempt: NONE });
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(statsView(root).querySelector('.hud-reset-stats')).toBeNull();
    expect(statsView(root).querySelector('.hud-reset-progress')).toBeNull();
    for (const sel of ['.hud-reset-stats', '.hud-reset-progress']) {
      const btn = root.querySelector(sel) as HTMLButtonElement;
      expect(btn.closest('.hud-settings-section')!.getAttribute('data-section'), sel).toBe('data');
    }
  });

  it('both resets are two-click: the first arms, the second fires', () => {
    const { hud: h, root } = mount();
    let statResets = 0;
    let progResets = 0;
    h.onResetStats(() => statResets++);
    h.onResetProgress(() => progResets++);
    h.setState('main-menu');
    (root.querySelector('.hud-settings-open') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click'),
    );

    const reset = root.querySelector('.hud-reset-stats') as HTMLButtonElement;
    reset.dispatchEvent(new MouseEvent('click'));
    expect(statResets).toBe(0); // armed, not fired
    expect(reset.textContent).toBe('Really reset?');
    reset.dispatchEvent(new MouseEvent('click'));
    expect(statResets).toBe(1);
    expect(reset.textContent).toBe('Reset stats'); // disarmed after firing

    const prog = root.querySelector('.hud-reset-progress') as HTMLButtonElement;
    prog.dispatchEvent(new MouseEvent('click'));
    prog.dispatchEvent(new MouseEvent('click'));
    expect(progResets).toBe(1);
  });

  it('arming one reset does not arm the other, and leaving the page disarms', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const openSettings = (): void => {
      (root.querySelector('.hud-settings-open') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click'),
      );
    };
    openSettings();
    const reset = root.querySelector('.hud-reset-stats') as HTMLButtonElement;
    const prog = root.querySelector('.hud-reset-progress') as HTMLButtonElement;
    reset.dispatchEvent(new MouseEvent('click'));
    expect(prog.textContent).toBe('Reset progress'); // untouched
    (root.querySelector('.hud-settings-back') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click'),
    );
    openSettings();
    expect(reset.textContent).toBe('Reset stats'); // disarmed by leaving
  });

  it('win panel carries the run summary line', () => {
    const { hud: h, root } = mount();
    h.setOutcome({ tally: 'solo', action: 'campaign-levels', attempt: { ...NONE, shellKills: 3, shotsFired: 6, deaths: 1 } });
    h.setState('outcome-win');
    const line = (root.querySelector('.hud-attempt-summary') as HTMLElement).textContent ?? '';
    expect(line).toContain('3 kills');
    expect(line).toContain('50%');
    // And updates if the final batch lands after the panel opened -- the winning
    // kill is recorded a beat after the state flips.
    h.setOutcome({ tally: 'solo', action: 'campaign-levels', attempt: { ...NONE, shellKills: 4, shotsFired: 6, deaths: 1 } });
    expect((root.querySelector('.hud-attempt-summary') as HTMLElement).textContent).toContain('4 kills');
  });

  it('the attempt summary reads the outcome projection, NOT the Records table it used to ride', () => {
    // The half of issue #324's step S4 a passing suite could otherwise hide. Both
    // setters carry `attempt` counts, and before S4 one setter carried both surfaces --
    // so a HUD that had only ever been told the Records numbers still wrote a summary
    // line onto the win panel. This pins the split in both directions: `setStats` alone
    // says nothing about the panel, and the outcome alone says everything.
    const { hud: h, root } = mount();
    const summary = (): HTMLElement => root.querySelector('.hud-attempt-summary') as HTMLElement;
    h.setStats({ lifetime: SOME, attempt: { ...NONE, shellKills: 9, shotsFired: 9 } });
    h.setState('outcome-win');
    expect(summary().classList.contains('hud-attempt-summary--hidden')).toBe(true);
    h.setOutcome({ tally: 'solo', action: 'campaign-levels', attempt: { ...NONE, shellKills: 3, shotsFired: 6, deaths: 1 } });
    expect(summary().classList.contains('hud-attempt-summary--hidden')).toBe(false);
    // The 3 the session stated, never the 9 Records holds -- a mutation that reverted
    // the line to `statsData` would still show a summary here, just the wrong one.
    expect(summary().textContent).toContain('3 kills');
  });

  it('win panel carries the coop kill line, twin of the attempt summary', () => {
    const { hud: h, root } = mount();
    h.setOutcome({ tally: 'coop', action: 'campaign-levels', attempt: NONE, kills: [3, 5] });
    h.setState('outcome-win');
    const line = (root.querySelector('.hud-coop-kills') as HTMLElement).textContent ?? '';
    expect(line).toBe('P1: 3 · P2: 5');
    expect(root.querySelector('.hud-coop-kills')!.classList.contains('hud-coop-kills--hidden')).toBe(false);
  });

  it('a solo outcome keeps the coop line hidden even at win/lose -- a 1P session', () => {
    const { hud: h, root } = mount();
    h.setOutcome({ tally: 'solo', action: 'campaign-levels', attempt: NONE });
    h.setState('outcome-win');
    expect(root.querySelector('.hud-coop-kills')!.classList.contains('hud-coop-kills--hidden')).toBe(true);
    h.setState('outcome-lose');
    expect(root.querySelector('.hud-coop-kills')!.classList.contains('hud-coop-kills--hidden')).toBe(true);
  });

  it('the coop kill line is hidden outside win/lose, even with live counts set', () => {
    const { hud: h, root } = mount();
    h.setOutcome({ tally: 'coop', action: 'campaign-levels', attempt: NONE, kills: [1, 2] });
    h.setState('playing');
    expect(root.querySelector('.hud-coop-kills')!.classList.contains('hud-coop-kills--hidden')).toBe(true);
  });

  it('updates live while the win panel is already open, same as the attempt summary', () => {
    const { hud: h, root } = mount();
    h.setOutcome({ tally: 'coop', action: 'campaign-levels', attempt: NONE, kills: [1, 0] });
    h.setState('outcome-win');
    expect((root.querySelector('.hud-coop-kills') as HTMLElement).textContent).toBe('P1: 1 · P2: 0');
    h.setOutcome({ tally: 'coop', action: 'campaign-levels', attempt: NONE, kills: [1, 1] });
    expect((root.querySelector('.hud-coop-kills') as HTMLElement).textContent).toBe('P1: 1 · P2: 1');
  });
});

describe('hud: achievements', () => {
  // The Achievements TAB of Records since issue #226, not a Main Menu peer of its own:
  // Records opens the Stats tab and the tab row inside it reaches this one. Scoped to
  // `.hud-stats` because the same tab pair exists in both panes -- an unscoped query
  // would find the Achievements pane's own copy, which is the tab you are already on.
  const openBtn = (root: HTMLElement): HTMLButtonElement => {
    (root.querySelector('.hud-records-open') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click'),
    );
    return root.querySelector('.hud-stats .hud-records-tab-achievements') as HTMLButtonElement;
  };
  const page = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-achievements') as HTMLElement;
  const rows = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll('.hud-achievement'));

  it('lists every catalog entry, marking only the earned ones', () => {
    const { hud: h, root } = mount();
    h.setAchievements(new Set(['first-blood', 'flawless'] as const));
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(page(root).classList.contains('hud-achievements--hidden')).toBe(false);
    // Population: the whole catalog -- locked entries stay visible with criteria.
    expect(rows(root)).toHaveLength(ACHIEVEMENTS.length);
    const earned = rows(root)
      .filter((r) => r.classList.contains('hud-achievement--earned'))
      .map((r) => r.dataset.achievement);
    expect(earned.sort()).toEqual(['first-blood', 'flawless']);
    expect(
      (root.querySelector('.hud-achievements-count') as HTMLElement).textContent,
    ).toBe(`2 of ${ACHIEVEMENTS.length} earned`);
    // Descriptions ship with the row: the list doubles as the to-do.
    const locked = rows(root).find((r) => !r.classList.contains('hud-achievement--earned'))!;
    expect((locked.querySelector('.hud-achievement-desc') as HTMLElement).textContent!.length)
      .toBeGreaterThan(0);
  });

  it('re-renders live while open: an achievement earned behind the page appears', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(rows(root).filter((r) => r.classList.contains('hud-achievement--earned'))).toHaveLength(0);
    h.setAchievements(new Set(['petard'] as const));
    const earned = rows(root)
      .filter((r) => r.classList.contains('hud-achievement--earned'))
      .map((r) => r.dataset.achievement);
    expect(earned).toEqual(['petard']);
  });

  it('is a title-screen affair, closed by any state change', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    h.setState('playing');
    expect(page(root).classList.contains('hud-achievements--hidden')).toBe(true);
    // ...and the only way back in is Records, which is Main-Menu only. The old sweep
    // asked the same question of a `.hud-achievements-open` button that no longer
    // exists; the entry it is really gated on is the one that replaced it.
    const records = root.querySelector('.hud-records-open') as HTMLButtonElement;
    for (const s of ['paused', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(records.classList.contains('hud-records-open--hidden'), s).toBe(true);
    }
  });

  it('is one destination with two tabs: switching keeps the Main Menu as the origin', () => {
    // The shallow-tab shape issue #226 asks for, on the layer stack the HUD already has:
    // Stats and Achievements are SIBLING layers over the same origin, not a two-deep
    // stack, so Back from either returns to the Main Menu rather than to the other tab.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      const records = root.querySelector('.hud-records-open') as HTMLButtonElement;
      records.dispatchEvent(new MouseEvent('click'));
      expect(
        (root.querySelector('.hud-stats') as HTMLElement).classList.contains('hud-stats--hidden'),
        'Records opens the Stats tab',
      ).toBe(false);
      openBtn(root).dispatchEvent(new MouseEvent('click'));
      vi.advanceTimersByTime(1000);
      expect(page(root).classList.contains('hud-achievements--hidden')).toBe(false);
      expect(
        (root.querySelector('.hud-stats') as HTMLElement).classList.contains('hud-stats--hidden'),
        'the Stats tab must LEAVE, not be covered',
      ).toBe(true);

      // One Back, and it lands on the menu -- not on the tab it came from.
      expect(h.back()).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(page(root).classList.contains('hud-achievements--hidden')).toBe(true);
      expect(
        (root.querySelector('.hud-panel') as HTMLElement).classList.contains('hud-panel--hidden'),
      ).toBe(false);
      expect(h.back(), 'the stack must be empty after one Back').toBe(false);
      // ...and focus is on the Records control the player actually used, not on the tab
      // button inside the pane they just left.
      expect(document.activeElement).toBe(records);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the tab you are on, in both panes', () => {
    // `ui-selectable--on` is the shared current-choice ring, and `aria-pressed` is the
    // same claim for a screen reader. Without both, two identical buttons say nothing
    // about which view is showing.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const on = (sel: string): boolean =>
      (root.querySelector(sel) as HTMLElement).classList.contains('ui-selectable--on');
    expect(on('.hud-stats .hud-records-tab-stats')).toBe(true);
    expect(on('.hud-stats .hud-records-tab-achievements')).toBe(false);
    expect(on('.hud-achievements .hud-records-tab-achievements')).toBe(true);
    expect(on('.hud-achievements .hud-records-tab-stats')).toBe(false);
  });

  it('toasts each unlock, stacks simultaneous ones, and expires them', () => {
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      const defs = ACHIEVEMENTS.filter((a) => a.id === 'first-blood' || a.id === 'marksman');
      h.showAchievementToasts(defs);
      const toasts = (): HTMLElement[] => Array.from(root.querySelectorAll('.hud-toast'));
      // Two at once STACK rather than replacing one another.
      expect(toasts().map((t) => t.dataset.achievement)).toEqual(['first-blood', 'marksman']);
      expect(toasts()[0].textContent).toContain('First Blood');
      vi.advanceTimersByTime(3199);
      expect(toasts()).toHaveLength(2); // still up just before the deadline
      vi.advanceTimersByTime(2);
      expect(toasts()).toHaveLength(0); // and gone after it
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose clears pending toast timers, so none fires into a removed HUD', () => {
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.showAchievementToasts(ACHIEVEMENTS.slice(0, 1));
      const toast = root.querySelector('.hud-toast') as HTMLElement;
      h.dispose();
      const removeSpy = vi.spyOn(toast, 'remove');
      vi.advanceTimersByTime(10000);
      expect(removeSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('showToast: a plain message stacks and expires exactly like an achievement toast', () => {
    // #114's "gamepad connected" notice, and any future plain notice, ride the same
    // stack and timer as showAchievementToasts -- this pins that they share the
    // machinery rather than each growing their own.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      const toasts = (): HTMLElement[] => Array.from(root.querySelectorAll('.hud-toast'));
      h.showToast('Gamepad connected');
      expect(toasts()).toHaveLength(1);
      expect(toasts()[0].textContent).toBe('Gamepad connected');
      // No achievement identity: unlike showAchievementToasts, nothing sets `.dataset.achievement`.
      expect(toasts()[0].dataset.achievement).toBeUndefined();
      vi.advanceTimersByTime(3199);
      expect(toasts()).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(toasts()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('showToast stacks alongside an achievement toast rather than replacing it', () => {
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.showAchievementToasts(ACHIEVEMENTS.slice(0, 1));
      h.showToast('Gamepad connected');
      const toasts = Array.from(root.querySelectorAll('.hud-toast'));
      expect(toasts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hud: the Bot candidate is gated (bots may not drive a player tank in the campaign)', () => {
  const openBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-controllers-open') as HTMLButtonElement;
  const view = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-controllers') as HTMLElement;
  // Scoped to view(root) -- see the identical comment on the controller-assignment
  // describe block's own `rows` helper above: .hud-controller-row is reused by the
  // versus setup pane's who's-playing preview, so an unscoped query would also match
  // ITS (disabled, mismatched-count) preview rows.
  const rows = (root: HTMLElement): HTMLElement[] =>
    Array.from(view(root).querySelectorAll('.hud-controller-row'));
  const candidateLabels = (row: HTMLElement): string[] =>
    Array.from(row.querySelectorAll('.hud-controller-source-btn')).map(
      (b) => (b as HTMLButtonElement).textContent ?? '',
    );

  function openPanel(h: Hud, root: HTMLElement): void {
    h.setControllers([{ kind: 'keyboard' }]);
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
  }

  it('omits Bot by default -- a shipped campaign cannot hand a player slot to a bot', () => {
    // Fails if `renderControllerRows` puts `{ kind: 'bot' }` back in the candidate list
    // unconditionally, or if `botAssignmentAllowedNow` defaults to true.
    const { hud: h, root } = mount();
    openPanel(h, root);
    expect(candidateLabels(rows(root)[0])).not.toContain('Bot');
  });

  it('offers Bot once it is allowed', () => {
    // The other half: without this, deleting the candidate entirely would still pass the
    // test above, so that one alone would not distinguish "gated" from "removed".
    const { hud: h, root } = mount();
    h.setBotAssignmentAllowed(true);
    openPanel(h, root);
    expect(candidateLabels(rows(root)[0])).toContain('Bot');
  });

  it('re-renders when the permission changes while the panel is already open', () => {
    // setBotAssignmentAllowed must call renderControllerRows, not merely set the flag for
    // the next unrelated re-render. Fails if that call is dropped.
    const { hud: h, root } = mount();
    openPanel(h, root);
    expect(candidateLabels(rows(root)[0])).not.toContain('Bot');
    h.setBotAssignmentAllowed(true);
    expect(candidateLabels(rows(root)[0])).toContain('Bot');
  });
});

// ---------------------------------------------------------------------------
// Issue #290 criterion 5: the player's UI scale reaches the stylesheet.
//
// `uiScaleFactor` has existed since issue #321 and NOTHING multiplied by it, which is what
// made issue #843's seeded `uiScale` capture photograph a byte-identical page. These cases
// pin the one property that closes that gap. The multiplication itself is a stylesheet
// concern and is pinned in `hud.css.test.ts`; jsdom applies no stylesheet, so what is
// assertable here is the value the stylesheet reads.
// ---------------------------------------------------------------------------
describe('UI scale reaches the stylesheet (issue #290)', () => {
  const hudRoot = () => document.querySelector('.hud') as HTMLElement;

  it('writes the factor as a custom property on the root', () => {
    const { hud: h } = mount();
    h.setUiScale(1.5);
    expect(hudRoot().style.getPropertyValue('--hud-ui-scale')).toBe('1.5');
  });

  it('REMOVES the property at 1 rather than writing it, which is what keeps the baselines still', () => {
    // The whole reason the 46 screen baselines do not move: a default page carries no inline
    // style at all, so its markup is byte-identical to one built before this existed.
    // `--hud-ui-scale: 1` would be numerically identical and would change every captured DOM.
    const { hud: h } = mount();
    expect(hudRoot().getAttribute('style'), 'a default page starts with an inline style').toBeNull();
    h.setUiScale(1.25);
    expect(hudRoot().style.getPropertyValue('--hud-ui-scale')).toBe('1.25');
    h.setUiScale(1);
    expect(hudRoot().style.getPropertyValue('--hud-ui-scale'), 'the property survives a return to 1').toBe('');
    expect(hudRoot().getAttribute('style'), 'returning to 1 leaves an inline style behind').toBe('');
  });

  it('ignores a value that would collapse the interface, one case each', () => {
    // This property is multiplied into every size in the HUD, so a bad value does not degrade
    // gracefully -- it makes the whole interface zero-sized or NaN-sized. `UI_SCALES` is
    // 100/125/150 so production cannot produce one; the guard is here because the blast radius
    // is too large to leave to the caller. Each case would be written through without it.
    const { hud: h } = mount();
    h.setUiScale(1.5);
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      h.setUiScale(bad);
      expect(hudRoot().style.getPropertyValue('--hud-ui-scale'), `${bad} was written through`)
        .toBe('1.5');
    }
  });
});
