import type { SimEvent } from '../sim/events';
import {
  type AppLocation,
  type AppRoute,
  type AppRouteKind,
  type GameplayPhase,
  type ResolvedSession,
  type SessionDescriptor,
  type TypedOutcome,
  type VersusResult,
  campaignOverOutcome,
  campaignCompleteOutcome,
  missionClearOutcome,
  launchRoute,
  legacyOutcomePresentation,
  locationAtRoute,
  locationInGameplay,
  mainMenuRoute,
  outcomePhase,
  pausedPhase,
  playingPhase,
  practiceResultOutcome,
  routeFor,
  versusDraw,
  vsMatchEndOutcome,
} from './app-state';

/**
 * The session state machine, backed by the canonical AppLocation model.
 *
 * A single AppLocation is the primary owner of the display. Every transition
 * is a legal move on that model -- illegal moves are refused rather than
 * silently falling through into an unrelated route or phase. Navigation-only
 * transitions (`toMainMenu`, `dismissLaunch`) operate on state alone; they do
 * not resolve arenas, derive seeds, build worlds, advance simulation, or
 * mutate persistence.
 *
 * The legacy `GameState` string union -- with `title` for Main Menu and
 * generic `win`/`lose` for outcomes -- is retired. Production consumers now
 * read AppLocation (and its `route`, `descriptor`, `phase`, `outcome`
 * accessors), so screens do not infer session identity from URL provenance,
 * world mode, or a `initialVersusConfig` presence check.
 *
 * The classifyOutcome closure captures caller-side context -- whether the level
 * that ended was the last in the sequence, and who actually survived a versus
 * match -- so the machine can turn a bare `type: 'win'`/`type: 'lose'` event
 * into a typed outcome without inheriting the caller's persistence, level
 * catalogs, or world.
 */

/**
 * Classifies the first terminal event of a `SimEvent[]` batch into the
 * session's typed outcome. Returns `null` when the batch carries no terminal
 * event at all, which is the overwhelmingly common case -- most frames end
 * without ending the session. Build one with `createOutcomeClassifier`.
 */
export type OutcomeClassifier = (
  events: SimEvent[],
  session: ResolvedSession,
) => TypedOutcome | null;

export interface GameStateMachineConfig {
  /**
   * Classify a terminal event into a typed outcome.
   *
   * REQUIRED, with no default. A descriptor-only default existed once and was
   * exactly what let production ship un-typed outcomes while a context-aware
   * classifier sat unused in tests (issue #316 review, finding 1). Making this
   * mandatory means every construction site -- production included -- must
   * state how Campaign Complete and versus attribution are decided.
   *
   * Build one with `createOutcomeClassifier`.
   */
  readonly classifyOutcome: OutcomeClassifier;
  /**
   * Where this session OPENS. Defaults to the Launch route, which is what every session
   * did unconditionally before issue #317.
   *
   * The Launch gate ("Press any key or tap to begin") is a PAGE-level handoff, not a
   * session-level one, and this is the field that lets those two disagree. `boot.ts`
   * disposes the whole handle and builds a fresh session on every Campaign<->Versus
   * switch, so a state machine that can only start at `launch` re-shows the splash on
   * every one of them -- the acceptance criterion issue #317 calls "the Launch gate
   * appears at most once per document load".
   *
   * Deliberately OPTIONAL, unlike `classifyOutcome` above. That one is required because a
   * default silently shipped un-typed outcomes to production; this one's default is the
   * conservative direction -- a caller that forgets it shows the splash, which is the
   * pre-#317 behavior and is merely redundant, not wrong. The page-scoped owner
   * (`app-shell.ts`) is what actually answers it in production.
   */
  readonly initialRoute?: 'launch' | 'main-menu';
}

export interface GameStateMachine {
  /** The single authoritative primary surface. Always defined. */
  readonly location: AppLocation;

  // --- Ergonomic accessors -- pure derivatives of `location`, read live so
  //     tests and consumers do not need to pattern-match everywhere. ---
  readonly route: AppRoute | null;
  readonly session: ResolvedSession | null;
  readonly descriptor: SessionDescriptor | null;
  readonly phase: GameplayPhase | null;
  readonly outcome: TypedOutcome | null;

