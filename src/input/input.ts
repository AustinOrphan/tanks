import type { InputState, Vec2 } from '../sim/types';
import {
  stickVector,
  touchSide,
  isTap,
  isDoubleTap,
  AIM_PROJECTION_UNITS,
  AIM_GRID,
  type TouchIndicator,
  type TouchScheme,
  type TouchSample,
  type FireMode,
} from './touch';
import { createGamepadReader, readNavigatorGamepads, type GamepadReader, type GetGamepads } from './gamepad';
export type { TouchIndicator, TouchScheme, FireMode } from './touch';

export interface InputController {
  sample(): InputState;
  /**
   * The thumbs, for the HUD to draw. Read-only and outside `sample()` on purpose: see
   * TouchIndicator.
   */
  touchIndicator(): TouchIndicator;
  /**
   * Drop latched fire/mine presses WITHOUT releasing held movement keys. For pause:
   * the driver stops sampling, and only sample() resets these latches, so a Space
   * pressed while hotkey-paused would mine on the first tick after resume. Held
   * movement stays held on purpose -- the key is physically still down.
   */
  clearQueuedPresses(): void;
  /**
   * Latch a mine, as the Space key does.
   *
   * A touch device has no Space and no right mouse button, so the on-screen button in
   * the HUD is the only way to lay one. It goes through the SAME latch rather than
   * reaching into the sim, so a mine tapped is indistinguishable from a mine keyed --
   * including being consumed by the next sample() and cleared by clearQueuedPresses().
   */
  pressMine(): void;
  /**
   * Latch a shot, as the left mouse button does.
   *
   * Touch aiming does NOT fire -- see TouchScheme. A phone has no trigger, so the shot
   * is an on-screen button, and it goes through the SAME latch as every other fire path
   * so a tapped shot is indistinguishable from a clicked one.
   */
  pressFire(): void;
  /**
   * Which scheme the right thumb is using. Changing it drops any aim gesture in flight,
   * so a thumb held across the switch cannot carry stale meaning into the new scheme.
   */
  setTouchScheme(scheme: TouchScheme): void;
  /**
   * How the aim thumb pulls the trigger. The FIRE button works in every mode -- these
   * add a gesture rather than replacing it.
   */
  setFireMode(mode: FireMode): void;
  /**
   * The player's WORLD position, pushed each frame by the loop.
   *
   * The aim STICK needs it: `InputState.aim` is a point, so a direction has to be
   * projected from somewhere, and the tank is the only sensible origin. World, not
   * screen -- the input layer never learns where anything is drawn. `null` when there is
   * no player, in which case the stick simply holds its last aim.
   */
  setPlayerPosition(pos: Vec2 | null): void;
  /**
   * Whether gamepad[0] is present, as of the last `sample()`. Read-only and outside
   * `sample()` on purpose, same reasoning as `touchIndicator()`: a HUD affordance (a
   * "gamepad connected" toast) wants to poll this every frame without perturbing the
   * input stream `step()` consumes. Always `false` when the `gamepad` option was not
   * passed to `createInputController` -- the reader is never even constructed then, so
   * this cannot report state that was never read.
   */
  gamepadConnected(): boolean;
  dispose(): void;
}

