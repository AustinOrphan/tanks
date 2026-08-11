// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type Hud } from './hud';
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
    // The single 'Start' button is retired at title: New Game is always offered, and
    // Continue only once there is something to resume -- see 'hud: continue vs new game'.
    expect(action(root).classList.contains('hud-action--hidden'), 'the old action button must hide at title').toBe(true);
    expect(root.querySelector('.hud-new-game')!.classList.contains('hud-new-game--hidden'), 'New Game must show with no progress').toBe(false);
    expect(root.querySelector('.hud-continue')!.classList.contains('hud-continue--hidden'), 'Continue must stay hidden with no progress').toBe(true);
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

  it('does not let the tap that dismisses the title screen press Continue underneath it', () => {
    // MEASURED on a Pixel 5: one centre tap left the splash AND started the game, so the
    // menu was never seen. The overlay hides on pointerdown and the browser completes
    // the click on whatever is now under the finger -- which is exactly where the action
    // button sits. A centre mouse click did the same.
    //
    // Uses Continue, not the retired .hud-action: it is the button a player at title with
    // some progress actually sees, and it fires onStartRestart exactly as the old single
    // action button did, so the assertion below still means what it says.
    const { hud: h, root } = mount();
    let starts = 0;
    h.onStartRestart(() => {
      starts += 1;
    });
    h.setLevelSelect(2, 2); // some progress, so Continue is the visible button
    // The real sequence: a pointer lands on the overlay, loop.ts dismisses on that same
    // pointerdown, and the browser then completes the click on the button beneath.
    const splash = root.querySelector('.hud-splash') as HTMLElement;
    splash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    h.setState('title');
    const action = root.querySelector('.hud-continue') as HTMLButtonElement;

    action.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(starts, 'the dismissing gesture also pressed Continue').toBe(0);

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
    h.setLevelSelect(2, 2); // some progress, so Continue is the visible button
    const splash = root.querySelector('.hud-splash') as HTMLElement;
    splash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    h.setState('title');

    // The click never comes; the player instead touches the button deliberately.
    const action = root.querySelector('.hud-continue') as HTMLButtonElement;
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
    h.setLevelSelect(2, 2); // some progress, so Continue (not the retired action button) is visible
    const splash = root.querySelector('.hud-splash') as HTMLElement;
    splash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    h.setState('title'); // armed, and the drag's click never lands in the panel

    const hudEl = root.querySelector('.hud') as HTMLElement;
    hudEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    (root.querySelector('.hud-continue') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(starts, 'the first keyboard activation after a drag dismissal was eaten').toBe(1);
  });

  it('does not eat a click after a drag dismissal followed by ARROW-KEY navigation', () => {
    // The Tab test above cannot see this: roving focus (onNavKeyDown) claims arrow keys
    // at window in the CAPTURE phase and stops propagation, which -- before the fix --
    // starved el's own capture-phase disarm listener, so the pending swallow sat armed
    // through any amount of arrow navigation and ate the next REAL click (Enter/Space
    // self-corrects, a pointer click does not). The production change that breaks this:
    // onNavKeyDown claiming a key without also disarming the pending panel-click swallow.
    const { hud: h, root } = mount();
    let picks = 0;
    h.onLevelSelect(() => {
      picks += 1;
    });
    h.setLevelSelect(2, 2);
    const splash = root.querySelector('.hud-splash') as HTMLElement;
    splash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    h.setState('title'); // armed, and the drag's click never lands in the panel

    // Arrow navigation instead of Tab -- the roving-focus path this file adds.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    (root.querySelector('.hud-new-game') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(picks, 'the first real click after drag-dismiss + arrow navigation was eaten').toBe(1);
  });

  it('claims a navigation key outright while a panel is open, and not while playing', () => {
    // Pins onNavKeyDown's stopPropagation itself -- removing that call left every other
    // test in this file green (measured by mutation in review), because the
    // while-playing test only exercises the early-return branch that never reaches it.
    // A second window-bound BUBBLE listener stands in for input.ts's own: it must not
    // see a claimed key while a panel is open, and must see the same key while playing.
    const { hud: h } = mount();
    h.setState('title');
    const seen: string[] = [];
    const probe = (e: KeyboardEvent): void => {
      seen.push(e.key);
    };
    window.addEventListener('keydown', probe);
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      expect(seen, 'a claimed key leaked past the roving-focus handler to a bubble listener').toEqual([]);
      h.setState('playing');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      expect(seen, 'an unclaimed key while playing must still reach input.ts').toEqual(['ArrowDown']);
    } finally {
      window.removeEventListener('keydown', probe);
    }
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

  it('is reachable from the title screen too, not just pause', () => {
    const { hud: h, root } = mount();
    h.setState('title');
    const toggle = root.querySelector('.hud-haptics-toggle') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    const settingsRow = root.querySelector('.hud-panel-settings') as HTMLElement;
    expect(settingsRow.classList.contains('hud-panel-settings--hidden')).toBe(false);
    expect(settingsRow.contains(toggle)).toBe(true);
  });
});

