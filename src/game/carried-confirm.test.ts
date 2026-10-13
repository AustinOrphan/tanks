// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCarriedConfirmGuard } from './carried-confirm';

/**
 * The keyboard half of issue #919's proof: a Confirm pressed for one screen cannot activate the
 * next screen's primary action.
 *
 * The guard is handed events directly, each with its `timeStamp` written, and an arrival clock
 * that reads a variable, so every "before" and "after" below is a number on the page rather
 * than an accident of how fast the test ran. What the browser then does with a cancelled event
 * is not modelled here: `defaultPrevented` is the whole contract, because the activation it
 * cancels is the browser's own (`hud.ts` never claims Enter or Space). `hud.navigation.test.ts`
 * drives the same guard through a real HUD, and the visual gate presses real keys.
 *
 * Enter and Space are each spelled out, never read from `ui-actions.ts`: a key dropped from that
 * vocabulary must fail here rather than take its own case with it.
 */

let clock = 0;
const guard = (): ReturnType<typeof createCarriedConfirmGuard> => createCarriedConfirmGuard(() => clock);

/** One keyboard event at `at`, cancellable as the browser's are, offered to `g`. Returns whether it was cancelled. */
function key(
  g: ReturnType<typeof createCarriedConfirmGuard>,
  type: 'keydown' | 'keypress' | 'keyup',
  name: string,
  at: number,
  repeat = false,
): boolean {
  const e = new KeyboardEvent(type, { key: name, repeat, cancelable: true });
  Object.defineProperty(e, 'timeStamp', { value: at });
  g.onKey(e);
  return e.defaultPrevented;
}

afterEach(() => {
  clock = 0;
  vi.useRealTimers();
});

