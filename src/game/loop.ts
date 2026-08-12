import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import type { Vec2, InputState } from '../sim/types';
import { decidePlayerInput, createPlayerAiState, mulberry32 } from '../sim/ai/player-profile';
import { ARENA_DEFS } from '../sim/arena';
import { createLevelSystem, type LevelSystem } from './levels';
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
import { createRenderer, type Renderer3D } from '../render/renderer';
import { createTankPreview, type TankPreview } from '../render/preview';
import { createAudioEngine, type AudioEngine } from '../audio/engine';
import { AUDIO_MANIFEST } from '../audio/manifest';
import type { SuiteContext } from '../audio/suites';
import type { GameState } from './state';
import { createAudioDirector, type AudioDirector } from '../audio/director';
import { createHapticsDirector, resolveVibrate, type HapticsDirector } from './haptics';
import { createGameStateMachine, type GameStateMachine } from './state';
import { createHud, type Hud } from './hud';
import { createDriver, type RafScheduler } from './driver';
import { roundPhase, roundPhaseTicksLeft } from '../sim/round';
import { TICK_HZ } from '../sim/constants';
import { parseDevFlags, type DevFlags } from './devflags';
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
  removeEventListener(type: 'keydown', fn: (e: KeyboardEvent) => void): void;
  removeEventListener(type: 'resize', fn: (e: Event) => void): void;
  removeEventListener(type: 'blur', fn: (e: Event) => void): void;
  removeEventListener(type: 'pointerdown', fn: (e: Event) => void): void;
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
  readonly createStateMachine: () => GameStateMachine;
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
 * Did the PLAYER die this frame?
 *
 * The event stream is shared, so `some(e => e.type === 'tank-destroyed')` is
 * true for every enemy kill as well -- the presence-only mistake CLAUDE.md
 * warns about. Exported so the discrimination is testable without engineering
 * a real death inside a driven frame.
 */
export function isPlayerDeath(events: SimEvent[]): boolean {
  return events.some((e) => e.type === 'tank-destroyed' && e.kind === 'player');
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
 * Which musical world a game state belongs to.
 *
 * Pause deliberately keeps the ARENA context: the round is still in progress
 * behind the panel, and moving the music elsewhere would make a pause feel like
 * leaving the level. It is ducked instead.
 */
export function musicContextFor(state: GameState): SuiteContext {
  switch (state) {
    // The splash screen shares the menu's suite rather than taking one of its own. It
    // is the same world musically, and it is the screen on which nothing can be heard
    // yet anyway -- the context is set here so that the gesture which dismisses it
    // starts the menu bed already in the right suite, with no switch on arrival.
    case 'splash':
    case 'title':
      return 'menu';
    case 'win':
      return 'victory';
    case 'lose':
      return 'defeat';
    case 'playing':
    case 'paused':
      return 'arena';
    default: {
      // Exhaustive by construction, the way TANK_KINDS forces a JSON entry: a
      // new GameState is a COMPILE error here rather than silently inheriting
      // arena's music. A `default: return 'arena'` compiled clean when a state
      // was added, which is how a screen ends up scored as though it were a
      // round in progress.
      const unreachable: never = state;
      return unreachable;
    }
  }
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
  const devFlags = parseDevFlags(globalThis.location?.search ?? '');
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
  };
}