describe('hud: level select panel', () => {
  // The row used to sit directly on the main menu; it is now a panel reached from a
  // "Levels" button, following the Stats/Achievements/Customize pattern exactly (see
  // issue #135). `openBtn`/`view` are the panel's own controls; `row`/`buttons` reach
  // into it the same way the old tests did.
  const openBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-levelselect-open') as HTMLButtonElement;
  const view = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-levelselect') as HTMLElement;
  const buttons = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll('.hud-level-btn'));

  it('renders one button per level, locking those past the unlock line', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 3); // cleared nothing beyond level 1's unlock
    const btns = buttons(root);
    expect(btns.map((b) => b.textContent)).toEqual(['1', '2', '3']);
    // Population: all 3 buttons. Level 1 open; 2 and 3 locked and DISABLED --
    // a locked level must be unclickable, not merely grey.
    expect(btns.map((b) => b.disabled)).toEqual([false, true, true]);
    expect(btns.map((b) => b.classList.contains('hud-level-btn--locked')))
      .toEqual([false, true, true]);
  });

  it('reports a click on an unlocked level, 0-based, and nothing for a locked one', () => {
    const { hud: h, root } = mount();
    const picks: number[] = [];
    h.onLevelSelect((i) => picks.push(i));
    h.setLevelSelect(2, 3);
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    buttons(root)[1].dispatchEvent(new MouseEvent('click'));
    buttons(root)[2].dispatchEvent(new MouseEvent('click')); // locked: disabled anyway
    expect(picks).toEqual([1]);
  });

  it('the Levels button opens the panel, and Back returns to the menu', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 2);
    h.setState('title');
    expect(view(root).classList.contains('hud-levelselect--hidden')).toBe(true);
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(view(root).classList.contains('hud-levelselect--hidden')).toBe(false);
    (root.querySelector('.hud-levelselect-back') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click'),
    );
    expect(view(root).classList.contains('hud-levelselect--hidden')).toBe(true);
  });

  it('the Levels button lives on the title panel only', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 2);
    h.setState('title');
    expect(openBtn(root).classList.contains('hud-levelselect-open--hidden')).toBe(false);
    for (const s of ['paused', 'win', 'lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-levelselect-open--hidden'), s).toBe(true);
    }
  });

  it('hides the Levels button entirely for a one-level sequence (the sandbox)', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 1);
    h.setState('title');
    expect(openBtn(root).classList.contains('hud-levelselect-open--hidden')).toBe(true);
  });

  it('is a title-screen affair, closed by any state change', () => {
    // Mirrors 'hud: achievements'' "is a title-screen affair" test: setState is the ONE
    // chokepoint that closes every panel unconditionally, so a caller cannot leave this
    // one sitting over a live game.
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 2);
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    h.setState('playing');
    expect(view(root).classList.contains('hud-levelselect--hidden')).toBe(true);
  });

  it('a re-render while another panel is up must not splash the Levels button onto it', () => {
    // The natural call order: the loop records an unlock AT the win event and
    // refreshes the select -- while the WIN panel is showing.
    const { hud: h, root } = mount();
    h.setState('win');
    h.setLevelSelect(2, 2);
    expect(openBtn(root).classList.contains('hud-levelselect-open--hidden')).toBe(true);
    h.setState('title');
    expect(openBtn(root).classList.contains('hud-levelselect-open--hidden')).toBe(false);
  });

  it('re-rendering after an unlock replaces the buttons rather than appending', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 2);
    h.setLevelSelect(2, 2); // level 1 cleared -> level 2 unlocks
    expect(buttons(root)).toHaveLength(2);
    expect(buttons(root)[1].disabled).toBe(false);
  });
});

