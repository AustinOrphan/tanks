import type { InputState, Vec2 } from '../sim/types';

export interface InputController {
  sample(): InputState;
  /**
   * Drop latched fire/mine presses WITHOUT releasing held movement keys. For pause:
   * the driver stops sampling, and only sample() resets these latches, so a Space
   * pressed while hotkey-paused would mine on the first tick after resume. Held
   * movement stays held on purpose -- the key is physically still down.
   */
  clearQueuedPresses(): void;
  dispose(): void;
}

export function createInputController(
  target: HTMLElement,
  screenToGround: (clientX: number, clientY: number) => Vec2,
): InputController {
  const keys = new Set<string>();
  let aim: Vec2 = { x: 0, y: 0 };
  let firePressed = false;
  let minePressed = false;

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
  const onMouseMove = (e: MouseEvent): void => {
    aim = screenToGround(e.clientX, e.clientY);
  };
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) firePressed = true;
    else if (e.button === 2) minePressed = true;
  };
  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };
  // Focus loss eats the keyup: alt-tab while holding W and the OS delivers that
  // keyup to the other window, leaving 'w' held forever and the tank driving
  // north until the player thinks to press and release W again.
  const releaseAll = (): void => {
    keys.clear();
    firePressed = false;
    minePressed = false;
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

  function readMove(): Vec2 {
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

  return {
    sample(): InputState {
      const state: InputState = {
        move: readMove(),
        aim,
        fire: firePressed,
        mine: minePressed,
      };
      firePressed = false;
      minePressed = false;
      return state;
    },
    clearQueuedPresses(): void {
      firePressed = false;
      minePressed = false;
    },
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('mousemove', onMouseMove);
      target.removeEventListener('mousedown', onMouseDown);
      target.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
