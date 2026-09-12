/**
 * What the player is told when the game cannot start, and what they can do about it
 * (issue #325).
 *
 * Until this module there was ONE message for every way startup could fail:
 * `NO_WEBGL_MESSAGE`, "this game needs WebGL, try another browser". `boot.ts` reached it
 * from a `catch` that covers the capability gate, `createAppShell` resolving storage, a
 * `WebGLRenderer` that gets its context and then fails initialising on it, and -- since
 * issue #428 -- a match that fails to start from a HUD click long after `boot()` returned.
 * The message was true for the first and a guess for the rest, and the guess was
 * ACTIONABLE: a player whose storage was blocked was told to go and change browsers over
 * a graphics feature that was working.
 *
 * Kept as a pure classification, separate from the DOM that renders it, for the same
 * reason `render-capability.ts` is separate from the screen: the mapping from "what went
 * wrong" to "what we say about it" is the part worth testing, and it has no business
 * knowing about elements.
 *
 * NO DIAGNOSTICS. Every string here is written for a player -- no error text, no stack, no
 * capability enum leaks into the page. The underlying error still goes to `reportError`
 * unchanged, which is where a developer reads it. Issue #325 asks for technical detail to
 * live behind Developer Tools; that surface is issue #238 and is not built, so the honest
 * reading of the constraint is to keep diagnostics OUT of player copy rather than to build
 * a home for them here.
 */
import type { RenderCapabilityFailure } from './render-capability';

/**
 * The capability probe said no, so boot stopped before building anything (issue #470).
 *
 * A distinct type, not a bare `Error`, because it is the one failure whose CAUSE is known
 * rather than inferred. Everything else arrives as "something threw during startup".
 * `reportError` receives it unchanged, and the branded screen reads `failure` off it
 * without re-probing.
 *
 * Lives HERE rather than in `boot.ts` since issue #325: the error and the copy that
 * explains it are one decision, and `boot.ts` importing this module while this module
 * imported the error class would have been a cycle. `boot.ts` re-exports it, so every
 * existing importer is unaffected.
 */
export class UnsupportedRenderError extends Error {
  constructor(readonly failure: RenderCapabilityFailure) {
    super(`Gameplay needs WebGL 2 and this browser did not provide it (${failure}).`);
    this.name = 'UnsupportedRenderError';
  }
}

/**
 * WHERE the failure happened, which changes what is true to say about it.
 *
 * The same thrown object means different things at the two boundaries. During `boot` the
 * game never came up at all. From a match START the player has already seen a Main Menu
 * work, so "Tanks! could not start" would read as a bug in the message rather than a
 * report of one -- whatever else is or is not wrong underneath.
 */
export type FailurePoint = 'boot' | 'match';

/** Which branded state to show. One per thing that is actually different to a player. */
export type StartupFailureKind =
  /** The browser answered, and the answer was no: no WebGL 2 context. */
  | 'unsupported-render'
  /** The probe could not even ask -- `createElement`/`getContext` threw. */
  | 'probe-blocked'
  /** Anything else during boot. The game never came up, and we do not know why. */
  | 'startup-failed'
  /**
   * A match failed to start after boot. Says what failed without vouching for the rest:
   * this is also the path a first match takes when the renderer cannot initialise, and
   * every later match would then fail the same way.
   */
  | 'match-failed';

export interface StartupFailure {
  readonly kind: StartupFailureKind;
  /** One short sentence naming the problem. */
  readonly title: string;
  /** One or two sentences: what it means, and what to try. */
  readonly detail: string;
  /**
   * The recovery action, as a label.
   *
   * ALWAYS present, and always exactly one, because at this boundary exactly one thing is
   * genuinely available. For a `page` state the page has been replaced, so there is no
   * Main Menu to go Back to and no Settings to open, and Reloading is the only real
   * recovery. For the `overlay` state the opposite holds: the menu is still there and
   * intact, so Reload would be the wrong advice -- it would throw away a working shell to
   * recover from a match that failed. Issue #325 asks for "only relevant recovery
   * actions", and which actions are relevant is decided by `presentation`.
   */
  readonly action: string;
  /**
   * WHERE this state is shown, and it is a property of the CAUSE rather than of the call
   * site (issue #325, owner ruling 2026-09-11: "overlay for transient, full page for
   * fatal").
   *
   * `page` replaces the document. Correct when nothing is left to return to -- boot never
   * finished -- and correct when the failure is FATAL rather than transient: an
   * `UnsupportedRenderError` means the renderer is unavailable, so the next match will fail
   * exactly as this one did, and handing the player back a Main Menu is an invitation to
   * prove it again.
   *
   * `overlay` keeps the working shell and blocks over it. Correct only when the shell IS
   * working and the failure might not repeat, which after this change is exactly one state:
   * a match that failed for a reason that is not the renderer being absent.
   *
   * A KNOWN RESIDUAL, recorded rather than papered over. `UnsupportedRenderError` is the
   * only typed cause, so a renderer that gets no context DURING CONSTRUCTION -- as opposed
   * to failing the probe -- arrives here as a bare `Error` and is classified transient,
   * even though every later match will fail identically. The copy is written not to vouch
   * for the rest, so it is not a lie, but the player can dismiss and retry forever. Typing
   * that failure so the classifier can call it fatal is the fix, and it belongs with
   * `session-host.ts`/`startGame` rather than here.
   */
  readonly presentation: 'page' | 'overlay';
}