describe('hud: continue vs new game', () => {
  const continueBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-continue') as HTMLButtonElement;
  const newGameBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-new-game') as HTMLButtonElement;

  it('Continue is absent at zero progress, and appears once a level is cleared', () => {
    // The assertion that can fail where "the button exists" cannot (issue #135): a
    // production change dropping the `unlocked > 1` check, or one that always shows
    // Continue, both break this.
    const { hud: h, root } = mount();
    h.setState('title');
    h.setLevelSelect(1, 4); // nothing cleared yet: only level 1 unlocked
    expect(continueBtn(root).classList.contains('hud-continue--hidden'), 'Continue must not show with no progress').toBe(true);
    expect(newGameBtn(root).classList.contains('hud-new-game--hidden')).toBe(false);

    h.setLevelSelect(2, 4); // level 1 cleared -> level 2 unlocks
    expect(continueBtn(root).classList.contains('hud-continue--hidden'), 'Continue must show once progress exists').toBe(false);
  });

  it('Continue fires the same onStartRestart callback the old single action button did', () => {
    const { hud: h, root } = mount();
    let starts = 0;
    h.onStartRestart(() => starts++);
    h.setState('title');
    h.setLevelSelect(2, 4);
    continueBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(starts).toBe(1);
  });

  it('New Game reports onLevelSelect(0), same as clicking level 1 in the panel', () => {
    // New Game IS "pick level 1" under a label that reads as starting fresh -- the
    // production change that would break this is New Game firing a different index,
    // or nothing at all.
    const { hud: h, root } = mount();
    const picks: number[] = [];
    h.onLevelSelect((i) => picks.push(i));
    h.setState('title');
    h.setLevelSelect(3, 4); // progress exists, but New Game must still target level 1
    newGameBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(picks).toEqual([0]);
  });

  it('New Game is always offered at title, with or without progress', () => {
    const { hud: h, root } = mount();
    h.setState('title');
    h.setLevelSelect(1, 4);
    expect(newGameBtn(root).classList.contains('hud-new-game--hidden')).toBe(false);
    h.setLevelSelect(4, 4);
    expect(newGameBtn(root).classList.contains('hud-new-game--hidden')).toBe(false);
  });

  it('both buttons are a title-screen affair, and the retired action button stays hidden there', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(2, 4);
    h.setState('title');
    expect(continueBtn(root).classList.contains('hud-continue--hidden')).toBe(false);
    expect(newGameBtn(root).classList.contains('hud-new-game--hidden')).toBe(false);
    for (const s of ['paused', 'win', 'lose'] as const) {
      h.setState(s);
      expect(continueBtn(root).classList.contains('hud-continue--hidden'), s).toBe(true);
      expect(newGameBtn(root).classList.contains('hud-new-game--hidden'), s).toBe(true);
      expect(
        (root.querySelector('.hud-action') as HTMLElement).classList.contains('hud-action--hidden'),
        s,
      ).toBe(false);
    }
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

describe('createHud roving-tabindex focus navigation (issue #115)', () => {
  it('every focus-target container names itself from its own heading', () => {
    // The five tabindex="-1" containers are what panel-open transitions focus; a bare
    // div's accessible name is the flattened text of everything inside it, so each one
    // carries aria-labelledby pointing at its own h1. Derived from the DOM, not a list:
    // a sixth focusable container added without the attribute fails here. Breaks if an
    // aria-labelledby is dropped, its id target renamed, or the target moves outside
    // the container it names.
    const { root } = mount();
    const containers = Array.from(root.querySelectorAll<HTMLElement>('[tabindex="-1"]'));
    expect(containers.length, '5 panel containers carry tabindex=-1 (panel + 4 subpanels)').toBe(5);
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
   * matters: `.hud-panel-settings` hides the audio row as a GROUP on the win/lose panel,
   * and `getComputedStyle` on a child inside it reports the child's OWN resolved
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

  const OPEN_TO_PANEL: Record<string, string> = {
    'hud-customize-open': 'hud-customize',
    'hud-stats-open': 'hud-stats',
    'hud-achievements-open': 'hud-achievements',
    'hud-levelselect-open': 'hud-levelselect',
  };
  const BACK_OF_PANEL: Record<string, string> = {
    'hud-customize': 'hud-customize-back',
    'hud-stats': 'hud-stats-back',
    'hud-achievements': 'hud-achievements-back',
    'hud-levelselect': 'hud-levelselect-back',
  };

  it('reaches every visible, enabled control from the title screen using arrow keys alone', () => {
    // The issue's own falsifiable assertion. 3 of 5 levels unlocked: exercises a
    // reachable level button AND a locked one that must be SKIPPED, not merely
    // disabled-but-focusable.
    const { hud: h, root } = mount();
    h.setLevelSelect(3, 5);
    h.setState('title'); // splash -> title: focuses the .hud-panel CONTAINER, index -1

    let totalControls = 0;
    const visited = new Set<HTMLElement>();

    // Walks ONE panel's flat control list forward with ArrowDown, entering and leaving
    // every subpanel it finds along the way via its own open/Back buttons (never via
    // arrows -- activation is a separate, native concern; see the report). Recursive
    // because a subpanel is walked exactly the same way the title panel is.
    //
    // EVERY panel-open transition -- the first splash -> title, a subpanel's own open
    // button, and Back returning to title -- focuses that panel's CONTAINER, never a
    // control (see the doc comment above `activePanelContainer` in hud.ts for why:
    // focusing a button there killed Escape/M the instant the panel opened). So `walk`
    // always starts at index -1 and its own first ArrowDown is what reaches controls[0],
    // uniformly, with no "already there" special case.
    function walk(container: HTMLElement): void {
      expect(
        document.activeElement,
        `${container.className} was not focused as a CONTAINER on open`,
      ).toBe(container);
      const controls = controlsOf(container);
      expect(controls.length, `${container.className} exposed no reachable controls`).toBeGreaterThan(0);
      totalControls += controls.length;
      for (let i = 0; i < controls.length; i++) {
        pressActive('ArrowDown');
        const active = document.activeElement as HTMLElement;
        expect(active, `step ${i} in .${container.className.split(' ')[0]} landed on the wrong control`).toBe(
          controls[i],
        );
        visited.add(active);
        const openCls = Array.from(active.classList).find((c) => c in OPEN_TO_PANEL);
        if (openCls) {
          activate(active); // opens the subpanel and focuses ITS container
          const subPanel = root.querySelector(`.${OPEN_TO_PANEL[openCls]}`) as HTMLElement;
          walk(subPanel);
          const back = root.querySelector(`.${BACK_OF_PANEL[OPEN_TO_PANEL[openCls]]}`) as HTMLButtonElement;
          activate(back); // leave -- resets focus to THIS (title) panel's CONTAINER
          expect(
            document.activeElement,
            'Back did not return focus to the panel container',
          ).toBe(container);
          // Container is index -1 again; replay i + 1 presses to resume exactly where
          // this loop left off (control i), so the loop's own next ArrowDown reaches i+1.
          for (let k = 0; k <= i; k++) pressActive('ArrowDown');
        }
      }
      // One more step proves the list is a closed CYCLE, not just a reachable line --
      // the last control wraps back to the first rather than dead-ending.
      pressActive('ArrowDown');
      expect(document.activeElement, `${container.className} did not wrap back to its first control`).toBe(
        controls[0],
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
    // test's own `setLevelSelect(3, 5)` leaves reachable, plus Back). The two volume
    // sliders and the topbar's own Mute are excluded by design -- see the roving-focus
    // doc comment in hud.ts.
    // 42 since the haptics toggle (issue #112's deferred HUD control) landed: 41 + the
    // toggle beside the fire-mode toggle in the title panel's settings row.
    expect(totalControls, 'recount the panels above if this moves').toBe(42);
    expect(visited.size, 'a control was reached more than once under a different identity').toBe(
      totalControls,
    );
  });

  it('skips locked level buttons when stepping through the Levels panel', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(2, 4); // levels 3 and 4 locked
    h.setState('title');

    let active = document.activeElement as HTMLElement;
    while (!(active instanceof HTMLElement && active.classList.contains('hud-levelselect-open'))) {
      pressActive('ArrowDown');
      active = document.activeElement as HTMLElement;
    }
    activate(active); // open Levels -- focuses the .hud-levelselect CONTAINER

    const levelSelectView = root.querySelector('.hud-levelselect') as HTMLElement;
    expect(document.activeElement, 'opening Levels did not focus its container').toBe(
      levelSelectView,
    );
    const levelBtns = Array.from(
      root.querySelectorAll('.hud-level-btn'),
    ) as HTMLButtonElement[];
    expect(levelBtns).toHaveLength(4);
    // 2 unlocked level buttons + Back -- the 2 locked ones must never appear here.
    const reached: HTMLButtonElement[] = [];
    for (let i = 0; i < 3; i++) {
      pressActive('ArrowDown');
      reached.push(document.activeElement as HTMLButtonElement);
    }
    expect(reached).toEqual([levelBtns[0], levelBtns[1], root.querySelector('.hud-levelselect-back')]);
    expect(reached.some((b) => b.disabled), 'a disabled, locked level button was focused').toBe(false);
  });

  it('moves focus backward with ArrowUp, undoing an ArrowDown step', () => {
    // A spot check, not a re-sweep of the whole panel -- the traversal test above
    // already proves the forward order for every control; this pins one adjacent pair
    // (of however many the title panel exposes) to check that reversing the direction
    // key reverses the step, not the full sweep that test performs.
    const { hud: h } = mount();
    h.setLevelSelect(3, 5);
    h.setState('title');
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
    h.setState('title');
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

  it('focuses the pause panel\'s CONTAINER (not Resume) so Escape-to-resume stays live', () => {
    // The regression this shape exists to avoid: an earlier draft focused Resume
    // directly on entering pause, on the reasoning that arriving already positioned
    // saves a keypress. `isPauseHotkey`/`isMuteHotkey` (game/loop.ts) both ignore any
    // key whose target sits inside a button, so that draft silently killed
    // Escape-to-resume and M-to-mute the instant the pause panel opened -- which no
    // test caught, because the only existing hotkey-liveness test covers splash ->
    // title, not pause. This constructs the SAME kind of event those guards read,
    // exactly as that test does, rather than trusting the class name alone.
    const { hud: h, root } = mount();
    h.setState('title');
    h.setState('playing');
    h.setState('paused');
    const panel = root.querySelector('.hud-panel') as HTMLElement;
    const active = document.activeElement as HTMLElement;
    expect(active, 'pause focused something other than the panel container').toBe(panel);
    const ev = (key: string): KeyboardEvent =>
      ({ key, repeat: false, target: active }) as unknown as KeyboardEvent;
    expect(isPauseHotkey(ev('Escape')), 'Escape-to-resume is dead while paused').toBe(true);
    expect(isMuteHotkey(ev('m')), 'M-to-mute is dead while paused').toBe(true);
  });

  it('reaches Resume then Quit from the pause panel with two ArrowDowns', () => {
    const { hud: h, root } = mount();
    h.setState('title');
    h.setState('playing');
    h.setState('paused');
    pressActive('ArrowDown');
    expect(document.activeElement, 'the first ArrowDown from pause did not reach Resume').toBe(
      root.querySelector('.hud-action'),
    );
    pressActive('ArrowDown');
    expect(document.activeElement).toBe(root.querySelector('.hud-quit'));
  });

  it('keeps the menu hotkeys alive returning to title via a subpanel\'s Back button too', () => {
    // The existing 'leaves the menu hotkeys alive after the title screen is dismissed'
    // test (createHud panel) covers splash -> title only. Back -> title is a SEPARATE
    // code path (setState('title') called from handleCustomizeBack, not from
    // dismissSplash), and nothing else in this file proves it lands on the container
    // rather than on Continue/New Game.
    const { hud: h, root } = mount();
    h.setState('title');
    (root.querySelector('.hud-customize-open') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }),
    );
    (root.querySelector('.hud-customize-back') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }),
    );
    const active = document.activeElement as HTMLElement;
    expect(active.className, 'Back left focus somewhere other than the panel container').toContain(
      'hud-panel',
    );
    const ev = (key: string): KeyboardEvent =>
      ({ key, repeat: false, target: active }) as unknown as KeyboardEvent;
    expect(isMuteHotkey(ev('m')), 'M is dead at the menu after Back').toBe(true);
  });

  it('auto-focuses the panel container, then reaches the action button, on win and lose', () => {
    const { hud: h, root } = mount();
    const panel = root.querySelector('.hud-panel') as HTMLElement;
    const action = root.querySelector('.hud-action') as HTMLButtonElement;
    h.setState('title');
    h.setState('playing');
    h.setState('win');
    expect(document.activeElement, 'win focused something other than the panel container').toBe(
      panel,
    );
    pressActive('ArrowDown');
    expect(document.activeElement).toBe(action);
    h.setState('playing');
    h.setState('lose');
    expect(document.activeElement, 'lose focused something other than the panel container').toBe(
      panel,
    );
    pressActive('ArrowDown');
    expect(document.activeElement).toBe(action);
  });

  it('never walks focus onto the audio row while its wrapper is display:none', () => {
    // The bug the ancestor-walking `isHiddenWithin` in hud.ts exists to catch:
    // `.hud-panel-settings` hides the audio row (panel Mute, the scheme and fire-mode
    // toggles) as a GROUP on the win/lose panel, but each control's OWN `display`
    // resolves to something other than `none` -- measured directly, a `getComputedStyle`
    // check that only looked at the control itself would have included all three and
    // walked the roving order onto invisible buttons on every win/lose screen.
    const { hud: h, root } = mount();
    h.setState('title');
    h.setState('playing');
    h.setState('win'); // controls: the action button ALONE
    const settings = root.querySelector('.hud-panel-settings') as HTMLElement;
    expect(getComputedStyle(settings).display, 'test invalid: the wrapper is not actually hidden').toBe(
      'none',
    );
    const panelMute = root.querySelector('.hud-panel-mute') as HTMLElement;
    expect(
      getComputedStyle(panelMute).display,
      'test invalid: the control itself now also resolves display:none, which would make this pass for the wrong reason',
    ).not.toBe('none');
    pressActive('ArrowDown'); // reaches the action button
    pressActive('ArrowDown'); // must WRAP back to the action button, not fall into the audio row
    expect(document.activeElement, 'focus walked onto a control inside the hidden audio row').toBe(
      root.querySelector('.hud-action'),
    );
  });

  it('does not intercept arrow keys while playing, so input.ts still drives the tank', () => {
    // The state-aware boundary this whole feature has to respect: no panel is visible
    // while playing, so `activePanelContainer` must return null and the handler must
    // return before calling preventDefault -- otherwise input.ts's own window listener,
    // which registers AFTER this one in a real boot and so runs strictly later, would
    // never see the key at all.
    const { hud: h } = mount();
    h.setState('title');
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
    h.setState('title');
    const slider = root.querySelector('.hud-panel-volume') as HTMLInputElement;
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
    h.setState('title');
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

  it('removes its own capture-phase window keydown listener on dispose', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = createHud(root);

    const added = addSpy.mock.calls.find(
      (c) => c[0] === 'keydown' && c[2] === true,
    );
    expect(added, 'no capture-phase keydown listener was registered at window').toBeDefined();

    h.dispose();

    const removed = removeSpy.mock.calls.find(
      (c) => c[0] === 'keydown' && c[1] === added![1] && c[2] === true,
    );
    expect(removed, 'dispose did not remove the capture-phase keydown listener it added').toBeDefined();

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
