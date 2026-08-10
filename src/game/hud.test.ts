// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createHud,
  levelSelectColumns,
  primaryActionVerb,
  LEVEL_GRID_MAX_COLS,
  type Hud,
  type LevelSelectState,
} from './hud';
import { isMuteHotkey, isPauseHotkey } from './loop';
import { SKINS, ACCENTS } from './customization';
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

const volumeSlider = (root: HTMLElement): HTMLInputElement =>
  root.querySelector('.hud-volume') as HTMLInputElement;

describe('createHud volume control', () => {
  it('shows the volume the audio engine actually boots at', () => {
    const { root } = mount();

    // Not a literal: the slider and the engine must read the same constant, or
    // the displayed level is a guess that happens to be wrong.
    expect(Number(volumeSlider(root).value)).toBe(DEFAULT_VOLUME);
  });

  it('keeps DEFAULT_VOLUME on the step grid the browser will snap to', () => {
    // Real browsers sanitize <input type="range"> onto the `step` grid; jsdom
    // does not. A DEFAULT_VOLUME of, say, 1/3 would leave the test above green
    // while the real HUD displayed 0.33 and the engine ran at 0.3333... --
    // the same lie, just below this test's resolution.
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
  const muteBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-mute') as HTMLButtonElement;

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

describe('createHud panel', () => {
  const panel = (root: HTMLElement): HTMLElement => root.querySelector('.hud-panel') as HTMLElement;
  const title = (root: HTMLElement): string =>
    (root.querySelector('.hud-title') as HTMLElement).textContent ?? '';
  const action = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-action') as HTMLButtonElement;

  it('shows the splash screen on mount, with the menu panel behind it hidden', () => {
    // The HUD boots into the same state the state machine does. Before the splash
    // screen existed this asserted the menu, so it is the one test that pins which
    // screen a player actually lands on.
    const { root } = mount();
    const splash = root.querySelector('.hud-splash') as HTMLElement;
    expect(splash.classList.contains('hud-splash--hidden')).toBe(false);
    expect(panel(root).classList.contains('hud-panel--hidden')).toBe(true);
    // Lives/Enemies/Level over the word TANKS! reads as a game already running.
    const topbar = root.querySelector('.hud-topbar') as HTMLElement;
    expect(topbar.classList.contains('hud-topbar--hidden')).toBe(true);
  });

  it('shows the title panel once the splash screen is dismissed', () => {
    const { hud: h, root } = mount();
    h.setState('title');
    const splash = root.querySelector('.hud-splash') as HTMLElement;
    expect(splash.classList.contains('hud-splash--hidden')).toBe(true);
    const topbar = root.querySelector('.hud-topbar') as HTMLElement;
    expect(topbar.classList.contains('hud-topbar--hidden')).toBe(false);
    expect(panel(root).classList.contains('hud-panel--hidden')).toBe(false);
    expect(title(root)).toBe('TANKS!');
    expect(action(root).textContent).toBe('Start');
  });

  it('leaves the menu hotkeys alive after the title screen is dismissed', () => {
    // REGRESSION, found in a browser and invisible to all 1351 tests before this one:
    // handing focus to the Start button on dismissal killed M and Escape at the menu.
    // isMuteHotkey/isPauseHotkey deliberately ignore any key whose target sits inside
    // input/button/select/textarea -- keys typed at a control belong to the control --
    // so whatever receives focus here decides whether the hotkeys work at all.
    //
    // Asserted through the real predicates rather than by checking the tag name, so
    // this keeps meaning what it says if that guard's selector ever changes.
    const { hud: h } = mount();
    h.setState('title'); // splash -> title: the focus handoff
    const active = document.activeElement as HTMLElement;
    expect(active.className, 'focus went somewhere unexpected').toContain('hud-panel');
    const ev = (key: string): KeyboardEvent =>
      ({ key, repeat: false, target: active }) as unknown as KeyboardEvent;
    expect(isMuteHotkey(ev('m')), 'M is dead at the menu').toBe(true);
    expect(isPauseHotkey(ev('Escape')), 'Escape is dead at the menu').toBe(true);
  });

  it('gives the title screen an accessible name and role', () => {
    // Both attributes survived deletion against the whole suite. They are the only
    // thing that describes a screen blocking the entire game to a screen reader.
    const { root } = mount();
    const splash = root.querySelector('.hud-splash') as HTMLElement;
    expect(splash.getAttribute('role')).toBe('dialog');
    expect(splash.getAttribute('aria-label')).toMatch(/press any key/i);
  });

  it('does not let the tap that dismisses the title screen press Start underneath it', () => {
    // MEASURED on a Pixel 5: one centre tap left the splash AND started the game, so the
    // menu was never seen. The overlay hides on pointerdown and the browser completes
    // the click on whatever is now under the finger -- which is exactly where the action
    // button sits. A centre mouse click did the same.
    const { hud: h, root } = mount();
    let starts = 0;
    h.onStartRestart(() => {
      starts += 1;
    });
    // The real sequence: a pointer lands on the overlay, loop.ts dismisses on that same
    // pointerdown, and the browser then completes the click on the button beneath.
    const splash = root.querySelector('.hud-splash') as HTMLElement;
    splash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    h.setState('title');
    const action = root.querySelector('.hud-action') as HTMLButtonElement;

    action.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(starts, 'the dismissing gesture also pressed Start').toBe(0);

    // ONE gesture only: the next press is the player's, and must work.
    action.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(starts, 'the guard ate a press the player meant').toBe(1);
  });

  it('does not let a stale swallow survive an unrelated touch', () => {
    // The guard is armed by a gesture and consumed by a click, with no deadline -- a
    // deadline was measured racing the very stall it causes (577-878ms real gap against
    // a 700ms window, 16 of 24 taps still skipping the menu). Without a way to clear it,
    // a gesture whose click never arrives -- a finger sliding off the overlay -- would
    // leave it armed to eat the player's next real press.
    const { hud: h, root } = mount();
    let starts = 0;
    h.onStartRestart(() => {
      starts += 1;
    });
    const splash = root.querySelector('.hud-splash') as HTMLElement;
    splash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    h.setState('title');

    // The click never comes; the player instead touches the button deliberately.
    const action = root.querySelector('.hud-action') as HTMLButtonElement;
    action.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    action.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(starts, 'a stale swallow ate the next real press').toBe(1);
  });

  it('drives its pause and mine buttons from real clicks, not just the callback', () => {
    // Both listeners could be deleted outright and the whole suite stayed green: the
    // loop tests fake the HUD, and the only other new test checks a CSS class. This is
    // the composition blindness CLAUDE.md documents, one layer down -- nothing
    // dispatched an event at a real button.
    const { hud: h, root } = mount();
    let pauses = 0;
    let mines = 0;
    h.onPauseTap(() => {
      pauses += 1;
    });
    h.onMineTap(() => {
      mines += 1;
    });
    h.setState('playing');

    // pointerdown, not click: Chromium does not synthesise a click for a touch tap while
    // another touch point is active, so a click binding left a player unable to pause
    // while driving or aiming -- which is the normal state of play. jsdom cannot model
    // the missing click, so what is pinned here is the BINDING.
    (root.querySelector('.hud-pause-btn') as HTMLButtonElement).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
    );
    expect(pauses, 'the Pause button is not wired to pointerdown').toBe(1);

    // pointerdown, not click: a mine lands when the thumb touches, not when it lifts.
    (root.querySelector('.hud-mine-btn') as HTMLButtonElement).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
    );
    expect(mines, 'the Mine button is not wired to anything').toBe(1);
  });

  it('drives its Fire button from a real pointerdown, not just the callback', () => {
    // Same composition-blindness reasoning as the Pause/Mine test above: nothing here
    // dispatches at a real button unless this test does it.
    const { hud: h, root } = mount();
    let fires = 0;
    h.onFireTap(() => {
      fires += 1;
    });
    h.setState('playing');

    // pointerdown, not click: a shot lands the instant the thumb touches, exactly like
    // the Mine button, and NOT on release.
    (root.querySelector('.hud-fire-btn') as HTMLButtonElement).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
    );
    expect(fires, 'the Fire button is not wired to anything').toBe(1);
  });

  it('suppresses the compat mousemove a Fire tap would otherwise synthesise', () => {
    // Same preventDefault as the Mine button, for the same reason: without it the
    // compat mousemove reaches the window-bound aim handler and drags aim to this
    // button's corner.
    const { root } = mount();
    const btn = root.querySelector('.hud-fire-btn') as HTMLButtonElement;
    const ev = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    expect(ev.defaultPrevented, 'the Fire tap was not suppressed').toBe(true);
  });

  it('does not eat a keyboard press after a drag dismissal', () => {
    // A DRAG dismissal delivers its click to the HUD root rather than into the panel, so
    // the arm is never consumed and sits waiting. Measured in a browser: a player who
    // dismissed by dragging and then tabbed to Start lost exactly one Enter. It
    // self-corrects on the second press, but a keyboard or AT user should not have to
    // press twice, so any key clears the arm.
    const { hud: h, root } = mount();
    let starts = 0;
    h.onStartRestart(() => {
      starts += 1;
    });
    const splash = root.querySelector('.hud-splash') as HTMLElement;
    splash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    h.setState('title'); // armed, and the drag's click never lands in the panel

    const hudEl = root.querySelector('.hud') as HTMLElement;
    hudEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    (root.querySelector('.hud-action') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(starts, 'the first keyboard activation after a drag dismissal was eaten').toBe(1);
  });

  it('draws the driving thumb where it landed, and clamps the knob to the throw', () => {
    const { hud: h, root } = mount();
    const viz = root.querySelector('.hud-touchviz') as HTMLElement;
    const base = root.querySelector('.hud-stick-base') as HTMLElement;
    const knob = root.querySelector('.hud-stick-knob') as HTMLElement;

    h.setTouchIndicator({ stick: null, aim: null, scheme: 'stick', used: false });
    expect(viz.classList.contains('hud-touchviz--hidden'), 'shown before any touch').toBe(true);

    // 20px up: inside the 56px radius, so the knob sits exactly under the thumb.
    h.setTouchIndicator({
      stick: { originX: 100, originY: 300, x: 100, y: 280 },
      aim: null,
      scheme: 'stick',
      used: true,
    });
    expect(viz.classList.contains('hud-touchviz--hidden')).toBe(false);
    expect(base.style.transform).toBe('translate(100px, 300px)');
    // 12.09px, NOT the raw 20px the thumb moved: the knob is positioned by the same
    // `stickVector` the tank obeys, so its offset IS the speed. A 20px push is 0.357 of
    // the radius, which the dead-zone rescale turns into 0.216 of full pace.
    expect(knob.style.transform).toBe('translate(100px, 287.9024390243902px)');

    // Inside the dead zone the tank does not move, so the knob must not either. Review
    // caught a parallel clamp that drew the knob at the raw offset here: a thumb
    // drifting ~10px visibly moved it while the tank sat still.
    h.setTouchIndicator({
      stick: { originX: 100, originY: 300, x: 100, y: 295 },
      aim: null,
      scheme: 'stick',
      used: true,
    });
    expect(knob.style.transform, 'the knob moved inside the dead zone').toBe(
      'translate(100px, 300px)',
    );

    // 200px up: well past the radius. The tank is already at full speed, so a knob that
    // kept following would show a throw that buys nothing.
    h.setTouchIndicator({
      stick: { originX: 100, originY: 300, x: 100, y: 100 },
      aim: null,
      scheme: 'stick',
      used: true,
    });
    expect(knob.style.transform, 'the knob escaped the stick').toBe('translate(100px, 244px)');
  });

  it('marks the point the turret is being sent to, and clears it when the thumb lifts', () => {
    // The dot is the COMMANDED target; the aim ray in the 3D scene is where the turret
    // actually points. They differ while it slews, and that gap is what playtest
    // feedback said was invisible.
    const { hud: h, root } = mount();
    const dot = root.querySelector('.hud-aimdot') as HTMLElement;

    h.setTouchIndicator({ stick: null, aim: { originX: 640, originY: 220, x: 640, y: 220 }, scheme: 'point', used: true });
    expect(dot.classList.contains('hud-aimdot--hidden')).toBe(false);
    expect(dot.style.transform).toBe('translate(640px, 220px)');

    h.setTouchIndicator({ stick: null, aim: null, scheme: 'point', used: true });
    expect(dot.classList.contains('hud-aimdot--hidden'), 'the dot outlived the thumb').toBe(true);
  });

  it('draws the aim thumb as a SECOND ring+knob under the stick scheme, not the crosshair', () => {
    // The whole point of the two schemes having two different visualisations: under
    // 'stick' the aim thumb IS a stick (aim.origin is where it landed, just like the
    // driving stick), so it must draw like one -- not as a point-scheme crosshair, which
    // would show a spot on the ground rather than a pushed direction.
    const { hud: h, root } = mount();
    const dot = root.querySelector('.hud-aimdot') as HTMLElement;
    const aimStick = root.querySelector('.hud-aimstick') as HTMLElement;
    const aimBase = root.querySelector('.hud-aimstick .hud-stick-base') as HTMLElement;
    const aimKnob = root.querySelector('.hud-aimstick .hud-stick-knob') as HTMLElement;

    h.setTouchIndicator({
      stick: null,
      aim: { originX: 700, originY: 300, x: 700, y: 280 }, // 20px up: inside the radius
      scheme: 'stick',
      used: true,
    });
    expect(aimStick.classList.contains('hud-aimstick--hidden'), 'the aim stick did not show').toBe(
      false,
    );
    expect(aimBase.style.transform).toBe('translate(700px, 300px)');
    expect(aimKnob.style.transform).toBe('translate(700px, 287.9024390243902px)') // same rescale as the driving stick;
    expect(dot.classList.contains('hud-aimdot--hidden'), 'the crosshair also showed').toBe(true);
  });

  it('clamps the aim stick knob to the throw, exactly like the driving stick', () => {
    // Reuses the SAME clamp: past STICK_RADIUS_PX (56) the turret is already at full
    // deflection, so a knob that kept following would show a throw that buys nothing.
    const { hud: h, root } = mount();
    const aimKnob = root.querySelector('.hud-aimstick .hud-stick-knob') as HTMLElement;

    // 200px up: well past the 56px radius.
    h.setTouchIndicator({
      stick: null,
      aim: { originX: 700, originY: 300, x: 700, y: 100 },
      scheme: 'stick',
      used: true,
    });
    expect(aimKnob.style.transform, 'the aim knob escaped the stick').toBe(
      'translate(700px, 244px)',
    );
  });

  it('hides the aim stick under the point scheme, even with an aim reading present', () => {
    const { hud: h, root } = mount();
    const aimStick = root.querySelector('.hud-aimstick') as HTMLElement;
    const dot = root.querySelector('.hud-aimdot') as HTMLElement;

    h.setTouchIndicator({
      stick: null,
      aim: { originX: 640, originY: 220, x: 640, y: 220 },
      scheme: 'point',
      used: true,
    });
    expect(aimStick.classList.contains('hud-aimstick--hidden'), 'the aim stick showed under point').toBe(
      true,
    );
    expect(dot.classList.contains('hud-aimdot--hidden')).toBe(false);
  });

  it('pulses the aim mark when the player fires, and re-pulses on a second shot', () => {
    // The visible half of the fire confirmation. Review replaced this method's body with
    // a no-op and 198 tests still passed: loop.test.ts only checked that a MOCK was
    // called, and nothing touched the real DOM effect at all.
    const { hud: h, root } = mount();
    const dot = root.querySelector('.hud-aimdot') as HTMLElement;
    h.setTouchIndicator({
      stick: null,
      aim: { originX: 640, originY: 220, x: 640, y: 220 },
      scheme: 'point',
      used: true,
    });
    expect(dot.classList.contains('hud-aimdot--fired')).toBe(false);

    h.signalPlayerFire();
    expect(dot.classList.contains('hud-aimdot--fired'), 'the shot did not pulse').toBe(true);

    // Two shots in quick succession must read as TWO. The class is already present, so
    // only the remove/reflow/re-add restart makes the animation play again -- deleting
    // that trick leaves the class on and this assertion is what catches it.
    const restarted: string[] = [];
    const realRemove = dot.classList.remove.bind(dot.classList);
    dot.classList.remove = (...names: string[]) => {
      restarted.push(...names);
      realRemove(...names);
    };
    h.signalPlayerFire();
    expect(restarted, 'the second shot did not restart the pulse').toContain('hud-aimdot--fired');
    expect(dot.classList.contains('hud-aimdot--fired')).toBe(true);
  });

  it('shows the touch controls only while playing', () => {
    // A Pause button on the pause panel is a second, untested way out of a paused game,
    // and a Mine button on the menu lays nothing. Swept over every state rather than
    // spot-checked, because the toggle is a single boolean and one sample cannot tell
    // "only while playing" from "always".
    const { hud: h, root } = mount();
    const row = root.querySelector('.hud-touch') as HTMLElement;
    const hidden = (): boolean => row.classList.contains('hud-touch--hidden');

    h.setState('playing');
    expect(hidden(), 'the touch controls are missing during play').toBe(false);
    for (const s of ['splash', 'title', 'paused', 'win', 'lose'] as const) {
      h.setState(s);
      expect(hidden(), `the touch controls are showing on ${s}`).toBe(true);
    }
  });

  it('does not render the Game Over panel behind the splash screen at boot', () => {
    // setState's final `else` is a Game Over branch, and every state that does not
    // return before reaching it falls in. 'splash' returns early alongside 'playing'.
    // Without that return, the very first setState at mount writes "Game Over" /
    // "Out of lives." into the panel AND leaves it un-hidden, so the first thing a
    // player sees on a fresh page load is a defeat screen.
    //
    // Only the boot path is asserted because it is the only one that reaches 'splash':
    // dismissSplash goes splash -> title and nothing returns to it, so there is no
    // lose -> splash transition to guard.
    const { root } = mount();
    expect(title(root)).not.toBe('Game Over');
    expect(panel(root).classList.contains('hud-panel--hidden')).toBe(true);
  });

  it('hides the panel while playing and restores it on win and lose', () => {
    const { hud: h, root } = mount();

    h.setState('playing');
    expect(panel(root).classList.contains('hud-panel--hidden')).toBe(true);

    h.setState('win');
    expect(panel(root).classList.contains('hud-panel--hidden')).toBe(false);
    expect(title(root)).toBe('You Win!');
    expect(action(root).textContent).toBe('Play Again');

    h.setState('lose');
    expect(title(root)).toBe('Game Over');
    expect(action(root).textContent).toBe('Retry');
  });

  it('notifies start/restart subscribers — the only gesture that can unlock audio', () => {
    const { hud: h, root } = mount();
    let starts = 0;
    h.onStartRestart(() => starts++);

    action(root).dispatchEvent(new MouseEvent('click'));

    expect(starts).toBe(1);
  });

  it('detaches listeners and removes itself on dispose', () => {
    const { hud: h, root } = mount();
    let events = 0;
    h.onMuteToggle(() => events++);
    h.onStartRestart(() => events++);
    const btn = muteBtnOf(root);
    const act = action(root);

    h.dispose();
    hud = null; // already disposed; stop afterEach double-disposing

    btn.dispatchEvent(new MouseEvent('click'));
    act.dispatchEvent(new MouseEvent('click'));

    expect(events).toBe(0);
    expect(root.querySelector('.hud')).toBeNull();
  });

  function muteBtnOf(root: HTMLElement): HTMLButtonElement {
    return root.querySelector('.hud-mute') as HTMLButtonElement;
  }
});

describe('createHud does not keep keyboard focus after a pointer interaction', () => {
  it('drops focus from the mute button when it is clicked with the mouse', () => {
    // A focused HUD control legitimately claims Space/Enter/arrows, so a mouse player who
    // clicks Mute would silently lose arrow-key driving and the Space mine-drop until they
    // clicked elsewhere. Keyboard activation reports detail 0 and must KEEP focus, so
    // anyone tabbing through the HUD still has it work.
    const { root } = mount();
    const btn = root.querySelector('.hud-mute') as HTMLButtonElement;

    btn.focus();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(document.activeElement).not.toBe(btn);
  });

  it('keeps focus when the mute button is activated from the keyboard', () => {
    const { root } = mount();
    const btn = root.querySelector('.hud-mute') as HTMLButtonElement;

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

describe('hud: losing a life', () => {
  function mount(): { root: HTMLElement; hud: ReturnType<typeof createHud> } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return { root, hud: createHud(root) };
  }

  it('shows nothing until a life is actually lost', () => {
    const { root, hud } = mount();
    expect(root.querySelector('.hud-damage')?.className).not.toContain('hud-damage--hit');
    hud.dispose();
  });

  it('flashes the screen and pulses the counter', () => {
    const { root, hud } = mount();
    hud.signalPlayerDeath();
    expect(root.querySelector('.hud-damage')?.className).toContain('hud-damage--hit');
    expect(root.querySelector('.hud-lives')?.className).toContain('hud-lives--hit');
    hud.dispose();
  });

  it('replays for a second death, so two deaths read as two', () => {
    // Re-adding a class the element already has does NOT restart a CSS
    // animation. Without the remove-and-reflow, a second death inside the
    // animation window would be invisible -- the case where the player most
    // needs telling. MutationObserver delivers on a microtask, so drain it
    // synchronously with takeRecords rather than waiting.
    const { root, hud } = mount();
    hud.signalPlayerDeath();
    const damage = root.querySelector('.hud-damage') as HTMLElement;
    const obs = new MutationObserver(() => {});
    obs.observe(damage, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    hud.signalPlayerDeath();
    const records = obs.takeRecords();
    obs.disconnect();
    const sawRemoval = records.some(
      (r) => r.oldValue?.includes('hud-damage--hit') && !r.oldValue.endsWith('--hit '),
    );
    expect(records.length).toBeGreaterThanOrEqual(2); // removed, then re-added
    expect(sawRemoval).toBe(true);
    expect(damage.className).toContain('hud-damage--hit');
    hud.dispose();
  });

  it('the flash cannot swallow the pointer', () => {
    // It covers the whole board, and the player is aiming through it the
    // instant they respawn.
    const { root, hud } = mount();
    hud.signalPlayerDeath();
    const damage = root.querySelector('.hud-damage') as HTMLElement;
    expect(damage.getAttribute('aria-hidden')).toBe('true');
    hud.dispose();
  });
});

describe('hud: dev shell count', () => {
  function mount(): { root: HTMLElement; hud: ReturnType<typeof createHud> } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return { root, hud: createHud(root) };
  }

  it('is hidden until asked for, since it is off by default', () => {
    const { root, hud } = mount();
    expect(root.querySelector('.hud-shells')?.className).toContain('hud-shells--hidden');
    hud.dispose();
  });

  it('shows shells against the cap', () => {
    const { root, hud } = mount();
    hud.setShellCount({ inFlight: 2, cap: 5 });
    const el = root.querySelector('.hud-shells') as HTMLElement;
    expect(el.textContent).toBe('shells 2/5');
    expect(el.className).not.toContain('hud-shells--hidden');
    hud.dispose();
  });

  it('marks the state where the cannon goes silent', () => {
    // At the cap firing stops with no other cue. That is the state this
    // readout exists for, so it must be distinguishable at a glance.
    const { root, hud } = mount();
    hud.setShellCount({ inFlight: 5, cap: 5 });
    expect((root.querySelector('.hud-shells') as HTMLElement).className).toContain('hud-shells--full');
    hud.setShellCount({ inFlight: 4, cap: 5 });
    expect((root.querySelector('.hud-shells') as HTMLElement).className).not.toContain('hud-shells--full');
    hud.dispose();
  });

  it('hides again on null', () => {
    const { root, hud } = mount();
    hud.setShellCount({ inFlight: 1, cap: 5 });
    hud.setShellCount(null);
    expect(root.querySelector('.hud-shells')?.className).toContain('hud-shells--hidden');
    hud.dispose();
  });
});

describe('hud: round-start phase feedback', () => {
  function mount(): { root: HTMLElement; hud: ReturnType<typeof createHud> } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return { root, hud: createHud(root) };
  }

  it('shows nothing until it is told to', () => {
    const { root, hud } = mount();
    expect(root.querySelector('.hud-banner')?.className).toContain('hud-banner--hidden');
    expect(root.querySelector('.hud-phase')?.className).toContain('hud-phase--hidden');
    hud.dispose();
  });

  it('shows the teaching banner when prominent', () => {
    const { root, hud } = mount();
    hud.setRoundPhase({ phase: 'countdown', secondsLeft: 3, prominent: true });
    const banner = root.querySelector('.hud-banner') as HTMLElement;
    expect(banner.className).not.toContain('hud-banner--hidden');
    expect(root.querySelector('.hud-banner-word')?.textContent).toBe('TAKE AIM');
    expect(root.querySelector('.hud-banner-count')?.textContent).toBe('3');
    // and not both at once
    expect(root.querySelector('.hud-phase')?.className).toContain('hud-phase--hidden');
    hud.dispose();
  });

  it('shows the quiet chip when not prominent', () => {
    const { root, hud } = mount();
    hud.setRoundPhase({ phase: 'grace', secondsLeft: 2, prominent: false });
    expect(root.querySelector('.hud-phase')?.textContent).toBe('MOVE 2');
    expect(root.querySelector('.hud-phase')?.className).not.toContain('hud-phase--hidden');
    expect(root.querySelector('.hud-banner')?.className).toContain('hud-banner--hidden');
    hud.dispose();
  });

  it('uses the phase word, not a generic countdown', () => {
    const { root, hud } = mount();
    hud.setRoundPhase({ phase: 'countdown', secondsLeft: 1, prominent: false });
    expect(root.querySelector('.hud-phase')?.textContent).toBe('AIM 1');
    hud.setRoundPhase({ phase: 'grace', secondsLeft: 1, prominent: false });
    expect(root.querySelector('.hud-phase')?.textContent).toBe('MOVE 1');
    hud.dispose();
  });

  it('hides on null and on live', () => {
    const { root, hud } = mount();
    hud.setRoundPhase({ phase: 'countdown', secondsLeft: 3, prominent: true });
    hud.setRoundPhase(null);
    expect(root.querySelector('.hud-banner')?.className).toContain('hud-banner--hidden');
    hud.setRoundPhase({ phase: 'countdown', secondsLeft: 3, prominent: false });
    hud.setRoundPhase({ phase: 'live', secondsLeft: 0, prominent: false });
    expect(root.querySelector('.hud-phase')?.className).toContain('hud-phase--hidden');
    hud.dispose();
  });

});

describe('hud: level progression', () => {
  it('shows the level position once told, and only in a multi-level sequence', () => {
    const { hud: h, root } = mount();
    const chip = (): HTMLElement => root.querySelector('.hud-level') as HTMLElement;
    expect(chip().className).toContain('hud-level--hidden'); // nothing until setLevel

    h.setLevel(1, 2);
    expect(chip().className).not.toContain('hud-level--hidden');
    expect(chip().textContent).toContain('1/2');

    // A one-level sequence (the sandbox) shows no chip: "Level 1/1" is noise.
    h.setLevel(1, 1);
    expect(chip().className).toContain('hud-level--hidden');
  });

  it('offers Next Level on an intermediate win, Play Again on the final one', () => {
    const { hud: h, root } = mount();
    const title = (): string => (root.querySelector('.hud-title') as HTMLElement).textContent ?? '';
    const button = (): string => (root.querySelector('.hud-action') as HTMLElement).textContent ?? '';

    h.setLevel(1, 2);
    h.setState('win');
    expect(title()).toContain('cleared');
    expect(button()).toBe('Next Level');

    h.setLevel(2, 2);
    h.setState('win'); // re-renders unconditionally; the equal-state guard lives in state.ts, not here
    expect(title()).toBe('You Win!');
    expect(button()).toBe('Play Again');
  });

  it('never says cleared before setLevel has been called at all', () => {
    // A HUD that has not been told about levels behaves exactly as it always did.
    const { hud: h, root } = mount();
    h.setState('win');
    expect((root.querySelector('.hud-title') as HTMLElement).textContent).toBe('You Win!');
  });
});

describe('hud: pause panel', () => {
  const panel = (root: HTMLElement): HTMLElement => root.querySelector('.hud-panel') as HTMLElement;
  const quit = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-quit') as HTMLButtonElement;
  const settings = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-panel-settings') as HTMLElement;

  it('shows the frozen-scene panel with Resume, Quit and the audio pair', () => {
    const { hud: h, root } = mount();
    h.setState('paused');
    expect(panel(root).classList.contains('hud-panel--hidden')).toBe(false);
    expect((root.querySelector('.hud-title') as HTMLElement).textContent).toBe('Paused');
    expect((root.querySelector('.hud-action') as HTMLElement).textContent).toBe('Resume');
    expect(quit(root).classList.contains('hud-quit--hidden')).toBe(false);
    expect(settings(root).classList.contains('hud-panel-settings--hidden')).toBe(false);
  });

  it('keeps Quit out of every other panel state, and settings off the END screens', () => {
    // Population: all four non-paused states. A quit button on the win panel would
    // be a second untested path out of a finished game. The settings row serves the
    // TITLE (the main menu) and pause; win/lose panels stay verdict-only.
    const { hud: h, root } = mount();
    for (const s of ['title', 'win', 'lose'] as const) {
      h.setState(s);
      expect(quit(root).classList.contains('hud-quit--hidden'), s).toBe(true);
    }
    for (const s of ['win', 'lose'] as const) {
      h.setState(s);
      expect(settings(root).classList.contains('hud-panel-settings--hidden'), s).toBe(true);
    }
    h.setState('title');
    expect(settings(root).classList.contains('hud-panel-settings--hidden')).toBe(false);
    h.setState('playing'); // panel hidden entirely
    expect(panel(root).classList.contains('hud-panel--hidden')).toBe(true);
  });

  it('does NOT render a Game Over corpse screen for paused', () => {
    // setState's final else renders "Game Over"; a forgotten branch for a new state
    // lands exactly there. This is the pin that keeps 'paused' out of it.
    const { hud: h, root } = mount();
    h.setState('paused');
    expect((root.querySelector('.hud-title') as HTMLElement).textContent).not.toBe('Game Over');
  });

  it('notifies quit subscribers, separately from start/restart', () => {
    const { hud: h, root } = mount();
    let quits = 0;
    let starts = 0;
    h.onQuitToTitle(() => quits++);
    h.onStartRestart(() => starts++);
    h.setState('paused');
    quit(root).dispatchEvent(new MouseEvent('click'));
    expect(quits).toBe(1);
    expect(starts).toBe(0);
  });

  it('mirrors mute state onto the panel button too', () => {
    const { hud: h, root } = mount();
    h.setMuted(true);
    expect((root.querySelector('.hud-panel-mute') as HTMLElement).textContent).toBe('Muted (M)');
    expect((root.querySelector('.hud-mute') as HTMLElement).textContent).toBe('Muted (M)');
  });

  it('panel volume slider reports changes and keeps the topbar slider in step', () => {
    const { hud: h, root } = mount();
    const seen: number[] = [];
    h.onVolumeChange((v) => seen.push(v));
    const panelSlider = root.querySelector('.hud-panel-volume') as HTMLInputElement;
    panelSlider.value = '0.2';
    panelSlider.dispatchEvent(new Event('input'));
    expect(seen).toEqual([0.2]);
    expect((root.querySelector('.hud-volume') as HTMLInputElement).value).toBe('0.2');
  });

  it('topbar slider keeps the panel slider in step, so reopening pause never lies', () => {
    const { hud: h, root } = mount();
    void h;
    const topbar = root.querySelector('.hud-volume') as HTMLInputElement;
    topbar.value = '0.7';
    topbar.dispatchEvent(new Event('input'));
    expect((root.querySelector('.hud-panel-volume') as HTMLInputElement).value).toBe('0.7');
  });

  it('the aim-scheme toggle shows the current scheme, labelled so the schemes read as different', () => {
    const { hud: h, root } = mount();
    const toggle = () => root.querySelector('.hud-scheme-toggle') as HTMLButtonElement;

    h.setTouchScheme('stick');
    expect(toggle().textContent).toMatch(/stick/i);
    const stickLabel = toggle().textContent;
    const stickAria = toggle().getAttribute('aria-label');

    h.setTouchScheme('point');
    expect(toggle().textContent).toMatch(/point/i);
    // Not just different case of the same string -- genuinely distinct copy, so a
    // screen-reader user or a sighted player gets an actual explanation of each.
    expect(toggle().textContent).not.toBe(stickLabel);
    expect(toggle().getAttribute('aria-label')).not.toBe(stickAria);
  });

  it('taps the toggle and reports the OTHER scheme, from a real click at the button', () => {
    // Same composition-blindness reasoning as the Pause/Mine/Fire button tests: drive
    // a real event at a real element rather than only invoking the callback directly.
    const { hud: h, root } = mount();
    const seen: string[] = [];
    h.onTouchSchemeChange((s) => seen.push(s));
    h.setTouchScheme('stick');

    const toggle = root.querySelector('.hud-scheme-toggle') as HTMLButtonElement;
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen, 'the toggle is not wired to anything').toEqual(['point']);

    // The button does NOT flip its own label -- it only reports the choice. The loop
    // echoes the ACCEPTED value back via setTouchScheme, same convention as the hull
    // and skin pickers, so the label must not move until that echo arrives.
    expect(root.querySelector('.hud-scheme-toggle')!.textContent).toMatch(/stick/i);

    h.setTouchScheme('point'); // the loop's echo
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen).toEqual(['point', 'stick']);
  });

  it('the aim-scheme toggle is reachable from the title screen too, not just pause', () => {
    // The settings row (and everything in it) shows on 'title' AND 'paused' -- see the
    // shared visibility test above. This pins that the toggle specifically rides along,
    // since a row-level class check cannot tell "the row is visible" from "the row is
    // visible AND still has every control in it".
    const { hud: h, root } = mount();
    h.setState('title');
    const toggle = root.querySelector('.hud-scheme-toggle') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    const settingsRow = root.querySelector('.hud-panel-settings') as HTMLElement;
    expect(settingsRow.classList.contains('hud-panel-settings--hidden')).toBe(false);
    expect(settingsRow.contains(toggle)).toBe(true);
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

  it('is reachable from the title screen too, not just pause', () => {
    const { hud: h, root } = mount();
    h.setState('title');
    const toggle = root.querySelector('.hud-firemode-toggle') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    const settingsRow = root.querySelector('.hud-panel-settings') as HTMLElement;
    expect(settingsRow.classList.contains('hud-panel-settings--hidden')).toBe(false);
    expect(settingsRow.contains(toggle)).toBe(true);
  });
});

describe('hud: the Level Select screen', () => {
  const view = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-levelselect') as HTMLElement;
  const grid = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-levels') as HTMLElement;
  const openBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-levelselect-open') as HTMLButtonElement;
  const backBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-levelselect-back') as HTMLButtonElement;
  const actionBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-action') as HTMLButtonElement;
  const tiles = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll('.hud-level-btn'));
  const columns = (root: HTMLElement): number =>
    Number(grid(root).style.getPropertyValue('--hud-level-cols'));
  const stateWords = (root: HTMLElement): (string | null)[] =>
    tiles(root).map((t) => t.querySelector('.hud-level-btn-state')?.textContent ?? null);
  /** A four-level campaign with nothing cleared, unless the caller says otherwise. */
  const seq = (over: Partial<LevelSelectState> = {}): LevelSelectState => ({
    total: 4,
    unlocked: 1,
    cleared: 0,
    resume: 0,
    ...over,
  });

  it('lays the grid out from the level count, at every count swept', () => {
    // THE assertion that makes the next level free, and the reason this screen is not
    // a row of four buttons: adding a level is a JSON edit (CLAUDE.md, "Arenas are
    // data too"), so nothing here may be a four-slot anything.
    //
    // Proved before it was written. Two mutations, each applied on its own to hud.ts
    // and measured against the WHOLE gate (`npx vitest run`, 2008 tests in 96 files):
    //
    //   - renderLevelGrid's loop bound hardcoded to `i < 4`: 3 of 2008 fail, all in
    //     this file -- this test and the two neighbours that happen to render 5 and 2
    //     levels.
    //   - the column write hardcoded to `'2'`: 1 of 2008 fails. THIS TEST ALONE. The
    //     shipped four-level campaign IS a two-column grid, so nothing else anywhere
    //     in the tree can tell a computed column count from that constant.
    const { hud: h, root } = mount();
    const seen: Array<{ total: number; tiles: number; cols: number }> = [];
    // Population: these 12 counts. 1..5 covers every size the game has shipped or is
    // one arena away from; 11 is the approved difficulty-curve arc
    // (docs/superpowers/specs/2026-08-02-difficulty-curve-design.md); 9/12/16/25/30/64
    // reach and pass the column cap.
    const COUNTS = [1, 2, 3, 4, 5, 9, 11, 12, 16, 25, 30, 64];
    for (const total of COUNTS) {
      h.setLevelSelect(seq({ total, unlocked: total }));
      seen.push({ total, tiles: tiles(root).length, cols: columns(root) });
      // Every level, once, in order -- not merely the right NUMBER of tiles.
      expect(tiles(root).map((t) => t.dataset.level), `total ${total}`).toEqual(
        Array.from({ length: total }, (_, i) => String(i + 1)),
      );
    }

    // One tile per level at every count in the sweep.
    expect(seen.map((r) => r.tiles)).toEqual(COUNTS);

    // ...and the LAYOUT moves with the count rather than the tiles merely piling into
    // a fixed track list. Pinned exactly, because "it changed at least once" would
    // pass on a two-valued step function.
    expect(seen.map((r) => r.cols)).toEqual([1, 2, 2, 2, 3, 3, 4, 4, 4, 5, 6, 6]);
    // Three properties that vector has to have, stated separately so retuning
    // levelSelectColumns is a one-line edit rather than a rewrite: never wider than
    // the cap (a 64-tile row would leave the viewport), never narrower as the count
    // grows, and never zero, which is not a grid.
    expect(Math.max(...seen.map((r) => r.cols))).toBeLessThanOrEqual(LEVEL_GRID_MAX_COLS);
    expect(seen.map((r) => r.cols)).toEqual([...seen.map((r) => r.cols)].sort((a, b) => a - b));
    expect(Math.min(...seen.map((r) => r.cols))).toBeGreaterThan(0);
    // And the exported function agrees with what the DOM actually got, which is what
    // lets hud.css.test.ts reason about the same number.
    for (const r of seen) expect(levelSelectColumns(r.total), `total ${r.total}`).toBe(r.cols);
  });

  it('shows each level as cleared, open, locked, or the one Continue resumes', () => {
    // The per-level identity this screen has without inventing data. A screen that
    // only numbered its tiles would pass every OTHER test in this block.
    const { hud: h, root } = mount();
    // Two cleared of five: 1 and 2 done, 3 is where Continue lands, 4 and 5 locked.
    h.setLevelSelect({ total: 5, unlocked: 3, cleared: 2, resume: 2 });
    expect(stateWords(root)).toEqual(['Cleared', 'Cleared', 'Continue', 'Locked', 'Locked']);
    // Population: all 5 tiles, on each of the three modifiers.
    expect(tiles(root).map((t) => t.classList.contains('hud-level-btn--cleared'))).toEqual([
      true, true, false, false, false,
    ]);
    expect(tiles(root).map((t) => t.classList.contains('hud-level-btn--resume'))).toEqual([
      false, false, true, false, false,
    ]);
    expect(tiles(root).map((t) => t.classList.contains('hud-level-btn--locked'))).toEqual([
      false, false, false, true, true,
    ]);
    // Locked is DISABLED, not merely grey: a disabled button fires no click handler.
    expect(tiles(root).map((t) => t.disabled)).toEqual([false, false, false, true, true]);
    // Spelled out, or the two spans are announced as "3Continue".
    expect(tiles(root).map((t) => t.getAttribute('aria-label'))).toEqual([
      'Level 1, cleared',
      'Level 2, cleared',
      'Level 3, continue',
      'Level 4, locked',
      'Level 5, locked',
    ]);
    expect(root.querySelector('.hud-levelselect-count')?.textContent).toBe('2 of 5 cleared');
  });

  it('never marks a locked level as the one Continue resumes', () => {
    // `resume` comes from the caller (levels.start). A caller bug must read as a bug,
    // not as an invitation into a level this same screen shows as locked.
    const { hud: h, root } = mount();
    h.setLevelSelect({ total: 4, unlocked: 1, cleared: 0, resume: 3 });
    expect(tiles(root).map((t) => t.classList.contains('hud-level-btn--resume'))).toEqual([
      false, false, false, false,
    ]);
    expect(stateWords(root)).toEqual(['Open', 'Locked', 'Locked', 'Locked']);
  });

  it('marks the resume tile with the primary action’s OWN word, not a fixed one', () => {
    // Caught in a real browser, not by a test: on a fresh save the button read "Start"
    // and the tile directly under it read "CONTINUE". Two views of one fact, and they
    // disagreed -- which is the defect this whole screen exists to remove. Both now
    // come from primaryActionVerb.
    const { hud: h, root } = mount();
    const action = root.querySelector('.hud-action') as HTMLButtonElement;
    for (const resume of [0, 1, 2, 3]) {
      h.setLevelSelect({ total: 4, unlocked: resume + 1, cleared: resume, resume });
      h.setState('title');
      const marked = tiles(root).find((t) => t.classList.contains('hud-level-btn--resume'));
      const word = marked?.querySelector('.hud-level-btn-state')?.textContent ?? '(none)';
      expect(word, `resume ${resume}`).toBe(primaryActionVerb(resume));
      // ...and the button's own label starts with that same word.
      expect(action.textContent?.startsWith(word), `resume ${resume}`).toBe(true);
    }
  });

  it('reports a click on an unlocked level, 0-based, and nothing for a locked one', () => {
    const { hud: h, root } = mount();
    const picks: number[] = [];
    h.onLevelSelect((i) => picks.push(i));
    h.setLevelSelect(seq({ unlocked: 2 }));
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    tiles(root)[1].dispatchEvent(new MouseEvent('click'));
    tiles(root)[2].dispatchEvent(new MouseEvent('click')); // locked: disabled anyway
    expect(picks).toEqual([1]);
  });

  it('opens from the menu button and closes on Back, like every other pane', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(seq());
    h.setState('title');
    const panel = root.querySelector('.hud-panel') as HTMLElement;
    expect(view(root).classList.contains('hud-levelselect--hidden')).toBe(true);

    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(view(root).classList.contains('hud-levelselect--hidden')).toBe(false);
    // The menu goes away behind it, or the two panels stack.
    expect(panel.classList.contains('hud-panel--hidden')).toBe(true);

    backBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(view(root).classList.contains('hud-levelselect--hidden')).toBe(true);
    expect(panel.classList.contains('hud-panel--hidden')).toBe(false);
  });

  it('is closed by ANY state change, so it cannot sit over a live game', () => {
    // The setState chokepoint, same as stats/customize/achievements. Without it the
    // pane survives Start and the player is looking at a menu over their own game.
    // Population: all four states reachable from a pane opened on the title screen.
    //
    // Proved: deleting setState's `levelSelectView.classList.add(...)` line fails 1 of
    // this file's 105 tests -- this one. Scoped to this file; the rest of the tree was
    // not swept for that mutation.
    for (const s of ['playing', 'paused', 'win', 'lose'] as const) {
      const { hud: h, root } = mount();
      h.setLevelSelect(seq());
      h.setState('title');
      openBtn(root).dispatchEvent(new MouseEvent('click'));
      expect(view(root).classList.contains('hud-levelselect--hidden'), s).toBe(false);
      h.setState(s);
      expect(view(root).classList.contains('hud-levelselect--hidden'), s).toBe(true);
      h.dispose();
      document.body.innerHTML = '';
    }
  });

  it('offers the button on the title panel only, and only when there is a choice', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(seq());
    h.setState('title');
    expect(openBtn(root).classList.contains('hud-levelselect-open--hidden')).toBe(false);
    for (const s of ['paused', 'win', 'lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-levelselect-open--hidden'), s).toBe(true);
    }
    // A one-level sequence is the sandbox: there is nothing to select between.
    h.setState('title');
    h.setLevelSelect(seq({ total: 1, unlocked: 1 }));
    expect(openBtn(root).classList.contains('hud-levelselect-open--hidden')).toBe(true);
  });

  it('re-rendering after an unlock replaces the tiles rather than appending', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(seq({ total: 2, unlocked: 1 }));
    h.setLevelSelect(seq({ total: 2, unlocked: 2, cleared: 1, resume: 1 }));
    expect(tiles(root)).toHaveLength(2);
    expect(tiles(root)[1].disabled).toBe(false);
  });

  it('a push while another panel is up must not open the screen or relabel that panel', () => {
    // The natural call order: the loop records an unlock AT the win event and pushes
    // the new state -- while the WIN panel is showing. Neither the Level Select button
    // nor a Continue label belongs on a win screen.
    const { hud: h, root } = mount();
    h.setState('win');
    h.setLevelSelect(seq({ total: 2, unlocked: 2, cleared: 1, resume: 1 }));
    expect(view(root).classList.contains('hud-levelselect--hidden')).toBe(true);
    expect(openBtn(root).classList.contains('hud-levelselect-open--hidden')).toBe(true);
    expect(actionBtn(root).textContent).toBe('Play Again');
    // ...and the title screen picks it all up when it next renders.
    h.setState('title');
    expect(openBtn(root).classList.contains('hud-levelselect-open--hidden')).toBe(false);
    expect(actionBtn(root).textContent).toBe('Continue — Level 2');
  });
});

