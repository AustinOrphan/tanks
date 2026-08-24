import type { VersusConfig } from './versus-config';

/**
 * The canonical model for "where the player is in the application" and
 * "what session, if any, they are inside" -- a pure, dataclass-only module
 * that no HUD, DOM, renderer, audio, storage, or dev-flag parser reaches.
 *
 * Four orthogonal concepts live here: application routes (Main Menu et al),
 * session descriptors (validated player intent for Campaign/Practice/Versus),
 * resolved session instances (one launched match's seed and arena), and
 * gameplay phases with typed outcomes. AppLocation is the single root
 * discriminant that makes an application route and active gameplay mutually
 * exclusive as the primary owner of the display. Developer mode is orthogonal
 * metadata carried alongside a descriptor, not a fourth session kind; the
 * translation from developer flags and menu gestures to a descriptor lives in
 * `session-intent.ts`, which is the ONE boundary allowed to read `DevFlags`.
 *
 * Consumers of this model receive AppLocation as one value; they do not read
 * a legacy `title` string that means Main Menu, and they do not infer outcome
 * meaning from `win`/`lose`. Screen-side inference is the exact seam issue #316
 * removes: outcomes are typed here, session identity is on the descriptor here,
 * and navigation-only transitions cannot resolve an arena, derive a seed,
 * build a world, advance simulation, or mutate persistence.
 */

// ---------------------------------------------------------------------------
// Application routes
// ---------------------------------------------------------------------------

/**
 * The application screens the player can be on when NOT in active gameplay.
 * These are structural destinations; overlay/history behavior belongs to #318.
 *
 * Every projection off this union (HUD surface, music context) is an exhaustive
 * `switch` with a `never` fallthrough, so ADDING a route is a compile error at
 * each projection rather than a silent fold into Main Menu.
 */
export type AppRoute =
  | { readonly kind: 'launch' }
  | { readonly kind: 'main-menu' }
  | { readonly kind: 'campaign' }
  | { readonly kind: 'practice' }
  | { readonly kind: 'versus-setup' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'records' }
  | { readonly kind: 'customize' }
  | { readonly kind: 'developer-tools' };

export type AppRouteKind = AppRoute['kind'];

/**
 * Every route kind, in declaration order. Exported so a projection test can
 * sweep the complete population rather than a hand-kept subset that a newly
 * added route could silently miss.
 */
export const APP_ROUTE_KINDS: readonly AppRouteKind[] = [
  'launch',
  'main-menu',
  'campaign',
  'practice',
  'versus-setup',
  'settings',
  'records',
  'customize',
  'developer-tools',
];

// ---------------------------------------------------------------------------
// Session descriptors -- retained, validated player intent
// ---------------------------------------------------------------------------

/**
 * The validated intent/configuration for one gameplay kind. Retained across
 * navigation and reusable to launch fresh resolved instances (a rematch reuses
 * the SAME descriptor to build a NEW resolved instance). A descriptor never
 * owns launch-derived state such as a seed or a resolved arena; that lives on
 * a ResolvedSession instead. Do NOT put DOM nodes, callbacks, worlds, timers,
 * gamepad objects, or other live resources on a descriptor.
 *
 * EXACTLY THREE KINDS. Developer entry does not add a fourth: a developer boot
 * produces one of these three, with its provenance recorded separately in
 * `DeveloperMetadata`. See `session-intent.ts`.
 */
export type SessionDescriptor =
  | CampaignSessionDescriptor
  | PracticeSessionDescriptor
  | VersusSessionDescriptor;

export type SessionDescriptorKind = SessionDescriptor['kind'];

export interface CampaignSessionDescriptor {
  readonly kind: 'campaign';
}

