import type { InputState, Vec2 } from '../sim/types';
import { AIM_PROJECTION_UNITS, quantizeAim } from './touch';

/**
 * Gamepad API reader: `navigator.getGamepads()`, mapped to the same `InputState` shape
 * keyboard and touch already produce.
 *
 * Gamepad[0] only, in both consumers below -- gamepad[1] onward stays unplumbed.
 * `createGamepadReader` alone backs `input.ts`'s single-player MERGE (`?dev=1&gamepad=1`,
 * OR'd into keyboard/mouse/touch). `createGamepadInputSource`, further down this file,
 * wraps it into a standalone `PlayerInputSource` for couch co-op's slot 1
 * (`?dev=1&coop=1`) -- see CLAUDE.md's input-routing entry and `loop.ts`'s `slots`
 * array. The two are mutually exclusive BY CONSTRUCTION, not merely by convention: when
 * `coop` is on, slot 0 is built with `{gamepad: false}` so the merge's own reader is
 * never constructed, and slot 1 owns gamepad[0] exclusively.
 *
 * Split in two on purpose. `deadzoneVector` is the pure mapping core: raw axis pair in,
 * a analog vector out, no DOM. `createGamepadReader` is the stateful edge at `poll()` --
 * it decides what "just pressed" and "just connected" mean across repeated polls, and
 * takes its `getGamepads` function injected so a test can drive it without a browser.
 * The spike behind issue #114 confirmed jsdom does not need to be involved either way:
 * `Object.defineProperty(navigator, 'getGamepads', {value: () => [...], configurable:
 * true})` and `vi.stubGlobal` both work under `@vitest-environment jsdom`, and neither
 * is exercised by the pure half at all.
 */

/**
 * How far off centre a stick must move before it counts as input.
 *
 * Feel, not measurement -- sticks on real hardware report a few percent of noise even
 * centred, worse on a worn pad, so 0 would read as permanent drift. Chosen in the same
 * range console pads standardise on (roughly 0.15-0.25); retune by eye with
 * `npm run gallery --sweep` rather than guessing tighter.
 */
export const GAMEPAD_DEADZONE = 0.2;

/**
 * Standard Gamepad API mapping (`mapping: 'standard'`) button indices this reader reads.
 * 0 is the bottom face button (A on Xbox, Cross on PlayStation) and 1 is the button to
 * its right (B / Circle) -- the two are adjacent under a right thumb resting on the face
 * buttons, mirroring the mouse's left-click-fires/right-click-mines split.
 */
export const GAMEPAD_FIRE_BUTTON = 0;
export const GAMEPAD_MINE_BUTTON = 1;

/** Standard mapping axis indices: left stick is 0/1, right stick is 2/3. */
const MOVE_AXIS_X = 0;
const MOVE_AXIS_Y = 1;
const AIM_AXIS_X = 2;
const AIM_AXIS_Y = 3;

/**
 * A raw `(x, y)` axis pair, clamped to a unit circle and rescaled past the dead zone.
 *
 * Mirrors `touch.ts`'s `stickVector`: inside the dead zone this is exactly `{0, 0}`, and
 * just past it the output starts near 0 rather than jumping straight to
 * `GAMEPAD_DEADZONE` -- a thumb easing a stick off centre should feel like a ramp, not a
 * step. Diagonal input is deliberately clamped to magnitude 1 (a raw diagonal reports
 * ~1.414) -- unlike the keyboard's `readMove`, which sums unit axes and never clamps its
 * `(1, 1)` diagonal; the two paths are allowed to disagree here because they are
 * different hardware with different physical constraints, not the same analog signal.
 */
export function deadzoneVector(x: number, y: number, deadzone: number = GAMEPAD_DEADZONE): Vec2 {
  const mag = Math.hypot(x, y);
  if (mag <= deadzone) return { x: 0, y: 0 };
  const clamped = Math.min(1, mag);
  const rescaled = (clamped - deadzone) / (1 - deadzone);
  return { x: (x / mag) * rescaled, y: (y / mag) * rescaled };
}