describe('hud: the Continue / New Game split', () => {
  const actionBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-action') as HTMLButtonElement;
  const newGameBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-newgame') as HTMLButtonElement;
  const newGameHidden = (root: HTMLElement): boolean =>
    newGameBtn(root).classList.contains('hud-newgame--hidden');

  it('names the level it resumes, so the button says what it does', () => {
    // The defect in the issue's title: the button read "Start" and started level 3.
    // Population: every 0-based resume a four-level campaign can produce.
    //
    // Proved: forcing `actionBtn.textContent = 'Start'` unconditionally fails 2 of the
    // 291 tests in hud.test.ts + loop.test.ts + hud.css.test.ts -- this one and the
    // "push while another panel is up" neighbour.
    const { hud: h, root } = mount();
    const labels: string[] = [];
    for (const resume of [0, 1, 2, 3]) {
      h.setLevelSelect({ total: 4, unlocked: resume + 1, cleared: resume, resume });
      h.setState('title');
      labels.push(actionBtn(root).textContent ?? '');
    }
    expect(labels).toEqual([
      'Start', // nothing cleared: "Continue - Level 1" is a fresh start dressed up
      'Continue — Level 2',
      'Continue — Level 3',
      'Continue — Level 4',
    ]);
  });

  it('says Start, and offers no New Game, when there is nothing to continue', () => {
    // Deliberate: with nothing cleared, Start and New Game are the same action, and a
    // menu offering one action twice teaches the player that the words mean nothing.
    //
    // Proved: showing New Game unconditionally fails 2 of those same 291 -- this one
    // and "defaults to Start when nothing has told it about levels at all".
    const { hud: h, root } = mount();
    h.setLevelSelect({ total: 4, unlocked: 1, cleared: 0, resume: 0 });
    h.setState('title');
    expect(actionBtn(root).textContent).toBe('Start');
    expect(newGameHidden(root)).toBe(true);
  });

  it('offers New Game once there is progress, and fires it', () => {
    const { hud: h, root } = mount();
    const fired: string[] = [];
    h.onNewGame(() => fired.push('new'));
    h.setLevelSelect({ total: 4, unlocked: 3, cleared: 2, resume: 2 });
    h.setState('title');
    expect(newGameHidden(root)).toBe(false);
    newGameBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(fired).toEqual(['new']);
  });

  it('keeps New Game off every panel that is not the title screen', () => {
    // It is a menu affair, like Level Select. On the pause panel it would be a second
    // untested path out of a live game; on win/lose it duplicates the action button.
    const { hud: h, root } = mount();
    h.setLevelSelect({ total: 4, unlocked: 3, cleared: 2, resume: 2 });
    for (const s of ['paused', 'win', 'lose'] as const) {
      h.setState(s);
      expect(newGameHidden(root), s).toBe(true);
    }
    h.setState('title');
    expect(newGameHidden(root)).toBe(false);
  });

  it('leaves the other panels’ action labels alone', () => {
    // Only the title branch changed. Population: the pause panel, the lose panel and
    // both win variants.
    const { hud: h, root } = mount();
    h.setLevelSelect({ total: 4, unlocked: 3, cleared: 2, resume: 2 });
    h.setLevel(2, 4);
    h.setState('paused');
    expect(actionBtn(root).textContent).toBe('Resume');
    h.setState('win');
    expect(actionBtn(root).textContent).toBe('Next Level');
    h.setLevel(4, 4);
    h.setState('win');
    expect(actionBtn(root).textContent).toBe('Play Again');
    h.setState('lose');
    expect(actionBtn(root).textContent).toBe('Retry');
  });

  it('defaults to Start when nothing has told it about levels at all', () => {
    // A HUD constructed and shown without a setLevelSelect push -- loop.ts's boot
    // order puts hud.setState BEFORE the first push. Reading `resume` off a null
    // state must not render "Continue - Level NaN".
    const { hud: h, root } = mount();
    h.setState('title');
    expect(actionBtn(root).textContent).toBe('Start');
    expect(newGameHidden(root)).toBe(true);
  });

  it('stops firing New Game after dispose', () => {
    const { hud: h, root } = mount();
    const fired: string[] = [];
    h.onNewGame(() => fired.push('new'));
    h.setLevelSelect({ total: 4, unlocked: 3, cleared: 2, resume: 2 });
    h.setState('title');
    const btn = newGameBtn(root);
    h.dispose();
    btn.dispatchEvent(new MouseEvent('click'));
    expect(fired).toEqual([]);
  });
});

