import { describe, it, expect } from 'vitest';
import {
  createGamepadMenuPoller,
  MENU_CONFIRM_BUTTON,
  MENU_BACK_BUTTON,
  MENU_PAUSE_BUTTON,
  MENU_STICK_THRESHOLD,
  MENU_REPEAT_DELAY_MS,
  MENU_REPEAT_INTERVAL_MS,
} from './gamepad-menu';
import { GAMEPAD_FIRE_BUTTON, GAMEPAD_MINE_BUTTON, type GamepadLike, type GetGamepads } from './gamepad';
import { UI_ACTIONS, type UiAction } from './ui-actions';

/**
 * Standard-mapping D-pad indices, in the mapping's up/down/left/right order. Module-private
 * in gamepad-menu.ts (nothing outside it needs them), so named here rather than imported.
 */
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;

/**
 * A pad whose buttons and left stick can be changed BETWEEN polls: the poller reads live
 * state on every poll, so a fake that is rebuilt per poll would hide exactly the held/
 * released edges under test. `pressed` is a getter over a live set so the same object the
 * poller was handed changes underneath it, as real hardware does.
 */
interface FakePad {
  readonly pad: GamepadLike;
  press(...buttons: number[]): void;
  release(...buttons: number[]): void;
  /** Left stick position; other axes stay centred. */
  stick(x: number, y: number): void;
}

function fakePad(): FakePad {
  const down = new Set<number>();
  const axes = [0, 0, 0, 0];
  const buttons = Array.from({ length: 16 }, (_, i) => ({
    get pressed(): boolean {
      return down.has(i);
    },
  }));
  return {
    pad: { axes, buttons },
    press: (...bs) => bs.forEach((b) => down.add(b)),
    release: (...bs) => bs.forEach((b) => down.delete(b)),
    stick: (x, y) => {
      axes[0] = x;
      axes[1] = y;
    },
  };
}

/** A poller over `getGamepads` plus `drain()`, which returns everything emitted since the last drain, in order. */
function harness(getGamepads: GetGamepads): { poller: ReturnType<typeof createGamepadMenuPoller>; drain(): UiAction[] } {
  const emitted: UiAction[] = [];
  const poller = createGamepadMenuPoller(getGamepads, (a) => emitted.push(a));
  return { poller, drain: () => emitted.splice(0, emitted.length) };
}

/** The common single-pad case. */
function single(): FakePad & { poller: ReturnType<typeof createGamepadMenuPoller>; drain(): UiAction[] } {
  const p = fakePad();
  const h = harness(() => [p.pad]);
  return { ...p, ...h };
}

describe('createGamepadMenuPoller: button indices', () => {
  it('confirm and back are the SAME face buttons gamepad.ts reads as fire and mine -- the reason loop.ts resyncs -- and pause is Start (9)', () => {
    // The behavioural tests below press through these constants, so a changed index would
    // pass them; this is what holds the numbers. The tie to gamepad.ts is the point: the
    // one-poll resync in `createGamepadReader` exists only because the two readers share
    // buttons 0 and 1.
    expect(MENU_CONFIRM_BUTTON).toBe(GAMEPAD_FIRE_BUTTON);
    expect(MENU_BACK_BUTTON).toBe(GAMEPAD_MINE_BUTTON);
    expect(MENU_PAUSE_BUTTON).toBe(9);
  });
});

