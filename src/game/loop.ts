import type { World } from '../sim/world';
import { countPlayerTanks, isVersusEliminated } from '../sim/world';
import type { SimEvent } from '../sim/events';
import type { Vec2, InputState, Tank } from '../sim/types';
import {
  decidePlayerInput,
  createPlayerAiState,
  mulberry32,
  type PlayerAiState,
} from '../sim/ai/player-profile';
import type { CampaignLevel } from '../sim/arena';
import { createLevelSystem, createVersusLevelSystem, type LevelSystem } from './levels';
import { resolveVersusConfig, type VersusConfig } from './versus-config';
import { botSlotsOf, resolveSources, type VersusSlotSetup } from './versus-setup';
import type { ProgressStore } from './progress';
import type { StatsStore } from './stats';
import type { CustomizationStore } from './customization';
import type { SkinId } from '../presentation/customization';
import type {
  PlayerSettings,
  PlayerSettingsStore,
  SettingsNotice,
  SettingsStatus,
} from './settings';
import type { EffectiveSettings, EffectiveSettingsHandle } from './effective-settings';
import { createBrowserAppShell, type AppShell } from './app-shell';
import type { AchievementsStore, AchievementContext } from './achievements';
import type { RunStore } from './run';

import { createSaveApi, type SaveApi } from './save';
import {
  createRecordingInput,
  replayMetaFor,
  type RecordingInput,
  type ReplayTrace,
} from './replay';
import { consumesKey } from '../input/ui-actions';
import { createInputController, type InputController } from '../input/input';
import {
  createGamepadInputSource,
  readNavigatorGamepads,
  readDetectedPads,
  type PlayerInputSource,
  type DetectedPad,
} from '../input/gamepad';
import {
  deriveInitialAssignment,
  reassign,
  botAssignmentAllowed,
  createHeldInputSource,
  type Assignment,
  type SlotSource,
} from '../input/assignment';
import { createRenderer, type Renderer3D } from '../render/renderer';
import { createTankPreview, type TankPreview } from '../render/preview';
import type { AudioEngine } from '../audio/engine';
import type { StorageNamespace } from './storage';
import type { SuiteContext } from '../audio/suites';
import { createAudioDirector, type AudioDirector } from '../audio/director';
import { createHapticsDirector, resolveVibrate, type HapticsDirector } from './haptics';
import { createBlockedFireHudCue } from './blocked-fire-hud';
import {
  createGameStateMachine,
  type GameStateMachine,
  type GameStateMachineConfig,
} from './state';
import {
  type AppLocation,
  type ResolvedSession,
  type SessionDescriptor,
  type VersusResult,
  legacyOutcomePresentation,
  resolveSession,
  versusDraw,
  versusWinnerSlot,
  versusWinnerTeam,
} from './app-state';
import {
  type RelaunchTarget,
  type SessionContext,
  type SessionIdentity,
  descriptorFor,
  identityForLevelPick,
  relaunchTargetFor,
  resolveBootSessionContext,
} from './session-intent';
import { createHud, type Hud, type HudSurface, SINGLE_PLAYER_DEATH_VIGNETTE } from './hud';
import { browserHistoryHost } from './navigation';
import { DEFAULT_BOT_DIFFICULTY, type BotDifficulty } from '../sim/ai/bot-difficulty';
import type { BlockedFireCue } from '../presentation/blocked-fire';
import type { RouteHost, StartIntent } from './route-host';
import { resolveOwnerColor } from '../presentation/identity';
import { createDriver, type RafScheduler } from './driver';
import { roundPhase, roundPhaseTicksLeft } from '../sim/round';
import { TICK_HZ } from '../sim/constants';
import { parseDevFlags, parseDeveloperMode, type DevFlags } from './devflags';
import { configFor } from '../sim/config';
import { qualityFor, type RenderQuality } from '../render/quality';

/**
 * Construction and wiring: the boundary where the untestable collaborators are
 * built. The frame loop itself lives in driver.ts and its arithmetic in
 * frame.ts, both of which are testable without a GPU.
 *
 * Everything the game is built from is injected as a FACTORY rather than as a
 * finished instance. That is what keeps the call sites -- and therefore their
 * ARGUMENTS -- inside the tested function: the renderer's width and height, the
 * director's player id, screenToGround's x and y, and the world's seed are all
 * defects that only a factory seam can reach. Injecting finished instances
 * leaves every one of them unreachable.
 */

/** Only what this module needs from `window`, so a test can record exact pairs. */
export interface HostWindow {
  readonly innerWidth: number;
  readonly innerHeight: number;
  addEventListener(type: 'keydown', fn: (e: KeyboardEvent) => void): void;
  addEventListener(type: 'resize', fn: (e: Event) => void): void;
  addEventListener(type: 'blur', fn: (e: Event) => void): void;
  addEventListener(type: 'pointerdown', fn: (e: Event) => void): void;
  // The controller assignment panel's live pad list (docs/superpowers/plans/
  // 2026-08-17-controller-assignment.md): added/removed ONLY while `.hud-controllers`
  // is open (hud.onControllersOpen/Close), never at boot -- see that wiring below.
  addEventListener(type: 'gamepadconnected', fn: (e: Event) => void): void;
  addEventListener(type: 'gamepaddisconnected', fn: (e: Event) => void): void;
  removeEventListener(type: 'keydown', fn: (e: KeyboardEvent) => void): void;
  removeEventListener(type: 'resize', fn: (e: Event) => void): void;
  removeEventListener(type: 'blur', fn: (e: Event) => void): void;
  removeEventListener(type: 'pointerdown', fn: (e: Event) => void): void;
  removeEventListener(type: 'gamepadconnected', fn: (e: Event) => void): void;
  removeEventListener(type: 'gamepaddisconnected', fn: (e: Event) => void): void;
}

/**
 * COMPLETE and NON-OPTIONAL, on purpose.
 *
 * An optional dependency lets a test that forgot one fall silently through to
 * the real implementation -- and createAudioEngine IS constructible under
 * jsdom, so that fall-through would not fail loudly. It would quietly play
 * nothing while the test claimed to have covered the wiring.
 */
export interface GameDeps {
  readonly createRenderer: (
    canvas: HTMLCanvasElement,
    worldWidth: number,
    worldHeight: number,
    boundary: number,
    options?: {
      aimRay?: boolean;
      mineReach?: boolean;
      aiContact?: boolean;
      blockedFire?: BlockedFireCue | null;
      mineTimer?: boolean;
      mineWarn?: import('../render/mine-warning').MineWarnStyle | null;
      playerColor?: string;
      playerSkin?: SkinId;
      playerAccent?: string | null;
      quality?: RenderQuality;
      enemyDeathPulse?: boolean;
    },
  ) => Renderer3D;
  /**
   * The paint shop's live tank preview, built against the HUD's own canvas
   * (`hud.previewCanvas`). Returns null if the environment cannot provide a second
   * WebGL context (see render/preview.ts's doc comment) -- the Customize panel still
   * works without one, it just shows no preview.
   */
  readonly createPreview: (
    canvas: HTMLCanvasElement,
    rotateButtons: readonly HTMLElement[],
    /** The resolved reduced-motion policy (effective-settings.ts), never a media query. */
    reducedMotion: boolean,
  ) => TankPreview | null;
  readonly createInput: (
    target: HTMLElement,
    screenToGround: (clientX: number, clientY: number) => Vec2,
    options?: { gamepad?: boolean },
  ) => InputController;
  /**
   * A standalone gamepad-only `PlayerInputSource`, one call per co-player slot 1..N-1
   * (see `startGameWith`'s `realSources` construction) -- `pad[i] -> slot[i]`, so
   * `padIndex` is always the SLOT being filled, not a fixed offset. Injected for the
   * same reason every other collaborator here is -- `createGamepadInputSource` itself
   * is a plain module function with no lifecycle to fake, but going through GameDeps
   * keeps its CONSTRUCTION SITE (how many times it is called, and with which
   * `padIndex`) inside the tested function -- see `gamepad.ts`'s module doc comment
   * for why slot 0's own optional pad merge (`input.ts`'s `gamepad` option, always
   * padIndex 0) and every co-player slot's dedicated reader never collide: they read
   * different indices of the same pads array, not a shared one arbitrated at runtime.
   */
  readonly createGamepadSource: (padIndex: number) => PlayerInputSource;
  /**
   * Every currently-connected pad, for the controller assignment panel's live list
   * (docs/superpowers/plans/2026-08-17-controller-assignment.md) -- `gamepad.ts`'s
   * `readDetectedPads` bound to the one production `GetGamepads`. Injected for the same
   * reason `createGamepadSource` is: going through GameDeps keeps the read testable
   * without a real `navigator.getGamepads`. Called once immediately on
   * `hud.onControllersOpen` (the browser's `gamepadconnected`/`gamepaddisconnected`
   * events fire only on CHANGE) and once per hotplug event after that, both scoped to
   * while the panel is open.
   */
  readonly readDetectedPads: () => DetectedPad[];
  readonly createAudio: () => AudioEngine;
  /**
   * Release the engine `createAudio` handed this session, at session teardown.
   *
   * REQUIRED, and deliberately a sibling of `createAudio` rather than a `dispose()` call
   * hard-coded into the teardown: since issue #317 the engine is owned by the PAGE
   * (`app-shell.ts`), so who may dispose it is a property of who created it. A session
   * that disposed a shell-owned engine would leave every later session with a dead
   * `AudioContext` and no sound at all -- silently, because `dispose()` latches and
   * `ensureCtx` then returns null rather than throwing.
   *
   * Required, not optional-with-a-`dispose()`-default, for that exact reason: the two
   * fields must agree, and a caller that wires a shared `createAudio` and forgets this
   * one would half-wire the pair. `tsc` refuses instead.
   */
  readonly releaseAudio: (engine: AudioEngine) => void;
  /**
   * The PAGE's Launch gate, not this session's (issue #317).
   *
   * `boot.ts` builds a fresh session on every Campaign<->Versus switch, and
   * `createGameStateMachine` opens at the Launch route, so before this every switch
   * re-showed "Press any key or tap to begin" to a player who had already dismissed it.
   * `startGameWith` reads `dismissed()` to decide where its state machine opens, and calls
   * `dismiss()` from the same gesture handler that dismisses it in the state machine.
   */
  readonly launchGate: LaunchGate;
  /**
   * playerId is required here even though createAudioDirector defaults it. The
   * default is DEFAULT_PLAYER_ID = 0 and no live tank is ever id 0, so taking
   * the default is a silent wrong answer -- the player never hears their own
   * cannon. Requiring it makes that a compile error instead of a defect.
   */
  readonly createDirector: (engine: AudioEngine, playerId: number) => AudioDirector;
  /**
   * The haptics seam (issue #112). Mirrors createDirector's shape and the same
   * reasoning: playerId is required, not defaulted, because no live tank is ever id 0
   * and a silently-wrong default would mean the player's own shots never buzz. Unlike
   * createDirector there is no separately-constructed "engine" to pass in -- the
   * injected collaborator is the bare `vibrate` function, and it is closed over
   * inside this factory (createBrowserDeps passes `resolveVibrate()`) rather than
   * threaded through GameDeps as its own field, since it has no lifecycle of its own
   * to test independently of the director that calls it.
   */
  readonly createHaptics: (playerId: number) => HapticsDirector;
  /**
   * Takes the outcome classifier its session needs -- see
   * `GameStateMachineConfig.classifyOutcome`. Not a zero-argument factory:
   * that shape is what allowed production to construct a machine with no
   * campaign-completion or versus-attribution context at all (issue #316
   * review, finding 1).
   */
  readonly createStateMachine: (config: GameStateMachineConfig) => GameStateMachine;
  readonly createHud: (root: HTMLElement) => Hud;
  /**
   * The level sequence: how many levels exist, where this session starts, and how
   * to build the world for any of them. Injected as one object so a test can
   * substitute a two-level fake and still exercise the real advance/carry/reset
   * wiring in startGameWith.
   */
  readonly levels: LevelSystem;
  /** Saved progress: which levels are cleared. Drives level select. */
  readonly progress: ProgressStore;
  /**
   * The active campaign run -- distinct from `progress` (issue #153). `progress` is
   * permanent, monotonic unlock history; `run` is the one in-flight attempt through
   * the campaign, with its own level position and life pool, that Continue resumes
   * and practice must never touch. See run.ts.
   */
  readonly run: RunStore;
  /** The lifetime and per-attempt tallies, fed from the attributed event stream. */
  readonly stats: StatsStore;
  /** The paint shop's saved choice. Render-only downstream. */
  readonly customization: CustomizationStore;
  /**
   * Every durable player preference, as STORED (settings.ts): mute, volume, touch scheme,
   * fire mode, device haptics, controller rumble, motion policy, UI scale.
   *
   * Written to when the player changes something. Almost never READ from here -- read
   * `effectiveSettings` instead, which is the same values after the capability and OS
   * rules have been applied. The two are separate fields precisely so a consumer cannot
   * reach for the raw preference by accident and buzz a device that cannot vibrate.
   *
   * PAGE-scoped: the same instance across every session on this document load (see
   * `createBrowserDeps`), which is what makes mute and volume survive the campaign/versus
   * reboot that replaces everything else in this object.
   */
  readonly settings: PlayerSettingsStore;
  /**
   * The resolved values every consumer should apply (effective-settings.ts). Page-scoped,
   * like `settings`.
   *
   * `startGameWith` must NOT dispose this -- see `EffectiveSettingsHandle.dispose`. It
   * unsubscribes its own listener on teardown and leaves the handle alive for the next
   * session.
   */
  readonly effectiveSettings: EffectiveSettingsHandle;
  /**
   * Register for the one persistence notice this page will show, if any. Returns an
   * unregister the session teardown must call -- the HUD it closes over dies with the
   * session, and the notice can arrive later (a first failed write).
   */
  readonly onSettingsNotice: (cb: (notice: SettingsNotice) => void) => () => void;
  readonly achievements: AchievementsStore;
  /**
   * The RAW key/value layer the six stores above sit on.
   *
   * Deliberately alongside them rather than instead of them: the save
   * export/import round-trips whole strings, which the typed stores cannot do
   * (they validate on read and drop what they do not recognise -- exactly the
   * data an export exists to preserve). Nothing else in this file touches it.
   */
  readonly storage: Storage;
  /**
   * Which namespace `storage` above is already applying (issue #250).
   *
   * REQUIRED, and paired with `storage` for the same reason `releaseAudio` is paired with
   * `createAudio` (issue #317): the two must agree. `storage` is the NAMESPACED adapter,
   * but the keys it exposes are the store-facing names -- `createNamespacedStorage`
   * prefixes underneath -- so a save blob taken through it carries no trace of where it
   * came from. That is precisely why the namespace has to travel beside it rather than be
   * recoverable from it, and why a default here would silently label every developer
   * export `production`, which is the defect issue #250 exists to close.
   */
  readonly storageNamespace: StorageNamespace;
  /**
   * Where the dev console surface is published, when a dev flag asks for one.
   * `globalThis` in the browser. Injected so the publish/teardown is assertable
   * without reaching for a global in a test.
   */
  readonly devConsole: DevConsoleTarget;
  /** Monotonic ms for the frame loop. */
  readonly now: () => number;
  /** Wall-clock ms, used ONLY to derive world seeds. Separate from `now` on purpose. */
  readonly wallMs: () => number;
  readonly raf: RafScheduler;
  readonly host: HostWindow;
  /** Opt-in switches for unshipped work. Off unless the URL says otherwise. */
  /** Opt-in diagnostics. Off unless the URL says otherwise. */
  readonly devFlags: DevFlags;
  /**
   * Whether the `dev` GATE itself was on -- `parseDeveloperMode`, not a
   * `DevFlags` field (a bare `?dev=1` parses to exactly `DEV_FLAGS_OFF`, so
   * the flags cannot report it). Feeds `DeveloperMetadata.active` through the
   * session translation.
   */
  readonly developerMode: boolean;
  /**
   * Reboots the running session into a versus match with this config -- the versus
   * setup pane's "Start" (a later task) calls it. Boot-provided (boot.ts's
   * `requestVersusSession`, threaded through `versusAwareDeps`): the campaign path
   * never calls it, and OPTIONAL so every existing test/caller in this file, which
   * builds a `GameDeps` with no reboot seam at all, keeps compiling unchanged.
   */
  readonly requestVersusSession?: (config: VersusConfig) => void;
  /**
   * Reboots the running session BACK into a plain campaign session -- Task 5b's
   * symmetric counterpart to `requestVersusSession` above, called by the versus-kind
   * title screen's Campaign button (`hud.onCampaignOpen`). Exists because a rebooted
   * versus session's `deps.levels` is the versus level system for its whole life
   * (levels.ts's own one-value-per-session posture): a plain campaign entry point
   * reachable from THERE would build a versus world off `levels[0]`, not a campaign
   * board (reviewer-confirmed against `onNewGame` above -- see its own doc comment).
   * Boot-provided (boot.ts's `requestCampaignSession`, threaded through
   * `versusAwareDeps`), and OPTIONAL for the same reason `requestVersusSession` is:
   * every existing test/caller with no reboot seam at all keeps compiling.
   *
   * Threaded ONLY into a VERSUS session's own deps (`applyVersusToDeps`'s versus
   * branch) -- same posture as `initialVersusConfig` just below: a campaign session
   * has no Campaign button to call this from (its own title already shows the real
   * Continue/New Game/Levels), so its deps leave this unset rather than wire a
   * reboot seam nothing on screen can reach.
   */
  readonly requestCampaignSession?: () => void;
  /**
   * Set when THIS session is itself a versus reboot, to the config it was rebooted
   * with -- so the setup pane can reopen pre-filled with the match just played
   * instead of its own defaults. `null`/absent for a fresh campaign boot, which has
   * no prior versus match to prefill from.
   *
   * Deliberately the UNRESOLVED config the pane handed to `requestVersusSession` --
   * NOT the config `levels` below was actually built from. `applyVersusToDeps` resolves
   * a `'random'` `arenaId` to a concrete one exactly once, for `levels`
   * (`resolveVersusConfig`, versus-config.ts -- issue #278), but stamps the ORIGINAL
   * `config` here unchanged, so a pane reopened mid-session (match end, or a future
   * Back) still shows `'random'` selected rather than whatever concrete arena this
   * session happened to roll. The two can therefore disagree on `arenaId` for the
   * whole life of a 'random' session; nothing here is stale, that disagreement IS the
   * point.
   */
  readonly initialVersusConfig?: VersusConfig | null;
}

/**
 * Page-level Launch state, as a session sees it.
 *
 * Two methods rather than a boolean field so a session cannot hold a STALE answer across
 * its own lifetime: `dismissed()` is asked at construction, and `dismiss()` is what the
 * splash gesture reports back to the page.
 */
export interface LaunchGate {
  dismissed(): boolean;
  dismiss(): void;
}

export interface GameHandle {
  dispose(): void;
  /**
   * Show this session (issue #428). Called by the start boundary, once, right after the
   * session is built.
   *
   * NOT done inside `startGameWith` itself, and the distinction is the point: building a
   * session and SHOWING it are different acts, and only the second one is a route change.
   * Before #428 they were separable in production too -- the eager boot built a session
   * and opened at the title, and `onStartRestart`'s main-menu branch was what entered
   * gameplay later. That branch is unreachable now, because with no session attached the
   * click goes to the start boundary instead of to the slot, which is how a session came
   * to be built with nobody left to reveal it.
   *
   * FOUND IN A BROWSER, not by a unit test, and the gap is worth recording: every unit
   * assertion was about how many sessions, canvases and worlds got built, and every one
   * was right. The game still did not start. `tools/visual/roundtrip.mjs` reported
   * `canvases: 1` with the title buttons still on screen -- which is what a player would
   * have seen: a menu that builds a match behind itself and never shows it.
   */
  enterGameplay(): void;
}