export function startGame(canvas: HTMLCanvasElement, uiRoot: HTMLElement): GameHandle {
  return startGameWith(canvas, uiRoot, createBrowserDeps());
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
  function buildWorld(atLevel: number, lives?: number): World {
    const w = deps.levels.world(atLevel, nextSeed(), deps.devFlags.mineTrigger ?? undefined, lives);
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
  const bootLives = deps.levels.tracksProgress && !deps.levels.isDevJump
    ? deps.run.active()?.livesRemaining
    : undefined;
  let world = buildWorld(level, bootLives);
  // Whether the CURRENT session is practice (Level Select), as opposed to the
  // campaign run. Practice must not consume, restore, replace, advance or complete
  // the active run (the spec's hard rule) -- this is the flag every run-mutation
  // below is gated on. Starts false: the board just built above is always the
  // campaign's own (the sandbox aside, where it is moot -- see campaignActive).
  let inPractice = false;
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
   */
  function campaignActive(): boolean {
    return deps.levels.tracksProgress && !deps.levels.isDevJump && !inPractice;
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
  });
  const input = deps.createInput(canvas, (x, y) => renderer.screenToGround(x, y), {
    gamepad: deps.devFlags.gamepad,
  });
  // The saved scheme, pushed at boot so the very first touch already uses it -- see the
  // echo-back wiring below for what happens when the player changes it in the HUD.
  input.setTouchScheme(deps.touchSettings.scheme());
  // Same convention for the saved fire mode: pushed at boot so the very first tap on
  // the aim side already reads under the right gesture.
  input.setFireMode(deps.touchSettings.fireMode());
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
   */
  const autoplayRnd = mulberry32(deriveSeed(deps.wallMs()) + 1);
  const autoplayState = createPlayerAiState(autoplayRnd);
  const effectiveInput = {
    sample: (): InputState =>
      deps.devFlags.autoplay && playerId !== undefined
        ? decidePlayerInput(driver.world, playerId, autoplayRnd, autoplayState)
        : input.sample(),
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
    ? createRecordingInput(effectiveInput, replayMetaFor(world, ARENA_DEFS[level].id))
    : null;
  const director = deps.createDirector(audio, playerId ?? -1);
  const haptics = deps.createHaptics(playerId ?? -1);
  // Read once at boot; the toggle below (see the settings-row wiring) keeps it live
  // afterward, the same as the saved scheme/fire-mode reads just above. Re-reading here
  // on every world switch would be redundant with that.
  haptics.setEnabled(deps.touchSettings.haptics());
  const sm = deps.createStateMachine();
  const hud = deps.createHud(uiRoot);

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

  function checkAchievements(clearedLevel: number | null): void {
    const ctx: AchievementContext = {
      lifetime: deps.stats.lifetime(),
      attempt: deps.stats.attempt(),
      highestCleared: deps.progress.highestCleared(),
      totalLevels: deps.levels.count,
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

  // Rounds restart on every RESPAWN, not just at game start (resetArena moves
  // roundStartTick), so a player with 3 lives sees the opening phases at least
  // three times. The banner teaches once per page load; every round after it
  // gets the quiet chip.
  let lastRoundStartTick: number | null = null;
  // The denominator for musical intensity. Re-read on every world rebuild, since
  // arenas differ in enemy count.
  let enemiesAtRoundStart = countEnemies(world);
  let roundsSeen = 0;
  /**
   * `?dev=1&gamepad=1` only: `input.gamepadConnected()` is always false when the flag is
   * off (the reader is never constructed -- see input.ts), so this needs no separate flag
   * check. Toasts on each RISING edge -- a reconnect toasts again, pinned by its own
   * test -- because Firefox does not expose a
   * pad to `navigator.getGamepads()` until the player presses a button on it, so this is
   * the one moment that confirms the press was seen.
   */
  let wasGamepadConnected = false;
  function refreshRoundPhase(w: World): void {
    if (w.roundStartTick !== lastRoundStartTick) {
      lastRoundStartTick = w.roundStartTick;
      roundsSeen += 1;
    }
    const phase = roundPhase(w);
    if (phase === 'live') {
      hud.setRoundPhase(null);
      return;
    }
    hud.setRoundPhase({
      phase,
      secondsLeft: Math.ceil(roundPhaseTicksLeft(w) / TICK_HZ),
      prominent: roundsSeen <= 1,
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
      // The aim STICK needs the player's WORLD position to project a point from --
      // see setPlayerPosition's doc comment. `null` when there is no player tank in
      // this world, in which case the input layer simply holds its last aim.
      const player = w.tanks.find((t) => t.kind === 'player');
      const playerPos = player ? { x: player.pos.x, y: player.pos.y } : null;
      input.setPlayerPosition(playerPos);
      // Same position, to the haptics director: mine-detonate is the only cue that
      // needs a distance from the player, and the event stream never carries the
      // player's own position (mine-detonate carries only the mine's).
      haptics.setPlayerPosition(playerPos);
      hud.setTouchIndicator(input.touchIndicator());
      const gamepadConnected = input.gamepadConnected();
      if (gamepadConnected && !wasGamepadConnected) hud.showToast('Gamepad connected');
      wasGamepadConnected = gamepadConnected;
      refreshRoundPhase(w);
      audio.setMusicIntensity(musicIntensity(countEnemies(w), enemiesAtRoundStart));
    },
    // The event stream is shared, so a bare `some(e => e.type === 'tank-destroyed')`
    // fires on every enemy kill too -- exactly the presence-only mistake
    // CLAUDE.md warns about. Discriminate on kind.
    onFrameEvents(events): void {
      if (isPlayerDeath(events)) {
        hud.signalPlayerDeath();
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
      // AFTER record, so an attempt feat sees the attempt that just finished.
      checkAchievements(pendingClear);
      pendingClear = null;
      // Keep the HUD's copy fresh: the stats page re-renders only while visible, and
      // the win/lose run-summary line updates a beat after the state flips -- the
      // winning kill is in THIS batch, not the one before the panel opened.
      hud.setStats({ lifetime: deps.stats.lifetime(), attempt: deps.stats.attempt() });
    },
  });

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
    if (sm.state === 'title') {
      sm.startPlaying();
    } else if (sm.state === 'paused') {
      // Resume shares the action button with Play Again/Retry, whose branch below
      // REBUILDS the world. Resuming must keep the game exactly as frozen.
      sm.resume();
    } else {
      // Intermediate win -> the NEXT level, with the lives that survived this one.
      // Neither branch touches the active RUN here: a mid-campaign level clear or a
      // game-over/completion is already persisted reactively in sm.onChange, the
      // instant the state flipped -- not deferred to this click, so a refresh at the
      // win/lose screen cannot lose it. This click only decides which WORLD to build.
      const advancing = sm.state === 'win' && level + 1 < deps.levels.count;
      if (advancing) {
        switchTo(level + 1, driver.world.lives);
      } else {
        // Final win, game over, or a practice session ending either way -- land back
        // on the campaign's own board (never a fresh one; see landOnCampaignBoard).
        // Only a real campaign session may CREATE a new run here: the one that just
        // ended (sm.onChange's 'lose'/final-'win' branch already ran endRun()) is
        // gone, and playing on needs somewhere to persist the next death/clear.
        landOnCampaignBoard(campaignActive());
      }
      sm.restart();
    }
  });

  /**
   * Land on a level: build its world, rebind everything the old world owned, and
   * refit the renderer if the BOARD changed size. One path for advance, quit and
   * level pick -- their parity was reviewed line-by-line three times before it
   * became structural.
   */
  function switchTo(newLevel: number, lives?: number): void {
    level = newLevel;
    world = buildWorld(level, lives);
    // A new world means a new trace: the recorded inputs only mean anything
    // applied to the world they were sampled against, so carrying them across a
    // level switch would produce a trace that replays into a different game.
    recorder?.begin(replayMetaFor(world, ARENA_DEFS[level].id));
    playerId = world.tanks.find((t) => t.kind === 'player')?.id;
    director.setPlayerId(playerId ?? -1);
    haptics.setPlayerId(playerId ?? -1);
    // A FRESH world's roundStartTick can equal the old one's (both start at the same
    // tick), so without this reset the round tracker would not count the new level's
    // opening round and the teaching banner would re-show.
    lastRoundStartTick = null;
    enemiesAtRoundStart = countEnemies(world);
    const b = deps.levels.bounds(level);
    if (b.width !== shownBounds.width || b.height !== shownBounds.height || b.cellSize !== shownBounds.cellSize) {
      // Guarded: a same-size rebuild (retry, quit on the same board) must not
      // reallocate ground geometry on every click.
      renderer.refit(b.width, b.height, b.cellSize);
      shownBounds = b;
    }
    hud.setLevel(level + 1, deps.levels.count);
    driver.reset(world);
    refreshStats(world);
    // A switch is a new ATTEMPT: the per-attempt tally starts over, the lifetime
    // rolls on. Deliberately NOT where the active RUN is touched -- switchTo only
    // builds a world; every caller above decides for itself whether this world is
    // campaign or practice, and mutates (or does not mutate) the run accordingly.
    deps.stats.startAttempt();
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
   * the run that just ended is already gone (sm.onChange's 'lose'/final-'win'
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
    inPractice = false;
    const startLevel = deps.levels.start;
    if (deps.levels.tracksProgress && deps.run.active() === null && mayCreateRun) {
      deps.run.startNewRun(startLevel);
    }
    const lives = campaignActive() ? deps.run.active()?.livesRemaining : undefined;
    switchTo(startLevel, lives);
    if (deps.levels.tracksProgress) hud.setContinueAvailable(deps.run.active() !== null);
  }

  /** How many levels are pickable: everything cleared plus the next one, capped. */
  const unlockedLevels = (): number =>
    Math.min(deps.progress.highestCleared() + 1, deps.levels.count);

  hud.onLevelSelect((picked) => {
    // Panel-only control, guarded like Quit: CSS hiding is not the only defence --
    // and neither is the HUD's button rendering, for the index. ARENAS[7] is
    // undefined, and a handler that rebuilds the world does not get to crash on it.
    if (sm.state !== 'title') return;
    if (!Number.isInteger(picked) || picked < 0 || picked >= deps.levels.count) return;
    // Practice: independent fresh lives (switchTo's `lives` is left undefined, so
    // buildWorld defaults to full LIVES), and the active campaign run is never read
    // or written from here on out -- see campaignActive.
    inPractice = true;
    switchTo(picked);
    // A level click is as real a gesture as the Start button, and it starts play, so
    // it must unlock the audio context too -- Safari accepts no later opportunity.
    audio.unlock();
    sm.startPlaying();
  });

  // New Run (spec: docs/superpowers/specs/2026-08-11-campaign-run-model.md): the one
  // deliberate action that creates or explicitly replaces the active campaign run.
  // Distinct from onLevelSelect above -- before issue #153 New Game reported
  // onLevelSelect(0), the literal same event as picking level 1 in the Levels panel,
  // which is exactly why practice and campaign could not be told apart.
  hud.onNewGame(() => {
    if (sm.state !== 'title') return;
    const fresh = deps.run.startNewRun(0);
    inPractice = false;
    switchTo(0, fresh.livesRemaining);
    hud.setContinueAvailable(true);
    // Same convention as onLevelSelect just above: a real gesture that starts play
    // must unlock the audio context here, since Safari accepts no later opportunity.
    audio.unlock();
    sm.startPlaying();
  });

  // The touch-only pause button. Routed through the SAME guarded transitions as the
  // keyboard hotkey rather than its own path -- pause() acts only from 'playing' and
  // resume() only from 'paused', so the button cannot reach a state the key cannot.
  //
  // Deliberately does NOT change the music: musicContextFor maps 'paused' to 'arena'
  // and the bed ducks instead of stopping, on the reasoning that moving the music
  // elsewhere would make a pause feel like leaving the level.
  hud.onPauseTap(() => {
    if (sm.state === 'paused') sm.resume();
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
    // The HUD hides the Quit button outside pause, but a handler that rebuilds the
    // world deserves its own guard, not a CSS class as its only defence.
    if (sm.state !== 'paused') return;
    // Quit suspends presentation of the run; it must not create or replenish one
    // (the spec's rule for quit/refresh/reopen) -- `false` here, unlike the
    // game-over/completion restart in onStartRestart. Rebuilt NOW rather than
    // lazily on Continue, so the title screen renders over the campaign's own
    // board, not the abandoned (possibly practice) one.
    landOnCampaignBoard(false);
    sm.toTitle();
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
    hud.setLevelSelect(unlockedLevels(), deps.levels.count);
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
  function followMusic(s: GameState): void {
    // startMusic is idempotent, so a resume passing back through 'playing' does
    // not double-start anything -- but NOT via the `music.playing()` check,
    // which guards the Howl branch the game never reaches. On the generated-bed
    // path that actually runs, `if (!bed)` builds the bed once (engine.ts) and
    // `bed.start()` returns early when its timer already exists (music.ts).
    // It runs for EVERY state now: title, endings and pause all have music, and
    // each is a context the director moves to through the same handled join a
    // suite change uses.
    audio.startMusic();
    audio.setMusicContext(musicContextFor(s));
    // Pause DUCKS rather than stops. Stopping discards the playlist's committed
    // decisions and leaves the scheduler at an ambiguous position -- exactly
    // what produced both blockers in the suite-wiring review -- while ducking
    // touches only the gain, so resuming is seamless.
    audio.duckMusic(s === 'paused');
  }

  sm.onChange((s) => {
    hud.setState(s);
    // The round indicator is pushed ONLY from onSimulated, which the driver runs
    // only while playing. Without this, pausing or blurring during the 3s
    // countdown freezes the chip on screen -- and quitting to title strands it
    // there indefinitely, since switchTo rebuilds the world without simulating.
    // The chip sits in the topbar (z-index 1), so it paints over the panel.
    if (s !== 'playing') hud.setRoundPhase(null);
    // Same reasoning as the round chip above: the marks are pushed ONLY from
    // onSimulated, which the driver runs only while playing, so pausing mid-drag would
    // strand a thumb on screen with no thumb under it.
    if (s !== 'playing') {
      hud.setTouchIndicator({ ...input.touchIndicator(), stick: null, aim: null });
    }
    followMusic(s);
    // Progress is recorded AT the win, not at the Next Level click: quitting after a
    // win keeps the unlock. The sandbox records nothing -- a test rig must not
    // unlock real levels.
    if (s === 'win' && deps.levels.tracksProgress) {
      deps.progress.recordCleared(level + 1);
      hud.setLevelSelect(unlockedLevels(), deps.levels.count);
    }
    // Latched, not evaluated here -- see pendingClear. Outside the tracksProgress
    // guard on purpose: the sandbox unlocks no levels but a feat performed there is
    // still a feat. recordCleared has already run, so level milestones see the clear.
    if (s === 'win') pendingClear = level + 1;
    // The active RUN's own transitions (issue #153/#152) -- separate from permanent
    // progress just above, and gated on campaignActive() so practice and the sandbox
    // can never reach them. Reactive, not deferred to the Next Level/Retry click: a
    // refresh sitting at the win/lose screen must already see the persisted result.
    if (campaignActive()) {
      if (s === 'win') {
        const isFinalLevel = level + 1 >= deps.levels.count;
        if (isFinalLevel) {
          deps.run.endRun(); // campaign completion
        } else {
          deps.run.advanceLevel(level + 1, driver.world.lives); // level clear, lives carried
        }
      } else if (s === 'lose') {
        deps.run.endRun(); // game over: no lives remain
      }
    }
    // Refreshed on every arrival at the title screen -- covers boot (the initial call
    // below), quitting, and a game-over/completion restart's later return to title --
    // rather than only at the moments above, so this can never go stale relative to
    // whatever landOnCampaignBoard/onNewGame most recently decided.
    if (s === 'title') hud.setContinueAvailable(deps.run.active() !== null);
    // The driver stops sampling while paused and only sample() resets the fire/mine
    // latches, so a Space pressed around or during a pause would mine on the first
    // resumed tick. At the state change, so hotkey, blur and any future pause trigger
    // all pass through the same clear. (input.ts clears itself on window blur too;
    // that covers alt-tab, this covers Esc/P.)
    // EVERY exit from play, not just pause. The driver stops calling sample() for any
    // state that is not 'playing' (driver.ts), while the window-level pointer and key
    // listeners keep running -- so a press completed on a win, lose or title screen
    // latches and fires on the first sample() of the NEXT round. Review found this
    // after the 'paused' instance was fixed: same mechanism, one call site short.
    if (s !== 'playing') input.clearQueuedPresses();
  });

  hud.setState(sm.state); // initial title panel
  followMusic(sm.state); // ...and its music: this path bypasses sm.onChange
  hud.setLevel(level + 1, deps.levels.count);
  hud.setLevelSelect(unlockedLevels(), deps.levels.count);
  // Boot is an arrival at the title screen too (splash precedes it, but the button
  // states must already be right underneath) -- see the matching sm.onChange('title')
  // refresh above, which covers every LATER arrival.
  hud.setContinueAvailable(deps.run.active() !== null);
  deps.stats.startAttempt();
  hud.setStats({ lifetime: deps.stats.lifetime(), attempt: deps.stats.attempt() });
  hud.setHullColor(deps.customization.hull());
  hud.setSkin(deps.customization.skin());
  hud.setAccentColor(deps.customization.accent());
  hud.setTouchScheme(deps.touchSettings.scheme());
  hud.setFireMode(deps.touchSettings.fireMode());
  hud.setHaptics(deps.touchSettings.haptics());
  hud.setAchievements(deps.achievements.earned());
  refreshStats(world);

  // The title screen leaves on ANY gesture. Both listeners are unconditional and the
  // state machine does the guarding -- `dismissSplash` acts only from 'splash' -- so a
  // keypress or click during play falls through to the handlers below unchanged.
  //
  // The audio half of this is ORDERING, not unlocking -- see dismissSplash in state.ts.
  // `audio/engine.ts` already resumes the context from its own document-level gesture
  // handler, and did before this screen existed. What changes is that the gesture is
  // now guaranteed to have happened before the menu is on screen.
  const onSplashGesture = (): void => {
    sm.dismissSplash();
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
    if (sm.state === 'splash') {
      sm.dismissSplash();
      return;
    }
    if (isMuteHotkey(e)) hud.setMuted(audio.toggleMute());
    if (isPauseHotkey(e)) {
      // Toggle, guarded by the state machine: pause() acts only from 'playing' and
      // resume() only from 'paused', so title/win/lose ignore the key entirely.
      if (sm.state === 'paused') sm.resume();
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