describe('createGamepadMenuPoller: press edges', () => {
  const dpad: [number, UiAction][] = [
    [DPAD_UP, 'up'],
    [DPAD_DOWN, 'down'],
    [DPAD_LEFT, 'left'],
    [DPAD_RIGHT, 'right'],
  ];

  it.each(dpad)('D-pad button %i emits %s on the press edge, nothing while held before the delay, nothing on release', (button, action) => {
    const s = single();
    s.press(button);
    s.poller.poll(0);
    expect(s.drain()).toEqual([action]);
    s.poller.poll(1); // still held, well inside MENU_REPEAT_DELAY_MS
    expect(s.drain()).toEqual([]);
    s.release(button);
    s.poller.poll(2);
    expect(s.drain()).toEqual([]);
  });

  const oneShots: [number, UiAction][] = [
    [MENU_CONFIRM_BUTTON, 'confirm'],
    [MENU_BACK_BUTTON, 'back'],
    [MENU_PAUSE_BUTTON, 'pause'],
  ];

  it.each(oneShots)('button %i emits %s exactly once per press and never repeats while held, however long', (button, action) => {
    // A held A must not activate every control it lands on. The direction-repeat block
    // below is the negative control for the silence here: a DIRECTION held over the
    // same span walks on schedule, so a quiet poller is the one-shot rule at work, not
    // a dead one -- and the release/re-press at the end proves it is still listening.
    const s = single();
    s.press(button);
    s.poller.poll(0);
    expect(s.drain()).toEqual([action]);
    for (const now of [1, MENU_REPEAT_DELAY_MS, MENU_REPEAT_DELAY_MS + MENU_REPEAT_INTERVAL_MS, 2000, 2001, 10_000]) {
      s.poller.poll(now);
    }
    expect(s.drain()).toEqual([]);
    s.release(button);
    s.poller.poll(10_001);
    expect(s.drain()).toEqual([]);
    s.press(button);
    s.poller.poll(10_002);
    expect(s.drain()).toEqual([action]); // a release then re-press is a new press
  });

  it('a release then re-press of a direction emits again, on the press edge', () => {
    const s = single();
    s.press(DPAD_DOWN);
    s.poller.poll(0);
    expect(s.drain()).toEqual(['down']);
    s.release(DPAD_DOWN);
    s.poller.poll(10);
    expect(s.drain()).toEqual([]);
    s.press(DPAD_DOWN);
    s.poller.poll(20);
    expect(s.drain()).toEqual(['down']);
  });
});

describe('createGamepadMenuPoller: direction repeat', () => {
  it('nothing before MENU_REPEAT_DELAY_MS, one at the delay, then one every MENU_REPEAT_INTERVAL_MS', () => {
    const s = single();
    s.press(DPAD_DOWN);
    s.poller.poll(0);
    expect(s.drain()).toEqual(['down']); // the press edge
    s.poller.poll(MENU_REPEAT_DELAY_MS - 1);
    expect(s.drain()).toEqual([]); // not yet -- a delay of 0 would emit here
    s.poller.poll(MENU_REPEAT_DELAY_MS);
    expect(s.drain()).toEqual(['down']); // the first repeat, exactly at the delay
    s.poller.poll(MENU_REPEAT_DELAY_MS + MENU_REPEAT_INTERVAL_MS - 1);
    expect(s.drain()).toEqual([]); // the interval, not the delay, governs from here
    s.poller.poll(MENU_REPEAT_DELAY_MS + MENU_REPEAT_INTERVAL_MS);
    expect(s.drain()).toEqual(['down']);
    s.poller.poll(MENU_REPEAT_DELAY_MS + 2 * MENU_REPEAT_INTERVAL_MS);
    expect(s.drain()).toEqual(['down']);
  });

  it('a repeat that is due is emitted once per poll, not once per elapsed interval', () => {
    // A frame that arrives late (a long GC pause, a background tab) must not dump a
    // burst of moves: the schedule is re-armed from `now`, not advanced by intervals.
    const s = single();
    s.press(DPAD_RIGHT);
    s.poller.poll(0);
    s.drain();
    s.poller.poll(MENU_REPEAT_DELAY_MS + 10 * MENU_REPEAT_INTERVAL_MS);
    expect(s.drain()).toEqual(['right']);
  });

  it('a release resets the schedule: the next press starts over with the full delay, not the interval', () => {
    const s = single();
    s.press(DPAD_DOWN);
    s.poller.poll(0);
    s.poller.poll(MENU_REPEAT_DELAY_MS);
    expect(s.drain()).toEqual(['down', 'down']); // press edge + first repeat, the walk is under way
    s.release(DPAD_DOWN);
    s.poller.poll(MENU_REPEAT_DELAY_MS + 10);
    expect(s.drain()).toEqual([]);
    const repress = MENU_REPEAT_DELAY_MS + 20;
    s.press(DPAD_DOWN);
    s.poller.poll(repress);
    expect(s.drain()).toEqual(['down']); // a fresh press edge -- a stale due time would swallow it
    s.poller.poll(repress + MENU_REPEAT_INTERVAL_MS);
    expect(s.drain()).toEqual([]); // one interval is not enough after a fresh press
    s.poller.poll(repress + MENU_REPEAT_DELAY_MS);
    expect(s.drain()).toEqual(['down']); // the full delay is
  });
});

