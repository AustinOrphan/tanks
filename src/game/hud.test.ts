// @vitest-environment jsdom
import { defaultSlots } from './versus-setup';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type Hud, SINGLE_PLAYER_DEATH_VIGNETTE } from './hud';
import { isMuteHotkey, isPauseHotkey } from './loop';
import { SKINS, ACCENTS } from './customization';
import { ACHIEVEMENTS } from './achievements';
import { DEFAULT_VOLUME } from '../audio/manifest';
import { versusMapChoices, type VersusConfig } from './versus-config';
import { createVersusSetupStore, VERSUS_SETUP_KEY } from './versus-setup-store';
import { createMemoryStorage } from './storage';
import { VERSUS_STOCK } from '../sim/constants';
import { IDENTITY_RING_COLORS, TEAM_COLORS } from '../render/entities';

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

  it('setVolume moves BOTH sliders, so the persisted level is not shown in one place only', () => {
    // The markup renders at DEFAULT_VOLUME, which was the truth while volume was a
    // session-local field on the audio engine. Since issue #320 it is persisted, and
    // loop.ts pushes the stored value through here at boot -- so a returning player who
    // set 0.2 must not see 0.6 on either control.
    //
    // BOTH, asserted separately: the topbar slider and the pause-panel slider are two
    // views of one value, and the input handlers already mirror each other in the other
    // direction. Dropping the panel write leaves the topbar test green and the panel
    // silently stale, which is exactly the half a fake HUD in loop.test.ts cannot see.
    const { hud, root } = mount();
    hud.setVolume(0.2);
    expect(volumeSlider(root).value).toBe('0.2');
    expect((root.querySelector('.hud-panel-volume') as HTMLInputElement).value).toBe('0.2');
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
    // Fake timers because the title screen now CROSSFADES into the menu rather than
    // cutting (issue #364): the outgoing surface keeps its `--hidden` off until the
    // transition settles, so the assertion below reads the settled state rather than the
    // frame the navigation started on. Which screen a player lands on is unchanged, and
    // that is what this test is for -- `createHud application transition contract` owns
    // the mid-transition frame.
    vi.useFakeTimers();
    try {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    vi.advanceTimersByTime(1000);
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
    } finally {
      vi.useRealTimers();
    }
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
    h.setState('main-menu'); // splash -> title: the focus handoff
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
    h.setContinueAvailable(true); // an active run exists, so Continue is the visible button
    // The real sequence: a pointer lands on the overlay, loop.ts dismisses on that same
    // pointerdown, and the browser then completes the click on the button beneath.
    const splash = root.querySelector('.hud-splash') as HTMLElement;
    splash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    h.setState('main-menu');
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
    h.setContinueAvailable(true); // an active run exists, so Continue is the visible button
    const splash = root.querySelector('.hud-splash') as HTMLElement;
    splash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    h.setState('main-menu');

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
    h.setContinueAvailable(true); // an active run exists, so Continue (not the retired action button) is visible
    const splash = root.querySelector('.hud-splash') as HTMLElement;
    splash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    h.setState('main-menu'); // armed, and the drag's click never lands in the panel

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
    let newGames = 0;
    h.onNewGame(() => {
      newGames += 1;
    });
    const splash = root.querySelector('.hud-splash') as HTMLElement;
    splash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    h.setState('main-menu'); // armed, and the drag's click never lands in the panel

    // Arrow navigation instead of Tab -- the roving-focus path this file adds.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    (root.querySelector('.hud-new-game') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(newGames, 'the first real click after drag-dismiss + arrow navigation was eaten').toBe(1);
  });

  it('claims a navigation key outright while a panel is open, and not while playing', () => {
    // Pins onNavKeyDown's stopPropagation itself -- removing that call left every other
    // test in this file green (measured by mutation in review), because the
    // while-playing test only exercises the early-return branch that never reaches it.
    // A second window-bound BUBBLE listener stands in for input.ts's own: it must not
    // see a claimed key while a panel is open, and must see the same key while playing.
    const { hud: h } = mount();
    h.setState('main-menu');
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
    for (const s of ['launch', 'main-menu', 'paused', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(hidden(), `the touch controls are showing on ${s}`).toBe(true);
    }
  });

  it('draws the application backdrop on the Main Menu and on no other surface', () => {
    // The whole visible half of issue #317's first change: with an opaque ground under
    // the menu, the board behind it stops being what the player reads -- which is what
    // makes a quit that no longer rebuilds that board invisible.
    //
    // Swept over all six surfaces, not spot-checked, for the same reason the touch-row
    // sweep above is: one sample cannot tell "only on the Main Menu" from "always", and
    // the two surfaces most easily got wrong are the two the Quit button is reachable
    // from -- 'paused' and 'outcome-win', where the arena MUST stay visible.
    //
    // Fake timers because the ground CROSSFADES with the screen above it now (issue
    // #364) instead of cutting: it stays painted for the transition it is leaving on, so
    // each leg of the sweep is read at its settled state. The sweep itself is unchanged
    // and is the point -- one sample cannot tell "only on the Main Menu" from "always".
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      const ground = root.querySelector('.ui-app-ground') as HTMLElement;
      const hidden = (): boolean => ground.classList.contains('ui-app-ground--hidden');

      h.setState('main-menu');
      vi.advanceTimersByTime(1000);
      expect(hidden(), 'the menu has no ground under it').toBe(false);
      for (const s of ['launch', 'playing', 'paused', 'outcome-win', 'outcome-lose'] as const) {
        h.setState(s);
        vi.advanceTimersByTime(1000);
        expect(hidden(), `the application ground is covering ${s}`).toBe(true);
        // Back to the menu between legs, so each surface is entered FROM the ground
        // being up -- otherwise every leg after the first would assert that a ground
        // which was already down stayed down, and the sweep would stop discriminating.
        h.setState('main-menu');
        vi.advanceTimersByTime(1000);
        expect(hidden(), 'the menu lost its ground on the way back').toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts hidden at mount, before any setState -- the ground never flashes over a boot frame', () => {
    // The markup ships the --hidden class rather than relying on the first setState to
    // add it. Without that, a HUD constructed before its first state push paints an
    // opaque ground over whatever is on screen.
    const { root } = mount();
    expect((root.querySelector('.ui-app-ground') as HTMLElement).className).toContain(
      'ui-app-ground--hidden',
    );
  });

  it("setBackdrop switches the treatment class both ways, and changes nothing about WHEN the ground shows", () => {
    // Two claims, because the pair is what the ruling asked for: the felt is reachable
    // (`?dev=1&backdrop=felt` -> loop.ts -> here) and the default is genuinely restorable
    // rather than a one-way trip. The visibility assertion is the negative control for
    // wiring the treatment into the --hidden toggle by mistake: a setBackdrop that also
    // decided visibility would fail the second half.
    const { hud: h, root } = mount();
    const ground = root.querySelector('.ui-app-ground') as HTMLElement;
    h.setState('main-menu');

    expect(ground.classList.contains('ui-app-ground--felt')).toBe(false);
    h.setBackdrop('felt');
    expect(ground.classList.contains('ui-app-ground--felt')).toBe(true);
    h.setBackdrop('default');
    expect(ground.classList.contains('ui-app-ground--felt')).toBe(false);

    h.setBackdrop('felt');
    expect(ground.classList.contains('ui-app-ground--hidden'), 'felt hid the ground').toBe(false);
    h.setState('playing');
    expect(ground.classList.contains('ui-app-ground--hidden'), 'felt kept it on during play').toBe(
      true,
    );
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

    h.setState('outcome-win');
    expect(panel(root).classList.contains('hud-panel--hidden')).toBe(false);
    expect(title(root)).toBe('You Win!');
    expect(action(root).textContent).toBe('Play Again');

    h.setState('outcome-lose');
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
    hud.signalPlayerDeath(SINGLE_PLAYER_DEATH_VIGNETTE);
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
    hud.signalPlayerDeath(SINGLE_PLAYER_DEATH_VIGNETTE);
    const damage = root.querySelector('.hud-damage') as HTMLElement;
    const obs = new MutationObserver(() => {});
    obs.observe(damage, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    hud.signalPlayerDeath(SINGLE_PLAYER_DEATH_VIGNETTE);
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
    hud.signalPlayerDeath(SINGLE_PLAYER_DEATH_VIGNETTE);
    const damage = root.querySelector('.hud-damage') as HTMLElement;
    expect(damage.getAttribute('aria-hidden')).toBe('true');
    hud.dispose();
  });

  /** Same #rrggbb derivation hud.ts's own cssColor uses, kept independent so the test
   *  does not import the private helper -- it asserts the CONTRACT (a colour string
   *  derived from the number), not hud.ts's internal implementation. */
  function expectedCssColor(hex: number): string {
    return '#' + hex.toString(16).padStart(6, '0');
  }

  it('tints the vignette to the colour it is given', () => {
    const { root, hud } = mount();
    hud.signalPlayerDeath(0x3fd0ff);
    const damage = root.querySelector('.hud-damage') as HTMLElement;
    expect(damage.style.getPropertyValue('--hud-damage-color')).toBe(expectedCssColor(0x3fd0ff));
    hud.dispose();
  });

  it('single-player keeps the classic red -- derived from the exported constant, not a literal', () => {
    // Importing SINGLE_PLAYER_DEATH_VIGNETTE (rather than writing '#b41e1e' here) is
    // the point: this assertion only fails if the constant's VALUE stops matching what
    // the property is set to, so retuning the constant cannot silently desync the two.
    const { root, hud } = mount();
    hud.signalPlayerDeath(SINGLE_PLAYER_DEATH_VIGNETTE);
    const damage = root.querySelector('.hud-damage') as HTMLElement;
    expect(damage.style.getPropertyValue('--hud-damage-color')).toBe(
      expectedCssColor(SINGLE_PLAYER_DEATH_VIGNETTE),
    );
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

describe('hud: round-start countdown', () => {
  function mount(): { root: HTMLElement; hud: ReturnType<typeof createHud> } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return { root, hud: createHud(root) };
  }

  it('shows nothing until it is told to', () => {
    const { root, hud } = mount();
    expect(root.querySelector('.hud-count')?.className).toContain('hud-count--hidden');
    hud.dispose();
  });

  it('is a bare number -- no "AIM"/"TAKE AIM" word, on either non-live phase', () => {
    // Design ruling: the countdown must not say a word, ever -- just the number.
    const { root, hud } = mount();
    hud.setRoundPhase({ phase: 'countdown', secondsLeft: 3 });
    const count = root.querySelector('.hud-count') as HTMLElement;
    expect(count.textContent).toBe('3');
    expect(count.className).not.toContain('hud-count--hidden');
    hud.setRoundPhase({ phase: 'grace', secondsLeft: 2 });
    expect(count.textContent).toBe('2');
    hud.dispose();
  });

  it('hides on null and on live', () => {
    const { root, hud } = mount();
    hud.setRoundPhase({ phase: 'countdown', secondsLeft: 3 });
    hud.setRoundPhase(null);
    expect(root.querySelector('.hud-count')?.className).toContain('hud-count--hidden');
    hud.setRoundPhase({ phase: 'countdown', secondsLeft: 3 });
    hud.setRoundPhase({ phase: 'live', secondsLeft: 0 });
    expect(root.querySelector('.hud-count')?.className).toContain('hud-count--hidden');
    hud.dispose();
  });

  it('restarts the pop animation on each new second, not on every call', () => {
    // The transient pop is the whole point (design ruling): each new second must read
    // as a fresh pop, not a continuation of the last one's fade-out, and a tick that
    // repeats the same second must NOT restart it (the driver calls this every
    // simulated tick, dozens of times per second -- restarting on every call would
    // just as surely break the design as never restarting at all). Same restart
    // trick as signalPlayerDeath: remove the class, force a reflow, add it back --
    // proven here via the classList.remove calls, since jsdom does not run CSS
    // animations at all.
    const { root, hud } = mount();
    const countEl = root.querySelector('.hud-count') as HTMLElement;
    const removeSpy = vi.spyOn(countEl.classList, 'remove');

    hud.setRoundPhase({ phase: 'countdown', secondsLeft: 3 });
    const popRemovals = (): number =>
      removeSpy.mock.calls.filter(([c]) => c === 'hud-count--pop').length;
    expect(popRemovals()).toBe(1);

    hud.setRoundPhase({ phase: 'countdown', secondsLeft: 3 }); // same second, repeated
    expect(popRemovals()).toBe(1); // unchanged: no restart mid-second

    hud.setRoundPhase({ phase: 'countdown', secondsLeft: 2 }); // a new second
    expect(popRemovals()).toBe(2); // restarted

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
    h.setState('outcome-win');
    expect(title()).toContain('cleared');
    expect(button()).toBe('Next Level');

    h.setLevel(2, 2);
    h.setState('outcome-win'); // re-renders unconditionally; the equal-state guard lives in state.ts, not here
    expect(title()).toBe('You Win!');
    expect(button()).toBe('Play Again');
  });

  it('never says cleared before setLevel has been called at all', () => {
    // A HUD that has not been told about levels behaves exactly as it always did.
    const { hud: h, root } = mount();
    h.setState('outcome-win');
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
    // Population: all four non-paused states. Quit reaches the level-cleared panel too
    // (a directive), but that needs an INTERMEDIATE level position -- this fixture sets
    // none, so `win` here is the final-win shape and stays verdict-only. The cleared
    // case has its own describe block below; without it this loop would keep passing
    // for the wrong reason, since a null level position hides the button regardless.
    const { hud: h, root } = mount();
    for (const s of ['main-menu', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(quit(root).classList.contains('hud-quit--hidden'), s).toBe(true);
    }
    for (const s of ['outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(settings(root).classList.contains('hud-panel-settings--hidden'), s).toBe(true);
    }
    h.setState('main-menu');
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
    h.setState('main-menu');
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
    h.setState('main-menu');
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
    h.setState('main-menu');
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
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    buttons(root)[1].dispatchEvent(new MouseEvent('click'));
    buttons(root)[2].dispatchEvent(new MouseEvent('click')); // locked: disabled anyway
    expect(picks).toEqual([1]);
  });

  it('the Levels button opens the panel, and Back returns to the menu', () => {
    // Fake timers from the START, not after the click: Back now CROSSFADES rather than
    // cutting, and a timer installed after the click cannot advance one scheduled
    // before it. The closing pane keeps its `--hidden` off for the transition it is
    // leaving on, so the assertion below reads the SETTLED state. Where Back lands is
    // what this test is for; the mid-transition frame is owned by `crossfades a panel
    // CLOSE, not only its open`.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setLevelSelect(1, 2);
      h.setState('main-menu');
      vi.advanceTimersByTime(1000);
      expect(view(root).classList.contains('hud-levelselect--hidden')).toBe(true);
      openBtn(root).dispatchEvent(new MouseEvent('click'));
      expect(view(root).classList.contains('hud-levelselect--hidden')).toBe(false);
      (root.querySelector('.hud-levelselect-back') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click'),
      );
      vi.advanceTimersByTime(1000);
      expect(view(root).classList.contains('hud-levelselect--hidden')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the Levels button lives on the title panel only', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 2);
    h.setState('main-menu');
    expect(openBtn(root).classList.contains('hud-levelselect-open--hidden')).toBe(false);
    for (const s of ['paused', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-levelselect-open--hidden'), s).toBe(true);
    }
  });

  it('hides the Levels button entirely for a one-level sequence (the sandbox)', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 1);
    h.setState('main-menu');
    expect(openBtn(root).classList.contains('hud-levelselect-open--hidden')).toBe(true);
  });

  it('is a title-screen affair, closed by any state change', () => {
    // Mirrors 'hud: achievements'' "is a title-screen affair" test: setState is the ONE
    // chokepoint that closes every panel unconditionally, so a caller cannot leave this
    // one sitting over a live game.
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 2);
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    h.setState('playing');
    expect(view(root).classList.contains('hud-levelselect--hidden')).toBe(true);
  });

  it('a re-render while another panel is up must not splash the Levels button onto it', () => {
    // The natural call order: the loop records an unlock AT the win event and
    // refreshes the select -- while the WIN panel is showing.
    const { hud: h, root } = mount();
    h.setState('outcome-win');
    h.setLevelSelect(2, 2);
    expect(openBtn(root).classList.contains('hud-levelselect-open--hidden')).toBe(true);
    h.setState('main-menu');
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

  it('is reachable from BOTH the title screen and the pause panel, unlike every sibling subpanel', () => {
    // 'playing' is excluded from this per-button check, matching the established
    // convention (see 'hud: level select panel's own equivalent test): setState's
    // early-return for playing/splash hides the whole .hud-panel wrapper rather than
    // toggling each button's own class, so the button's OWN class is not the right
    // oracle there.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    expect(openBtn(root).classList.contains('hud-controllers-open--hidden')).toBe(false);
    h.setState('paused');
    expect(openBtn(root).classList.contains('hud-controllers-open--hidden')).toBe(false);
    for (const s of ['outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-controllers-open--hidden'), s).toBe(true);
    }
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

describe('hud: versus setup pane (docs/superpowers/specs/2026-08-21-versus-setup-menu-design.md)', () => {
  const openBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-versus-open') as HTMLButtonElement;
  const view = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-versus-setup') as HTMLElement;
  const backBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-versus-back') as HTMLButtonElement;
  const startBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-versus-start') as HTMLButtonElement;
  const modeBtn = (root: HTMLElement, mode: 'ffa' | 'teams'): HTMLButtonElement =>
    root.querySelector(`.hud-versus-mode-row [data-mode="${mode}"]`) as HTMLButtonElement;
  const playersBtn = (root: HTMLElement, players: number): HTMLButtonElement =>
    root.querySelector(`.hud-versus-players-row [data-players="${players}"]`) as HTMLButtonElement;
  const stockBtn = (root: HTMLElement, stock: number): HTMLButtonElement =>
    root.querySelector(`.hud-versus-stock-row [data-stock="${stock}"]`) as HTMLButtonElement;
  const mapButtons = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll('.hud-versus-map-row button'));
  const mapBtn = (root: HTMLElement, map: string): HTMLButtonElement =>
    root.querySelector(`.hud-versus-map-row [data-map="${map}"]`) as HTMLButtonElement;
  const friendlyFireBtn = (root: HTMLElement): HTMLButtonElement | null =>
    root.querySelector('.hud-versus-friendlyfire-btn');
  // The who's-playing SETUP rows (issue #260). These used to be
  // .hud-controller-row/.hud-controller-source-btn, shared with the real Controllers
  // panel and therefore needing a `view(root)` scope; they are now the pane's own
  // classes, which cannot collide, so no scoping comment is needed here any more.
  const slotRows = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll('.hud-versus-slot-row'));
  const roleBtn = (root: HTMLElement, slot: number, role: string): HTMLButtonElement =>
    root.querySelector(
      `.hud-versus-slot-row[data-slot="${slot}"] .hud-versus-role-btn[data-role="${role}"]`,
    ) as HTMLButtonElement;
  const slotDevice = (root: HTMLElement, slot: number): HTMLElement =>
    root.querySelector(`.hud-versus-slot-row[data-slot="${slot}"] .hud-versus-slot-device`) as HTMLElement;
  const slotReason = (root: HTMLElement, slot: number): HTMLElement =>
    root.querySelector(`.hud-versus-slot-row[data-slot="${slot}"] .hud-versus-slot-reason`) as HTMLElement;

  it('the Versus button is a bare click passthrough: it does NOT open the pane itself, and fires onVersusOpen once per click', () => {
    // Kills the mutation "the button calls showVersusSetup directly" -- see
    // onVersusOpen's own doc comment on the Hud interface for why that would be
    // wrong: only the caller (loop.ts) knows which VersusConfig to retain across a
    // rematch, so the button cannot decide to open the pane on its own.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    let opens = 0;
    h.onVersusOpen(() => {
      opens += 1;
    });
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(opens, 'onVersusOpen did not fire on click').toBe(1);
    expect(
      view(root).classList.contains('hud-versus-setup--hidden'),
      'clicking Versus opened the pane without any subscriber -- it must not',
    ).toBe(true);
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(opens, 'a second click did not fire the callback a second time').toBe(2);
  });

  it('is visible at title ONLY -- unlike Controllers, a live round has nothing this could offer', () => {
    // 'playing'/'splash' excluded from this per-button check, matching the
    // established convention (see 'hud: controller assignment panel's own
    // equivalent test): setState's early-return for playing/splash hides the whole
    // .hud-panel wrapper rather than toggling each button's own class, so the
    // button's OWN class is not the right oracle there.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    expect(openBtn(root).classList.contains('hud-versus-open--hidden')).toBe(false);
    for (const s of ['paused', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-versus-open--hidden'), s).toBe(true);
    }
  });

  const teamBtns = (root: HTMLElement, slot: number): HTMLButtonElement[] =>
    Array.from(
      (root.querySelectorAll('.hud-versus-slot-rows > *')[slot]?.querySelectorAll('.hud-versus-team-btn') ?? []) as NodeListOf<HTMLButtonElement>,
    );

  it('does not offer Teams at two players, and does at three (issue #281)', () => {
    // The issue's first binding rule. `.click()` rather than `dispatchEvent`, deliberately:
    // a disabled button ignores a real click and honours a dispatched one, so only the
    // former measures what a player can actually do.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(modeBtn(root, 'teams').disabled, 'Teams is offered at two players').toBe(true);
    expect(modeBtn(root, 'ffa').disabled, 'FFA was refused too').toBe(false);
    modeBtn(root, 'teams').click();
    expect(teamBtns(root, 0), 'a refused Teams click still built the team controls').toHaveLength(0);

    playersBtn(root, 3).click();
    expect(modeBtn(root, 'teams').disabled, 'Teams still refused at three players').toBe(false);
  });

  it('drops out of Teams when the player count falls to two', () => {
    // The state a disabled button alone cannot prevent: pick Teams at three, then go back
    // to two. Leaving the mode set would leave the pane in a mode it no longer offers, and
    // the Start gate refusing a match the player cannot see how to fix.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    playersBtn(root, 3).click();
    modeBtn(root, 'teams').click();
    expect(teamBtns(root, 0).length).toBeGreaterThan(0);

    playersBtn(root, 2).click();
    expect(modeBtn(root, 'teams').disabled).toBe(true);
    expect(teamBtns(root, 0), 'the team controls survived the drop to two players').toHaveLength(0);
    // ...and friendly fire, which is Teams-only, went with it.
    expect(friendlyFireBtn(root)).toBeNull();
  });

  it('offers a team per slot under Teams, and none under FFA', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    playersBtn(root, 3).click();
    expect(teamBtns(root, 0), 'FFA offered team controls').toHaveLength(0);
    modeBtn(root, 'teams').click();
    for (const slot of [0, 1, 2]) expect(teamBtns(root, slot)).toHaveLength(3);
    // The letters are the non-colour reinforcement the issue asks for, so they are pinned
    // as CONTENT rather than left to the swatch's hue.
    expect(teamBtns(root, 0).map((b) => b.textContent)).toEqual(['A', 'B', 'C']);
  });

  it('shows the EFFECTIVE team on an untouched slot, not an empty selection', () => {
    // An untouched slot has `team === undefined` and falls back to `teamOf(slot)`, which is
    // exactly what `loadArena` stamps. Showing nothing chosen would read as a decision the
    // player still had to make, in a pane whose Start button is already enabled.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    playersBtn(root, 3).click();
    modeBtn(root, 'teams').click();
    const chosen = (slot: number): string[] =>
      teamBtns(root, slot).filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent ?? '');
    // teamOf alternates, so slots 0/1/2 start on A/B/A.
    expect(chosen(0)).toEqual(['A']);
    expect(chosen(1)).toEqual(['B']);
    expect(chosen(2)).toEqual(['A']);
  });

  it('keeps a chosen team across a round trip through FFA', () => {
    // The issue's "switching modes does not corrupt retained team choices". The controls
    // are absent in FFA, so the only way this can hold is by the CHOICE surviving in the
    // descriptor while its control does not exist -- which is why `team` is carried
    // unconditionally rather than only under Teams.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    playersBtn(root, 3).click();
    modeBtn(root, 'teams').click();
    teamBtns(root, 1)[2].click(); // put slot 1 on team C, which teamOf would never pick
    const chosenC = (): boolean =>
      teamBtns(root, 1)[2]?.getAttribute('aria-pressed') === 'true';
    expect(chosenC()).toBe(true);

    modeBtn(root, 'ffa').click();
    expect(teamBtns(root, 1), 'FFA kept the team controls on screen').toHaveLength(0);
    modeBtn(root, 'teams').click();
    expect(chosenC(), 'the round trip through FFA lost the chosen team').toBe(true);
  });

  it("Start fires onVersusStart with exactly the selections made, not the pane's defaults", () => {
    // Kills the mutation "emit versusConfigState's INITIAL value" / "emit a
    // hardcoded default object" -- every field below is changed from its default
    // before Start is clicked.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    modeBtn(root, 'teams').dispatchEvent(new MouseEvent('click'));
    playersBtn(root, 3).dispatchEvent(new MouseEvent('click'));
    const choices = versusMapChoices(3, 'teams');
    mapBtn(root, choices[1]).dispatchEvent(new MouseEvent('click')); // the SECOND map entry
    stockBtn(root, 5).dispatchEvent(new MouseEvent('click'));
    (friendlyFireBtn(root) as HTMLButtonElement).dispatchEvent(new MouseEvent('click')); // off -> on

    const seen: VersusConfig[] = [];
    h.onVersusStart((config) => seen.push(config));
    startBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(seen).toEqual([
      { mode: 'teams', players: 3, arenaId: choices[1], stock: 5, friendlyFire: true, slots: defaultSlots(3) },
    ]);
  });

  it('stock defaults to VERSUS_STOCK, the same constant the sim boundary uses (constants.ts)', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(stockBtn(root, VERSUS_STOCK).classList.contains('ui-selectable--on')).toBe(true);
  });

  it('friendly fire is GENUINELY ABSENT from the DOM under FFA, present under Teams', () => {
    // The spec's own wording (§3): "rendered only when Teams selected". Absent, not
    // merely hidden -- kills the mutation "hide it with a CSS class instead of not
    // building it", which a `.hud-versus-friendlyfire-row--hidden`-class check could
    // not tell apart from a genuinely broken hidden rule (see hud.css.test.ts's own
    // `.hud-accents` precedent for exactly that failure mode).
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(friendlyFireBtn(root), 'present under the FFA default').toBeNull();
    modeBtn(root, 'teams').dispatchEvent(new MouseEvent('click'));
    expect(friendlyFireBtn(root), 'absent after switching to Teams').not.toBeNull();
    modeBtn(root, 'ffa').dispatchEvent(new MouseEvent('click'));
    expect(friendlyFireBtn(root), 'still present after switching back to FFA').toBeNull();
  });

  it('does not reset friendlyFire when leaving Teams -- Teams -> FFA -> Teams keeps the toggle', () => {
    // Kills the mutation "zero friendlyFire on switching to FFA": versus-config.ts's
    // own doc comment states loadArena/createWorld already ignore it outside
    // 'teams', so carrying it unconditionally is harmless -- resetting it here would
    // be an active regression against ruling 4's "selections persist" contract.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    modeBtn(root, 'teams').dispatchEvent(new MouseEvent('click'));
    (friendlyFireBtn(root) as HTMLButtonElement).dispatchEvent(new MouseEvent('click')); // off -> on
    modeBtn(root, 'ffa').dispatchEvent(new MouseEvent('click'));
    modeBtn(root, 'teams').dispatchEvent(new MouseEvent('click'));
    expect((friendlyFireBtn(root) as HTMLButtonElement).textContent).toBe('Friendly fire: On');
  });

  it('Players change REPLACES the Map row rather than appending to it, across two successive re-renders', () => {
    // All 15 shipped (arena, playerCount) rows pass `suitable` today (measured via
    // versusBoardCatalog(), see versus-config.ts's own doc comment), so 2/3/4
    // players all offer the SAME five arenas -- which is exactly why row COUNT,
    // not arena identity, is what proves REPLACE here: an APPEND mutation would
    // grow the row count on every click below rather than holding steady.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(mapButtons(root)).toHaveLength(versusMapChoices(2, 'ffa').length + 1); // + Random
    playersBtn(root, 3).dispatchEvent(new MouseEvent('click'));
    expect(mapButtons(root)).toHaveLength(versusMapChoices(3, 'ffa').length + 1);
    playersBtn(root, 4).dispatchEvent(new MouseEvent('click'));
    expect(mapButtons(root)).toHaveLength(versusMapChoices(4, 'ffa').length + 1);
  });

  it('showVersusSetup(true, initial) pre-fills every field', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const initial: VersusConfig = {
      mode: 'teams',
      players: 4,
      arenaId: versusMapChoices(4, 'teams')[2],
      stock: 2,
      friendlyFire: true, slots: defaultSlots(4) };
    h.showVersusSetup(true, initial);
    expect(modeBtn(root, 'teams').classList.contains('ui-selectable--on')).toBe(true);
    expect(playersBtn(root, 4).classList.contains('ui-selectable--on')).toBe(true);
    expect(mapBtn(root, initial.arenaId).classList.contains('ui-selectable--on')).toBe(true);
    expect(stockBtn(root, 2).classList.contains('ui-selectable--on')).toBe(true);
    expect(friendlyFireBtn(root)).not.toBeNull();
    expect((friendlyFireBtn(root) as HTMLButtonElement).textContent).toBe('Friendly fire: On');
  });

  it("selections persist across a close (setState) and reopen with NO `initial` argument -- session-scoped state (ruling 4)", () => {
    // Kills the mutation "reset versusConfigState to defaults whenever the pane
    // closes or reopens".
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    modeBtn(root, 'teams').dispatchEvent(new MouseEvent('click'));
    stockBtn(root, 5).dispatchEvent(new MouseEvent('click'));
    h.setState('playing'); // setState's close-all discipline hides the pane
    h.setState('main-menu');
    h.showVersusSetup(true); // no `initial` argument at all
    expect(modeBtn(root, 'teams').classList.contains('ui-selectable--on')).toBe(true);
    expect(stockBtn(root, 5).classList.contains('ui-selectable--on')).toBe(true);
  });

  it("passing `null` -- Task 5's own `deps.initialVersusConfig ?? null` for \"nothing retained yet\" -- also keeps the pane's persisted selections, same as omitting the argument", () => {
    // Kills the mutation "seed from `initial ?? DEFAULTS`", which would silently
    // wipe a returning player's own selections on precisely this call -- the one
    // Task 5's own wiring line makes on every FIRST open of a session.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    modeBtn(root, 'teams').dispatchEvent(new MouseEvent('click'));
    playersBtn(root, 4).dispatchEvent(new MouseEvent('click'));
    h.setState('playing');
    h.setState('main-menu');
    h.showVersusSetup(true, null);
    expect(modeBtn(root, 'teams').classList.contains('ui-selectable--on')).toBe(true);
    expect(playersBtn(root, 4).classList.contains('ui-selectable--on')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Who's playing -- per-slot ROLE controls (issue #260).
  //
  // These four tests REPLACE four that pinned the previous ruling: that these rows
  // rendered the RUNNING session's `Assignment` and that clicking a candidate
  // reassigned that session through `onReassignSlot`, interactively when the pane's
  // player count matched the session's and as a disabled preview when it did not.
  // That is the divergence issue #260 exists to remove -- Start disposes the session
  // those clicks were editing, so what the pane showed was not what launched. The old
  // tests are deleted rather than skipped: they asserted the superseded behaviour
  // directly, so there is nothing in them left to be true.
  // ---------------------------------------------------------------------------

  it('offers a role control per slot, and a click writes that slot -- Start carries the roles it displayed', () => {
    // The issue's "Start initializes the session from the exact displayed assignments".
    // Kills the mutation "the role button re-renders without calling setVersusConfig":
    // the pane would LOOK right and Start would still emit the old slots.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(slotRows(root), 'one row per slot at the default player count').toHaveLength(2);

    let started: VersusConfig | null = null;
    h.onVersusStart((c) => {
      started = c;
    });
    // Slot 1 defaults to Bot (defaultSlots); make it a second Human and start.
    roleBtn(root, 1, 'human').dispatchEvent(new MouseEvent('click'));
    expect(roleBtn(root, 1, 'human').classList.contains('ui-selectable--on')).toBe(true);
    startBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(started, 'Start fired').not.toBeNull();
    expect((started as unknown as VersusConfig).slots).toEqual([
      { role: 'human' },
      { role: 'human' },
    ]);
  });

  it('derives the device column from the live pads rather than storing one, and never honours a stale index', () => {
    // The issue's one purely NEGATIVE criterion. Slot 1 is Human and one pad is
    // connected, so it resolves to that pad; unplug it and the SAME stored role
    // resolves to Unassigned rather than to some other physical controller.
    //
    // Negative control: if `resolveSources` were replaced by a stored per-slot device,
    // the second assertion would still read "Pad Seven (index 3)" after the unplug.
    const { hud: h, root } = mount();
    h.setDetectedPads([{ padIndex: 3, id: 'Pad Seven' }]);
    h.setState('main-menu');
    h.showVersusSetup(true);
    roleBtn(root, 1, 'human').dispatchEvent(new MouseEvent('click'));
    expect(slotDevice(root, 0).textContent).toBe('Keyboard / Mouse / Touch');
    expect(slotDevice(root, 1).textContent).toBe('Pad Seven (index 3)');

    h.setDetectedPads([]); // unplugged WHILE the pane is open
    expect(
      slotDevice(root, 1).textContent,
      'a human slot with no free device must read Unassigned, not a remembered pad',
    ).toBe('Unassigned');
  });

  it('refuses Start with an actionable, ASSOCIATED reason -- and only the first offending card carries one', () => {
    // "Never accept Start with an inert required slot", plus the deliberate
    // first-problem-only choice `versusSetupProblem` makes: two simultaneous refusals
    // would give a player two sentences and no order to fix them in.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    playersBtn(root, 3).dispatchEvent(new MouseEvent('click'));
    expect(startBtn(root).disabled, 'the default 3-player setup is startable').toBe(false);

    // Turn slots 1 AND 2 off: two `unassigned` problems at once.
    roleBtn(root, 1, 'none').dispatchEvent(new MouseEvent('click'));
    roleBtn(root, 2, 'none').dispatchEvent(new MouseEvent('click'));
    expect(startBtn(root).disabled, 'an Off slot must refuse Start').toBe(true);
    expect(slotReason(root, 1).textContent).toBe('Player 2 is off. Choose Human or Bot to start.');
    expect(slotReason(root, 1).classList.contains('hud-versus-slot-reason--hidden')).toBe(false);
    expect(
      slotReason(root, 2).textContent,
      'the SECOND offending card stays silent -- one actionable fix at a time',
    ).toBe('');
    // Associated, not merely on screen (#321's rule).
    expect(startBtn(root).getAttribute('aria-describedby')).toBe('hud-versus-slot-reason-1');

    // Fixing the first reveals the second, which is what makes one-at-a-time workable.
    roleBtn(root, 1, 'bot').dispatchEvent(new MouseEvent('click'));
    expect(slotReason(root, 2).textContent).toBe('Player 3 is off. Choose Human or Bot to start.');
    expect(startBtn(root).getAttribute('aria-describedby')).toBe('hud-versus-slot-reason-2');
    roleBtn(root, 2, 'bot').dispatchEvent(new MouseEvent('click'));
    expect(startBtn(root).disabled, 'both fixed -> startable again').toBe(false);
    expect(startBtn(root).getAttribute('aria-describedby'), 'the reason is withdrawn').toBeNull();
  });

  it('refuses an all-bot match at the PANE level, since no-human names no slot to hang a reason on', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    const paneReason = root.querySelector('.hud-versus-start-reason') as HTMLElement;
    expect(paneReason.classList.contains('hud-versus-start-reason--hidden')).toBe(true);

    roleBtn(root, 0, 'bot').dispatchEvent(new MouseEvent('click'));
    expect(startBtn(root).disabled).toBe(true);
    expect(paneReason.textContent).toBe('At least one slot must be Human.');
    expect(paneReason.classList.contains('hud-versus-start-reason--hidden')).toBe(false);
    expect(startBtn(root).getAttribute('aria-describedby')).toBe('hud-versus-start-reason');
    // No per-slot card claims it -- the problem belongs to the match, not a player.
    expect(slotReason(root, 0).textContent).toBe('');
    expect(slotReason(root, 1).textContent).toBe('');
  });

  it('a Human slot left without a device refuses Start with the device-missing reason, not the off one', () => {
    // The three refusal kinds are distinguished on purpose: a card that says only
    // "not ready" is not actionable, and the fix here (connect a pad, or choose Bot)
    // is different from the fix for an Off slot.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    roleBtn(root, 1, 'human').dispatchEvent(new MouseEvent('click')); // no pads connected
    expect(startBtn(root).disabled).toBe(true);
    expect(slotReason(root, 1).textContent).toBe(
      'Player 2 is Human but no device is free. Connect a controller, or choose Bot.',
    );
    // ...and connecting one clears it, which is what proves the gate reads live pads.
    h.setDetectedPads([{ padIndex: 0, id: 'Pad One' }]);
    expect(startBtn(root).disabled).toBe(false);
    expect(slotReason(root, 1).textContent).toBe('');
  });

  it('keyboard-only first launch is playable by default: no refusal, and exactly one human', () => {
    // The issue's "first-time keyboard-only ... produce playable defaults". A default
    // of Human for slot 1 would hand a keyboard-only player a tank nothing can drive.
    const { hud: h, root } = mount(); // no setDetectedPads at all
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(startBtn(root).disabled, 'first launch must be startable with no controllers').toBe(false);
    expect(startBtn(root).getAttribute('aria-describedby')).toBeNull();
    expect(slotDevice(root, 0).textContent).toBe('Keyboard / Mouse / Touch');
    expect(slotDevice(root, 1).textContent).toBe('Bot');
  });

  it('returning from a match reopens the pane on the roles that match started with', () => {
    // The issue's "returning from gameplay preserves displayed role choices". The
    // return-to-setup path is `showVersusSetup(true, initial)` with loop.ts's retained
    // `initialVersusConfig` -- the UNRESOLVED config the session was started from.
    //
    // Driven end to end rather than asserted on `initial` alone: the seeding call is
    // `setVersusConfig`, so this also pins that a re-open RE-RENDERS the cards from the
    // seeded slots. Kills the mutation "seed the state but skip renderVersusSlotRows",
    // which would leave the previous match's cards on screen while Start emitted the
    // seeded ones -- the same display/launch divergence the issue is about, one level up.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    playersBtn(root, 3).dispatchEvent(new MouseEvent('click'));
    roleBtn(root, 1, 'human').dispatchEvent(new MouseEvent('click'));

    let started: VersusConfig | null = null;
    h.onVersusStart((c) => {
      started = c;
    });
    startBtn(root).dispatchEvent(new MouseEvent('click'));
    const launched = started as unknown as VersusConfig;
    expect(launched.slots).toEqual([{ role: 'human' }, { role: 'human' }, { role: 'bot' }]);

    // ...the match runs, then the results screen returns to setup with what it launched.
    h.setState('playing');
    h.setState('main-menu');
    h.showVersusSetup(true, launched);
    expect(slotRows(root), 'the pane reopened at the match player count').toHaveLength(3);
    expect(roleBtn(root, 1, 'human').classList.contains('ui-selectable--on')).toBe(true);
    expect(roleBtn(root, 2, 'bot').classList.contains('ui-selectable--on')).toBe(true);
    // ...and a negative half: slot 1 is NOT still showing the default it started life at.
    expect(roleBtn(root, 1, 'bot').classList.contains('ui-selectable--on')).toBe(false);
  });

  it('Players change REPLACES the slot rows across two successive re-renders, and keeps the roles already chosen', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(slotRows(root)).toHaveLength(2);
    roleBtn(root, 1, 'human').dispatchEvent(new MouseEvent('click'));
    playersBtn(root, 3).dispatchEvent(new MouseEvent('click'));
    expect(slotRows(root)).toHaveLength(3);
    expect(
      roleBtn(root, 1, 'human').classList.contains('ui-selectable--on'),
      "resizeSlots keeps slot 1's chosen role when the count grows",
    ).toBe(true);
    playersBtn(root, 4).dispatchEvent(new MouseEvent('click'));
    expect(slotRows(root)).toHaveLength(4);
  });

  it('Back hides the pane and returns to the TITLE menu -- hardcoded, unlike handleControllersBack\'s shownState routing', () => {
    // The Versus button itself is visible only at 'title' (see its own test above),
    // so Back has exactly one place to return to. Opened from 'paused' on purpose --
    // a real user cannot (the open button is hidden there), but the point is to
    // prove Back calls setState('main-menu') REGARDLESS of what state was current when
    // the pane opened, not merely that it happens to already look right: starting
    // from 'title' would leave every title-only marker already correct before Back
    // ever ran, so dropping the setState('main-menu') call would go unnoticed -- verified
    // by mutation (removing it from handleVersusBack) survived that shape of the test.
    const { hud: h, root } = mount();
    h.setState('paused');
    h.showVersusSetup(true);
    backBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(view(root).classList.contains('hud-versus-setup--hidden')).toBe(true);
    // Landed on TITLE, not back on 'paused': the pause panel's own action button
    // (Resume) is exactly what would still be showing if setState('main-menu') were
    // never called -- showVersusSetup(false) alone only un-hides .hud-panel, it does
    // not touch which of actionBtn/Continue/New Game is visible.
    expect(
      (root.querySelector('.hud-action') as HTMLButtonElement).classList.contains('hud-action--hidden'),
      "Back did not land on title -- the pause panel's own action button is still showing",
    ).toBe(true);
    expect(
      openBtn(root).classList.contains('hud-versus-open--hidden'),
      'Back did not land back on the title menu',
    ).toBe(false);
  });

  it('is closed unconditionally by ANY state change, same as every sibling subpanel', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    h.setState('playing');
    expect(view(root).classList.contains('hud-versus-setup--hidden')).toBe(true);
  });

  it('roving tabindex reaches Start, then Back -- the two controls the task brief names explicitly', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(document.activeElement, 'opening the pane did not focus its CONTAINER').toBe(view(root));
    let steps = 0;
    while (document.activeElement !== startBtn(root) && steps < 40) {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
      steps += 1;
    }
    expect(document.activeElement, 'never reached Start').toBe(startBtn(root));
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement, 'the step after Start did not reach Back').toBe(backBtn(root));
  });
});

describe('hud: continue vs new game', () => {
  const continueBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-continue') as HTMLButtonElement;
  const newGameBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-new-game') as HTMLButtonElement;

  it('Continue is absent with no active run, and appears once setContinueAvailable says so', () => {
    // The assertion that can fail where "the button exists" cannot (issue #135): a
    // production change that always shows Continue, or never does, both break this.
    // Driven by setContinueAvailable, NOT setLevelSelect's `unlocked` -- issue #153
    // separates "an active run exists" from "levels are permanently unlocked".
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.setLevelSelect(1, 4); // unlocked levels exist, but that says nothing about a run
    expect(continueBtn(root).classList.contains('hud-continue--hidden'), 'Continue must not show with no active run').toBe(true);
    expect(newGameBtn(root).classList.contains('hud-new-game--hidden')).toBe(false);

    h.setContinueAvailable(true);
    expect(continueBtn(root).classList.contains('hud-continue--hidden'), 'Continue must show once a run is active').toBe(false);

    h.setContinueAvailable(false);
    expect(continueBtn(root).classList.contains('hud-continue--hidden'), 'Continue must hide again once the run ends').toBe(true);
  });

  it('Continue fires the same onStartRestart callback the old single action button did', () => {
    const { hud: h, root } = mount();
    let starts = 0;
    h.onStartRestart(() => starts++);
    h.setState('main-menu');
    h.setContinueAvailable(true);
    continueBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(starts).toBe(1);
  });

  it('New Game fires its OWN callback, distinct from onLevelSelect', () => {
    // Before issue #153 New Game reported onLevelSelect(0), indistinguishable from
    // picking level 1 in the Levels panel -- exactly the seam practice-vs-campaign
    // needed to tell apart and could not. The production change that would break this
    // is New Game firing onLevelSelect again, or firing nothing at all.
    const { hud: h, root } = mount();
    let newGames = 0;
    const picks: number[] = [];
    h.onNewGame(() => newGames++);
    h.onLevelSelect((i) => picks.push(i));
    h.setState('main-menu');
    h.setContinueAvailable(true); // a run exists, but New Game must still fire
    newGameBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(newGames).toBe(1);
    expect(picks).toEqual([]);
  });

  it('New Game is always offered at title, with or without an active run', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    expect(newGameBtn(root).classList.contains('hud-new-game--hidden')).toBe(false);
    h.setContinueAvailable(true);
    expect(newGameBtn(root).classList.contains('hud-new-game--hidden')).toBe(false);
  });

  it('both buttons are a title-screen affair, and the retired action button stays hidden there', () => {
    const { hud: h, root } = mount();
    h.setContinueAvailable(true);
    h.setState('main-menu');
    expect(continueBtn(root).classList.contains('hud-continue--hidden')).toBe(false);
    expect(newGameBtn(root).classList.contains('hud-new-game--hidden')).toBe(false);
    for (const s of ['paused', 'outcome-win', 'outcome-lose'] as const) {
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

  it('the Stats button lives on the title panel only', () => {
    const { hud: h, root } = mount();
    for (const s of ['paused', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-stats-open--hidden'), s).toBe(true);
    }
    h.setState('main-menu');
    expect(openBtn(root).classList.contains('hud-stats-open--hidden')).toBe(false);
  });

  it('both resets are two-click: the first arms, the second fires', () => {
    const { hud: h, root } = mount();
    let statResets = 0;
    let progResets = 0;
    h.onResetStats(() => statResets++);
    h.onResetProgress(() => progResets++);
    h.setStats({ lifetime: SOME, attempt: NONE });
    h.setState('main-menu');
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
    h.setStats({ lifetime: SOME, attempt: NONE });
    h.setState('main-menu');
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
    h.setStats({ lifetime: SOME, attempt: { ...NONE, shellKills: 3, shotsFired: 6, deaths: 1 } });
    h.setState('outcome-win');
    const line = (root.querySelector('.hud-attempt-summary') as HTMLElement).textContent ?? '';
    expect(line).toContain('3 kills');
    expect(line).toContain('50%');
    // And updates if the final batch lands after the panel opened -- the winning
    // kill is recorded a beat after the state flips.
    h.setStats({ lifetime: SOME, attempt: { ...NONE, shellKills: 4, shotsFired: 6, deaths: 1 } });
    expect((root.querySelector('.hud-attempt-summary') as HTMLElement).textContent).toContain('4 kills');
  });

  it('win panel carries the coop kill line, twin of the attempt summary', () => {
    const { hud: h, root } = mount();
    h.setCoopKills([3, 5]);
    h.setState('outcome-win');
    const line = (root.querySelector('.hud-coop-kills') as HTMLElement).textContent ?? '';
    expect(line).toBe('P1: 3 · P2: 5');
    expect(root.querySelector('.hud-coop-kills')!.classList.contains('hud-coop-kills--hidden')).toBe(false);
  });

  it('setCoopKills(null) keeps the line hidden even at win/lose -- a 1P session', () => {
    const { hud: h, root } = mount();
    h.setCoopKills(null);
    h.setState('outcome-win');
    expect(root.querySelector('.hud-coop-kills')!.classList.contains('hud-coop-kills--hidden')).toBe(true);
    h.setState('outcome-lose');
    expect(root.querySelector('.hud-coop-kills')!.classList.contains('hud-coop-kills--hidden')).toBe(true);
  });

  it('the coop kill line is hidden outside win/lose, even with live counts set', () => {
    const { hud: h, root } = mount();
    h.setCoopKills([1, 2]);
    h.setState('playing');
    expect(root.querySelector('.hud-coop-kills')!.classList.contains('hud-coop-kills--hidden')).toBe(true);
  });

  it('updates live while the win panel is already open, same as the attempt summary', () => {
    const { hud: h, root } = mount();
    h.setCoopKills([1, 0]);
    h.setState('outcome-win');
    expect((root.querySelector('.hud-coop-kills') as HTMLElement).textContent).toBe('P1: 1 · P2: 0');
    h.setCoopKills([1, 1]);
    expect((root.querySelector('.hud-coop-kills') as HTMLElement).textContent).toBe('P1: 1 · P2: 1');
  });
});

describe('hud: the versus pane reads and writes the RETAINED setup (issue #260)', () => {
  // A REAL `createVersusSetupStore` over a real `createMemoryStorage`, not a fake.
  // A hand-rolled stub would give this file's assertions nothing to say about the
  // module that actually has to survive a reload -- and the store's own sanitize-on-
  // write is part of the behaviour under test, since the pane hands it a whole config.
  function mountWithStore(storage: Storage): { hud: Hud; root: HTMLElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = createHud(root, { versusSetup: createVersusSetupStore(storage) });
    return { hud: h, root };
  }

  const roleBtn = (root: HTMLElement, slot: number, role: string): HTMLButtonElement =>
    root.querySelector(
      `.hud-versus-slot-row[data-slot="${slot}"] .hud-versus-role-btn[data-role="${role}"]`,
    ) as HTMLButtonElement;
  const open = (h: Hud): void => {
    h.setState('main-menu');
    h.showVersusSetup(true);
  };

  it('persists a role choice to the RAW key, so a second HUD on the same storage opens with it', () => {
    // The reload criterion, and the reason it is asserted through a SECOND HUD rather
    // than by reading the first one back: a pane that only updated its own closure
    // state would pass any single-instance assertion and still forget on reload.
    //
    // Negative control: drop the `opts.versusSetup?.set(...)` line from
    // `setVersusConfig` and the second HUD opens on the default Bot for slot 1.
    const storage = createMemoryStorage();
    const first = mountWithStore(storage);
    open(first.hud);
    roleBtn(first.root, 1, 'human').dispatchEvent(new MouseEvent('click'));
    first.hud.dispose();

    expect(storage.getItem(VERSUS_SETUP_KEY), 'nothing reached the raw key').not.toBeNull();
    const second = mountWithStore(storage);
    open(second.hud);
    expect(
      roleBtn(second.root, 1, 'human').classList.contains('ui-selectable--on'),
      'the retained role did not survive into a fresh HUD',
    ).toBe(true);
    second.hud.dispose();
    document.body.innerHTML = '';
  });

  it('persists the match rules too, not only the slots -- every write goes through one funnel', () => {
    // Kills the mutation "persist only in the role-button handler": mode, players,
    // stock, map and friendly fire each have their own call site, and a per-site
    // `store.set` is exactly the thing that gets forgotten at the next one added.
    const storage = createMemoryStorage();
    const first = mountWithStore(storage);
    open(first.hud);
    (first.root.querySelector('.hud-versus-mode-row [data-mode="teams"]') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));
    (first.root.querySelector('.hud-versus-players-row [data-players="4"]') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));
    (first.root.querySelector('.hud-versus-stock-row [data-stock="5"]') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));
    first.hud.dispose();

    const stored = JSON.parse(storage.getItem(VERSUS_SETUP_KEY) as string);
    expect(stored.mode).toBe('teams');
    expect(stored.players).toBe(4);
    expect(stored.stock).toBe(5);
    expect(stored.slots, 'slots follow the player count into storage').toHaveLength(4);
    document.body.innerHTML = '';
  });

  it('never writes a device to storage -- only the role pattern survives', () => {
    // The stored shape is what makes "survives reload" and "never silently binds a
    // different physical controller" both true at once. A pad index in here would
    // break the second the moment anyone read it back.
    const storage = createMemoryStorage();
    const { hud: h, root } = mountWithStore(storage);
    h.setDetectedPads([{ padIndex: 2, id: 'Pad Three' }]);
    open(h);
    roleBtn(root, 1, 'human').dispatchEvent(new MouseEvent('click'));
    const raw = storage.getItem(VERSUS_SETUP_KEY) as string;
    expect(raw).toContain('"role":"human"');
    expect(raw, 'a device index reached storage').not.toContain('padIndex');
    expect(raw).not.toContain('keyboard');
    h.dispose();
    document.body.innerHTML = '';
  });

  it('works with no store at all -- the pane still gates, it simply forgets', () => {
    // `createHud(root)` is the shape ~200 existing tests use. The optional dependency
    // must not turn into a required one by accident.
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = createHud(root);
    open(h);
    const start = root.querySelector('.hud-versus-start') as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    (root.querySelector('.hud-versus-slot-row[data-slot="0"] .hud-versus-role-btn[data-role="bot"]') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));
    expect(start.disabled, 'the gate still runs without a store').toBe(true);
    h.dispose();
    document.body.innerHTML = '';
  });
});

describe('hud: versus results (n-player arc PR 4 -- FFA + teams, .hud-coop-kills precedent)', () => {
  it('win panel carries the ffa results line, per-slot kills/deaths', () => {
    const { hud: h, root } = mount();
    h.setVersusResults({ mode: 'ffa', kills: [2, 0, 1], deaths: [1, 3, 0] });
    h.setState('outcome-win');
    const line = (root.querySelector('.hud-versus-results') as HTMLElement).textContent ?? '';
    expect(line).toBe('P1: 2/1 · P2: 0/3 · P3: 1/0');
    expect(root.querySelector('.hud-versus-results')!.classList.contains('hud-versus-results--hidden')).toBe(false);
  });

  it('win panel carries the teams results line as PER-TEAM sums, not per-slot', () => {
    const { hud: h, root } = mount();
    // slots 0,2 -> team 0; slot 1 -> team 1 (teamOf(slot) = slot % 2).
    h.setVersusResults({ mode: 'teams', kills: [2, 1, 3], deaths: [1, 4, 0] });
    h.setState('outcome-win');
    const line = (root.querySelector('.hud-versus-results') as HTMLElement).textContent ?? '';
    expect(line).toBe('Team 1: 5/1 · Team 2: 1/4');
  });

  it('setVersusResults(null) keeps the line hidden even at win/lose', () => {
    const { hud: h, root } = mount();
    h.setVersusResults(null);
    h.setState('outcome-win');
    expect(root.querySelector('.hud-versus-results')!.classList.contains('hud-versus-results--hidden')).toBe(true);
    h.setState('outcome-lose');
    expect(root.querySelector('.hud-versus-results')!.classList.contains('hud-versus-results--hidden')).toBe(true);
  });

  it('the versus results line is hidden outside win/lose, even with live data set', () => {
    const { hud: h, root } = mount();
    h.setVersusResults({ mode: 'ffa', kills: [1], deaths: [0] });
    h.setState('playing');
    expect(root.querySelector('.hud-versus-results')!.classList.contains('hud-versus-results--hidden')).toBe(true);
  });

  it('updates live while the win panel is already open, same as the coop kill line', () => {
    const { hud: h, root } = mount();
    h.setVersusResults({ mode: 'ffa', kills: [1, 0], deaths: [0, 1] });
    h.setState('outcome-win');
    expect((root.querySelector('.hud-versus-results') as HTMLElement).textContent).toBe('P1: 1/0 · P2: 0/1');
    h.setVersusResults({ mode: 'ffa', kills: [1, 1], deaths: [1, 1] });
    expect((root.querySelector('.hud-versus-results') as HTMLElement).textContent).toBe('P1: 1/1 · P2: 1/1');
  });
});

describe('hud: in-match stock readout (spec §3a, owner addition 2026-08-21)', () => {
  const strip = (root: HTMLElement): HTMLElement => root.querySelector('.hud-versus-stocks') as HTMLElement;
  const entries = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll('.hud-versus-stock-entry')) as HTMLElement[];

  /**
   * `--hud-damage-color` (the death-vignette precedent above) is a CUSTOM property, so
   * jsdom's `getPropertyValue` hands the literal `#rrggbb` string back unparsed. `color`
   * is a REAL css property here -- `span.style.color`, not a custom property -- and
   * jsdom's CSSOM (like a real browser's) normalizes any valid colour value to
   * `rgb(r, g, b)` on read, hex included. Measured directly: assigning `#3fd0ff` and
   * reading `.style.color` back gives `'rgb(63, 208, 255)'`, not `'#3fd0ff'`. This
   * derives that same rgb() form from the exported constant's number, so it is still
   * the CONTRACT being asserted (a colour derived from IDENTITY_RING_COLORS/
   * TEAM_COLORS), not hud.ts's private cssColor implementation.
   */
  function expectedCssColor(hex: number): string {
    const r = (hex >> 16) & 0xff;
    const g = (hex >> 8) & 0xff;
    const b = hex & 0xff;
    return `rgb(${r}, ${g}, ${b})`;
  }

  it('carries the TEAM as a letter beside the colour, all three teams (issue #281)', () => {
    // The non-colour channel. Colour alone fails a colour-blind reader, a forced-colours
    // palette (#368 replaces authored hues outright) and a greyscale screenshot; the
    // letter survives all three. Asserted as TEXT, which is the part that survives.
    const { hud: h, root } = mount();
    // Production order (see the note below this block): the strip's visibility is
    // state-derived, so the session kind has to be set before `playing`.
    h.setSessionKind('versus');
    h.setState('playing');
    h.setVersusStocks([
      { slot: 0, stock: 3, team: 0 },
      { slot: 1, stock: 2, team: 1 },
      { slot: 2, stock: 1, team: 2 },
    ]);
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 A 3', 'P2 B 2', 'P3 C 1']);
    // ...and the third team is a real hue, not the white fallback. This is the assertion
    // that would have failed while TEAM_COLORS had only two entries -- a 2v1v1 rendered
    // team 2 as the unstyled-slot placeholder.
    expect(entries(root)[2].style.color).toBe(expectedCssColor(TEAM_COLORS[2]));
    expect(entries(root)[2].style.color).not.toBe(expectedCssColor(0xffffff));
  });

  it('omits the team letter in FFA, where a slot has no side', () => {
    // The control for the case above: without it, "P1 A 3" could be an unconditional
    // format rather than a teams-only reinforcement, and FFA would grow a letter that
    // means nothing.
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setState('playing');
    h.setVersusStocks([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]);
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 3', 'P2 2']);
  });

  it('setVersusStocks(null) keeps the strip hidden even while playing', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setVersusStocks(null);
    h.setState('playing');
    expect(strip(root).classList.contains('hud-versus-stocks--hidden')).toBe(true);
  });

  // The PRODUCTION order, not the data-then-state order every test above/below this one
  // uses: loop.ts calls `hud.setState('playing')` BEFORE the first real
  // `hud.setVersusStocks(entries)` call, because nothing marks "a versus match just
  // started" as a SimEvent -- onFrameEvents (loop.ts) only fires once something has
  // actually happened. Before this fix, that first setState('playing') ran
  // renderVersusStocks against still-null data, which re-added `--hidden`; the OLD
  // setVersusStocks guard then read that SAME class and silently dropped the very
  // first real call, forever (nothing else touched the class until a later setState,
  // e.g. a pause). Breaks if `setVersusStocks`'s render guard reads the DOM class
  // instead of the state-derived `versusStocksVisible` variable.
  it('production order -- setSessionKind then setState(playing) THEN setVersusStocks -- the strip still ends up visible with entries', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setState('playing');
    h.setVersusStocks([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]);
    expect(strip(root).classList.contains('hud-versus-stocks--hidden')).toBe(false);
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 3', 'P2 2']);
  });

  it('renders one entry per slot, with the slot number and stock count as its text', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setVersusStocks([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]);
    h.setState('playing');
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 3', 'P2 2']);
    expect(strip(root).classList.contains('hud-versus-stocks--hidden')).toBe(false);
  });

  it('ffa entries are tinted from IDENTITY_RING_COLORS[slot], not a copied-out hex', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setVersusStocks([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]);
    h.setState('playing');
    const es = entries(root);
    expect(es[0].style.color).toBe(expectedCssColor(IDENTITY_RING_COLORS[0]));
    expect(es[1].style.color).toBe(expectedCssColor(IDENTITY_RING_COLORS[1]));
  });

  it("teams entries are tinted from TEAM_COLORS[team], not IDENTITY_RING_COLORS[slot]", () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    // slot 0 carries team 1 deliberately -- if the dispatch dropped `team` and fell
    // through to the ffa branch, this would read IDENTITY_RING_COLORS[0] instead.
    h.setVersusStocks([{ slot: 0, stock: 3, team: 1 }, { slot: 1, stock: 2, team: 0 }]);
    h.setState('playing');
    const es = entries(root);
    expect(es[0].style.color).toBe(expectedCssColor(TEAM_COLORS[1]));
    expect(es[1].style.color).toBe(expectedCssColor(TEAM_COLORS[0]));
    expect(es[0].style.color).not.toBe(expectedCssColor(IDENTITY_RING_COLORS[0]));
  });

  it('hidden at title/win/lose even with entries set', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setVersusStocks([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]);
    for (const s of ['main-menu', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(strip(root).classList.contains('hud-versus-stocks--hidden'), s).toBe(true);
    }
  });

  it('visible at both playing and paused', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setVersusStocks([{ slot: 0, stock: 3 }]);
    for (const s of ['playing', 'paused'] as const) {
      h.setState(s);
      expect(strip(root).classList.contains('hud-versus-stocks--hidden'), s).toBe(false);
    }
  });

  it('a campaign session never shows the strip, even with entries set -- the gate is sessionKind, not trusting loop.ts to never call this with entries', () => {
    const { hud: h, root } = mount();
    // sessionKind defaults to 'campaign' -- no setSessionKind('versus') call.
    h.setVersusStocks([{ slot: 0, stock: 3 }]);
    h.setState('playing');
    expect(strip(root).classList.contains('hud-versus-stocks--hidden')).toBe(true);
  });
});

