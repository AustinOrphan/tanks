// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type GameplayStatus, type Hud, SINGLE_PLAYER_DEATH_VIGNETTE } from './hud';
import { isMuteHotkey, isPauseHotkey } from './loop';


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
    // HIDDEN at the Main Menu since issue #226, where it used to show: everything left
    // in that bar is in-match status (the audio pair moved to Settings), and carrying the
    // abandoned session's Lives/Enemies/Level over a menu offering to start a new one is
    // the leak the issue names. `hud: the topbar's surface rule` below sweeps every
    // surface; this asserts the one a dismissed splash lands on.
    const topbar = root.querySelector('.hud-topbar') as HTMLElement;
    expect(topbar.classList.contains('hud-topbar--hidden')).toBe(true);
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
    // In Settings -> Audio since issue #226; the topbar chip it used to name is gone.
    return root.querySelector('.hud-settings-mute') as HTMLButtonElement;
  }
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

/**
 * A campaign status at a stated place in its level sequence (issue #324, step S6).
 *
 * The level position rides the status projection now, so every case that used to call
 * `setLevel(current, total)` states a whole session instead. `lives`/`enemies` are the
 * shipped opening pair and are inert here: nothing in these cases reads them.
 */
const atLevel = (mission: number, missions: number): GameplayStatus => ({
  kind: 'campaign',
  mission,
  missions,
  lives: 3,
  enemies: 3,
});

describe('hud: level progression', () => {
  it('shows the level position once told, and only in a multi-level sequence', () => {
    const { hud: h, root } = mount();
    const chip = (): HTMLElement => root.querySelector('.hud-level') as HTMLElement;
    expect(chip().className).toContain('hud-level--hidden'); // nothing until a status lands

    h.setStatus(atLevel(1, 2));
    expect(chip().className).not.toContain('hud-level--hidden');
    // Position without scale since issue #552's ruling: the chip says which board this
    // is and not how many there are. The sequence LENGTH still decides whether the chip
    // shows at all -- that is the next assertion -- so `missions` is read here even
    // though it is no longer written. The `full` arm puts the denominator back, and
    // `topbar-treatment.test.ts` is where every arm's text is asserted.
    expect(chip().textContent).toBe('Level: 1');

    // A one-level sequence (the sandbox) shows no chip: a lone "Level 1" is noise.
    h.setStatus(atLevel(1, 1));
    expect(chip().className).toContain('hud-level--hidden');
    // NEGATIVE CONTROL for the reading above: the chip is the CURRENT position, so a
    // status further along the same sequence renumbers it rather than repeating itself.
    h.setStatus(atLevel(2, 4));
    expect(chip().textContent).toBe('Level: 2');
  });

  it('offers Next Level on an intermediate win, Play Again on the final one', () => {
    const { hud: h, root } = mount();
    const title = (): string => (root.querySelector('.hud-title') as HTMLElement).textContent ?? '';
    const button = (): string => (root.querySelector('.hud-action') as HTMLElement).textContent ?? '';

    h.setStatus(atLevel(1, 2));
    h.setState('outcome-win');
    expect(title()).toContain('cleared');
    expect(button()).toBe('Next Level');

    h.setStatus(atLevel(2, 2));
    h.setState('outcome-win'); // re-renders unconditionally; the equal-state guard lives in state.ts, not here
    expect(title()).toBe('You Win!');
    expect(button()).toBe('Play Again');
  });

  it('never says cleared before any status has been pushed at all', () => {
    // A HUD that has not been told about a session behaves exactly as it always did.
    const { hud: h, root } = mount();
    h.setState('outcome-win');
    expect((root.querySelector('.hud-title') as HTMLElement).textContent).toBe('You Win!');
  });
});