/**
 * The property the dev surface is published under.
 *
 * Underscored because this origin is SHARED with every other project page on
 * austinorphan.com (CLAUDE.md): a bare `tanks` on the global object is a name a
 * neighbour could plausibly want.
 */
export const DEV_CONSOLE_KEY = '__tanks';

/**
 * What `?dev=1&saveIo=1` / `?dev=1&replay=1` put on the console.
 *
 * Each member appears only when its own flag is on, and the whole object is
 * absent when neither is -- so a shipped build has no dev surface at all, not an
 * empty one that reads as "the feature is here but broken".
 */
export interface DevConsole {
  /** Export/import the `tanks.*` save keys. Reload after an import -- see save.ts. */
  save?: SaveApi;
  /**
   * Player settings (issue #320): what is stored, whether it is actually being saved,
   * and the reset that restores the documented defaults.
   *
   * Rides `saveIo` rather than earning a flag of its own, because it is the same
   * concern: the raw save layer beside the one typed store that can end up UNWRITABLE.
   * `status()` is the difference between "your settings are saved", "they die with this
   * page", and "a newer build's payload is under this key and nothing will be written
   * until you reset" -- and `reset()` is the only exit from that last state, which the
   * notice text promises exists. The Settings -> Data affordance that will make it
   * reachable without a dev flag belongs to issue #226.
   */
  settings?: SettingsApi;
  /** The input trace for the CURRENT level, replayable through replay.ts. */
  replay?: () => ReplayTrace;
}

export interface SettingsApi {
  /** The accepted settings, exactly as every consumer sees them. */
  snapshot(): PlayerSettings;
  /** The EFFECTIVE values, after capability and OS rules -- what is actually applied. */
  effective(): EffectiveSettings;
  /** Whether settings are reaching storage, and why not. See `SettingsStatus`. */
  status(): SettingsStatus;
  /**
   * Restore the documented defaults and persist them. Clears a future-schema lock and
   * the legacy `tanks.touch.v1` key. Progress, stats and achievements are untouched --
   * those belong to the HUD's own Reset Progress, which does not touch settings either.
   */
  reset(): void;
}

/** Where the dev surface is published. `globalThis` in the browser; a plain object in tests. */
export type DevConsoleTarget = Record<string, unknown>;

/**
 * A fresh seed per world. Wall-clock time is illegal inside sim/ -- it would
 * break replay determinism -- but correct here at the boundary: the sim stays a
 * pure function of the seed it is handed, and only the game layer decides what
 * that seed is. Never 0, which the PRNG treats as degenerate.
 */
export function deriveSeed(wallMs: number): number {
  return (wallMs ^ (wallMs >>> 9)) >>> 0 || 1;
}

/**
 * The spacing a bot's per-slot RNG stream is DEDUCTED from the resolved world seed by
 * (see `createBotSources` below) -- chosen, not copied, from the n-player arc design's
 * own draft (`mulberry32(seed + 1000 + slot)`), which collided with `targeting.ts`'s
 * wander stream: `wanderMove` seeds `nextRng(world.seed + tank.id * 1000 + bucket)`, so
 * a slot-0 bot at that offset drew the IDENTICAL number `nextRng` computes for an id-1
 * enemy's very first wander decision (id 1, bucket 0) -- `world.seed + 1000 + 0`
 * literally equals `world.seed + 1*1000 + 0`.
 *
 * Every per-tank enemy stream in `targeting.ts` (wander 1000, retreat 4243, mine
 * inclination 6101, aim jitter 7919, all four multiplying `tank.id`) has the shape
 * `world.seed + tank.id * PRIME + bucket` with PRIME > 0, `tank.id >= 1` (arena.ts's
 * grid-scan numbering starts its counter at 1, `let id = 1`, and never assigns 0 to any
 * tank, player or enemy), and `bucket >= 0` (`Math.floor(tick / WINDOW)`, tick never
 * negative) -- so EVERY enemy key is strictly GREATER than `world.seed` itself, for any
 * positive multiplier, not only today's four. Subtracting a fixed spacing (larger than
 * the largest slot index, 3, so every bot key stays below `world.seed`) makes every bot
 * key strictly LESS than `world.seed` -- disjoint from the whole family by construction,
 * not merely from the four multipliers that happen to exist today. A future per-tank
 * stream that keeps the same additive-from-world.seed shape (as PR2c's planned fifth
 * prime would) cannot collide with this either, whatever prime it picks -- only a
 * stream that itself went negative relative to world.seed could, and none does.
 *
 * `1009` is arbitrary beyond needing magnitude > 3: a prime, for the same
 * spot-the-typo-if-reused reason `targeting.ts` picks primes for its own multipliers,
 * not because primality does any work in the collision argument above.
 */
export const BOT_SEED_SPACING = 1009;

/**
 * Per-slot RNG stream and hold-state for a bot-claimed slot, mirroring what `autoplay`
 * builds for slot 0 (`autoplayRnd`/`autoplayState` below) -- except reseeded from the
 * CURRENT world's own resolved seed rather than session-scoped from `wallMs()`. Bots
 * exist to simulate a REPRODUCIBLE multiplayer session (owner directive 1's actual use
 * case: `?dev=1&seed=42&bots=K` must replay identically), which is exactly the
 * guarantee `wallMs()` cannot give and `world.seed` can -- see BOT_SEED_SPACING's own
 * doc comment for why `world.seed - BOT_SEED_SPACING + slot` never collides with an
 * enemy AI stream.
 *
 * `slots` is the exact set of slot indices bots claim (the LAST `botCount` of
 * `playerCount`, computed once by the caller) -- keyed by slot number, not built as an
 * array, so a non-claimed slot has no entry at all rather than a hole.
 */
/** One bot slot's stream, state and -- bound at construction -- its decision function. */
export interface BotSource {
  readonly rnd: () => number;
  readonly state: PlayerAiState;
  readonly difficulty: BotDifficulty;
  readonly decide: (world: World, tankId: number) => InputState;
}

export function createBotSources(
  seed: number,
  slots: ReadonlySet<number>,
  // Trailing and optional (issue #267): per-slot competence, read from the descriptor the
  // pane validated. A slot with no entry plays at `normal`, which is the authored profile
  // unchanged -- so every existing caller, none of which passes a third argument, builds
  // exactly the bots it always did.
  difficulty?: ReadonlyMap<number, BotDifficulty>,
): Map<number, BotSource> {
  const sources = new Map<number, BotSource>();
  for (const slot of slots) {
    // The RNG stream is keyed on seed and slot ALONE, deliberately: difficulty must change
    // how well a bot plays, never which draws it makes. Keying the stream on the preset
    // too would mean switching difficulty re-rolled every subsequent decision, so an A/B
    // comparison at one seed would be comparing two different matches.
    const rnd = mulberry32(seed - BOT_SEED_SPACING + slot);
    const state = createPlayerAiState(rnd);
    const preset = difficulty?.get(slot) ?? DEFAULT_BOT_DIFFICULTY;
    sources.set(slot, {
      rnd,
      state,
      difficulty: preset,
      // BOUND HERE, not passed at the call site, and that is the point. An earlier shape
      // had the frame loop call `decidePlayerInput(world, id, rnd, state, bot.difficulty)`
      // -- and replacing that last argument with the default was MEASURED to leave 1801
      // tests green, because nothing in the tree drives a bot far enough to notice. The
      // preset is now closed over at construction, so there is no argument for a caller to
      // drop: the only way to unwire it is to change this function, which its own test
      // reads directly.
      decide: (world, tankId) => decidePlayerInput(world, tankId, rnd, state, preset),
    });
  }
  return sources;
}

/**
 * The LAST `botCount` of `playerCount` slots, per the n-player arc's PR2 design: the
 * simplest possible fill rule, chosen because at this PR no per-slot controller routing
 * exists yet to arbitrate a per-slot declaration against (that is a later PR's job).
 * `botCount` may equal `playerCount` -- including at playerCount 1, where it claims the
 * only slot, the fully autonomous match owner directive 1 asks for.
 *
 * PR3 (`pad[i] -> slot[i]`) is that later PR, and the precedence is fixed here rather
 * than arbitrated at the controller layer: `botSlots` is computed once, above, and
 * `realSources`' construction loop only calls `deps.createGamepadSource(i)` for a slot
 * NOT in this set -- bots claim their declared slots first, controllers fill whatever
 * remains, in `pad[i] -> slot[i]` order for the slots that are left. A bot-claimed slot
 * never constructs a gamepad reader at all.
 */
/**
 * How a session's initial slot assignment is decided, for BOTH entry paths (issue #260).
 *
 * Extracted and exported rather than left inline in `startGame` because it is the one place
 * the two paths could silently diverge, and inline it was unreachable by any test: a
 * mutation that made the VS path ignore its slots and fall back to the derived count
 * SURVIVED the whole suite. Measured, not assumed -- that survivor is why this seam exists.
 *
 *   - VS (`versusSlots` present): roles come from the descriptor the pane validated, and
 *     devices are re-resolved densely against what is plugged in RIGHT NOW. A human slot
 *     with no pad stays `'none'` so the Start gate can name it instead of rebinding.
 *   - Campaign/dev: the historical positional rule (`pad[i] -> slot[i]`, slot 0 keyboard),
 *     with the `bots` flag claiming the LAST `botCount` slots. Unchanged on purpose --
 *     nothing validates a campaign co-op session, so giving it the VS rule would hand it a
 *     new failure mode for no benefit.
 */
export function seedAssignment(
  versusSlots: readonly VersusSlotSetup[] | undefined,
  playerCount: number,
  botCount: number,
  connectedPads: readonly number[],
): Assignment {
  if (versusSlots) return resolveSources(versusSlots, connectedPads);
  return deriveInitialAssignment(playerCount, botSlotsFor(playerCount, botCount));
}

export function botSlotsFor(playerCount: number, botCount: number): Set<number> {
  const slots = new Set<number>();
  for (let i = playerCount - botCount; i < playerCount; i++) slots.add(i);
  return slots;
}

// createIdleInputSource() was RETIRED at n-player arc PR3 (`pad[i] -> slot[i]`), when
// every co-player slot got its own dedicated `createGamepadInputSource(padIndex)` whose
// own "no pad ever connected" branch (`input/gamepad.ts`) already produced the identical
// echo -- so it was deleted rather than kept unused, per CLAUDE.md's "a generator nothing
// calls rots." The controller assignment UI UN-retires that exact shape as
// `createHeldInputSource` (`input/assignment.ts`): a `'none'` slot is a real,
// UI-selectable call site again, and CLAUDE.md's retirement note only applies while
// nothing calls a generator.

/**
 * Holding M fires ~30 keydowns a second, so an unguarded toggle lands on
 * whichever state the repeat count's parity happened to pick. Keys aimed at a
 * focused control that CONSUMES them belong to that control, not to the game.
 *
 * `consumesKey` (`input/ui-actions.ts`), the SAME rule `input.ts` drives the tank by
 * (issues #318, #494): a control keeps only the keys it consumes. Text entry keeps
 * everything; a slider or select keeps Space, Enter, the arrows and Home/End; a button
 * keeps Space and Enter and nothing else -- so M, P and Escape on a focused button OR a
 * focused volume slider are the player's. The guard used to name `button`, and that one word is why every
 * panel arrival had to focus its CONTAINER rather than a control: a focused Resume
 * killed Escape-to-resume, a focused menu button killed M. Then it named
 * `input,select,textarea`, which still ate Escape on a focused slider. Back returns
 * focus to the control that opened the layer (spec: "restores the invoking control"),
 * which is only legal because a focused control no longer swallows the hotkeys.
 */
export function isMuteHotkey(e: KeyboardEvent): boolean {
  if (e.repeat) return false;
  if (consumesKey(e.target, e.key)) return false;
  return e.key === 'm' || e.key === 'M';
}

/** Escape or P toggles pause, under the same repeat/focused-control guard as mute. */
export function isPauseHotkey(e: KeyboardEvent): boolean {
  if (e.repeat) return false;
  if (consumesKey(e.target, e.key)) return false;
  return e.key === 'Escape' || e.key === 'p' || e.key === 'P';
}

/**
 * Shells the player currently has in flight, which is what SHELL_CAP limits.
 *
 * Counts the player's OWN live bullets: dropMine and spawnBullet enforce the
 * cap per owner, so a shared count would read the whole arena's traffic and be
 * meaningless as a cap indicator.
 */
export function playerShellsInFlight(world: World, playerId: number | undefined): number {
  if (playerId === undefined) return 0;
  let n = 0;
  for (const b of world.bullets) {
    if (b.alive && b.ownerId === playerId) n += 1;
  }
  return n;
}

/**
 * Did THIS tracked player die this frame?
 *
 * The event stream is shared, so `some(e => e.type === 'tank-destroyed')` is
 * true for every enemy kill as well -- the presence-only mistake CLAUDE.md
 * warns about. Exported so the discrimination is testable without engineering
 * a real death inside a driven frame.
 *
 * Discriminated by `tankId`, not `kind === 'player'`: at playerCount > 1 a
 * second player-kind tank exists, and kind alone can no longer tell "the
 * tracked player died" apart from "some OTHER player-kind tank died". Zero
 * behavior change at N=1 -- the only player-kind tank's id IS playerId.
 */
export function isPlayerDeath(events: SimEvent[], playerId: number): boolean {
  return events.some((e) => e.type === 'tank-destroyed' && e.tankId === playerId);
}

/**
 * Which colour signalPlayerDeath's screen vignette tints to (death-pulse, issue #200).
 *
 * Single-player (`playerCount` 1) always gets the classic red -- `SINGLE_PLAYER_DEATH_
 * VIGNETTE` -- unconditionally, so existing single-player behaviour cannot move. At
 * `playerCount >= 2` it is the DYING tank's own identity colour: `TEAM_COLORS[team]` in
 * 'teams' mode, `IDENTITY_RING_COLORS[controlledBy]` otherwise -- the same dispatch
 * entities.ts's own ring/tint colouring already uses at its `curr.mode === 'teams' ?
 * teamColor(...) : identityColor(...)` sites, so the vignette always matches the ring
 * the dying tank draws on screen. `tank-destroyed` does not carry `controlledBy` itself
 * (see events.ts), so this looks the tank up in `world`; `resolveWalls`'s sibling
 * invariant does not apply here, but the same fact this file already relies on for
 * `driver.world.lives` above does -- a destroyed tank stays in `world.tanks` (`alive:
 * false`, never spliced, see world.ts/bullets.ts/mines.ts) -- so the lookup finds it.
 * Falls back to the classic red if the tank cannot be found (should not happen). The
 * multiplayer branch delegates to `resolveOwnerColor` (`render/entities.ts`, issue
 * #200's death-pulse work) -- the same team/identity dispatch `syncTanks`'s own
 * ring/spawn-ring sites and `shellTintFor` use, rather than a fourth copy that indexed
 * `TEAM_COLORS`/`IDENTITY_RING_COLORS` directly. That used to mean an out-of-range slot
 * fell back to this file's red instead of `resolveOwnerColor`'s white; unreached today
 * (`players` caps at 4, matching both palettes' length) and not pinned by any test, so
 * folding it in changes no observed behaviour.
 */
export function deathVignetteColor(world: World, playerId: number, playerCount: number): number {
  if (playerCount === 1) return SINGLE_PLAYER_DEATH_VIGNETTE;
  const tank = world.tanks.find((t) => t.id === playerId);
  if (!tank) return SINGLE_PLAYER_DEATH_VIGNETTE;
  return resolveOwnerColor(world, tank);
}

/**
 * Per-player kill/death attribution for the results-screen tally (coop semantics plan,
 * docs/superpowers/plans/2026-08-15-coop-semantics.md; generalized to versus modes by
 * the n-player arc's PR 4). Mutates `kills`/`deaths` in place, indexed by slot
 * (`controlledBy`), the same array-as-accumulator shape `checkAchievements`'s callers
 * already use elsewhere in this file.
 *
 * `world.rules.mode` dispatches two entirely separate rules:
 *
 *  - `'campaign-coop'`: TODAY'S rule, byte-for-byte. `e.kind === 'player'` is excluded
 *    -- only ENEMY kills count as a "kill" here, matching the results screen's existing
 *    lifetime/attempt stat semantics (stats.ts's shellKills/mineKills never count a
 *    teammate). AI-on-AI friendly fire (brown.ts's bank shots, teal's alternation --
 *    CLAUDE.md's "A green tank changed what structuralFailures has to check") is
 *    excluded too: `killer?.kind !== 'player'` skips any credit whose `by.ownerId`
 *    resolves to a non-player-kind tank, so an enemy killing another enemy increments
 *    nothing. `deaths` is untouched in this branch -- campaign-coop has no per-slot
 *    death tally, only the shared win/lose machinery in world.ts.
 *  - `'ffa'`/`'teams'`: the OPPOSITE selection -- a `tank-destroyed` event where BOTH
 *    victim and killer are player-kind. The killer's slot gets a kill, the victim's
 *    slot gets a death. Self-elimination (`killer.id === victim.id`, an own shell or
 *    own mine) credits a death to the victim and a kill to NOBODY -- the no-suicide-
 *    credit convention common to arena shooters. There are no enemy-kind tanks to
 *    exclude in these modes (loadArena strips them), so this is not merely the
 *    campaign-coop rule with the polarity flipped -- it is genuinely victim-first
 *    where campaign-coop is killer-only.
 *
 * Teams sums a per-team total from these same per-slot figures as a DERIVED reduction
 * at render/HUD time (Tank.team, no new storage here) -- this function stays unaware of
 * teams beyond dispatching on `world.rules.mode`.
 *
 * Not `stats.ts`: `StatCounts` has no per-player axis, and bolting one on would
 * conflate two orthogonal dimensions (metric vs. player) in one shape -- adopted
 * default 4 keeps lifetime stats P1-scoped. This stays a small loop.ts-local array
 * pair instead.
 */
export function tallyCoopKills(events: SimEvent[], world: World, kills: number[], deaths: number[]): void {
  if (world.rules.mode === 'ffa' || world.rules.mode === 'teams') {
    for (const e of events) {
      if (e.type !== 'tank-destroyed' || e.kind !== 'player') continue; // player-vs-player only
      const victim = world.tanks.find((t) => t.id === e.tankId);
      if (!victim) continue;
      const victimSlot = victim.controlledBy ?? 0;
      deaths[victimSlot] = (deaths[victimSlot] ?? 0) + 1;
      if (e.by.ownerId === e.tankId) continue; // self-elimination: a death, credited to nobody's kill total
      const killer = world.tanks.find((t) => t.id === e.by.ownerId);
      if (killer?.kind !== 'player') continue;
      const killerSlot = killer.controlledBy ?? 0;
      kills[killerSlot] = (kills[killerSlot] ?? 0) + 1;
    }
    return;
  }
  for (const e of events) {
    if (e.type !== 'tank-destroyed' || e.kind === 'player') continue; // enemy kills only
    const killer = world.tanks.find((t) => t.id === e.by.ownerId);
    if (killer?.kind !== 'player') continue; // AI friendly fire doesn't count as a "kill"
    const slot = killer.controlledBy ?? 0;
    kills[slot] = (kills[slot] ?? 0) + 1;
  }
}