/** The subset of a real `Gamepad` this reader touches, so a fake needs only this much. */
export interface GamepadLike {
  readonly axes: ArrayLike<number>;
  readonly buttons: ArrayLike<{ readonly pressed: boolean }>;
}

/** Matches `navigator.getGamepads`'s own signature: a possibly-sparse array of pads or nulls. */
export type GetGamepads = () => ArrayLike<GamepadLike | null | undefined>;

export interface GamepadPoll {
  /** Left stick, dead-zoned and rescaled. `{0, 0}` when centred or no pad is present. */
  readonly move: Vec2;
  /**
   * Right stick projected to a world point, `AIM_PROJECTION_UNITS` out from `playerPos`
   * along the pushed direction -- the same stick-direction-times-projection-units
   * pattern `touch.ts`'s `stick` aim scheme uses. `null` when the stick is inside the
   * dead zone (hold whatever aim is already live, exactly as touch does) or there is no
   * player position to project from.
   */
  readonly aim: Vec2 | null;
  /** True on the poll where the fire button transitions from up to down, never held. */
  readonly fire: boolean;
  /** Same, for the mine button. */
  readonly mine: boolean;
}

const NEUTRAL_POLL: GamepadPoll = { move: { x: 0, y: 0 }, aim: null, fire: false, mine: false };

export interface GamepadReader {
  /**
   * Called once per simulated tick from `sample()`, never on its own timer -- the driver
   * already calls `sample()` once per tick, and a second polling loop would double-read
   * the hardware and could double-count an edge.
   */
  poll(playerPos: Vec2 | null): GamepadPoll;
  /**
   * Cached from the last `poll()`. Deliberately NOT a second call to `getGamepads` --
   * reading presence is done here so a per-frame HUD check (outside the tick-scoped
   * `sample()`) does not also advance the fire/mine edge state a second time and swallow
   * a real press.
   */
  connected(): boolean;
  /** No listeners are registered -- poll() only ever reads `getGamepads()` -- so there is
   * nothing to release. Present for symmetry with every other input collaborator, all of
   * which expose dispose(). */
  dispose(): void;
}

/**
 * @param getGamepads Injected rather than reading `navigator` directly, so this is
 * testable without a browser and so a platform with no Gamepad API at all (the function
 * itself absent from `navigator`) is the caller's problem to guard, not this module's --
 * see `createReaderFromNavigator` below for the one production call site.
 */
export function createGamepadReader(getGamepads: GetGamepads): GamepadReader {
  let cachedConnected = false;
  let prevFire = false;
  let prevMine = false;

  return {
    poll(playerPos: Vec2 | null): GamepadPoll {
      let pads: ArrayLike<GamepadLike | null | undefined>;
      try {
        pads = getGamepads() ?? [];
      } catch {
        // Tolerate a throwing implementation exactly like a permanently-empty one --
        // the reader must never be the reason the game errors out.
        pads = [];
      }
      const pad = pads.length > 0 ? pads[0] ?? null : null;
      cachedConnected = pad != null;

      if (pad == null) {
        prevFire = false;
        prevMine = false;
        return NEUTRAL_POLL;
      }
      // No "just connected" edge is computed here, deliberately: an earlier draft
      // returned one and review found it dead -- loop.ts derives the connect toast's
      // rising edge itself from connected(), and two mechanisms for one concept is how
      // the unwired one rots while its tests keep advertising coverage.

      const move = deadzoneVector(pad.axes[MOVE_AXIS_X] ?? 0, pad.axes[MOVE_AXIS_Y] ?? 0);

      let aim: Vec2 | null = null;
      const aimStick = deadzoneVector(pad.axes[AIM_AXIS_X] ?? 0, pad.axes[AIM_AXIS_Y] ?? 0);
      if ((aimStick.x !== 0 || aimStick.y !== 0) && playerPos !== null) {
        const len = Math.hypot(aimStick.x, aimStick.y);
        aim = {
          x: playerPos.x + (aimStick.x / len) * AIM_PROJECTION_UNITS,
          y: playerPos.y + (aimStick.y / len) * AIM_PROJECTION_UNITS,
        };
      }

      const firePressed = pad.buttons[GAMEPAD_FIRE_BUTTON]?.pressed ?? false;
      const minePressed = pad.buttons[GAMEPAD_MINE_BUTTON]?.pressed ?? false;
      const fire = firePressed && !prevFire;
      const mine = minePressed && !prevMine;
      prevFire = firePressed;
      prevMine = minePressed;

      return { move, aim, fire, mine };
    },
    connected(): boolean {
      return cachedConnected;
    },
    dispose(): void {
      // Nothing registered; see the interface doc comment.
    },
  };
}