describe('hud: pause panel', () => {
  const panel = (root: HTMLElement): HTMLElement => root.querySelector('.hud-panel') as HTMLElement;
  const quit = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-quit') as HTMLButtonElement;
  // THE UTILITIES REGION, which is where Settings lives since issue #226. The pause
  // panel used to carry an inline five-control audio/input row; it now carries the one
  // button that opens the pane those controls moved into, and the region is the thing
  // whose visibility says whether a paused player can reach them at all.
  const settings = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-menu-utilities') as HTMLElement;

  it('shows the frozen-scene panel with Resume, Quit and a way into Settings', () => {
    const { hud: h, root } = mount();
    h.setState('paused');
    expect(panel(root).classList.contains('hud-panel--hidden')).toBe(false);
    expect((root.querySelector('.hud-title') as HTMLElement).textContent).toBe('Paused');
    expect((root.querySelector('.hud-action') as HTMLElement).textContent).toBe('Resume');
    expect(quit(root).classList.contains('hud-quit--hidden')).toBe(false);
    expect(settings(root).classList.contains('hud-menu-utilities--hidden')).toBe(false);
    // ...and the region carries Settings alone here: repainting a tank or reading
    // lifetime statistics is not something a paused round has a claim on, so Customize
    // and Records are hidden inside a region that is itself visible.
    const visible = (sel: string): boolean =>
      !(root.querySelector(sel) as HTMLElement).classList.contains(`${sel.slice(1)}--hidden`);
    expect(visible('.hud-settings-open'), 'Settings must be reachable from Pause').toBe(true);
    expect(visible('.hud-customize-open'), 'Customize does not belong to Pause').toBe(false);
    expect(visible('.hud-records-open'), 'Records does not belong to Pause').toBe(false);
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
      expect(settings(root).classList.contains('hud-menu-utilities--hidden'), s).toBe(true);
    }
    h.setState('main-menu');
    expect(settings(root).classList.contains('hud-menu-utilities--hidden')).toBe(false);
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

  it('has exactly ONE mute button, in Settings, and it says which state it is in', () => {
    // The pair this replaces asserted that the panel button and the topbar button
    // mirrored each other. Issue #226 removed the second one, so the obligation is no
    // longer "keep two in step" but "there is only one to keep" -- asserted by counting,
    // because a reintroduced twin is exactly the regression the count can see and a
    // single-selector assertion cannot.
    const { hud: h, root } = mount();
    h.setMuted(true);
    const buttons = Array.from(root.querySelectorAll('button')).filter((b) =>
      /^Mute|^Muted/.test(b.textContent ?? ''),
    );
    expect(buttons.length, 'a second mute control came back').toBe(1);
    expect(buttons[0].classList.contains('hud-settings-mute')).toBe(true);
    expect(buttons[0].textContent).toBe('Muted (M)');
  });

  it('the volume slider reports changes, and there is one of it', () => {
    const { hud: h, root } = mount();
    const seen: number[] = [];
    h.onVolumeChange((v) => seen.push(v));
    const sliders = root.querySelectorAll('input[type="range"]');
    expect(sliders.length, 'a second volume slider came back').toBe(1);
    const slider = sliders[0] as HTMLInputElement;
    expect(slider.classList.contains('hud-settings-volume')).toBe(true);
    slider.value = '0.2';
    slider.dispatchEvent(new Event('input'));
    expect(seen).toEqual([0.2]);
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

  it('the aim-scheme toggle lives in the Settings pane, under Controls', () => {
    // It used to ride the panel's own settings row, which showed on the Main Menu AND at
    // Pause. Since issue #226 it lives in the Settings pane, which is reachable from both
    // of those -- so the reachability claim is unchanged and its EVIDENCE moved: the
    // question is now which section holds the control, since a pane-level check cannot
    // tell "the pane is open" from "the pane is open AND still has this control in it".
    const { root } = mount();
    const toggle = root.querySelector('.hud-scheme-toggle') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    const section = toggle.closest('.hud-settings-section') as HTMLElement;
    expect(section, 'the toggle is not inside a Settings section').not.toBeNull();
    expect(section.dataset.section).toBe('controls');
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

/*
 * ISSUE #226: the Main Menu's information architecture.
 *
 * What is under test here is COMPOSITION -- which control sits in which region, and what
 * the menu says about the run it is offering to continue. The same issue's layer-stack
 * half (the replace-run confirmation, and Back out of Settings) is in
 * hud.navigation.test.ts, and its per-control half (the Settings sections, and audio
 * having one home) is in hud.controls.test.ts.
 */
describe('hud: the Main Menu hierarchy (issue #226)', () => {
  const q = (root: HTMLElement, sel: string): HTMLButtonElement =>
    root.querySelector(sel) as HTMLButtonElement;
  const summary = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-run-summary') as HTMLElement;

  it('puts every destination the issue names in the region the issue names', () => {
    // The issue body IS the specification, and this is its hierarchy read back off the
    // DOM: one dominant Campaign action, Versus and Practice as direct secondary play
    // actions, Customize/Records/Settings as compact utilities, and a compact About/Legal
    // entry. Asserted as CONTAINMENT rather than as a list of visible classes, because
    // the failure this is for is a button drifting between regions -- which every
    // per-button visibility test in this file would keep passing through.
    const { hud: h, root } = mount();
    h.setLevelSelect(2, 4);
    h.setState('main-menu');
    const regionOf = (sel: string): string | null => {
      const el = q(root, sel);
      const region = el.closest('.hud-menu-play, .hud-menu-utilities, .hud-menu-footer');
      return region === null ? null : (region.className.split(' ')[0] ?? null);
    };
    // The primary pair sits directly on the panel, in NO region -- they are the dominant
    // action, and putting them in a row would make them peers of something.
    expect(regionOf('.hud-continue'), 'Continue must not be inside a region').toBeNull();
    expect(regionOf('.hud-new-game'), 'the campaign start must not be inside a region').toBeNull();
    expect(regionOf('.hud-versus-open')).toBe('hud-menu-play');
    expect(regionOf('.hud-levelselect-open')).toBe('hud-menu-play');
    expect(regionOf('.hud-customize-open')).toBe('hud-menu-utilities');
    expect(regionOf('.hud-records-open')).toBe('hud-menu-utilities');
    expect(regionOf('.hud-settings-open')).toBe('hud-menu-utilities');
    expect(regionOf('.hud-about-open')).toBe('hud-menu-footer');
    // ...and the two play actions say what they DO. "Levels" named the pane it opened,
    // which is why a new player could not tell it from the campaign.
    expect(q(root, '.hud-levelselect-open').textContent).toBe('Practice');
    expect(q(root, '.hud-versus-open').textContent).toBe('Versus');
    expect(q(root, '.hud-continue').textContent).toBe('Continue Campaign');
  });

  it('summarises the active run above the action it describes, and only there', () => {
    // "Show only the current mission and remaining run lives needed to build confidence."
    // MAIN MENU only: pause and the outcome screens are the same panel element and
    // already say where the session stands, and during practice the two legitimately
    // disagree -- a run summary there would report the run's position over a board the
    // run did not choose.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    expect(summary(root).classList.contains('hud-run-summary--hidden'), 'no run, no line').toBe(
      true,
    );

    h.setCampaignRun({ mission: 3, total: 8, lives: 2 });
    expect(summary(root).classList.contains('hud-run-summary--hidden')).toBe(false);
    expect(summary(root).textContent).toBe('Mission 3 of 8 -- 2 lives left');

    for (const state of ['paused', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(state);
      expect(
        summary(root).classList.contains('hud-run-summary--hidden'),
        `the run summary leaked onto ${state}`,
      ).toBe(true);
    }
    h.setState('main-menu');
    expect(summary(root).classList.contains('hud-run-summary--hidden')).toBe(false);

    // ...and it goes away when the run does, rather than describing a run that ended.
    h.setCampaignRun(null);
    expect(summary(root).classList.contains('hud-run-summary--hidden')).toBe(true);
    expect(summary(root).textContent).toBe('');
  });

  it('says "1 life left", and degrades to the lives half when the mission cannot be resolved', () => {
    // Two wordings that are easy to get wrong in opposite directions. The singular is not
    // a flourish: the number is at its most alarming when it is one, and "1 lives" is
    // exactly the reading a player is least likely to trust. The null mission is the
    // honest answer for a stored level this build's campaign does not contain (see
    // `setCampaignRun`) -- inventing a position would be worse than omitting one.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.setCampaignRun({ mission: 1, total: 8, lives: 1 });
    expect(summary(root).textContent).toBe('Mission 1 of 8 -- 1 life left');
    h.setCampaignRun({ mission: null, total: 8, lives: 3 });
    expect(summary(root).textContent).toBe('3 lives left');
  });

  it('hides the summary for a versus relaunch target, exactly as Continue is hidden', () => {
    // The versus session shares the campaign run store (loop.ts's `versusAwareDeps`), so
    // a real campaign run is usually active behind a versus match. Without this the
    // versus menu would carry a campaign mission line over buttons that start a match.
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setCampaignRun({ mission: 3, total: 8, lives: 2 });
    h.setState('main-menu');
    expect(summary(root).classList.contains('hud-run-summary--hidden')).toBe(true);
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

  it('Start Campaign fires its OWN callback, distinct from onLevelSelect', () => {
    // Before issue #153 New Game reported onLevelSelect(0), indistinguishable from
    // picking level 1 in the Levels panel -- exactly the seam practice-vs-campaign
    // needed to tell apart and could not. The production change that would break this
    // is New Game firing onLevelSelect again, or firing nothing at all.
    //
    // NO ACTIVE RUN here, unlike before issue #226: with a run the same button is the
    // destructive "Start New Campaign" and opens the confirmation instead of firing --
    // which is its own test, in hud.navigation.test.ts. This is the direct path.
    const { hud: h, root } = mount();
    let newGames = 0;
    const picks: number[] = [];
    h.onNewGame(() => newGames++);
    h.onLevelSelect((i) => picks.push(i));
    h.setState('main-menu');
    newGameBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(newGames).toBe(1);
    expect(picks).toEqual([]);
  });

  it('the campaign start button is always offered at title, and says which of the two it is', () => {
    // One button, three labels (issue #226). "Start Campaign" is the primary action when
    // nothing is running; with a run active the same control becomes the tertiary "Start
    // New Campaign", and the word New is the only warning before the confirmation pane.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    expect(newGameBtn(root).classList.contains('hud-new-game--hidden')).toBe(false);
    expect(newGameBtn(root).textContent).toBe('Start Campaign');
    expect(newGameBtn(root).classList.contains('ui-btn--primary'), 'primary with no run').toBe(true);
    h.setContinueAvailable(true);
    expect(newGameBtn(root).classList.contains('hud-new-game--hidden')).toBe(false);
    expect(newGameBtn(root).textContent).toBe('Start New Campaign');
    // TERTIARY once Continue is beside it: the destructive action must not keep the
    // primary weight while the safe one is on screen.
    expect(newGameBtn(root).classList.contains('ui-btn--primary'), 'still primary with a run').toBe(
      false,
    );
    expect(newGameBtn(root).classList.contains('hud-new-game--tertiary')).toBe(true);
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
    h.setStatus(atLevel(2, 5));
    h.setState('outcome-win');
    expect(hidden(root)).toBe(false);
    expect(quitBtn(root).textContent).toBe('Main Menu');
  });

  it('hides it on the FINAL win, where the run has already ended', () => {
    // The discriminator, and the reason `s === 'win'` alone is not the condition:
    // endRun has run by then, so there is no run to return to.
    const { hud: h, root } = mount();
    h.setStatus(atLevel(5, 5));
    h.setState('outcome-win');
    expect(hidden(root)).toBe(true);
  });

  it('hides it on lose even mid-campaign', () => {
    // A loss ends the run too, so a cleared-level route out does not apply. Fails if the
    // condition widens from `s === 'win'` to "any end screen with levels left".
    const { hud: h, root } = mount();
    h.setStatus(atLevel(2, 5));
    h.setState('outcome-lose');
    expect(hidden(root)).toBe(true);
  });

  it('still says Quit to Title when paused', () => {
    // The label is per-state, not a global rename: pause keeps its own wording.
    const { hud: h, root } = mount();
    h.setStatus(atLevel(2, 5));
    h.setState('paused');
    expect(hidden(root)).toBe(false);
    expect(quitBtn(root).textContent).toBe('Quit to Title');
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
