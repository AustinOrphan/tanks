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
import type { ProgressStore } from './progress';
import type { StatsStore } from './stats';
import type { CustomizationStore, SkinId } from './customization';
import type { TouchSettingsStore } from './touch-settings';
import type { AchievementsStore, AchievementContext } from './achievements';
import type { RunStore } from './run';
import { resolveStorage, createStores } from './storage';
import { createSaveApi, type SaveApi } from './save';
import {
  createRecordingInput,
  replayMetaFor,
  type RecordingInput,
  type ReplayTrace,
} from './replay';
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
import { createAudioEngine, type AudioEngine } from '../audio/engine';
import { AUDIO_MANIFEST } from '../audio/manifest';
import type { SuiteContext } from '../audio/suites';
import { createAudioDirector, type AudioDirector } from '../audio/director';
import { createHapticsDirector, resolveVibrate, type HapticsDirector } from './haptics';
import {
  createGameStateMachine,
  createOutcomeClassifier,
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
  type SessionContext,
  type SessionIdentity,
  descriptorFor,
  practiceLevelIdentity,
  resolveBootSessionContext,
  usesVersusTitleAffordances,
} from './session-intent';
import { createHud, type Hud, type HudSurface, SINGLE_PLAYER_DEATH_VIGNETTE } from './hud';
import { resolveOwnerColor } from '../render/entities';
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
      mineTimer?: boolean;
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
  /** The right thumb's saved aim scheme. Input-only downstream, unlike customization. */
  readonly touchSettings: TouchSettingsStore;
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