/**
 * The slice of an input collaborator co-op's per-slot array needs. `InputController`
 * (`input.ts`) satisfies this structurally -- it has every member here plus more (touch
 * indicator, latched presses, scheme/fire-mode setters) -- so slot 0 (the multi-device
 * controller) and slot 1 (`createGamepadInputSource` below) can sit in the same
 * `PlayerInputSource[]` in `loop.ts` with no shared base class or adapter.
 */
export interface PlayerInputSource {
  sample(): InputState;
  /** Same contract as `InputController.setPlayerPosition` -- see its doc comment. */
  setPlayerPosition(pos: Vec2 | null): void;
  gamepadConnected(): boolean;
  dispose(): void;
}

/**
 * A standalone, per-slot input source over one `GamepadReader` -- couch co-op's slot 1
 * (`?dev=1&coop=1`), never merged into slot 0's keyboard/mouse/touch stream (see this
 * file's module doc comment for the mutual-exclusion argument).
 *
 * Holds its own `aim`, defaulting to `{0, 0}` and updated only when the right stick is
 * outside the dead zone (`poll().aim !== null`). This is NOT redundant with the
 * reader's own dead-zone handling: `input.ts`'s merged controller survives a centred
 * stick because mouse/touch keep its `aim` variable alive between gamepad polls, but a
 * standalone slot 1 has no such fallback producer, so it has to persist its own last
 * aim the same way the merged controller's closure does.
 *
 * Quantized through `quantizeAim` (`touch.ts`) -- the SAME boundary function
 * `input.ts`'s `sample()` applies, not a second, differently-rounded copy. See
 * `touch.ts`'s `AIM_GRID` doc comment for why the function lives there.
 */
export function createGamepadInputSource(getGamepads: GetGamepads): PlayerInputSource {
  const reader = createGamepadReader(getGamepads);
  let aim: Vec2 = { x: 0, y: 0 };
  let playerPos: Vec2 | null = null;

  return {
    sample(): InputState {
      const gp = reader.poll(playerPos);
      if (gp.aim !== null) aim = gp.aim;
      return {
        move: gp.move,
        aim: quantizeAim(aim),
        fire: gp.fire,
        mine: gp.mine,
      };
    },
    setPlayerPosition(pos: Vec2 | null): void {
      playerPos = pos === null ? null : { x: pos.x, y: pos.y };
    },
    gamepadConnected(): boolean {
      return reader.connected();
    },
    dispose(): void {
      reader.dispose();
    },
  };
}

/**
 * The one production `GetGamepads`: reads `navigator.getGamepads` if the platform has
 * it, an empty list forever if not. Two production call sites: `input.ts`'s merge and
 * `loop.ts`'s `createBrowserDeps` (co-op slot 1) -- both read the SAME live pads,
 * mutually exclusive by construction rather than by which one happens to call this.
 */
export function readNavigatorGamepads(): ArrayLike<GamepadLike | null | undefined> {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
  return navigator.getGamepads();
}