/**
 * The music's arrangement density, from how much of the arena is left.
 *
 * Rises as enemies are destroyed, so the round BUILDS: the opening is bass and
 * pads, the stabs join partway, and the melody arrives for the last tank.
 *
 * The denominator is `total - 1` on purpose. Dividing by `total` would only
 * reach 1.0 once every enemy is dead -- i.e. the fullest arrangement would play
 * for the instant the round ends and never during a fight. Pure and exported so
 * the mapping is testable without a game, like round.ts's phaseAt.
 */
export function musicIntensity(remaining: number, total: number): number {
  if (total <= 1) return 1;
  const destroyed = Math.max(0, total - remaining);
  return Math.max(0, Math.min(1, destroyed / (total - 1)));
}

/**
 * Which musical world an AppLocation belongs to.
 *
 * Pause deliberately keeps the ARENA context: the round is still in progress
 * behind the panel, and moving the music elsewhere would make a pause feel like
 * leaving the level. It is ducked instead.
 *
 * The launch route shares the Main Menu's suite rather than taking one of its
 * own -- it is the same world musically, and the screen on which nothing can be
 * heard yet anyway. The context is set here so that the gesture which
 * dismisses launch starts the menu bed already in the right suite, with no
 * switch on arrival.
 *
 * An outcome routes through `legacyOutcomePresentation` -- the explicitly-named
 * compatibility projection (`app-state.ts`) that flattens a typed outcome onto
 * the shipped victory/defeat pair. It is a PRESENTATION decision, not a claim
 * about which seat won: a decided versus match plays the victory bed whoever
 * survived, and a versus DRAW plays the defeat bed, exactly as the shipped
 * `win`/`lose` events did.
 *
 * EXHAUSTIVE over routes on purpose. A silent `return 'menu'` for anything
 * non-gameplay meant a future Records or Settings route would inherit the menu
 * bed by accident rather than by decision; the switch below makes adding a
 * route a compile error here.
 */
export function musicContextFor(location: AppLocation): SuiteContext {
  if (location.kind === 'route') {
    switch (location.route.kind) {
      // Every shipped route shares the menu suite -- including `launch`, which
      // is the same world musically and is the screen on which nothing can be
      // heard yet anyway. Setting it here means the gesture that dismisses
      // launch starts the menu bed already in the right suite, with no switch
      // on arrival. Routes that later dependent issues carve out may choose
      // their own context; this preserves today's shipped rule.
      case 'launch':
      case 'main-menu':
      case 'campaign':
      case 'practice':
      case 'versus-setup':
      case 'settings':
      case 'records':
      case 'customize':
      case 'developer-tools':
        return 'menu';
      default: {
        const unreachable: never = location.route;
        return unreachable;
      }
    }
  }
  switch (location.phase.kind) {
    case 'playing':
    case 'paused':
      return 'arena';
    case 'outcome':
      return legacyOutcomePresentation(location.phase.outcome) === 'win' ? 'victory' : 'defeat';
    default: {
      const unreachable: never = location.phase;
      return unreachable;
    }
  }
}

/**
 * Project an `AppLocation` onto the HUD surface. The HUD does not receive the
 * canonical model directly (see `HudSurface`'s own doc comment); this is the
 * boundary where the projection happens. The mapping preserves every visible
 * behavior: Launch → 'launch' hides the topbar and shows the splash panel;
 * Main Menu → 'main-menu' shows the title panel; playing/paused pass through;
 * an outcome projects to `outcome-win`/`outcome-lose` through
 * `legacyOutcomePresentation`, the explicitly-named compatibility projection.
 *
 * EXHAUSTIVE over routes on purpose: every non-primary route
 * (settings/records/customize/...) is listed as landing on 'main-menu' because
 * the Main Menu is the shipped host for those panels TODAY, and that is a
 * decision each future route must re-make at compile time rather than inherit
 * from an `else`.
 */
export function locationToHudSurface(location: AppLocation): HudSurface {
  if (location.kind === 'route') {
    switch (location.route.kind) {
      case 'launch':
        return 'launch';
      case 'main-menu':
      case 'campaign':
      case 'practice':
      case 'versus-setup':
      case 'settings':
      case 'records':
      case 'customize':
      case 'developer-tools':
        return 'main-menu';
      default: {
        const unreachable: never = location.route;
        return unreachable;
      }
    }
  }
  const phase = location.phase;
  if (phase.kind === 'playing') return 'playing';
  if (phase.kind === 'paused') return 'paused';
  return legacyOutcomePresentation(phase.outcome) === 'win' ? 'outcome-win' : 'outcome-lose';
}

/**
 * Who actually survived a versus match, read off the world that emitted the
 * terminal event.
 *
 * This is the honest answer the sim's bare `win`/`lose` events cannot give.
 * `resolveStatusFfa`/`resolveStatusTeams` (sim/world.ts) emit `win` when
 * exactly one player -- or exactly one team -- is NOT ELIMINATED, and `lose`
 * when none are. Neither says which seat, and the previous model turned every
 * decided match into `localPlayerWon: true`, which in a couch match is not even
 * a well-formed claim: every participant is local.
 *
 * Safe to read at classification time because the sim LATCHES: `stepInputs`
 * runs its stage block only `if (draft.status === 'playing')`, so once a
 * terminal status is set no further tick mutates tanks, and the driver's
 * `world` getter still points at the deciding world when `onEvents` fires.
 *
 * Uses the sim's own `isVersusEliminated` predicate rather than a local copy,
 * so the model cannot drift from the rule that produced the event.
 */
export function versusResultFromWorld(world: World): VersusResult {
  const players = world.tanks.filter((t) => t.kind === 'player');
  const remaining = players.filter((t) => !isVersusEliminated(t));
  if (world.rules.mode === 'teams') {
    const teams = new Set(remaining.map((t) => t.team));
    // Exactly one side left is that side's win; anything else is a draw --
    // matching resolveStatusTeams, which resolves a simultaneous double
    // wipeout to `lose` rather than inventing a third status.
    const only = [...teams];
    if (only.length === 1 && only[0] !== undefined) return versusWinnerTeam(only[0]);
    return versusDraw();
  }
  if (remaining.length === 1) return versusWinnerSlot(remaining[0].controlledBy ?? 0);
  return versusDraw();
}

function countEnemies(world: World): number {
  let n = 0;
  for (const t of world.tanks) {
    if (t.kind !== 'player' && t.alive) n += 1;
  }
  return n;
}

/**
 * A FUNCTION, not an exported const.
 *
 * A module-scope object literal holding `window` throws ReferenceError on
 * import outside a DOM environment, which would make this module unimportable
 * from any node-environment test -- even one that only wanted a type. Nothing
 * in this module's top-level evaluation touches the global, and the host is
 * read off globalThis so that a mis-call under node yields undefined at the use
 * site rather than a ReferenceError at import.
 */
export function createBrowserDeps(shell: AppShell = createBrowserAppShell()): GameDeps {
  const search = globalThis.location?.search ?? '';
  const devFlags = parseDevFlags(search);
  // Resolved ONCE and shared by all six stores. It used to be resolved per
  // store, which was harmless only because localStorage hands back the same
  // object every time -- with the in-memory fallback it would have given each
  // store its own private namespace. storage.ts makes that structural.
  //
  // Since issue #320 the resolution happens one level HIGHER still: `AppSettings` owns it
  // for the whole page (app-settings.ts), and this function is handed the result. That is
  // what makes the stores -- and with them mute, volume and every other preference --
  // the SAME objects across the campaign/versus reboot that rebuilds these deps. The
  // default argument keeps `createBrowserDeps()` callable on its own, which is what the
  // tests that exercise dev-flag parsing against a real `location` rely on.
  const appSettings = shell.settings;
  const { storage, stores } = appSettings;
  const { progress, stats, customization, settings, achievements, run } = stores;
  return {
    createRenderer,
    createPreview: createTankPreview,
    createInput: createInputController,
    createGamepadSource: (padIndex) => createGamepadInputSource(readNavigatorGamepads, padIndex),
    readDetectedPads: () => readDetectedPads(readNavigatorGamepads),
    // The PAGE's engine, the same instance on every session (issue #317) -- so the
    // context a session resumed is still resumed for the next one, which is what keeps
    // skipping the splash from trading a redundant screen for a silent menu.
    createAudio: () => shell.audio,
    // ...and therefore NOT `dispose()`. Stopping the bed is the whole release: it ends the
    // outgoing session's music (without which the abandoned level's bed would play on
    // under the new menu) and leaves the engine and its resumed context alive.
    releaseAudio: (engine) => engine.stopMusic(),
    launchGate: {
      dismissed: () => shell.launchDismissed(),
      dismiss: () => shell.dismissLaunch(),
    },
    createDirector: (engine, playerId) =>
      createAudioDirector(engine, playerId, { blockedFire: devFlags.blockedFire }),
    createHaptics: (playerId) =>
      createHapticsDirector(resolveVibrate(), playerId, { blockedFire: devFlags.blockedFire }),
    createStateMachine: createGameStateMachine,
    // The pane needs the retained VS setup (issue #260) and `GameDeps.createHud` is
    // deliberately still `(root) => Hud`: the store is a BROWSER-WIRING concern, so it
    // is bound here rather than widened into the injected seam that ~200 tests build.
    createHud: (root) =>
      createHud(root, {
        versusSetup: stores.versusSetup,
        // The browser's Back consumes an open layer before it leaves the page (issue
        // #318). Bound here, the browser-only factory, for the same reason the store is:
        // `null` where `history.pushState` is missing, and absent from every injected
        // HUD, which is what keeps the ~230 HUD tests off the History API entirely.
        history: browserHistoryHost(window),
        // Issue #542's menu-transition arm. Bound here for the same reason the two above
        // are: `GameDeps.createHud` stays `(root) => Hud`, so no injected HUD in a test
        // grows a developer flag it has no opinion about.
        menuTransition: devFlags.menuTransition,
      }),
    levels: createLevelSystem(devFlags, run),
    progress,
    run,
    stats,
    customization,
    settings,
    effectiveSettings: appSettings.effective,
    onSettingsNotice: appSettings.onNotice,
    achievements,
    storage,
    // The namespace `storage` already applies -- read from the same object, so the two
    // cannot disagree about which keys this session is on.
    storageNamespace: appSettings.namespace,
    devConsole: globalThis as unknown as DevConsoleTarget,
    now: () => performance.now(),
    wallMs: () => Date.now(),
    raf: {
      request: (cb) => requestAnimationFrame(cb),
      cancel: (h) => cancelAnimationFrame(h),
    },
    host: globalThis.window as unknown as HostWindow,
    devFlags,
    developerMode: parseDeveloperMode(search),
  };
}

/**
 * The OVERRIDE step `versusAwareDeps` applies on top of a base `GameDeps`, factored out
 * as its own PURE function so it is testable without `createBrowserDeps`'s real
 * `location`/`localStorage` reads. `createBrowserDeps` itself IS callable under jsdom
 * (see its own describe block below) -- but proving that `corpseBlock`/`muzzleInside`
 * dev flags keep reaching the world in a versus session (Task 2's carried hazard H1)
 * would otherwise mean driving them through a real `location.search`, which conflates
 * THIS function's own job with `parseDevFlags`'s, already proven in devflags.test.ts.
 * A fake `GameDeps` with `devFlags.corpseBlock` set directly is the more honest fixture.
 *
 * When `versus` is present:
 * - Resolves `config.arenaId` to a concrete id ONCE, right here, before `levels` is
 *   built (`resolveVersusConfig`, versus-config.ts -- issue #278's fix): a `'random'`
 *   pick is drawn from `deps.devFlags.seed ?? deriveSeed(deps.wallMs())`, the SAME
 *   seed-derivation formula `startGameWith`'s own `nextSeed()` uses for its first world
 *   build (versus-setup-menu spec §2: "the seed derivation that already feeds
 *   `nextSeed()` is the source", not `Math.random`). This session's `resolvedConfig`
 *   is a NEW object only when a resolution actually happened -- a concrete `arenaId`
 *   passes through by identity (`resolveVersusConfig`'s own doc comment).
 * - Swaps `levels` for `createVersusLevelSystem(resolvedConfig, deps.run, deps.devFlags)`
 *   -- the RESOLVED config, not the pane's own `config` -- the session's REAL parsed dev
 *   flags, not the `DEV_FLAGS_OFF` `createVersusLevelSystem` defaults to, so
 *   `corpseBlock`/`muzzleInside` keep working during a versus playtest (H1). Building
 *   `levels` from a concrete `arenaId` is exactly what fixes #278: `bounds()`/`world()`
 *   now agree for the rest of this session's life, on every quit/retry/advance
 *   (`switchTo` in `startGameWith` re-checks `bounds()` but never re-resolves
 *   `'random'`, because there is no `'random'` left in `resolvedConfig` to re-resolve --
 *   this also neutralizes the re-roll-on-quit mechanism issue #261 names, though #261's
 *   own Quit-routing defect is untouched here). Dropping the dev-flags argument would
 *   silently lose that dev-flag support.
 * - Widens `devFlags` with `{ mode, players, friendlyFire }` from `config` (the pane's
 *   own, unresolved config -- these three fields are untouched by resolution) so
 *   `startGameWith`'s own `playerCount` derivation (`deps.devFlags.players`, see
 *   `startGameWith` below) AGREES with the world `createVersusLevelSystem` builds from
 *   `config.players` directly (H2) -- otherwise the two disagree and the spawned tank
 *   count does not match the config the player chose.
 * - Threads `requestVersusSession` and stamps `initialVersusConfig: config` -- the
 *   ORIGINAL, UNRESOLVED config, not `resolvedConfig` -- so the setup pane reopens
 *   pre-filled with `'random'` still selected when that is what was actually chosen
 *   (spec ruling 4; see `initialVersusConfig`'s own doc comment for why `levels` and
 *   this field can name different arenas for one session and that is not a bug).
 * - Threads `requestCampaignSession` (Task 5b) so the versus-kind title screen's
 *   Campaign button has a reboot seam to call -- see `GameDeps.requestCampaignSession`'s
 *   own doc comment for why this is versus-only, same as `initialVersusConfig`.
 *
 * When `versus` is absent (a fresh campaign boot): returns `deps` unchanged except for
 * `requestVersusSession` (still threaded, so a campaign session can reboot INTO
 * versus) and `initialVersusConfig: null` (no prior match to prefill from). `levels`
 * and `devFlags` are NOT touched here -- widening them unconditionally would corrupt a
 * plain campaign boot that no test below would otherwise catch. `requestCampaignSession`
 * is left UNSET here (not defaulted to a no-op): a campaign session's own title has no
 * Campaign button to call it from, so there is nothing this seam would ever reach.
 */
export function applyVersusToDeps(
  deps: GameDeps,
  versus: { config: VersusConfig } | null | undefined,
  requestVersusSession: (config: VersusConfig) => void,
  requestCampaignSession?: () => void,
): GameDeps {
  if (!versus) {
    return { ...deps, requestVersusSession, initialVersusConfig: null };
  }
  const { config } = versus;
  const resolvedConfig = resolveVersusConfig(config, deps.devFlags.seed ?? deriveSeed(deps.wallMs()));
  return {
    ...deps,
    levels: createVersusLevelSystem(resolvedConfig, deps.run, deps.devFlags),
    devFlags: {
      ...deps.devFlags,
      mode: config.mode,
      players: config.players,
      friendlyFire: config.friendlyFire,
      /**
       * DERIVED from the slots, never carried alongside them (issue #260: "a bot count is
       * derived data and is not authoritative"). This is the translation that makes the
       * issue's "developer flags and player setup cannot create competing assignment
       * sources" true by construction: a VS session's `devFlags.bots` is a VIEW of the
       * roles the player chose, so any consumer still reading the count agrees with any
       * consumer reading the roles. Whatever `bots` a URL carried is deliberately
       * overwritten here -- the pane is the more specific, more recent statement of intent.
       */
      bots: botSlotsOf(config.slots).size,
    },
    requestVersusSession,
    initialVersusConfig: config,
    requestCampaignSession,
  };
}

/**
 * `createBrowserDeps()` plus `applyVersusToDeps`'s override step -- the one thing
 * `main.ts`'s wiring-only wrapper calls (CLAUDE.md: `main.ts` stays wiring, behavior
 * lives behind an injected seam). Exported so that seam is itself testable; see
 * `applyVersusToDeps`'s own doc comment for why the override logic is a separate pure
 * function rather than inlined here.
 */
export function versusAwareDeps(
  versus: { config: VersusConfig } | null | undefined,
  requestVersusSession: (config: VersusConfig) => void,
  requestCampaignSession?: () => void,
  /**
   * The page's ONE shell (app-shell.ts), created once by `boot.ts` and handed to every
   * session it starts: settings, the audio engine and the Launch gate. Optional so an
   * existing caller that has none still builds a working session with its own; production
   * always passes it, which is what makes settings, audio and the dismissed splash all
   * survive a reboot.
   */
  shell?: AppShell,
): GameDeps {
  return applyVersusToDeps(
    createBrowserDeps(shell),
    versus,
    requestVersusSession,
    requestCampaignSession,
  );
}

