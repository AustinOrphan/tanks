/**
 * The semantic actions a menu-time input device produces (issues #319 and #494).
 *
 * Keyboard, gamepad, pointer and touch all end in ONE of these -- or in a direct call to
 * the same handler the action would reach -- so a screen is written once against the
 * vocabulary rather than once per device. Directional actions move the focus of the
 * active panel spatially (`hud.ts`'s `act` over `game/spatial-focus.ts`, issue #495),
 * `confirm` activates the focused control, `back`
 * pops one layer (`Hud.back()`), and `pause` toggles the page's state machine exactly as
 * the Pause button's tap does. The gameplay half of the input system is untouched:
 * `input.ts` and `gamepad.ts` keep producing `InputState`, never a `UiAction`.
 */
export type UiAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'pause';

/** Every action, in the order a single poll emits them when several arrive together. */
export const UI_ACTIONS: readonly UiAction[] = ['up', 'down', 'left', 'right', 'confirm', 'back', 'pause'];

/**
 * The keyboard half of the vocabulary: a `KeyboardEvent.key` (any case) to the action it
 * names, or null for a key that is not a menu action. W/S ride with the vertical arrows
 * because `hud.ts`'s roving focus has always accepted them; A/D are deliberately absent
 * -- with nothing open they drive the tank, and a menu that claimed them would need a
 * container check the arrows already provide. Enter and Space are listed for
 * completeness of the vocabulary, but the HUD never dispatches a keyboard `confirm`: the
 * browser's native activation of the focused button IS the confirm handler for a
 * keyboard, and claiming the key would only duplicate it.
 */
export function keyToUiAction(rawKey: string): UiAction | null {
  const key = rawKey.toLowerCase();
  switch (key) {
    case 'arrowup':
    case 'w':
      return 'up';
    case 'arrowdown':
    case 's':
      return 'down';
    case 'arrowleft':
      return 'left';
    case 'arrowright':
      return 'right';
    case 'enter':
    case ' ':
    case 'spacebar':
      return 'confirm';
    case 'escape':
      return 'back';
    case 'p':
      return 'pause';
    default:
      return null;
  }
}

// Text entry claims EVERY key: a 'w' typed into a field is a 'w', never a throttle.
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time',
]);

/** True when `el` sits inside a control that takes free text (textarea, contenteditable, a text-like input). */
export function isTextEntry(el: HTMLElement): boolean {
  const field = el.closest('textarea,[contenteditable],input');
  if (field === null) return false;
  if (!(field instanceof HTMLInputElement)) return true; // textarea / contenteditable
  return TEXT_INPUT_TYPES.has(field.type.toLowerCase());
}

// A widget claims only the keys it actually operates on. A button activates on Space and
// Enter and nothing else -- the arrows are the roving focus's, which is how a keyboard
// walks from one menu button to the next. A slider or select also adjusts on the arrows
// and Home/End.
const WIDGET_SELECTOR = 'input,button,select,[contenteditable],textarea';
const BUTTON_KEYS = new Set([' ', 'spacebar', 'enter']);
const ADJUSTABLE_KEYS = new Set([
  ' ', 'spacebar', 'enter', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'home', 'end',
]);

/**
 * The ONE rule for "does the focused control keep this key" (issue #494): true when the
 * event target should consume the key instead of the game or a menu acting on it.
 *
 * The rule this replaced asked whether ANY interactive element had focus, which is not
 * the same question. `e.target` on a KeyboardEvent is the FOCUSED element, and clicking
 * the mute button or dragging the volume slider leaves it focused -- so after touching
 * either one, every keystroke was discarded and the tank was undriveable until the
 * player happened to click the canvas again. Nothing on screen explained why.
 *
 * Split by what the focused element genuinely needs: text entry takes everything, a
 * slider or select takes the keys that adjust it (Space/Enter, the arrows, Home/End),
 * and a button takes only Space and Enter. So WASD keeps driving with the slider
 * focused, the slider keeps responding to arrow keys for anyone navigating by keyboard,
 * the arrows walk from one focused menu button to the next, and Escape, P and M --
 * which no widget consumes -- always reach the game. `input.ts`, the session's hotkey
 * guards in `loop.ts` and the HUD's roving-focus handler all ask this function, so a
 * control cannot be "native" to one of them and transparent to another. (The rule this
 * unified let a button keep the arrows in `input.ts` alone; shared with the roving
 * handler that would have frozen keyboard navigation on the first focused button.)
 */
export function consumesKey(target: EventTarget | null, rawKey: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (isTextEntry(target)) return true;
  const widget = target.closest(WIDGET_SELECTOR);
  if (widget === null) return false;
  const key = rawKey.toLowerCase();
  return widget instanceof HTMLButtonElement ? BUTTON_KEYS.has(key) : ADJUSTABLE_KEYS.has(key);
}
