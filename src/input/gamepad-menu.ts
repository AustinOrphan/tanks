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
import {
  STANDARD_PROFILE,
  classifyPad,
  createEffectiveProfileReader,
  profileFor,
  recommendedLayouts,
  type ControlProfile,
  type LayoutLookup,
} from './gamepad-profile';
import { UI_ACTIONS, type UiAction } from './ui-actions';

/**
 * Standard-mapping button indices. A/Cross confirms and B/Circle backs out, the console
 * convention. 9 is Start (Options), 12-15 the D-pad in the mapping's up/down/left/right
 * order.
 *
 * These are now DISJOINT from the buttons `gamepad.ts` reads as fire and mine, which moved
 * to the triggers so a twin-stick player need not leave the aim stick to shoot. They used
 * to be the same two buttons, which is why the resync in `loop.ts` was written -- a Resume
 * confirmed with A leaked a shell into the first simulated tick. That overlap is gone; the
 * resync stays for the held-trigger case, and `gamepad-menu.test.ts` pins the separation so
 * a future rebinding cannot quietly restore the collision.
 */
export const MENU_CONFIRM_BUTTON = STANDARD_PROFILE.buttons.confirm;
export const MENU_BACK_BUTTON = STANDARD_PROFILE.buttons.back;
export const MENU_PAUSE_BUTTON = STANDARD_PROFILE.buttons.pause;

/*
 * DERIVED, not restated (issue #596). The D-pad and stick indices that used to sit here as
 * their own constants are the standard profile's, and `actionsDown` below reads whatever
 * profile `classifyPad` resolved for the pad in hand rather than these -- a pad this
 * catalogue does not recognize emits no menu action at all. The three exports above remain
 * because `route-host.ts` and the tests name them; deriving them is what stops "the standard
 * profile's confirm" and "the button the menu reads on a standard pad" becoming two numbers.
 *
 * The disjointness above is now MACHINE-CHECKED rather than merely observed:
 * `profileCollisions` in `gamepad-profile.ts` refuses any catalogue profile that puts a menu
 * action on the fire or mine button, which is the #494 collision stated as a rule instead of
 * as a comment.
 */

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

function actionsDown(pad: GamepadLike, profile: ControlProfile, into: Set<UiAction>): void {
  const pressed = (i: number): boolean => pad.buttons[i]?.pressed ?? false;
  if (pressed(profile.buttons.up)) into.add('up');
  if (pressed(profile.buttons.down)) into.add('down');
  if (pressed(profile.buttons.left)) into.add('left');
  if (pressed(profile.buttons.right)) into.add('right');
  if (pressed(profile.buttons.confirm)) into.add('confirm');
  if (pressed(profile.buttons.back)) into.add('back');
  if (pressed(profile.buttons.pause)) into.add('pause');
  const x = pad.axes[profile.axes.moveX] ?? 0;
  const y = pad.axes[profile.axes.moveY] ?? 0;
  if (Math.abs(y) >= Math.abs(x)) {
    if (y <= -MENU_STICK_THRESHOLD) into.add('up');
    else if (y >= MENU_STICK_THRESHOLD) into.add('down');
  } else if (x <= -MENU_STICK_THRESHOLD) into.add('left');
  else if (x >= MENU_STICK_THRESHOLD) into.add('right');
}

/**
 * @param getGamepads Injected like every other reader here, so jsdom tests drive menus
 * through a fake and the one production site passes `readNavigatorGamepads`.
 * @param layoutFor The player's layout for a profile id (issue #754). Confirm, Back and Pause
 * follow its bindings, and the navigation stick follows the movement stick, so Southpaw moves
 * menu navigation to the stick that drives the tank. The D-pad never moves. Defaults to every
 * profile as it ships.
 */
export function createGamepadMenuPoller(
  getGamepads: GetGamepads,
  onAction: (action: UiAction) => void,
  layoutFor: LayoutLookup = recommendedLayouts,
): GamepadMenuPoller {
  const effective = createEffectiveProfileReader(layoutFor);
  /** Actions currently held across the union of pads, with the time their next repeat is due. */
  const held = new Map<UiAction, number>();
  /**
   * How each pad was read on the previous poll, by `getGamepads()` index, as the values of its
   * effective mapping (issue #754).
   *
   * A layout edit can move an action onto a button that is ALREADY down -- the Controller Layout
   * pane does it on every capture, since the button just chosen is still held. `held` is kept per
   * action, so that button would read as a new press of its new action on the next poll: Back
   * moved onto X closes the pane while X is still down. A poll on which any pad's mapping changed
   * therefore ADOPTS a newly down action as held instead of dispatching it, the menu's form of
   * the gameplay reader's #494 resync. The cost: a genuinely new press landing on that same poll
   * is adopted too, and needs pressing again.
   *
   * Values, not object identity: the effective reader caches one entry, so pads of two profiles
   * would hand back a fresh object on every poll and every press would be adopted.
   */
  let lastMappings = new Map<number, string>();
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
      const mappings = new Map<number, string>();
      let remapped = false;
      let any = false;
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        if (pad == null) continue;
        // PRESENT COUNTS, READABLE IS SEPARATE (issue #596). `any` is set for every pad the
        // browser reports, unsupported ones included, because `connected()` answers "is there
        // a pad" for the connect toast and issue #597's visible-but-unsupported state -- a
        // refused pad that reported as absent would be indistinguishable from no hardware.
        // What it does NOT do is contribute actions: a pad whose layout is unknown cannot
        // have its button 0 read as Confirm, which on a differently-laid-out device is a
        // menu activating itself.
        any = true;
        const profile = profileFor(classifyPad(pad));
        if (profile === null) continue;
        const read = effective(profile);
        const mapping = `${read.id}|${Object.values(read.buttons).join(',')}|${Object.values(read.axes).join(',')}`;
        mappings.set(i, mapping);
        const before = lastMappings.get(i);
        if (before !== undefined && before !== mapping) remapped = true;
        actionsDown(pad, read, down);
      }
      lastMappings = mappings;
      cachedConnected = any;
      for (const action of UI_ACTIONS) {
        if (!down.has(action)) {
          held.delete(action);
          continue;
        }
        const due = held.get(action);
        if (due === undefined && remapped) {
          // Down only because the mapping moved under a held button: adopted, not pressed.
          held.set(action, Infinity);
          continue;
        }
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