export interface GameHandle {
  dispose(): void;
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
  /** Export/import the five `tanks.*` keys. Reload after an import -- see save.ts. */
  save?: SaveApi;
  /** The input trace for the CURRENT level, replayable through replay.ts. */
  replay?: () => ReplayTrace;
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
export function createBotSources(
  seed: number,
  slots: ReadonlySet<number>,
): Map<number, { rnd: () => number; state: PlayerAiState }> {
  const sources = new Map<number, { rnd: () => number; state: PlayerAiState }>();
  for (const slot of slots) {
    const rnd = mulberry32(seed - BOT_SEED_SPACING + slot);
    sources.set(slot, { rnd, state: createPlayerAiState(rnd) });
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
 * focused control belong to that control, not to the game.
 */
export function isMuteHotkey(e: KeyboardEvent): boolean {
  if (e.repeat) return false;
  if (e.target instanceof HTMLElement && e.target.closest('input,button,select,textarea')) {
    return false;
  }
  return e.key === 'm' || e.key === 'M';
}

/** Escape or P toggles pause, under the same repeat/focused-control guard as mute. */
export function isPauseHotkey(e: KeyboardEvent): boolean {
  if (e.repeat) return false;
  if (e.target instanceof HTMLElement && e.target.closest('input,button,select,textarea')) {
    return false;
  }
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
 * `world.mode` dispatches two entirely separate rules:
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
 * teams beyond dispatching on `world.mode`.
 *
 * Not `stats.ts`: `StatCounts` has no per-player axis, and bolting one on would
 * conflate two orthogonal dimensions (metric vs. player) in one shape -- adopted
 * default 4 keeps lifetime stats P1-scoped. This stays a small loop.ts-local array
 * pair instead.
 */
export function tallyCoopKills(events: SimEvent[], world: World, kills: number[], deaths: number[]): void {
  if (world.mode === 'ffa' || world.mode === 'teams') {
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
  if (world.mode === 'teams') {
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
export function createBrowserDeps(): GameDeps {
  const search = globalThis.location?.search ?? '';
  const devFlags = parseDevFlags(search);
  // Resolved ONCE and shared by all five stores. It used to be resolved per
  // store, which was harmless only because localStorage hands back the same
  // object every time -- with the in-memory fallback it would have given each
  // store its own private namespace. storage.ts makes that structural.
  const storage = resolveStorage();
  const { progress, stats, customization, touchSettings, achievements, run } = createStores(storage);
  return {
    createRenderer,
    createPreview: createTankPreview,
    createInput: createInputController,
    createGamepadSource: (padIndex) => createGamepadInputSource(readNavigatorGamepads, padIndex),
    readDetectedPads: () => readDetectedPads(readNavigatorGamepads),
    createAudio: () => createAudioEngine(AUDIO_MANIFEST),
    createDirector: createAudioDirector,
    createHaptics: (playerId) => createHapticsDirector(resolveVibrate(), playerId),
    createStateMachine: createGameStateMachine,
    createHud,
    levels: createLevelSystem(devFlags, run),
    progress,
    run,
    stats,
    customization,
    touchSettings,
    achievements,
    storage,
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
): GameDeps {
  return applyVersusToDeps(createBrowserDeps(), versus, requestVersusSession, requestCampaignSession);
}

export function startGameWith(
  canvas: HTMLCanvasElement,
  uiRoot: HTMLElement,
  deps: GameDeps,
): GameHandle {
  // The STARTING level's board, not a fixed arena: a dev-flag jump may open on a
  // different-sized level, and the renderer must be born fitting it.
  let shownBounds = deps.levels.bounds(deps.levels.start);
  const { width, height } = shownBounds;

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
   * for the session's life: `world.mode` never changes within one (see the versus-results
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
  /** The LAST `botCount` of `playerCount` slots -- see botSlotsFor's own doc comment. */
  const botSlots = botSlotsFor(playerCount, botCount);

  /**
   * The controller assignment UI's SESSION-HELD model (input/assignment.ts, owner
   * ruling: no persistence, no seventh store). Seeded ONCE from `botSlots` -- today's
   * rule, made explicit -- and mutated only by `reassignSlot` below, via the panel.
   * `botSlots` itself is not read again after this: every later site that needs "which
   * slots are bots right now" reads it off `assignment` (`botSlotsFromAssignment`),
   * since a session-long reassignment can move a slot to or from `'bot'`.
   */
  let assignment: Assignment = deriveInitialAssignment(playerCount, botSlots);

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


  // `&& playerCount === 1`: a multiplayer boot gets fresh LIVES from balance.json, the
  // same as a dev jump -- see campaignActive's doc comment for why a multiplayer
  // session must not adopt (or later write) the real run's life count. Without this, a
  // multiplayer session opened mid-campaign would silently inherit whatever life count
  // the solo run happened to be sitting on, which has no decided meaning for a shared
  // pool.
  const bootLives = bootContext.identity.kind === 'campaign'
      && deps.levels.tracksProgress
      && !deps.levels.isDevJump
      && playerCount === 1
    ? deps.run.active()?.livesRemaining
    : undefined;
  let world = buildWorld(level, bootLives);
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
  let botSources = createBotSources(world.seed, botSlotsFromAssignment(assignment));
  /**
   * Is this session allowed to touch the active run at all? False for practice
   * (see `inPractice`), for any session `deps.levels.tracksProgress` says is not
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

  // Constructed EAGERLY and synchronously. main.ts wraps this call in a
  // try/catch to render a "this browser has no WebGL" page, and that only
  // works if the renderer throws out of HERE rather than out of a later
  // start(). Deferring construction breaks an error path nothing tests.
  const renderer = deps.createRenderer(canvas, width, height, shownBounds.cellSize, {
    aimRay: deps.devFlags.aimRay,
    mineReach: deps.devFlags.mineReach,
    mineTimer: deps.devFlags.mineTimer,
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
  // The saved scheme, pushed at boot so the very first touch already uses it -- see the
  // echo-back wiring below for what happens when the player changes it in the HUD.
  input.setTouchScheme(deps.touchSettings.scheme());
  // Same convention for the saved fire mode: pushed at boot so the very first tap on
  // the aim side already reads under the right gesture.
  input.setFireMode(deps.touchSettings.fireMode());
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
          out.push(decidePlayerInput(driver.world, tank?.id ?? -1, bot.rnd, bot.state));
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
  // Read once at boot; the toggle below (see the settings-row wiring) keeps it live
  // afterward, the same as the saved scheme/fire-mode reads just above. Re-reading here
  // on every world switch would be redundant with that.
  haptics.setEnabled(deps.touchSettings.haptics());
  /**
   * THE PRODUCTION CLASSIFIER (issue #316's finding 1).
   *
   * Both facts a terminal event must be read against are owned here and
   * nowhere else, so they are handed in at construction rather than left to a
   * descriptor-only default:
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
   */
  const sm = deps.createStateMachine({
    classifyOutcome: createOutcomeClassifier({
      isFinalCampaignLevel: () => nextInSession(level) === null,
      versusResult: () => versusResultFromWorld(driver.world),
    }),
  });
  const hud = deps.createHud(uiRoot);
  // Task 5b: fixed for this session's whole life, same posture as `playerCount` below --
  // a versus session's `deps.levels` never becomes a campaign level system mid-session
  // (levels.ts's own one-value-per-session comment), so the title screen's affordances
  // never need to change kind either. Drives which title buttons hud.ts shows (see
  // setSessionKind's own doc comment) -- set once, here, before any setState/
  // setContinueAvailable/setLevelSelect call below so the very first render already
  // reflects it.
  // Derived from the canonical model -- session identity plus its developer
  // provenance -- never from `initialVersusConfig`, a URL read, or a
  // `world.mode` check (issue #316's HUD-identity criterion). See
  // `usesVersusTitleAffordances` for why a DEVELOPER-flag versus session keeps
  // campaign-shaped title affordances: it still runs the campaign LevelSystem,
  // so Continue and Levels there rebuild correct FFA/teams worlds.
  hud.setSessionKind(usesVersusTitleAffordances(bootContext) ? 'versus' : 'campaign');
  // Task 6 (spec §3a): the in-match stock readout is versus-only for this session's
  // whole life, the same fixed-for-the-session posture as sessionKind just above.
  // The gate is `!deps.initialVersusConfig`, NOT "is this a campaign session" --
  // those are not the same test. `initialVersusConfig` is only ever set from a REAL
  // `VersusConfig` the setup pane handed to `requestVersusSession` (`applyVersusToDeps`);
  // a dev-flag-driven versus world (`?dev=1&mode=ffa`, no setup pane involved) has
  // `world.mode === 'ffa'`/`'teams'` but NO `initialVersusConfig`, and so ALSO takes
  // this branch -- see the "a versus fixture with NO players flag still gets a REAL
  // versus world" test below for that exact shape. For a genuine campaign session this
  // `null` really is the only call this session will ever make (a campaign world's
  // `mode` is fixed to `'campaign-coop'`, so onSimulated's own `isVersusFrame` branch
  // below never fires for it, all session long). For the dev-flag-versus case, this
  // `null` is simply the FIRST call -- onSimulated's very next 'playing' frame
  // overwrites the DATA with real entries the same way a setup-pane-driven versus
  // session's does, since `world.mode` is what that branch actually keys off, not
  // this flag. The STRIP stays hidden regardless, though: this session has no
  // `initialVersusConfig`, so the `hud.setSessionKind` call above passed `'campaign'`,
  // and hud.ts's visibility gate is `sessionKind === 'versus'` (not "does setVersusStocks
  // carry entries") -- see hud.test.ts's "a campaign session never shows the strip,
  // even with entries set" case for the proof.
  if (!deps.initialVersusConfig) hud.setVersusStocks(null);

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
   * coexist in one session (`world.mode` is fixed for its whole life), so one array
   * safely serves both. `versusDeaths` is the PR 4 addition `tallyCoopKills` needs only
   * for its ffa/teams branch -- unused, always empty, in campaign-coop. Per-attempt
   * scope, mirroring `attempt`'s own lifecycle: both reset at every `startAttempt()`
   * call site below, since they feed the same win/lose panel. Fed to the HUD
   * unconditionally -- whether either line actually shows is the HUD's own gate
   * (`setCoopKills`/`setVersusResults`, dispatched below on `driver.world.mode`).
   */
  let coopKills: number[] = [];
  let versusDeaths: number[] = [];
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
    hud.showAchievementToasts(fresh);
    hud.setAchievements(deps.achievements.earned());
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
      for (let i = 0; i < playerCount; i++) {
        const isKeyboardSlot = assignment[i].kind === 'keyboard';
        const connected = slotGamepadConnected(i);
        if (connected && !gamepadConnectedPrev[i]) {
          hud.showToast(isKeyboardSlot ? 'Gamepad connected' : `Player ${i + 1}'s controller connected`);
        } else if (!connected && gamepadConnectedPrev[i]) {
          hud.showToast(isKeyboardSlot ? 'Gamepad disconnected' : `Player ${i + 1}'s controller disconnected`);
        }
        gamepadConnectedPrev[i] = connected;
      }
      refreshRoundPhase(w);
      audio.setMusicIntensity(musicIntensity(countEnemies(w), enemiesAtRoundStart));
      // Task 6's in-match stock readout (spec §3a), dispatched HERE rather than from
      // onFrameEvents below (review of this task's own first landing): onSimulated
      // runs on EVERY 'playing' frame, unconditionally, including the pre-round
      // countdown -- no `SimEvent` marks "a versus match/countdown has started", so
      // gating on an event arriving left the strip dark until whatever the first event
      // happened to be (typically a shot). Reads `w`, the world this callback is
      // actually handed (the post-step world for THIS frame), rather than reaching for
      // `driver.world` the way onFrameEvents' own `isVersus`/setCoopKills/
      // setVersusResults dispatch still does one section below (untouched, out of this
      // relocation's scope) -- the two are the same world by the time either callback
      // runs (driver.ts assigns `curr` before calling either), but `w` is the value
      // this specific callback is actually given.
      const isVersusFrame = w.mode === 'ffa' || w.mode === 'teams';
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
      // Attributed against the CURRENT world's player: ids are arena-dependent, and
      // a stale id would misfile every stat from level 2 onward.
      deps.stats.record(events, playerId ?? -1);
      // The results-screen per-slot tally, alongside stats.record -- see coopKills' own
      // comment above for why this stays out of stats.ts.
      tallyCoopKills(events, driver.world, coopKills, versusDeaths);
      // AFTER record, so an attempt feat sees the attempt that just finished.
      checkAchievements(pendingClear);
      pendingClear = null;
      // Keep the HUD's copy fresh: the stats page re-renders only while visible, and
      // the win/lose run-summary line updates a beat after the state flips -- the
      // winning kill is in THIS batch, not the one before the panel opened.
      hud.setStats({ lifetime: deps.stats.lifetime(), attempt: deps.stats.attempt() });
      // Gated on the WORLD's real player count, not the playerCount variable -- the same
      // convention replayMetaFor uses, and the two never diverge in practice (the
      // sandbox exclusion keeps playerCount and countPlayerTanks(world) in lockstep by
      // construction). null means "never show", not merely "hide right now".
      //
      // n-player arc PR 4: dispatched on the world's own mode, mirroring resolveStatus's
      // dispatch one layer up -- campaign-coop feeds ONLY the coop line (today's rule,
      // unchanged), ffa/teams feed ONLY the versus line, so a session's two results
      // lines are never both live at once.
      const isVersus = driver.world.mode === 'ffa' || driver.world.mode === 'teams';
      hud.setCoopKills(!isVersus && countPlayerTanks(driver.world) >= 2 ? coopKills : null);
      hud.setVersusResults(isVersus ? { mode: driver.world.mode as 'ffa' | 'teams', kills: coopKills, deaths: versusDeaths } : null);
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
  function reassignSlot(slot: number, source: SlotSource): void {
    // The boundary's second enforcement point. The panel does not OFFER `'bot'` when it
    // is disallowed, so this is unreachable through the UI -- which is exactly why it is
    // here: a rule enforced only by the thing that draws the buttons is one stale DOM
    // node or one new caller away from not being a rule.
    if (source.kind === 'bot' && !botsMayDrivePlayers) return;
    const next = reassign(assignment, slot, source);
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
        const seeded = createBotSources(driver.world.seed, new Set([i]));
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
    // Refresh the panel's own display. setControllers rebuilds unconditionally
    // (see hud.ts) so this always re-renders, open or not -- cheap, and it is what
    // lets hud.css.test.ts's mountEveryButton fixture drive rows without opening
    // the panel first.
    hud.setControllers(assignment);
  }

  hud.onMuteToggle(() => {
    hud.setMuted(audio.toggleMute());
  });
  hud.onVolumeChange((v) => {
    audio.setVolume(v);
  });
  hud.onStartRestart(() => {
    // This click is the only guaranteed user gesture in the game, and Safari
    // will not open an AudioContext resumed from anywhere else. Sounds are
    // emitted from the frame loop, which never qualifies.
    audio.unlock();
    if (sm.atMainMenu) {
      // Continue from the Main Menu enters gameplay on the CURRENT resolved
      // session -- the world was already built at boot/quit/landOnCampaignBoard,
      // so this is the pure "start play" gesture. See `currentSession` for the
      // instance being entered.
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
      } else if (deps.initialVersusConfig) {
        // A versus match's own win/lose has nothing to advance to -- the versus
        // level system is always a single synthetic level (levels.ts), so `next`
        // above is null here exactly as it is for a campaign game-over. But unlike
        // campaign, "Play Again" on a FINISHED versus match must not silently
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
        hud.showVersusSetup(true, deps.initialVersusConfig);
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
  // interface's own doc comments on onVersusOpen/onVersusStart: the pane owns its
  // config state and its own Back button, so loop.ts's only two jobs are handing it
  // the retained config to prefill from (`?? null` for "no prior match this session",
  // the same fallback applyVersusToDeps/versusAwareDeps use for a fresh campaign boot)
  // and, on Start, forwarding the pane's chosen config to the reboot seam.
  hud.onVersusOpen(() => {
    hud.showVersusSetup(true, deps.initialVersusConfig ?? null);
  });
  // `?.`: `requestVersusSession` is optional (GameDeps' own doc comment) so every
  // existing test/caller that builds a GameDeps with no reboot seam at all keeps
  // compiling AND keeps working -- a Start click reaching here with nothing wired to
  // receive it must not throw.
  hud.onVersusStart((config) => {
    deps.requestVersusSession?.(config);
  });
  // Task 5b's Campaign button -- a bare passthrough, same shape as the two above:
  // `deps.requestCampaignSession` is only ever wired on a VERSUS session's own deps
  // (applyVersusToDeps), so a campaign session's own click here (unreachable, since
  // hud.ts hides the button there -- see setSessionKind) would no-op via `?.` exactly
  // like a Start click with no requestVersusSession wired does above.
  hud.onCampaignOpen(() => {
    deps.requestCampaignSession?.();
  });

  /**
   * Land on a level: build its world, rebind everything the old world owned, and
   * refit the renderer if the BOARD changed size. One path for advance, quit and
   * level pick -- their parity was reviewed line-by-line three times before it
   * became structural.
   */
  function switchTo(newLevel: CampaignLevel, lives?: number): void {
    level = newLevel;
    world = buildWorld(level, lives);
    // THE structural fix for issue #316's finding 4. The descriptor is
    // RE-DERIVED from the session identity and the level actually built, on
    // every world build -- it is never carried forward from a previous
    // transition, so a Practice descriptor cannot survive onto a campaign
    // board no matter which path got here. A Practice session advancing a
    // level also gets its ordinal updated for free, which a stored descriptor
    // silently would not.
    currentDescriptor = descriptorFor(sessionIdentity, ordinalOf(level));
    currentSession = resolveSession(currentDescriptor, world.seed, level.arenaId);
    // Reseeded here too -- see botSources' own doc comment above for why bots are
    // per-world, not per-session. Read off the CURRENT `assignment`, not the boot-time
    // `botSlots` set: a mid-session reassignment can have moved a slot to or from
    // `'bot'` since boot, and switchTo must not resurrect a stale bot roster.
    botSources = createBotSources(world.seed, botSlotsFromAssignment(assignment));
    // A new world means a new trace: the recorded inputs only mean anything
    // applied to the world they were sampled against, so carrying them across a
    // level switch would produce a trace that replays into a different game.
    recorder?.begin(replayMetaFor(world, level.arenaId));
    playerId = world.tanks.find((t) => t.kind === 'player')?.id;
    director.setPlayerId(playerId ?? -1);
    haptics.setPlayerId(playerId ?? -1);
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
    hud.setStats({ lifetime: deps.stats.lifetime(), attempt: deps.stats.attempt() });
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
   * `campaignActive()` instead (which is `tracksProgress && !isDevJump` here,
   * since `inPractice` is unconditionally false at this point) -- a jumped session
   * must not even READ the run's lives, or a stray quit/retry would leak an
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
    if (deps.levels.tracksProgress) hud.setContinueAvailable(deps.run.active() !== null);
  }

  /** How many levels are pickable: everything cleared plus the next one, capped. */
  const unlockedLevels = (): number =>
    Math.min(deps.progress.highestCleared() + 1, deps.levels.levels.length);

  hud.onLevelSelect((picked) => {
    // Panel-only control, guarded like Quit: CSS hiding is not the only defence --
    // and neither is the HUD's button rendering, for the index. `deps.levels.levels[7]`
    // is undefined on a shorter sequence, and a handler that rebuilds the world does
    // not get to crash on it.
    if (!sm.atMainMenu) return;
    if (!Number.isInteger(picked) || picked < 0 || picked >= deps.levels.levels.length) return;
    // Practice: independent fresh lives (switchTo's `lives` is left undefined, so
    // buildWorld defaults to full LIVES), and the active campaign run is never read
    // or written from here on out -- see campaignActive.
    // Identity transition 1 of 2 (issue #316): this session is Practice from
    // here until New Game or a landing on its home board resets it. The
    // ORDINAL is not stored -- `switchTo` derives the descriptor from this
    // identity and whichever level it actually builds, so the descriptor
    // cannot fall out of step with the board.
    sessionIdentity = practiceLevelIdentity();
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
  // `inPractice = false` is set FIRST, unconditionally, same as landOnCampaignBoard:
  // New Game from title always leaves practice, campaign-owning or not. Today every
  // path back to 'title' already runs through landOnCampaignBoard (quit-to-title) or
  // starts with `inPractice` false from construction, so `sm.atMainMenu` with
  // `inPractice === true` cannot currently happen -- this ordering is defensive, not
  // covering a reachable gap, so a future path to title that skips
  // landOnCampaignBoard cannot leave campaignActive() reading a stale practice flag.
  hud.onNewGame(() => {
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
      hud.setContinueAvailable(true);
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
  hud.onPauseTap(() => {
    if (sm.isPaused) sm.resume();
    else sm.pause();
  });

  // The touch-only Mine button, routed to the input controller's own latch so a mine
  // tapped is indistinguishable from a mine keyed: same sample(), same clear-on-pause.
  hud.onMineTap(() => {
    input.pressMine();
  });

  // The touch-only Fire button, routed the same way: a tap here is indistinguishable
  // from a click or a keypress once it reaches the latch. Touch aiming deliberately
  // never fires on its own -- see TouchScheme in input/touch.ts.
  hud.onFireTap(() => {
    input.pressFire();
  });

  // The aim-scheme toggle: store, then echo the ACCEPTED value back -- same convention
  // as the paint shop's onPickHullColor/onPickSkin below. setScheme refuses anything off
  // TOUCH_SCHEMES, so the echo can never show a scheme the input layer was not told.
  hud.onTouchSchemeChange((next) => {
    deps.touchSettings.setScheme(next);
    const accepted = deps.touchSettings.scheme();
    hud.setTouchScheme(accepted);
    input.setTouchScheme(accepted);
  });

  // The fire-mode toggle: same three-step convention -- store, then echo the ACCEPTED
  // value back to both the HUD and the input controller. setFireMode refuses anything
  // off FIRE_MODES, so the echo can never show a mode the input layer was not told.
  hud.onFireModeChange((next) => {
    deps.touchSettings.setFireMode(next);
    const accepted = deps.touchSettings.fireMode();
    hud.setFireMode(accepted);
    input.setFireMode(accepted);
  });

  // The haptics toggle: same three-step convention -- store, then echo the ACCEPTED
  // value back to both the HUD and the live director, since this preference has no
  // input-controller half the way scheme/fire-mode do. Booleans have no off-list value
  // to refuse, unlike setScheme/setFireMode.
  hud.onHapticsChange((next) => {
    deps.touchSettings.setHaptics(next);
    const accepted = deps.touchSettings.haptics();
    hud.setHaptics(accepted);
    haptics.setEnabled(accepted);
  });

  hud.onQuitToTitle(() => {
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
    // Quit suspends presentation of the run; it must not create or replenish one
    // (the spec's rule for quit/refresh/reopen) -- `false` here, unlike the
    // game-over/completion restart in onStartRestart. Rebuilt NOW rather than
    // lazily on Continue, so the Main Menu renders over the campaign's own
    // board, not the abandoned (possibly practice) one. `landOnCampaignBoard`
    // resets `inPractice` and rebuilds the campaign descriptor via the same
    // path New Game takes, so a post-quit Continue enters gameplay on a real
    // campaign board.
    // No descriptor bookkeeping here: `landOnCampaignBoard` resets the session
    // identity itself, and `switchTo` re-derives the descriptor from it.
    landOnCampaignBoard(false);
    sm.toMainMenu();
  });

  // The paint shop's live preview: a SECOND WebGL context. Built on onCustomizeOpen,
  // torn down on onCustomizeClose -- together the ONE chokepoint hud.ts fires both
  // transitions through (see its doc comment), so this never SKIPS a dispose down the
  // "Start while the panel is open" path. But "torn down" is dispose(), not context
  // loss: measured directly (see render/preview.ts's doc comment), the underlying
  // WebGL context survives dispose() and is REUSED on the next open, because the HUD
  // holds one persistent `.hud-preview` canvas for the whole session rather than a
  // fresh one per open. So the context is held from the first Customize open through
  // the rest of the session, not freed and reacquired every open/close -- what
  // dispose() DOES reclaim every time is the THREE-side cost (the scene, the tank
  // mesh, the skin texture, the environment map, the shadow map). The number that
  // stays true either way, and is the one that actually matters: peak is two live
  // contexts (this one plus the main game's), never three.
  let preview: TankPreview | null = null;
  hud.onCustomizeOpen(() => {
    preview = deps.createPreview(hud.previewCanvas, hud.previewRotateButtons);
    preview?.setStyle(
      deps.customization.hexFor(deps.customization.hull()),
      deps.customization.skin(),
      deps.customization.accentHexFor(deps.customization.accent()),
    );
  });
  hud.onCustomizeClose(() => {
    preview?.dispose();
    preview = null;
  });

  // Hull, skin and accent restyle through ONE renderer call: the style is a triple,
  // and sending part of it would reset the rest to a default. The live preview (when
  // open) gets the SAME triple, so the tank behind the panel and the one inside it
  // never disagree.
  function restyle(): void {
    const hex = deps.customization.hexFor(deps.customization.hull());
    const skin = deps.customization.skin();
    const accentHex = deps.customization.accentHexFor(deps.customization.accent());
    renderer.setPlayerStyle(hex, skin, accentHex);
    preview?.setStyle(hex, skin, accentHex);
  }

  hud.onPickHullColor((id) => {
    deps.customization.setHull(id);
    // Echo the ACCEPTED value back: the store refuses off-palette ids, and the
    // swatch ring must show what was stored, not what was clicked.
    hud.setHullColor(deps.customization.hull());
    restyle();
  });

  hud.onPickSkin((id) => {
    deps.customization.setSkin(id);
    hud.setSkin(deps.customization.skin());
    restyle();
  });

  hud.onPickAccentColor((id) => {
    deps.customization.setAccent(id);
    hud.setAccentColor(deps.customization.accent());
    restyle();
  });

  // The controller assignment UI's one write path -- see reassignSlot's own doc comment.
  hud.onReassignSlot(reassignSlot);

  // The panel's live pad list -- read once immediately on open (the browser's
  // gamepadconnected/disconnected events fire only on CHANGE, so opening over
  // already-connected pads would otherwise show nothing until the next hotplug), then
  // kept live by the two window listeners for as long as the panel stays open. Added and
  // removed at exactly this chokepoint -- the driver does not tick during title/paused,
  // so nothing else would refresh the panel while it is up.
  const onGamepadHotplug = (): void => {
    hud.setDetectedPads(deps.readDetectedPads());
  };
  hud.onControllersOpen(() => {
    onGamepadHotplug();
    deps.host.addEventListener('gamepadconnected', onGamepadHotplug);
    deps.host.addEventListener('gamepaddisconnected', onGamepadHotplug);
  });
  hud.onControllersClose(() => {
    deps.host.removeEventListener('gamepadconnected', onGamepadHotplug);
    deps.host.removeEventListener('gamepaddisconnected', onGamepadHotplug);
  });

  hud.onResetStats(() => {
    deps.stats.resetLifetime();
    hud.setStats({ lifetime: deps.stats.lifetime(), attempt: deps.stats.attempt() });
  });

  hud.onResetProgress(() => {
    deps.progress.reset();
    // Achievements are progress, not statistics: this is the one reset that clears
    // them, and Reset stats deliberately leaves them alone.
    deps.achievements.reset();
    hud.setAchievements(deps.achievements.earned());
    // Levels re-lock immediately: the select the player is looking at must not keep
    // offering a level the save no longer justifies.
    hud.setLevelSelect(unlockedLevels(), deps.levels.levels.length);
  });

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

  sm.onChange((location) => {
    hud.setState(locationToHudSurface(location));
    const nowPlaying = location.kind === 'gameplay' && location.phase.kind === 'playing';
    const nowAtMainMenu =
      location.kind === 'route' && location.route.kind === 'main-menu';
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
      hud.setLevelSelect(unlockedLevels(), deps.levels.levels.length);
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
    // Refreshed on every arrival at the Main Menu -- covers boot (the initial
    // call below), quitting, and a game-over/completion restart's later return
    // to Main Menu -- rather than only at the moments above, so this can never
    // go stale relative to whatever landOnCampaignBoard/onNewGame most recently
    // decided.
    if (nowAtMainMenu) hud.setContinueAvailable(deps.run.active() !== null);
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
  });

  hud.setState(locationToHudSurface(sm.location)); // initial launch panel
  followMusic(sm.location); // ...and its music: this path bypasses sm.onChange
  hud.setLevel(ordinalOf(level), deps.levels.levels.length);
  hud.setLevelSelect(unlockedLevels(), deps.levels.levels.length);
  // Boot is an arrival at the title screen too (splash precedes it, but the button
  // states must already be right underneath) -- see the matching sm.onChange main-menu
  // refresh above, which covers every LATER arrival.
  hud.setContinueAvailable(deps.run.active() !== null);
  deps.stats.startAttempt();
  coopKills = [];
  versusDeaths = [];
  hud.setStats({ lifetime: deps.stats.lifetime(), attempt: deps.stats.attempt() });
  hud.setHullColor(deps.customization.hull());
  hud.setSkin(deps.customization.skin());
  hud.setAccentColor(deps.customization.accent());
  hud.setTouchScheme(deps.touchSettings.scheme());
  hud.setFireMode(deps.touchSettings.fireMode());
  hud.setHaptics(deps.touchSettings.haptics());
  hud.setAchievements(deps.achievements.earned());
  hud.setBotAssignmentAllowed(botsMayDrivePlayers);
  hud.setControllers(assignment);
  refreshStats(world);

  // The title screen leaves on ANY gesture. Both listeners are unconditional and the
  // state machine does the guarding -- `dismissLaunch` acts only from `launch` -- so a
  // keypress or click during play falls through to the handlers below unchanged.
  //
  // The audio half of this is ORDERING, not unlocking -- see dismissLaunch in state.ts.
  // `audio/engine.ts` already resumes the context from its own document-level gesture
  // handler, and did before this screen existed. What changes is that the gesture is
  // now guaranteed to have happened before the menu is on screen.
  const onSplashGesture = (): void => {
    sm.dismissLaunch();
  };
  deps.host.addEventListener('pointerdown', onSplashGesture);

  const onKey = (e: KeyboardEvent): void => {
    // A key that dismisses the title screen does that and NOTHING ELSE.
    //
    // Falling through here meant "Press any key to begin" included M, which mutes:
    // the one key most likely to be pressed by someone testing whether the game has
    // sound would silence the menu bed this screen exists to make audible, with only
    // the Mute button's label left to explain why. Escape and P were harmless by luck
    // alone -- pause() no-ops from 'title' -- which is not a property to rely on as
    // more hotkeys arrive.
    if (sm.atLaunch) {
      sm.dismissLaunch();
      return;
    }
    if (isMuteHotkey(e)) hud.setMuted(audio.toggleMute());
    if (isPauseHotkey(e)) {
      // Toggle, guarded by the state machine: pause() acts only from `playing`
      // and resume() only from `paused`, so main-menu/outcome ignore the key
      // entirely.
      if (sm.isPaused) sm.resume();
      else sm.pause();
    }
  };
  deps.host.addEventListener('keydown', onKey);

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
    preview?.resize();
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
  if (deps.devFlags.saveIo) devApi.save = createSaveApi(deps.storage);
  if (recorder) devApi.replay = (): ReplayTrace => recorder.trace();
  const publishedDevApi = Object.keys(devApi).length > 0;
  if (publishedDevApi) deps.devConsole[DEV_CONSOLE_KEY] = devApi;

  driver.start();

  return {
    dispose(): void {
      driver.stop();
      // Guarded on having published it: a teardown that deleted the key
      // unconditionally would remove whatever a second instance -- or a
      // neighbouring page on this shared origin -- had put there.
      if (publishedDevApi) delete deps.devConsole[DEV_CONSOLE_KEY];
      deps.host.removeEventListener('keydown', onKey);
      deps.host.removeEventListener('resize', onResize);
      deps.host.removeEventListener('blur', onBlur);
      deps.host.removeEventListener('pointerdown', onSplashGesture);
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
      // The panel can still be open at teardown (main.ts's pagehide path can fire
      // any time) -- dispose whatever live preview context is holding, same as the
      // main renderer just above.
      preview?.dispose();
      audio.dispose();
      hud.dispose();
    },
  };
}
