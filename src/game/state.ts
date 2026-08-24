import type { SimEvent } from '../sim/events';
import {
  type AppLocation,
  type AppRoute,
  type AppRouteKind,
  type GameplayPhase,
  type ResolvedSession,
  type SessionDescriptor,
  type TypedOutcome,
  campaignOverOutcome,
  campaignCompleteOutcome,
  missionClearOutcome,
  launchRoute,
  locationAtRoute,
  locationInGameplay,
  mainMenuRoute,
  outcomeIsVictory,
  outcomePhase,
  pausedPhase,
  playingPhase,
  practiceResultOutcome,
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
 * The classifyOutcome closure captures caller-side context (level position,
 * campaign completion detection, VS local-player identity) so the state
 * machine can turn a bare `type: 'win'` / `type: 'lose'` event into a typed
 * outcome without inheriting the caller's persistence or level catalogs.
 */

/**
 * Classifies the first terminal event of a `SimEvent[]` batch into the
 * session's typed outcome. Returns `null` if the event should be ignored
 * for this session (currently unused; reserved for cross-session filtering
 * later dependent issues may need). See `defaultOutcomeClassifier`.
 */
export type OutcomeClassifier = (
  events: SimEvent[],
  session: ResolvedSession,
) => TypedOutcome | null;

export interface GameStateMachineConfig {
  /**
   * Classify a terminal event into a typed outcome. Defaults to a
   * descriptor-only classifier that decides mission-clear/campaign-over/
   * practice-result/vs-match-end from the descriptor kind alone.
   *
   * Campaign completion (last level cleared) cannot be inferred from the
   * descriptor alone -- the classifier gets caller-side context through
   * closure. See loop.ts's wiring.
   */
  readonly classifyOutcome?: OutcomeClassifier;
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
   * True iff the current phase is an `outcome` whose typed outcome reads as a
   * victory (`outcomeIsVictory`). Callers that need to distinguish the specific
   * outcome kind (mission-clear vs campaign-complete vs practice-result vs
   * vs-match-end) read `outcome` directly.
   */
  readonly wasWin: boolean;
  /** True iff the outcome reads as a defeat -- the negation of `wasWin` at outcome. */
  readonly wasLose: boolean;

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
   * Reach an arbitrary AppRoute. Explicit variant of `toMainMenu`. Never from
   * inside gameplay implicitly -- callers must decide navigation first, then
   * transition here.
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
   * Same-descriptor restart of the current session. Legal only from an
   * outcome phase -- a mid-round "restart" is not a state-machine operation
   * (it belongs to the caller's world/level system). Callers that want to
   * rebuild the world with new launch-derived data should call
   * `enterGameplay(newlyResolvedSession)` instead.
   */
  restart(): void;

  /**
   * Route terminal `type: 'win'`/`'lose'` events into a typed outcome. Only
   * acts from the `playing` phase; ignored from `paused` (the sim is not
   * stepping) or any route. The first terminal event wins; a batch with
   * both `win` and `lose` maps to `win` -- matching the shipped behavior --
   * unless the classifier decides otherwise.
   */
  onEvents(events: SimEvent[]): void;

  onChange(cb: (location: AppLocation) => void): void;
}

/**
 * The default outcome classifier -- descriptor-kind alone. Campaign completion
 * (last-level clear) cannot be decided here without caller-side context, so
 * a plain `type: 'win'` on a campaign session defaults to `mission-clear`.
 * Callers that need to distinguish clears from completions provide their own
 * classifier via `GameStateMachineConfig.classifyOutcome`.
 */
export function defaultOutcomeClassifier(
  events: SimEvent[],
  session: ResolvedSession,
): TypedOutcome | null {
  const first = firstTerminalEvent(events);
  if (first === null) return null;
  const won = first.type === 'win';
  const kind = session.descriptor.kind;
  if (kind === 'campaign') {
    return won ? missionClearOutcome() : campaignOverOutcome();
  }
  if (kind === 'practice') {
    return practiceResultOutcome(won);
  }
  if (kind === 'versus') {
    return vsMatchEndOutcome(won);
  }
  const unreachable: never = kind;
  return unreachable;
}

/**
 * Extend the default classifier with campaign-completion detection using a
 * caller-provided "is this the last level?" predicate. loop.ts owns the level
 * catalog, so completion cannot be inferred from the descriptor alone.
 */
export function classifyWithCampaignCompletion(
  isFinalCampaignLevel: () => boolean,
): OutcomeClassifier {
  return (events, session) => {
    const first = firstTerminalEvent(events);
    if (first === null) return null;
    const won = first.type === 'win';
    const kind = session.descriptor.kind;
    if (kind === 'campaign') {
      if (won) return isFinalCampaignLevel() ? campaignCompleteOutcome() : missionClearOutcome();
      return campaignOverOutcome();
    }
    if (kind === 'practice') return practiceResultOutcome(won);
    if (kind === 'versus') return vsMatchEndOutcome(won);
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

export function createGameStateMachine(config: GameStateMachineConfig = {}): GameStateMachine {
  const classify = config.classifyOutcome ?? defaultOutcomeClassifier;
  const subscribers: Array<(location: AppLocation) => void> = [];
  let current: AppLocation = locationAtRoute(launchRoute());

  function emit(): void {
    for (const cb of subscribers) cb(current);
  }

  function setLocation(next: AppLocation): void {
    if (locationsEqual(current, next)) return;
    current = next;
    emit();
  }

  function transitionToRoute(kind: AppRouteKind): AppRoute {
    switch (kind) {
      case 'launch': return launchRoute();
      case 'main-menu': return mainMenuRoute();
      case 'campaign': return { kind: 'campaign' };
      case 'practice': return { kind: 'practice' };
      case 'versus-setup': return { kind: 'versus-setup' };
      case 'settings': return { kind: 'settings' };
      case 'records': return { kind: 'records' };
      case 'customize': return { kind: 'customize' };
      case 'developer-tools': return { kind: 'developer-tools' };
      default: {
        const unreachable: never = kind;
        return unreachable;
      }
    }
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
    get wasWin(): boolean {
      if (current.kind !== 'gameplay') return false;
      if (current.phase.kind !== 'outcome') return false;
      return outcomeIsVictory(current.phase.outcome);
    },
    get wasLose(): boolean {
      if (current.kind !== 'gameplay') return false;
      if (current.phase.kind !== 'outcome') return false;
      return !outcomeIsVictory(current.phase.outcome);
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
      setLocation(locationAtRoute(transitionToRoute(kind)));
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

    restart(): void {
      // Same-descriptor restart of the CURRENT resolved session -- the world
      // rebuild lives in the caller (loop.ts's `switchTo` / `landOnCampaignBoard`);
      // this just moves the phase back to `playing`. Legal only from an
      // outcome phase; a mid-round "restart" is not a state-machine operation.
      if (current.kind !== 'gameplay') return;
      if (current.phase.kind !== 'outcome') return;
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

    onChange(cb: (location: AppLocation) => void): void {
      subscribers.push(cb);
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
      return b.kind === 'vs-match-end' && a.localPlayerWon === b.localPlayerWon;
    default: {
      const unreachable: never = a;
      return unreachable;
    }
  }
}