describe('createCarriedConfirmGuard (issue #919)', () => {
  for (const name of ['Enter', ' ']) {
    const label = name === ' ' ? 'Space' : name;

    it(`cancels every event of a ${label} held across an arrival: repeats, keypress and keyup`, () => {
      const g = guard();
      expect(key(g, 'keydown', name, 5), 'the press itself, before any arrival, was cancelled').toBe(false);
      clock = 10;
      g.arrive();
      expect(key(g, 'keydown', name, 12, true), 'an auto-repeat reached the new screen').toBe(true);
      expect(key(g, 'keypress', name, 12, true), 'the repeat\'s keypress reached the new screen').toBe(true);
      expect(key(g, 'keyup', name, 14), 'the release reached the new screen').toBe(true);

      // NEGATIVE CONTROL: the same events with no arrival between them are the browser's.
      const quiet = guard();
      expect(key(quiet, 'keydown', name, 5)).toBe(false);
      expect(key(quiet, 'keydown', name, 12, true), 'a repeat on the same screen was cancelled').toBe(false);
      expect(key(quiet, 'keypress', name, 12, true)).toBe(false);
      expect(key(quiet, 'keyup', name, 14)).toBe(false);
    });

    it(`leaves a ${label} pressed after the arrival alone, repeats and all`, () => {
      const g = guard();
      clock = 10;
      g.arrive();
      expect(key(g, 'keydown', name, 11), 'a fresh press on the new screen was cancelled').toBe(false);
      expect(key(g, 'keypress', name, 11)).toBe(false);
      expect(key(g, 'keydown', name, 13, true)).toBe(false);
      expect(key(g, 'keyup', name, 15)).toBe(false);
    });
  }

  it('cancels the keypress and keyup of the very keydown that made the arrival', () => {
    // The Launch splash dismisses on a keydown, and Enter clicks on the keypress that follows
    // it, aimed at whatever holds focus by then: the Main Menu's primary action.
    const g = guard();
    expect(key(g, 'keydown', 'Enter', 20), 'the keydown itself predates the arrival it makes').toBe(false);
    clock = 20.5; // the arrival, while that keydown is still being dispatched
    g.arrive();
    expect(key(g, 'keypress', 'Enter', 20), 'the same keystroke activated the new screen').toBe(true);
    expect(key(g, 'keyup', 'Enter', 21)).toBe(true);
  });

  it('cancels a keydown stamped before the arrival though it is delivered after it (a queued press)', () => {
    // A press made while the arrival's frame was running reaches the new screen first.
    const g = guard();
    clock = 10;
    g.arrive();
    expect(key(g, 'keydown', 'Enter', 9), 'a press queued behind the arrival reached the new screen').toBe(true);
    expect(key(g, 'keypress', 'Enter', 9)).toBe(true);
    // NEGATIVE CONTROL: the same press stamped just after the arrival is a fresh one.
    expect(key(g, 'keydown', 'Enter', 10.1)).toBe(false);
    expect(key(g, 'keypress', 'Enter', 10.1)).toBe(false);
  });

  it('counts a press stamped at the arrival\'s own instant as before it', () => {
    // Two stamps coarsened to one tick cannot say which came first, so the guard assumes the
    // press may predate the screen.
    const g = guard();
    clock = 10;
    g.arrive();
    expect(key(g, 'keydown', ' ', 10), 'a press at the arrival\'s instant counted as after it').toBe(true);
    expect(key(g, 'keydown', 'Enter', 10.001), 'the press a moment later is fresh').toBe(false);
  });

  it('cancels the events of a press whose start it never saw', () => {
    // A key already down when the page took focus: its repeats and release are not this screen's.
    const g = guard();
    expect(key(g, 'keydown', 'Enter', 3, true), 'a repeat of an unseen press got through').toBe(true);
    expect(key(g, 'keyup', 'Enter', 4), 'the release of an unseen press got through').toBe(true);
    // NEGATIVE CONTROL: once a press is seen from its start, its repeat and release are allowed.
    expect(key(g, 'keydown', 'Enter', 5)).toBe(false);
    expect(key(g, 'keydown', 'Enter', 6, true)).toBe(false);
    expect(key(g, 'keyup', 'Enter', 7)).toBe(false);
  });

  it('frees a carried key at its next press, so a held-then-released key is never stuck', () => {
    const g = guard();
    key(g, 'keydown', ' ', 1);
    clock = 2;
    g.arrive();
    expect(key(g, 'keyup', ' ', 3)).toBe(true);
    expect(key(g, 'keydown', ' ', 4), 'the next press of a released key was still cancelled').toBe(false);
    expect(key(g, 'keyup', ' ', 5)).toBe(false);
  });

  it('never touches a key that is not Confirm, held across an arrival or not', () => {
    const g = guard();
    for (const name of ['Escape', 'ArrowDown', 'm', 'p', 'w', 'Tab']) key(g, 'keydown', name, 1);
    key(g, 'keydown', 'Enter', 1);
    clock = 2;
    g.arrive();
    for (const name of ['Escape', 'ArrowDown', 'm', 'p', 'w', 'Tab']) {
      expect(key(g, 'keydown', name, 3, true), `${name}'s repeat was cancelled`).toBe(false);
      expect(key(g, 'keyup', name, 4), `${name}'s release was cancelled`).toBe(false);
    }
    // NEGATIVE CONTROL: Enter, held across the same arrival, is cancelled.
    expect(key(g, 'keyup', 'Enter', 4)).toBe(true);
  });

  it('stamps the arrival on the clock events carry by default, so the two always compare', () => {
    // jsdom stamps events from `Date.now()`, a browser from `performance.now()`; the default
    // arrival clock reads a fresh event's stamp, so it is whichever the environment uses.
    // `performance.now()` here would put the arrival decades before every press.
    vi.useFakeTimers({ toFake: ['Date'] });
    const g = createCarriedConfirmGuard();
    vi.setSystemTime(1_000_000);
    const down = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    g.onKey(down);
    vi.setSystemTime(2_000_000);
    g.arrive();
    vi.setSystemTime(3_000_000);
    const up = new KeyboardEvent('keyup', { key: 'Enter', cancelable: true });
    g.onKey(up);
    expect(down.defaultPrevented, 'the press was cancelled before any arrival').toBe(false);
    expect(up.defaultPrevented, 'the release of a press made before the arrival got through').toBe(true);
    // NEGATIVE CONTROL: a press made after the arrival, on the same default clock, is fresh.
    const again = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    g.onKey(again);
    expect(again.defaultPrevented).toBe(false);
  });
});
