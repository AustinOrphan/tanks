import type { InputState, Vec2 } from '../sim/types';

export interface InputController {
  sample(): InputState;
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
  const isInteractive = (t: EventTarget | null): boolean =>
    t instanceof HTMLElement && t.closest('input,button,select,textarea,[contenteditable]') !== null;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isInteractive(e.target)) return;
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
    if (keys.has('w') || keys.has('arrowup')) y += 1;
    if (keys.has('s') || keys.has('arrowdown')) y -= 1;
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