describe('hud: campaign Lives/Enemies stats hidden during versus (issue #282)', () => {
  const statEls = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll('.hud-campaign-stat')) as HTMLElement[];
  const hidden = (root: HTMLElement): boolean[] =>
    statEls(root).map((e) => e.classList.contains('hud-campaign-stat--hidden'));

  it('hides Lives/Enemies for a versus session in both playing and paused', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    // Two stat elements exist (Lives, Enemies) -- fails silently (an empty sweep that
    // still passes) if the markup ever drops one, so the population is asserted here
    // rather than assumed.
    expect(statEls(root).length).toBe(2);
    for (const s of ['playing', 'paused'] as const) {
      h.setState(s);
      expect(hidden(root), s).toEqual([true, true]);
    }
  });

  it('keeps Lives/Enemies visible and updating for a campaign session -- the negative control against over-hiding', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('campaign');
    for (const s of ['playing', 'paused'] as const) {
      h.setState(s);
      expect(hidden(root), s).toEqual([false, false]);
    }
    h.setLives(2);
    h.setEnemiesRemaining(1);
    expect((root.querySelector('.hud-lives') as HTMLElement).textContent).toBe('2');
    expect((root.querySelector('.hud-enemies') as HTMLElement).textContent).toBe('1');
  });

  it("a session-kind switch restores the stats -- production reboots into a FRESH Hud per session (boot.ts's requestCampaignSession -> deps.startGame), so this exercises the stronger property that the gate tracks CURRENT kind rather than latching the first kind a Hud instance ever saw", () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setState('playing');
    expect(hidden(root)).toEqual([true, true]);

    h.setSessionKind('campaign');
    expect(hidden(root)).toEqual([false, false]);
  });

  it('a campaign session never hides the stats even if setVersusStocks somehow carried entries -- the gate is sessionKind, not versus data', () => {
    const { hud: h, root } = mount();
    // sessionKind defaults to 'campaign' -- no setSessionKind('versus') call.
    h.setVersusStocks([{ slot: 0, stock: 3 }]);
    h.setState('playing');
    expect(hidden(root)).toEqual([false, false]);
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
    for (const s of ['paused', 'outcome-win', 'outcome-lose'] as const) {
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
    expect(containers.length, '7 panel containers carry tabindex=-1 (panel + 6 subpanels: ' +
      'controller assignment landing added the 6th (docs/superpowers/plans/2026-08-17-' +
      'controller-assignment.md), the versus setup pane the 7th (docs/superpowers/specs/' +
      '2026-08-21-versus-setup-menu-design.md))').toBe(7);
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
    'hud-controllers-open': 'hud-controllers',
    'hud-versus-open': 'hud-versus-setup',
  };
  const BACK_OF_PANEL: Record<string, string> = {
    'hud-customize': 'hud-customize-back',
    'hud-stats': 'hud-stats-back',
    'hud-achievements': 'hud-achievements-back',
    'hud-levelselect': 'hud-levelselect-back',
    'hud-controllers': 'hud-controllers-back',
    'hud-versus-setup': 'hud-versus-back',
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
    h.setState('main-menu'); // splash -> title: focuses the .hud-panel CONTAINER, index -1

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
    expect(totalControls, 'recount the panels above if this moves').toBe(72);
    expect(visited.size, 'a control was reached more than once under a different identity').toBe(
      totalControls,
    );
  });

  it('skips locked level buttons when stepping through the Levels panel', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(2, 4); // levels 3 and 4 locked
    h.setState('main-menu');

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
    h.setState('main-menu');
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

  it('reaches Resume, then Controllers, then Quit from the pause panel with three ArrowDowns', () => {
    // Was "two ArrowDowns" before the controller assignment panel landed (docs/
    // superpowers/plans/2026-08-17-controller-assignment.md): its own open button sits
    // between the action button and Quit in DOM order and is now visible at 'paused'
    // too (owner ruling: "in case controllers disconnect"), so it is a real, reachable
    // stop, not a skip.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.setState('playing');
    h.setState('paused');
    pressActive('ArrowDown');
    expect(document.activeElement, 'the first ArrowDown from pause did not reach Resume').toBe(
      root.querySelector('.hud-action'),
    );
    pressActive('ArrowDown');
    expect(document.activeElement, 'the second ArrowDown did not reach Controllers').toBe(
      root.querySelector('.hud-controllers-open'),
    );
    pressActive('ArrowDown');
    expect(document.activeElement, 'the third ArrowDown did not reach Quit').toBe(
      root.querySelector('.hud-quit'),
    );
  });

  it('keeps the menu hotkeys alive returning to title via a subpanel\'s Back button too', () => {
    // The existing 'leaves the menu hotkeys alive after the title screen is dismissed'
    // test (createHud panel) covers splash -> title only. Back -> title is a SEPARATE
    // code path (setState('main-menu') called from handleCustomizeBack, not from
    // dismissSplash), and nothing else in this file proves it lands on the container
    // rather than on Continue/New Game.
    const { hud: h, root } = mount();
    h.setState('main-menu');
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
    h.setState('main-menu');
    h.setState('playing');
    h.setState('outcome-win');
    expect(document.activeElement, 'win focused something other than the panel container').toBe(
      panel,
    );
    pressActive('ArrowDown');
    expect(document.activeElement).toBe(action);
    h.setState('playing');
    h.setState('outcome-lose');
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
    h.setState('main-menu');
    h.setState('playing');
    h.setState('outcome-win'); // controls: the action button ALONE
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

describe('hud: the title screen carries no tagline', () => {
  const subtitle = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-subtitle') as HTMLElement;

  it('leaves the title subtitle empty AND out of layout', () => {
    // A directive: the menu is crowded and the tagline was the least load-bearing thing
    // on it. Both halves are asserted because blanking alone is not enough -- .hud-panel
    // is a gapped flex column, so an emptied element still costs its 14px gap. Fails if
    // the string comes back, or if setSubtitle stops toggling the hidden class.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    expect(subtitle(root).textContent).toBe('');
    expect(subtitle(root).classList.contains('hud-subtitle--hidden')).toBe(true);
  });

  it('still shows a subtitle in states that have one', () => {
    // The negative control: without it, deleting setSubtitle's write entirely -- or
    // hiding the element permanently -- would satisfy the test above.
    const { hud: h, root } = mount();
    h.setState('outcome-lose');
    expect(subtitle(root).textContent).toBe('Out of lives.');
    expect(subtitle(root).classList.contains('hud-subtitle--hidden')).toBe(false);
  });
});

describe('hud: the level-cleared panel offers the main menu', () => {
  const quitBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-quit') as HTMLButtonElement;
  const hidden = (root: HTMLElement): boolean =>
    quitBtn(root).classList.contains('hud-quit--hidden');

  it('shows it after clearing an INTERMEDIATE level, labelled Main Menu', () => {
    // Fails if the clearedIntermediate condition is dropped, or if the label is left as
    // "Quit to Title" -- wrong copy for leaving a level you just won.
    const { hud: h, root } = mount();
    h.setLevel(2, 5);
    h.setState('outcome-win');
    expect(hidden(root)).toBe(false);
    expect(quitBtn(root).textContent).toBe('Main Menu');
  });

  it('hides it on the FINAL win, where the run has already ended', () => {
    // The discriminator, and the reason `s === 'win'` alone is not the condition:
    // endRun has run by then, so there is no run to return to.
    const { hud: h, root } = mount();
    h.setLevel(5, 5);
    h.setState('outcome-win');
    expect(hidden(root)).toBe(true);
  });

  it('hides it on lose even mid-campaign', () => {
    // A loss ends the run too, so a cleared-level route out does not apply. Fails if the
    // condition widens from `s === 'win'` to "any end screen with levels left".
    const { hud: h, root } = mount();
    h.setLevel(2, 5);
    h.setState('outcome-lose');
    expect(hidden(root)).toBe(true);
  });

  it('still says Quit to Title when paused', () => {
    // The label is per-state, not a global rename: pause keeps its own wording.
    const { hud: h, root } = mount();
    h.setLevel(2, 5);
    h.setState('paused');
    expect(hidden(root)).toBe(false);
    expect(quitBtn(root).textContent).toBe('Quit to Title');
  });
});

describe('hud: relaunch target -- the title/outcome affordance policy', () => {
  const continueBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-continue') as HTMLButtonElement;
  const newGameBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-new-game') as HTMLButtonElement;
  const levelSelectOpenBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-levelselect-open') as HTMLButtonElement;
  const campaignOpenBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-campaign-open') as HTMLButtonElement;
  const versusOpenBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-versus-open') as HTMLButtonElement;
  const actionBtn = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-action') as HTMLElement;

  /** The whole visibility/label set applyTitleAffordances drives, snapshotted together
   *  so a single assertion can pin the exact combination rather than one class at a
   *  time. */
  function titleAffordances(root: HTMLElement): {
    continueVisible: boolean;
    newGameVisible: boolean;
    newGameLabel: string;
    levelsVisible: boolean;
    campaignVisible: boolean;
    versusVisible: boolean;
  } {
    return {
      continueVisible: !continueBtn(root).classList.contains('hud-continue--hidden'),
      newGameVisible: !newGameBtn(root).classList.contains('hud-new-game--hidden'),
      newGameLabel: newGameBtn(root).textContent ?? '',
      levelsVisible: !levelSelectOpenBtn(root).classList.contains('hud-levelselect-open--hidden'),
      campaignVisible: !campaignOpenBtn(root).classList.contains('hud-campaign-open--hidden'),
      versusVisible: !versusOpenBtn(root).classList.contains('hud-versus-open--hidden'),
    };
  }

  it("the default target ('campaign-levels'), never calling setRelaunchTarget, is byte-identical to the title screen before this method existed", () => {
    // Fails if the default relaunchTarget is ever 'versus-setup', or if
    // applyTitleAffordances changes anything a campaign session's title screen showed
    // before this policy existed -- the "campaign flow is untouched" invariant.
    const { hud: h, root } = mount();
    h.setContinueAvailable(true);
    h.setLevelSelect(2, 4);
    h.setState('main-menu');
    expect(titleAffordances(root)).toEqual({
      continueVisible: true,
      newGameVisible: true,
      newGameLabel: 'New Game',
      levelsVisible: true,
      campaignVisible: false,
      versusVisible: true,
    });
  });

  it("an explicit setRelaunchTarget('campaign-levels') produces the IDENTICAL DOM as never calling it at all", () => {
    const { hud: h, root } = mount();
    h.setRelaunchTarget('campaign-levels');
    h.setContinueAvailable(true);
    h.setLevelSelect(2, 4);
    h.setState('main-menu');
    expect(titleAffordances(root)).toEqual({
      continueVisible: true,
      newGameVisible: true,
      newGameLabel: 'New Game',
      levelsVisible: true,
      campaignVisible: false,
      versusVisible: true,
    });
  });

  it("setRelaunchTarget('versus-setup') hides Continue and Levels-open, relabels New Game to 'Start Match' (kept VISIBLE, not hidden), and shows Campaign -- Versus stays visible either way", () => {
    // New Game is deliberately NOT hidden: unlike Continue, its handler
    // (loop.ts's onNewGame) always rebuilds the world via switchTo before
    // startPlaying(), and for a versus session it is the ONLY path from title into
    // the just-configured match (a versus session is never campaignActive(), so
    // nothing else reaches sm.startPlaying() from title once Levels is hidden).
    // Hiding it, as the controller ruling's literal text asked, would make a freshly
    // rebooted versus session unplayable through this UI -- see setRelaunchTarget's
    // own doc comment on the Hud interface.
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setContinueAvailable(true); // a real campaign run is ALSO active -- see below
    h.setLevelSelect(2, 4); // a hypothetical multi-level versus system
    h.setState('main-menu');
    expect(titleAffordances(root)).toEqual({
      continueVisible: false,
      newGameVisible: true,
      newGameLabel: 'Start Match',
      levelsVisible: false,
      campaignVisible: true,
      versusVisible: true,
    });
  });

  it('is order-independent: setRelaunchTarget before or after setState/setContinueAvailable lands on the same DOM', () => {
    // Fails if `relaunchTarget` is only consulted INSIDE setState (e.g. a stale `s`
    // closed over rather than re-read live) -- that shape would leave Continue VISIBLE
    // when setRelaunchTarget runs after setState/setContinueAvailable, since those two
    // would have already computed visibility against the OLD (campaign) target.
    const before = mount();
    before.hud.setRelaunchTarget('versus-setup');
    before.hud.setContinueAvailable(true);
    before.hud.setState('main-menu');

    const after = mount();
    after.hud.setContinueAvailable(true);
    after.hud.setState('main-menu');
    after.hud.setRelaunchTarget('versus-setup');

    expect(titleAffordances(before.root)).toEqual(titleAffordances(after.root));
    // Sanity: hasProgress is true in both, so if the order bug above were present this
    // would read `continueVisible: true` for `after` instead.
    expect(titleAffordances(after.root).continueVisible).toBe(false);
    before.hud.dispose();
  });

  it("closes the corpse-world window: setContinueAvailable(true) pushed AFTER setState('main-menu') on a versus session still keeps Continue hidden", () => {
    // The discriminating case gating only inside setState would miss: loop.ts pushes
    // setContinueAvailable(deps.run.active() !== null) unconditionally on every
    // 'title' transition (not gated on tracksProgress), and `deps.run` is the SAME
    // store a versus session shares with campaign -- so this exact ordering fires
    // whenever a real campaign run is ALSO active, true for most returning players,
    // not an edge case.
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setState('main-menu');
    h.setContinueAvailable(true);
    expect(continueBtn(root).classList.contains('hud-continue--hidden')).toBe(true);
  });

  it("the corpse-window closure holds under a second call order: setContinueAvailable(true) before win/lose/title (not just after title, as the case above covers) still keeps Continue hidden -- order-independence, not a trace of loop.ts's actual runtime call order", () => {
    // Mirrors the reachable sequence Task 5's own report traced but could not exercise
    // through its loop.test.ts fake (which only records calls, not real DOM/close-all
    // interactions): versus win/lose -> the setup pane's Back button (setState('main-menu'))
    // -> title, with Continue otherwise reachable via a concurrently active campaign
    // run. Fails if Continue's hide is gated on anything narrower than relaunchTarget
    // alone.
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setContinueAvailable(true); // the shared run store says a campaign run is active
    h.setState('outcome-lose'); // the match just ended
    h.setState('main-menu'); // the pane's own Back button (Task 4) lands here
    expect(continueBtn(root).classList.contains('hud-continue--hidden')).toBe(true);
  });

  it("the win/lose action button reads 'Versus Setup' for a versus session's FINAL win and its lose -- truthful about what the click now does", () => {
    // Fails if the label branch is missing, or reads deps/state other than
    // relaunchTarget (e.g. always 'Versus Setup' regardless of target, which the
    // campaign-target tests elsewhere in this file would also have caught).
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setLevel(1, 1); // versus's single synthetic level -- always the FINAL win
    h.setState('outcome-win');
    expect(actionBtn(root).textContent).toBe('Versus Setup');
    h.setState('outcome-lose');
    expect(actionBtn(root).textContent).toBe('Versus Setup');
  });

  it("leaves 'Resume' and 'Next Level' alone for a versus session -- neither click opens the pane, so relabeling either would be the same lie in reverse", () => {
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setState('paused');
    expect(actionBtn(root).textContent).toBe('Resume');
    h.setLevel(1, 2); // an intermediate win -- not reachable for a real versus session
    // (single synthetic level), but the label branch must not fire on it regardless
    h.setState('outcome-win');
    expect(actionBtn(root).textContent).toBe('Next Level');
  });

  it('onCampaignOpen fires once per Campaign button click', () => {
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setState('main-menu');
    let opens = 0;
    h.onCampaignOpen(() => opens++);
    campaignOpenBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(opens).toBe(1);
  });

  it('Campaign is a title-only affordance, even for a versus session', () => {
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setState('main-menu');
    expect(campaignOpenBtn(root).classList.contains('hud-campaign-open--hidden')).toBe(false);
    for (const s of ['paused', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(campaignOpenBtn(root).classList.contains('hud-campaign-open--hidden'), s).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // THE SEPARATION ITSELF (issue #316 review, finding 1). Each direction gets
  // its own negative control, because a regression that collapsed the two
  // concepts back into one value would break exactly one of them.
  // -------------------------------------------------------------------------

  it("setSessionKind('versus') alone changes NO title affordance -- identity is not the button policy", () => {
    // The developer-flag versus shape (`?dev=1&mode=ffa`): Versus identity, campaign
    // relaunch target. Fails if any button gate is keyed on sessionKind -- Continue
    // would vanish, New Game would read 'Start Match', and the Campaign button would
    // appear, on a session whose Continue and Levels still rebuild correct FFA worlds.
    const kindOnly = mount();
    kindOnly.hud.setSessionKind('versus');
    kindOnly.hud.setContinueAvailable(true);
    kindOnly.hud.setLevelSelect(2, 4);
    kindOnly.hud.setState('main-menu');

    const neither = mount();
    neither.hud.setContinueAvailable(true);
    neither.hud.setLevelSelect(2, 4);
    neither.hud.setState('main-menu');

    expect(titleAffordances(kindOnly.root)).toEqual(titleAffordances(neither.root));
    // Sanity that the fixture is the campaign-shaped one, not two identically broken
    // screens: an assertion comparing two DOMs cannot fail if both are wrong.
    expect(titleAffordances(kindOnly.root)).toEqual({
      continueVisible: true,
      newGameVisible: true,
      newGameLabel: 'New Game',
      levelsVisible: true,
      campaignVisible: false,
      versusVisible: true,
    });
    kindOnly.hud.dispose();
    neither.hud.dispose();
  });

  it("setSessionKind('versus') alone leaves the outcome action button reading 'Play Again'/'Retry'", () => {
    // The label names the click's DESTINATION, and loop.ts's onStartRestart routes a
    // developer-flag versus session through landOnCampaignBoard -- so 'Versus Setup'
    // here would name a pane the click never opens. Fails if the label branch is
    // keyed on sessionKind.
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setLevel(1, 1); // the FINAL win -- the branch that carries the label
    h.setState('outcome-win');
    expect(actionBtn(root).textContent).toBe('Play Again');
    h.setState('outcome-lose');
    expect(actionBtn(root).textContent).toBe('Retry');
  });

  it("setRelaunchTarget('versus-setup') alone hides NO campaign stat and shows NO stock strip -- the button policy is not identity", () => {
    // The other direction: a regression that reused the title policy as gameplay
    // identity would blank Lives/Enemies and surface the stock strip on the strength
    // of a button-shape decision.
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setState('playing');
    h.setVersusStocks([{ slot: 0, stock: 3 }]);
    for (const el of Array.from(root.querySelectorAll('.hud-campaign-stat'))) {
      expect(el.classList.contains('hud-campaign-stat--hidden')).toBe(false);
    }
    expect(
      (root.querySelector('.hud-versus-stocks') as HTMLElement).classList.contains(
        'hud-versus-stocks--hidden',
      ),
    ).toBe(true);
  });

  it("setSessionKind('practice') shows the campaign stats, exactly as 'campaign' does", () => {
    // Practice is a campaign board played in isolation: its lives and enemy count are
    // as real there as in a run. Fails if the stat gate is widened to `!== 'campaign'`,
    // which is the tempting shape once the setter takes three kinds.
    const practice = mount();
    practice.hud.setSessionKind('practice');
    practice.hud.setState('playing');
    for (const el of Array.from(practice.root.querySelectorAll('.hud-campaign-stat'))) {
      expect(el.classList.contains('hud-campaign-stat--hidden')).toBe(false);
    }
    // ...and its title affordances are campaign-shaped too.
    practice.hud.setContinueAvailable(true);
    practice.hud.setLevelSelect(2, 4);
    practice.hud.setState('main-menu');
    expect(titleAffordances(practice.root).newGameLabel).toBe('New Game');
    expect(titleAffordances(practice.root).campaignVisible).toBe(false);
    practice.hud.dispose();
  });

  it('a MID-SESSION kind change re-gates both gameplay surfaces, in both directions', () => {
    // A Levels pick makes a campaign session Practice and landing back on its home
    // board makes it Campaign again, so the kind is no longer fixed for a session's
    // life. Fails if either surface is computed once at the first setState and never
    // recomputed -- the shape the old "fixed for the session's whole life" comment
    // licensed.
    const { hud: h, root } = mount();
    const stocksEl = root.querySelector('.hud-versus-stocks') as HTMLElement;
    const statHidden = (): boolean =>
      (root.querySelector('.hud-campaign-stat') as HTMLElement).classList.contains(
        'hud-campaign-stat--hidden',
      );
    h.setSessionKind('campaign');
    h.setState('playing');
    h.setVersusStocks([{ slot: 0, stock: 3 }]);
    expect(statHidden()).toBe(false);
    expect(stocksEl.classList.contains('hud-versus-stocks--hidden')).toBe(true);

    // ...now the same live session becomes versus, with NO intervening setState.
    h.setSessionKind('versus');
    expect(statHidden()).toBe(true);
    expect(stocksEl.classList.contains('hud-versus-stocks--hidden')).toBe(false);

    // ...and back again.
    h.setSessionKind('campaign');
    expect(statHidden()).toBe(false);
    expect(stocksEl.classList.contains('hud-versus-stocks--hidden')).toBe(true);
  });

  it('roving tabindex reaches the Campaign button on a versus-kind title screen', () => {
    // hud.ts's focusableControls is a GENERIC `button, [tabindex]` sweep of whatever is
    // visible inside the active panel container -- not a hardcoded class list -- so a
    // new title-panel button is reachable for free. This pins that it actually IS, the
    // same shape as the versus setup pane's own "reaches Start, then Back" test: a
    // bounded ArrowDown walk (not unbounded -- an unreachable control must fail loudly
    // here rather than hang the suite the way flipping the default did in this
    // policy's own mutation testing).
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setState('main-menu');
    expect(document.activeElement, 'opening the title panel did not focus its CONTAINER').toBe(
      root.querySelector('.hud-panel'),
    );
    let steps = 0;
    while (document.activeElement !== campaignOpenBtn(root) && steps < 40) {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
      steps += 1;
    }
    expect(document.activeElement, 'never reached the Campaign button').toBe(campaignOpenBtn(root));
  });
});


describe('the UI kit contracts, swept across every control that uses them (issue #321)', () => {
  function mountEveryChoice(): { hud: Hud; root: HTMLElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = createHud(root);
    h.setLevelSelect(2, 4);
    h.setBotAssignmentAllowed(true);
    h.setDetectedPads([{ padIndex: 1, id: 'Test Pad' }]);
    h.setControllers([{ kind: 'keyboard' }, { kind: 'gamepad', padIndex: 1 }]);
    // The paint shop's three rows render their selection when the game TELLS the HUD
    // what is stored -- `setHullColor`/`setSkin`/`setAccentColor`, the same calls
    // `loop.ts` makes at boot -- not at construction. A freshly built HUD shows no ring
    // on them and, equally, announces no pressed state; that symmetry is the point, and
    // driving the setters here is what puts those 18 controls inside the sweep at all
    // rather than leaving them permanently unselected and permanently unannounced.
    h.setHullColor((root.querySelector('.hud-swatch[data-hull]') as HTMLElement).dataset.hull as never);
    h.setSkin((root.querySelector('.hud-skin') as HTMLElement).dataset.skin as never);
    h.setAccentColor((root.querySelector('.hud-swatch[data-accent]') as HTMLElement).dataset.accent as never);
    return { hud: h, root };
  }

  const selectables = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll('button.ui-selectable'));

  it('announces the current choice on EVERY choice control, not only draws it', () => {
    // Before `setSelected`, the hull swatches, accent swatches, skins, controller
    // sources and versus options each toggled a class of their own and told assistive
    // technology nothing: the current choice was a white border and nothing else.
    const { root } = mountEveryChoice();
    const btns = selectables(root);
    // Exactly, not a lower bound -- this is the sweep's denominator, and it is measured
    // against THIS fixture rather than derived: 11 swatches in the paint shop (PALETTE 6
    // + ACCENTS 5, which share `.hud-swatch`) + 7 skins (SKINS) + 8 in the Controllers
    // panel (2 slots x [Keyboard/Bot/None + 1 detected pad]) + 23 in the versus pane
    // (17 option buttons -- Mode 2, Players 3, Map 7, Stock 5 -- plus its who's-playing
    // ROLE buttons, 2 slots x [Human/Bot/Off] = 6). Map went 6 -> 7 with issue #271's
    // vs-duel-01, offered at the N=2 this fixture defaults to.
    //
    // 23 and not 25 since issue #260: the who's-playing block used to contribute 8
    // (2 slots x [Keyboard/Bot/None + 1 pad]) as a DEVICE preview reusing the
    // Controllers panel's own candidate rows. It renders per-slot ROLES now, and three
    // roles per slot is 6. A different slot, pad or player count pins a different
    // number; the number moving is the prompt to check the new row is inside the sweep
    // rather than beside it.
    //
    // 26 and not 23 since issue #267: a BOT slot also offers Easy/Normal/Hard.
    // `defaultSlots(2)` is `[human, bot]`, so exactly one slot carries them at this
    // fixture's player count -- 3 buttons, not 6. Re-derived, not incremented: the count
    // depends on how many slots are bots, so a fixture that defaulted both slots to Bot
    // would pin 29 here.
    expect(btns.length).toBe(11 + 7 + 8 + 26);
    const missing = btns
      .filter((b) => !b.hasAttribute('aria-pressed'))
      .map((b) => Array.from(b.classList).join('.'));
    expect(missing, 'choice controls with no announced state').toEqual([]);
    // ...and the two channels agree, control for control. A helper that wrote the
    // attribute once at build time and then only moved the class would pass the sweep
    // above and fail here.
    const disagree = btns
      .filter((b) => (b.getAttribute('aria-pressed') === 'true')
        !== b.classList.contains('ui-selectable--on'))
      .map((b) => Array.from(b.classList).join('.'));
    expect(disagree, 'the ring and the announced state disagree').toEqual([]);
    // Not vacuous: something IS selected in this fixture, so the agreement above is not
    // "every control is false" agreeing with "no control has the class".
    expect(btns.filter((b) => b.getAttribute('aria-pressed') === 'true').length)
      .toBeGreaterThan(0);
  });

  it('moves the announced state with the choice, not only on the first render', () => {
    const { hud: h, root } = mountEveryChoice();
    const skins = () => Array.from(root.querySelectorAll('.hud-skin')) as HTMLButtonElement[];
    const pressed = () => skins().map((b) => b.getAttribute('aria-pressed'));
    const before = pressed();
    const other = skins().find((b) => b.getAttribute('aria-pressed') !== 'true')!;
    h.setSkin(other.dataset.skin as never);
    expect(pressed()).not.toEqual(before);
    expect(other.getAttribute('aria-pressed')).toBe('true');
    expect(pressed().filter((v) => v === 'true')).toHaveLength(1);
  });

  it('associates a locked level with the line that says why it is locked', () => {
    const { hud: h, root } = mountEveryChoice();
    const note = root.querySelector('#hud-levels-note') as HTMLElement;
    expect(note, 'the level picker has no reason line').not.toBeNull();
    expect(note.textContent).toContain('unlock');
    expect(note.classList.contains('hud-levels-note--hidden')).toBe(false);

    const btns = Array.from(root.querySelectorAll('.hud-level-btn')) as HTMLButtonElement[];
    // setLevelSelect(2, 4): levels 1-2 open, 3-4 locked.
    expect(btns.map((b) => b.disabled)).toEqual([false, false, true, true]);
    expect(btns.map((b) => b.getAttribute('aria-describedby')))
      .toEqual([null, null, 'hud-levels-note', 'hud-levels-note']);

    // Nothing locked: the reason goes away rather than explaining a state the player is
    // no longer in, and no button is left pointing at a line that is not on screen.
    h.setLevelSelect(4, 4);
    expect(note.classList.contains('hud-levels-note--hidden')).toBe(true);
    const after = Array.from(root.querySelectorAll('.hud-level-btn')) as HTMLButtonElement[];
    expect(after.map((b) => b.getAttribute('aria-describedby'))).toEqual([null, null, null, null]);
  });

  it("associates a refused Start with the reason, and describes the Controllers panel's real rows with nothing", () => {
    // SUPERSEDES the versus half of this test. It used to assert that the pane's
    // who's-playing PREVIEW buttons pointed at #hud-versus-assignment-note while
    // disabled -- those buttons are gone (issue #260), and the pane's disabled control
    // is now Start itself, whose reason moves with the problem.
    const { root } = mountEveryChoice();
    const described = (sel: string): (string | null)[] =>
      Array.from(root.querySelectorAll(`${sel} .hud-controller-source-btn`))
        .map((b) => b.getAttribute('aria-describedby'));
    // The standalone Controllers panel reassigns for real: its buttons need no excuse.
    expect(new Set(described('.hud-controllers'))).toEqual(new Set([null]));
    expect(described('.hud-controllers').length).toBeGreaterThan(0);
    // ...and the versus pane no longer renders any of those buttons at all.
    expect(described('.hud-versus-setup'), 'the device preview should be gone').toEqual([]);

    const start = root.querySelector('.hud-versus-start') as HTMLButtonElement;
    expect(start.disabled, 'the fixture default is startable').toBe(false);
    expect(start.getAttribute('aria-describedby'), 'an allowed Start needs no excuse').toBeNull();

    // Refuse it, and the association appears with the reason -- not merely near it.
    (root.querySelector('.hud-versus-slot-row[data-slot="0"] .hud-versus-role-btn[data-role="none"]') as HTMLButtonElement)
      .click();
    expect(start.disabled).toBe(true);
    const id = start.getAttribute('aria-describedby');
    expect(id).toBe('hud-versus-slot-reason-0');
    const reason = root.querySelector(`#${id}`) as HTMLElement;
    expect(reason, 'aria-describedby points at no element').not.toBeNull();
    expect(reason.textContent, 'the referenced element is empty, so the excuse says nothing')
      .not.toBe('');
  });
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
      click(root, '.hud-stats-open');

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
      click(root, '.hud-stats-open');
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
      click(root, '.hud-stats-open');
      click(root, '.hud-achievements-open'); // interrupts, before any timer runs
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
      click(root, '.hud-stats-open');
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
      click(root, '.hud-stats-open');
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

      click(root, '.hud-stats-open');
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
      click(root, '.hud-stats-open');
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