/**
 * What an isolated, run-neutral session is played ON.
 *
 * Practice is the canonical kind for "play that must not consume, restore,
 * replace, advance, or complete the active campaign run" (CLAUDE.md's rule).
 * Three shipped things have exactly that shape, and this union is what lets
 * all three be described truthfully without inventing a fourth session kind:
 *
 *  - a menu Level-Select pick (`campaign-level`);
 *  - a developer level jump, `?dev=1&level=N` (`campaign-level`, with
 *    `DeveloperMetadata.sessionOrigin === 'level-jump'` recording the
 *    provenance);
 *  - the developer sandbox, `?dev=1&level=sandbox` (`sandbox`), whose synthetic
 *    level is not a member of `CAMPAIGN_LEVELS` at all and therefore has no
 *    truthful ordinal to report.
 *
 * The old shape carried a bare `levelOrdinal: number`, which could not
 * represent the sandbox at all -- issue #316's review required this be fixed
 * here rather than deferred.
 */
export type PracticeTarget =
  | {
      readonly kind: 'campaign-level';
      /**
       * 1-based ordinal into THIS SESSION's level sequence. Stored as an
       * ordinal, not as a CampaignLevel reference, so a descriptor stays plain
       * validated data (no world/level object identity leaks in). The level
       * system is authoritative for what that ordinal names at launch time.
       */
      readonly levelOrdinal: number;
    }
  | { readonly kind: 'sandbox' };

export interface PracticeSessionDescriptor {
  readonly kind: 'practice';
  readonly target: PracticeTarget;
}

/**
 * The match rules one versus session plays under -- an IMMUTABLE SNAPSHOT.
 *
 * Deliberately not the caller's own `VersusConfig` object: the setup pane owns
 * a long-lived mutable `versusConfigState` it keeps editing across rematches,
 * and holding that object by reference meant a later pane edit silently
 * rewrote the retained intent of a session already in progress. Every field
 * here is a primitive and the record is frozen, so retained intent cannot be
 * altered after the fact.
 */
export interface VersusRules {
  readonly mode: 'ffa' | 'teams';
  /**
   * How many player slots share the board. 2-4 through the setup pane; a
   * developer-flag versus world (`?dev=1&mode=ffa`) may legitimately be 1,
   * since `players` is a separate flag that may be absent.
   */
  readonly players: number;
  readonly friendlyFire: boolean;
  /**
   * Stock per player when the match was configured through the setup pane.
   * `null` for a developer-flag versus world, which has no stock flag and
   * takes `createWorldFor`'s own default -- recording a fabricated number
   * there would be the same class of untruth `localPlayerWon` was.
   */
  readonly stock: number | null;
  /**
   * The pane's ARENA SELECTION, retained UNRESOLVED: a stable VS catalog id or
   * the literal `'random'`. Resolution to a concrete arena happens exactly once
   * per launch, and the result lives on `ResolvedSession.arenaId` -- never
   * written back here, which is what lets one retained `'random'` descriptor
   * produce distinct rematch instances.
   *
   * `null` when the arena was not chosen through the pane: a developer-flag
   * versus world plays on whatever arena the level system's own `start` level
   * names.
   */
  readonly arenaSelection: string | null;
}

export interface VersusSessionDescriptor {
  readonly kind: 'versus';
  readonly rules: VersusRules;
}

// ---------------------------------------------------------------------------
// Resolved session instance -- one launch's seed and arena
// ---------------------------------------------------------------------------

/**
 * A single actual launched match. Owns the launch-derived values (seed,
 * resolved arena id) so a retained descriptor can create distinct rematch
 * instances without being mutated into a mixture of player choice and launch
 * result. Contains plain data and identifiers only -- no world/render/audio
 * objects.
 */
export interface ResolvedSession {
  readonly descriptor: SessionDescriptor;
  /** Launch-derived world seed. Never 0 (mulberry32 treats 0 as degenerate). */
  readonly seed: number;
  /**
   * The concrete arena id this instance was built on. For VS: the resolved
   * result of `'random'` (or the concrete choice) at the launch boundary. For
   * Campaign/Practice: the level's own arena id at that ordinal.
   */
  readonly arenaId: string;
}

// ---------------------------------------------------------------------------
// Typed outcomes
// ---------------------------------------------------------------------------

