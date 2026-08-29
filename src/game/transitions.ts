/**
 * The ONE motion contract for application transitions (issue #364).
 *
 * Screen to screen, panel open and close, and backdrop change are three spellings of the
 * same thing: something on screen is replaced by something else, and the replacement must
 * read as continuous rather than as a cut. Before this each was an instant class toggle
 * written at its own call site, which is why there was nothing to interrupt, nothing to
 * make instant under reduced motion, and no single place to change the timing.
 *
 * This module owns SCHEDULING and CANCELLATION only -- it never touches the DOM. That is
 * deliberate: the two properties issue #364 actually asks for are both about time, not
 * about pixels.
 *
 *  - *"A transition interrupted by a second navigation resolves to the second destination,
 *    with no intermediate screen left visible."* Guaranteed here by settling the
 *    outstanding transition IMMEDIATELY when a new one starts, rather than cancelling it
 *    and leaving its half-applied state on screen.
 *  - *"Repeated fast navigation leaks no listeners, timers or animation frames."*
 *    Assertable because `pending` is observable and structurally never exceeds 1.
 *
 * Built on `setTimeout` rather than `transitionend`, which is not a style choice. jsdom
 * never fires `transitionend`, so a contract built on it could not be tested at all here;
 * meanwhile `hud.ts` already schedules its armed-reset and toast timeouts this way and
 * `hud.test.ts` already drives them with fake timers. CSS still performs the animation --
 * this decides only WHEN the outgoing state is torn down.
 */

export interface TransitionRunner {
  /**
   * Run one transition.
   *
   * `begin` runs SYNCHRONOUSLY, before this returns. Focus moves there, which is what
   * makes *"focus lands on the destination's initial control before the animation ends"*
   * true by construction rather than by racing the animation: at zero duration it has
   * already happened, and at any duration it happened first.
   *
   * `settle` runs after the current duration, or synchronously when that duration is 0
   * (reduced motion, or a build with no stylesheet -- see `durationMs`).
   */
  run(begin: () => void, settle: () => void): void;
  /**
   * Outstanding timers. Structurally 0 or 1, never more: a second `run` settles the first
   * before scheduling its own. Exposed so a test can ASSERT the absence of a leak after
   * repeated fast navigation rather than observe that nothing looked wrong.
   */
  readonly pending: number;
  /**
   * Settle any outstanding transition immediately and stop scheduling.
   *
   * Settles rather than drops: a HUD torn down mid-transition would otherwise keep the
   * outgoing screen's `--leaving` class on an element that is about to be reused.
   */
  dispose(): void;
}

export interface TransitionRunnerDeps {
  /**
   * How long the current transition should take, in milliseconds. Read PER TRANSITION,
   * not once at construction, because reduced motion can be toggled in Settings while the
   * menu is open and the next transition must honour it.
   *
   * 0 means instant, and covers two cases the game must not tell apart: the player asked
   * for reduced motion, or the stylesheet that defines the duration is not there. There is
   * deliberately no fallback duration constant in this file -- the CSS custom property is
   * the single definition (issue #364's first acceptance criterion), and a mirror here
   * would be exactly the second copy that criterion forbids.
   */
  readonly durationMs: () => number;
  /** Injected so tests need no globals; production passes the window's own pair. */
  readonly setTimeout: (fn: () => void, ms: number) => number;
  readonly clearTimeout: (handle: number) => void;
}

export function createTransitionRunner(deps: TransitionRunnerDeps): TransitionRunner {
  let handle: number | null = null;
  let outstanding: (() => void) | null = null;
  let disposed = false;

  /** Apply the pending end state now, and forget it. Safe to call with nothing pending. */
  function settleNow(): void {
    if (handle !== null) {
      deps.clearTimeout(handle);
      handle = null;
    }
    const fn = outstanding;
    outstanding = null;
    // Cleared BEFORE running: a `settle` that starts another transition (a menu that
    // closes itself on arrival) must not be cancelled by its own predecessor's bookkeeping.
    if (fn) fn();
  }

  return {
    run(begin: () => void, settle: () => void): void {
      if (disposed) return;
      // The interrupt rule, and the whole reason this is one owner rather than six
      // independent helpers: the outgoing transition finishes its job first, so the
      // screen it was hiding is hidden rather than left half-visible underneath.
      // DRAINED, not just settled once, and drained BEFORE `begin`.
      //
      // A settle may itself start a transition -- a screen that navigates on arrival --
      // and that one is already superseded by this call. Settling only once orphans its
      // timer when `handle` is overwritten below: measured at 2 live timers while
      // `pending` reported 1, with the chained transition's end state never applied. Both
      // of issue #364's failure modes at once, in the very field its leak criterion is
      // asserted on.
      //
      // Before `begin`, because the alternative was measured too: draining afterwards
      // settles the superseded transition AFTER the new screen is already revealed, so its
      // end state lands on top of the arriving one. Everything from the old chain resolves
      // first, then the new transition begins.
      //
      // Bounded rather than `while`, so a settle that unconditionally re-navigates cannot
      // spin the loop; one level is what a chained navigation actually produces.
      for (let drain = 0; drain < 8 && (outstanding !== null || handle !== null); drain++) {
        settleNow();
      }
      begin();
      // The pathological other half: `begin` itself starting a transition would orphan the
      // same way. Superseded identically, and cheap when there is nothing to do.
      for (let drain = 0; drain < 8 && (outstanding !== null || handle !== null); drain++) {
        settleNow();
      }
      const ms = deps.durationMs();
      if (ms <= 0) {
        settle();
        return;
      }
      outstanding = settle;
      handle = deps.setTimeout(() => {
        handle = null;
        const fn = outstanding;
        outstanding = null;
        if (fn) fn();
      }, ms);
    },
    get pending(): number {
      return handle === null ? 0 : 1;
    },
    dispose(): void {
      settleNow();
      disposed = true;
    },
  };
}
