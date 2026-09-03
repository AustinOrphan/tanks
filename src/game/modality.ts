/**
 * Which input the player is actually using (issues #319, #496), so a prompt can name
 * the right key or button.
 *
 * The problem this exists to solve is the hybrid device: a laptop with a touchscreen, a
 * phone with a keyboard, a desktop with a pad plugged in. Capability detection alone
 * says "this machine can do all three" and cannot choose; the LAST input is the honest
 * answer, but reacting to every event makes prompts flicker -- a palm brushing a
 * trackpad while typing would rewrite the hints mid-sentence.
 *
 * So a switch needs the new modality to be the only one seen for `switchAfterMs`. The
 * first input on a fresh page is accepted immediately, with no history to weigh: the
 * splash's "Press any key or tap" is answered by whatever the player reaches for, and
 * the visual job's very first Space must not wait out a threshold.
 *
 * Pure and clock-injected: `note(modality, now)` takes the time from the caller, so
 * tests drive it without timers and the page passes `performance.now()`.
 */
export type Modality = 'keyboard' | 'pointer' | 'touch' | 'gamepad';

/**
 * How long a new modality must be the only one seen before prompts follow it. Feel, not
 * measurement: long enough that a stray trackpad brush or a pad's idle drift does not
 * rewrite a hint mid-read, short enough that deliberately picking up the other device
 * and pressing a button changes the prompt before the player looks for it. Tuned by eye
 * against the same 400ms range key-repeat delays use.
 */
export const MODALITY_SWITCH_MS = 400;

export interface ModalityTracker {
  /** The modality prompts should name. `null` until the first input of the page. */
  current(): Modality | null;
  /**
   * Record one input at `now` (any monotonic clock, milliseconds). Returns true when
   * `current()` changed, which is the page's cue to repaint the prompts and nothing else.
   */
  note(modality: Modality, now: number): boolean;
  /** Called on every change, with the new modality. Returns an unsubscribe. */
  subscribe(cb: (modality: Modality) => void): () => void;
}

/**
 * @param switchAfterMs How long a candidate must hold the field before it wins; the
 * default is `MODALITY_SWITCH_MS`. A test passes its own so the threshold under test is
 * the one the assertion names.
 */
export function createModalityTracker(switchAfterMs: number = MODALITY_SWITCH_MS): ModalityTracker {
  /** @type {Modality | null} */
  let current: Modality | null = null;
  /** The modality trying to take over, and when it first appeared. */
  let candidate: Modality | null = null;
  let candidateSince = 0;
  const listeners = new Set<(m: Modality) => void>();

  const settle = (next: Modality): boolean => {
    current = next;
    candidate = null;
    for (const cb of [...listeners]) cb(next);
    return true;
  };

  return {
    current: () => current,
    note(modality, now): boolean {
      if (current === null) return settle(modality); // the first input of the page
      if (modality === current) {
        candidate = null; // the incumbent reasserts itself: any challenger starts over
        return false;
      }
      if (candidate !== modality) {
        candidate = modality;
        candidateSince = now;
        return false;
      }
      // A candidate wins by holding the field for the whole threshold, so a single stray
      // event of another modality never switches: it is one sample, not a span.
      return now - candidateSince >= switchAfterMs ? settle(modality) : false;
    },
    subscribe(cb): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/**
 * The static hint a control appends to its label, per modality (issue #496's "one policy
 * across the HUD").
 *
 * A keyboard names the key. TOUCH names nothing: there is no key to press, and a hint the
 * player cannot act on is worse than none. A MOUSE keeps the key hint, which is the case
 * worth stating -- clicking says nothing about whether a keyboard is present, and on the
 * desktop it always is, so dropping the hint there would hide `M` from the players most
 * likely to use it. That is also why the page tells a finger from a mouse by the
 * browser's `pointerType` rather than lumping both into "pointer".
 *
 * A PAD names its button only when one is actually bound to the action: `button` is null
 * for a control the pad cannot reach by a shortcut, and the hint is then empty rather
 * than either an invented button or a key a couch player has no keyboard for. Mute is
 * exactly that case today -- `loop.ts` binds M and the on-screen button, nothing else --
 * and a pad reaches it the way it reaches every control, by moving focus and confirming.
 * Naming a button here that nothing dispatches would be a false instruction (review of
 * issue #496 caught the earlier version claiming `Y`).
 *
 * `null` modality, before the first input, keeps the shipped keyboard hint, which is
 * what a desktop page shows untouched.
 */
export function keyHint(modality: Modality | null, key: string, button: string | null): string {
  if (modality === 'gamepad') return button === null ? '' : ` (${button})`;
  if (modality === 'touch') return '';
  return ` (${key})`;
}
