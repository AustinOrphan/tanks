// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type GameplayOutcome, type GameplayStatus, type Hud, SINGLE_PLAYER_DEATH_VIGNETTE } from './hud';
import { isMuteHotkey, isPauseHotkey } from './loop';
import { TYPED_OUTCOME_KINDS, type TypedOutcome } from './app-state';
import { ZERO_STATS, type StatCounts } from './stats';


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

  it('keeps Quit off the MAIN MENU, offers it on every end screen, and settings off both', () => {
    // NARROWED by issue #323. This loop used to include both outcome states and assert
    // the button was hidden on all three, with the reasoning that a final win and a loss
    // have already ended the run so the panel is "verdict-only". The route out is not the
    // run's to withhold: the Main Menu is a destination either way, and hiding it left a
    // player who ran out of lives with one control that restarts the level.
    //
    // The Main Menu keeps its own exclusion for the unchanged reason -- you are already
    // there.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    expect(quit(root).classList.contains('hud-quit--hidden'), 'main-menu').toBe(true);
    for (const s of ['outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(quit(root).classList.contains('hud-quit--hidden'), s).toBe(false);
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

  it('renders one button per UNLOCKED level, and none at all for the rest (issue #555)', () => {
    // The concealment, stated where it can fail. A grid built from `total` -- which is
    // what shipped until #555 -- renders ['1', '2', '3'] here and tells a player who has
    // cleared nothing that the campaign is three levels long. Population: 3 levels, 1
    // unlocked, so the two assertions below disagree with each other under the old code.
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 3); // cleared nothing beyond level 1's unlock
    expect(buttons(root).map((b) => b.textContent)).toEqual(['1']);

    // The NEGATIVE CONTROL for "only unlocked": the same grid, fully unlocked, must draw
    // every level. Without this line a `setLevelSelect` that rendered nothing, or one
    // button, or a hard-coded `1`, would pass the assertion above.
    h.setLevelSelect(3, 3);
    expect(buttons(root).map((b) => b.textContent)).toEqual(['1', '2', '3']);

    // ...and no button is ever disabled now, because no unpickable level is drawn. This
    // is the machinery the change removed, asserted as ABSENT rather than deleted along
    // with the code: a re-added locked branch would restore the leak silently.
    expect(
      buttons(root).some((b) => b.disabled || b.classList.contains('hud-level-btn--locked')),
      'a locked level button was drawn, which is the leak this issue closed',
    ).toBe(false);
  });

  it('says whether the grid will keep growing, without saying how far it has to go', () => {
    // The completion signal, which the locked buttons used to carry implicitly: a grid
    // that has simply stopped growing cannot be told from one whose next entry has not
    // arrived. The line says which, and says it without a number -- the whole point.
    const { hud: h, root } = mount();
    const note = (): string => (root.querySelector('.hud-levels-note') as HTMLElement).textContent ?? '';

    h.setLevelSelect(2, 5);
    // "add it here", not "unlock the next": `unlocked` counts levels BEATEN, so clearing
    // one puts THAT level in this grid. The old wording described the cleared-plus-one
    // rule and would now be pointing at a button that never arrives.
    expect(note()).toBe('Clear a level to add it here.');
    // Everything cleared -- and it means that exactly, which it did not under the old
    // rule: `unlocked` reaching `total` now requires the LAST level to have fallen.
    h.setLevelSelect(5, 5);
    expect(note()).toBe('Every level cleared.');
    // ...and back, because a clear is not the only thing that repaints this grid: a
    // level system swap (dev flags, a versus system) pushes a smaller `unlocked`.
    h.setLevelSelect(2, 5);
    expect(note()).toBe('Clear a level to add it here.');
    // Never hidden. It used to be, on exactly the `unlocked >= total` state above, and
    // that is the state it now has something to say about.
    expect(
      (root.querySelector('.hud-levels-note') as HTMLElement).classList.contains(
        'hud-levels-note--hidden',
      ),
    ).toBe(false);
  });

  it('reports a click on a level, 0-based, from the last button as well as the first', () => {
    const { hud: h, root } = mount();
    const picks: number[] = [];
    h.onLevelSelect((i) => picks.push(i));
    h.setLevelSelect(2, 3);
    h.setState('main-menu');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    // Two buttons, both live. The second is the newest unlock and the one an off-by-one
    // in the render loop would either omit or leave inert.
    expect(buttons(root)).toHaveLength(2);
    buttons(root)[1].dispatchEvent(new MouseEvent('click'));
    buttons(root)[0].dispatchEvent(new MouseEvent('click'));
    expect(picks).toEqual([1, 0]);
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
      // (2, 2), not (1, 2): since issue #555 the Levels button appears once there is more
      // than one UNLOCKED level, and this test needs the button to press.
      h.setLevelSelect(2, 2);
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
    h.setLevelSelect(2, 2); // 2 unlocked -- see the offer test below for why not (1, 2)
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

  it('offers the Levels button on what is UNLOCKED, not on what the campaign holds', () => {
    // Issue #555's second half, and the one that changes a screen a new player sees. The
    // offer used to be `total > 1`, so a five-level campaign showed a Levels button from
    // the first boot -- and opening it showed the whole shape of the campaign. It is now
    // `unlocked > 1`: nothing to choose between, nothing offered.
    //
    // This is not only concealment. A pane holding exactly one button is a choice of one,
    // which the sandbox test above already refuses on the identical reasoning.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const offered = (): boolean =>
      !openBtn(root).classList.contains('hud-levelselect-open--hidden');

    h.setLevelSelect(1, 5); // fresh five-level campaign: `total > 1` would offer it
    expect(offered(), 'a fresh campaign offered a Levels pane holding one button').toBe(false);

    // The negative control, one unlock later. Without it a permanently hidden button
    // passes the assertion above.
    h.setLevelSelect(2, 5);
    expect(offered(), 'the Levels button never came back after an unlock').toBe(true);
  });

  it('is a title-screen affair, closed by any state change', () => {
    // Mirrors 'hud: achievements'' "is a title-screen affair" test: setState is the ONE
    // chokepoint that closes every panel unconditionally, so a caller cannot leave this
    // one sitting over a live game.
    const { hud: h, root } = mount();
    h.setLevelSelect(2, 2);
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
    h.setLevelSelect(1, 2); // one button
    h.setLevelSelect(2, 2); // level 1 cleared -> level 2 unlocks, so two
    // 2, not 3. Append is the failure this catches, and since issue #555 the grid GROWS
    // between these two calls, which is exactly the shape append hides in.
    expect(buttons(root)).toHaveLength(2);
    expect(buttons(root).map((b) => b.textContent)).toEqual(['1', '2']);

    // ...and it shrinks too, which append cannot do at all: a level-system swap pushes a
    // smaller `unlocked` at a grid that already drew more.
    h.setLevelSelect(1, 2);
    expect(buttons(root).map((b) => b.textContent)).toEqual(['1']);
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

    h.setCampaignRun({ mission: 3, lives: 2 });
    expect(summary(root).classList.contains('hud-run-summary--hidden')).toBe(false);
    expect(summary(root).textContent).toBe('Mission 3 -- 2 lives left');

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
    h.setCampaignRun({ mission: 1, lives: 1 });
    expect(summary(root).textContent).toBe('Mission 1 -- 1 life left');
    h.setCampaignRun({ mission: null, lives: 3 });
    expect(summary(root).textContent).toBe('3 lives left');
  });

  it('hides the summary for a versus relaunch target, exactly as Continue is hidden', () => {
    // The versus session shares the campaign run store (loop.ts's `versusAwareDeps`), so
    // a real campaign run is usually active behind a versus match. Without this the
    // versus menu would carry a campaign mission line over buttons that start a match.
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setCampaignRun({ mission: 3, lives: 2 });
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

  it('shows it on the FINAL win too, where the run has already ended', () => {
    // REVERSED by issue #323, and worth stating as a reversal. This asserted the button
    // was HIDDEN here, because "endRun has run by then, so there is no run to return to".
    // That is a true statement about the run and a wrong one about the route: it explains
    // why the Main Menu will have no Continue on it, not why the player may not go there.
    const { hud: h, root } = mount();
    h.setStatus(atLevel(5, 5));
    h.setState('outcome-win');
    expect(hidden(root)).toBe(false);
    expect(quitBtn(root).textContent).toBe('Main Menu');
  });

  it('shows it on lose, which is where its absence actually stranded people', () => {
    // Also REVERSED. The old rule left a lost campaign with exactly one control, and that
    // control restarts the level rather than leaving it -- so the menu was reachable only
    // by playing again, pausing, and quitting from there.
    const { hud: h, root } = mount();
    h.setStatus(atLevel(2, 5));
    h.setState('outcome-lose');
    expect(hidden(root)).toBe(false);
    expect(quitBtn(root).textContent).toBe('Main Menu');
  });

  it('THE GAP (issue #323): a lost campaign has a route to the Main Menu', () => {
    // Measured before the fix, not argued: at `outcome-lose` the quit button is hidden
    // and the panel's one remaining action restarts the level (`landOnCampaignBoard` in
    // loop.ts), so the only way to the Main Menu is to play again, pause, and quit from
    // there. `back` does not help either -- route-host.ts's menu-action handler acts on
    // `back` only while `sm.isPaused`.
    const { hud: h, root } = mount();
    h.setStatus(atLevel(2, 5));
    h.setState('outcome-lose');

    const reachable = [...root.querySelectorAll('button')].filter(
      (b) => b.offsetParent !== null || !b.className.includes('--hidden'),
    );
    const labels = reachable.map((b) => b.textContent?.trim());
    expect(labels, 'the outcome screen offered no way to the Main Menu').toContain('Main Menu');
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
 * ---- THE PAUSE EXIT NAMES WHAT LEAVING COSTS (issue #323) --------------------------
 *
 * The shipped button said `Quit to Title` at Pause for every session there is. That is
 * the right sentence about a campaign run -- leaving suspends one -- and the wrong one
 * about practice, where `loop.ts`'s session identity already keeps the board from
 * reading or writing the run at all. So the one surface that asks "will this cost me
 * anything?" answered the same way whether or not it would, and the reassuring case was
 * the one the wording scared the player off.
 *
 * The ACTION is untouched in all three cases -- `onQuitToTitle`, the same handler, the
 * same landing. Only the word changes, which is exactly why the negative control below
 * has to exist: a rename applied to the button rather than to the practice case would
 * satisfy the practice assertion alone.
 */
describe('hud: the pause exit is contextual (issue #323)', () => {
  const quitBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-quit') as HTMLButtonElement;

  /**
   * One status per session kind, differing in the KIND and in nothing else that this
   * button could read -- same level position, same sequence length. That is what makes
   * the campaign/versus cases below a control rather than a second scenario: if the
   * label follows anything other than the kind, the three cases are indistinguishable
   * inputs and cannot disagree.
   */
  const paused = (kind: GameplayStatus['kind']): GameplayStatus =>
    kind === 'versus'
      ? { kind, mission: 2, missions: 5, stocks: null }
      : { kind, mission: 2, missions: 5, lives: 3, enemies: 3 };

  it('offers Change Setup at Pause in a versus match, and on no other panel (issue #261)', () => {
    // The Pause twin of Choose Level. A versus match's configuration surface, reachable
    // from the match itself rather than by leaving and finding it on the menu.
    const { hud: h, root } = mount();
    const changeSetup = (): HTMLButtonElement =>
      root.querySelector('.hud-change-setup') as HTMLButtonElement;
    const offered = (): boolean => !changeSetup().classList.contains('hud-change-setup--hidden');

    h.setStatus(paused('versus'));
    h.setState('paused');
    expect(offered(), 'a paused versus match had no way back to its setup').toBe(true);

    // THE NEGATIVE CONTROLS, and they are two different mistakes. Wrong KIND: a paused
    // campaign or practice round has no versus setup to change, and the button would land
    // on a pane prefilled for a match the player is not in.
    for (const kind of ['campaign', 'practice'] as const) {
      h.setStatus(paused(kind));
      h.setState('paused');
      expect(offered(), `a paused ${kind} round offered Change Setup`).toBe(false);
    }

    // Wrong SURFACE: the versus status stays exactly as it was, and only the panel moves.
    // The end screen is issue #279's action set and already carries its own route to the
    // pane, so a second one here would put two on one panel.
    h.setStatus(paused('versus'));
    for (const surface of ['playing', 'main-menu', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(surface);
      expect(offered(), `Change Setup leaked onto ${surface}`).toBe(false);
    }
  });

  it('leaves the match before opening the setup pane, through the paths that already exist', () => {
    // The click is `handleQuit()` then `openLayer('versus-setup')`, in that order -- the
    // same shape Choose Level uses. The ORDER is what this pins, by reading the pane's own
    // visibility from inside the quit callback: reversing the two would sit a
    // configuration surface over a live match, and that reading is the only moment the
    // difference is observable, since both orders settle to the same final state.
    //
    // A recorder over two CALLBACKS would not do it. `handleChangeSetup` opens the layer
    // directly rather than through the menu button's handler, so `onVersusOpen` never
    // fires on this path -- measured, after an earlier version of this test claimed an
    // ordered pair of events and was really asserting one event and a final state.
    const { hud: h, root } = mount();
    const pane = (): HTMLElement => root.querySelector('.hud-versus-setup') as HTMLElement;
    const paneOpen = (): boolean => !pane().classList.contains('hud-versus-setup--hidden');
    let quits = 0;
    let paneOpenWhenQuitFired: boolean | null = null;
    h.onQuitToTitle(() => {
      quits += 1;
      paneOpenWhenQuitFired = paneOpen();
    });
    h.setStatus(paused('versus'));
    h.setState('paused');
    (root.querySelector('.hud-change-setup') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));

    expect(quits, 'Change Setup never left the match').toBe(1);
    expect(paneOpenWhenQuitFired, 'the setup pane was opened over a live match').toBe(false);
    expect(paneOpen(), 'the match was left but the setup pane never opened').toBe(true);
  });

  it('never paints the Main Menu on the way to the setup pane (issue #566)', () => {
    // THE MIDPOINT IS THE CLAIM, not the settled state. Settled, the pane is open and the
    // panel is hidden whether or not this bug is present -- which is exactly why 235 HUD
    // tests passed over it. The flash is one crossfade long, so it has to be read at the
    // instant the handler returns, before any transition settles.
    //
    // What used to happen: `handleChangeSetup` called `handleQuit()`, that reached
    // `setState('main-menu')` synchronously through the quit subscribers, and `setState`
    // switched the panel on because the route said Main Menu. The pane's own transition
    // then faded it away. TANKS! and all six menu buttons, painted on the way to a
    // destination the player asked for directly.
    const { hud: h, root } = mount();
    const panelHidden = (): boolean =>
      (root.querySelector('.hud-panel') as HTMLElement).classList.contains('hud-panel--hidden');
    // A quit subscriber, because that is what makes the flash reachable: without one,
    // `handleQuit` reaches no `setState` and the bug cannot occur in the fixture.
    h.onQuitToTitle(() => h.setState('main-menu'));
    h.setStatus(paused('versus'));
    h.setState('paused');
    expect(panelHidden(), 'the pause panel should be up before this starts').toBe(false);

    (root.querySelector('.hud-change-setup') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));

    // Read IMMEDIATELY. No timer advance: this is the frame the Main Menu used to appear in.
    expect(
      panelHidden(),
      'the Main Menu was painted between leaving the match and opening the pane',
    ).toBe(true);

    // ...and the handoff is not a permanent suppression. A plain Quit still wants the menu,
    // so the flag must be clear by the time anything else asks. Without this the "fix"
    // could be a panel that never comes back, which is a far worse bug than the flash.
    h.setState('main-menu');
    expect(panelHidden(), 'the Main Menu never came back after the handoff').toBe(false);
  });

  it('reopens the setup a player CHOSE, not a fresh one (issue #261)', () => {
    // THE GAP, proven before this test existed: replacing `handleChangeSetup`'s reopen
    // with `seedAndRenderVersus(<a hardcoded default config>)` -- the pane forgetting
    // every selection the player made -- passed all 1833 tests in `src/game/`. The
    // sibling case above proves the pane OPENS and proves the ORDER; nothing asserted
    // what the pane opened onto, which is the half the criterion is actually about
    // ("Change Setup: return to retained VS Setup").
    //
    // Driven through the pane's own controls rather than a seeded store, so this reads
    // what a player would see: they pick, they start, they pause, they change setup.
    const { hud: h, root } = mount();
    const pick = (row: string, attr: string, value: string): void => {
      (root.querySelector(`.hud-versus-${row}-row [data-${attr}="${value}"]`) as HTMLButtonElement)
        .dispatchEvent(new MouseEvent('click'));
    };
    const chosen = (row: string, attr: string): string | null => {
      const on = root.querySelector(
        `.hud-versus-${row}-row [aria-pressed="true"]`,
      ) as HTMLElement | null;
      return on?.getAttribute(`data-${attr}`) ?? null;
    };

    h.setState('main-menu');
    h.showVersusSetup(true);
    pick('mode', 'mode', 'teams');
    pick('players', 'players', '4');
    pick('stock', 'stock', '5');
    expect([chosen('mode', 'mode'), chosen('players', 'players'), chosen('stock', 'stock')])
      .toEqual(['teams', '4', '5']);

    // Into the match, then Pause, then Change Setup.
    h.setStatus(paused('versus'));
    h.setState('paused');
    (root.querySelector('.hud-change-setup') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));

    expect(
      [chosen('mode', 'mode'), chosen('players', 'players'), chosen('stock', 'stock')],
      'Change Setup reopened a pane that had forgotten the match it came from',
    ).toEqual(['teams', '4', '5']);

    // THE NEGATIVE CONTROL: the three readings are not simply whatever the pane defaults
    // to. A pane hardcoded to teams/4/5 would satisfy every assertion above, so the same
    // helpers have to be able to read a DIFFERENT selection through the same path.
    pick('mode', 'mode', 'ffa');
    pick('players', 'players', '2');
    expect([chosen('mode', 'mode'), chosen('players', 'players')]).toEqual(['ffa', '2']);
  });

  it('reads End Practice at Pause, where "quit to title" would overstate the cost', () => {
    const { hud: h, root } = mount();
    h.setStatus(paused('practice'));
    h.setState('paused');
    // Visible as well as relabelled: the route out of a paused session is PR #563's and
    // issue #226's, and this change is only allowed to rename it.
    expect(quitBtn(root).classList.contains('hud-quit--hidden')).toBe(false);
    expect(quitBtn(root).textContent).toBe('End Practice');
  });

  it('names the destination at Pause wherever one can be named, and keeps the generic word where it cannot', () => {
    // THE NEGATIVE CONTROL for both contextual arms. Without it, writing `End Practice`
    // or `Main Menu` unconditionally -- or keying either on something the other session
    // merely happens to have -- passes the tests above.
    //
    // Campaign keeps `Quit to Title`: a run genuinely IS being left, which is the one
    // case the generic wording is true for. A null status is a session that has not
    // stated its kind, where the generic word is the only honest one.
    //
    // Versus reads `Main Menu` since issue #261, whose contract is "do not expose a
    // generic Quit action when a specific destination can be named". It shares the
    // campaign run store but writes nothing to it, so `Quit to Title` described a cost
    // that is not being paid. This case previously asserted `Quit to Title` and deferred
    // to issue #279 -- a mis-read, since #279 is the RESULTS screen and Pause is #261's.
    const { hud: h, root } = mount();
    const labelWith = (status: GameplayStatus | null): string => {
      h.setStatus(status);
      h.setState('paused');
      return quitBtn(root).textContent ?? '';
    };
    expect(labelWith(paused('campaign'))).toBe('Quit to Title');
    expect(labelWith(null)).toBe('Quit to Title');
    // The two contextual readings, through the same driver, so all four are a
    // disagreement this panel can actually express and not a constant.
    expect(labelWith(paused('versus'))).toBe('Main Menu');
    expect(labelWith(paused('practice'))).toBe('End Practice');
  });

  it('leaves every practice END screen reading Main Menu, not End Practice', () => {
    // The arms are ordered, and this is the assertion that pins the order. A practice
    // level that is OVER is an end screen, and issue #323's action set for it names Main
    // Menu -- there is no session left to end. A practice arm placed ahead of the outcome
    // arm would relabel both endings and quietly undo PR #563's wording.
    const { hud: h, root } = mount();
    h.setStatus(paused('practice'));
    for (const s of ['outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(quitBtn(root).textContent, s).toBe('Main Menu');
      expect(quitBtn(root).classList.contains('hud-quit--hidden'), s).toBe(false);
    }
  });
});

/*
 * ---- EVERY ENDING GETS ITS OWN SCREEN (issue #323) --------------------------------
 *
 * The issue's finding, restated as a fixture: before this, four endings shared two
 * screens. A campaign that ran out of lives and a practice level that ran out of lives
 * both read `Game Over` / `Out of lives.` over a button saying `Retry`; a campaign
 * completed to its last level and a practice level beaten both read `You Win!` /
 * `Arena cleared.` over `Play Again`. The panel had no way to tell them apart because
 * nothing ever told it -- it was handed a two-valued win/lose surface and nothing else.
 *
 * These drive the panel exactly the way production does: `setState` opens the surface,
 * then `setOutcome` lands the session's own `TypedOutcome` on it. The ordering is not
 * incidental and one case below asserts it directly.
 */
describe('hud: every ending gets its own screen (issue #323)', () => {
  const title = (root: HTMLElement): string =>
    (root.querySelector('.hud-title') as HTMLElement).textContent ?? '';
  const subtitle = (root: HTMLElement): string =>
    (root.querySelector('.hud-subtitle') as HTMLElement).textContent ?? '';
  const action = (root: HTMLElement): string =>
    (root.querySelector('.hud-action') as HTMLElement).textContent ?? '';
  const chooseLevel = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-choose-level') as HTMLButtonElement;
  const chooseLevelShown = (root: HTMLElement): boolean =>
    !chooseLevel(root).classList.contains('hud-choose-level--hidden');

  /** A solo campaign-shaped outcome push carrying the session's own ending. */
  const push = (typedOutcome: TypedOutcome, run?: StatCounts): GameplayOutcome => ({
    tally: 'solo',
    attempt: ZERO_STATS,
    // Absent unless a case asks for it, mirroring production: `pushOutcome` resolves a run
    // total only for the two endings that finish a run, so `undefined` is the shape every
    // other screen really receives rather than a fixture convenience.
    ...(run ? { run } : {}),
    action: 'campaign-levels',
    typedOutcome,
  });

  /**
   * The surface the page would be on for an ending, from the SAME projection production
   * uses (`legacyOutcomePresentation`, restated here as the fixture's own two lines so a
   * change to that function shows up as a failure rather than being followed silently).
   */
  const surfaceFor = (outcome: TypedOutcome): 'outcome-win' | 'outcome-lose' => {
    if (outcome.kind === 'campaign-over') return 'outcome-lose';
    if (outcome.kind === 'practice-result' && !outcome.cleared) return 'outcome-lose';
    return 'outcome-win';
  };

  /** Drive the panel to an ending the way production does: surface first, outcome after. */
  const drive = (h: Hud, outcome: TypedOutcome, run?: StatCounts): void => {
    h.setState(surfaceFor(outcome));
    h.setOutcome(push(outcome, run));
  };

  const MISSION_CLEAR: TypedOutcome = { kind: 'mission-clear' };
  const CAMPAIGN_OVER: TypedOutcome = { kind: 'campaign-over' };
  const CAMPAIGN_COMPLETE: TypedOutcome = { kind: 'campaign-complete' };
  const PRACTICE_WON: TypedOutcome = { kind: 'practice-result', cleared: true };
  const PRACTICE_LOST: TypedOutcome = { kind: 'practice-result', cleared: false };

  it('heads the tally "Level attempt" on EVERY ending, because that is what it counts', () => {
    // SUPERSEDES 'keeps the word "run" off a practice ending'. That test pinned the
    // practice half of this rule and used the campaign half as its negative control --
    // "a line hardcoded to This level would relabel every campaign ending too". Issue
    // #322's owner ruling is that relabelling them is CORRECT, so the control had to be
    // replaced rather than relaxed; the new one is below.
    //
    // The line is wrong about its DATA, not merely loose: `stats.attempt()` is zeroed on
    // every world build (stats.ts names this exact wording as the ambiguity issue #153
    // asks to remove), so these numbers are one try at one level. A campaign ending
    // saying "This run" pointed at the campaign attempt the player has going elsewhere,
    // which is the one thing they are not.
    //
    // "Level attempt", not the "This level" that briefly replaced "This run": the two
    // campaign endings now carry a SECOND line naming the campaign run, and once both
    // scopes share a screen the labels have to be built the same way to read as a pair.
    const { hud: h, root } = mount();
    h.setStatus(atLevel(3, 5));
    const summary = (): string =>
      (root.querySelector('.hud-attempt-summary') as HTMLElement).textContent ?? '';

    for (const [name, outcome] of [
      ['practice-lost', PRACTICE_LOST],
      ['practice-won', PRACTICE_WON],
      ['campaign-over', CAMPAIGN_OVER],
      ['mission-clear', MISSION_CLEAR],
      ['campaign-complete', CAMPAIGN_COMPLETE],
    ] as const) {
      drive(h, outcome);
      expect(summary(), `${name} did not head its tally with the level attempt`).toMatch(
        /^Level attempt:/,
      );
      expect(summary(), `${name} still called a per-attempt tally a run`).not.toMatch(/\brun\b/);
    }

    // THE NEGATIVE CONTROL, third attempt, and the failures are the interesting part.
    //
    // It first read `mission-clear`'s subtitle ("Your run carries on..."), on the theory
    // that the word "run" must survive where it is true. An owner ruling cut that
    // subtitle. It then moved to the replace-run confirmation, which says "run" only in a
    // FALLBACK branch no shipped page reaches. It then asserted that Records still said
    // "Current attempt" while these screens said "Level attempt" -- and a later ruling
    // unified those two deliberately, so "the labels differ" stopped being true.
    //
    // What is left is the distinction that actually matters: on a campaign ending the two
    // LINES name different scopes, and a refactor that hoisted one shared label for both
    // -- the obvious tidy-up now that both are built by `tallyLineEl` -- would make the
    // screen report the same words twice over different numbers.
    drive(h, CAMPAIGN_COMPLETE, {
      shotsFired: 100, shellKills: 31, mineKills: 4, deaths: 7, selfKills: 1,
      friendlyFireKills: 0, minesLaid: 12, wallsDestroyed: 40, ricochets: 9,
    });
    const attemptLine = (root.querySelector('.hud-attempt-summary') as HTMLElement).textContent ?? '';
    const runLine = (root.querySelector('.hud-run-tally') as HTMLElement).textContent ?? '';
    expect(attemptLine).toMatch(/^Level attempt:/);
    expect(runLine, 'both lines were built from one shared label').toMatch(/^Campaign run:/);
  });

  it('reports the whole campaign run beside the level attempt, on the two endings that finish one', () => {
    // The pair, in the order they are read. Two scopes on one screen is the point: a bare
    // number leaves the player guessing which one it is, so both are named.
    const { hud: h, root } = mount();
    h.setStatus(atLevel(5, 5));
    const lines = (): Array<string | null> => [
      (root.querySelector('.hud-attempt-summary') as HTMLElement).textContent,
      (root.querySelector('.hud-run-tally') as HTMLElement).classList.contains('hud-run-tally--hidden')
        ? null
        : (root.querySelector('.hud-run-tally') as HTMLElement).textContent,
    ];
    const RUN = { shotsFired: 100, shellKills: 31, mineKills: 4, deaths: 7, selfKills: 1,
      friendlyFireKills: 0, minesLaid: 12, wallsDestroyed: 40, ricochets: 9 };

    for (const outcome of [CAMPAIGN_COMPLETE, CAMPAIGN_OVER] as const) {
      drive(h, outcome, RUN);
      const [attempt, run] = lines();
      expect(attempt, 'the level attempt line went missing').toMatch(/^Level attempt:/);
      expect(run, `${outcome.kind} carried no campaign total`).toMatch(/^Campaign run:/);
      // The two lines are DIFFERENT readings, not the same numbers twice -- which is what
      // a payload wired to `attempt` for both would produce.
      expect(run).toContain('35 kills'); // 31 shell + 4 mine, from RUN
      expect(attempt).not.toContain('35 kills');
    }

    // THE NEGATIVE CONTROL, and the reason the HUD hides this line by ABSENCE rather than
    // by naming screens: an ending with no run behind it must not show a campaign total.
    // `mission-clear` is the sharp case -- it IS campaign play, and it is mid-run, so a
    // gate written as "is this a campaign session" instead of "did this end a run" shows
    // a running total on every level.
    for (const outcome of [MISSION_CLEAR, PRACTICE_WON, PRACTICE_LOST] as const) {
      drive(h, outcome);
      expect(lines()[1], `${outcome.kind} reported a campaign run that has not ended`).toBeNull();
      expect(lines()[0], 'the level attempt line went with it').toMatch(/^Level attempt:/);
    }
  });

  it('gives each campaign and practice ending its own copy and its own action', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(3, 5); // a real level choice exists, so Choose Level is not withheld
    h.setStatus(atLevel(3, 5));

    // The tuple carries BOTH secondary controls (issue #323 added the second). Reading only
    // `chooseLevelShown` would have let `Practice This Level` appear on every ending, or on
    // none, without a single line of this file changing -- and this is the test that exists
    // to say which screen offers what.
    const practiceShown = (r: HTMLElement): boolean =>
      !(r.querySelector('.hud-practice-level') as HTMLElement).classList
        .contains('hud-practice-level--hidden');
    const screen = (outcome: TypedOutcome): string[] => {
      drive(h, outcome);
      return [
        title(root), subtitle(root), action(root),
        String(chooseLevelShown(root)), String(practiceShown(root)),
      ];
    };

    // NO SUBTITLE on any of them, by owner ruling, arrived at over three separate rulings
    // rather than as a policy. Each line restated the headline, the action button or the
    // topbar: "Your run carries on, with the lives you have left." over a topbar showing
    // the lives and a button reading Next Level; "Out of lives. This run is over." over
    // "Game Over"; "Every level cleared. This run is finished." directly under "Campaign
    // Complete!".
    expect(screen(MISSION_CLEAR)).toEqual(['Level 3 cleared!', '', 'Next Level', 'false', 'true']);
    expect(screen(CAMPAIGN_OVER)).toEqual(['Game Over', '', 'Start New Campaign', 'false', 'false']);
    expect(screen(CAMPAIGN_COMPLETE)).toEqual([
      'Campaign Complete!',
      '',
      'Start New Campaign',
      'false',
      'false',
    ]);
    // The last column is `Practice This Level`, and it is TRUE on exactly one screen. A
    // practice ending already offers Retry, which replays the same level -- offering
    // "practice this level" from inside practice would be the same button twice under two
    // names. Mission Clear is the only ending where the level just played and the mode the
    // player is in differ, which is the whole reason the control exists (issue #323).
    //
    // The practice endings name the LEVEL and carry no subtitle (owner ruling). They said
    // "Practice Cleared"/"Practice Failed" over a topbar chip already reading PRACTICE,
    // and a subtitle promising the campaign run was safe -- reassurance that mostly
    // raised the doubt it answered.
    expect(screen(PRACTICE_WON)).toEqual(['Level Cleared', '', 'Retry', 'true', 'false']);
    expect(screen(PRACTICE_LOST)).toEqual(['Level Failed', '', 'Retry', 'true', 'false']);
  });

  it('Practice This Level leaves the run, then reports the level just cleared (issue #323)', () => {
    // WHAT THIS OWNS: that the button reports the RIGHT level through the RIGHT seam, in
    // the right order. What a level-select report then DOES -- reassign the identity to
    // practice, build with fresh independent lives, never touch the run -- is `loop.ts`'s,
    // and is already pinned there ("practice lands on the picked level and leaves the run
    // untouched"). Reusing that seam rather than adding one is what makes that split hold.
    const { hud: h, root } = mount();
    const picks: number[] = [];
    let quits = 0;
    let quitsWhenPicked: number | null = null;
    h.onQuitToTitle(() => { quits += 1; });
    h.onLevelSelect((level) => { picks.push(level); quitsWhenPicked = quits; });
    h.setLevelSelect(3, 5);
    h.setStatus(atLevel(3, 5));
    drive(h, MISSION_CLEAR);

    (root.querySelector('.hud-practice-level') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));

    // THE OFF-BY-ONE IS THE CONTROL. The screen says "Level 3 cleared!" and the callback
    // indexes `deps.levels.levels`, so the right answer is 2 and the plausible wrong one is
    // 3 -- which would practise level FOUR, silently, from a screen naming level three. An
    // assertion on "a pick happened" would pass on that.
    expect(picks, 'the level just cleared was not reported, or was reported twice').toEqual([2]);
    // ORDER, because `loop.ts` guards the level-select handler on `sm.atMainMenu`: reporting
    // the pick before leaving the run has it dropped on the floor and nothing happens.
    expect(quits, 'the run was never left').toBe(1);
    expect(quitsWhenPicked, 'the pick was reported before the run was left').toBe(1);
  });

  it('offers Practice This Level on NO other ending, and not without a level to name', () => {
    const { hud: h, root } = mount();
    const shown = (): boolean =>
      !(root.querySelector('.hud-practice-level') as HTMLElement).classList
        .contains('hud-practice-level--hidden');
    h.setLevelSelect(3, 5);

    // No status pushed: there is no level to practise, so the button must not offer to.
    // Every css and gallery fixture is in exactly this state, and a button that appeared
    // there would do nothing when pressed -- `handlePracticeThisLevel` returns early.
    drive(h, MISSION_CLEAR);
    expect(shown(), 'offered with no level to name').toBe(false);

    h.setStatus(atLevel(3, 5));
    drive(h, MISSION_CLEAR);
    expect(shown(), 'not offered on the one ending it belongs to').toBe(true);

    // ...and on NO OTHER ending, which is what this test is named for and what it did not
    // actually check until a mutation said so: dropping the table term from the gate left
    // every other case here passing, because they all turn on the other two terms. A
    // campaign game-over did not clear the level, and the two practice endings already
    // offer Retry -- which replays the same level, so this would be that button twice.
    for (const ending of [CAMPAIGN_OVER, CAMPAIGN_COMPLETE, PRACTICE_WON, PRACTICE_LOST]) {
      drive(h, ending);
      expect(shown(), 'offered on an ending that is not Mission Clear').toBe(false);
    }

    // ...and withheld when the session has no level choice at all -- a sandbox or a
    // one-level system, whose Main Menu already hides the Practice entry. Same gate as
    // Choose Level, and asserted here because the two flags are independent.
    h.setLevelSelect(0, 1);
    drive(h, MISSION_CLEAR);
    expect(shown(), 'offered on a session with no practice to offer').toBe(false);
  });

  it('THE GAP (issue #323): no two endings render as the same screen any more', () => {
    // The shipped state, measured rather than argued: a campaign game-over and a failed
    // practice level were byte-identical panels (`Game Over` / `Out of lives.` / `Retry`),
    // and a campaign completion and a cleared practice level were the other one
    // (`You Win!` / `Arena cleared.` / `Play Again`). That is the whole of the issue's
    // complaint about these screens.
    //
    // This is the sweep the per-ending case above cannot be: it fails on ANY collapse,
    // including one introduced by a later edit that makes two entries agree, without
    // naming which strings are involved.
    const { hud: h, root } = mount();
    h.setLevelSelect(3, 5);
    h.setStatus(atLevel(3, 5));

    const screens = [MISSION_CLEAR, CAMPAIGN_OVER, CAMPAIGN_COMPLETE, PRACTICE_WON, PRACTICE_LOST]
      .map((outcome) => {
        drive(h, outcome);
        return { title: title(root), whole: `${title(root)} | ${subtitle(root)} | ${action(root)}` };
      });
    const whole = screens.map((s) => s.whole);
    expect(new Set(whole).size, whole.join('\n')).toBe(whole.length);
    // ...and the HEADLINES on their own, which is the stronger half and the one the
    // issue's complaint is actually about. Two endings that differ only in the word on a
    // button are still two screens a player reads as the same verdict -- and it was
    // measured that the whole-screen comparison above does NOT catch that on its own:
    // giving the practice failure the campaign game-over's headline and line left the
    // triples distinct, because their actions still differed.
    const titles = screens.map((s) => s.title);
    expect(new Set(titles).size, titles.join('\n')).toBe(titles.length);
  });

  it('keeps the VERSUS result screen OUT of the copy table, and gives it the #279 action set', () => {
    // The negative control for the table: a versus ending has no entry in it and must
    // still render the legacy win/lose copy. A transcription of that screen into
    // OUTCOME_PANEL would pass the per-ending case above and fail here the moment it
    // drifted.
    //
    // The ACTION is `Rematch` since issue #279, not the `Versus Setup` this test pinned
    // before -- and Change Setup now stands beside it, which is what makes renaming the
    // primary action honest rather than a relabel of a trip to the pane.
    const { hud: h, root } = mount();
    h.setLevelSelect(3, 5);
    const versus = (result: TypedOutcome): GameplayOutcome => ({
      tally: 'ffa', attempt: ZERO_STATS, action: 'versus-setup',
      kills: [1, 0], deaths: [0, 1], shots: [4, 4], shellKills: [1, 0], typedOutcome: result,
    });

    h.setState('outcome-win');
    h.setOutcome(versus({ kind: 'vs-match-end', result: { kind: 'winner-slot', slot: 0 } }));
    // NAMES THE WINNER (owner ruling): "You Win!" / "Arena cleared." is campaign language
    // on a local versus screen -- there is no arena to clear, and the "you" may well be
    // the player who lost. The typed outcome already carries who won, so the screen says
    // it, and the subtitle goes the way the campaign endings' did.
    expect(title(root)).toBe('Player 1 wins');
    expect(subtitle(root)).toBe('');
    expect(action(root)).toBe('Rematch');
    expect(chooseLevelShown(root), 'a versus match never chose a level to be on').toBe(false);
    expect(
      root.querySelector('.hud-change-setup')!.classList.contains('hud-change-setup--hidden'),
      'the versus result screen offered no way back to the setup',
    ).toBe(false);

    // A draw presents as a defeat, which is the shipped behaviour for the simultaneous
    // -elimination `lose` event -- see legacyOutcomePresentation's own doc comment.
    // A draw presents on the LOSE surface (the simultaneous-elimination `lose` event, see
    // `legacyOutcomePresentation`) but is not a defeat and no longer says so.
    h.setState('outcome-lose');
    h.setOutcome(versus({ kind: 'vs-match-end', result: { kind: 'draw' } }));
    expect(title(root)).toBe('Draw');
    expect(subtitle(root)).toBe('');

    // ...and a TEAMS win names the side, not a player: the same result type carries both,
    // and a screen that read `slot` for a team outcome would name a player who may not
    // even have been the last one standing.
    h.setState('outcome-win');
    h.setOutcome(versus({ kind: 'vs-match-end', result: { kind: 'winner-team', team: 1 } }));
    expect(title(root)).toBe('Team 2 wins');
    expect(action(root)).toBe('Rematch');
    expect(chooseLevelShown(root)).toBe(false);
    expect(
      root.querySelector('.hud-change-setup')!.classList.contains('hud-change-setup--hidden'),
    ).toBe(false);
  });

  it('keeps the pre-#323 wording when no ending has been pushed at all', () => {
    // Every css and gallery fixture is this HUD, and so is the instant between the state
    // machine flipping and the session's own push landing. Both must read as the panel
    // always did rather than as an empty table lookup.
    const { hud: h, root } = mount();
    h.setStatus(atLevel(5, 5));
    h.setState('outcome-win');
    expect(title(root)).toBe('You Win!');
    expect(action(root)).toBe('Play Again');
    h.setState('outcome-lose');
    expect(title(root)).toBe('Game Over');
    expect(action(root)).toBe('Retry');
    expect(chooseLevelShown(root)).toBe(false);
  });

  it('replaces the opening copy when the ending lands AFTER the panel is already up', () => {
    // PRODUCTION'S OWN ORDER, asserted as an order. `state.ts` flips to the outcome phase
    // inside `stateMachine.onEvents`, and `loop.ts` pushes the outcome from
    // `onFrameEvents`, which `driver.ts` runs immediately afterwards -- so `setState`
    // always opens the panel before the kind that explains it arrives. A `setOutcome`
    // that repainted only the tally lines would leave a campaign game-over reading
    // `Retry` under `Out of lives.` for the rest of the screen's life.
    const { hud: h, root } = mount();
    h.setStatus(atLevel(4, 5));
    h.setState('outcome-lose');
    expect(title(root), 'the opening frame is the legacy copy').toBe('Game Over');
    expect(action(root)).toBe('Retry');

    h.setOutcome(push(CAMPAIGN_OVER));
    // The repaint is visible in BOTH directions here: the legacy line is cleared (the
    // ruled copy for this ending has no subtitle) and the action is rewritten. Asserting
    // only the action would let a repaint that touched buttons and left stale prose
    // behind pass.
    expect(subtitle(root), 'the legacy subtitle survived the repaint').toBe('');
    expect(action(root)).toBe('Start New Campaign');
  });

  it('offers Choose Level on the practice endings and nowhere else', () => {
    // The population is every outcome kind, from the model's own list, so a sixth kind
    // added later arrives here unanswered rather than defaulting quietly into one arm.
    const { hud: h, root } = mount();
    h.setLevelSelect(3, 5);
    // Every ENDING of every kind, since the two that carry a payload have more than one
    // -- a practice level ends two ways and the button must follow the kind, not the
    // verdict. The cast is only for the three kinds whose whole content is their name;
    // the two with payloads are spelled out above it and never reach it.
    const offeredBy: string[] = [];
    for (const kind of TYPED_OUTCOME_KINDS) {
      const endings: TypedOutcome[] =
        kind === 'practice-result'
          ? [PRACTICE_WON, PRACTICE_LOST]
          : kind === 'vs-match-end'
            ? [{ kind: 'vs-match-end', result: { kind: 'winner-slot', slot: 0 } }]
            : [{ kind } as TypedOutcome];
      for (const ending of endings) {
        drive(h, ending);
        if (chooseLevelShown(root) && !offeredBy.includes(kind)) offeredBy.push(kind);
      }
    }
    expect(offeredBy).toEqual(['practice-result']);

    // ...and every surface that is not an end screen keeps it off, including the pause
    // panel a player reaches from the level they went on to play.
    drive(h, PRACTICE_LOST);
    expect(chooseLevelShown(root)).toBe(true);
    for (const s of ['paused', 'main-menu', 'playing', 'launch'] as const) {
      h.setState(s);
      expect(chooseLevelShown(root), s).toBe(false);
    }
  });

  it('withholds Choose Level from a session with no level to choose', () => {
    // The second half of the gate, and not redundant with the first: the SANDBOX ends as
    // a `practice-result` (it is a practice-kind session), and its one synthetic level is
    // exactly the case for which the Main Menu already hides the Practice entry into the
    // same pane. Offering the button here would land the player on a menu with nothing
    // behind it.
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 1); // one level: no choice to make
    drive(h, PRACTICE_LOST);
    expect(chooseLevelShown(root)).toBe(false);

    // NEGATIVE CONTROL, and it also pins the live half: an unlock recorded at the win
    // event repaints the grid while this panel is already up, and the button must follow
    // that push rather than wait for the next surface change.
    h.setLevelSelect(2, 4);
    expect(chooseLevelShown(root)).toBe(true);
  });

  it('leaves the finished session and opens the Levels pane, in that order', () => {
    // Choose Level is Main Menu followed by Practice, through the two paths those
    // controls already use -- `loop.ts` acts on a level pick only from the Main Menu, so
    // a pane opened over the end screen would look right and do nothing on the click that
    // matters. The order is the assertion: the quit must have been dispatched before the
    // pane is on screen.
    const { hud: h, root } = mount();
    h.setLevelSelect(3, 5);
    const paneHidden = (): boolean =>
      (root.querySelector('.hud-levelselect') as HTMLElement).classList.contains(
        'hud-levelselect--hidden',
      );
    // RECORDED, never asserted from inside the callback: jsdom swallows a throw from an
    // event listener and reports it on the window instead of propagating it out of
    // `click()`, so an `expect` in here passes the test whatever it finds. Measured --
    // an earlier draft of this case asserted in the callback and stayed green with the
    // two calls in `handleChooseLevel` swapped, which is the exact mutation it exists to
    // kill.
    let quits = 0;
    let paneWasHiddenAtQuit: boolean | null = null;
    h.onQuitToTitle(() => {
      quits += 1;
      paneWasHiddenAtQuit = paneHidden();
    });
    drive(h, PRACTICE_LOST);
    chooseLevel(root).click();
    expect(quits, 'Choose Level did not leave the session at all').toBe(1);
    expect(paneWasHiddenAtQuit, 'the pane opened before the session was left').toBe(true);
    expect(paneHidden(), 'the pane never opened').toBe(false);
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