export function startGameWith(
  canvas: HTMLCanvasElement,
  deps: GameDeps,
  /**
   * The page's route UI (issue #468), built once by `boot.ts` and handed to every
   * session. REQUIRED, and a positional argument rather than a `GameDeps` field on
   * purpose: `GameDeps` is the bag of injected seams a session builds its own world
   * from, and this is the opposite -- the one collaborator a session BORROWS and must
   * give back. Making it optional, with a fallback that built a private one, would leave
   * the whole production wiring untested: deleting it from `boot.ts` would keep every
   * test green while every real page silently went back to a per-session HUD.
   *
   * It also REPLACES the old `uiRoot` parameter. A session had no use for the root
   * except to build a HUD in it, and the route host is built on that root one level up,
   * so keeping the argument would have left every caller passing an element nothing read.
   */
  routeHost: RouteHost,
  /**
   * WHICH match the player just asked for (issue #428).
   *
   * Required, and the reason it is: `boot.ts` no longer starts a session eagerly, so
   * every call to this function now answers a deliberate gesture. A default would put
   * back the one thing #428 removes -- a session that exists because the page loaded.
   *
   * See the START BOUNDARY block below for what each intent moves.
   */
  intent: StartIntent,
): GameHandle {
  /**
   * `players` read once, not re-read per world: mirrors `createLevelSystem`'s own
   * `flags.level === 'sandbox'` branch (levels.ts) rather than a new field on
   * `LevelSystem` -- the sandbox is excluded by checking the SAME flag that decided
   * which `LevelSystem` this session got, so the two can never disagree about which
   * session is the sandbox one. `createSandboxWorld` takes no `playerCount` and has
   * no co-op spawn rule to inherit from `loadArena` -- see devflags.ts's `players` doc
   * comment for why this is excluded rather than built.
   *
   * The sandbox exclusion is folded directly into `playerCount` (rather than kept as a
   * separate boolean the way `coopActive` was): 1 in the sandbox regardless of what the
   * flag says, else `players ?? 1` -- so every site below that used to read `coopActive`
   * generalizes uniformly to `playerCount >= 2` / `playerCount`.
   */
  const playerCount = deps.devFlags.level === 'sandbox' ? 1 : (deps.devFlags.players ?? 1);

  /**
   * `bots` clamped against the resolved `playerCount`, not rejected: the two flags
   * parse independently (devflags.ts has no view of the other's value), so `bots=4`
   * with `players` unset (playerCount 1) claims the one slot that exists rather than
   * erroring on a combination nobody asked to be invalid. Unlike `playerCount`, NOT
   * excluded from the sandbox -- see devflags.ts's `bots` doc comment for why: the
   * sandbox already resolves to a single slot, and `bots=1` there is exactly what
   * `autoplay=1` already does unguarded.
   */
  const botCount = Math.min(deps.devFlags.bots ?? 0, playerCount);

  /**
   * May a bot drive a player tank in THIS session -- see `botAssignmentAllowed`. Fixed
   * for the session's life: `world.rules.mode` never changes within one (see the versus-results
   * dispatch below), and a dev flag cannot be set mid-session.
   *
   * The BOOT path already honours this without any help, since `botCount` is 0 whenever
   * the `bots` flag is absent. The panel was the hole: it offered `'bot'` for every slot
   * unconditionally, so a shipped campaign could hand Player 1 to a bot from the title or
   * pause screen and watch the game play itself.
   */
  const botsMayDrivePlayers = botAssignmentAllowed(
    deps.devFlags.mode ?? 'campaign-coop',
    deps.devFlags.bots !== null,
  );
  /**
   * WHICH SLOTS ARE BOTS, and where that answer comes from (issue #260).
   *
   * TWO ENTRY PATHS, ONE DESCRIPTOR -- the issue's "deterministic developer-flag
   * precedence by translating both player and dev entry through the same descriptor
   * boundary". A VS session started from the setup pane carries per-slot roles, and those
   * are authoritative: they are what the player actually saw and chose. A campaign or dev
   * session has no pane, so it keeps the pre-existing derived rule, where the `bots` dev
   * flag claims the LAST `botCount` slots.
   *
   * The two cannot compete, because the VS path does not consult `botCount` at all --
   * `applyVersusToDeps` has already translated the config's roles into `devFlags.bots` so
   * the derived count agrees with the roles rather than contradicting them.
   */
  const versusSlots = deps.initialVersusConfig?.slots;
  /**
   * Per-slot bot competence, from the descriptor the pane validated (issue #267).
   *
   * Built once from the session's own config rather than read per tick: a bot's preset is
   * fixed for the match, and rebuilding the map on every frame would put a descriptor read
   * inside the input path. Campaign and autoplay sessions have no versus config, so this
   * is empty and every bot resolves `normal` -- the authored profile, unchanged.
   */
  const botDifficulty: ReadonlyMap<number, BotDifficulty> = new Map(
    (versusSlots ?? []).flatMap((slot, i) =>
      slot.difficulty === undefined ? [] : [[i, slot.difficulty] as const],
    ),
  );

  /**
   * The controller assignment UI's session-held model (input/assignment.ts).
   *
   * SEEDED DIFFERENTLY BY PATH, and the difference is deliberate rather than an accident of
   * two functions existing:
   *
   *   - VS: `resolveSources` (versus-setup.ts), which packs connected pads DENSELY onto the
   *     human slots and leaves a human with no pad as `'none'` so the Start gate can report
   *     it. That is what makes a disconnected controller visible instead of silently
   *     rebinding, and it is only correct because the pane has already validated the setup.
   *   - Campaign/dev: `deriveInitialAssignment`, which keeps the historical positional rule
   *     (`pad[i] -> slot[i]`, slot 0 keyboard). Nothing validates a campaign co-op session,
   *     so the positional rule stays what it always was rather than acquiring a new failure
   *     mode at this distance from the issue.
   *
   * Mutated after seeding only by `reassignSlot`, via the panel. `botSlots` is not read
   * again: every later site that needs "which slots are bots right now" reads it off
   * `assignment` (`botSlotsFromAssignment`), since a reassignment can move a slot in or out.
   */
  // `readDetectedPads` is the EXISTING injected seam for "what is plugged in right now"
  // (the assignment panel's live list), reused rather than adding a second gamepad read
  // path. Read ONCE here, at session start, which is the moment the setup was validated
  // against; hotplug during a match is the panel's business, not this seeding.
  let assignment: Assignment = seedAssignment(
    versusSlots,
    playerCount,
    botCount,
    deps.readDetectedPads().map((p) => p.padIndex),
  );

  /** Which slots `assignment` currently marks `'bot'` -- recomputed, never cached, so a
   *  mid-session reassignment is always reflected. */
  function botSlotsFromAssignment(a: Assignment): Set<number> {
    const s = new Set<number>();
    for (let i = 0; i < a.length; i++) if (a[i].kind === 'bot') s.add(i);
    return s;
  }

  /** Structural equality for the small `SlotSource` union -- `reassign`'s own diff. */
  function sameSlotSource(a: SlotSource, b: SlotSource): boolean {
    if (a.kind !== b.kind) return false;
    return a.kind === 'gamepad' && b.kind === 'gamepad' ? a.padIndex === b.padIndex : true;
  }

  // A pinned dev seed makes a scripted playthrough reproducible; without one
  // every session is a different fight, which is right for playing and useless
  // for a before/after comparison.
  const nextSeed = (): number => deps.devFlags.seed ?? deriveSeed(deps.wallMs());

  /**
   * The ONE place worlds are built: boot, level advance, quit-to-title and level pick
   * all pass through here, so seed, mine policy, lives carry and the dev
   * invincibility flag cannot drift apart between them -- their parity used to be
   * checked line-by-line in review instead of being structural.
   */
  function buildWorld(atLevel: CampaignLevel, lives?: number): World {
    const w = deps.levels.world(
      atLevel, nextSeed(), deps.devFlags.mineTrigger ?? undefined, lives,
      playerCount >= 2 ? playerCount : undefined,
    );
    if (deps.devFlags.invincible) {
      const p = w.tanks.find((t) => t.kind === 'player');
      if (p) p.invincible = true;
    }
    // `invincible` is the only dev flag applied HERE, after the build: it marks one tank,
    // which is mutable snapshot state. Every rule-shaped flag (`aiPerception` included,
    // since issue #472) is resolved into `World.rules` by levels.ts BEFORE the world
    // exists -- `rules` is frozen, so setting a rule on a built world is not merely
    // discouraged, it throws.
    return w;
  }

  // The board shown behind the title screen reflects the active RUN, not a fresh
  // start: `deps.levels.start` already resolves to the run's own level (levels.ts),
  // and the run's remaining lives must come along with it -- undefined falls back to
  // full LIVES (arena.ts's default), which is correct both when no run exists yet and
  // for the sandbox (tracksProgress false, where the run is never consulted at all).
  //
  // EXCEPT for a dev-flag jump (`isDevJump`): the board it opens is not the run's own
  // position (levels.ts's `start` getter lets a jump beat the run for which board
  // builds), so adopting the run's lives here would show a life count that belongs to
  // a level the player is not looking at -- and since a jumped session never writes
  // back either (see campaignActive below), there would be no way to tell "the run
  // really has this many lives" from "this session merely read them once, stale,
  // at boot". Decided: a jumped session gets fresh lives, the same as practice --
  // adopt-but-never-write was the odd combination (defect 1, adjudicated review of
  // #156), not a deliberate design. Pinned in loop.test.ts.
  let level = deps.levels.start;

  /**
   * The shared `level + 1` arithmetic, split into its two unrelated roles (CLAUDE.md):
   * a 1-based display/record ordinal, and "what comes after this in THIS SESSION's own
   * sequence." Computed against `deps.levels.levels` -- this session's own list -- never
   * against the global `CAMPAIGN_LEVELS` catalog directly: the sandbox's synthetic
   * `'sandbox'` id is not a member of that catalog, and a lookup against it would throw.
   * Relies on the LevelSystem invariant that `start` (and therefore `level`, which is
   * only ever assigned from `start` or from `nextInSession`'s own return) is always
   * reference-equal to an element of `levels` -- see levels.ts's doc comment.
   */
  function ordinalOf(l: CampaignLevel): number {
    return deps.levels.levels.indexOf(l) + 1;
  }
  function nextInSession(l: CampaignLevel): CampaignLevel | null {
    const i = deps.levels.levels.indexOf(l);
    return i >= 0 && i + 1 < deps.levels.levels.length ? deps.levels.levels[i + 1] : null;
  }
  /**
   * THE SESSION'S CANONICAL IDENTITY, produced by the one pure translation
   * boundary (`resolveBootSessionContext`, session-intent.ts) from this boot's
   * developer flags and its optional setup-pane config.
   *
   * Every developer entry point is canonicalized here rather than inferred
   * downstream: `?dev=1&mode=ffa|teams` is a VERSUS session, `?dev=1&level=N`
   * and `?dev=1&level=sandbox` are PRACTICE sessions (isolated play that must
   * not touch the active run), and provenance for all of them lives in
   * `bootContext.developer`, never as a fourth session kind.
   */
  const bootContext: SessionContext = resolveBootSessionContext({
    devFlags: deps.devFlags,
    versusConfig: deps.initialVersusConfig ?? null,
    developerMode: deps.developerMode,
  });

  /**
   * The session's CURRENT identity. Starts at the boot identity and is
   * reassigned by exactly two kinds of transition, both explicit:
   *
   *  - a menu Level-Select pick switches it to `practice-level`;
   *  - New Game and landing on the session's home board reset it to
   *    `bootContext.identity`.
   *
   * Deliberately an IDENTITY, not a descriptor. The descriptor names the level
   * a Practice session is currently on, which changes on every advance/retry --
   * storing it is what let a stale Practice descriptor ride onto a campaign
   * board while run bookkeeping was re-enabled (issue #316 review, finding 4).
   * `switchTo` re-derives the descriptor from THIS plus the level actually
   * built, every single time, so that divergence has no place left to occur.
   */
  let sessionIdentity: SessionIdentity = bootContext.identity;

  /**
   * THE START BOUNDARY (issue #428).
   *
   * `bootContext` above answers "what kind of session do this page's developer flags and
   * retained versus config describe" -- a question about the PAGE, and the only question
   * there was while `boot.ts` started a session eagerly. This answers the one #428 adds:
   * which board did the player just ask for, and does that request own the campaign run.
   *
   * Three of the four intents move something here, and each moves the minimum:
   *
   *  - `campaign-continue` moves NOTHING. `deps.levels.start` already resolves to the
   *    run's own level (levels.ts) and `bootLives` already adopts its lives, which is
   *    exactly what Continue means -- so the intent that used to be the eager boot is
   *    still, byte for byte, the eager boot's behaviour.
   *  - `campaign-new` writes the run ONCE, here, and lands on level one. The write is
   *    guarded the same way the in-session New Game button's is: a session that does not
   *    own the run (practice, sandbox, a developer jump, versus) gets the fresh board
   *    without the run mutation. `startNewRun` is the only persistence write any start
   *    request makes.
   *  - `practice` switches the identity to `practice-level` and lands on the picked
   *    level, so the run is never read or written -- `campaignActive()` below reads this
   *    identity and is what enforces it.
   *  - `versus` moves nothing here: the config reached `applyVersusToDeps` before this
   *    function was called, so `deps.levels` is already the versus level system and
   *    `bootContext.identity` is already Versus.
   *
   * REJECTED BEFORE ANYTHING IS CONSUMED. The level-bounds check is the same one the
   * in-session Levels handler makes, moved to the boundary that now runs first: a request
   * naming a level this session's sequence does not have falls back to the run's own
   * board rather than building an undefined one. No seed is drawn and no run is written
   * on the way to that decision, which is #428's "invalid or cancelled starts create no
   * session, world, seed, or persistence mutation" -- for the world specifically, the
   * caller is what declines to start, and this is the half that declines to MUTATE.
   */
  const startsCampaignRun =
    bootContext.identity.kind === 'campaign' && deps.levels.tracksProgress && !deps.levels.isDevJump;
  let newRunLives: number | undefined;
  if (intent.kind === 'campaign-new') {
    level = deps.levels.levels[0];
    if (startsCampaignRun) newRunLives = deps.run.startNewRun(level.id).livesRemaining;
  } else if (intent.kind === 'practice') {
    const picked = intent.level;
    if (Number.isInteger(picked) && picked >= 0 && picked < deps.levels.levels.length) {
      // `identityForLevelPick`, not an unconditional Practice, for the reason the
      // in-session handler gives: the Levels button is genuinely reachable on a
      // developer-flag versus session, and calling that match Practice would drop its
      // stock strip and report `practice-result` for a match the sim decided by
      // last-slot-standing.
      sessionIdentity = identityForLevelPick(bootContext.identity);
      level = deps.levels.levels[picked];
    }
  }

  /**
   * WHAT THE MENU AND OUTCOME BUTTONS DO -- decided once, from the canonical
   * model, and read by BOTH consumers: the HUD's title/outcome affordances and
   * `onStartRestart`'s own branch. One source of truth on purpose; the branch
   * used to re-derive the same policy by testing `deps.initialVersusConfig`
   * directly, which is one of the provenance reads issue #316 removes.
   *
   * Genuinely fixed for the session's life, unlike `sessionIdentity`: which
   * `LevelSystem` and which reboot seam are installed is settled at boot
   * (levels.ts's one-value-per-session rule), and no menu gesture can change it.
   */
  const relaunchTarget: RelaunchTarget = relaunchTargetFor(bootContext);


  // `&& playerCount === 1`: a multiplayer boot gets fresh LIVES from balance.json, the
  // same as a dev jump -- see campaignActive's doc comment for why a multiplayer
  // session must not adopt (or later write) the real run's life count. Without this, a
  // multiplayer session opened mid-campaign would silently inherit whatever life count
  // the solo run happened to be sitting on, which has no decided meaning for a shared
  // pool.
  const bootLives = sessionIdentity.kind === 'campaign'
      && deps.levels.tracksProgress
      && !deps.levels.isDevJump
      && playerCount === 1
    // The fresh run's lives when this start CREATED one (issue #428), and the active
    // run's otherwise. Read from `newRunLives` rather than re-reading `run.active()`,
    // so New Game's board shows the lives the write above actually returned rather
    // than a second read that a failed write would leave stale.
    ? newRunLives ?? deps.run.active()?.livesRemaining
    : undefined;
  let world = buildWorld(level, bootLives);
  /**
   * A landing on this session's home board is OWED but not yet built (issue #317).
   *
   * Set by the quit-to-title handler, which used to build that board eagerly. The
   * application shell now presents the Main Menu over its own ground rather than over a
   * live world, so navigating there must build nothing, consume no gameplay seed and
   * mutate no run -- and the board the player would resume onto is built at the moment
   * they ask for it instead, which is Continue.
   *
   * Cleared inside `switchTo` rather than at each of the three call sites that could
   * satisfy it (Continue, New Game, a Levels pick): ANY world build satisfies a pending
   * landing, and `switchTo`'s own comment records that its callers' parity became
   * structural precisely because keeping it by hand did not hold.
   */
  let pendingLanding = false;
  let currentDescriptor: SessionDescriptor = descriptorFor(sessionIdentity, ordinalOf(level));
  let currentSession: ResolvedSession = resolveSession(
    currentDescriptor,
    world.seed,
    level.arenaId,
  );
  /**
   * Reseeded from the CURRENT world's own resolved seed on every world switch (see
   * `switchTo`'s matching reassignment below) -- unlike `autoplayRnd`/`autoplayState`
   * further down, which are session-scoped. Bots exist specifically to simulate a
   * REPRODUCIBLE session (`?dev=1&seed=42&bots=K` must replay identically), which is
   * a per-world guarantee, not a per-session one: a pinned dev seed resolves to the
   * SAME value on every level (`nextSeed` returns the constant unconditionally), so
   * reseeding here keeps every level's bot behaviour a pure function of that level's
   * own seed rather than of how much a previous level's stream had already consumed.
   */
  let botSources = createBotSources(world.seed, botSlotsFromAssignment(assignment), botDifficulty);
  /**
   * Is this session allowed to touch the active run at all? False for practice
   * (`sessionIdentity.kind`, the same identity `descriptorFor` turns into this
   * session's descriptor), for any session `deps.levels.tracksProgress` says is not
   * real campaign play -- today that is only the dev sandbox (`?dev=1&level=sandbox`),
   * which must never unlock real levels OR mutate the real run, the same reasoning
   * `deps.progress.recordCleared` is already gated on below -- AND for a dev-flag
   * level jump (`deps.levels.isDevJump`).
   *
   * The jump exclusion is defect 1 (adjudicated review of #156): `tracksProgress`
   * alone does not tell a real campaign session apart from `?dev=1&level=N`, both are
   * true, so a jumped session used to read AND write the real run exactly like a
   * normal one. Proven reachable: a run sitting at level 4, a boot jump to level 1,
   * a win at the jumped level regressed the run to level 2, and a loss ENDED it
   * outright -- neither the level the player was jumped to nor the level the run was
   * actually on. A dev-flag jump is a look-at-any-level tool, not a way to play the
   * campaign, so it is excluded the same structural way practice is: it must not
   * consume, restore, replace, advance or complete the run. Permanent progress
   * (`deps.progress.recordCleared`) is NOT part of this exclusion and keeps its
   * pre-existing behaviour -- it is monotonic and was always writable from a dev
   * jump; only the position/life-pool bookkeeping this function gates is new here.
   *
   * `playerCount === 1` (coop semantics plan, docs/superpowers/plans/2026-08-15-coop-semantics.md;
   * generalized past two players in the N-player PR): the simpler, safer call the plan
   * itself flags. A shared life pool has no decided meaning against the
   * single-player-shaped `RunState.livesRemaining` field (does P2's death count against
   * the solo player's progress if the session is later abandoned mid-run?) -- writing to
   * it now would be writing data whose meaning nobody has decided. Excluded identically
   * to practice/dev-jump/sandbox, at zero cost today since `players` is dev-flag-only
   * with no menu path; a future "ship multiplayer for real" PR can revisit deliberately.
   * See bootLives above for the matching boot-time half of this exclusion.
   */
  function campaignActive(): boolean {
    // Identity FIRST, and identity is the whole answer to "is this a campaign
    // session": practice (menu pick, developer jump, sandbox) and versus (setup
    // pane or developer flags) all report their own kind and are excluded here
    // by construction. The separate `inPractice` boolean this replaced was the
    // competing source of truth finding 4 named -- it could disagree with the
    // descriptor, and did.
    //
    // `tracksProgress`/`isDevJump` are retained as belt-and-braces: they are
    // facts about the installed LevelSystem rather than a second session-kind
    // flag, and with the translation in place they are already implied by the
    // identity. `playerCount === 1` is NOT redundant -- a campaign co-op
    // session (`?dev=1&players=2`) is genuinely Campaign identity, and the run
    // record has no decided meaning for a shared life pool.
    return (
      sessionIdentity.kind === 'campaign' &&
      deps.levels.tracksProgress &&
      !deps.levels.isDevJump &&
      playerCount === 1
    );
  }

  // The STARTED level's board, not a fixed arena and not the level system's own
  // `start`: the renderer must be born fitting the board `level` names by the time the
  // START BOUNDARY above has run. Those two used to be the same level, because a session
  // could only ever open on `deps.levels.start`. Since issue #428 a New Game opens on
  // level one while `start` is still the saved run's level, and a Practice pick opens on
  // whichever level was picked -- and sizing from `start` gave both of them a floor and a
  // camera fitted to a board the player was not on. Measured in the browser first: a run
  // parked on a 15x11 level, New Game, and level one's 11x9 walls sat in the corner of a
  // 15x11 floor. The boot build below does not pass through `switchTo`, so there is no
  // refit to catch it; being born fitting is the only thing that does.
  let shownBounds = deps.levels.bounds(level);
  const { width, height } = shownBounds;

  // Constructed EAGERLY and synchronously. main.ts wraps this call in a
  // try/catch to render a "this browser has no WebGL" page, and that only
  // works if the renderer throws out of HERE rather than out of a later
  // start(). Deferring construction breaks an error path nothing tests.
  const renderer = deps.createRenderer(canvas, width, height, shownBounds.cellSize, {
    aimRay: deps.devFlags.aimRay,
    mineReach: deps.devFlags.mineReach,
    aiContact: deps.devFlags.aiContact,
    blockedFire: deps.devFlags.blockedFire,
    mineTimer: deps.devFlags.mineTimer,
    mineWarn: deps.devFlags.mineWarn,
    // The paint shop's saved colour, skin and accent, applied from the first frame.
    playerColor: deps.customization.hexFor(deps.customization.hull()),
    playerSkin: deps.customization.skin(),
    playerAccent: deps.customization.accentHexFor(deps.customization.accent()),
    // `?dev=1&quality=low|medium|high`; a null flag resolves to `high`, today's shipped
    // values -- see render/quality.ts.
    quality: qualityFor(deps.devFlags.quality),
    // `?dev=1&enemyDeathPulse=1` (issue #200): player deaths always ring; this only
    // gates non-player ones. See death-pulse.ts's own doc comment.
    enemyDeathPulse: deps.devFlags.enemyDeathPulse,
  });
  const input = deps.createInput(canvas, (x, y) => renderer.screenToGround(x, y), {
    // `pad[i] -> slot[i]` (n-player arc PR3): NOT forced off at `playerCount >= 2`
    // anymore. Slot 0 keeps keyboard/mouse/touch as its baseline and can additionally
    // merge gamepad[0] -- the same `?dev=1&gamepad=1` flag, same semantics, as
    // single-player -- because every co-player slot below now owns its OWN dedicated
    // pad index (slot i reads padIndex i), so slot 0's optional pad[0] merge and slot
    // 1's dedicated pad[1] reader can never contend over the same index. This is a
    // deliberate reversal of the pre-PR3 rule (slot 0 always gamepad:false once a
    // second player existed): that rule existed only because the OLD mapping put slot
    // 1 on pad[0] too, so keeping slot 0 off it was the only way to avoid two readers
    // racing one physical pad. THE NAMED TRADEOFF this reversal buys: a session's
    // ONLY physical pad (almost always browser index 0) now feeds slot 0 if this flag
    // is set, not slot 1 -- "P1 keyboard, hand the one pad to P2" has no zero-flag path
    // anymore. Accepted, not fixed -- see gamepad.ts's module doc comment and
    // docs/superpowers/plans/2026-08-17-controllers-4.md.
    gamepad: deps.devFlags.gamepad,
  });
  // The saved scheme and fire mode, pushed at boot so the very first touch already uses
  // them. Read through `effectiveSettings`, never the store: the effective layer is the
  // only place allowed to decide what a stored preference actually means on this device,
  // and reading the raw store here would be a second, silently divergent answer.
  //
  // `applyEffectiveSettings` below re-pushes both -- and everything else -- from one
  // place once the HUD, audio and haptics exist, and on every later change. These two
  // calls exist because `input` is built here, long before that.
  {
    const effective = deps.effectiveSettings.current();
    input.setTouchScheme(effective.touchScheme);
    input.setFireMode(effective.fireMode);
  }
  /**
   * Build the `PlayerInputSource` a `SlotSource` DESCRIBES -- `null` for `'bot'`, which
   * has none: `decidePlayerInput` reads straight off `botSources`/`world`, so building a
   * source for a slot that will never call `.sample()` on it would be dead construction.
   * `'keyboard'` is always the ONE `input` singleton, whichever slot currently holds it
   * -- never a fresh instance, and never disposed here (see `reassignSlot`'s doc comment
   * for why). `'gamepad'`/`'none'` are each a fresh construction, per the controller
   * assignment UI's "rebuild, don't re-point" rule -- `createGamepadInputSource` closes
   * over `padIndex` at construction, so a slot that changes which pad it reads gets a
   * new instance, not a mutated one.
   */
  function buildRealSource(source: SlotSource): PlayerInputSource | null {
    switch (source.kind) {
      case 'keyboard':
        return input;
      case 'gamepad':
        return deps.createGamepadSource(source.padIndex);
      case 'none':
        return createHeldInputSource();
      case 'bot':
        return null;
    }
  }
  /**
   * The real, constructed `PlayerInputSource` for every NON-bot slot, keyed by slot
   * number -- driven entirely by `assignment`, not by a hardcoded slot-0/1..N-1 split
   * (the controller assignment UI's whole point: which slot holds keyboard vs. which
   * gamepad index is now an explicit, sticky field, not `i === 0` / `i`). Hotplug and
   * "no pad ever connected" both still fall out of `createGamepadInputSource` itself
   * (see its own doc comment): it polls `getGamepads()[padIndex]` fresh every tick, so a
   * slot with nothing plugged in echoes its tank's own position back as `aim` (the
   * turret holds instead of slewing toward world-origin), and a pad connecting or
   * disconnecting mid-session at that index is visible on the very next tick. A `'none'`
   * slot gets the same hold, from `createHeldInputSource` (`input/assignment.ts`).
   */
  const realSources = new Map<number, PlayerInputSource>();
  for (let i = 0; i < playerCount; i++) {
    const src = buildRealSource(assignment[i]);
    if (src) realSources.set(i, src);
  }
  const audio = deps.createAudio();
  // MUTABLE: loadArena numbers tanks in grid-scan order, so the player's id differs
  // per arena (16 in ARENA_01, 15 in ARENA_02). Every world rebuild recomputes it and
  // rebinds the director, or the player's own cannon scores as an enemy's.
  let playerId = world.tanks.find((t) => t.kind === 'player')?.id;
  /**
   * `?dev=1&autoplay=1`: the scripted "competent player" (sim/ai/player-profile.ts)
   * drives the tank instead of the real input controller, so the game can demo itself.
   *
   * Its own RNG stream and hold-state, independent of the world's own seed -- see
   * player-profile.ts's module comment for why driving the player must not draw from
   * the same stream the enemy AI does. Seeded once per session (not per level/reset):
   * autoplay is a demo aid, not a replay a test asserts against, so it does not need
   * `buildWorld`'s reproducibility guarantees the way the world's own seed does.
   *
   * The flag is read HERE, at the boundary, and never reaches src/sim/: decidePlayerInput
   * takes a World and returns an InputState exactly like the real controller's sample()
   * does, so step() cannot tell which one produced it, and a replay stays an exact
   * function of its inputs whether autoplay was on or not.
   *
   * Substitutes SLOT 0 only: autoplay predates multiplayer and only ever demos P1. At
   * `playerCount >= 2`, every other slot's own source still samples through on the same
   * tick -- the two are not exclusive of each other.
   */
  const autoplayRnd = mulberry32(deriveSeed(deps.wallMs()) + 1);
  const autoplayState = createPlayerAiState(autoplayRnd);
  /**
   * The tank a slot drives, resolved the SAME way for every purpose this file needs it
   * for (bot substitution here, the aim-stick position feed in onSimulated below):
   * `controlledBy ?? 0` mirrors the render seam's own convention. At playerCount 1 this
   * is identical to a bare `kind === 'player'` find, since no `controlledBy` is stamped
   * and the one player-kind tank defaults to slot 0.
   */
  function tankForSlot(w: World, slot: number): Tank | undefined {
    return w.tanks.find((t) => t.kind === 'player' && (t.controlledBy ?? 0) === slot);
  }
  /**
   * Bots ride the SAME per-slot substitution autoplay already established at slot 0,
   * generalized to every bot-claimed slot -- `createBotInputSource` per the n-player
   * arc's PR2 design doc is this branch, not a separate `PlayerInputSource`
   * implementation: `decidePlayerInput` already takes a `World` and returns an
   * `InputState` exactly like a real source's `sample()`, so no adapter object is
   * needed, only another arm of this same map.
   *
   * Precedence when BOTH `autoplay` and `bots` claim slot 0 (`bots` can reach slot 0 --
   * see `botSlotsFor`): autoplay wins, checked first, unchanged from today's sole
   * branch. This is a deliberate, narrow exception to bots' own reproducibility
   * guarantee -- autoplay's stream is `wallMs()`-seeded, so a session with BOTH flags
   * set is not reproducible at slot 0 even under a pinned `?dev=1&seed=`. Every other
   * bot-claimed slot is unaffected: autoplay only ever substitutes slot 0.
   */
  const effectiveInput = {
    sample: (): InputState[] => {
      const out: InputState[] = [];
      for (let i = 0; i < playerCount; i++) {
        if (i === 0 && deps.devFlags.autoplay && playerId !== undefined) {
          out.push(decidePlayerInput(driver.world, playerId, autoplayRnd, autoplayState));
          continue;
        }
        const bot = botSources.get(i);
        if (bot !== undefined) {
          const tank = tankForSlot(driver.world, i);
          out.push(bot.decide(driver.world, tank?.id ?? -1));
          continue;
        }
        out.push(realSources.get(i)!.sample());
      }
      return out;
    },
  };
  /**
   * `?dev=1&replay=1`: remember what was sampled, tick by tick.
   *
   * Wraps `effectiveInput`, NOT `input`: effectiveInput is what the driver is
   * handed, so this captures the stream step() actually saw -- including the
   * autoplay substitution above. Wrapping `input` instead would record an empty
   * stream for every autoplay demo while looking correct in a normal session.
   *
   * The driver is untouched: it already calls `input.sample()` exactly once per
   * simulated tick, so a decorator is the whole mechanism. A trace spans ONE
   * world, so `begin` restarts it on every level switch (see switchTo).
   */
  const recorder: RecordingInput | null = deps.devFlags.replay
    ? createRecordingInput(effectiveInput, replayMetaFor(world, level.arenaId))
    : null;
  const director = deps.createDirector(audio, playerId ?? -1);
  const haptics = deps.createHaptics(playerId ?? -1);
  // The EFFECTIVE value, not the stored preference: a device with no `navigator.vibrate`
  // has `deviceHaptics: false` here however the player has the switch set, and the
  // preference is left untouched so it comes back if the capability ever does
  // (effective-settings.ts). `applyEffectiveSettings` re-pushes this on every change,
  // including a capability change, so this call only covers the window before the HUD
  // exists. Re-reading on every world switch would be redundant with that.
  haptics.setEnabled(deps.effectiveSettings.current().deviceHaptics);
  /**
   * This session's hold on the page's route UI (issue #468).
   *
   * The HUD, the state machine and the `RouteUi` are no longer built here -- they belong
   * to `route-host.ts`, one per page, and outlive every session. What a session does now
   * is TAKE the gameplay slot, fill it, and release it in `dispose()`. `attach()` is also
   * what resets the visible route, which is the job the freshly-constructed state machine
   * used to do on every Campaign<->Versus reboot.
   */
  const slot = routeHost.attach();
  const { hud, sm, routeUi } = routeHost;
  /**
   * Issue #516's `hud` blocked-fire arm. Constructed here rather than behind a `GameDeps`
   * seam because it needs nothing from the browser -- the audio and haptic arms sit behind
   * seams only because an AudioEngine and `navigator.vibrate` do. Its gate, its
   * controlling-player filter and its one-row-per-cue table live in blocked-fire-hud.ts;
   * this line is wiring, and `handle` is called from onFrameEvents with the same frame
   * events every other consumer of the stream sees.
   */
  const blockedFireHud = createBlockedFireHudCue(hud, playerId, {
    blockedFire: deps.devFlags.blockedFire,
  });

  /**
   * THE PRODUCTION CLASSIFIER (issue #316's finding 1).
   *
   * Both facts a terminal event must be read against are owned here and
   * nowhere else, so they are handed in rather than left to a descriptor-only
   * default:
   *
   *  - `isFinalCampaignLevel` is what separates Mission Clear from Campaign
   *    Complete. It reads the LIVE `level`, so it answers for whichever level
   *    actually just ended rather than for the boot level.
   *  - `versusResult` reads the world that emitted the event
   *    (`versusResultFromWorld`), so a versus match reports the slot or team
   *    that genuinely survived -- or a draw -- instead of asserting that the
   *    local player won.
   *
   * `driver` is referenced lazily: it is constructed below, and this closure
   * can only run from inside a driver frame, by which time it is assigned.
   *
   * Handed to the SLOT rather than to a constructor argument since #468: the machine is
   * built once per page and both of these are facts about one session's driver, so the
   * indirection is what lets the machine outlive them. `route-host.ts` documents why the
   * empty-slot fallbacks are unreachable.
   */
  slot.setOutcomeContext({
    isFinalCampaignLevel: () => nextInSession(level) === null,
    versusResult: () => versusResultFromWorld(driver.world),
  });
  // The config this session was built from, so the Versus Setup pane prefills from the
  // player's own last match. Retained by the route host after this session is gone.
  //
  // ONLY WHEN THERE IS ONE. `applyVersusToDeps` stamps `initialVersusConfig: null` on
  // every campaign session, so an unconditional push here would have a campaign start
  // CLEAR the retained config -- and the pane would come up blank on the one journey it
  // exists for: play a match, go back to the menu, open Versus again to tweak it. A
  // session that has no versus config has said nothing about the last match played, which
  // is the same reasoning `session-host.ts` gives for not clearing its own
  // `lastVersusConfig` on a campaign replacement. (Raised by review on PR #475.)
  if (deps.initialVersusConfig) slot.setVersusConfig(deps.initialVersusConfig);

  /**
   * THE ONE PLACE a settings value reaches a runtime consumer.
   *
   * Before issue #320 each preference had its own three-step echo -- write the store,
   * read back the accepted value, push it to the HUD and to the one runtime object that
   * cared -- repeated per setting, and mute/volume had no store at all, so the audio
   * engine and both mute buttons were the state. That is what let a returning player's
   * volume slider sit at DEFAULT_VOLUME while the game played at something else, and what
   * made a versus reboot silently unmute.
   *
   * Now every handler does exactly one thing: write the store. This function is what runs
   * afterwards, from the two subscriptions below, and it is the only writer of runtime
   * audio/input/haptics/HUD state from settings.
   *
   * Note which side each consumer is given:
   *
   *  - `haptics.setEnabled` gets the EFFECTIVE value, so a device with no
   *    `navigator.vibrate` stays silent whatever the switch says.
   *
   * The DISPLAY side of that same split -- the Settings toggle showing the STORED
   * preference, because a switch forced off on an unsupported device reads as a preference
   * that was erased, which issue #320 forbids -- moved with the rest of the HUD pushes to
   * `route-host.ts`'s `paintSettingsControls` (issue #324). The rule did not change owner
   * as an afterthought: it is stated there, beside the call that now depends on it.
   *
   * Touch scheme and fire mode are ungated, so stored and effective agree by construction
   * (effective-settings.ts); they are read from the effective side so that every consumer
   * in this function reads from the same place a future gate would appear.
   */
  function applySettings(): void {
    const effective = deps.effectiveSettings.current();
    audio.setMuted(effective.muted);
    audio.setVolume(effective.volume);
    input.setTouchScheme(effective.touchScheme);
    input.setFireMode(effective.fireMode);
    haptics.setEnabled(effective.deviceHaptics);
    // NO `hud.*` HERE (issue #324). Every line above drives a RUNTIME consumer this
    // session owns; the six HUD pushes that used to follow drove Settings' own controls
    // and the page frame, which the session does not own and cannot be the only writer
    // of -- a page with no session (since #428, every page before its first match) got
    // no settings display at all, which is the hole #485 recorded.
    // `route-host.ts`'s `paintSettingsControls` is now the single writer, on the same
    // subscription to the same handle.
    //
    // The gameplay renderer stays here, because it IS this session's (issue #289): one
    // subscription, two consumers in two owners -- NOT a second media-query read, which
    // capabilities.ts forbids by design.
    renderer.setReducedMotion(effective.reducedMotion);
  }

  applySettings();
  // ONE subscription. `EffectiveSettingsHandle.subscribe` republishes on any INPUT change
  // -- a stored preference, a capability, or the OS motion preference -- not only when
  // the resolved value moves, which is what lets this single registration cover both the
  // runtime consumers and the controls that edit the preferences (see its own comment).
  const stopEffectiveSubscription = deps.effectiveSettings.subscribe(applySettings);
  /**
   * The persistence notice (issue #320): one line, in the existing self-expiring toast
   * rail, at most once per page.
   *
   * Registered rather than polled because the condition it reports is not always known at
   * boot: a real `localStorage` whose `setItem` throws (Safari private mode) only reveals
   * itself on the first write. `showToast` is already non-modal, already `aria-live`
   * polite, already self-expiring and already takes no input -- reusing it is what keeps
   * this from becoming a new navigation state.
   *
   * The unregister is not optional: this closure holds THIS session's HUD, and the
   * session is torn down and rebuilt on every campaign/versus reboot.
   *
   * HELD WHILE THE SPLASH IS UP, and this is the difference between the notice existing
   * and the player seeing it. `.hud-splash` is `z-index: 3` over a full-bleed
   * `rgba(14, 17, 22, 0.92)` scrim; `.hud-toasts` is `z-index: 2` (hud.css). The title
   * screen deliberately paints over everything, the toast rail included. Both conditions
   * that are knowable at BOOT -- memory-only storage and a future-schema payload -- are
   * delivered the instant this registers, which is immediately after `createHud`, while
   * the surface is still `launch`. A toast raised there expires behind the scrim after
   * TOAST_MS (3200ms, hud.ts) and a player who takes longer than that to press a key
   * never sees it at all. Deferring to the first surface that is not `launch` is what
   * makes "surfaces a notice" true rather than merely "called showToast".
   *
   * Deliberately NOT solved by raising the rail above the splash: the splash's
   * z-index comment states the title screen is the whole screen and nothing may paint
   * over it, and a notice about storage is not worth reopening that ruling.
   */
  let pendingNotice: SettingsNotice | null = null;
  function flushSettingsNotice(): void {
    if (pendingNotice === null || sm.atLaunch) return;
    const notice = pendingNotice;
    // Cleared BEFORE the toast, not after: `showToast` is the only caller that could
    // re-enter, and a notice shown twice would break the at-most-once contract.
    pendingNotice = null;
    hud.showToast(notice.message);
  }
  const stopSettingsNotice = deps.onSettingsNotice((notice) => {
    pendingNotice = notice;
    flushSettingsNotice();
  });
  // THE TWO SEPARATE HUD PROJECTIONS (issue #316 review, finding 1), both
  // derived from the canonical model -- never from `deps.initialVersusConfig`,
  // a URL read, or a `world.rules.mode` check.
  //
  // `setRelaunchTarget` is WHAT THE BUTTONS DO, and is fixed for the session
  // (see `relaunchTarget` above). `setSessionKind` is WHAT IS BEING PLAYED, and
  // is re-pushed from `switchTo` on every world build, because a Levels pick
  // really does change it. Both are set here, before any setState/
  // setContinueAvailable/setLevelSelect call below, so the very first render
  // already reflects them.
  //
  // These were ONE call before this fix, and the collapse was a lie in the
  // direction of the buttons: `?dev=1&mode=ffa` builds a genuine FFA world on
  // the campaign level system, so the single call passed 'campaign' to keep
  // Continue and Levels working -- and with it hid the versus stock strip and
  // showed campaign Lives/Enemies for a match that has neither.
  hud.setRelaunchTarget(relaunchTarget);
  hud.setSessionKind(currentDescriptor.kind);
  // The application ground is NOT pushed from here any more (issue #324, step S5). It is
  // page chrome that outlives every match, so `route-host.ts` reads the same `backdrop`
  // flag once at page construction -- which is what makes a page that never starts a
  // session stand on the right ground.
  // The stock strip's DATA, cleared once for a session that will never produce
  // any. Keyed on the descriptor, like the strip's own visibility gate: a
  // versus session -- setup-pane OR developer-flag -- skips this and lets
  // `onSimulated`'s first 'playing' frame push real entries instead, exactly as
  // a setup-pane match already did. For a campaign or practice session
  // `world.rules.mode` is `'campaign-coop'`, so `onSimulated`'s `isVersusFrame`
  // branch never fires and this null really is the only call it will ever make.
  if (currentDescriptor.kind !== 'versus') hud.setVersusStocks(null);

  /**
   * The two evaluation moments live here. `clearedLevel` is non-null ONLY when a win
   * has just landed, which is what stops an attempt feat firing mid-round on a tally
   * that happens to qualify. Newly earned entries come back and become toasts.
   */
  /**
   * Set when a win lands, consumed on the SAME frame once that frame's stats are
   * recorded. The winning tank-destroyed and the win event ride one step() batch,
   * and the driver routes it to the state machine (which flips synchronously)
   * BEFORE onFrameEvents, where stats.record runs. Evaluating attempt feats straight
   * from the state change therefore reads a tally one kill short -- Dead Eye
   * unearnable on a normal clear, Bomb Squad blind to a single-mine-kill win,
   * Flawless granted for a mutual kill the player did not survive.
   */
  let pendingClear: number | null = null;

  /**
   * The results-screen kill tally, indexed by slot -- coop's own (coop semantics plan,
   * docs/superpowers/plans/2026-08-15-coop-semantics.md) generalized by n-player arc PR
   * 4's `tallyCoopKills` to also hold ffa/teams' player-vs-player kills: the two never
   * coexist in one session (`world.rules.mode` is fixed for its whole life), so one array
   * safely serves both. `versusDeaths` is the PR 4 addition `tallyCoopKills` needs only
   * for its ffa/teams branch -- unused, always empty, in campaign-coop. Per-attempt
   * scope, mirroring `attempt`'s own lifecycle: both reset at every `startAttempt()`
   * call site below, since they feed the same win/lose panel. Which of the two the
   * panel actually shows is decided once, in `pushOutcome` just below, off the world's
   * own `rules.mode`.
   */
  let coopKills: number[] = [];
  let versusDeaths: number[] = [];

  /**
   * THE WHOLE WIN/LOSE PANEL, in one push (issue #324, step S4) -- what used to be
   * `hud.setCoopKills`, `hud.setVersusResults` and the attempt half of `hud.setStats`.
   *
   * The mode dispatch lives HERE rather than at each call site because it is one
   * question with one answer per world: `rules.mode` is fixed for a world's whole life,
   * so a session shows the versus tally or the coop one or neither, and the projection's
   * `tally` says which. Splitting it across setters is what made "the two results lines
   * are never both live at once" a rule the HUD had to trust rather than one it could
   * see.
   *
   * Takes the world it is describing rather than reading `driver.world`. All three
   * callers hand it the same object the driver holds -- the driver is CONSTRUCTED with
   * the boot world, and `switchTo` calls `driver.reset(world)` before reaching here --
   * so the parameter buys no different answer today. What it buys is that the agreement
   * is checkable at the call site instead of being an ordering the reader has to trust,
   * and that ordering is exactly what a future caller pushing before its reset would
   * break. `countPlayerTanks` on that world, not the `playerCount` variable, for the
   * same reason the tally itself is world-derived: the world is what the panel is about.
   *
   * `action` is the boot-time relaunch target, unchanged for the session's whole life --
   * the outcome button names where its click LANDS, and no world build moves that.
   */
  function pushOutcome(forWorld: World): void {
    const attempt = deps.stats.attempt();
    const mode = forWorld.rules.mode;
    if (mode === 'ffa' || mode === 'teams') {
      hud.setOutcome({ tally: mode, attempt, action: relaunchTarget, kills: coopKills, deaths: versusDeaths });
    } else if (countPlayerTanks(forWorld) >= 2) {
      hud.setOutcome({ tally: 'coop', attempt, action: relaunchTarget, kills: coopKills });
    } else {
      hud.setOutcome({ tally: 'solo', attempt, action: relaunchTarget });
    }
  }
  /**
   * The stock readout's own no-thrash guard (Task 6, spec §3a): the joined key of the
   * LAST `stocks` array actually handed to `hud.setVersusStocks`, so a frame whose
   * stocks are unchanged does not re-invoke the setter with an identical array. This
   * matters MORE than it would if the dispatch were event-gated: it is dispatched from
   * `onSimulated` (see that callback's own comment), which runs EVERY 'playing' frame
   * unconditionally, at up to 60/s -- without this guard the HUD would re-render the
   * strip every single frame of a live match, event or no event. `null` is the sentinel
   * "never dispatched yet" -- distinct from any real key, since a real versus world
   * always has at least one player-kind tank and therefore a non-empty joined key.
   */
  let lastVersusStocksKey: string | null = null;

  function checkAchievements(clearedLevel: number | null): void {
    const ctx: AchievementContext = {
      lifetime: deps.stats.lifetime(),
      attempt: deps.stats.attempt(),
      highestCleared: deps.progress.highestCleared(),
      totalLevels: deps.levels.levels.length,
      clearedLevel,
      livesLeft: driver.world.lives,
      tracksProgress: deps.levels.tracksProgress,
    };
    const fresh = deps.achievements.check(ctx);
    if (fresh.length === 0) return;
    // The TOAST only. The Records page's earned list is repainted by the page when the
    // page is opened (issue #324, step S5) -- `deps.achievements` is the same store the
    // route UI reads, so a list read at open cannot be behind a set written mid-match.
    hud.showAchievementToasts(fresh);
  }

  function refreshStats(w: World): void {
    hud.setLives(w.lives);
    hud.setEnemiesRemaining(countEnemies(w));
    if (deps.devFlags.shellCount) {
      hud.setShellCount({ inFlight: playerShellsInFlight(w, playerId), cap: configFor('player').weapon.maxActiveProjectiles });
    }
  }

  // The denominator for musical intensity. Re-read on every world rebuild, since
  // arenas differ in enemy count.
  let enemiesAtRoundStart = countEnemies(world);
  /**
   * Per-slot rising-edge state for the connect toast, index = slot number
   * (n-player arc PR3). Generalizes the pre-PR3 single `wasGamepadConnected` boolean,
   * which read only slot 0's `input.gamepadConnected()` -- under shipped coop's
   * mapping that left the toast permanently false during co-op, a load-bearing gap
   * the input-routing plan named and deferred. `pad[i] -> slot[i]` means every slot
   * can connect independently now, so every slot gets its own edge and its own toast,
   * named to the slot ("Player 2's controller connected"). Slot 0's own check is
   * unaffected: `input.gamepadConnected()` is always false when `?dev=1&gamepad=1` is
   * off (the reader is never constructed -- see input.ts), so this needs no separate
   * flag check there either. Toasts on each RISING edge -- a reconnect toasts again,
   * pinned by its own test -- because Firefox does not expose a pad to
   * `navigator.getGamepads()` until the player presses a button on it, so this is the
   * one moment that confirms the press was seen.
   */
  const gamepadConnectedPrev: boolean[] = new Array(playerCount).fill(false);
  /**
   * Single source of truth for "is slot i's physical pad connected right now",
   * shared by the toast edge-detector below and by `reassignSlot`. Reassignment
   * needs its own read of this: moving a slot away from a connected gamepad (to
   * bot/none, or bouncing it via a keyboard/gamepad exclusivity swap) removes its
   * `realSources` entry, so `connected` would read false on the very next tick even
   * though nothing physically disconnected. Without re-syncing `gamepadConnectedPrev`
   * at the moment of reassignment, that reads as a falling edge and fires a spurious
   * "Player N's controller disconnected" toast for a deliberate UI action.
   */
  function slotGamepadConnected(i: number): boolean {
    return assignment[i].kind === 'keyboard'
      ? input.gamepadConnected()
      : (realSources.get(i)?.gamepadConnected() ?? false);
  }
  function refreshRoundPhase(w: World): void {
    const phase = roundPhase(w);
    if (phase === 'live') {
      hud.setRoundPhase(null);
      return;
    }
    hud.setRoundPhase({
      phase,
      secondsLeft: Math.ceil(roundPhaseTicksLeft(w) / TICK_HZ),
    });
  }

  const driver = createDriver({
    now: deps.now,
    raf: deps.raf,
    input: recorder ?? effectiveInput,
    renderer,
    director,
    haptics,
    stateMachine: sm,
    world,
    onSimulated(w): void {
      refreshStats(w);
      // The aim STICK needs EACH SLOT's own WORLD position to project a point from --
      // see setPlayerPosition's doc comment (`tankForSlot`, hoisted above, is the same
      // resolution the bot substitution uses). `null` when there is no tank for that
      // slot, in which case the source simply holds its last aim. Only REAL sources
      // need this -- a bot-claimed slot has no entry in `realSources` and needs none:
      // `decidePlayerInput` reads the tank's position straight off `world` every tick,
      // it does not need it echoed back through an injected setter.
      const p1 = tankForSlot(w, 0);
      const p1Pos = p1 ? { x: p1.pos.x, y: p1.pos.y } : null;
      realSources.forEach((src, i) => {
        const tank = i === 0 ? p1 : tankForSlot(w, i);
        src.setPlayerPosition(tank ? { x: tank.pos.x, y: tank.pos.y } : null);
      });
      // Same position, to the haptics director -- P1-ONLY, explicitly deferred (see
      // the co-op input-routing plan's "assumes THE player" audit): mine-detonate is
      // the only cue that needs a distance from the player, and there is no
      // per-player attribution anywhere in haptics.ts/stats.ts/director.ts yet.
      haptics.setPlayerPosition(p1Pos);
      // Touch indicator: slot 0 (the multi-device controller) only, unaffected by
      // co-op or controllers -- see the co-op plan's audit for why a per-player touch
      // affordance is out of scope; touch is inherently a single-device input.
      hud.setTouchIndicator(input.touchIndicator());
      // Gamepad connect/disconnect toast, PER SLOT -- see gamepadConnectedPrev's own doc
      // comment. Gated on `assignment[i].kind === 'keyboard'`, NOT `i === 0`: the
      // controller assignment UI can move keyboard to any slot, and that slot -- whichever
      // one it is -- is the one whose `input.gamepadConnected()` (the optional
      // `?dev=1&gamepad=1` merge) is the right read; every other REAL slot reads its own
      // dedicated `PlayerInputSource.gamepadConnected()`. A bot-claimed slot has no entry
      // in `realSources` and never toasts -- there is no physical pad to have
      // connected there. Toasts on BOTH edges: the rising edge is the pre-existing rule
      // (issue #114); the falling edge closes the loop during play, so a mid-round
      // disconnect is visible immediately rather than only through the panel's dimmed row
      // (see input/assignment.ts's Reserved-idle semantics -- the slot's tank keeps
      // holding either way, this is purely the notification).
      let changedGamepadConnection = false;
      for (let i = 0; i < playerCount; i++) {
        const isKeyboardSlot = assignment[i].kind === 'keyboard';
        const connected = slotGamepadConnected(i);
        if (connected && !gamepadConnectedPrev[i]) {
          hud.showToast(isKeyboardSlot ? 'Gamepad connected' : `Player ${i + 1}'s controller connected`);
          changedGamepadConnection = true;
        } else if (!connected && gamepadConnectedPrev[i]) {
          hud.showToast(isKeyboardSlot ? 'Gamepad disconnected' : `Player ${i + 1}'s controller disconnected`);
          changedGamepadConnection = true;
        }
        gamepadConnectedPrev[i] = connected;
      }
      // A pad arriving or leaving can change whether controller rumble is available at
      // all, so the boot snapshot is not permanently correct. Hung off the edge
      // detection this loop already runs rather than a `gamepadconnected` listener of
      // its own: no new registration, no new disposal surface, and it fires exactly on
      // the transitions that matter. `refresh()` publishes only on a real change
      // (capabilities.ts), so the common case -- nothing changed -- costs one scan.
      if (changedGamepadConnection) deps.effectiveSettings.refreshCapabilities();
      refreshRoundPhase(w);
      audio.setMusicIntensity(musicIntensity(countEnemies(w), enemiesAtRoundStart));
      // Task 6's in-match stock readout (spec §3a), dispatched HERE rather than from
      // onFrameEvents below (review of this task's own first landing): onSimulated
      // runs on EVERY 'playing' frame, unconditionally, including the pre-round
      // countdown -- no `SimEvent` marks "a versus match/countdown has started", so
      // gating on an event arriving left the strip dark until whatever the first event
      // happened to be (typically a shot). Reads `w`, the world this callback is
      // actually handed (the post-step world for THIS frame), rather than reaching for
      // `driver.world` the way onFrameEvents' own `pushOutcome` call still does one
      // section below -- the two are the same world by the time either callback runs
      // (driver.ts assigns `curr` before calling either), but `w` is the value this
      // specific callback is actually given.
      const isVersusFrame = w.rules.mode === 'ffa' || w.rules.mode === 'teams';
      if (isVersusFrame) {
        // One entry per player-kind tank still in the world (never spliced, even once
        // eliminated -- world.ts's own comment on `alive: false` tanks). `slot` =
        // `controlledBy` (`?? 0`, the same convention `tankForSlot`'s own lookup uses
        // above in this file); `stock` = `stockRemaining` (`?? 0`, the same "unstamped
        // reads as already at zero" fallback that field's own doc comment on `Tank`
        // names); `team` carried through only for 'teams' -- ffa tanks never have it
        // stamped (loadArena), so it comes through `undefined` there, which is exactly
        // what the optional `team?` on the HUD's own payload expects.
        //
        // Sorted by `slot`, NOT left in `w.tanks`' own array order: today that order
        // happens to match slot order (loadArena's own grid-scan numbering), but
        // nothing GUARANTEES it, and this is the one place a future tank-array reorder
        // (a respawn splice, a different spawn pass ordering) could silently reshuffle
        // the strip -- P1's own entry appearing after P2's, or the joined key changing
        // shape for a stocks array that is semantically identical. Sorting by the
        // value that actually identifies "which player" this is closes that off
        // structurally rather than relying on today's incidental order staying true.
        const stocks = w.tanks
          .filter((t) => t.kind === 'player')
          .map((t) => ({ slot: t.controlledBy ?? 0, stock: t.stockRemaining ?? 0, team: t.team }))
          .sort((a, b) => a.slot - b.slot);
        // The no-thrash guard -- see lastVersusStocksKey's own doc comment above for why
        // this matters even more now that the dispatch runs every frame, not only
        // event-bearing ones.
        const key = stocks.map((s) => `${s.slot}:${s.stock}:${s.team ?? ''}`).join('|');
        if (key !== lastVersusStocksKey) {
          lastVersusStocksKey = key;
          hud.setVersusStocks(stocks);
        }
      }
    },
    // The event stream is shared, so a bare `some(e => e.type === 'tank-destroyed')`
    // fires on every enemy kill too -- exactly the presence-only mistake
    // CLAUDE.md warns about. Discriminate on tankId: kind alone stops being unique
    // the moment a second player-kind tank exists (the co-op foundation).
    onFrameEvents(events): void {
      if (isPlayerDeath(events, playerId ?? -1)) {
        hud.signalPlayerDeath(deathVignetteColor(driver.world, playerId ?? -1, playerCount));
        // The #152 fix: persist the reduced life count on the RUN before the player
        // can escape it by refreshing or leaving gameplay -- not deferred to any
        // later click. `driver.world.lives` is already the post-step count: the
        // driver assigns `curr = result.world` before calling onFrameEvents.
        // Practice/sandbox never reach here -- see campaignActive.
        if (campaignActive()) deps.run.setLivesRemaining(driver.world.lives);
      }
      // Discriminated by ownerId, not presence: the stream is shared, so a bare
      // `some(e => e.type === 'fire')` pulses on every enemy shot -- exactly the
      // presence-only mistake CLAUDE.md warns about.
      // `!== undefined`, not `!== null`: playerId is `number | undefined`, so the null
      // form was always true and the guard did nothing. tsc does not flag it.
      if (playerId !== undefined && events.some((e) => e.type === 'fire' && e.ownerId === playerId)) {
        hud.signalPlayerFire();
      }
      // The transient shell-capacity line (issue #516's `hud` arm), silent unless
      // `?dev=1&blockedFire=hud` names it. Handed the CURRENT world, since the capacity it
      // shows is read from the same resolved config `spawnBullet` enforced: the driver
      // assigns `curr = result.world` before calling onFrameEvents, so this is the world
      // the refusal happened in.
      blockedFireHud.handle(events, driver.world);
      // Attributed against the CURRENT world's player: ids are arena-dependent, and
      // a stale id would misfile every stat from level 2 onward.
      deps.stats.record(events, playerId ?? -1);
      // The results-screen per-slot tally, alongside stats.record -- see coopKills' own
      // comment above for why this stays out of stats.ts.
      tallyCoopKills(events, driver.world, coopKills, versusDeaths);
      // AFTER record, so an attempt feat sees the attempt that just finished.
      checkAchievements(pendingClear);
      pendingClear = null;
      // The Records table used to be repainted from here, every event-bearing frame, so
      // that a page which re-renders only while visible was never stale. The page reads
      // `deps.stats` when the Records page opens instead (issue #324, step S5), which is
      // the only instant the numbers can be seen and is reachable from the Main Menu
      // alone -- so a per-frame push was buying a freshness nothing could observe.
      //
      // The win/lose panel is a different surface with a different owner, and it still
      // updates from here. It updates a beat AFTER the state flips -- the winning kill is
      // in THIS batch, not the one before the panel opened -- so this push lands into an
      // already-open panel and the HUD repaints it.
      pushOutcome(driver.world);
      // Task 6's in-match stock readout (spec §3a) is dispatched from `onSimulated`
      // below, NOT here -- see that callback's own comment for why. `onFrameEvents`
      // only fires `if (frameEvents.length > 0)` (driver.ts), so gating the readout on
      // an EVENT arriving left it dark for the whole pre-round countdown (no `SimEvent`
      // marks "a versus match's countdown is running") and, in production, dropped its
      // very first real update entirely -- `hud.setState('playing')` always runs before
      // the first event-bearing frame, and the OLD `setVersusStocks` guard read that
      // as "already hidden, do not render" (fixed in hud.ts; see `versusStocksVisible`'s
      // own doc comment there for the full mechanism).
    },
  });

  /**
   * The controller assignment UI's one write path: apply `reassign`'s pure exclusivity-
   * bounce, then bring every slot whose DESCRIPTOR actually changed (the target, and any
   * bounced slot) into line -- both are real changes and both need rebuilding, or the
   * bounced slot would keep sampling its old source while `assignment` says `'none'`,
   * which is the exact exclusivity bug the bounce exists to prevent.
   *
   * Rebuild, don't re-point (see input/assignment.ts's module doc comment and this
   * plan's own reasoning): `createGamepadInputSource` closes over `padIndex` at
   * construction, so a slot changing kind or pad index gets a FRESH source, never a
   * mutated one. `input` (the `'keyboard'` singleton) is the one exception -- it is
   * never disposed here, whichever slot loses it; only `dispose()` at final teardown
   * frees it.
   *
   * A slot gaining a REAL source (gamepad/none) is seeded from `driver.world`
   * IMMEDIATELY, not left for the next `onSimulated` tick: `setPlayerPosition` is what
   * keeps a `'none'` slot's turret held rather than slewing toward world-origin for one
   * tick (see createHeldInputSource's own doc comment), and a freshly-built gamepad
   * source starts with `playerPos === null` otherwise.
   *
   * A slot gaining `'bot'` gets exactly one new `botSources` entry, seeded from the
   * CURRENT world -- `createBotSources` with a single-element slot set, so an unrelated
   * bot's own RNG stream (keyed by its own slot number) is untouched. A slot LOSING
   * `'bot'` has its entry deleted the same way, incrementally.
   */
  function reassignSlot(playerSlot: number, source: SlotSource): void {
    // The boundary's second enforcement point. The panel does not OFFER `'bot'` when it
    // is disallowed, so this is unreachable through the UI -- which is exactly why it is
    // here: a rule enforced only by the thing that draws the buttons is one stale DOM
    // node or one new caller away from not being a rule.
    if (source.kind === 'bot' && !botsMayDrivePlayers) return;
    // `playerSlot`, not `slot`: this session's hold on the page's route UI is also called
    // `slot` (`routeHost.attach()`), and the panel row's index and that hold are two
    // different things which the reporting call at the end of this function needs apart.
    const next = reassign(assignment, playerSlot, source);
    const changed: number[] = [];
    for (let i = 0; i < next.length; i++) {
      const prev = assignment[i];
      if (sameSlotSource(next[i], prev)) continue;
      changed.push(i);
      const old = realSources.get(i);
      if (old && old !== input) old.dispose();
      realSources.delete(i);
      if (prev.kind === 'bot') botSources.delete(i);
      const nextSource = next[i];
      if (nextSource.kind === 'bot') {
        const seeded = createBotSources(driver.world.seed, new Set([i]), botDifficulty);
        botSources.set(i, seeded.get(i)!);
      } else {
        const built = buildRealSource(nextSource);
        if (built) {
          realSources.set(i, built);
          const tank = tankForSlot(driver.world, i);
          built.setPlayerPosition(tank ? { x: tank.pos.x, y: tank.pos.y } : null);
        }
      }
    }
    assignment = next;
    // Re-sync the toast edge-detector for every slot whose source just changed.
    // Without this, a slot that HAD a connected pad and gets reassigned away from it
    // (to bot/none directly, or bounced to 'none' by another slot claiming its
    // padIndex/keyboard) loses its `realSources` entry, so `slotGamepadConnected`
    // reads false on the very next tick with `gamepadConnectedPrev[i]` still true --
    // a spurious falling edge that would toast "Player N's controller disconnected"
    // for a deliberate reassignment, not a physical unplug. Reading truth here at the
    // moment of change is what keeps the falling-edge toast meaning "the hardware
    // disconnected" rather than "the UI moved this slot".
    for (const i of changed) {
      gamepadConnectedPrev[i] = slotGamepadConnected(i);
    }
    // Refresh the panel's own display, THROUGH THE SLOT (issue #324, step S5): the
    // Controllers panel is an application surface, so the page writes it and this session
    // only reports what changed. `route-host.ts` rebuilds unconditionally, open or not --
    // cheap, and it is what lets hud.css.test.ts's mountEveryButton fixture drive rows
    // without opening the panel first.
    slot.setControllers(assignment, botsMayDrivePlayers);
  }
  /**
   * The one thing the application routes cannot do alone: the paint shop restyles the
   * tank BEHIND the panel through the gameplay renderer, which exists only while a
   * session does.
   *
   * The routes themselves were extracted above this session by #427 and are now built
   * above the PAGE by `route-host.ts` (#468), so all that is left here is handing over
   * this session's renderer. The route host's own sink is a trampoline onto whatever the
   * slot holds, so the panel keeps working with no session at all -- the store still
   * records the pick and the live preview still shows it; only the arena tank, which is
   * not on screen, goes unpushed.
   */
  slot.setStyleSink((hex, skin, accentHex) => {
    renderer.setPlayerStyle(hex, skin, accentHex);
  });

  slot.onStartRestart(() => {
    // This click is the only guaranteed user gesture in the game, and Safari
    // will not open an AudioContext resumed from anywhere else. Sounds are
    // emitted from the frame loop, which never qualifies.
    audio.unlock();
    if (sm.atMainMenu) {
      // Continue from the Main Menu enters gameplay on the CURRENT resolved session --
      // the world was already built at boot or by whichever gesture last landed on a
      // board, so this is otherwise the pure "start play" gesture. See `currentSession`
      // for the instance being entered.
      //
      // UNLESS a landing is owed (issue #317): a quit leaves the abandoned world in
      // place behind the application ground and defers its own board to here, so this
      // is where it gets built. Ordering matters and is build-then-reveal -- the world
      // exists, `currentSession` is re-derived from it, and only then does
      // `enterGameplay` reach the state change that hides the ground. Entering first
      // would show one frame of the abandoned board.
      if (pendingLanding) landOnCampaignBoard(false);
      sm.enterGameplay(currentSession);
    } else if (sm.isPaused) {
      // Resume shares the action button with Play Again/Retry, whose branch below
      // REBUILDS the world. Resuming must keep the game exactly as frozen.
      sm.resume();
    } else {
      // Intermediate win -> the NEXT level, with the lives that survived this one.
      // Neither branch touches the active RUN here: a mid-campaign level clear or a
      // game-over/completion is already persisted reactively in sm.onChange, the
      // instant the state flipped -- not deferred to this click, so a refresh at the
      // win/lose screen cannot lose it. This click only decides which WORLD to build.
      const next = sm.presentsAsWin ? nextInSession(level) : null;
      if (next !== null) {
        switchTo(next, driver.world.lives);
        sm.enterGameplay(currentSession);
      } else if (relaunchTarget === 'versus-setup') {
        // A setup-pane versus match's own win/lose has nothing to advance to -- the
        // versus level system is always a single synthetic level (levels.ts), so
        // `next` above is null here exactly as it is for a campaign game-over. But
        // unlike campaign, "Play Again" on a FINISHED versus match must not silently
        // rebuild the same match: the versus-setup-menu plan's rematch flow returns
        // to the setup pane, prefilled with the match just played, so players/map/
        // stock can change before the next round. The actual reboot -- a new world,
        // new bots, the lot -- happens only through `requestVersusSession`, wired
        // below off the pane's OWN Start button; this click must not touch `world`.
        //
        // sm.toMainMenu() BEFORE showVersusSetup, not after: setState's close-all
        // discipline (hud.ts) unconditionally re-hides the versus pane on every
        // state change, so opening the pane first would just have that work undone
        // a moment later by this very call. loop.test.ts pins the order with a case
        // that fails if the two calls are swapped.
        sm.toMainMenu();
        // Through the SLOT (issue #324, step S5): this session decides that its own
        // rematch goes back to the pane, and the page decides what the pane is prefilled
        // with, from the config it retains across the disposal this click causes.
        slot.openVersusSetup();
      } else {
        // Final win, game over, or a practice session ending either way -- land back
        // on the campaign's own board (never a fresh one; see landOnCampaignBoard).
        // Only a real campaign session may CREATE a new run here: the one that just
        // ended (sm.onChange's outcome branch already ran endRun()) is gone, and
        // playing on needs somewhere to persist the next death/clear.
        landOnCampaignBoard(campaignActive());
        sm.enterGameplay(currentSession);
      }
    }
  });

  // The versus setup pane's own entry points -- both bare passthroughs, per the Hud
  // interface's own doc comments on onVersusOpen/onVersusStart -- are subscribed by the
  // PAGE (`route-ui.ts`, since issue #427), not here: the pane owns its config state and
  // its own Back button, so the page's only two jobs are handing it the retained config
  // to prefill from and, on Start, forwarding the pane's chosen config to the start
  // boundary. What this session still does is the post-match reopen above.
  /**
   * Land on a level: build its world, rebind everything the old world owned, and
   * refit the renderer if the BOARD changed size. One path for advance, quit and
   * level pick -- their parity was reviewed line-by-line three times before it
   * became structural.
   */
  function switchTo(newLevel: CampaignLevel, lives?: number): void {
    level = newLevel;
    world = buildWorld(level, lives);
    // The one site that can satisfy an owed landing, because it is the one site that
    // builds a world -- see `pendingLanding`.
    pendingLanding = false;
    // THE structural fix for issue #316's finding 4. The descriptor is
    // RE-DERIVED from the session identity and the level actually built, on
    // every world build -- it is never carried forward from a previous
    // transition, so a Practice descriptor cannot survive onto a campaign
    // board no matter which path got here. A Practice session advancing a
    // level also gets its ordinal updated for free, which a stored descriptor
    // silently would not.
    currentDescriptor = descriptorFor(sessionIdentity, ordinalOf(level));
    currentSession = resolveSession(currentDescriptor, world.seed, level.arenaId);
    // The gameplay HUD's identity, re-pushed from THE SAME LINE the descriptor is
    // derived on, so the two cannot fall out of step. This is what makes "a Levels
    // pick makes this session Practice" and "landing back on the home board makes
    // it Campaign again" visible to the HUD without any transition having to
    // remember to say so. `relaunchTarget` is deliberately NOT re-pushed: it is a
    // boot-time fact and no world build changes it.
    hud.setSessionKind(currentDescriptor.kind);
    // Reseeded here too -- see botSources' own doc comment above for why bots are
    // per-world, not per-session. Read off the CURRENT `assignment`, not the boot-time
    // `botSlots` set: a mid-session reassignment can have moved a slot to or from
    // `'bot'` since boot, and switchTo must not resurrect a stale bot roster.
    botSources = createBotSources(world.seed, botSlotsFromAssignment(assignment), botDifficulty);
    // A new world means a new trace: the recorded inputs only mean anything
    // applied to the world they were sampled against, so carrying them across a
    // level switch would produce a trace that replays into a different game.
    recorder?.begin(replayMetaFor(world, level.arenaId));
    playerId = world.tanks.find((t) => t.kind === 'player')?.id;
    director.setPlayerId(playerId ?? -1);
    haptics.setPlayerId(playerId ?? -1);
    // `playerId` itself, not `?? -1`: this arm takes `number | undefined` and treats
    // undefined as "no tracked player, say nothing", which is the honest reading of a
    // world with no player tank -- an id of -1 would be a tank id that can never match.
    blockedFireHud.setPlayerId(playerId);
    enemiesAtRoundStart = countEnemies(world);
    const b = deps.levels.bounds(level);
    if (b.width !== shownBounds.width || b.height !== shownBounds.height || b.cellSize !== shownBounds.cellSize) {
      // Guarded: a same-size rebuild (retry, quit on the same board) must not
      // reallocate ground geometry on every click.
      renderer.refit(b.width, b.height, b.cellSize);
      shownBounds = b;
    }
    hud.setLevel(ordinalOf(level), deps.levels.levels.length);
    driver.reset(world);
    refreshStats(world);
    // A switch is a new ATTEMPT: the per-attempt tally starts over, the lifetime
    // rolls on. Deliberately NOT where the active RUN is touched -- switchTo only
    // builds a world; every caller above decides for itself whether this world is
    // campaign or practice, and mutates (or does not mutate) the run accordingly.
    deps.stats.startAttempt();
    // Same lifecycle as `attempt` above: coopKills/versusDeaths reset on every new
    // attempt, not just at boot -- see coopKills' own comment for why.
    coopKills = [];
    versusDeaths = [];
    // No Records push for the new attempt: the page reads `deps.stats` when the Records
    // page opens (issue #324, step S5), and `startAttempt` above has already reset the
    // store this reads.
    // The win/lose panel starts the new attempt empty too. A board switch can change
    // which tally the panel would show -- a Levels pick lands a coop session on a
    // one-player board -- so the whole projection is re-derived here rather than left
    // saying whatever the finished attempt said.
    pushOutcome(world);
  }

  /**
   * Rebuild the CAMPAIGN's own board: the LEVEL from `deps.levels.start` -- already
   * live and already correctly prioritised (a dev-flag jump beats the active run
   * beats level 1, see levels.ts) -- and the LIVES from the active run, EXCEPT for a
   * dev-flag jump, which gets fresh lives instead -- see campaignActive's doc
   * comment (defect 1, adjudicated review of #156). Quit-to-title, a
   * game-over/completion restart, and a practice session ending all land here.
   * Before this consolidation each called switchTo with no `lives` argument at
   * all, which defaults to full LIVES (arena.ts's `createWorldFor`) rather than
   * the run's real count -- the literal #152 exploit, reachable from three call
   * sites instead of one.
   *
   * `mayCreateRun` is true only for a real campaign game-over/completion restart:
   * the run that just ended is already gone (sm.onChange's outcome (`campaign-over` or final `campaign-complete`)
   * branch calls endRun() the instant the state flips, not deferred to this call),
   * and playing on needs somewhere to persist the next death/clear -- created AT
   * `deps.levels.start`. Every caller passes `campaignActive()` (or a hardcoded
   * `false`) for this argument, so it is already false for a dev-flag jump; a
   * died-and-retried jumped session lands on the jumped level same as any other
   * jumped landing, but creates nothing. Quitting and leaving practice must NOT
   * create one either -- landing on a "no run yet" board is correct there:
   * Continue stays hidden, New Game remains the only way in.
   *
   * The run-creation guard below reads `deps.run` when `deps.levels.tracksProgress`
   * -- for the sandbox (`?dev=1&level=sandbox`) both it and `mayCreateRun`'s effect
   * fall through to nothing, so this is `switchTo(deps.levels.start)` there, exactly
   * as before the run model existed. The sandbox must never create OR read a real
   * campaign run. The LIVES line just below is gated on the narrower
   * `campaignActive()` instead (the first line of the body resets `sessionIdentity`
   * to `bootContext.identity`, so no mid-session practice pick can still be in force
   * and a campaign boot leaves exactly `tracksProgress && !isDevJump`) -- a jumped
   * session must not even READ the run's lives, or a stray quit/retry would leak an
   * unrelated level's life count into a board the player did not reach by playing.
   */
  function landOnCampaignBoard(mayCreateRun: boolean): void {
    // Reset to the session's own boot identity BEFORE anything below builds a
    // world. This is the exact site issue #316's finding 4 named: it used to
    // clear a separate `inPractice` flag while leaving the retained Practice
    // descriptor in place, so `switchTo` then resolved a Practice session on a
    // campaign board with campaign run bookkeeping switched back on. Callers
    // evaluate `mayCreateRun` BEFORE calling, so a practice session still
    // correctly creates no run here.
    //
    // "Campaign board" is the historical name; what it really lands on is
    // `deps.levels.start`, i.e. THIS session's home level -- the campaign's
    // resume point, the jumped level, the sandbox, or the versus board. The
    // boot identity is the right answer for every one of those.
    sessionIdentity = bootContext.identity;
    const startLevel = deps.levels.start;
    if (deps.levels.tracksProgress && deps.run.active() === null && mayCreateRun) {
      deps.run.startNewRun(startLevel.id);
    }
    const lives = campaignActive() ? deps.run.active()?.livesRemaining : undefined;
    switchTo(startLevel, lives);
  }

  slot.onLevelSelect((picked) => {
    // Panel-only control, guarded like Quit: CSS hiding is not the only defence --
    // and neither is the HUD's button rendering, for the index. `deps.levels.levels[7]`
    // is undefined on a shorter sequence, and a handler that rebuilds the world does
    // not get to crash on it.
    if (!sm.atMainMenu) return;
    if (!Number.isInteger(picked) || picked < 0 || picked >= deps.levels.levels.length) return;
    // Practice: independent fresh lives (switchTo's `lives` is left undefined, so
    // buildWorld defaults to full LIVES), and the active campaign run is never read
    // or written from here on out -- see campaignActive.
    // Identity transition 1 of 2 (issue #316): a CAMPAIGN session is Practice
    // from here until New Game or a landing on its home board resets it. The
    // ORDINAL is not stored -- `switchTo` derives the descriptor from this
    // identity and whichever level it actually builds, so the descriptor
    // cannot fall out of step with the board.
    //
    // `identityForLevelPick`, not an unconditional Practice: this button is
    // genuinely reachable on a DEVELOPER-FLAG versus session (`?dev=1&mode=ffa`
    // keeps the campaign level system, so `levelChoice` is true and the
    // campaign-shaped title affordances leave the button on screen), and that
    // system's `world()` stamps `flags.mode` on every level it builds. Calling
    // the resulting FFA match Practice would drop its stock strip and report
    // `practice-result` for a match the sim decided by last-slot-standing.
    sessionIdentity = identityForLevelPick(bootContext.identity);
    switchTo(deps.levels.levels[picked]);
    // A level click is as real a gesture as the Start button, and it starts play, so
    // it must unlock the audio context too -- Safari accepts no later opportunity.
    audio.unlock();
    sm.enterGameplay(currentSession);
  });

  // New Run (spec: docs/superpowers/specs/2026-08-11-campaign-run-model.md): the one
  // deliberate action that creates or explicitly replaces the active campaign run.
  // Distinct from onLevelSelect above -- before issue #153 New Game reported
  // onLevelSelect(0), the literal same event as picking level 1 in the Levels panel,
  // which is exactly why practice and campaign could not be told apart.
  //
  // Gated on campaignActive() (defect 2, adjudicated review of #157): every OTHER
  // run mutation in this file already checks it, and this one had no guard at all --
  // `deps.run.startNewRun(deps.levels.levels[0].id)` ran unconditionally. For the
  // sandbox, `levels[0].id` is the synthetic `'sandbox'` string, never a member of
  // CAMPAIGN_LEVELS, so a click there persisted `{currentLevelId: 'sandbox', ...}`
  // into the REAL tanks.run.v2 key -- the sandbox must never create OR read a real
  // campaign run, and a later normal session would read the poisoned id back as
  // unresolvable and silently fall back to level 1, discarding wherever the run
  // actually was. For a dev-flag jump, the same call REPLACED a real run outright:
  // #156's adjudicated model already excludes a jump from consuming, restoring,
  // advancing or completing the run (see campaignActive's doc comment), and Replace
  // is the same exclusion, just missed the first time. Only a session that OWNS the
  // run -- real campaign play, neither the sandbox nor a jump -- may replace it;
  // the other two get a fresh board and leave the real run untouched.
  //
  // `sessionIdentity` is reset to `bootContext.identity` FIRST, unconditionally, the
  // same ordering `landOnCampaignBoard` uses: New Game from title returns the session
  // to whatever it booted as, campaign-owning or not. Today every path back to 'title'
  // already runs through `landOnCampaignBoard` (quit-to-title), and a session that has
  // never left the title screen is still on its boot identity, so reaching
  // `sm.atMainMenu` with a practice pick still in force cannot currently happen -- this
  // ordering is defensive, not covering a reachable gap, so a future path to title that
  // skips `landOnCampaignBoard` still cannot leave `campaignActive()` reading a stale
  // practice identity.
  slot.onNewGame(() => {
    if (!sm.atMainMenu) return;
    // Identity transition 2 of 2 (issue #316): New Game is a deliberate return
    // to whatever this session IS. For a campaign boot that leaves practice for
    // good; for a versus reboot it stays Versus ("Start Match"); for a
    // developer jump or the sandbox it stays that session's own kind while
    // landing on `levels[0]`. Set BEFORE `campaignActive()` is consulted below,
    // so the guard sees the identity this click establishes.
    sessionIdentity = bootContext.identity;
    if (campaignActive()) {
      const fresh = deps.run.startNewRun(deps.levels.levels[0].id);
      switchTo(deps.levels.levels[0], fresh.livesRemaining);
    } else {
      // Sandbox or dev jump: no run write at all -- just a fresh board at levels[0],
      // the same "New Game" affordance a campaign-owning session gets, minus the
      // part that touches a run this session does not own. Continue's signal is left
      // alone rather than forced to `true`, which would claim a run exists when this
      // click created none.
      switchTo(deps.levels.levels[0], undefined);
    }
    // Same convention as onLevelSelect just above: a real gesture that starts play
    // must unlock the audio context here, since Safari accepts no later opportunity.
    audio.unlock();
    sm.enterGameplay(currentSession);
  });

  // The touch-only pause button. Routed through the SAME guarded transitions as the
  // keyboard hotkey rather than its own path -- pause() acts only from 'playing' and
  // resume() only from 'paused', so the button cannot reach a state the key cannot.
  //
  // Deliberately does NOT change the music: musicContextFor maps 'paused' to 'arena'
  // and the bed ducks instead of stopping, on the reasoning that moving the music
  // elsewhere would make a pause feel like leaving the level.
  // The touch-only Mine button, routed to the input controller's own latch so a mine
  // tapped is indistinguishable from a mine keyed: same sample(), same clear-on-pause.
  slot.onMineTap(() => {
    input.pressMine();
  });

  // The touch-only Fire button, routed the same way: a tap here is indistinguishable
  // from a click or a keypress once it reaches the latch. Touch aiming deliberately
  // never fires on its own -- see TouchScheme in input/touch.ts.
  slot.onFireTap(() => {
    input.pressFire();
  });

  // The three input toggles: write the store, and nothing else. The old three-step
  // "store, read back the accepted value, echo it to the HUD and the runtime" is now
  // `applySettings` running from the subscription, once, for every setting at once.
  //
  // An OFF-LIST value is still refused rather than stored (settings.ts's setters), and
  // refusing publishes nothing -- so the HUD keeps showing the accepted value, exactly as
  // the echo used to guarantee. The HUD never flips optimistically on its own (hud.ts's
  // toggles render only from `setTouchScheme`/`setFireMode`/`setHaptics`), which is what
  // makes "publish nothing" the correct response to a rejected value.
  slot.onQuitToTitle(() => {
    // The HUD hides the Quit button outside pause and the level-cleared panel, but a
    // handler that rebuilds the world deserves its own guard, not a CSS class as its
    // only defence.
    //
    // 'win' joined 'paused' when a directive asked for a main-menu route out of a
    // cleared level. The run SURVIVES that trip, which needs no work here and is the
    // reason this reuses the quit path rather than inventing one: `advanceLevel` already
    // ran at the moment the level cleared (see the `s === 'win'` branch below), not when
    // Next Level is pressed, so the run is already sitting on the NEXT level by the time
    // this panel is on screen. Leaving from here resumes there, not on the level just
    // beaten.
    if (!sm.isPaused && !sm.presentsAsWin) return;
    // NAVIGATION ONLY (issue #317): this builds no world, consumes no gameplay seed and
    // touches no run. It used to call `landOnCampaignBoard(false)` -- `switchTo` ->
    // `nextSeed()` -> a world build -- for one reason, stated in the comment this
    // replaces: so the Main Menu rendered over the campaign's own board rather than the
    // abandoned (possibly practice) one. The shell now owns what is behind the menu, and
    // an opaque application ground is what is behind it (`.ui-app-ground`, hud.css), so
    // there is no longer a board to get right there.
    //
    // What that eager rebuild ALSO did, and what therefore has to be done deliberately
    // here, is the split this handler is now written around: a landing has a
    // PRESENTATION half and a WORLD half, and only the second one needs a world.
    //
    // The presentation half runs now, so the menu never advertises the session the
    // player just left -- the identity reset (issue #316's finding 4 site: a retained
    // Practice descriptor must not survive onto a campaign board), the session kind, and
    // the level readout, all derived from `deps.levels.start` without building it.
    //
    // The world half is OWED, and `pendingLanding` is that debt. Continue redeems it
    // immediately before entering gameplay, so a post-quit Continue still resumes on a
    // real campaign board with the run's own lives -- and reads `deps.levels.start` and
    // the run LATER than this handler would have, which is strictly more current.
    //
    // Quit still suspends presentation of the run and must not create or replenish one
    // (the spec's rule for quit/refresh/reopen), which is why the deferred call passes
    // `false` -- unlike the game-over/completion restart in onStartRestart.
    //
    // THE ONE STATED RESIDUAL. The topbar's campaign Lives/Enemies readout is projected
    // from a WORLD (`refreshStats`), so with no world built here it keeps the abandoned
    // session's numbers until the next build instead of the landing board's. Measured on
    // the ENEMY COUNT, in a browser and in loop.test.ts; Lives rides the same call and is
    // stale the same way but is not separately asserted -- see that test for why. The
    // chrome does not belong on an application screen at all: making the gameplay HUD
    // contextual is #324, and this issue's own criterion "gameplay-only HUD elements must
    // not leak into application screens" is where it goes away.
    //
    // WHAT IS DELIBERATELY LEFT STALE UNTIL THE LANDING BUILDS: `currentDescriptor` and
    // `currentSession` still describe the abandoned world, while the HUD has already been
    // told the landing's kind. Inert, and checked rather than assumed -- nothing reads
    // either at the Main Menu, and Continue rebuilds through `switchTo`, which re-derives
    // both from `sessionIdentity` and the level it actually built before `enterGameplay`
    // is handed one. Re-deriving them here would mean resolving a session against a world
    // that does not exist yet.
    sessionIdentity = bootContext.identity;
    const landing = deps.levels.start;
    hud.setSessionKind(descriptorFor(sessionIdentity, ordinalOf(landing)).kind);
    hud.setLevel(ordinalOf(landing), deps.levels.levels.length);
    pendingLanding = true;
    sm.toMainMenu();
  });

  // The controller assignment UI's one write path -- see reassignSlot's own doc comment.
  slot.onReassignSlot(reassignSlot);

  /**
   * The music follows the game rather than merely starting and stopping.
   *
   * Shared by the state-change path and BOOT. Boot matters: the initial title
   * panel is pushed straight to the HUD without going through the state
   * machine, so hanging this off onChange alone left the title screen silent --
   * which is the very gap this change exists to close, and the browser probe
   * caught it.
   */
  function followMusic(location: AppLocation): void {
    // startMusic is idempotent, so a resume passing back through `playing` does
    // not double-start anything -- but NOT via the `music.playing()` check,
    // which guards the Howl branch the game never reaches. On the generated-bed
    // path that actually runs, `if (!bed)` builds the bed once (engine.ts) and
    // `bed.start()` returns early when its timer already exists (music.ts).
    // It runs for EVERY location: routes (launch/main-menu/settings/...),
    // gameplay phases (playing/paused/outcome) all have music, and each is a
    // context the director moves to through the same handled join a suite
    // change uses.
    audio.startMusic();
    audio.setMusicContext(musicContextFor(location));
    // Pause DUCKS rather than stops. Stopping discards the playlist's committed
    // decisions and leaves the scheduler at an ambiguous position -- exactly
    // what produced both blockers in the suite-wiring review -- while ducking
    // touches only the gain, so resuming is seamless.
    audio.duckMusic(location.kind === 'gameplay' && location.phase.kind === 'paused');
  }

  const stopObserving = sm.onChange((location) => {
    // No `hud.setState` here: since issue #428 the PAGE paints which screen is showing
    // (`route-host.ts`), because a HUD only a session ever painted would leave a page with
    // no session showing nothing at all. What stays is everything that needs a world.
    //
    // The splash covers the toast rail, so a notice raised at boot is held until the
    // player has left it -- see `flushSettingsNotice`. Called on EVERY change rather
    // than only on the launch->main-menu edge: the notice can also arrive later (a
    // first failed write), and a later arrival while the splash is somehow still up
    // must not be dropped either.
    flushSettingsNotice();
    const nowPlaying = location.kind === 'gameplay' && location.phase.kind === 'playing';
    // The shipped screens and the run bookkeeping below still work in terms of
    // "did this end well", so the typed outcome is flattened through the
    // explicitly-named compatibility projection rather than by re-deriving a
    // win/lose guess here. The run-mutation branch further down reads the
    // OUTCOME KIND directly where the distinction actually matters.
    const outcome = location.kind === 'gameplay' && location.phase.kind === 'outcome'
      ? location.phase.outcome
      : null;
    const nowWon = outcome !== null && legacyOutcomePresentation(outcome) === 'win';
    // The round indicator is pushed ONLY from onSimulated, which the driver runs
    // only while playing. Without this, pausing or blurring during the 3s
    // countdown freezes the chip on screen -- and quitting to Main Menu strands
    // it there indefinitely, since switchTo rebuilds the world without
    // simulating. The chip sits in the topbar (z-index 1), so it paints over
    // the panel.
    if (!nowPlaying) hud.setRoundPhase(null);
    // Same reasoning as the round chip above: the marks are pushed ONLY from
    // onSimulated, which the driver runs only while playing, so pausing mid-drag would
    // strand a thumb on screen with no thumb under it.
    if (!nowPlaying) {
      hud.setTouchIndicator({ ...input.touchIndicator(), stick: null, aim: null });
    }
    followMusic(location);
    // Progress is recorded AT the win, not at the Next Level click: quitting after a
    // win keeps the unlock. The sandbox records nothing -- a test rig must not
    // unlock real levels.
    if (nowWon && deps.levels.tracksProgress) {
      deps.progress.recordCleared(level);
    }
    // Latched, not evaluated here -- see pendingClear. Outside the tracksProgress
    // guard on purpose: the sandbox unlocks no levels but a feat performed there is
    // still a feat. recordCleared has already run, so level milestones see the clear.
    if (nowWon) pendingClear = ordinalOf(level);
    // The active RUN's own transitions (issue #153/#152) -- separate from permanent
    // progress just above, and gated on campaignActive() so practice and the sandbox
    // can never reach them. Reactive, not deferred to the Next Level/Retry click: a
    // refresh sitting at the outcome screen must already see the persisted result.
    if (campaignActive() && outcome !== null) {
      // Straight off the TYPED outcome now: `campaign-complete` and
      // `campaign-over` both end the run, `mission-clear` advances it. This is
      // the distinction issue #316 exists to make available, and reading it
      // here removes the old re-derivation of "is this the last level?" at the
      // point of use -- the classifier already decided that, once, from the
      // level that actually ended.
      if (outcome.kind === 'campaign-complete' || outcome.kind === 'campaign-over') {
        deps.run.endRun();
      } else if (outcome.kind === 'mission-clear') {
        const next = nextInSession(level);
        // `mission-clear` means a next level exists by construction, but the
        // lookup stays guarded rather than asserted: a null here must not throw
        // inside a state-change subscriber.
        if (next !== null) deps.run.advanceLevel(next.id, driver.world.lives);
      }
    }
    // The driver stops sampling while paused and only sample() resets the fire/mine
    // latches, so a Space pressed around or during a pause would mine on the first
    // resumed tick. At the state change, so hotkey, blur and any future pause trigger
    // all pass through the same clear. (input.ts clears itself on window blur too;
    // that covers alt-tab, this covers Esc/P.)
    // EVERY exit from play, not just pause. The driver stops calling sample() for any
    // location that is not `playing` (driver.ts), while the window-level pointer and
    // key listeners keep running -- so a press completed on an outcome or Main Menu
    // screen latches and fires on the first sample() of the NEXT round.
    if (!nowPlaying) input.clearQueuedPresses();
    // The gamepad half, on every ENTRY into play (issue #494): the page's menu poller
    // reads A and B as Confirm and Back while nothing simulates, and the gameplay
    // readers -- not polled at all then -- would otherwise see the A that confirmed
    // Resume, still held on the first tick, as a fresh fire edge. Every real source,
    // slot 0 and each co-player pad alike; a held or bot source has nothing to resync.
    if (nowPlaying) for (const src of realSources.values()) src.resyncGamepad?.();
  });

  // The initial surface paint moved to `route-host.ts` with the subscription above; the
  // music did not, because it needs this session's audio engine.
  followMusic(sm.location); // this path bypasses sm.onChange
  hud.setLevel(ordinalOf(level), deps.levels.levels.length);
  deps.stats.startAttempt();
  coopKills = [];
  versusDeaths = [];
  // The outcome panel's opening state, stated rather than inherited: a session that is
  // disposed before it ever produces an event still leaves the HUD holding a projection
  // that describes THIS session's board, not the previous one's.
  pushOutcome(world);
  // NO APPLICATION-SURFACE PUSHES HERE any more (issue #324, step S5). Continue, the
  // Levels grid, Records and the paint shop's selected swatches were all pushed from this
  // block at every session construction, over values `route-host.ts` had already painted
  // from the same page-owned stores -- and the application ground was pushed further up.
  // A second writer of a surface this session does not own is the boundary #324 draws,
  // and the duplicate was invisible only because the two agreed. The page's copy is the
  // one that exists before any session does, and now the only one. (Settings' own
  // controls left earlier, from `applySettings`; see its comment.)
  //
  // What is left is what only a session knows. The controller assignment is REPORTED
  // rather than written -- see `slot.setControllers` for why an `Assignment` cannot be
  // read off a page-owned store the way everything above could.
  slot.setControllers(assignment, botsMayDrivePlayers);
  refreshStats(world);

  // The title screen leaves on ANY gesture. Both listeners are unconditional and the
  // state machine does the guarding -- `dismissLaunch` acts only from `launch` -- so a
  // keypress or click during play falls through to the handlers below unchanged.
  //
  // The audio half of this is ORDERING, not unlocking -- see dismissLaunch in state.ts.
  // `audio/engine.ts` already resumes the context from its own document-level gesture
  // handler, and did before this screen existed. What changes is that the gesture is
  // now guaranteed to have happened before the menu is on screen.

  const onKey = (e: KeyboardEvent): void => {
    // A key that dismisses the title screen does that and NOTHING ELSE.
    //
    // Falling through here meant "Press any key to begin" included M, which mutes:
    // the one key most likely to be pressed by someone testing whether the game has
    // sound would silence the menu bed this screen exists to make audible, with only
    // the Mute button's label left to explain why. Escape and P were harmless by luck
    // alone -- pause() no-ops from 'title' -- which is not a property to rely on as
    // more hotkeys arrive.
    // No `atLaunch` branch: since issue #428 the PAGE owns the keydown listener
    // (`route-host.ts`'s `onHostKey`) and never forwards a key that dismissed the splash.
    // A second guard here would be dead code that read as the live one.
    //
    // No `isMuteHotkey` branch either, since issue #226: mute is a page-scoped preference
    // on a page-scoped store, and the Mute BUTTON it used to mirror no longer exists on
    // every surface -- `route-host.ts`'s `onHostKey` claims M and returns, so this handler
    // never sees it. Keeping a copy here would have muted twice per keystroke, which
    // cancels out and is therefore exactly the kind of duplicate a test would not catch.
    if (isPauseHotkey(e)) {
      // Toggle, guarded by the state machine: pause() acts only from `playing`
      // and resume() only from `paused`, so main-menu/outcome ignore the key
      // entirely.
      if (sm.isPaused) sm.resume();
      else sm.pause();
    }
  };
  // Through the slot, not the host: `route-host.ts` owns the one keydown listener and
  // hands on only the keys that are not the Launch gesture.
  slot.onKey(onKey);

  // A blurred tab must not keep eating lives. Focus deliberately does NOT
  // auto-resume: coming back to a firefight you cannot see yet is worse than
  // clicking Resume.
  const onBlur = (): void => {
    sm.pause();
  };
  deps.host.addEventListener('blur', onBlur);

  const onResize = (): void => {
    renderer.resize(deps.host.innerWidth, deps.host.innerHeight);
    // Only while open: a disposed preview has nothing to resize, and re-reading
    // hud.previewCanvas's now-hidden layout would just re-fit against stale/zero
    // dimensions for no visible effect.
    routeUi.resizePreview();
  };
  deps.host.addEventListener('resize', onResize);
  onResize();

  /**
   * The dev console surface, published only for the flags that asked for it.
   *
   * Console-level and nothing else: no HUD button, no CSS. Whether save
   * export/import earns a permanent affordance is a product call (issue #110),
   * and a button shipped here would decide it by accident.
   */
  const devApi: DevConsole = {};
  if (deps.devFlags.saveIo) {
    devApi.save = createSaveApi(deps.storage, deps.storageNamespace);
    devApi.settings = {
      snapshot: () => deps.settings.snapshot(),
      effective: () => deps.effectiveSettings.current(),
      status: () => deps.settings.status(),
      reset: () => deps.settings.reset(),
    };
  }
  if (recorder) devApi.replay = (): ReplayTrace => recorder.trace();
  const publishedDevApi = Object.keys(devApi).length > 0;
  if (publishedDevApi) deps.devConsole[DEV_CONSOLE_KEY] = devApi;

  driver.start();

  return {
    enterGameplay(): void {
      // `audio.unlock()` rides here for the reason the old handlers gave: the start
      // boundary runs inside the click that started the match, which is the only
      // guaranteed user gesture, and Safari will not open an AudioContext resumed from
      // anywhere else.
      audio.unlock();
      sm.enterGameplay(currentSession);
    },
    dispose(): void {
      driver.stop();
      // Guarded on having published it: a teardown that deleted the key
      // unconditionally would remove whatever a second instance -- or a
      // neighbouring page on this shared origin -- had put there.
      if (publishedDevApi) delete deps.devConsole[DEV_CONSOLE_KEY];
      // No `keydown`: the page owns that listener since issue #428, and `slot.detach()`
      // below is what stops this session receiving from it.
      deps.host.removeEventListener('resize', onResize);
      deps.host.removeEventListener('blur', onBlur);
      // No `pointerdown`: the Launch gesture belongs to the page since issue #428
      // (`route-host.ts`), and a session that unregistered it would take the splash
      // dismissal down with it on the way to the very first match.
      // The two settings registrations this SESSION made. The store, the effective
      // handle and the notice latch all outlive it (they belong to the page -- see
      // app-settings.ts), so what is released here is this session's listeners, holding
      // this session's HUD, audio engine and input controller. Disposing the handle
      // itself here instead would leave the NEXT session with a dead OS motion
      // subscription and settings that stop updating after one navigation.
      stopEffectiveSubscription();
      stopSettingsNotice();
      input.dispose();
      // Every REAL source except `input` itself, whichever slot currently holds it --
      // `input` is the boot-to-teardown singleton, disposed exactly once above,
      // regardless of which slot the controller assignment UI has it in right now.
      // Gamepad readers hold no listeners of their own today (see
      // GamepadReader.dispose's own doc comment) and `createHeldInputSource` holds none
      // either, but both are disposed for symmetry and so a future stateful slot has
      // somewhere to release. A bot-claimed slot has nothing here to dispose -- see
      // `realSources`' own doc comment.
      realSources.forEach((s) => {
        if (s !== input) s.dispose();
      });
      renderer.dispose();
      /**
       * Release the slot, and dispose NOTHING the page owns (issue #468).
       *
       * This used to be `routeUi.disposePreview()` and `hud.dispose()`. Both now belong
       * to `route-host.ts`'s own `dispose()`, which only the page teardown calls. A
       * session that still disposed them would blank the shell on every Quit and every
       * Campaign<->Versus switch -- and `boot.test.ts`'s pagehide suites could not see
       * it, because the page is going away in those anyway.
       *
       * Detaching is what stops this session's seven handlers being dispatched to after
       * it is gone. It is inert if a replacement session has already taken the slot, so
       * the ordering `replace()` uses -- stop the old, start the new -- is safe either
       * way round.
       */
      slot.detach();
      // ...and stop observing the page's state machine, which outlives this session
      // (issue #468) and was subscribed above. A subscriber left behind keeps running on
      // every later change with THIS session's closures -- its level, its identity, its
      // disposed input -- so a retired Practice session recorded the live campaign
      // session's level clear against its own level, and a retired campaign session
      // advanced the shared run with a stale life count first. Both measured in
      // loop.test.ts's "a retired session stops observing the page state machine".
      stopObserving();
      deps.releaseAudio(audio);
    },
  };
}