describe('hud: the stats page', () => {
  const statsView = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-stats') as HTMLElement;
  const openBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-stats-open') as HTMLButtonElement;
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
    const { hud: h, root } = mount();
    h.setStats({ lifetime: SOME, run: NONE });
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(statsView(root).classList.contains('hud-stats--hidden')).toBe(false);
    expect(cell(root, 'Shell kills', 0)).toBe('4'); // lifetime column
    expect(cell(root, 'Shell kills', 1)).toBe('0'); // run column
    (root.querySelector('.hud-stats-back') as HTMLButtonElement).dispatchEvent(new MouseEvent('click'));
    expect(statsView(root).classList.contains('hud-stats--hidden')).toBe(true);
  });

  it('derives both accuracies, and shows -- when the denominator is zero', () => {
    const { hud: h, root } = mount();
    h.setStats({ lifetime: SOME, run: NONE });
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(cell(root, 'Accuracy', 0)).toBe('40%'); // 4 shell kills / 10 shots
    expect(cell(root, 'Mine accuracy', 0)).toBe('50%'); // 1 mine kill / 2 laid
    expect(cell(root, 'Accuracy', 1)).toBe('--'); // 0 shots this run
  });

  it('the Stats button lives on the title panel only', () => {
    const { hud: h, root } = mount();
    for (const s of ['paused', 'win', 'lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-stats-open--hidden'), s).toBe(true);
    }
    h.setState('title');
    expect(openBtn(root).classList.contains('hud-stats-open--hidden')).toBe(false);
  });

  it('both resets are two-click: the first arms, the second fires', () => {
    const { hud: h, root } = mount();
    let statResets = 0;
    let progResets = 0;
    h.onResetStats(() => statResets++);
    h.onResetProgress(() => progResets++);
    h.setStats({ lifetime: SOME, run: NONE });
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));

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
    h.setStats({ lifetime: SOME, run: NONE });
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    const reset = root.querySelector('.hud-reset-stats') as HTMLButtonElement;
    const prog = root.querySelector('.hud-reset-progress') as HTMLButtonElement;
    reset.dispatchEvent(new MouseEvent('click'));
    expect(prog.textContent).toBe('Reset progress'); // untouched
    (root.querySelector('.hud-stats-back') as HTMLButtonElement).dispatchEvent(new MouseEvent('click'));
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(reset.textContent).toBe('Reset stats'); // disarmed by leaving
  });

  it('win panel carries the run summary line', () => {
    const { hud: h, root } = mount();
    h.setStats({ lifetime: SOME, run: { ...NONE, shellKills: 3, shotsFired: 6, deaths: 1 } });
    h.setState('win');
    const line = (root.querySelector('.hud-run-summary') as HTMLElement).textContent ?? '';
    expect(line).toContain('3 kills');
    expect(line).toContain('50%');
    // And updates if the final batch lands after the panel opened -- the winning
    // kill is recorded a beat after the state flips.
    h.setStats({ lifetime: SOME, run: { ...NONE, shellKills: 4, shotsFired: 6, deaths: 1 } });
    expect((root.querySelector('.hud-run-summary') as HTMLElement).textContent).toContain('4 kills');
  });
});