/**
 * How a versus match actually ended.
 *
 * THE UNTRUTH THIS REPLACES: the sim's `win` event in `ffa`/`teams` means
 * "exactly one player (or exactly one team) is not eliminated" -- see
 * `resolveStatusFfa`/`resolveStatusTeams` in `sim/world.ts`. It does NOT mean
 * "player 1 won", and in a couch match every participant is local, so there is
 * no single "local player" to have won. Symmetrically the sim's `lose` event in
 * those modes means ZERO remain -- a simultaneous final elimination, which is a
 * DRAW, not a defeat for a particular seat.
 *
 * So the payload names the seat or side that actually survived, derived from
 * the world that emitted the event, or records the draw. Nothing here is
 * inferred from a generic boolean.
 */
export type VersusResult =
  /** FFA: the surviving slot (`Tank.controlledBy`). */
  | { readonly kind: 'winner-slot'; readonly slot: number }
  /** Teams: the surviving team (`Tank.team`, i.e. `teamOf(slot)`). */
  | { readonly kind: 'winner-team'; readonly team: number }
  /**
   * No survivor: every player (or every team) was eliminated on the same tick.
   * The sim reports this as `lose`; it is a draw, and the model says so.
   */
  | { readonly kind: 'draw' };

/**
 * The session-specific meaning of a completed session. Consumers must not
 * infer outcome meaning from a session kind plus a generic `win`/`lose`
 * boolean; the payload carried here IS the meaning.
 *
 * Owned surface issues (Main Menu, outcome redesign) may add fields; do not
 * synthesize outcome kinds from session kind alone at screen sites.
 */
export type TypedOutcome =
  | { readonly kind: 'mission-clear' }
  | { readonly kind: 'campaign-over' }
  | { readonly kind: 'campaign-complete' }
  | { readonly kind: 'practice-result'; readonly cleared: boolean }
  | { readonly kind: 'vs-match-end'; readonly result: VersusResult };

export type TypedOutcomeKind = TypedOutcome['kind'];

/** Every outcome kind, for population-complete projection sweeps. */
export const TYPED_OUTCOME_KINDS: readonly TypedOutcomeKind[] = [
  'mission-clear',
  'campaign-over',
  'campaign-complete',
  'practice-result',
  'vs-match-end',
];

/** The two-valued presentation the shipped outcome screen and music bed have. */
export type OutcomePresentation = 'win' | 'lose';

/**
 * THE LEGACY WIN/LOSE COMPATIBILITY PROJECTION -- named that way on purpose.
 *
 * The shipped outcome screen and music director have exactly two shapes: a
 * victory panel with the victory suite, and a defeat panel with the defeat
 * suite. This function is the ONE place a typed outcome is flattened onto
 * that pair, and it is a statement about PRESENTATION, never a claim about
 * who won:
 *
 *  - a decided versus match (any surviving slot or team) presents as a victory,
 *    because the shipped screen's "You Win!" panel is what a decided couch
 *    match has always shown to the room. It does NOT assert that the local
 *    player, or player 1, was the survivor -- read `VersusResult` for that.
 *  - a versus DRAW presents as a defeat, matching the shipped behaviour for the
 *    simultaneous-elimination `lose` event.
 *
 * When #279/#323 redesign the result screens they should read `TypedOutcome`
 * and `VersusResult` directly and retire this projection, rather than growing
 * a third presentation value here.
 */
