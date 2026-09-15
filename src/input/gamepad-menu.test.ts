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
import type { ControlLayout, LayoutLookup } from './gamepad-profile';

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
    // `mapping: 'standard'` since issue #596: the poller classifies each pad before reading
    // it, and one reporting no mapping contributes no actions. This fake has always been a
    // standard pad -- it is indexed with MENU_CONFIRM_BUTTON and the standard D-pad -- so
    // saying so is what it always meant. The refusal itself has its own tests below.
    pad: { axes, buttons, mapping: 'standard' },
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
  it('confirm and back are DISJOINT from fire and mine, so a menu press cannot leak a shot, and pause is Start (9)', () => {
    // The behavioural tests below press through these constants, so a changed index would
    // pass them; this is what holds the numbers.
    //
    // THE ASSERTION INVERTED, deliberately. It used to require these to be the SAME two
    // buttons, and the one-poll resync in `createGamepadReader` existed because they were:
    // confirming Resume with A, still held on the first simulated tick, read as a fresh
    // fire press and shot a shell (issue #494). Fire and mine have since moved to the
    // triggers, because on a twin-stick pad the face buttons sit under the thumb that has
    // to stay on the aim stick.
    //
    // So the tie is now a separation, and it is worth pinning in that direction: rebinding
    // either pair back onto the other's buttons would restore a defect that took its own
    // issue to find. Stated as set disjointness rather than four literals, so it keeps
    // holding if any of the four moves for an unrelated reason.
    const menu = [MENU_CONFIRM_BUTTON, MENU_BACK_BUTTON, MENU_PAUSE_BUTTON];
    const play = [GAMEPAD_FIRE_BUTTON, GAMEPAD_MINE_BUTTON];
    for (const m of menu) {
      expect(play, `menu button ${m} is also a gameplay action`).not.toContain(m);
    }
    expect(MENU_CONFIRM_BUTTON).toBe(0);
    expect(MENU_BACK_BUTTON).toBe(1);
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
  it('emits NOTHING from a pad it cannot classify, while still counting it as connected', () => {
    // Issue #596. Before this, every visible pad was read at the standard indices: button 0
    // as Confirm, 12-15 as the D-pad. On a pad laid out differently that is a menu operating
    // itself -- an unrelated control activating whatever has focus -- which is worse than a
    // pad that does nothing, because the player cannot tell it from a bug in the menu.
    //
    // The two halves are deliberately opposite, and both are the contract: NO actions, and
    // connected() TRUE. Issue #597 builds "this controller is visible but unsupported" on
    // exactly that pair, and a refused pad that also read as absent would be indistinguishable
    // from no hardware at all.
    const unknown = fakePad();
    const pad: GamepadLike = { ...unknown.pad, mapping: '' };
    const h = harness(() => [pad]);
    unknown.press(MENU_CONFIRM_BUTTON, MENU_BACK_BUTTON, MENU_PAUSE_BUTTON, DPAD_DOWN);
    unknown.stick(0, 1);
    h.poller.poll(0);
    expect(h.drain()).toEqual([]);
    expect(h.poller.connected()).toBe(true);
  });

  it('reads the supported pad beside an unsupported one, so one bad device does not mute the menu', () => {
    // The union is per-pad now, not all-or-nothing. A player with an unrecognized adapter
    // plugged in beside a working controller keeps the working one -- and this is the
    // negative control for the test above: it proves the refusal is scoped to the pad that
    // earned it rather than being a poller that stopped emitting.
    const good = fakePad();
    const bad = fakePad();
    const badPad: GamepadLike = { ...bad.pad, mapping: '' };
    const h = harness(() => [badPad, good.pad]);
    bad.press(MENU_BACK_BUTTON);
    good.press(MENU_CONFIRM_BUTTON);
    h.poller.poll(0);
    expect(h.drain()).toEqual(['confirm']);
  });

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

describe("createGamepadMenuPoller: the player's layout (issue #754)", () => {
  it('reads Confirm from its bound control, and the old button no longer confirms', () => {
    const asked: string[] = [];
    const bound: ControlLayout = { preset: 'recommended', bindings: { confirm: 'face-left' } };
    const lookup: LayoutLookup = (id) => {
      asked.push(id);
      return bound;
    };
    const p = fakePad();
    const emitted: UiAction[] = [];
    const poller = createGamepadMenuPoller(() => [p.pad], (a) => emitted.push(a), lookup);

    p.press(MENU_CONFIRM_BUTTON);
    poller.poll(0);
    expect(emitted).toEqual([]);
    p.release(MENU_CONFIRM_BUTTON);
    poller.poll(1);
    p.press(2); // face-left
    poller.poll(2);
    expect(emitted).toEqual(['confirm']);
    expect(asked).toContain('standard');

    // Control: with no lookup, face-left is no menu action at all.
    const control = single();
    control.press(2);
    control.poller.poll(0);
    expect(control.drain()).toEqual([]);
  });

  it('adopts a button held across a layout change as held, not pressed, and reads it once pressed again', () => {
    // The Controller Layout pane binds the button a player is still holding: Back moved onto X
    // with X down. Held state is kept per action, so without adoption X is a new Back press on
    // the next poll, and the pane closes on the press that only chose the button.
    let layout: ControlLayout = { preset: 'recommended', bindings: {} };
    const p = fakePad();
    const emitted: UiAction[] = [];
    const poller = createGamepadMenuPoller(() => [p.pad], (a) => emitted.push(a), () => layout);
    p.press(2); // face-left: no menu action yet
    poller.poll(0);
    layout = { preset: 'recommended', bindings: { back: 'face-left' } };
    poller.poll(1);
    poller.poll(2);
    expect(emitted, 'a held button became a Back press when the layout moved under it').toEqual([]);
    p.release(2);
    poller.poll(3);
    p.press(2);
    poller.poll(4);
    expect(emitted).toEqual(['back']);
  });

  it('compares mappings by value: a new layout object that maps the same buttons adopts nothing', () => {
    // The negative control for the case above. An identity comparison would read this fresh
    // object as a remap and swallow the genuine press that lands on the same poll.
    let layout: ControlLayout = { preset: 'recommended', bindings: { back: 'face-left' } };
    const p = fakePad();
    const emitted: UiAction[] = [];
    const poller = createGamepadMenuPoller(() => [p.pad], (a) => emitted.push(a), () => layout);
    poller.poll(0);
    layout = { preset: 'recommended', bindings: { back: 'face-left' } };
    p.press(2);
    poller.poll(1);
    expect(emitted).toEqual(['back']);
  });

  it('moves stick navigation to the right stick under Southpaw, and leaves the D-pad where it is', () => {
    const southpaw: ControlLayout = { preset: 'southpaw', bindings: {} };
    const p = fakePad();
    const axes = p.pad.axes as number[];
    const emitted: UiAction[] = [];
    const poller = createGamepadMenuPoller(() => [p.pad], (a) => emitted.push(a), () => southpaw);

    p.stick(1, 0); // the left stick, which Southpaw makes the aim stick
    poller.poll(0);
    expect(emitted).toEqual([]);
    p.stick(0, 0);
    axes[2] = 1; // the right stick, which Southpaw makes the movement stick
    poller.poll(1);
    expect(emitted).toEqual(['right']);
    axes[2] = 0;
    poller.poll(2);
    p.press(DPAD_UP);
    poller.poll(3);
    expect(emitted).toEqual(['right', 'up']);
  });
});
