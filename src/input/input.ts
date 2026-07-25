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

  const onKeyDown = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === ' ' || k === 'spacebar') minePressed = true;
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

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  target.addEventListener('mousemove', onMouseMove);
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
      target.removeEventListener('mousemove', onMouseMove);
      target.removeEventListener('mousedown', onMouseDown);
      target.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