describe('createGamepadMenuPoller: left stick', () => {
  const pushes: [number, number, UiAction][] = [
    [0, -1, 'up'],
    [0, 1, 'down'],
    [-1, 0, 'left'],
    [1, 0, 'right'],
    [0.3, 0.9, 'down'], // a diagonal: only the dominant axis counts
    [0.9, 0.3, 'right'],
    [-0.3, -0.9, 'up'],
    [-0.9, 0.3, 'left'],
    [0.7, 0.7, 'down'], // an exact tie goes to the vertical axis
  ];

  it.each(pushes)('stick (%d, %d) emits exactly one direction: %s', (x, y, action) => {
    const s = single();
    s.stick(x, y);
    s.poller.poll(0);
    expect(s.drain()).toEqual([action]);
  });

  it('a push inside MENU_STICK_THRESHOLD emits nothing, and exactly at it emits', () => {
    const s = single();
    s.stick(MENU_STICK_THRESHOLD - 0.01, 0);
    s.poller.poll(0);
    expect(s.drain()).toEqual([]);
    s.stick(0.3, 0.3); // both axes under, though the vector's length is not
    s.poller.poll(1);
    expect(s.drain()).toEqual([]);
    s.stick(MENU_STICK_THRESHOLD, 0); // the boundary is inclusive
    s.poller.poll(2);
    expect(s.drain()).toEqual(['right']);
  });

  it('a held stick is an edge like the D-pad, repeating on the same schedule and releasing on recentre', () => {
    const s = single();
    s.stick(0, 1);
    s.poller.poll(0);
    expect(s.drain()).toEqual(['down']);
    s.poller.poll(MENU_REPEAT_DELAY_MS - 1);
    expect(s.drain()).toEqual([]);
    s.poller.poll(MENU_REPEAT_DELAY_MS);
    expect(s.drain()).toEqual(['down']);
    s.stick(0, 0);
    s.poller.poll(MENU_REPEAT_DELAY_MS + MENU_REPEAT_INTERVAL_MS);
    expect(s.drain()).toEqual([]); // recentred: the walk stops
    s.stick(0, 1);
    s.poller.poll(MENU_REPEAT_DELAY_MS + MENU_REPEAT_INTERVAL_MS + 1);
    expect(s.drain()).toEqual(['down']); // and a fresh push is a fresh edge
  });
});

describe('createGamepadMenuPoller: the union of every pad', () => {
  it('two pads both holding Down emit Down once', () => {
    const a = fakePad();
    const b = fakePad();
    const h = harness(() => [a.pad, b.pad]);
    a.press(DPAD_DOWN);
    b.press(DPAD_DOWN);
    h.poller.poll(0);
    expect(h.drain()).toEqual(['down']);
    expect(h.poller.connected()).toBe(true);
  });

  it('a pad at index 1 alone drives the menu -- index 0 is not special, whichever pad is in a hand counts', () => {
    // Negative control for the union: a poller that read only pads[0] would see an idle
    // pad and emit nothing.
    const idle = fakePad();
    const b = fakePad();
    const h = harness(() => [idle.pad, b.pad]);
    b.press(MENU_CONFIRM_BUTTON);
    h.poller.poll(0);
    expect(h.drain()).toEqual(['confirm']);
  });

  it('different pads holding different actions merge into one ordered emission', () => {
    const a = fakePad();
    const b = fakePad();
    const h = harness(() => [a.pad, b.pad]);
    b.press(MENU_CONFIRM_BUTTON); // pad 1's action listed first on purpose
    a.press(DPAD_DOWN);
    h.poller.poll(0);
    expect(h.drain()).toEqual(['down', 'confirm']); // UI_ACTIONS order, not pad order
  });

  it('the stick and the D-pad agreeing on one pad emit that direction once', () => {
    const s = single();
    s.press(DPAD_UP);
    s.stick(0, -1);
    s.poller.poll(0);
    expect(s.drain()).toEqual(['up']);
  });

  it('a null slot is skipped, not treated as "no pads": the pad beside it still drives and connected() is true', () => {
    // Firefox reports an unpressed pad as null; Chromium leaves a hole at an unplugged index.
    const b = fakePad();
    const h = harness(() => [null, b.pad]);
    b.press(DPAD_UP);
    h.poller.poll(0);
    expect(h.drain()).toEqual(['up']);
    expect(h.poller.connected()).toBe(true);
  });

  it('an array of only holes is no pads at all', () => {
    const h = harness(() => [null, undefined]);
    h.poller.poll(0);
    expect(h.drain()).toEqual([]);
    expect(h.poller.connected()).toBe(false);
  });
});