export function legacyOutcomePresentation(outcome: TypedOutcome): OutcomePresentation {
  switch (outcome.kind) {
    case 'mission-clear':
    case 'campaign-complete':
      return 'win';
    case 'campaign-over':
      return 'lose';
    case 'practice-result':
      return outcome.cleared ? 'win' : 'lose';
    case 'vs-match-end':
      return outcome.result.kind === 'draw' ? 'lose' : 'win';
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// Gameplay phase
// ---------------------------------------------------------------------------

/**
 * Where the active resolved session is in its lifecycle. Distinct from an
 * AppRoute: pause is a phase of a live session, not a peer of Main Menu.
 */
export type GameplayPhase =
  | { readonly kind: 'playing' }
  | { readonly kind: 'paused' }
  | { readonly kind: 'outcome'; readonly outcome: TypedOutcome };

export type GameplayPhaseKind = GameplayPhase['kind'];

// ---------------------------------------------------------------------------
// Root application location
// ---------------------------------------------------------------------------

/**
 * The one authoritative primary surface. An AppRoute (Main Menu, Settings...)
 * and active gameplay cannot both own the display at once; issue #316's core
 * architectural boundary is this discriminant. Overlays (pause dialogs,
 * destructive-confirm modals) belong on top of a location; they do not
 * appear here.
 */
export type AppLocation =
  | { readonly kind: 'route'; readonly route: AppRoute }
  | { readonly kind: 'gameplay'; readonly session: ResolvedSession; readonly phase: GameplayPhase };

// ---------------------------------------------------------------------------
// Developer metadata
// ---------------------------------------------------------------------------

/**
 * Which developer flag, if any, decided this session's KIND. Orthogonal to the
 * descriptor: a `'versus-flags'` boot still produces an ordinary Versus
 * descriptor, and a `'level-jump'` boot still produces an ordinary Practice
 * descriptor. Developer mode is never a fourth session kind.
 */
export type DeveloperSessionOrigin = 'level-jump' | 'sandbox' | 'versus-flags';

/**
 * Orthogonal provenance for a developer-driven boot.
 *
 * Produced by the one translation boundary (`resolveBootSessionContext`,
 * `session-intent.ts`) alongside the descriptor, and carried on the session
 * context so consumers that care WHY a session has the shape it does read one
 * value rather than re-deriving it from scattered flag reads. No shipped
 * player-facing screen reads it today; #238 (Developer Tools route) and #240
 * (isolated developer persistence) are its intended consumers.
 */
export interface DeveloperMetadata {
  /** Was the `dev` gate itself on? Every other developer flag requires it. */
  readonly active: boolean;
  /**
   * What (if anything) developer flags steered the session KIND to. `null`
   * when no dev flag decided the kind, even if developer mode is on -- e.g.
   * `?dev=1&aimRay=1` is an ordinary Campaign session with `active: true`.
   */
  readonly sessionOrigin: DeveloperSessionOrigin | null;
  /**
   * The 1-based level `?dev=1&level=N` jumped to, independent of the session
   * kind it produced. Recorded separately from `sessionOrigin` because both
   * facts can be true at once: `?dev=1&mode=ffa&level=3` is a VERSUS session
   * (`sessionOrigin: 'versus-flags'`) played on level 3's arena
   * (`levelJump: 3`). A single enum could not say both.
   */
  readonly levelJump: number | null;
}

export const DEV_METADATA_OFF: DeveloperMetadata = Object.freeze({
  active: false,
  sessionOrigin: null,
  levelJump: null,
});

// ---------------------------------------------------------------------------
// Pure constructors
// ---------------------------------------------------------------------------

export function launchRoute(): AppRoute { return { kind: 'launch' }; }
export function mainMenuRoute(): AppRoute { return { kind: 'main-menu' }; }
export function campaignRoute(): AppRoute { return { kind: 'campaign' }; }
export function practiceRoute(): AppRoute { return { kind: 'practice' }; }
export function versusSetupRoute(): AppRoute { return { kind: 'versus-setup' }; }
export function settingsRoute(): AppRoute { return { kind: 'settings' }; }
export function recordsRoute(): AppRoute { return { kind: 'records' }; }
export function customizeRoute(): AppRoute { return { kind: 'customize' }; }
export function developerToolsRoute(): AppRoute { return { kind: 'developer-tools' }; }

/** Build the AppRoute value for a route kind. Exhaustive by construction. */
export function routeFor(kind: AppRouteKind): AppRoute {
  switch (kind) {
    case 'launch': return launchRoute();
    case 'main-menu': return mainMenuRoute();
    case 'campaign': return campaignRoute();
    case 'practice': return practiceRoute();
    case 'versus-setup': return versusSetupRoute();
    case 'settings': return settingsRoute();
    case 'records': return recordsRoute();
    case 'customize': return customizeRoute();
    case 'developer-tools': return developerToolsRoute();
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

export function campaignDescriptor(): CampaignSessionDescriptor {
  return Object.freeze({ kind: 'campaign' as const });
}

/**
 * A Practice descriptor on a campaign level, by 1-based ordinal. Rejects
 * non-integer, non-positive, or 0 ordinals -- practice cannot describe a
 * level that does not exist in the sequence's namespace.
 */
export function practiceLevelDescriptor(levelOrdinal: number): PracticeSessionDescriptor {
  if (!Number.isInteger(levelOrdinal) || levelOrdinal < 1) {
    throw new Error(
      `practiceLevelDescriptor: levelOrdinal must be a 1-based integer, got ${levelOrdinal}`,
    );
  }
  return Object.freeze({
    kind: 'practice' as const,
    target: Object.freeze({ kind: 'campaign-level' as const, levelOrdinal }),
  });
}

/**
 * A Practice descriptor on the developer sandbox. Carries no ordinal: the
 * sandbox's synthetic level is not a member of any campaign sequence, so any
 * number reported here would be a fabrication.
 */
export function practiceSandboxDescriptor(): PracticeSessionDescriptor {
  return Object.freeze({
    kind: 'practice' as const,
    target: Object.freeze({ kind: 'sandbox' as const }),
  });
}

/**
 * Snapshot the setup pane's `VersusConfig` into immutable retained rules.
 *
 * The pane's own config object stays mutable and stays the pane's (loop.ts
 * hands it back for prefill); this is the copy the session keeps. Rejects
 * clearly-invalid selections -- the pane's own filters exist to prevent this
 * reaching launch, but the descriptor boundary is the last line that can
 * refuse.
 */
export function versusRulesFromConfig(config: VersusConfig): VersusRules {
  if (config.players !== 2 && config.players !== 3 && config.players !== 4) {
    throw new Error(`versusRulesFromConfig: players must be 2, 3, or 4, got ${config.players}`);
  }
  if (config.mode !== 'ffa' && config.mode !== 'teams') {
    throw new Error(`versusRulesFromConfig: mode must be 'ffa' or 'teams', got '${config.mode}'`);
  }
  if (!Number.isInteger(config.stock) || config.stock < 1) {
    throw new Error(`versusRulesFromConfig: stock must be a positive integer, got ${config.stock}`);
  }
  if (typeof config.arenaId !== 'string' || config.arenaId === '') {
    throw new Error(`versusRulesFromConfig: arenaId must be a non-empty string`);
  }
  return Object.freeze({
    mode: config.mode,
    players: config.players,
    friendlyFire: config.friendlyFire,
    stock: config.stock,
    // UNRESOLVED on purpose -- may still be the literal 'random'.
    arenaSelection: config.arenaId,
  });
}

/**
 * Retained rules for a developer-flag versus world (`?dev=1&mode=ffa|teams`).
 *
 * No stock and no arena selection: neither is expressible as a developer flag,
 * so both are `null` rather than a fabricated default. `players` may be 1 --
 * `?dev=1&mode=ffa` with no `players` flag really does build a one-slot FFA
 * world, and the descriptor reports what was actually built.
 */
export function versusRulesFromDeveloperFlags(input: {
  readonly mode: 'ffa' | 'teams';
  readonly players: number;
  readonly friendlyFire: boolean;
}): VersusRules {
  if (input.mode !== 'ffa' && input.mode !== 'teams') {
    throw new Error(`versusRulesFromDeveloperFlags: mode must be 'ffa' or 'teams'`);
  }
  if (!Number.isInteger(input.players) || input.players < 1 || input.players > 4) {
    throw new Error(
      `versusRulesFromDeveloperFlags: players must be an integer 1-4, got ${input.players}`,
    );
  }
  return Object.freeze({
    mode: input.mode,
    players: input.players,
    friendlyFire: input.friendlyFire,
    stock: null,
    arenaSelection: null,
  });
}

export function versusDescriptor(rules: VersusRules): VersusSessionDescriptor {
  return Object.freeze({ kind: 'versus' as const, rules });
}

/**
 * Wrap already-resolved launch data into a ResolvedSession. Callers that
 * resolved a VS descriptor's `'random'` arena (see `resolveVersusConfig`)
 * pass the concrete `arenaId`; campaign/practice callers pass the level's
 * own arena id. The `seed` must be non-zero (mulberry32 degeneracy).
 */
export function resolveSession(
  descriptor: SessionDescriptor,
  seed: number,
  arenaId: string,
): ResolvedSession {
  if (!Number.isInteger(seed) || seed <= 0) {
    throw new Error(`resolveSession: seed must be a positive integer, got ${seed}`);
  }
  if (arenaId === '' || arenaId === 'random') {
    throw new Error(`resolveSession: arenaId must be a concrete id, got '${arenaId}'`);
  }
  return Object.freeze({ descriptor, seed, arenaId });
}

// Location constructors -- the two shapes AppLocation ever takes.

export function locationAtRoute(route: AppRoute): AppLocation {
  return { kind: 'route', route };
}

export function locationInGameplay(
  session: ResolvedSession,
  phase: GameplayPhase,
): AppLocation {
  return { kind: 'gameplay', session, phase };
}

// Phase constructors.

export function playingPhase(): GameplayPhase { return { kind: 'playing' }; }
export function pausedPhase(): GameplayPhase { return { kind: 'paused' }; }
export function outcomePhase(outcome: TypedOutcome): GameplayPhase {
  return { kind: 'outcome', outcome };
}

// Outcome constructors.

export function missionClearOutcome(): TypedOutcome { return { kind: 'mission-clear' }; }
export function campaignCompleteOutcome(): TypedOutcome { return { kind: 'campaign-complete' }; }
export function campaignOverOutcome(): TypedOutcome { return { kind: 'campaign-over' }; }
export function practiceResultOutcome(cleared: boolean): TypedOutcome {
  return { kind: 'practice-result', cleared };
}
export function vsMatchEndOutcome(result: VersusResult): TypedOutcome {
  return { kind: 'vs-match-end', result };
}

// Versus result constructors.

export function versusWinnerSlot(slot: number): VersusResult {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error(`versusWinnerSlot: slot must be a non-negative integer, got ${slot}`);
  }
  return { kind: 'winner-slot', slot };
}
export function versusWinnerTeam(team: number): VersusResult {
  if (!Number.isInteger(team) || team < 0) {
    throw new Error(`versusWinnerTeam: team must be a non-negative integer, got ${team}`);
  }
  return { kind: 'winner-team', team };
}
export function versusDraw(): VersusResult {
  return { kind: 'draw' };
}

// ---------------------------------------------------------------------------
// Pure predicates -- what a caller checks without needing pattern matching
// ---------------------------------------------------------------------------

export function isAtRoute(location: AppLocation): boolean {
  return location.kind === 'route';
}

export function isAtRouteKind(location: AppLocation, kind: AppRouteKind): boolean {
  return location.kind === 'route' && location.route.kind === kind;
}

export function isInGameplay(location: AppLocation): boolean {
  return location.kind === 'gameplay';
}

export function isPlaying(location: AppLocation): boolean {
  return location.kind === 'gameplay' && location.phase.kind === 'playing';
}

export function isPaused(location: AppLocation): boolean {
  return location.kind === 'gameplay' && location.phase.kind === 'paused';
}

export function hasOutcome(location: AppLocation): boolean {
  return location.kind === 'gameplay' && location.phase.kind === 'outcome';
}

export function currentDescriptor(location: AppLocation): SessionDescriptor | null {
  return location.kind === 'gameplay' ? location.session.descriptor : null;
}

export function currentSession(location: AppLocation): ResolvedSession | null {
  return location.kind === 'gameplay' ? location.session : null;
}

export function currentPhase(location: AppLocation): GameplayPhase | null {
  return location.kind === 'gameplay' ? location.phase : null;
}

export function currentOutcome(location: AppLocation): TypedOutcome | null {
  if (location.kind !== 'gameplay') return null;
  if (location.phase.kind !== 'outcome') return null;
  return location.phase.outcome;
}

export function currentRoute(location: AppLocation): AppRoute | null {
  return location.kind === 'route' ? location.route : null;
}