  readonly atLaunch: boolean;
  readonly atMainMenu: boolean;
  readonly atRoute: boolean;
  readonly inGameplay: boolean;
  readonly isPlaying: boolean;
  readonly isPaused: boolean;
  readonly hasOutcome: boolean;
  /** Alias of `isPlaying`; the driver reads this to gate simulation. */
  readonly isSimulating: boolean;
  /**
   * True iff the current phase is an `outcome` that PRESENTS as a victory --
   * `legacyOutcomePresentation`, the explicitly-named compatibility projection.
   * This is a presentation question, never a claim about which seat won: read
   * `outcome` (and, for versus, its `VersusResult`) for that.
   */
  readonly presentsAsWin: boolean;
  /** True iff the outcome presents as a defeat -- the negation at outcome. */
  readonly presentsAsLose: boolean;

  // --- Navigation-only transitions -- state only, never a world/seed/persist. ---

  /**
   * Launch route -> Main Menu route. ONLY from the Launch route, so a stray
   * gesture during play does nothing. Exists to be driven by the page-level
   * gesture that also lets `audio/engine.ts` unlock the AudioContext.
   */
  dismissLaunch(): void;

  /**
   * Reach Main Menu. From any location; navigation-only, so quitting from a
   * paused or outcome session lands here without constructing or mutating
   * anything session-scoped.
   */
  toMainMenu(): void;

  /**
   * Reach an arbitrary AppRoute. Explicit variant of `toMainMenu`.
   *
   * LEGAL FROM ACTIVE GAMEPLAY, deliberately -- see the transition matrix on
   * `createGameStateMachine`. Navigating to a route from `playing`/`paused`/
   * `outcome` is how Quit works: it ABANDONS the running session, handing the
   * primary surface back to a route. The state machine drops its reference to
   * the resolved session; disposing anything world-side (the world itself, the
   * replay recorder, renderer resources) is the caller's job and always was.
   *
   * An earlier draft of this doc claimed callers had to end gameplay first.
   * That was never enforced and never true of the shipped Quit path, so the
   * rule is stated correctly here and pinned by tests rather than left as a
   * comment the code contradicts.
   */
  toRoute(kind: AppRouteKind): void;

  // --- Gameplay lifecycle. ---

  /**
   * Enter gameplay with a resolved session instance. The session owns its
   * seed and arena. Legal from any route or from an outcome phase (rematch);
   * illegal from within `playing`/`paused` (a caller must first end the
   * running session).
   */
  enterGameplay(session: ResolvedSession): void;

  /**
   * Playing -> paused. No-op from any other location, matching the legacy
   * guard: a shot or a pause key during launch/main-menu/outcome must not
   * flip the display.
   */
  pause(): void;

  /**
   * Paused -> playing. No-op from any other location.
   */
  resume(): void;

  /**
   * Route terminal `type: 'win'`/`'lose'` events into a typed outcome. Only
   * acts from the `playing` phase; ignored from `paused` (the sim is not
   * stepping) or any route. The first terminal event wins; a batch with
   * both `win` and `lose` maps to `win` -- matching the shipped behavior --
   * unless the classifier decides otherwise.
   */
  onEvents(events: SimEvent[]): void;

  /**
   * Subscribe to location changes. Returns the unsubscribe.
   *
   * The RETURN VALUE is not optional for a subscriber that can die before the machine
   * does. The machine is page-scoped since issue #468 while its main subscriber is
   * session-scoped (`loop.ts`), so a session disposed without calling this keeps running
   * its subscriber on every later change, with its own closures -- its level, its
   * identity, its disposed input controller. Measured before the unsubscribe existed
   * (loop.test.ts, "a retired session stops observing the page state machine"): a
   * retired Practice session on level 3 recorded level 3 as cleared when the LIVE
   * campaign session cleared level 1, and a retired campaign session advanced the shared
   * run with its own stale life count before the live one wrote the real value.
   */
  onChange(cb: (location: AppLocation) => void): () => void;
}

/**
 * The caller-side facts a terminal event must be interpreted against.
 *
 * Neither can be answered from a `ResolvedSession` alone, and both are owned by
 * `loop.ts`: it holds the level sequence, and it holds the driver whose world
 * emitted the event.
 */
export interface OutcomeContext {
  /**
   * Is the level that just ended the LAST in this session's own sequence?
   * Decides Mission Clear vs Campaign Complete -- the distinction issue #316
   * requires and that a descriptor cannot carry.
   */
  readonly isFinalCampaignLevel: () => boolean;
  /**
   * Who actually survived a versus match, derived from the world that emitted
   * the event. See `versusResultFromWorld` in `loop.ts`: FFA reports the
   * surviving slot, teams the surviving team, and a simultaneous elimination
   * reports a draw. Never a guess.
   */
  readonly versusResult: () => VersusResult;
}

