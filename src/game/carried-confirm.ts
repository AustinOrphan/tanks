/**
 * A keyboard Confirm pressed for one screen must not activate the next (issue #919).
 *
 * WHY THIS EXISTS. Since #919 a pane, an overlay or a panel state arrives with focus on its
 * primary action, so one press takes a screen. The keyboard's Confirm is the browser's own
 * activation of the focused button -- `hud.ts` never claims Enter or Space -- and that
 * activation does not care which screen the key was pressed on:
 *
 * - Enter clicks a button on `keypress`, which follows the `keydown` and is aimed at whatever
 *   holds focus THEN. A `keydown` that moves focus (the Launch splash dismisses on one) hands
 *   its own `keypress` to the new primary: one keystroke, two screens.
 * - A held key auto-repeats, and every repeat is another `keydown`/`keypress`, so Enter held on
 *   a button that opens a pane clicks the pane's primary on the next repeat, and the one after.
 * - Space clicks on `keyup`. Space also lays a mine in play, so a match that ends with it held
 *   lands focus on Retry or Next Mission with the release still to come.
 * - A `keydown` the browser queued while the frame that opened the screen was running reaches
 *   the new screen first, though the press was made before that screen existed.
 *
 * THE RULE. A press of Enter or Space that began at or before the latest arrival does nothing:
 * its `keydown`, repeats, `keypress` and `keyup` all have their default action prevented.
 * A press that begins after the arrival is untouched, so a deliberate press is as quick as
 * ever. This is the keyboard twin of the gamepad poller's edge rule (`gamepad-menu.ts`), under
 * which a held Confirm never fires again and a button must be released and pressed anew.
 *
 * A REACTION WINDOW, for a screen nobody asked for. An arrival may carry `graceMs`, which moves
 * "the arrival" that far past the moment focus moved, so a press begun inside the window is
 * cancelled too. `hud.ts` passes one only for a match's outcome, the surface the game opens on
 * its own on the frame the match ends: a press there in the first moments was made for the
 * match, before the player could have seen the result. A screen the player opened has none.
 *
 * TIMES, NOT A COUNTER. "Began before the arrival" is read off the press's own `keydown`
 * `timeStamp`, which the browser sets from the input itself, so a `keydown` queued behind the
 * arrival's frame is still judged by when the key went down. An arrival counter could judge
 * only the order the guard happened to see events in. The arrival is stamped from a fresh
 * `Event`, the clock input events carry in every engine and in jsdom alike (`performance.now()`
 * in a browser, `Date.now()` in jsdom), so the two sides are always on one timeline. `<=`,
 * because two stamps coarsened to the same tick cannot say which came first, and a press that
 * might predate the screen is treated as one that did.
 *
 * PREVENT, NEVER STOP. The guard only cancels the browser's activation. Propagation continues,
 * because `input.ts` tracks a held Space for play from the same events: a swallowed `keyup`
 * would leave the key down for the next match.
 *
 * NO RESET ON BLUR, AND NO CLEAR ON RELEASE. A key keeps the stamp of its latest press, which
 * is harmless after the release: its next press is a fresh `keydown` that writes a new one, so
 * a stuck entry cannot swallow a real press. A key that is still down when the page regains
 * focus is carried if a screen arrived meanwhile, which is correct.
 *
 * A LEAF MODULE over `ui-actions.ts`'s vocabulary, so the keys it guards are the keys that
 * vocabulary calls Confirm.
 */
import { keyToUiAction } from '../input/ui-actions';

export interface CarriedConfirmGuard {
  /**
   * A surface has just taken focus: every Confirm press begun until now belongs to the screen
   * before, and with `graceMs`, every press begun within that many milliseconds after it.
   */
  arrive(graceMs?: number): void;
  /** The window-capture listener for `keydown`, `keypress` and `keyup`. */
  onKey(e: KeyboardEvent): void;
}

/** The clock browsers stamp input events with -- see the module comment. */
const eventClock = (): number => new Event('arrival').timeStamp;

/**
 * @param now The arrival clock. Defaults to the event clock; a test that writes its own event
 * `timeStamp`s passes the matching clock.
 */
export function createCarriedConfirmGuard(now: () => number = eventClock): CarriedConfirmGuard {
  let arrivedAt = -Infinity;
  /** When each Confirm key's current press began, by lowercased `key`. */
  const pressedAt = new Map<string, number>();
  return {
    arrive(graceMs = 0): void {
      arrivedAt = now() + graceMs;
    },
    onKey(e: KeyboardEvent): void {
      if (keyToUiAction(e.key) !== 'confirm') return;
      const key = e.key.toLowerCase();
      // Only the press's first `keydown` writes its start. A stale entry left by a release the
      // page never saw is overwritten by that key's next press, so nothing is ever cleared.
      if (e.type === 'keydown' && !e.repeat) pressedAt.set(key, e.timeStamp);
      const began = pressedAt.get(key);
      // A press whose start the page never saw (held while focus was elsewhere) counts as old.
      if (began === undefined || began <= arrivedAt) e.preventDefault();
    },
  };
}
