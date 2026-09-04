// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type Hud } from './hud';
import { SKINS, ACCENTS } from '../presentation/customization';
import { ACHIEVEMENTS } from './achievements';
import { DEFAULT_VOLUME } from '../audio/manifest';


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

describe('createHud stats', () => {
  it('renders lives and enemies remaining', () => {
    const { hud: h, root } = mount();

    h.setLives(2);
    h.setEnemiesRemaining(1);

    expect((root.querySelector('.hud-lives') as HTMLElement).textContent).toBe('2');
    expect((root.querySelector('.hud-enemies') as HTMLElement).textContent).toBe('1');
  });

  it('does not rewrite the text node when the value is unchanged', () => {
    // loop.ts calls these every frame. textContent's setter replaces the text
    // node even for an identical string, invalidating layout at 60 Hz for
    // values that change a handful of times per round.
    const { hud: h, root } = mount();
    h.setLives(3);
    const node = (root.querySelector('.hud-lives') as HTMLElement).firstChild;

    h.setLives(3);

    expect((root.querySelector('.hud-lives') as HTMLElement).firstChild).toBe(node);
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
  it('drops focus from the mute button when it is clicked with the mouse', () => {
    // A focused HUD control legitimately claims Space/Enter/arrows, so a mouse player who
    // clicks Mute would silently lose arrow-key driving and the Space mine-drop until they
    // clicked elsewhere. Keyboard activation reports detail 0 and must KEEP focus, so
    // anyone tabbing through the HUD still has it work.
    const { root } = mount();
    const btn = root.querySelector('.hud-settings-mute') as HTMLButtonElement;

    btn.focus();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(document.activeElement).not.toBe(btn);
  });

  it('keeps focus when the mute button is activated from the keyboard', () => {
    const { root } = mount();
    const btn = root.querySelector('.hud-settings-mute') as HTMLButtonElement;

    btn.focus();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(document.activeElement).toBe(btn);
  });

  it('drops focus from the volume slider when the drag ends', () => {
    const { root } = mount();
    const slider = volumeSlider(root);

    slider.focus();
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

describe('hud: the paint shop', () => {
  const pane = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-customize') as HTMLElement;
  const openBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-customize-open') as HTMLButtonElement;
  // `.hud-swatch` is the shared circle-button class for BOTH the hull row and the
  // accent row (they are the same control), so scope by the dataset attribute each
  // row alone sets -- `data-hull` here, `data-accent` for the accent row below.
  const swatches = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll('.hud-swatch[data-hull]'));
  const accentSwatches = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll('.hud-swatch[data-accent]'));

  it('opens from the title with one swatch per palette entry, current one marked', () => {
    const { hud: h, root } = mount();
    h.setHullColor('red');
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(pane(root).classList.contains('hud-customize--hidden')).toBe(false);
    expect(swatches(root).length).toBeGreaterThanOrEqual(6);
    const selected = swatches(root).filter((b) => b.classList.contains('ui-selectable--on'));
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.hull).toBe('red');
  });

  it('reports a pick by id and re-marks the selection', () => {
    const { hud: h, root } = mount();
    const picks: string[] = [];
    h.onPickHullColor((id) => picks.push(id));
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    const purple = swatches(root).find((b) => b.dataset.hull === 'purple')!;
    purple.dispatchEvent(new MouseEvent('click'));
    expect(picks).toEqual(['purple']);
    h.setHullColor('purple'); // the loop echoes the accepted pick back
    expect(purple.classList.contains('ui-selectable--on')).toBe(true);
  });

  it('offers one skin button per SKINS entry, current one marked, and reports picks', () => {
    const { hud: h, root } = mount();
    const skins = (): HTMLButtonElement[] => Array.from(root.querySelectorAll('.hud-skin'));
    const picks: string[] = [];
    h.onPickSkin((id) => picks.push(id));
    h.setSkin('camo');
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    // One button per entry in the REAL skin list, labelled from it.
    expect(skins().map((b) => b.dataset.skin)).toEqual(SKINS.map((sk) => sk.id));
    expect(skins().map((b) => b.textContent)).toEqual(SKINS.map((sk) => sk.label));
    const selected = skins().filter((b) => b.classList.contains('ui-selectable--on'));
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.skin).toBe('camo');

    const checker = skins().find((b) => b.dataset.skin === 'checker')!;
    checker.dispatchEvent(new MouseEvent('click'));
    expect(picks).toEqual(['checker']);
    h.setSkin('checker'); // the loop echoes the accepted pick back
    expect(checker.classList.contains('ui-selectable--on')).toBe(true);
    expect(skins().filter((b) => b.classList.contains('ui-selectable--on'))).toHaveLength(1);
  });

  it('offers one accent swatch per ACCENTS entry, current one marked, and reports picks', () => {
    const { hud: h, root } = mount();
    const picks: string[] = [];
    h.onPickAccentColor((id) => picks.push(id));
    h.setAccentColor('black');
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    // One button per entry in the REAL accent list, `auto` first.
    expect(accentSwatches(root).map((b) => b.dataset.accent)).toEqual(
      ACCENTS.map((a) => a.id),
    );
    const selected = accentSwatches(root).filter((b) =>
      b.classList.contains('ui-selectable--on'),
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.accent).toBe('black');

    const gold = accentSwatches(root).find((b) => b.dataset.accent === 'gold')!;
    gold.dispatchEvent(new MouseEvent('click'));
    expect(picks).toEqual(['gold']);
    h.setAccentColor('gold'); // the loop echoes the accepted pick back
    expect(gold.classList.contains('ui-selectable--on')).toBe(true);
    expect(
      accentSwatches(root).filter((b) => b.classList.contains('ui-selectable--on')),
    ).toHaveLength(1);
  });

  it('is a title-screen affair: hidden everywhere else, closed by any state change', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    h.setState('playing');
    expect(pane(root).classList.contains('hud-customize--hidden')).toBe(true);
    for (const s of ['paused', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-customize-open--hidden'), s).toBe(true);
    }
  });

  // The accent-hint feature (a <p> shown only for solid+explicit-accent) was removed
  // along with the rest of the panel's prose: the design feedback asked for exactly two
  // labelled sections (Hull, Skin) with the rest self-explanatory once the panel has a
  // real preview. The preview does not resolve the ambiguity the hint used to name (a
  // solid-skin tank still shows no visible change when an accent is picked) any more
  // than the old background tank did -- it makes the absence of change more vivid,
  // not less confusing on its own -- but the selection ring still confirms the pick
  // registered, and that instruction is explicit enough on its own to cut this
  // narrow an edge case. See the PR body for the fuller argument.

  it('has exactly two labelled sections -- Hull and Skin -- and no prose at rest', () => {
    const { root } = mount();
    const headings = Array.from(pane(root).querySelectorAll('h2')).map((h) => h.textContent);
    expect(headings).toEqual(['Hull', 'Skin']);
    // BACK to "no <p> at all". It was briefly relaxed to allow one focus-gated hint
    // spelling out the keyboard scheme; the rotate cluster teaches the same thing to
    // everyone, including touch, so the exception is gone with the element. Adding any
    // paragraph to this pane fails here.
    expect(Array.from(pane(root).querySelectorAll('p'))).toEqual([]);
    // ...and the cluster really is icons, with no visible words of its own -- the check
    // that stops "no prose" being satisfied by moving the prose into the buttons.
    const cluster = pane(root).querySelector('.hud-preview-rotate') as HTMLElement;
    expect(cluster.textContent?.trim()).toBe('');
  });

  it('gives the preview four rotate buttons, one per part and direction', () => {
    // The exact four, as ATTRIBUTE PAIRS: preview-controls.ts parses these and drops
    // anything it does not recognise, so a typo here is an inert button and nothing
    // else in the tree would say so. Sorted, because the assertion is about the set.
    const { hud: h } = mount();
    const pairs = h.previewRotateButtons
      .map((b) => `${b.dataset.rotatePart}:${b.dataset.rotateDir}`)
      .sort();
    expect(pairs).toEqual(['hull:left', 'hull:right', 'turret:left', 'turret:right']);
    // Real buttons, so they are focusable and announced without a role of their own,
    // and type=button so they cannot submit anything.
    for (const b of h.previewRotateButtons) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('type')).toBe('button');
      // An accessible name that says both halves: which part, and which way.
      const label = b.getAttribute('aria-label') ?? '';
      expect(label, 'no accessible name').toMatch(/hull|turret/i);
      expect(label).toMatch(/left|right/i);
      expect(label.toLowerCase()).toContain(b.dataset.rotatePart!);
      expect(label.toLowerCase()).toContain(b.dataset.rotateDir!);
      // The icon must not be read out as well -- the name already says it.
      const icon = b.querySelector('svg');
      expect(icon, 'the button has no icon at all').not.toBeNull();
      expect(icon!.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('orders the cluster hull-pair then turret-pair, left before right', () => {
    // The order is the layout: hud.css puts the extra gap before the THIRD child, so a
    // reordering silently moves the visual grouping onto the wrong pair.
    const { hud: h } = mount();
    expect(h.previewRotateButtons.map((b) => `${b.dataset.rotatePart}:${b.dataset.rotateDir}`)).toEqual(
      ['hull:left', 'hull:right', 'turret:left', 'turret:right'],
    );
    // ...and they sit under the canvas, in the pane, not somewhere else in the HUD.
    expect(h.previewCanvas.nextElementSibling).toBe(
      h.previewRotateButtons[0].parentElement,
    );
  });

  it('mirrors the left icon from the right one rather than hand-drawing a second path', () => {
    // The pair is drawn once and flipped by a transform. A hand-written mirror is where
    // an asymmetric pair comes from, and nothing else in the suite looks at these
    // glyphs -- they are exactly the "file no test reads" case. Asserted as the
    // relationship: the two icons of a pair must differ ONLY by that transform.
    const { hud: h } = mount();
    const svg = (part: string, dir: string): string =>
      h.previewRotateButtons
        .find((b) => b.dataset.rotatePart === part && b.dataset.rotateDir === dir)!
        .innerHTML;
    for (const part of ['hull', 'turret']) {
      const right = svg(part, 'right');
      const left = svg(part, 'left');
      expect(left).not.toBe(right);
      expect(left).toContain('scale(-1,1)');
      expect(right).not.toContain('scale(-1,1)');
      // Strip the wrapper the mirror adds and the two are the same drawing.
      expect(left.replace(/<g transform="[^"]*">|<\/g>/g, '')).toBe(right);
    }
    // ...and the two PARTS are drawn differently, or all four buttons would look alike.
    expect(svg('hull', 'right')).not.toBe(svg('turret', 'right'));
  });

  it('puts the skin buttons AND the accent swatches inside the Skin section', () => {
    const { root } = mount();
    const sections = Array.from(pane(root).querySelectorAll('.hud-customize-section'));
    const skinSection = sections.find((s) => s.querySelector('h2')?.textContent === 'Skin');
    expect(skinSection).toBeDefined();
    expect(skinSection!.querySelector('.hud-skins')).not.toBeNull();
    expect(skinSection!.querySelector('.hud-accents')).not.toBeNull();
  });

  it('exposes a preview canvas element, present even before the panel first opens', () => {
    const { hud: h, root } = mount();
    expect(h.previewCanvas).toBeInstanceOf(HTMLCanvasElement);
    expect(h.previewCanvas.classList.contains('hud-preview')).toBe(true);
    expect(root.contains(h.previewCanvas)).toBe(true);
  });

  it('makes the preview a focusable, named control rather than decoration', () => {
    // It became interactive in the "rotate the tank" change (render/preview-controls.ts
    // gives it a keyboard scheme), and three markup facts carry that:
    //
    // - tabindex, because a canvas element has NO default tab stop, so without it the
    //   keyboard scheme is unreachable and the whole feature is mouse-only;
    // - no aria-hidden, because the canvas used to carry it and a FOCUSABLE element
    //   inside an aria-hidden subtree is a tab stop a screen reader cannot announce;
    // - an accessible name that states the scheme, which for a keyboard-only player is
    //   the only place it is written down (the pane carries no prose -- see the
    //   two-sections test above).
    const { hud: h } = mount();
    expect(h.previewCanvas.getAttribute('tabindex')).toBe('0');
    expect(h.previewCanvas.hasAttribute('aria-hidden')).toBe(false);
    const label = h.previewCanvas.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/drag/i);
    expect(label).toMatch(/arrow/i);
    expect(label).toMatch(/turret/i);
    // The sighted-mouse equivalent of the same sentence.
    expect(h.previewCanvas.getAttribute('title') ?? '').toMatch(/drag/i);
  });

  it('fires onCustomizeOpen/onCustomizeClose exactly on the Back-button round trip', () => {
    const { hud: h, root } = mount();
    const opens: number[] = [];
    const closes: number[] = [];
    h.onCustomizeOpen(() => opens.push(1));
    h.onCustomizeClose(() => closes.push(1));
    h.setState('main-menu');
    expect(opens).toHaveLength(0);
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(0);
    root.querySelector('.hud-customize-back')!.dispatchEvent(new MouseEvent('click'));
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(1);
  });

  it('unhides the pane BEFORE firing onCustomizeOpen, not after', () => {
    // Load-bearing for the live preview, even though jsdom cannot see the actual
    // consequence: game/loop.ts's onCustomizeOpen handler builds the preview and reads
    // hud.previewCanvas.clientWidth (via render/preview.ts's fit()) to size it. A
    // canvas still carrying `hud-customize--hidden` at that moment lays out at 0x0 in a
    // real browser, and fit()'s `|| 1` fallback would silently produce a 1x1 preview --
    // wrong, not broken, so nothing would throw and no GL check builds a canvas in that
    // exact hidden state to catch it. This pins the ORDERING that prevents it: by the
    // time the callback runs, the pane's hidden class is already gone.
    const { hud: h, root } = mount();
    let hiddenWhenCallbackFired: boolean | null = null;
    h.onCustomizeOpen(() => {
      hiddenWhenCallbackFired = pane(root).classList.contains('hud-customize--hidden');
    });
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(hiddenWhenCallbackFired).toBe(false);
  });

  it('fires onCustomizeClose on ANY state change while open, not just Back -- the leak this guards', () => {
    // The common exit from the panel is Start (setState('playing')), which never
    // touches the Back button. A caller building a live WebGL preview off open/close
    // (game/loop.ts does) would leak a context down this path if it only fired here.
    const { hud: h, root } = mount();
    const closes: number[] = [];
    h.onCustomizeClose(() => closes.push(1));
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(closes).toHaveLength(0);
    h.setState('playing');
    expect(closes).toHaveLength(1);
  });

  it('does not fire onCustomizeClose again for state changes AFTER the one that closed it', () => {
    // setState's guard is `wasOpen`, checked fresh each call -- without it, every
    // subsequent state change (not just the one that actually closed the panel) would
    // re-fire the close callback, and a caller disposing a WebGL context on it would
    // call dispose() on an already-disposed preview.
    const { hud: h, root } = mount();
    const closes: number[] = [];
    h.onCustomizeClose(() => closes.push(1));
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    h.setState('playing'); // closes it -- one close
    h.setState('main-menu');
    h.setState('paused');
    expect(closes).toHaveLength(1);
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