export function createInputController(
  target: HTMLElement,
  screenToGround: (clientX: number, clientY: number) => Vec2,
  options: { gamepad?: boolean; getGamepads?: GetGamepads } = {},
): InputController {
  const keys = new Set<string>();
  let aim: Vec2 = { x: 0, y: 0 };
  let firePressed = false;
  let minePressed = false;
  /**
   * `?dev=1&gamepad=1` (issue #114). `null` when the option is off, which is the whole
   * gate: `sample()` below only ever touches `navigator.getGamepads` through this, so
   * "off" means the reader is never even constructed, not merely that its output is
   * discarded.
   */
  const gamepadReader: GamepadReader | null = options.gamepad
    ? createGamepadReader(options.getGamepads ?? readNavigatorGamepads)
    : null;

  // Keydown is bound at the window, so it also sees events bubbling out of the
  // HUD's own controls. Driving the tank from those -- and worse, calling
  // preventDefault on them -- makes the volume slider and mute button
  // keyboard-inoperable: Right Arrow would strafe instead of moving the slider,
  // Space would drop a mine instead of activating the button.
  // Text entry claims EVERY key: a 'w' typed into a field is a 'w', never a throttle.
  const TEXT_INPUT_TYPES = new Set([
    'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time',
  ]);
  const isTextEntry = (el: HTMLElement): boolean => {
    const field = el.closest('textarea,[contenteditable],input');
    if (field === null) return false;
    if (!(field instanceof HTMLInputElement)) return true; // textarea / contenteditable
    return TEXT_INPUT_TYPES.has(field.type.toLowerCase());
  };
  // A widget like a button, slider or select claims only the keys it actually operates on.
  const isWidget = (el: HTMLElement): boolean =>
    el.closest('input,button,select,[contenteditable],textarea') !== null;
  const WIDGET_KEYS = new Set([
    ' ', 'spacebar', 'enter', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'home', 'end',
  ]);

  /**
   * True if the focused element should swallow this key instead of the tank driving on it.
   *
   * The old rule rejected the key whenever ANY interactive element had focus, which is not
   * the same question. e.target on a KeyboardEvent is the FOCUSED element, and clicking the
   * mute button or dragging the volume slider leaves it focused -- so after touching either
   * one, every keystroke was discarded and the tank was undriveable until the player
   * happened to click the canvas again. Nothing on screen explained why.
   *
   * Split by what the focused element genuinely needs: text entry takes everything, while a
   * button or slider only takes the keys that operate it (Space/Enter to activate, arrows to
   * adjust). So WASD keeps driving with the slider focused, and the slider keeps responding
   * to arrow keys for anyone navigating by keyboard. The HUD also drops focus after a
   * pointer interaction, which returns the arrow keys to the tank for mouse players.
   */
  const swallowsKey = (t: EventTarget | null, key: string): boolean => {
    if (!(t instanceof HTMLElement)) return false;
    if (isTextEntry(t)) return true;
    return isWidget(t) && WIDGET_KEYS.has(key);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (swallowsKey(e.target, e.key.toLowerCase())) return;
    const k = e.key.toLowerCase();
    // Prevent the browser's default scroll behavior for keys the game uses
    // (Space would otherwise scroll the page; arrow keys too).
    if (k === ' ' || k === 'spacebar' || k.startsWith('arrow')) {
      e.preventDefault();
    }
    keys.add(k);
    if (!e.repeat && (k === ' ' || k === 'spacebar')) minePressed = true;
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.key.toLowerCase());
  };
  /**
   * When the last touch happened, so the COMPATIBILITY mouse events a browser
   * synthesises afterwards can be ignored.
   *
   * This is not defensive: measured on a Pixel 5, one tap in the aiming half put TWO
   * shells in flight (3 of 3 taps), and one tap in the DRIVING half fired a shell at
   * all (3 of 3) -- aimed at the player's own thumb, because the compat `mousemove`
   * reaches the window-bound handler and drags `aim` there. The burst lands ~200ms
   * after `touchend`, well past the 0.4s fire cooldown for any real hold.
   *
   * A time window rather than a permanent "this is a touch device" latch, because a
   * laptop with a touchscreen has both and must keep both.
   */
  let lastTouchAt = -Infinity;
  const TOUCH_COMPAT_MS = 700;
  const isCompatMouse = (): boolean => performance.now() - lastTouchAt < TOUCH_COMPAT_MS;

  const onMouseMove = (e: MouseEvent): void => {
    if (isCompatMouse()) return;
    aim = screenToGround(e.clientX, e.clientY);
  };
  const onMouseDown = (e: MouseEvent): void => {
    if (isCompatMouse()) return;
    if (e.button === 0) firePressed = true;
    else if (e.button === 2) minePressed = true;
  };
  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  // ---- Touch: left thumb drives, right thumb aims. NEITHER fires. ------------------
  //
  // Pointer events rather than touch events, so one code path covers finger, stylus and
  // any future pen -- filtered to non-mouse so the existing mouse handling above is
  // untouched. Tracked BY pointerId because both thumbs are down at once and the browser
  // interleaves their moves; `setPointerCapture` is deliberately not used (jsdom does not
  // implement it, and window-level move/up tracking survives a thumb sliding off the
  // canvas, which capture is only one way to achieve).
  //
  // `aim` is a WORLD POINT, not an angle. Under `point` that is the spot the thumb is
  // over, unprojected exactly as the mouse is. Under `stick` it is projected out in
  // front of the tank along the pushed direction -- which needs the player's WORLD
  // position, pushed in by the loop, and never its screen position: the input layer does
  // not learn where anything is drawn.
  /**
   * The width the left/right split is measured against. Read fresh on every touch, not
   * captured: a phone rotated mid-round would otherwise keep splitting at the old
   * midpoint, and the driving thumb would suddenly be aiming.
   */
  const viewportWidth = (): number => window.innerWidth;

  let stickPointer: number | null = null;
  let stickOrigin: Vec2 = { x: 0, y: 0 };
  let stickCurrent: Vec2 = { x: 0, y: 0 };
  let stickMove: Vec2 = { x: 0, y: 0 };
  let aimPointer: number | null = null;
  let aimPoint: Vec2 | null = null;
  let aimOrigin: Vec2 = { x: 0, y: 0 };
  let touchUsed = false;
  let scheme: TouchScheme = 'stick';
  let fireMode: FireMode = 'tap';
  /** The aim thumb's press, held until release so the gesture can be classified. */
  let aimDownAt = 0;
  let aimDownPos: Vec2 = { x: 0, y: 0 };
  /** The last completed tap on the aim side, for double-tap detection. */
  let lastAimTap: TouchSample | null = null;
  /**
   * Set when the game stops consuming input mid-gesture, so the touch in flight cannot
   * become a shot. Cleared by the next press, which is a gesture the player made with
   * the game actually running.
   */
  let aimGestureVoid = false;
  let playerPos: Vec2 | null = null;

  /**
   * Turn the aim thumb's gesture into the world point `InputState.aim` carries.
   *
   * `point`: unproject the spot under the thumb, exactly as the mouse does.
   * `stick`: project a point out in front of the tank along the pushed direction. The
   * stick's own vector is reused, so the dead zone and clamping behave identically to
   * the driving stick -- inside the dead zone the aim simply HOLDS rather than snapping
   * back, because a turret that recentres itself when the thumb rests is unusable.
   */
  const applyAimGesture = (): void => {
    if (aimPoint === null) return;
    if (scheme === 'point') {
      aim = screenToGround(aimPoint.x, aimPoint.y);
      return;
    }
    if (playerPos === null) return;
    const dir = stickVector(aimOrigin, aimPoint);
    if (dir.x === 0 && dir.y === 0) return; // inside the dead zone: hold the last aim
    const len = Math.hypot(dir.x, dir.y);
    aim = {
      x: playerPos.x + (dir.x / len) * AIM_PROJECTION_UNITS,
      y: playerPos.y + (dir.y / len) * AIM_PROJECTION_UNITS,
    };
  };

  const isTouch = (e: PointerEvent): boolean => e.pointerType !== 'mouse';

  const onPointerDown = (e: PointerEvent): void => {
    if (!isTouch(e)) return;
    lastTouchAt = performance.now();
    touchUsed = true;
    // Suppress the compatibility mouse events this touch would otherwise synthesise.
    // Measured in Chromium: the burst goes from ["mousemove","mousedown"] to []. This is
    // the deterministic half; `isCompatMouse` is the backstop.
    //
    // Be honest about that backstop: forcing `isCompatMouse` to false and leaving this
    // line alone still measures 0 stray shells, so IN CHROMIUM THE CLOCK NEVER FIRES.
    // It is kept because its whole value rests on an engine that cannot be tested from
    // here -- iOS Safari, which has its own history with compatibility events -- and
    // because the failure it backstops is the one that shipped. Deleting it wants a
    // measurement on real iOS Safari, not an inference from Chromium.
    if (e.cancelable) e.preventDefault();
    if (touchSide(e.clientX, viewportWidth()) === 'move') {
      // First thumb down on the left wins; a second one there is ignored rather than
      // stealing the stick mid-drive.
      if (stickPointer !== null) return;
      stickPointer = e.pointerId;
      stickOrigin = { x: e.clientX, y: e.clientY };
      stickCurrent = { x: e.clientX, y: e.clientY };
      stickMove = { x: 0, y: 0 };
    } else {
      if (aimPointer !== null) return; // first aiming thumb wins, as on the left
      aimPointer = e.pointerId;
      aimOrigin = { x: e.clientX, y: e.clientY };
      aimPoint = { x: e.clientX, y: e.clientY };
      aimDownAt = performance.now();
      aimDownPos = { x: e.clientX, y: e.clientY };
      aimGestureVoid = false; // a fresh press, made while the game was running
      applyAimGesture();
      // DELIBERATELY NO FIRE HERE. Aiming and firing used to be this one gesture, and
      // that made re-aiming dangerous: with the turret facing a nearby wall, the touch
      // that began a new aim put a shell into it, and the ricochet came back into the
      // player's own tank. Firing is `pressFire()`, from a button the player presses on
      // purpose.
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!isTouch(e)) return;
    lastTouchAt = performance.now();
    if (e.pointerId === stickPointer) {
      stickCurrent = { x: e.clientX, y: e.clientY };
      stickMove = stickVector(stickOrigin, stickCurrent);
    } else if (e.pointerId === aimPointer) {
      aimPoint = { x: e.clientX, y: e.clientY };
      applyAimGesture();
    }
  };

  const onPointerEnd = (e: PointerEvent): void => {
    if (!isTouch(e)) return;
    // Stamped on END too, and that is the load-bearing one: the compat burst arrives
    // AFTER the finger lifts.
    lastTouchAt = performance.now();
    if (e.pointerId === stickPointer) {
      stickPointer = null;
      stickMove = { x: 0, y: 0 };
    } else if (e.pointerId === aimPointer) {
      // Classify the gesture that just ended, BEFORE clearing it.
      //
      // `pointercancel` lands here too, and deliberately counts the same: the browser
      // taking the gesture is not the player's doing, and a cancelled touch is not a
      // shot they asked for -- but it also must not leave a half-tap primed to pair with
      // the next one, so it goes through the same bookkeeping and resets the pair.
      const ended: TouchSample = {
        downAt: aimDownAt,
        upAt: performance.now(),
        from: aimDownPos,
        to: { x: e.clientX, y: e.clientY },
      };
      // A gesture the game did not see the whole of is treated exactly like a cancelled
      // one: it cannot fire, and it cannot prime the next pair.
      const cancelled = e.type === 'pointercancel' || aimGestureVoid;
      if (!cancelled && fireMode === 'tap' && isTap(ended)) {
        firePressed = true;
      } else if (!cancelled && fireMode === 'double' && isDoubleTap(lastAimTap, ended)) {
        firePressed = true;
        lastAimTap = null; // a completed double does not begin the next one
      } else {
        lastAimTap = cancelled ? null : ended;
      }
      aimPointer = null;
      aimPoint = null;
    }
    // NOTE: lifting the aim thumb does NOT recentre or clear `aim`. The turret keeps the
    // heading it was given, which is what lets the player line a shot up, let go, and
    // then press Fire.
  };
  // Focus loss eats the keyup: alt-tab while holding W and the OS delivers that
  // keyup to the other window, leaving 'w' held forever and the tank driving
  // north until the player thinks to press and release W again.
  const releaseAll = (): void => {
    keys.clear();
    firePressed = false;
    minePressed = false;
    // A thumb is as capable of being lost as a key: switch apps mid-drive and the
    // pointerup is delivered to whatever comes next, leaving the stick held forever and
    // the tank driving into a wall until the player thinks to touch and lift again.
    stickPointer = null;
    aimPointer = null;
    aimPoint = null;
    stickMove = { x: 0, y: 0 };
    lastAimTap = null;
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') releaseAll();
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', onVisibilityChange);
  // Aim tracks at the window, not the canvas: the HUD overlay sets
  // pointer-events:auto and would otherwise swallow mousemove, freezing the
  // turret whenever the cursor crossed the audio controls.
  window.addEventListener('mousemove', onMouseMove);
  target.addEventListener('mousedown', onMouseDown);
  target.addEventListener('contextmenu', onContextMenu);
  // DOWN on the canvas so the HUD's own buttons keep their taps -- the overlay is
  // pointer-events:none except on controls, so an empty stretch of HUD falls through to
  // here. MOVE and UP at the window, so a thumb that slides off the canvas mid-drive
  // keeps steering and still releases cleanly.
  target.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);

  /**
   * Precedence, most to least specific: TOUCH stick (a deliberate gesture in flight) >
   * GAMEPAD stick (outside its dead zone, so `gamepadMove` is non-zero) > keyboard.
   * Never summed, same reasoning as touch-over-keyboard above: a stray held key must not
   * drag an analogue stick off-axis, and the same now applies to a gamepad's stick.
   */
  function readMove(gamepadMove: Vec2 | null): Vec2 {
    // The thumbstick wins while it is held. Not summed with the keys: nobody drives with
    // both, and summing would let a stray held key drag an analogue stick off-axis with
    // nothing on screen to explain it.
    if (stickPointer !== null) return stickMove;
    if (gamepadMove !== null && (gamepadMove.x !== 0 || gamepadMove.y !== 0)) return gamepadMove;
    let x = 0;
    let y = 0;
    if (keys.has('a') || keys.has('arrowleft')) x -= 1;
    if (keys.has('d') || keys.has('arrowright')) x += 1;
    // The sim's +y is SOUTH on screen: render maps world y to three's z, and the camera
    // sits at +z looking back, so growing y walks toward the viewer -- down the screen.
    // W therefore has to DECREASE y. It did the opposite, and w drove the tank backwards;
    // measured before the fix, holding w moved the player 65px DOWN a 600px viewport.
    if (keys.has('w') || keys.has('arrowup')) y -= 1;
    if (keys.has('s') || keys.has('arrowdown')) y += 1;
    return { x, y };
  }

  /**
   * Snaps a point to the `AIM_GRID` -- applied ONCE, here, at the boundary all four aim
   * producers (mouse, touch point, touch stick, gamepad) converge into. `Math.round(NaN
   * / g) * g` and the `Infinity` case both stay non-finite, so `driveTank`'s existing
   * `Number.isFinite` guard on `aimDir` (`world.ts`) still catches an unlaid-out-canvas
   * NaN exactly as before -- quantization does not reopen that bug.
   */
  function quantizeAim(v: Vec2): Vec2 {
    return {
      x: Math.round(v.x / AIM_GRID) * AIM_GRID,
      y: Math.round(v.y / AIM_GRID) * AIM_GRID,
    };
  }

  return {
    sample(): InputState {
      // Polled HERE, once per call -- the driver calls sample() once per SIMULATED tick
      // (see driver.ts), never on its own rAF loop, so this is exactly one hardware read
      // per tick, no more. A multi-tick catch-up frame polls the same live hardware state
      // several times in a row, which is why the reader's fire/mine edge detection lives
      // inside the reader (a button held across three polls must fire once, not three
      // times) rather than here.
      let gp: ReturnType<GamepadReader['poll']> | null = null;
      if (gamepadReader !== null) {
        gp = gamepadReader.poll(playerPos);
        // Fire/mine OR into the same latches every other source uses (keyboard, mouse,
        // touch, the HUD's own buttons) -- gamepad is simply one more producer of the
        // same edge, not a replacement path, so no extra precedence rule is needed here.
        if (gp.fire) firePressed = true;
        if (gp.mine) minePressed = true;
        // Aim precedence, mirroring readMove's: an IN-FLIGHT touch aim thumb
        // (aimPointer) beats the gamepad -- review proved the unguarded version
        // overwrote a live touch gesture every tick. Against the MOUSE the stick wins
        // while deflected, deliberately: holding a stick off centre is as deliberate as
        // a gesture, there is no discrete in-flight marker to arbitrate with, and the
        // moment it recentres gp.aim goes null so the next mousemove owns aim again.
        // Both halves pinned in input.test.ts's gamepad block.
        if (gp.aim !== null && aimPointer === null) aim = gp.aim;
      }
      const state: InputState = {
        move: readMove(gp?.move ?? null),
        aim: quantizeAim(aim),
        fire: firePressed,
        mine: minePressed,
      };
      firePressed = false;
      minePressed = false;
      return state;
    },
    touchIndicator(): TouchIndicator {
      return {
        stick:
          stickPointer === null
            ? null
            : {
                originX: stickOrigin.x,
                originY: stickOrigin.y,
                x: stickCurrent.x,
                y: stickCurrent.y,
              },
        aim:
          aimPoint === null
            ? null
            : { originX: aimOrigin.x, originY: aimOrigin.y, x: aimPoint.x, y: aimPoint.y },
        scheme,
        used: touchUsed,
      };
    },
    clearQueuedPresses(): void {
      firePressed = false;
      minePressed = false;
      // The touch half of the same problem, and it is NOT covered by the two latches
      // above. The window-level pointer listeners keep running while the driver has
      // stopped calling sample(), so a thumb lifted during a pause would latch a shot
      // that sits unconsumed until the first sample() after resume -- fired at nothing,
      // with the turret wherever it was left. The keyboard version of this bug is why
      // this method exists at all.
      //
      // The gesture in flight is VOIDED rather than released: the thumb may still be
      // physically down, and dropping `aimPointer` would stop it steering the turret on
      // resume, which is the same mistake as releasing a held movement key.
      lastAimTap = null;
      if (aimPointer !== null) aimGestureVoid = true;
    },
    pressMine(): void {
      minePressed = true;
    },
    pressFire(): void {
      firePressed = true;
    },
    setFireMode(next: FireMode): void {
      if (next === fireMode) return;
      fireMode = next;
      lastAimTap = null; // a half-finished double must not survive the switch
    },
    setTouchScheme(next: TouchScheme): void {
      if (next === scheme) return;
      scheme = next;
      // Drop any aim gesture in flight: a thumb held across the switch would otherwise
      // be read as a stick origin that was never placed as one.
      aimPointer = null;
      aimPoint = null;
      lastAimTap = null;
    },
    setPlayerPosition(pos: Vec2 | null): void {
      playerPos = pos === null ? null : { x: pos.x, y: pos.y };
    },
    gamepadConnected(): boolean {
      return gamepadReader !== null && gamepadReader.connected();
    },
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('mousemove', onMouseMove);
      target.removeEventListener('mousedown', onMouseDown);
      target.removeEventListener('contextmenu', onContextMenu);
      target.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      gamepadReader?.dispose();
    },
  };
}
