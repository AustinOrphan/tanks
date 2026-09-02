/**
 * Menu-time gamepad input (issue #494): the union of every connected pad, read on the
 * page's frame loop for the life of the page and turned into `UiAction`s. The poll never
 * stops: `route-host.ts` gates the DISPATCH instead (only `pause` while a session
 * simulates), so a button held across Pause/Resume stays "held" here and does not read
 * as a fresh press on the other side.
 *
 * Deliberately NOT `createGamepadReader`. That reader is a gameplay collaborator: one per
 * slot, polled once per simulated tick, carrying the fire/mine edge state the sim depends
 * on. A menu must never share that state -- a Confirm consumed here would otherwise be a
 * shell on the first tick of play -- so this poller owns its own per-action edge state and
 * `loop.ts` resyncs the gameplay readers on every entry into play (`resyncGamepad`).
 *
 * The union, not `pad[i] -> slot[i]`: whichever pad is in a hand should drive the menu,
 * and two players both pressing Down should move focus once, not twice.
 */
import type { GetGamepads, GamepadLike } from './gamepad';
import { UI_ACTIONS, type UiAction } from './ui-actions';

/**
 * Standard-mapping button indices. 0 and 1 are the same face buttons `gamepad.ts` reads
 * as fire and mine -- A/Cross confirms and B/Circle backs out, the console convention --
 * which is exactly why the resync in `loop.ts` exists. 9 is Start (Options), 12-15 the
 * D-pad in the mapping's up/down/left/right order.
 */
export const MENU_CONFIRM_BUTTON = 0;
export const MENU_BACK_BUTTON = 1;
export const MENU_PAUSE_BUTTON = 9;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;
const STICK_X = 0;
const STICK_Y = 1;

/**
 * How far the left stick must travel before it counts as a menu direction. Wider than
 * `GAMEPAD_DEADZONE` on purpose: a menu wants a deliberate push, not the first few
 * percent past drift, and only the dominant axis counts so a diagonal never emits two
 * directions at once. Feel, not measurement.
 */
export const MENU_STICK_THRESHOLD = 0.5;

/**
 * Key-repeat for the four directions: one move on the press, a pause, then a steady walk
 * while held. The numbers are the desktop convention (roughly the OS keyboard repeat)
 * and tuned by feel. Confirm, Back and Pause never repeat -- a held A must not activate
 * every control it lands on.
 */
export const MENU_REPEAT_DELAY_MS = 400;
export const MENU_REPEAT_INTERVAL_MS = 130;

export interface GamepadMenuPoller {
  /**
   * One read of every pad, at page-frame time `now` (milliseconds, any monotonic clock).
   * Emits through the `onAction` callback, in `UI_ACTIONS` order when several arrive in
   * one frame. A no-op after `dispose()`.
   */
  poll(now: number): void;
  /** True when the last poll saw at least one pad. */
  connected(): boolean;
  /** Drops every held edge and stops emitting. Nothing else to release: no listeners, no timers. */
  dispose(): void;
}

function actionsDown(pad: GamepadLike, into: Set<UiAction>): void {
  const pressed = (i: number): boolean => pad.buttons[i]?.pressed ?? false;
  if (pressed(DPAD_UP)) into.add('up');
  if (pressed(DPAD_DOWN)) into.add('down');
  if (pressed(DPAD_LEFT)) into.add('left');
  if (pressed(DPAD_RIGHT)) into.add('right');
  if (pressed(MENU_CONFIRM_BUTTON)) into.add('confirm');
  if (pressed(MENU_BACK_BUTTON)) into.add('back');
  if (pressed(MENU_PAUSE_BUTTON)) into.add('pause');
  const x = pad.axes[STICK_X] ?? 0;
  const y = pad.axes[STICK_Y] ?? 0;
  if (Math.abs(y) >= Math.abs(x)) {
    if (y <= -MENU_STICK_THRESHOLD) into.add('up');
    else if (y >= MENU_STICK_THRESHOLD) into.add('down');
  } else if (x <= -MENU_STICK_THRESHOLD) into.add('left');
  else if (x >= MENU_STICK_THRESHOLD) into.add('right');
}

/**
 * @param getGamepads Injected like every other reader here, so jsdom tests drive menus
 * through a fake and the one production site passes `readNavigatorGamepads`.
 */
export function createGamepadMenuPoller(
  getGamepads: GetGamepads,
  onAction: (action: UiAction) => void,
): GamepadMenuPoller {
  /** Actions currently held across the union of pads, with the time their next repeat is due. */
  const held = new Map<UiAction, number>();
  let cachedConnected = false;
  let disposed = false;

  return {
    poll(now: number): void {
      if (disposed) return;
      let pads: ArrayLike<GamepadLike | null | undefined>;
      try {
        pads = getGamepads() ?? [];
      } catch {
        pads = []; // a throwing implementation is a permanently-empty one -- see gamepad.ts
      }
      const down = new Set<UiAction>();
      let any = false;
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        if (pad == null) continue;
        any = true;
        actionsDown(pad, down);
      }
      cachedConnected = any;
      for (const action of UI_ACTIONS) {
        if (!down.has(action)) {
          held.delete(action);
          continue;
        }
        const due = held.get(action);
        if (due === undefined) {
          // The press edge. Directions arm a repeat; the three one-shots never fire again
          // until released.
          const repeats = action === 'up' || action === 'down' || action === 'left' || action === 'right';
          held.set(action, repeats ? now + MENU_REPEAT_DELAY_MS : Infinity);
          onAction(action);
        } else if (now >= due) {
          held.set(action, now + MENU_REPEAT_INTERVAL_MS);
          onAction(action);
        }
      }
    },
    connected(): boolean {
      return cachedConnected;
    },
    dispose(): void {
      disposed = true;
      held.clear();
      cachedConnected = false;
    },
  };
}