/**
 * Build the production outcome classifier from its caller-side context.
 *
 * THIS IS THE ONLY CLASSIFIER. An earlier revision shipped a
 * `defaultOutcomeClassifier` that decided everything from the descriptor kind
 * alone, plus a context-aware variant that only tests ever constructed -- so
 * production silently classified every campaign victory as `mission-clear` and
 * every versus completion as a local-player win. Both were the review's
 * findings 1 and 2. Removing the descriptor-only default removes the fallback
 * that made those defects invisible: there is no longer a classifier that CAN
 * be constructed without saying how completion and versus attribution are
 * decided.
 */
export function createOutcomeClassifier(context: OutcomeContext): OutcomeClassifier {
  return (events, session) => {
    const first = firstTerminalEvent(events);
    if (first === null) return null;
    const won = first.type === 'win';
    const kind = session.descriptor.kind;
    if (kind === 'campaign') {
      // A campaign LOSS is always the end of the run: there are no lives left,
      // whichever level it happened on.
      if (!won) return campaignOverOutcome();
      return context.isFinalCampaignLevel() ? campaignCompleteOutcome() : missionClearOutcome();
    }
    if (kind === 'practice') {
      // Practice is isolated by definition: clearing the level or running out
      // of lives on it are both just "how the attempt ended".
      return practiceResultOutcome(won);
    }
    if (kind === 'versus') {
      // Derived from the world, never from `won`. The sim's `win` means "one
      // side remains" (which side is a fact about the world, not about the
      // event) and its `lose` means "none remain", i.e. a draw -- so a
      // `won`-shaped boolean cannot express either honestly.
      return vsMatchEndOutcome(won ? context.versusResult() : versusDraw());
    }
    const unreachable: never = kind;
    return unreachable;
  };
}

function firstTerminalEvent(events: SimEvent[]): { type: 'win' } | { type: 'lose' } | null {
  for (const ev of events) {
    if (ev.type === 'win' || ev.type === 'lose') return ev;
  }
  return null;
}

