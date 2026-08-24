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
 * metadata carried alongside a descriptor, not a fourth session kind.
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
 */
export type SessionDescriptor =
  | CampaignSessionDescriptor
  | PracticeSessionDescriptor
  | VersusSessionDescriptor;

export type SessionDescriptorKind = SessionDescriptor['kind'];

export interface CampaignSessionDescriptor {
  readonly kind: 'campaign';
}

export interface PracticeSessionDescriptor {
  readonly kind: 'practice';
  /**
   * 1-based ordinal into the campaign level sequence -- what the player picked
   * in the level select. Stored as ordinal, not as a CampaignLevel reference,
   * so a descriptor stays plain validated data (no world/level object identity
   * leaks in). The level system is authoritative for what that ordinal names
   * at launch time.
   */
  readonly levelOrdinal: number;
}

export interface VersusSessionDescriptor {
  readonly kind: 'versus';
  /**
   * The pane's validated selection. A retained VS descriptor may still carry
   * `arenaId: 'random'` -- resolution to a concrete arena happens exactly once,
   * at the point a resolved instance is created (`resolveVersusConfig` in
   * versus-config.ts). See `ResolvedSession.arenaId` for the launched value.
   */
  readonly config: VersusConfig;
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
  | { readonly kind: 'vs-match-end'; readonly localPlayerWon: boolean };

export type TypedOutcomeKind = TypedOutcome['kind'];

/**
 * Whether the local player's presentation should read the outcome as a
 * victory. Music routing and audience-facing win/loss cues consult this
 * instead of guessing from a session kind + boolean pair.
 */
export function outcomeIsVictory(outcome: TypedOutcome): boolean {
  switch (outcome.kind) {
    case 'mission-clear':
    case 'campaign-complete':
      return true;
    case 'campaign-over':
      return false;
    case 'practice-result':
      return outcome.cleared;
    case 'vs-match-end':
      return outcome.localPlayerWon;
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
 * Orthogonal metadata about developer-driven boot state. Developer mode is
 * NOT a fourth session kind -- a `?dev=1&level=3` boot still produces a real
 * Practice descriptor, and this record just records that dev flags participated.
 * Consumers that need to distinguish a URL-driven jump from a menu-driven
 * choice (persistence, telemetry, campaign-run mutation gates) read this
 * beside the descriptor rather than encoding provenance inside it.
 */
export interface DeveloperMetadata {
  /** Was the `dev` flag itself set at boot? */
  readonly active: boolean;
  /**
   * What (if anything) developer flags steered the initial session shape to.
   * `null` when no dev-driven session selection happened, even if dev mode is on.
   */
  readonly sessionOrigin: 'level-jump' | 'sandbox' | 'versus-flags' | null;
}

export const DEV_METADATA_OFF: DeveloperMetadata = {
  active: false,
  sessionOrigin: null,
};

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

export function campaignDescriptor(): CampaignSessionDescriptor {
  return { kind: 'campaign' };
}

/**
 * A Practice descriptor for the given 1-based level ordinal. Rejects
 * non-integer, non-positive, or 0 ordinals -- practice cannot describe a
 * level that does not exist in the sequence's namespace.
 */
export function practiceDescriptor(levelOrdinal: number): PracticeSessionDescriptor {
  if (!Number.isInteger(levelOrdinal) || levelOrdinal < 1) {
    throw new Error(`practiceDescriptor: levelOrdinal must be a 1-based integer, got ${levelOrdinal}`);
  }
  return { kind: 'practice', levelOrdinal };
}

/**
 * A Versus descriptor with a validated config -- the pane's selection at Start.
 * The retained descriptor may still say `arenaId: 'random'`; resolution to a
 * concrete arena happens later at `resolveSession`. Rejects clearly-invalid
 * player counts or unsupported modes -- the setup pane's own filters exist to
 * prevent this reaching launch, but the descriptor boundary is the last line
 * that can refuse.
 */
export function versusDescriptor(config: VersusConfig): VersusSessionDescriptor {
  if (config.players !== 2 && config.players !== 3 && config.players !== 4) {
    throw new Error(`versusDescriptor: players must be 2, 3, or 4, got ${config.players}`);
  }
  if (config.mode !== 'ffa' && config.mode !== 'teams') {
    throw new Error(`versusDescriptor: mode must be 'ffa' or 'teams', got '${config.mode}'`);
  }
  if (!Number.isInteger(config.stock) || config.stock < 1) {
    throw new Error(`versusDescriptor: stock must be a positive integer, got ${config.stock}`);
  }
  return { kind: 'versus', config };
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
  return { descriptor, seed, arenaId };
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
export function vsMatchEndOutcome(localPlayerWon: boolean): TypedOutcome {
  return { kind: 'vs-match-end', localPlayerWon };
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