/**
 * Every state, keyed by kind, so a reader can see the whole set of things the game will
 * ever say at this boundary in one place -- and so a test can assert over ALL of them
 * rather than over the ones someone remembered to list.
 */
export const STARTUP_FAILURES: Readonly<Record<StartupFailureKind, StartupFailure>> =
  Object.freeze({
    'unsupported-render': Object.freeze({
      kind: 'unsupported-render',
      title: 'This browser cannot run Tanks!',
      detail:
        'The game needs WebGL 2, and this browser is not providing it. Try a different ' +
        'browser, or turn on hardware acceleration in this one’s settings.',
      action: 'Reload',
      presentation: 'page',
    }),
    'probe-blocked': Object.freeze({
      kind: 'probe-blocked',
      title: 'This browser cannot run Tanks!',
      // Deliberately different from the one above, because the fix is different. A
      // browser that ANSWERED no needs different hardware or different settings; a
      // browser that could not be asked is usually being blocked by something the player
      // can switch off, and sending them to install another browser first would be the
      // more expensive advice for the more likely cause.
      detail:
        'Something stopped the game from checking whether this browser can draw it — ' +
        'often an extension, or a privacy mode that blocks graphics access. Try ' +
        'disabling extensions for this page, or use a different browser.',
      action: 'Reload',
      presentation: 'page',
    }),
    'startup-failed': Object.freeze({
      kind: 'startup-failed',
      title: 'Tanks! could not start.',
      // Says nothing about WHY, because at this point nothing here knows. The old
      // behaviour named WebGL on the strength of it being the likely cause, which made
      // every other cause -- blocked storage, a renderer that failed after getting its
      // context -- into a wrong instruction rather than a vague one.
      detail:
        'Something went wrong before the game was ready. Reloading usually fixes it.',
      action: 'Reload',
      presentation: 'page',
    }),
    'match-failed': Object.freeze({
      kind: 'match-failed',
      title: 'That match could not start.',
      // Deliberately does NOT say "the game itself is fine". It reads that way -- the
      // player is looking at a menu that worked a moment ago -- but this same path is
      // reached when the FIRST match fails on renderer initialisation, in which case
      // every later match will fail too and the reassurance would be a lie the player
      // disproves on their next click. Naming the match without vouching for the rest is
      // true in both cases.
      // The copy CHANGED with the presentation (issue #325, 2026-09-11 ruling). It used to
      // end "Reload to get back to the menu and try again", which was right while this
      // state replaced the page; the shell now survives, so telling the player to reload
      // would throw away a working one to recover from a single match.
      //
      // It does NOT say the menu is visible, and an earlier draft did. The HUD's layer
      // stack SWAPS surfaces -- every layer hides the one beneath it, the existing
      // confirmation included -- so what "overlay" buys is `navigation.ts`'s rule that a
      // route may never be pushed over one, not visual stacking. Measured: with the alert
      // open, `.hud-panel` reports a 0x0 box. The claim to make is about the button, which
      // returns to the menu in one press and without a reload.
      detail:
        'Something went wrong while loading the match. Go back to the menu and try again.',
      action: 'Back to menu',
      // The ONE overlay state. Reached only when the shell is up AND the cause is not the
      // renderer being unavailable -- see `classifyStartupFailure`, which checks the cause
      // before the call site precisely so a fatal failure cannot land here.
      presentation: 'overlay',
    }),
  });

/**
 * Classify a thrown value, and where it was thrown, into the state to show.
 *
 * `err` is `unknown` on purpose: a `catch` binding is, and this boundary has already been
 * reached by a bare string in production (`boot.test.ts` pins that case). Anything that is
 * not an `UnsupportedRenderError` is "we do not know", which is a state of its own rather
 * than a licence to guess.
 */
export function classifyStartupFailure(err: unknown, at: FailurePoint): StartupFailure {
  // CAUSE FIRST, call site second, and the order is the whole of the 2026-09-11 ruling.
  // It used to be the other way round, which meant `at === 'match'` short-circuited before
  // the error was examined: a browser with no WebGL 2 that got as far as a menu click was
  // told "that match could not start" and handed back a Main Menu whose every Start would
  // fail the same way. An `UnsupportedRenderError` is FATAL wherever it is thrown -- the
  // renderer is absent, not busy -- so it keeps the full-page state at both boundaries.
  if (err instanceof UnsupportedRenderError) {
    return STARTUP_FAILURES[err.failure === 'probe-failed' ? 'probe-blocked' : 'unsupported-render'];
  }
  if (at === 'match') return STARTUP_FAILURES['match-failed'];
  return STARTUP_FAILURES['startup-failed'];
}