export function createGameStateMachine(config: GameStateMachineConfig): GameStateMachine {
  const classify = config.classifyOutcome;
  const subscribers: Array<(location: AppLocation) => void> = [];
  let current: AppLocation = locationAtRoute(
    config.initialRoute === 'main-menu' ? mainMenuRoute() : launchRoute(),
  );

  function emit(): void {
    // Over a SNAPSHOT: a subscriber may unsubscribe itself or a sibling while this runs
    // (a session disposing inside a state change), and splicing the live array under a
    // `for...of` skips the element after the removed one.
    for (const cb of [...subscribers]) cb(current);
  }

  function setLocation(next: AppLocation): void {
    if (locationsEqual(current, next)) return;
    current = next;
    emit();
  }

  const machine: GameStateMachine = {
    get location(): AppLocation { return current; },
    get route(): AppRoute | null {
      return current.kind === 'route' ? current.route : null;
    },
    get session(): ResolvedSession | null {
      return current.kind === 'gameplay' ? current.session : null;
    },
    get descriptor(): SessionDescriptor | null {
      return current.kind === 'gameplay' ? current.session.descriptor : null;
    },
    get phase(): GameplayPhase | null {
      return current.kind === 'gameplay' ? current.phase : null;
    },
    get outcome(): TypedOutcome | null {
      if (current.kind !== 'gameplay') return null;
      return current.phase.kind === 'outcome' ? current.phase.outcome : null;
    },
    get atLaunch(): boolean {
      return current.kind === 'route' && current.route.kind === 'launch';
    },
    get atMainMenu(): boolean {
      return current.kind === 'route' && current.route.kind === 'main-menu';
    },
    get atRoute(): boolean { return current.kind === 'route'; },
    get inGameplay(): boolean { return current.kind === 'gameplay'; },
    get isPlaying(): boolean {
      return current.kind === 'gameplay' && current.phase.kind === 'playing';
    },
    get isPaused(): boolean {
      return current.kind === 'gameplay' && current.phase.kind === 'paused';
    },
    get hasOutcome(): boolean {
      return current.kind === 'gameplay' && current.phase.kind === 'outcome';
    },
    get isSimulating(): boolean {
      return current.kind === 'gameplay' && current.phase.kind === 'playing';
    },
    get presentsAsWin(): boolean {
      if (current.kind !== 'gameplay') return false;
      if (current.phase.kind !== 'outcome') return false;
      return legacyOutcomePresentation(current.phase.outcome) === 'win';
    },
    get presentsAsLose(): boolean {
      if (current.kind !== 'gameplay') return false;
      if (current.phase.kind !== 'outcome') return false;
      return legacyOutcomePresentation(current.phase.outcome) === 'lose';
    },

    dismissLaunch(): void {
      // Guarded: from anywhere except Launch, a stray gesture must not yank a
      // live game or a menu-selected screen back to the launch handoff.
      if (current.kind === 'route' && current.route.kind === 'launch') {
        setLocation(locationAtRoute(mainMenuRoute()));
      }
    },

    toMainMenu(): void {
      setLocation(locationAtRoute(mainMenuRoute()));
    },

    toRoute(kind: AppRouteKind): void {
      setLocation(locationAtRoute(routeFor(kind)));
    },

    enterGameplay(session: ResolvedSession): void {
      // Legal from any route or from an outcome phase (rematch's fresh
      // resolved instance) -- illegal from inside `playing`/`paused`, because
      // there is a running session that must be ended first. Callers that
      // WANT to hot-switch mid-round go through toMainMenu() (or a specific
      // route) first, then enterGameplay again.
      if (current.kind === 'gameplay' && current.phase.kind !== 'outcome') {
        throw new Error(
          `enterGameplay: cannot enter gameplay from '${current.phase.kind}' phase; ` +
            `end the running session first`,
        );
      }
      setLocation(locationInGameplay(session, playingPhase()));
    },

    pause(): void {
      if (current.kind !== 'gameplay') return;
      if (current.phase.kind !== 'playing') return;
      setLocation(locationInGameplay(current.session, pausedPhase()));
    },

    resume(): void {
      if (current.kind !== 'gameplay') return;
      if (current.phase.kind !== 'paused') return;
      setLocation(locationInGameplay(current.session, playingPhase()));
    },


    onEvents(events: SimEvent[]): void {
      // Only from `playing`. A `paused` or ended session must not flip on a
      // stray queued frame (see the legacy pause-and-lose test).
      if (current.kind !== 'gameplay') return;
      if (current.phase.kind !== 'playing') return;
      const outcome = classify(events, current.session);
      if (outcome === null) return;
      setLocation(locationInGameplay(current.session, outcomePhase(outcome)));
    },

    onChange(cb: (location: AppLocation) => void): () => void {
      subscribers.push(cb);
      return () => {
        // By identity, once: a second call finds nothing and removes nothing, so a
        // subscriber registered twice (which nothing does) would need two releases.
        const i = subscribers.indexOf(cb);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
  };

  return machine;
}

/** Structural equality on locations -- descriptor identity + phase identity. */
function locationsEqual(a: AppLocation, b: AppLocation): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'route' && b.kind === 'route') {
    return a.route.kind === b.route.kind;
  }
  if (a.kind === 'gameplay' && b.kind === 'gameplay') {
    if (a.session !== b.session) return false; // reference-identity: same launch
    return phaseEqual(a.phase, b.phase);
  }
  return false;
}

function phaseEqual(a: GameplayPhase, b: GameplayPhase): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'outcome' && b.kind === 'outcome') {
    return outcomeEqual(a.outcome, b.outcome);
  }
  return true;
}

function outcomeEqual(a: TypedOutcome, b: TypedOutcome): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'mission-clear':
    case 'campaign-complete':
    case 'campaign-over':
      return true;
    case 'practice-result':
      return b.kind === 'practice-result' && a.cleared === b.cleared;
    case 'vs-match-end':
      return b.kind === 'vs-match-end' && versusResultEqual(a.result, b.result);
    default: {
      const unreachable: never = a;
      return unreachable;
    }
  }
}

function versusResultEqual(a: VersusResult, b: VersusResult): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'winner-slot':
      return b.kind === 'winner-slot' && a.slot === b.slot;
    case 'winner-team':
      return b.kind === 'winner-team' && a.team === b.team;
    case 'draw':
      return true;
    default: {
      const unreachable: never = a;
      return unreachable;
    }
  }
}