describe('createGamepadMenuPoller: presence and failure', () => {
  it('connected() is false before any poll and reflects the LAST poll afterwards', () => {
    let pads: GamepadLike[] = [];
    const p = fakePad();
    const h = harness(() => pads);
    expect(h.poller.connected()).toBe(false);
    pads = [p.pad];
    h.poller.poll(0);
    expect(h.poller.connected()).toBe(true);
    pads = [];
    h.poller.poll(1);
    expect(h.poller.connected()).toBe(false);
    pads = [p.pad];
    h.poller.poll(2);
    expect(h.poller.connected()).toBe(true);
  });

  it('a throwing getGamepads emits nothing and reads as disconnected; the same press on a working one emits', () => {
    const throwing = harness(() => {
      throw new Error('no gamepad API here');
    });
    expect(() => throwing.poller.poll(0)).not.toThrow();
    expect(throwing.drain()).toEqual([]);
    expect(throwing.poller.connected()).toBe(false);
    // Negative control: the emptiness above is the catch, not a poller that never emits.
    const working = single();
    working.press(MENU_CONFIRM_BUTTON);
    working.poller.poll(0);
    expect(working.drain()).toEqual(['confirm']);
    expect(working.poller.connected()).toBe(true);
  });

  it('a getGamepads that returns nothing at all is an empty list', () => {
    const h = harness((() => undefined) as unknown as GetGamepads);
    expect(() => h.poller.poll(0)).not.toThrow();
    expect(h.drain()).toEqual([]);
    expect(h.poller.connected()).toBe(false);
  });
});

describe('createGamepadMenuPoller: dispose', () => {
  it('after dispose(), poll() emits nothing and connected() is false, even with a pad still held', () => {
    const s = single();
    s.press(DPAD_DOWN);
    s.poller.poll(0);
    expect(s.drain()).toEqual(['down']); // negative control: alive before dispose
    expect(s.poller.connected()).toBe(true);
    s.poller.dispose();
    expect(s.poller.connected()).toBe(false);
    s.poller.poll(MENU_REPEAT_DELAY_MS); // a repeat would be due now
    s.press(MENU_CONFIRM_BUTTON); // and this would be a fresh press edge
    s.poller.poll(MENU_REPEAT_DELAY_MS + 1);
    expect(s.drain()).toEqual([]);
    expect(s.poller.connected()).toBe(false);
  });
});

describe('createGamepadMenuPoller: emission order', () => {
  it('several actions arriving in one poll come out in UI_ACTIONS order, whatever order the buttons were pressed', () => {
    const s = single();
    // Pressed in REVERSE vocabulary order and with the stick pushed too, so an
    // implementation that emitted in button-index or press order would differ.
    s.press(MENU_PAUSE_BUTTON, MENU_BACK_BUTTON, MENU_CONFIRM_BUTTON, DPAD_RIGHT, DPAD_LEFT, DPAD_DOWN, DPAD_UP);
    s.stick(1, 0);
    s.poller.poll(0);
    const emitted = s.drain();
    expect(emitted).toEqual([...UI_ACTIONS]);
    expect(emitted).not.toEqual([...UI_ACTIONS].reverse()); // the press order, as a named control
  });
});