describe('hud: achievements', () => {
  const openBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-achievements-open') as HTMLButtonElement;
  const page = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-achievements') as HTMLElement;
  const rows = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll('.hud-achievement'));

  it('lists every catalog entry, marking only the earned ones', () => {
    const { hud: h, root } = mount();
    h.setAchievements(new Set(['first-blood', 'flawless'] as const));
    h.setState('title');
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
    h.setState('title');
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
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    h.setState('playing');
    expect(page(root).classList.contains('hud-achievements--hidden')).toBe(true);
    for (const s of ['paused', 'win', 'lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-achievements-open--hidden'), s).toBe(true);
    }
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
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(pane(root).classList.contains('hud-customize--hidden')).toBe(false);
    expect(swatches(root).length).toBeGreaterThanOrEqual(6);
    const selected = swatches(root).filter((b) => b.classList.contains('hud-swatch--selected'));
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.hull).toBe('red');
  });

  it('reports a pick by id and re-marks the selection', () => {
    const { hud: h, root } = mount();
    const picks: string[] = [];
    h.onPickHullColor((id) => picks.push(id));
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    const purple = swatches(root).find((b) => b.dataset.hull === 'purple')!;
    purple.dispatchEvent(new MouseEvent('click'));
    expect(picks).toEqual(['purple']);
    h.setHullColor('purple'); // the loop echoes the accepted pick back
    expect(purple.classList.contains('hud-swatch--selected')).toBe(true);
  });

  it('offers one skin button per SKINS entry, current one marked, and reports picks', () => {
    const { hud: h, root } = mount();
    const skins = (): HTMLButtonElement[] => Array.from(root.querySelectorAll('.hud-skin'));
    const picks: string[] = [];
    h.onPickSkin((id) => picks.push(id));
    h.setSkin('camo');
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    // One button per entry in the REAL skin list, labelled from it.
    expect(skins().map((b) => b.dataset.skin)).toEqual(SKINS.map((sk) => sk.id));
    expect(skins().map((b) => b.textContent)).toEqual(SKINS.map((sk) => sk.label));
    const selected = skins().filter((b) => b.classList.contains('hud-skin--selected'));
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.skin).toBe('camo');

    const checker = skins().find((b) => b.dataset.skin === 'checker')!;
    checker.dispatchEvent(new MouseEvent('click'));
    expect(picks).toEqual(['checker']);
    h.setSkin('checker'); // the loop echoes the accepted pick back
    expect(checker.classList.contains('hud-skin--selected')).toBe(true);
    expect(skins().filter((b) => b.classList.contains('hud-skin--selected'))).toHaveLength(1);
  });

  it('offers one accent swatch per ACCENTS entry, current one marked, and reports picks', () => {
    const { hud: h, root } = mount();
    const picks: string[] = [];
    h.onPickAccentColor((id) => picks.push(id));
    h.setAccentColor('black');
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    // One button per entry in the REAL accent list, `auto` first.
    expect(accentSwatches(root).map((b) => b.dataset.accent)).toEqual(
      ACCENTS.map((a) => a.id),
    );
    const selected = accentSwatches(root).filter((b) =>
      b.classList.contains('hud-swatch--selected'),
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.accent).toBe('black');

    const gold = accentSwatches(root).find((b) => b.dataset.accent === 'gold')!;
    gold.dispatchEvent(new MouseEvent('click'));
    expect(picks).toEqual(['gold']);
    h.setAccentColor('gold'); // the loop echoes the accepted pick back
    expect(gold.classList.contains('hud-swatch--selected')).toBe(true);
    expect(
      accentSwatches(root).filter((b) => b.classList.contains('hud-swatch--selected')),
    ).toHaveLength(1);
  });

  it('is a title-screen affair: hidden everywhere else, closed by any state change', () => {
    const { hud: h, root } = mount();
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    h.setState('playing');
    expect(pane(root).classList.contains('hud-customize--hidden')).toBe(true);
    for (const s of ['paused', 'win', 'lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-customize-open--hidden'), s).toBe(true);
    }
  });

  // The accent-hint feature (a <p> shown only for solid+explicit-accent) was removed
  // along with the rest of the panel's prose: Austin asked for exactly two labelled
  // sections (Hull, Skin) with the rest self-explanatory once the panel has a real
  // preview. The preview does not resolve the ambiguity the hint used to name (a
  // solid-skin tank still shows no visible change when an accent is picked) any more
  // than the old background tank did -- it makes the absence of change more vivid,
  // not less confusing on its own -- but the selection ring still confirms the pick
  // registered, and Austin's instruction is explicit enough on its own to cut this
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
    h.setState('title');
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
    h.setState('title');
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
    h.setState('title');
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
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    h.setState('playing'); // closes it -- one close
    h.setState('title');
    h.setState('paused');
    expect(closes).toHaveLength(1);
  });
});
