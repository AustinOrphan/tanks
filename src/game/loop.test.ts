// @vitest-environment jsdom
//
// jsdom, as hud.test.ts and input.test.ts already do: isMuteHotkey does an
// `instanceof HTMLElement` check and the dispose path hands real elements
// around. frame.test.ts and driver.test.ts deliberately do NOT use jsdom.
import { describe, it, expect } from 'vitest';
import { DEV_FLAGS_OFF, type DevFlags } from './devflags';
import { QUALITY_PRESETS } from '../render/quality';
import { ZERO_STATS } from './stats';
import { PALETTE, SKINS, ACCENTS, type HullColorId, type SkinId, type AccentId } from './customization';
import type { AchievementContext, AchievementId } from './achievements';
import { TANK_KINDS } from '../sim/config';
import { CURRENT_ARENA, arenaBounds, createArenaWorld } from '../sim/arena';
import { roundPhase } from '../sim/round';
import {
  TOUCH_SCHEMES,
  FIRE_MODES,
  type TouchIndicator,
  type TouchScheme,
  type FireMode,
} from '../input/touch';
import { COUNTDOWN_TICKS, LIVES, VERSUS_STOCK } from '../sim/constants';
import { createRunStore, DEFAULT_CAMPAIGN_ID, RUN_KEY, type ActiveRun } from './run';
import type { World } from '../sim/world';
import { countPlayerTanks } from '../sim/world';
import type { SimEvent } from '../sim/events';
import type { Tank, Vec2, Bullet, UnarmedTrigger } from '../sim/types';
import type { GameState } from './state';
import {
  isPlayerDeath,
  deathVignetteColor,
  tallyCoopKills,
  playerShellsInFlight,
  startGameWith,
  deriveSeed,
  botSlotsFor,
  createBotSources,
  BOT_SEED_SPACING,
  isMuteHotkey,
  musicIntensity,
  isPauseHotkey,
  DEV_CONSOLE_KEY,
  createBrowserDeps,
  applyVersusToDeps,
  versusAwareDeps,
  type GameDeps,
  type HostWindow,
  type DevConsole,
  type DevConsoleTarget,
} from './loop';
import { versusMapChoices, type VersusConfig } from './versus-config';
import { createMemoryStorage } from './storage';
import { SAVE_KEYS, SAVE_FORMAT, exportSave, type SaveBlob } from './save';
import { decodeTick, replayTrace, checkTrace } from './replay';
import { createWorldFor, ARENA_DEFS, arenaById, CAMPAIGN_LEVELS, type CampaignLevel } from '../sim/arena';
import { createLevelSystem } from './levels';
import type { SlotSource } from '../input/assignment';
import { createGamepadInputSource, type DetectedPad } from '../input/gamepad';
import { SINGLE_PLAYER_DEATH_VIGNETTE } from './hud';
import { IDENTITY_RING_COLORS, TEAM_COLORS } from '../render/entities';

interface Recorder {
  rendererArgs: Array<[unknown, number, number, number, unknown]>;
  screenToGroundArgs: Array<[number, number]>;
  directorPlayerIds: number[];
  directorRebinds: number[];
  hapticsPlayerIds: number[];
  hapticsRebinds: number[];
  hapticsSaw: SimEvent[][];
  /** Every position pushed to haptics.setPlayerPosition, in order -- mirrors lastPlayerPos. */
  hapticsPositions: Array<{ x: number; y: number } | null>;
  /** Every value passed to haptics.setEnabled, in order. */
  hapticsEnabledCalls: boolean[];
  levelBuilds: Array<{ level: number; lives: number | undefined }>;
  hudLevels: Array<[number, number]>;
  seeds: number[];
  worldPolicies: Array<UnarmedTrigger | undefined>;
  renders: Array<{ prev: World; curr: World; alpha: number; events: SimEvent[]; dt: number }>;
  directed: SimEvent[][];
  machineSaw: SimEvent[][];
  lives: number[];
  enemies: number[];
  hudStates: GameState[];
  muted: boolean[];
  shellCounts: Array<{ inFlight: number; cap: number } | null>;
  roundPhases: Array<{ phase: string; secondsLeft: number } | null>;
  deathSignals: number;
  /** Every colour passed to signalPlayerDeath, in order -- death-pulse issue #200. */
  deathColors: number[];
  inputClears: number;
  minePresses: number;
  firePresses: number;
  /** Every scheme pushed to the INPUT controller's setTouchScheme, in order. */
  schemeSets: TouchScheme[];
  /** Every scheme accepted by the STORE (touchSettings.setScheme), in order. */
  schemeStoreSets: TouchScheme[];
  /** Every scheme echoed back to the HUD (hud.setTouchScheme), in order. */
  schemeEchoes: TouchScheme[];
  /** Every mode pushed to the INPUT controller's setFireMode, in order. */
  fireModeSets: FireMode[];
  /** Every mode accepted by the STORE (touchSettings.setFireMode), in order. */
  fireModeStoreSets: FireMode[];
  /** Every mode echoed back to the HUD (hud.setFireMode), in order. */
  fireModeEchoes: FireMode[];
  /** Every value accepted by the STORE (touchSettings.setHaptics), in order. */
  hapticsStoreSets: boolean[];
  /** Every value echoed back to the HUD (hud.setHaptics), in order. */
  hapticsEchoes: boolean[];
  playerPosPushes: number;
  lastPlayerPos: { x: number; y: number } | null;
  touchPushes: TouchIndicator[];
  fireSignals: number;
  cleared: number[];
  progressResets: number;
  statBatches: Array<{ count: number; playerId: number }>;
  statAttemptStarts: number;
  statResets: number;
  statPushes: number;
  /** Every value passed to hud.setCoopKills, in order. */
  coopKillPushes: Array<number[] | null>;
  /** Every value passed to hud.setVersusResults, in order. */
  versusResultsPushes: Array<{ mode: 'ffa' | 'teams'; kills: number[]; deaths: number[] } | null>;
  /** Every value passed to hud.setVersusStocks, in order (Task 6, spec §3a). */
  versusStocksPushes: Array<{ slot: number; stock: number; team?: number }[] | null>;
  /** Every (show, initial) passed to hud.showVersusSetup, in order. */
  versusSetupPushes: Array<{ show: boolean; initial: VersusConfig | null }>;
  /** Every value passed to hud.setSessionKind, in order (Task 5b). */
  sessionKinds: Array<'campaign' | 'versus'>;
  /**
   * A SINGLE shared log of every hud.setState and hud.showVersusSetup call, in the
   * exact order loop.ts made them -- unlike hudStates/versusSetupPushes (each its own
   * array), this is what lets a test tell "setState('title') ran before
   * showVersusSetup(true, ...)" from "the other way round": two separate arrays each
   * preserve their OWN call order but say nothing about the order BETWEEN them.
   * Mirrors audioCalls' own precedent just below for the identical reason.
   */
  hudCallLog: string[];
  levelSelects: Array<[number, number]>;
  /** Every value pushed to hud.setContinueAvailable, in order. */
  continueAvailable: boolean[];
  /** Every level passed to run.startNewRun, in order. */
  runNewRuns: number[];
  /** Every (level, lives) passed to run.advanceLevel, in order. */
  runAdvances: Array<{ level: number; lives: number }>;
  /** Every value passed to run.setLivesRemaining, in order. */
  runLivesSets: number[];
  runEnds: number;
  builtWorlds: World[];
  volumes: number[];
  resizes: Array<[number, number]>;
  refits: Array<[number, number, number]>;
  restyles: Array<{ hex: string | null; skin: string; accent: string | null }>;
  previewCanvasesReceived: HTMLCanvasElement[];
  previewButtonsReceived: ReadonlyArray<readonly HTMLElement[]>;
  previewRestyles: Array<{ hex: string | null; skin: string; accent: string | null }>;
  previewResizes: number;
  hullSets: string[];
  hullEchoes: string[];
  skinSets: string[];
  skinEchoes: string[];
  accentSets: string[];
  accentEchoes: string[];
  toasts: string[][];
  plainToasts: string[];
  achPushes: string[][];
  achChecks: Array<{
    clearedLevel: number | null;
    livesLeft: number;
    highestCleared: number;
    attemptShellKills: number;
  }>;
  achResets: number;
  listeners: Array<[string, (e: never) => void]>;
  removed: Array<[string, (e: never) => void]>;
  disposed: string[];
  musicStarts: number;
  /**
   * Every music call in ORDER, on one log. Three independent counters cannot
   * see sequence: review swapped startMusic and setMusicContext in loop.ts and
   * the whole 1268-test suite stayed green.
   */
  audioCalls: string[];
  musicStops: number;
  musicIntensities: number[];
  musicContexts: string[];
  musicDucks: boolean[];
  unlocks: number;
  samples: number;
  hudRoots: HTMLElement[];
  inputOptions: Array<{ gamepad?: boolean } | null>;
  /** How many times deps.createGamepadSource(padIndex) was called, any slot. */
  gamepadSourceBuilds: number;
  /**
   * The padIndex argument received on each deps.createGamepadSource call, in order --
   * this is what pins `pad[i] -> slot[i]`: loop.ts must call this with the SLOT number
   * it is filling, not always 1 or always 0.
   */
  gamepadSourceBuildIndices: number[];
  /** Every value passed to setPlayerPosition, per slot (keyed by padIndex). */
  slotPositions: Record<number, Array<{ x: number; y: number } | null>>;
  /** How many times sample() was called, per slot (keyed by padIndex). */
  slotSamples: Record<number, number>;
  /** True once dispose() was called, per slot (keyed by padIndex). */
  slotDisposed: Record<number, boolean>;
  /** What each slot's fake gamepadConnected() returns next -- see setSlotGamepadConnected. */
  slotConnectedNext: Record<number, boolean>;
  /** Every value passed to slot 1's setPlayerPosition, in order -- alias of slotPositions[1],
   *  kept so every pre-PR3 test reads unchanged. */
  slot1Positions: Array<{ x: number; y: number } | null>;
  /** How many times slot 1's sample() was called -- alias of slotSamples[1]. */
  slot1Samples: number;
  /** True once slot 1's dispose() was called -- alias of slotDisposed[1]. */
  slot1Disposed: boolean;
  /** Every playerCount passed to deps.levels.world(...), in order. */
  playerCounts: Array<number | undefined>;
  /** Every value passed to hud.setControllers, in order (each a snapshot copy). */
  controllersPushes: SlotSource[][];
  botAllowedPushes: boolean[];
  /** Every value passed to hud.setDetectedPads, in order (each a snapshot copy). */
  detectedPadsPushes: DetectedPad[][];
}

function makeDeps(opts: { world?: World; wallMs?: number; devFlags?: Partial<DevFlags>; levelCount?: number; levelStart?: number; isDevJump?: boolean; staticRoundStart?: boolean; tracksProgress?: boolean; progressHighest?: number; boundsByLevel?: Array<{ width: number; height: number; cellSize: number }>; savedHull?: string; savedSkin?: string; savedAccent?: string; savedScheme?: string; savedFireMode?: string; savedHaptics?: boolean; earnsOn?: Array<{ id: string; when: (c: AchievementContext) => boolean }>; savedAchievements?: string[]; enemiesByLevel?: number[]; previewUnavailable?: boolean; savedKeys?: Record<string, string>; savedRun?: { level: number; lives: number } } = {}): {
  deps: GameDeps;
  rec: Recorder;
  storage: Storage;
  devConsole: DevConsoleTarget;
  previewCanvas: HTMLCanvasElement;
  previewButtons: readonly HTMLButtonElement[];
  fireFrame(now: number): void;
  hasFrame(): boolean;
  hud: {
    mute(): void;
    volume(v: number): void;
    startRestart(): void;
    quitToTitle(): void;
    pauseTap(): void;
    mineTap(): void;
    fireTap(): void;
    toggleScheme(s: TouchScheme): void;
    toggleFireMode(m: FireMode): void;
    toggleHaptics(v: boolean): void;
    pickLevel(i: number): void;
    newGame(): void;
    resetStats(): void;
    resetProgress(): void;
    pickHull(id: HullColorId): void;
    pickSkin(id: SkinId): void;
    pickAccent(id: AccentId): void;
    openCustomize(): void;
    closeCustomize(): void;
    reassignSlot(slot: number, source: SlotSource): void;
    openControllers(): void;
    closeControllers(): void;
    openVersus(): void;
    startVersus(config: VersusConfig): void;
    openCampaign(): void;
  };
  setState(s: GameState): void;
  setTouch(t: TouchIndicator): void;
  firePlayerShot(): void;
  setGamepadConnected(v: boolean): void;
  /** Sets slot `padIndex`'s (>= 1) fake gamepad source's next gamepadConnected() value. */
  setSlotGamepadConnected(padIndex: number, v: boolean): void;
  /** What `deps.readDetectedPads()` returns next -- the controller assignment panel's
   *  live candidate-pad list. */
  setDetectedPadsFixture(pads: DetectedPad[]): void;
  getState(): GameState;
  keydown(e: Partial<KeyboardEvent>): void;
  blur(): void;
  /** Fires the host pointerdown listener -- the splash screen's dismissal path. */
  pointerdown(): void;
  resize(): void;
} {
  const rec: Recorder = {
    rendererArgs: [],
    screenToGroundArgs: [],
    directorPlayerIds: [],
    directorRebinds: [],
    hapticsPlayerIds: [],
    hapticsRebinds: [],
    hapticsSaw: [],
    hapticsPositions: [],
    hapticsEnabledCalls: [],
    levelBuilds: [],
    hudLevels: [],
    seeds: [],
    worldPolicies: [],
    renders: [],
    directed: [],
    machineSaw: [],
    lives: [],
    enemies: [],
    hudStates: [],
    muted: [],
    shellCounts: [],
    roundPhases: [],
    deathSignals: 0,
    deathColors: [],
    inputClears: 0,
    minePresses: 0,
    firePresses: 0,
    schemeSets: [],
    schemeStoreSets: [],
    schemeEchoes: [],
    fireModeSets: [],
    fireModeStoreSets: [],
    fireModeEchoes: [],
    hapticsStoreSets: [],
    hapticsEchoes: [],
    playerPosPushes: 0,
    lastPlayerPos: null,
    touchPushes: [],
    fireSignals: 0,
    cleared: [],
    progressResets: 0,
    statBatches: [],
    statAttemptStarts: 0,
    statResets: 0,
    statPushes: 0,
    coopKillPushes: [],
    versusResultsPushes: [],
    versusStocksPushes: [],
    versusSetupPushes: [],
    sessionKinds: [],
    hudCallLog: [],
    levelSelects: [],
    continueAvailable: [],
    runNewRuns: [],
    runAdvances: [],
    runLivesSets: [],
    runEnds: 0,
    builtWorlds: [],
    volumes: [],
    resizes: [],
    refits: [],
    restyles: [],
    previewCanvasesReceived: [],
    previewButtonsReceived: [],
    previewRestyles: [],
    previewResizes: 0,
    hullSets: [],
    hullEchoes: [],
    skinSets: [],
    skinEchoes: [],
    accentSets: [],
    accentEchoes: [],
    toasts: [],
    plainToasts: [],
    achPushes: [],
    achChecks: [],
    achResets: 0,
    listeners: [],
    removed: [],
    disposed: [],
    musicStarts: 0,
    audioCalls: [],
    musicStops: 0,
    musicIntensities: [],
    musicContexts: [],
    musicDucks: [],
    unlocks: 0,
    samples: 0,
    hudRoots: [],
    inputOptions: [],
    gamepadSourceBuilds: 0,
    gamepadSourceBuildIndices: [],
    slotPositions: {},
    slotSamples: {},
    slotDisposed: {},
    slotConnectedNext: {},
    slot1Positions: [],
    slot1Samples: 0,
    slot1Disposed: false,
    playerCounts: [],
    controllersPushes: [],
    botAllowedPushes: [],
    detectedPadsPushes: [],
  };

  let pending: ((now: number) => void) | null = null;
  let state: GameState = 'splash'; // faithful to state.ts's initial state
  const changeCbs: Array<(s: GameState) => void> = [];
  let onMute = (): void => {};
  let onVolume = (_v: number): void => {};
  let onStartRestart = (): void => {};
  // Faithful shape, and mutable so a test can put a thumb down.
  let touchState: TouchIndicator = { stick: null, aim: null, scheme: 'stick', used: false };
  let fireNext = false;
  let gamepadConnectedNext = false;
  let detectedPadsFixture: DetectedPad[] = [];
  let onQuit = (): void => {};
  let onPauseTap = (): void => {};
  let onMineTap = (): void => {};
  let onFireTap = (): void => {};
  let onTouchSchemeChange = (_s: TouchScheme): void => {};
  let onFireModeChange = (_m: FireMode): void => {};
  let onHapticsChange = (_on: boolean): void => {};
  let onResetStats = (): void => {};
  let onPickHull = (_id: HullColorId): void => {};
  let onPickSkin = (_id: SkinId): void => {};
  let onPickAccent = (_id: AccentId): void => {};
  let onResetProgress = (): void => {};
  let onPickLevel = (_i: number): void => {};
  let onNewGame = (): void => {};
  let onCustomizeOpen = (): void => {};
  let onCustomizeClose = (): void => {};
  let onReassignSlot = (_slot: number, _source: SlotSource): void => {};
  let onControllersOpen = (): void => {};
  let onControllersClose = (): void => {};
  let onVersusOpenCb = (): void => {};
  let onVersusStartCb = (_config: VersusConfig): void => {};
  let onCampaignOpenCb = (): void => {};
  // A real element (not a mock): loop.ts hands it straight to deps.createPreview, so a
  // fake createPreview below can assert it received the SAME element the HUD exposed --
  // catching a wiring bug (passing some OTHER canvas, or none) that a mock would hide.
  const fakePreviewCanvas = document.createElement('canvas');
  // Likewise real elements: loop.ts hands the HUD's own button list to createPreview,
  // and a fake list here would make "it passed the HUD's buttons" untestable.
  const fakePreviewButtons = [document.createElement('button'), document.createElement('button')];
  // The save layer's two seams, both real objects a test can inspect afterwards.
  const storage = createMemoryStorage();
  for (const [k, v] of Object.entries(opts.savedKeys ?? {})) storage.setItem(k, v);
  // A pre-existing active run, written at the RAW storage layer -- like every other
  // `saved*` option -- rather than through `deps.run` once it exists below. `deps.run`
  // is the REAL store DECORATED to record every call into `rec` (see its own comment),
  // so seeding through it would show up as a spurious call the test under test never
  // made -- exactly the trap `startNewRun`/`setLivesRemaining` calls made from test
  // SETUP fell into before this option existed.
  if (opts.savedRun) {
    const seed: ActiveRun = {
      campaignId: DEFAULT_CAMPAIGN_ID,
      currentLevelId: String(opts.savedRun.level),
      livesRemaining: opts.savedRun.lives,
      status: 'active',
    };
    storage.setItem(RUN_KEY, JSON.stringify(seed));
  }
  const devConsole: DevConsoleTarget = {};

  // A small array of INTERNED (built-once, reused-by-reference) synthetic
  // CampaignLevel objects standing in for this session's own `levels` -- the
  // LevelSystem invariant (levels.ts's doc comment) is that `start` and every
  // value `world`/`bounds`/the run are handed is always reference-equal to an
  // element of `levels`, never a freshly-built lookalike. Ids are plain digit
  // strings ('0', '1', ...) so every existing `currentLevelId: '<N>'` fixture and
  // `rec.runNewRuns`/`rec.runAdvances` assertion below keeps meaning exactly what
  // it always did -- a REAL CampaignLevel id is never a bare digit string
  // (validateCampaign rejects one), but this is a hand-built test double, not
  // validated data, and nothing here calls the validator.
  // `Math.max` with (levelStart + 1): the OLD fake's `start` was a raw, UNCLAMPED
  // number independent of `count` (levels.ts's real system clamps; this fake never
  // did), so a test setting `levelStart` past `levelCount - 1` without also raising
  // `levelCount` -- reachable, and at least one test in this file does exactly
  // that -- must still get a real fakeLevels[levelStart] rather than undefined.
  const fakeLevelCount = Math.max(opts.levelCount ?? 1, (opts.levelStart ?? 0) + 1);
  const fakeLevels: CampaignLevel[] = Array.from({ length: fakeLevelCount }, (_, i) => ({
    id: String(i),
    arenaId: ARENA_DEFS[i % ARENA_DEFS.length].id,
  }));

  function emit(): void {
    for (const cb of changeCbs) cb(state);
  }

  const host: HostWindow = {
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener(type: string, fn: (e: never) => void): void {
      rec.listeners.push([type, fn]);
    },
    removeEventListener(type: string, fn: (e: never) => void): void {
      rec.removed.push([type, fn]);
    },
  } as unknown as HostWindow;

  const deps: GameDeps = {
    createRenderer: (canvas, w, h, boundary, options) => {
      rec.rendererArgs.push([canvas, w, h, boundary, options]);
      return {
        render(prev, curr, alpha, events, dt): void {
          rec.renders.push({ prev, curr, alpha, events, dt });
        },
        screenToGround(x, y): Vec2 {
          rec.screenToGroundArgs.push([x, y]);
          return { x, y };
        },
        resize(w2, h2): void {
          rec.resizes.push([w2, h2]);
        },
        refit(w2: number, h2: number, b: number): void {
          rec.refits.push([w2, h2, b]);
        },
        setPlayerStyle(hex: string | null, skin: string, accent: string | null): void {
          rec.restyles.push({ hex, skin, accent });
        },
        dispose(): void {
          rec.disposed.push('renderer');
        },
      };
    },
    createPreview: (canvas, rotateButtons) => {
      rec.previewCanvasesReceived.push(canvas);
      (rec.previewButtonsReceived as Array<readonly HTMLElement[]>).push(rotateButtons);
      if (opts.previewUnavailable) return null; // no spare WebGL context, real code path
      return {
        setStyle(hex: string | null, skin: string, accent: string | null): void {
          rec.previewRestyles.push({ hex, skin, accent });
        },
        resize(): void {
          rec.previewResizes += 1;
        },
        dispose(): void {
          rec.disposed.push('preview');
        },
      };
    },
    createInput: (_target, screenToGround, options) => {
      rec.inputOptions.push(options ?? null);
      return {
      sample() {
        rec.samples += 1;
        // Prove the wiring passes x and y through in that order, not swapped.
        screenToGround(3, 7);
        const fire = fireNext;
        fireNext = false; // latched, exactly as the real controller consumes it
        return { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire, mine: false };
      },
      clearQueuedPresses(): void {
        rec.inputClears += 1;
      },
      touchIndicator: () => touchState,
      pressMine(): void {
        rec.minePresses += 1;
      },
      pressFire(): void {
        rec.firePresses += 1;
      },
      setTouchScheme(sch): void {
        rec.schemeSets.push(sch);
      },
      setFireMode(m): void {
        rec.fireModeSets.push(m);
      },
      setPlayerPosition(pos): void {
        rec.playerPosPushes += 1;
        rec.lastPlayerPos = pos;
      },
      gamepadConnected(): boolean {
        return gamepadConnectedNext;
      },
      dispose(): void {
        rec.disposed.push('input');
      },
      };
    },
    // Every co-player slot's own gamepad source (`pad[i] -> slot[i]`, PR3) -- see
    // GameDeps's own doc comment for why this is a factory rather than an inline
    // default: going through it is what makes "constructed exactly once per slot" and
    // "constructed with the right padIndex" both assertable. Distinct move/aim from
    // slot 0's fake (which never moves: move is always {x:0,y:0}) so a test can tell
    // a co-player tank apart from slot 0's by whether it moved at all, not just by
    // which way. Every slot's fake shares the same move/aim shape -- tests that need
    // to tell TWO co-player slots apart already discriminate by `controlledBy`, the
    // real production key, not by giving each slot's fake a different velocity.
    createGamepadSource: (padIndex: number) => {
      rec.gamepadSourceBuilds += 1;
      rec.gamepadSourceBuildIndices.push(padIndex);
      rec.slotSamples[padIndex] = 0;
      rec.slotPositions[padIndex] = [];
      rec.slotDisposed[padIndex] = false;
      return {
        sample() {
          rec.slotSamples[padIndex] = (rec.slotSamples[padIndex] ?? 0) + 1;
          if (padIndex === 1) rec.slot1Samples += 1;
          return { move: { x: 1, y: 0 }, aim: { x: 2, y: 0 }, fire: false, mine: false };
        },
        setPlayerPosition(pos: { x: number; y: number } | null): void {
          rec.slotPositions[padIndex]!.push(pos);
          if (padIndex === 1) rec.slot1Positions.push(pos);
        },
        gamepadConnected(): boolean {
          return rec.slotConnectedNext[padIndex] ?? false;
        },
        dispose(): void {
          rec.slotDisposed[padIndex] = true;
          if (padIndex === 1) rec.slot1Disposed = true;
        },
      };
    },
    // The controller assignment panel's live pad list -- a plain mutable array a test
    // can push into via `setDetectedPadsFixture` below, mirroring `gamepadConnectedNext`'s
    // own closed-over-mutable convention.
    readDetectedPads: () => detectedPadsFixture,
    createAudio: () => ({
      play: () => {},
      startMusic: () => {
        rec.musicStarts += 1;
        rec.audioCalls.push('start');
      },
      stopMusic: () => {
        rec.musicStops += 1;
      },
      setMuted: () => {},
      toggleMute: () => true,
      isMuted: () => false,
      setVolume: (v: number) => {
        rec.volumes.push(v);
      },
      getVolume: () => 1,
      unlock: () => {
        rec.unlocks += 1;
      },
      setMusicIntensity: (v: number) => {
        rec.musicIntensities.push(v);
      },
      setMusicContext: (c: string) => {
        rec.musicContexts.push(c);
        rec.audioCalls.push(`context:${c}`);
      },
      duckMusic: (d: boolean) => {
        rec.musicDucks.push(d);
        rec.audioCalls.push(`duck:${d}`);
      },
      dispose: () => {
        rec.disposed.push('audio');
      },
    }),
    createDirector: (_engine, playerId) => {
      rec.directorPlayerIds.push(playerId);
      return {
        handle(events): void {
          rec.directed.push(events);
        },
        setPlayerId(id): void {
          rec.directorRebinds.push(id);
        },
      };
    },
    createHaptics: (playerId) => {
      rec.hapticsPlayerIds.push(playerId);
      return {
        handle(events): void {
          rec.hapticsSaw.push(events);
        },
        setPlayerId(id): void {
          rec.hapticsRebinds.push(id);
        },
        setPlayerPosition(pos): void {
          rec.hapticsPositions.push(pos);
        },
        setEnabled(v): void {
          rec.hapticsEnabledCalls.push(v);
        },
      };
    },
    createStateMachine: () => ({
      get state(): GameState {
        return state;
      },
      set state(s: GameState) {
        state = s;
      },
      onEvents(events: SimEvent[]): void {
        rec.machineSaw.push(events);
        // Faithful to state.ts: a win event flips the state SYNCHRONOUSLY inside
        // this call, so every onChange subscriber runs BEFORE the driver reaches
        // onFrameEvents. The fake used to only record, and that divergence hid a
        // real ordering defect -- the win-time achievement check ran before the
        // winning frame's stats were recorded.
        if (state === 'playing' && events.some((e) => e.type === 'win')) {
          state = 'win';
          emit();
        }
      },
      toTitle(): void {
        state = 'title';
        emit();
      },
      // Guarded exactly as state.ts guards it: acts only from 'splash'. An unguarded
      // fake would let a keypress during play "dismiss" a splash that is not showing
      // and emit a spurious change, which is the divergence this file has been bitten
      // by before.
      dismissSplash(): void {
        if (state === 'splash') {
          state = 'title';
          emit();
        }
      },
      startPlaying(): void {
        state = 'playing';
        emit();
      },
      restart(): void {
        state = 'playing';
        emit();
      },
      pause(): void {
        if (state === 'playing') {
          state = 'paused';
          emit();
        }
      },
      resume(): void {
        if (state === 'paused') {
          state = 'playing';
          emit();
        }
      },
      onChange(cb): void {
        changeCbs.push(cb);
      },
    }),
    createHud: (root) => {
      rec.hudRoots.push(root);
      return {
        setLives: (n) => rec.lives.push(n),
        setEnemiesRemaining: (n) => rec.enemies.push(n),
        setState: (s) => {
          rec.hudStates.push(s);
          rec.hudCallLog.push(`state:${s}`);
        },
        setTouchIndicator: (t: TouchIndicator) => rec.touchPushes.push(t),
        setMuted: (m) => rec.muted.push(m),
        setShellCount: (i) => rec.shellCounts.push(i),
        setLevel: (c: number, t: number) => rec.hudLevels.push([c, t]),
        setRoundPhase: (info) => rec.roundPhases.push(info),
        signalPlayerDeath: (color: number) => { rec.deathSignals += 1; rec.deathColors.push(color); },
        signalPlayerFire: () => { rec.fireSignals += 1; },
        onMuteToggle: (cb) => {
          onMute = cb;
        },
        onVolumeChange: (cb) => {
          onVolume = cb;
        },
        onStartRestart: (cb) => {
          onStartRestart = cb;
        },
        onQuitToTitle: (cb: () => void) => {
          onQuit = cb;
        },
        onPauseTap: (cb: () => void) => {
          onPauseTap = cb;
        },
        onMineTap: (cb: () => void) => {
          onMineTap = cb;
        },
        onFireTap: (cb: () => void) => {
          onFireTap = cb;
        },
        setTouchScheme: (s: TouchScheme) => {
          rec.schemeEchoes.push(s);
        },
        onTouchSchemeChange: (cb: (s: TouchScheme) => void) => {
          onTouchSchemeChange = cb;
        },
        setFireMode: (m: FireMode) => {
          rec.fireModeEchoes.push(m);
        },
        onFireModeChange: (cb: (m: FireMode) => void) => {
          onFireModeChange = cb;
        },
        setHaptics: (v: boolean) => {
          rec.hapticsEchoes.push(v);
        },
        onHapticsChange: (cb: (v: boolean) => void) => {
          onHapticsChange = cb;
        },
        setStats: () => {
          rec.statPushes += 1;
        },
        setCoopKills: (counts: number[] | null) => {
          rec.coopKillPushes.push(counts === null ? null : [...counts]);
        },
        setVersusResults: (data: { mode: 'ffa' | 'teams'; kills: number[]; deaths: number[] } | null) => {
          rec.versusResultsPushes.push(data === null ? null : { mode: data.mode, kills: [...data.kills], deaths: [...data.deaths] });
        },
        setVersusStocks: (stocks: { slot: number; stock: number; team?: number }[] | null) => {
          rec.versusStocksPushes.push(stocks === null ? null : stocks.map((s) => ({ ...s })));
        },
        setHullColor: (id: string) => {
          rec.hullEchoes.push(id);
        },
        onPickHullColor: (cb: (id: HullColorId) => void) => {
          onPickHull = cb;
        },
        setSkin: (id: string) => {
          rec.skinEchoes.push(id);
        },
        onPickSkin: (cb: (id: SkinId) => void) => {
          onPickSkin = cb;
        },
        setAccentColor: (id: string) => {
          rec.accentEchoes.push(id);
        },
        onPickAccentColor: (cb: (id: AccentId) => void) => {
          onPickAccent = cb;
        },
        previewCanvas: fakePreviewCanvas,
        previewRotateButtons: fakePreviewButtons,
        onCustomizeOpen: (cb: () => void) => {
          onCustomizeOpen = cb;
        },
        onCustomizeClose: (cb: () => void) => {
          onCustomizeClose = cb;
        },
        setAchievements: (earned: ReadonlySet<string>) => {
          rec.achPushes.push([...earned]);
        },
        showAchievementToasts: (defs: ReadonlyArray<{ id: string }>) => {
          rec.toasts.push(defs.map((d) => d.id));
        },
        showToast: (message: string) => {
          rec.plainToasts.push(message);
        },
        onResetStats: (cb: () => void) => {
          onResetStats = cb;
        },
        onResetProgress: (cb: () => void) => {
          onResetProgress = cb;
        },
        setLevelSelect: (u: number, t: number) => rec.levelSelects.push([u, t]),
        onLevelSelect: (cb: (i: number) => void) => {
          onPickLevel = cb;
        },
        setContinueAvailable: (available: boolean) => {
          rec.continueAvailable.push(available);
        },
        onNewGame: (cb: () => void) => {
          onNewGame = cb;
        },
        onReassignSlot: (cb: (slot: number, source: SlotSource) => void) => {
          onReassignSlot = cb;
        },
        setControllers: (a: SlotSource[]) => {
          rec.controllersPushes.push([...a]);
        },
        setBotAssignmentAllowed: (allowed: boolean) => {
          rec.botAllowedPushes.push(allowed);
        },
        setDetectedPads: (pads: readonly DetectedPad[]) => {
          rec.detectedPadsPushes.push([...pads]);
        },
        onControllersOpen: (cb: () => void) => {
          onControllersOpen = cb;
        },
        onControllersClose: (cb: () => void) => {
          onControllersClose = cb;
        },
        // Task 5's own wiring: loop.ts subscribes both, and calls showVersusSetup
        // itself (on Versus-button open and on a finished versus session's rematch
        // path) -- recorded here the same way onQuitToTitle/onStartRestart's
        // subscriptions are, with this harness's own openVersus/startVersus trigger
        // (below, mirroring openControllers) driving the recorded callback.
        onVersusOpen: (cb: () => void) => {
          onVersusOpenCb = cb;
        },
        onVersusStart: (cb: (config: VersusConfig) => void) => {
          onVersusStartCb = cb;
        },
        showVersusSetup: (show: boolean, initial?: VersusConfig | null) => {
          rec.versusSetupPushes.push({ show, initial: initial ?? null });
          rec.hudCallLog.push(`versusSetup:${show}`);
        },
        // Task 5b: this fake has no real DOM, so it only records what loop.ts pushed --
        // "the button is hidden" can only be asserted against the real hud.ts (hud.test.ts).
        // What IS assertable here: which kind was pushed, and in what order relative to
        // other construction-time calls (rec.hudCallLog, mirroring setState/
        // showVersusSetup's own shared log).
        setSessionKind: (kind: 'campaign' | 'versus') => {
          rec.sessionKinds.push(kind);
          rec.hudCallLog.push(`sessionKind:${kind}`);
        },
        onCampaignOpen: (cb: () => void) => {
          onCampaignOpenCb = cb;
        },
        dispose: () => rec.disposed.push('hud'),
      };
    },
    customization: (() => {
      let hull: HullColorId = (opts.savedHull ?? 'blue') as HullColorId;
      let skin: SkinId = (opts.savedSkin ?? 'solid') as SkinId;
      let accent: AccentId = (opts.savedAccent ?? 'auto') as AccentId;
      // From the REAL palette, skin and accent lists, not duplicate lists that drift.
      const VALID = new Set<string>(PALETTE.map((sw) => sw.id));
      const VALID_SKINS = new Set<string>(SKINS.map((sk) => sk.id));
      const VALID_ACCENTS = new Set<string>(ACCENTS.map((a) => a.id));
      return {
        hull: () => hull,
        setHull: (id: HullColorId) => {
          if (VALID.has(id)) hull = id;
          rec.hullSets.push(id);
        },
        hexFor: (id: HullColorId) => `#hex-${id}`,
        skin: () => skin,
        setSkin: (id: SkinId) => {
          if (VALID_SKINS.has(id)) skin = id;
          rec.skinSets.push(id);
        },
        accent: () => accent,
        setAccent: (id: AccentId) => {
          if (VALID_ACCENTS.has(id)) accent = id;
          rec.accentSets.push(id);
        },
        // Mirrors the real store: null for 'auto', a fake hex for anything else -- so
        // a restyle test can tell "auto propagated" from "a literal accent propagated".
        accentHexFor: (id: AccentId) => (id === 'auto' ? null : `#accent-${id}`),
      };
    })(),
    touchSettings: (() => {
      let scheme: TouchScheme = (opts.savedScheme ?? 'stick') as TouchScheme;
      let fireMode: FireMode = (opts.savedFireMode ?? 'tap') as FireMode;
      let haptics = opts.savedHaptics ?? true;
      // From the REAL scheme/mode lists, not duplicates that could drift.
      const VALID = new Set<string>(TOUCH_SCHEMES);
      const VALID_MODES = new Set<string>(FIRE_MODES);
      return {
        scheme: () => scheme,
        setScheme: (id: TouchScheme) => {
          if (VALID.has(id)) scheme = id;
          rec.schemeStoreSets.push(id);
        },
        fireMode: () => fireMode,
        setFireMode: (id: FireMode) => {
          if (VALID_MODES.has(id)) fireMode = id;
          rec.fireModeStoreSets.push(id);
        },
        haptics: () => haptics,
        setHaptics: (v: boolean) => {
          haptics = v;
          rec.hapticsStoreSets.push(v);
        },
      };
    })(),
    achievements: (() => {
      const earned = new Set<AchievementId>((opts.savedAchievements ?? []) as AchievementId[]);
      return {
        earned: () => earned,
        // Deliberately NOT the real catalog: this harness pins the loop's WIRING
        // (when it evaluates, with what context), and achievements.test.ts pins the
        // catalog. A fake that re-implemented predicates would test itself.
        check: (ctx: AchievementContext) => {
          rec.achChecks.push({
            clearedLevel: ctx.clearedLevel,
            livesLeft: ctx.livesLeft,
            highestCleared: ctx.highestCleared,
            attemptShellKills: ctx.attempt.shellKills,
          });
          const due = (opts.earnsOn ?? []).filter(
            (e) => e.when(ctx) && !earned.has(e.id as AchievementId),
          );
          for (const e of due) earned.add(e.id as AchievementId);
          return due.map((e) => ({
            id: e.id as AchievementId,
            label: e.id,
            description: '',
            earned: () => true,
          }));
        },
        reset: () => {
          earned.clear();
          rec.achResets += 1;
        },
      };
    })(),
    stats: (() => {
      // Accumulating, not a frozen ZERO_STATS literal: a stub that returns fresh
      // zeros every call makes a STALE read indistinguishable from a fresh one,
      // which is exactly how the win-ordering defect stayed invisible.
      let attempt = { ...ZERO_STATS };
      let lifetime = { ...ZERO_STATS };
      const fold = (events: SimEvent[]): void => {
        const kills = events.filter((e) => e.type === 'tank-destroyed').length;
        attempt = { ...attempt, shellKills: attempt.shellKills + kills };
        lifetime = { ...lifetime, shellKills: lifetime.shellKills + kills };
      };
      return {
        lifetime: () => ({ ...lifetime }),
        attempt: () => ({ ...attempt }),
        record: (events: SimEvent[], playerId: number) => {
          rec.statBatches.push({ count: events.length, playerId });
          fold(events);
        },
        startAttempt: () => {
          attempt = { ...ZERO_STATS };
          rec.statAttemptStarts += 1;
        },
        resetLifetime: () => {
          lifetime = { ...ZERO_STATS };
          rec.statResets += 1;
        },
      };
    })(),
    progress: (() => {
      // Mutable base so reset() models the real store: everything re-locks,
      // including clears that predate this session.
      let base = opts.progressHighest ?? 0;
      return {
        highestCleared: () => Math.max(base, ...rec.cleared, 0),
        recordCleared: (level: CampaignLevel) => {
          // 1-based ordinal, matching the real store's highestCleared() shape --
          // `rec.cleared` stays plain numbers, same convention as `rec.levelBuilds`.
          rec.cleared.push(fakeLevels.indexOf(level) + 1);
        },
        reset: () => {
          rec.progressResets += 1;
          rec.cleared.length = 0;
          base = 0;
        },
      };
    })(),
    // The REAL run store over `storage` (also real -- see its own comment below), not
    // a hand-fake: this is exactly the composition CLAUDE.md warns loop.test.ts must
    // pin ("the REAL wiring feeds the run store"), so the store itself has to be real
    // too, or a wiring bug that never calls it could still read back a value that
    // happens to be right. Decorated only to also RECORD each call, the same
    // convention `stats`/`progress` above already follow.
    run: (() => {
      const real = createRunStore(storage);
      return {
        active: () => real.active(),
        startNewRun: (startLevelId: string) => {
          rec.runNewRuns.push(Number(startLevelId));
          return real.startNewRun(startLevelId);
        },
        advanceLevel: (levelId: string, lives: number) => {
          rec.runAdvances.push({ level: Number(levelId), lives });
          real.advanceLevel(levelId, lives);
        },
        setLivesRemaining: (lives: number) => {
          rec.runLivesSets.push(lives);
          real.setLivesRemaining(lives);
        },
        endRun: () => {
          rec.runEnds += 1;
          real.endRun();
        },
      };
    })(),
    levels: {
      // Defaults to a ONE-level sequence: every pre-progression test in this file was
      // written against "restart rebuilds the same arena", which is exactly what a
      // one-level sequence still does. Progression tests opt into more.
      levels: fakeLevels,
      // LIVE, like the real system: an unlock earned mid-session must move the
      // session's start. A fixed opts.levelStart models a dev-flag jump OR a plain
      // resumed run's own position -- opts.isDevJump (default false) says which, and
      // is what loop.ts's campaignActive() reads (see "the active campaign run"
      // below, and levels.test.ts for the real system's own version of this field).
      get start(): CampaignLevel {
        if (opts.levelStart !== undefined) return fakeLevels[opts.levelStart];
        const cleared = Math.max(opts.progressHighest ?? 0, ...rec.cleared, 0);
        return fakeLevels[Math.min(cleared, fakeLevelCount - 1)];
      },
      tracksProgress: opts.tracksProgress ?? true,
      isDevJump: opts.isDevJump ?? false,
      bounds: (level: CampaignLevel) => {
        const i = fakeLevels.indexOf(level);
        // Width/height are world-space (arenaBounds(ARENA_01)); cellSize is DELIBERATELY
        // not ARENA_01.cellSize. While the fake echoed the shipped constant, the
        // "sizes the renderer to the arena" assertion below could not tell "loop.ts
        // passes shownBounds.cellSize through" from "loop.ts hardcodes the constant" --
        // hardcoding it in loop.ts left all 142 tests in this file, levels.test.ts and
        // framing.test.ts passing. An unshipped value makes the assertion discriminate.
        return opts.boundsByLevel?.[i] ?? { width: 22, height: 18, cellSize: 1.5 };
      },
      world: (level, seed, policy, lives, playerCount) => {
        const i = fakeLevels.indexOf(level);
        rec.levelBuilds.push({ level: i, lives });
        // The same reference the loop receives: post-build mutations (invincibility)
        // are visible here.
        rec.seeds.push(seed);
        rec.worldPolicies.push(policy);
        rec.playerCounts.push(playerCount);
        // Co-op: bypass every synthetic-fixture knob below (opts.world, the id shift,
        // enemiesByLevel trimming) and build a REAL arena world instead. Those knobs
        // exist to make single-player fixtures easy to script; co-op's whole claim is
        // that slot i drives the tank with REAL `controlledBy === i`, which only a
        // REAL `loadArena`-produced world can carry (the foundation plan's own spawn
        // alignment, not something this harness can fake convincingly).
        // The REAL-world branch is taken whenever the test needs a world the synthetic
        // fixtures cannot fake: more than one player slot, OR a versus mode (which
        // strips enemies and stamps Tank.team inside loadArena). Review found the
        // playerCount-only condition left `mode` silently dropped at playerCount <= 1
        // -- the same silent-drop shape the versus composition fix closed one layer up,
        // dormant only because no test set mode without players. Including mode here
        // means a `mode: 'ffa'` fixture can never quietly get a campaign-coop world.
        const wantsVersus = (opts.devFlags?.mode ?? 'campaign-coop') !== 'campaign-coop';
        if ((playerCount !== undefined && playerCount > 1) || wantsVersus) {
          const real = createWorldFor(
            // playerCount defaults to 1 when the branch was entered for versus alone.
            arenaById(fakeLevels[i].arenaId), seed, policy, lives, undefined, undefined, playerCount ?? 1,
            // Mirrors levels.ts's own closure: `!flags.coopPool` -- absent/false leaves
            // the shared-attempts default (true), coopPool=1 restores the shipped pool
            // model (false). Read straight off opts.devFlags, the same source the real
            // devFlags merge below is built from, so this cannot drift from what the
            // game itself would have wired.
            !opts.devFlags?.coopPool,
            // n-player arc PR 4 (FFA + teams): mirrors levels.ts's campaign branch
            // (`flags.mode ?? 'campaign-coop'`, `flags.friendlyFire`) so a versus test
            // that sets opts.devFlags.mode gets a REAL FFA/teams world -- enemies
            // actually stripped, Tank.team actually stamped -- rather than a coop world
            // that happens to have the right playerCount. Before this, the fake ignored
            // devFlags.mode entirely: any test passing mode: 'ffa' here would silently
            // get a coop world back.
            opts.devFlags?.mode ?? 'campaign-coop',
            opts.devFlags?.friendlyFire,
          );
          // Back-dated past COUNTDOWN_TICKS, same convention every live-play fixture
          // in this file uses (see winningWorld below): a fresh world cannot act on
          // its first ticks, and a co-op test wants input live immediately.
          const built = { ...real, roundStartTick: -100000 };
          rec.builtWorlds.push(built);
          return built;
        }
        // The real createArenaWorld returns a FRESH world each call, and
        // resetArena moves roundStartTick forward -- so a fixed fixture object
        // would make every round look like the same round to loop.ts. Advance it
        // per call, as a respawn does. staticRoundStart turns that OFF, modelling
        // the level-advance case where two fresh worlds collide on the same tick.
        const base = opts.world ?? createArenaWorld(seed);
        // Each level's player gets a DIFFERENT id, as loadArena's grid-scan numbering
        // really does (16 in ARENA_01, 15 in ARENA_02) -- a fake where every level's
        // player id matches let a stale-id bug pass the rebind test.
        let tanks = i === 0 ? base.tanks
          : base.tanks.map((t) => (t.kind === 'player' ? { ...t, id: t.id + 70 + i } : t));
        // Real arenas differ in enemy count (ARENA_01 has 3, ARENA_03 more), and
        // anything computed from "how many did this round start with" is wrong if
        // the fake keeps every level the same size.
        const want = opts.enemiesByLevel?.[i];
        if (want !== undefined) {
          const player = tanks.filter((t) => t.kind === 'player');
          const foes = tanks.filter((t) => t.kind !== 'player').slice(0, want);
          tanks = [...player, ...foes];
        }
        const built = {
          ...base,
          tanks,
          roundStartTick: base.roundStartTick + (opts.staticRoundStart ? 0 : rec.seeds.length - 1),
        };
        rec.builtWorlds.push(built);
        return built;
      },
    },
    now: () => 0,
    wallMs: () => opts.wallMs ?? 1234567,
    raf: {
      request(cb): number {
        pending = cb;
        return 1;
      },
      cancel(): void {},
    },
    host,
    // A REAL storage (the in-memory one the game itself falls back to), not a
    // mock: the save export/import writes and reads whole strings, and a mock
    // would let a wiring bug that never touches storage look correct.
    storage,
    devConsole,
    devFlags: { ...DEV_FLAGS_OFF, ...opts.devFlags },
  };

  return {
    deps,
    rec,
    storage,
    devConsole,
    previewCanvas: fakePreviewCanvas,
    previewButtons: fakePreviewButtons,
    fireFrame(now): void {
      const cb = pending;
      if (!cb) throw new Error('no frame queued');
      pending = null;
      cb(now);
    },
    hasFrame: () => pending !== null,
    hud: {
      mute: () => onMute(),
      volume: (v) => onVolume(v),
      startRestart: () => onStartRestart(),
      quitToTitle: () => onQuit(),
      pauseTap: () => onPauseTap(),
      mineTap: () => onMineTap(),
      fireTap: () => onFireTap(),
      toggleScheme: (s: TouchScheme) => onTouchSchemeChange(s),
      toggleFireMode: (m: FireMode) => onFireModeChange(m),
      toggleHaptics: (v: boolean) => onHapticsChange(v),
      pickLevel: (i) => onPickLevel(i),
      newGame: () => onNewGame(),
      resetStats: () => onResetStats(),
      pickHull: (id: HullColorId) => onPickHull(id),
      pickSkin: (id: SkinId) => onPickSkin(id),
      pickAccent: (id: AccentId) => onPickAccent(id),
      resetProgress: () => onResetProgress(),
      openCustomize: () => onCustomizeOpen(),
      closeCustomize: () => onCustomizeClose(),
      reassignSlot: (slot: number, source: SlotSource) => onReassignSlot(slot, source),
      openControllers: () => onControllersOpen(),
      closeControllers: () => onControllersClose(),
      openVersus: () => onVersusOpenCb(),
      startVersus: (config: VersusConfig) => onVersusStartCb(config),
      openCampaign: () => onCampaignOpenCb(),
    },
    setState: (s) => {
      state = s;
      emit();
    },
    setTouch: (t: TouchIndicator) => {
      touchState = t;
    },
    firePlayerShot: () => {
      fireNext = true;
    },
    setGamepadConnected: (v: boolean) => {
      gamepadConnectedNext = v;
    },
    setSlotGamepadConnected: (padIndex: number, v: boolean) => {
      rec.slotConnectedNext[padIndex] = v;
    },
    setDetectedPadsFixture: (pads: DetectedPad[]) => {
      detectedPadsFixture = pads;
    },
    getState: () => state,
    blur(): void {
      const entry = rec.listeners.find(([t]) => t === 'blur');
      if (!entry) throw new Error('no blur listener');
      (entry[1] as () => void)();
    },
    keydown(e): void {
      const entry = rec.listeners.find(([t]) => t === 'keydown');
      if (!entry) throw new Error('no keydown listener');
      (entry[1] as (ev: Partial<KeyboardEvent>) => void)(e);
    },
    pointerdown(): void {
      const entry = rec.listeners.find(([t]) => t === 'pointerdown');
      if (!entry) throw new Error('no pointerdown listener');
      (entry[1] as () => void)();
    },
    resize(): void {
      const entry = rec.listeners.find(([t]) => t === 'resize');
      if (!entry) throw new Error('no resize listener');
      (entry[1] as () => void)();
    },
  };
}

/**
 * Boots the game AND leaves the title screen, which is where nearly every test in this
 * file wants to start: `hud.onStartRestart` branches on `sm.state === 'title'`, so a
 * `startRestart()` from the splash screen silently takes the Play-Again/advance branch
 * instead of the menu's Start branch. Both land on 'playing', so the tests still pass
 * while exercising a different path -- review measured 16 `startRestart()` call sites
 * affected, with only 1 of 109 tests failing when the boot state was moved.
 *
 * Use `bootAtSplash()` when the title screen itself is the subject.
 */
function boot(h = makeDeps()): ReturnType<typeof makeDeps> & { handle: { dispose(): void } } {
  const booted = bootAtSplash(h);
  booted.pointerdown(); // splash -> title, the way a player leaves it
  return booted;
}

function bootAtSplash(
  h = makeDeps(),
): ReturnType<typeof makeDeps> & { handle: { dispose(): void } } {
  const canvas = document.createElement('canvas');
  const root = document.createElement('div');
  const handle = startGameWith(canvas, root, h.deps);
  return Object.assign(h, { handle });
}

describe('deriveSeed', () => {
  it('never returns 0, which the PRNG treats as degenerate', () => {
    expect(deriveSeed(0)).toBe(1);
  });

  it('varies with wall-clock time', () => {
    expect(deriveSeed(1000)).not.toBe(deriveSeed(2000));
  });
});

// createIdleInputSource is RETIRED (n-player arc PR3, `pad[i] -> slot[i]`): every
// co-player slot now gets its own createGamepadInputSource(padIndex), whose own
// "no pad ever connected" branch already produces the identical echo-hold behaviour
// this used to hand-build -- see loop.ts's retirement comment at its old definition
// site, and gamepad.ts's module doc comment. That mechanism's tests live in
// gamepad.test.ts ("the no-pad-ever-connected case") and are unchanged by this PR.

describe('isPauseHotkey', () => {
  it('accepts Escape and both cases of P', () => {
    for (const key of ['Escape', 'p', 'P']) {
      expect(isPauseHotkey({ key, repeat: false, target: null } as unknown as KeyboardEvent)).toBe(
        true,
      );
    }
  });

  it('ignores auto-repeat and other keys', () => {
    expect(
      isPauseHotkey({ key: 'Escape', repeat: true, target: null } as unknown as KeyboardEvent),
    ).toBe(false);
    expect(isPauseHotkey({ key: ' ', repeat: false, target: null } as unknown as KeyboardEvent)).toBe(
      false,
    );
  });

  it('ignores keys aimed at a focused control, so Esc cannot yank a slider mid-drag', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(
      isPauseHotkey({ key: 'Escape', repeat: false, target: input } as unknown as KeyboardEvent),
    ).toBe(false);
    input.remove();
  });
});

describe('isMuteHotkey', () => {
  it('accepts a bare M', () => {
    expect(isMuteHotkey({ key: 'm', repeat: false, target: null } as unknown as KeyboardEvent)).toBe(
      true,
    );
  });

  it('ignores auto-repeat, which would toggle ~30x a second', () => {
    expect(isMuteHotkey({ key: 'm', repeat: true, target: null } as unknown as KeyboardEvent)).toBe(
      false,
    );
  });

  it('ignores keys aimed at a focused control', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(
      isMuteHotkey({ key: 'm', repeat: false, target: input } as unknown as KeyboardEvent),
    ).toBe(false);
    input.remove();
  });

  it('ignores other keys', () => {
    expect(isMuteHotkey({ key: 'n', repeat: false, target: null } as unknown as KeyboardEvent)).toBe(
      false,
    );
  });
});

describe('startGameWith: construction', () => {
  it('sizes the renderer to the arena and its boundary ring', () => {
    const h = boot();
    const { width, height } = arenaBounds(CURRENT_ARENA);
    const [, w, ht, boundary] = h.rec.rendererArgs[0];
    expect(w).toBe(width);
    expect(ht).toBe(height);
    // The FAKE's cellSize, which is not CURRENT_ARENA.cellSize -- see the bounds fake.
    expect(boundary).toBe(1.5);
    h.handle.dispose();
  });

  it('gives the director the real player tank id, not the id-0 default', () => {
    // createAudioDirector defaults playerId to 0 and no live tank is id 0, so
    // the default silently mutes the player's own cannon.
    const world = createArenaWorld(1);
    const player = world.tanks.find((t) => t.kind === 'player');
    const h = boot(makeDeps({ world }));
    expect(h.rec.directorPlayerIds[0]).toBe(player?.id);
    expect(h.rec.directorPlayerIds[0]).not.toBe(0);
    h.handle.dispose();
  });

  it('gives haptics the real player tank id too, the same way the director gets it', () => {
    const world = createArenaWorld(1);
    const player = world.tanks.find((t) => t.kind === 'player');
    const h = boot(makeDeps({ world }));
    expect(h.rec.hapticsPlayerIds[0]).toBe(player?.id);
    expect(h.rec.hapticsPlayerIds[0]).not.toBe(0);
    h.handle.dispose();
  });

  it('reads the persisted haptics preference at boot, pushes it to the director, and echoes it to the HUD', () => {
    const on = boot(makeDeps({ savedHaptics: true }));
    expect(on.rec.hapticsEnabledCalls).toEqual([true]);
    expect(on.rec.hapticsEchoes[0]).toBe(true);
    on.handle.dispose();

    const off = boot(makeDeps({ savedHaptics: false }));
    expect(off.rec.hapticsEnabledCalls).toEqual([false]);
    expect(off.rec.hapticsEchoes[0]).toBe(false);
    off.handle.dispose();
  });

  it('seeds the world from wall-clock time, not a constant', () => {
    const a = boot(makeDeps({ wallMs: 1000 }));
    const b = boot(makeDeps({ wallMs: 999000 }));
    expect(a.rec.seeds[0]).not.toBe(b.rec.seeds[0]);
    expect(a.rec.seeds[0]).toBe(deriveSeed(1000));
    a.handle.dispose();
    b.handle.dispose();
  });

  it('builds exactly one world at boot, and hands that one to the loop', () => {
    // Constructing a second world for the driver leaves the HUD, the director's
    // player id and the simulated arena derived from different seeds.
    const h = boot();
    expect(h.rec.seeds).toHaveLength(1);
    h.handle.dispose();
  });

  it('wires screenToGround through to the renderer with x and y in that order', () => {
    const h = boot();
    h.setState('playing');
    h.fireFrame(20);
    expect(h.rec.screenToGroundArgs).toContainEqual([3, 7]);
    h.handle.dispose();
  });

  it('builds the HUD in the ui root it was given', () => {
    const canvas = document.createElement('canvas');
    const root = document.createElement('div');
    const h = makeDeps();
    const handle = startGameWith(canvas, root, h.deps);
    expect(h.rec.hudRoots[0]).toBe(root);
    handle.dispose();
  });
});

describe('startGameWith: HUD wiring', () => {
  it('routes the mute button to the engine and back to the button', () => {
    const h = boot();
    h.hud.mute();
    expect(h.rec.muted).toEqual([true]);
    h.handle.dispose();
  });

  it('routes the volume slider to the engine', () => {
    const h = boot();
    h.hud.volume(0.42);
    expect(h.rec.volumes).toEqual([0.42]);
    h.handle.dispose();
  });

  it('starts playing from the title screen, and unlocks audio on that gesture', () => {
    // The Start click is the only guaranteed user gesture; Safari will not open
    // an AudioContext from anywhere else.
    const h = boot();
    h.hud.startRestart();
    expect(h.rec.unlocks).toBe(1);
    expect(h.rec.hudStates).toContain('playing');
    h.handle.dispose();
  });

  it('rebuilds a fresh world when restarting from a finished game', () => {
    const h = boot();
    h.setState('win');
    const seedsBefore = h.rec.seeds.length;
    h.hud.startRestart();
    expect(h.rec.seeds.length).toBe(seedsBefore + 1);
    h.handle.dispose();
  });

  it('starts the music AT BOOT, on the title screen', () => {
    // This REPLACES "starts the music when, and only when, play begins". The
    // title screen used to be silent -- music existed only during play, so the
    // menu piece was written and never heard. Boot matters specifically because
    // the initial title panel is pushed straight to the HUD without going
    // through the state machine, so hanging the music off onChange alone left
    // this path silent; a browser probe caught it after the unit tests passed.
    const h = bootAtSplash(makeDeps());
    // The exact SEQUENCE, not three independent counters. Review swapped
    // startMusic and setMusicContext in loop.ts and all 1268 tests stayed
    // green; it also doubled the startMusic call and nothing noticed. Both
    // were lost power from the deleted test, which pinned `musicStarts` at
    // exactly 1. (Neither is a live defect -- the engine stores the context
    // whether or not the bed exists yet, and startMusic is idempotent -- but
    // an ordering the tests cannot see is one this repo has been bitten by.)
    expect(h.rec.audioCalls, 'boot left the title screen silent').toEqual([
      'start',
      'context:menu',
      'duck:false',
    ]);

    // Leaving the splash screen repeats the same three calls, and each is a no-op:
    // startMusic builds the bed once and bed.start() returns early once its timer
    // exists, and the engine stores a context it already holds.
    //
    // What is pinned here is the CONTEXT -- still 'menu', not a second suite. Splash
    // and the menu deliberately share one, so arriving at the menu asks for no suite
    // change; a different context here would cut the bed off and start another a beat
    // later, right under the player's first gesture. Give musicContextFor('splash')
    // any other suite and this fails.
    h.pointerdown();
    expect(h.rec.audioCalls.slice(3), 'dismissing the splash changed suite').toEqual([
      'start',
      'context:menu',
      'duck:false',
    ]);
    h.handle.dispose();
  });

  it('BUILDS the music as the arena empties, reaching full on the last tank', () => {
    // The mapping is pure, so it is tested directly rather than by engineering
    // deaths through the sim. Population: a 4-enemy round, every count.
    expect(musicIntensity(4, 4), 'a full arena is the sparsest mix').toBe(0);
    expect(musicIntensity(3, 4)).toBeCloseTo(1 / 3, 9);
    expect(musicIntensity(2, 4)).toBeCloseTo(2 / 3, 9);
    expect(musicIntensity(1, 4), 'the final duel is the fullest mix').toBe(1);
    // Monotonic across every size the arenas use.
    for (const total of [1, 2, 3, 4, 5, 6]) {
      let previous = -1;
      for (let remaining = total; remaining >= 1; remaining--) {
        const v = musicIntensity(remaining, total);
        expect(v, `total ${total}, remaining ${remaining}`).toBeGreaterThanOrEqual(previous);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        previous = v;
      }
    }
    // Degenerate rounds must not divide by zero or go negative.
    expect(musicIntensity(1, 1)).toBe(1);
    expect(musicIntensity(0, 0)).toBe(1);
    expect(musicIntensity(9, 4)).toBe(0); // more alive than started: clamped
  });

  it('re-reads the enemy count when the LEVEL changes, not just at boot', () => {
    // Levels differ in size. Keeping the first level's count as the denominator
    // makes the build wrong for every later level -- on a smaller level the mix
    // would jump to full immediately, on a larger one never arrive.
    const h = boot(
      makeDeps({ levelCount: 2, enemiesByLevel: [3, 2], world: { ...createArenaWorld(1), roundStartTick: -100000 } }),
    );
    h.setState('playing');
    h.fireFrame(20);
    expect(h.rec.musicIntensities.at(-1), 'level 1 starts sparse').toBe(musicIntensity(3, 3));

    h.setState('win');
    h.hud.startRestart(); // advance to level 2, which has 2 enemies
    h.setState('playing');
    h.fireFrame(60);
    // With 2 enemies both alive, intensity is 0 against the CORRECT denominator.
    // Against the stale denominator of 3 it would read 1/2 -- already half built
    // before a shot is fired.
    expect(h.rec.musicIntensities.at(-1), 'level 2 must use its own count').toBe(
      musicIntensity(2, 2),
    );
    h.handle.dispose();
  });

  it('pushes the intensity to the audio engine every simulated frame', () => {
    // The wiring, separately from the mapping: without this the layer gating is
    // inert and the mix runs flat, which is what review found.
    const world = { ...createArenaWorld(1), roundStartTick: -100000 };
    const h = boot(makeDeps({ world }));
    h.setState('playing');
    h.fireFrame(20);
    expect(h.rec.musicIntensities.length).toBeGreaterThan(0);
    const enemies = world.tanks.filter((t) => t.kind !== 'player').length;
    expect(h.rec.musicIntensities.at(-1)).toBe(musicIntensity(enemies, enemies));
    h.handle.dispose();
  });

  it('MOVES the music to the world each state belongs to', () => {
    // The title screen was silent before this: music played only while playing,
    // so the menu piece existed and was never heard in the game.
    const h = boot(makeDeps());
    const seen = (s: GameState): string => {
      h.setState(s);
      return h.rec.musicContexts.at(-1)!;
    };
    expect(seen('title')).toBe('menu');
    expect(seen('playing')).toBe('arena');
    expect(seen('win')).toBe('victory');
    expect(seen('lose')).toBe('defeat');
    // Pause stays in the ARENA world: the round is still there behind the
    // panel, and moving the music would make a pause feel like leaving.
    h.setState('playing');
    expect(seen('paused')).toBe('arena');
    h.handle.dispose();
  });

  it('DUCKS on pause instead of stopping, and unducks on resume', () => {
    // Stopping discards the playlist's committed decisions and leaves the
    // scheduler at an ambiguous position -- both blockers in the suite-wiring
    // review came from that path. Ducking touches only the gain.
    const h = boot(makeDeps());
    h.setState('playing');
    expect(h.rec.musicDucks.at(-1)).toBe(false);
    h.setState('paused');
    expect(h.rec.musicDucks.at(-1), 'pause did not duck').toBe(true);
    h.setState('playing');
    expect(h.rec.musicDucks.at(-1), 'resume did not unduck').toBe(false);
    // And the music was never stopped along the way.
    expect(h.rec.musicStops, 'pause stopped the music instead of ducking').toBe(0);
    h.handle.dispose();
  });

  it('keeps the music running on every screen, not only while playing', () => {
    const h = boot(makeDeps());
    for (const s of ['title', 'playing', 'paused', 'win', 'lose'] as const) h.setState(s);
    expect(h.rec.musicStops).toBe(0);
    expect(h.rec.musicStarts).toBeGreaterThan(0);
    h.handle.dispose();
  });

  it('the bed still cannot outlive the game: dispose tears it down', () => {
    // This REPLACES "stops the music whenever play stops". That property was
    // right when music existed only during play; now every screen has its own
    // context and stopping between them would defeat the handled joins. The
    // concern underneath it -- a bed synthesising forever -- is now dispose's
    // job, so that is what gets pinned.
    const h = boot(makeDeps());
    h.setState('playing');
    h.setState('paused');
    h.setState('title');
    expect(h.rec.musicStops, 'a state change stopped the music').toBe(0);
    h.handle.dispose();
    expect(h.rec.disposed, 'dispose did not tear down the audio engine').toContain('audio');
  });

  it('shows the initial state and stats before any frame runs', () => {
    const h = bootAtSplash();
    // The splash screen, not the menu: the HUD's first push must match the state
    // machine's initial state, and loop.ts pushes it explicitly because that path
    // bypasses sm.onChange.
    expect(h.rec.hudStates[0]).toBe('splash');
    expect(h.rec.lives.length).toBeGreaterThan(0);
    h.handle.dispose();
  });
});

describe('startGameWith: leaving the title screen', () => {
  it('any key dismisses it -- the keyboard half of "Press any key or tap to begin"', () => {
    // Deleting `sm.dismissSplash()` from onKey left the WHOLE suite green: the pointer
    // path had a helper and the keyboard path had nothing, while the on-screen text
    // promises both.
    const h = bootAtSplash();
    expect(h.getState()).toBe('splash');
    h.keydown({ key: 'x', repeat: false, target: null } as Partial<KeyboardEvent>);
    expect(h.getState()).toBe('title');
    h.handle.dispose();
  });

  it('a pointer press dismisses it', () => {
    const h = bootAtSplash();
    h.pointerdown();
    expect(h.getState()).toBe('title');
    h.handle.dispose();
  });

  it('the key that dismisses it does nothing else -- M must not mute the game', () => {
    // "Press any key" includes M, and M is the mute hotkey. Without the early return
    // in onKey, the single key most likely to be pressed by someone checking whether
    // the game has sound silenced the menu bed this screen exists to make audible.
    const h = bootAtSplash();
    h.keydown({ key: 'm', repeat: false, target: null } as Partial<KeyboardEvent>);
    expect(h.getState()).toBe('title');
    expect(h.rec.muted, 'the key that began the game also muted it').toEqual([]);
    h.handle.dispose();
  });

  it('still mutes on M once the game is past the title screen', () => {
    // The other edge: the early return must not swallow the hotkey forever.
    const h = boot(); // already past the splash
    h.keydown({ key: 'm', repeat: false, target: null } as Partial<KeyboardEvent>);
    expect(h.rec.muted).toEqual([true]);
    h.handle.dispose();
  });
});

describe('startGameWith: the touch controls', () => {
  it('drops queued presses on EVERY exit from play, not just pause', () => {
    // The driver stops calling sample() for any state that is not 'playing'
    // (driver.ts), but the window-level pointer listeners keep running. So a gesture
    // completed while a win/lose screen is up latches a shot that sits unconsumed until
    // the first sample() of the NEXT round -- fired at nothing, on a level the player
    // has only just started.
    //
    // Review found this after the 'paused' instance was fixed: same mechanism, same
    // file, one call site short. Your aim thumb is routinely down at the moment you
    // die, so it is not an edge case.
    for (const stopped of ['paused', 'win', 'lose', 'title'] as const) {
      const h = boot();
      h.setState('playing');
      const before = h.rec.inputClears;
      h.setState(stopped);
      expect(
        h.rec.inputClears,
        `leaving play for ${stopped} did not drop queued presses`,
      ).toBeGreaterThan(before);
      h.handle.dispose();
    }
  });


  it('clears the thumb marks when play stops, so none is stranded on screen', () => {
    // The marks are pushed ONLY from onSimulated, which the driver runs only while
    // playing -- so pausing mid-drag would leave a ring on screen with no thumb under
    // it, and quitting to the title would strand it there indefinitely.
    //
    // Review deleted this entire feature from loop.ts and all 117 tests still passed:
    // the recorder below was written to and never read once. That is worse than a weak
    // assertion -- it is plumbing that looks like coverage.
    const h = boot();
    h.setTouch({
      stick: { originX: 90, originY: 500, x: 90, y: 400 },
      aim: { originX: 300, originY: 300, x: 300, y: 300 },
      scheme: 'stick',
      used: true,
    });
    h.setState('playing');
    h.fireFrame(20);
    const held = h.rec.touchPushes.at(-1);
    expect(held?.stick, 'the thumb was not drawn while playing').not.toBeNull();

    for (const stopped of ['paused', 'title', 'win', 'lose'] as const) {
      h.setState(stopped);
      const last = h.rec.touchPushes.at(-1);
      expect(last?.stick, `a driving thumb was stranded on ${stopped}`).toBeNull();
      expect(last?.aim, `an aim mark was stranded on ${stopped}`).toBeNull();
      h.setState('playing');
      h.fireFrame(40);
    }
    h.handle.dispose();
  });


  it("pulses the aim mark on the PLAYER's shot", () => {
    // On a phone the muzzle is under the player's own hand and the shell is gone before
    // the eye gets there, so a tap that fired and a tap that hit the cooldown look
    // identical. Driven by the sim's `fire` event, so it confirms a shot that actually
    // happened rather than a tap that was merely registered.
    const world = { ...createArenaWorld(1), roundStartTick: -1000 };
    const h = boot(makeDeps({ world }));
    h.setState('playing');
    expect(h.rec.fireSignals).toBe(0);

    h.firePlayerShot();
    h.fireFrame(20);
    expect(h.rec.fireSignals, 'the player fired and the mark did not pulse').toBe(1);
    h.handle.dispose();
  });

  it('does NOT pulse when an ENEMY fires', () => {
    // The control, and the reason the check is discriminated by ownerId: the event
    // stream is shared, so `some(e => e.type === 'fire')` pulses on every enemy shot.
    const world = { ...createArenaWorld(1), roundStartTick: -1000 };
    const h = boot(makeDeps({ world }));
    h.setState('playing');

    // Run until an enemy actually fires, so this asserts against a real enemy shot
    // rather than against a frame where nothing happened at all.
    let enemyFired = false;
    for (let i = 1; i <= 600 && !enemyFired; i++) {
      h.fireFrame(i * 17);
      enemyFired = h.rec.directed.some((batch) =>
        batch.some((e) => e.type === 'fire' && e.ownerId !== h.rec.directorPlayerIds.at(-1)),
      );
    }
    expect(enemyFired, 'no enemy fired in 600 frames, so this proves nothing').toBe(true);
    expect(h.rec.fireSignals, 'an enemy shot pulsed the player\'s aim mark').toBe(0);
    h.handle.dispose();
  });



  it('the pause button toggles pause, through the same guards as the hotkey', () => {
    const h = boot();
    h.hud.startRestart(); // into play
    expect(h.getState()).toBe('playing');

    h.hud.pauseTap();
    expect(h.getState()).toBe('paused');
    h.hud.pauseTap();
    // The resume half is DEFENSIVE and unreachable from the current UI: the touch row
    // hides while paused, so a player resumes with the pause panel's own Resume button.
    // Exercised here through the state machine because the guard costs nothing and a
    // future always-visible pause button would rely on it.
    expect(h.getState(), 'the pause toggle is not symmetric').toBe('playing');
    h.handle.dispose();
  });

  it('the pause button cannot reach a state the hotkey cannot', () => {
    // It routes through sm.pause()/resume(), which act only from 'playing'/'paused'.
    // A second path out of a finished game is exactly what this must not become.
    const h = boot();
    for (const state of ['title', 'win', 'lose'] as const) {
      h.setState(state);
      h.hud.pauseTap();
      expect(h.getState(), `pauseTap moved the game out of ${state}`).toBe(state);
    }
    h.handle.dispose();
  });

  it('the mine button latches a mine on the input controller', () => {
    // Through the controller's own latch, NOT a separate path into the sim: that is
    // what makes a tapped mine identical to a keyed one, including being consumed by
    // the next sample() and cleared on pause.
    const h = boot();
    expect(h.rec.minePresses).toBe(0);
    h.hud.mineTap();
    expect(h.rec.minePresses, 'the Mine button did not reach the input controller').toBe(1);
    h.handle.dispose();
  });

  it('the fire button latches a shot on the input controller', () => {
    // Same convention as the Mine button above: through pressFire()'s own latch, not a
    // separate path into the sim.
    const h = boot();
    expect(h.rec.firePresses).toBe(0);
    h.hud.fireTap();
    expect(h.rec.firePresses, 'the Fire button did not reach the input controller').toBe(1);
    h.handle.dispose();
  });
});

describe('startGameWith: the touch aim-scheme wiring', () => {
  it('pushes the SAVED scheme into the input controller and echoes it to the HUD at boot', () => {
    const h = boot(makeDeps({ savedScheme: 'point' }));
    // Pushed once, at construction -- before any frame has been simulated.
    expect(h.rec.schemeSets[0]).toBe('point');
    expect(h.rec.schemeEchoes[0]).toBe('point');
    h.handle.dispose();
  });

  it('defaults to stick when nothing was saved', () => {
    const h = boot(makeDeps());
    expect(h.rec.schemeSets[0]).toBe('stick');
    expect(h.rec.schemeEchoes[0]).toBe('stick');
    h.handle.dispose();
  });

  it('a toggle stores the pick, pushes it into the input controller, and echoes the ACCEPTED value back', () => {
    // Same three-step convention as a hull-colour pick: store, then echo what the store
    // actually accepted -- not blindly the click's own argument.
    const h = boot(makeDeps({ savedScheme: 'stick' }));
    h.hud.toggleScheme('point');
    expect(h.rec.schemeStoreSets).toEqual(['point']);
    expect(h.rec.schemeSets.at(-1), 'the input controller was not told about the switch').toBe(
      'point',
    );
    expect(h.rec.schemeEchoes.at(-1)).toBe('point');
    h.handle.dispose();
  });

  it('an off-list scheme is refused by the store, and the echo says so', () => {
    // The HUD toggle can only ever emit a real TouchScheme, but the handler must not
    // trust that -- mirrors the paint shop's "off-palette pick is refused" test.
    const h = boot(makeDeps({ savedScheme: 'point' }));
    h.hud.toggleScheme('joystick' as never);
    expect(h.rec.schemeEchoes.at(-1), 'the echo did not fall back to the stored value').toBe(
      'point',
    );
    expect(h.rec.schemeSets.at(-1)).toBe('point'); // the input controller was not moved either
    h.handle.dispose();
  });
});

describe('startGameWith: the touch fire-mode wiring', () => {
  it('pushes the SAVED mode into the input controller and echoes it to the HUD at boot', () => {
    const h = boot(makeDeps({ savedFireMode: 'double' }));
    // Pushed once, at construction -- before any frame has been simulated.
    expect(h.rec.fireModeSets[0]).toBe('double');
    expect(h.rec.fireModeEchoes[0]).toBe('double');
    h.handle.dispose();
  });

  it('defaults to tap when nothing was saved', () => {
    const h = boot(makeDeps());
    expect(h.rec.fireModeSets[0]).toBe('tap');
    expect(h.rec.fireModeEchoes[0]).toBe('tap');
    h.handle.dispose();
  });

  it('a toggle stores the pick, pushes it into the input controller, and echoes the ACCEPTED value back', () => {
    // Same three-step convention as the scheme toggle: store, then echo what the store
    // actually accepted -- not blindly the click's own argument.
    const h = boot(makeDeps({ savedFireMode: 'tap' }));
    h.hud.toggleFireMode('double');
    expect(h.rec.fireModeStoreSets).toEqual(['double']);
    expect(
      h.rec.fireModeSets.at(-1),
      'the input controller was not told about the switch',
    ).toBe('double');
    expect(h.rec.fireModeEchoes.at(-1)).toBe('double');
    h.handle.dispose();
  });

  it('an off-list mode is refused by the store, and the echo says so', () => {
    // The HUD toggle can only ever emit a real FireMode, but the handler must not trust
    // that -- mirrors the scheme toggle's "off-list scheme is refused" test.
    const h = boot(makeDeps({ savedFireMode: 'double' }));
    h.hud.toggleFireMode('triple' as never);
    expect(
      h.rec.fireModeEchoes.at(-1),
      'the echo did not fall back to the stored value',
    ).toBe('double');
    expect(h.rec.fireModeSets.at(-1)).toBe('double'); // the input controller was not moved either
    h.handle.dispose();
  });
});

describe('startGameWith: the haptics toggle wiring', () => {
  it('a toggle stores the pick, takes effect on the LIVE director, and echoes the accepted value to the HUD', () => {
    // Same three-step convention as the scheme/fire-mode toggles: store, then echo what
    // the store actually accepted. Unlike scheme/fire-mode there is no input controller
    // half of this -- the second collaborator is the haptics director itself, via
    // setEnabled, which is why this asserts hapticsEnabledCalls rather than an
    // input-controller setter.
    const h = boot(makeDeps({ savedHaptics: true }));
    expect(h.rec.hapticsEnabledCalls).toEqual([true]); // the boot-time read
    h.hud.toggleHaptics(false);
    expect(h.rec.hapticsStoreSets).toEqual([false]);
    expect(
      h.rec.hapticsEnabledCalls.at(-1),
      'the live director was not told about the switch',
    ).toBe(false);
    expect(h.rec.hapticsEchoes.at(-1)).toBe(false);
    h.handle.dispose();
  });
});

describe('startGameWith: the aim stick\'s player-position feed', () => {
  it('pushes the LIVE player tank\'s world position on every simulated frame', () => {
    const world = { ...createArenaWorld(1), roundStartTick: -1000 };
    const h = boot(makeDeps({ world }));
    h.setState('playing');
    expect(h.rec.playerPosPushes).toBe(0);

    h.fireFrame(20);
    const player = world.tanks.find((t) => t.kind === 'player')!;
    expect(h.rec.playerPosPushes, 'setPlayerPosition was not called from onSimulated').toBe(1);
    // Position, not identity -- a defect that passed a stale or zeroed struct through
    // would fail here even though "some object" was pushed.
    expect(h.rec.lastPlayerPos).toEqual({ x: player.pos.x, y: player.pos.y });
    h.handle.dispose();
  });

  it('pushes null when the built world has no player tank', () => {
    // The stick still needs to hold its last aim rather than throw when a world is
    // ever built without one -- setPlayerPosition's own contract for `null`.
    const world = {
      ...createArenaWorld(1),
      roundStartTick: -1000,
      tanks: createArenaWorld(1).tanks.filter((t) => t.kind !== 'player'),
    };
    const h = boot(makeDeps({ world }));
    h.setState('playing');
    h.fireFrame(20);
    expect(h.rec.playerPosPushes).toBeGreaterThan(0);
    expect(h.rec.lastPlayerPos, 'a world with no player pushed a stale position').toBeNull();
    h.handle.dispose();
  });

  it('feeds haptics the SAME position, on the same frame -- the mine-detonate cue needs it', () => {
    // haptics.ts cannot see the player's position from the event stream (mine-detonate
    // carries only the mine's own pos), so loop.ts must push it the same way it pushes
    // the aim stick's feed. A loop that fed haptics a stale or absent position would
    // still pass every test above.
    const world = { ...createArenaWorld(1), roundStartTick: -1000 };
    const h = boot(makeDeps({ world }));
    h.setState('playing');
    h.fireFrame(20);
    const player = world.tanks.find((t) => t.kind === 'player')!;
    expect(h.rec.hapticsPositions.at(-1)).toEqual({ x: player.pos.x, y: player.pos.y });
    h.handle.dispose();
  });

  it('keeps pushing on every subsequent frame, not just the first', () => {
    const world = { ...createArenaWorld(1), roundStartTick: -1000 };
    const h = boot(makeDeps({ world }));
    h.setState('playing');
    h.fireFrame(20);
    h.fireFrame(40);
    h.fireFrame(60);
    expect(h.rec.playerPosPushes).toBe(3);
    h.handle.dispose();
  });
});

describe('startGameWith: listeners and teardown', () => {
  it('registers keydown, resize, blur and pointerdown, and sizes the canvas once at boot', () => {
    const h = boot();
    expect(h.rec.listeners.map(([t]) => t).sort()).toEqual([
      'blur',
      'keydown',
      'pointerdown', // dismisses the splash screen; see the audio-unlock note in loop.ts
      'resize',
    ]);
    expect(h.rec.resizes).toEqual([[1024, 768]]);
    h.handle.dispose();
  });

  it('resizes the renderer to the host viewport on a resize event', () => {
    const h = boot();
    h.resize();
    expect(h.rec.resizes[h.rec.resizes.length - 1]).toEqual([1024, 768]);
    h.handle.dispose();
  });

  it('toggles mute on M through the registered listener', () => {
    const h = boot();
    h.keydown({ key: 'm', repeat: false, target: null });
    expect(h.rec.muted).toEqual([true]);
    h.handle.dispose();
  });

  it('does not toggle mute on auto-repeat', () => {
    const h = boot();
    h.keydown({ key: 'm', repeat: true, target: null });
    expect(h.rec.muted).toEqual([]);
    h.handle.dispose();
  });

  it('removes exactly the listeners it added, by identity', () => {
    const h = boot();
    h.handle.dispose();
    // The TYPES as a set, not just a count with an each-was-added check: review showed
    // that form passes when one type is removed twice and another never at all, which
    // is exactly how the new pointerdown listener would have leaked unnoticed.
    expect(h.rec.removed.map(([t]) => t).sort()).toEqual([
      'blur',
      'keydown',
      'pointerdown',
      'resize',
    ]);
    for (const [type, fn] of h.rec.removed) {
      expect(h.rec.listeners).toContainEqual([type, fn]);
    }
  });

  it('disposes every collaborator it constructed', () => {
    const h = boot();
    h.handle.dispose();
    expect(h.rec.disposed.sort()).toEqual(['audio', 'hud', 'input', 'renderer']);
  });

  it('stops the frame loop, so a queued callback cannot advance the world', () => {
    const h = boot();
    h.setState('playing');
    h.fireFrame(20);
    const rendersBefore = h.rec.renders.length;
    h.handle.dispose();
    // The driver's own guard is what makes this safe; here we only prove the
    // handle actually reaches it.
    expect(h.hasFrame()).toBe(true);
    h.fireFrame(40);
    expect(h.rec.renders.length).toBe(rendersBefore);
  });
});

// ---------------------------------------------------------------------------
// The seam the refactor CREATES. driver.test.ts injects fake hooks, so it can
// prove the driver calls its hooks but NOT that loop.ts wires the real
// collaborators into them. Every assertion below pumps a frame through the
// REAL startGameWith. Without these, inverting the play gate, dropping audio
// routing, emptying the render call or freezing the HUD all pass the gate.
// ---------------------------------------------------------------------------

describe('startGameWith: composition (a real frame, pumped)', () => {
  it('simulates only while playing, and renders either way', () => {
    const h = boot();
    h.fireFrame(100); // still on the title screen
    expect(h.rec.renders).toHaveLength(1);
    expect(h.rec.renders[0].curr.tick).toBe(0);

    h.setState('playing');
    h.fireFrame(200);
    expect(h.rec.renders).toHaveLength(2);
    expect(h.rec.renders[1].curr.tick).toBeGreaterThan(0);
    h.handle.dispose();
  });

  it('draws from the previous pose to the current one, in that order', () => {
    const h = boot();
    h.setState('playing');
    h.fireFrame(20);
    const r = h.rec.renders[h.rec.renders.length - 1];
    expect(r.prev.tick).toBeLessThan(r.curr.tick);
    h.handle.dispose();
  });

  it('samples the real input controller once per simulated tick', () => {
    const h = boot();
    h.setState('playing');
    h.fireFrame(100); // 6 ticks
    expect(h.rec.samples).toBe(6);
    h.handle.dispose();
  });

  it('refreshes the HUD stats from the live world as the game runs', () => {
    const h = boot();
    const before = h.rec.lives.length;
    h.setState('playing');
    h.fireFrame(20);
    expect(h.rec.lives.length).toBeGreaterThan(before);
    h.handle.dispose();
  });

  it('routes the events a real tick produced to the director, haptics AND the machine', () => {
    // Back-date the round so the player is past countdown+grace and can fire.
    const world = { ...createArenaWorld(1), roundStartTick: -1000 };
    const h = boot(makeDeps({ world }));
    h.setState('playing');
    // Several frames: AI tanks act, so events appear without needing the player
    // to fire through the fake input. 30, not 12: tank ids now come from spawn
    // order alone (arena.ts no longer shares a counter with walls), which reseeds
    // every AI's per-tank RNG streams (ai/targeting.ts) and pushed ARENA_01's
    // first AI shot at this seed from tick ~35 to tick ~95 -- 12 frames (~72
    // ticks) stopped reaching a shot at all.
    for (let i = 1; i <= 30; i++) h.fireFrame(i * 100);
    expect(h.rec.directed.length).toBeGreaterThan(0);
    expect(h.rec.machineSaw.length).toBe(h.rec.directed.length);
    expect(h.rec.directed.flat().length).toBe(h.rec.machineSaw.flat().length);
    expect(h.rec.hapticsSaw.length).toBe(h.rec.directed.length);
    expect(h.rec.hapticsSaw.flat().length).toBe(h.rec.directed.flat().length);
    h.handle.dispose();
  });
});

describe('isPlayerDeath', () => {
  // Distinct tankIds per case, deliberately -- the whole point of the id-based fix
  // (loop.ts) is that `kind === 'player'` alone can no longer tell "the TRACKED
  // player died" apart from "some OTHER player-kind tank died" once a second
  // human-driven tank exists. A shared tankId (as this fixture used to hardcode,
  // regardless of kind) cannot exercise that distinction at all.
  const TRACKED_PLAYER_ID = 1;
  const OTHER_PLAYER_ID = 2;

  const destroyed = (kind: string, tankId: number): SimEvent =>
    ({ type: 'tank-destroyed', tankId, kind, pos: { x: 0, y: 0 } }) as SimEvent;

  it('is true when the TRACKED player\'s own tankId dies', () => {
    expect(isPlayerDeath([destroyed('player', TRACKED_PLAYER_ID)], TRACKED_PLAYER_ID)).toBe(true);
  });

  it('is FALSE for every enemy kind, each at its OWN distinct (non-tracked) id', () => {
    // The whole point: the stream is shared, so a presence-only check would
    // flash the screen red every time the player scored a kill. Real tank ids
    // are unique across the world (arena.ts), so a realistic enemy death never
    // carries the tracked player's own id -- this fixture matches that.
    // Population: DERIVED -- every non-player kind in the canonical TANK_KINDS,
    // so a new enemy kind is swept the moment it exists (review: this was a
    // hand-kept list of three whose "all" claim silently went stale).
    TANK_KINDS.filter((k) => k !== 'player').forEach((kind, i) => {
      const enemyId = 100 + i; // distinct from TRACKED_PLAYER_ID and from each other
      expect(isPlayerDeath([destroyed(kind, enemyId)], TRACKED_PLAYER_ID)).toBe(false);
    });
  });

  it('is FALSE for a player-KIND tank whose id is not the tracked player -- ' +
    'the actual point of keying on tankId instead of kind', () => {
    // Unreached by any runtime call site today (no path sets playerCount > 1 yet),
    // but this is exactly the co-op case the fix exists for: a second player-kind
    // tank (controlledBy: 1) dying must not read as the tracked player dying.
    expect(isPlayerDeath([destroyed('player', OTHER_PLAYER_ID)], TRACKED_PLAYER_ID)).toBe(false);
  });

  it('finds the tracked player among a mixed frame', () => {
    expect(
      isPlayerDeath(
        [destroyed('brown', 3), destroyed('player', TRACKED_PLAYER_ID), destroyed('teal', 4)],
        TRACKED_PLAYER_ID,
      ),
    ).toBe(true);
  });

  it('is false for a frame with no deaths at all', () => {
    expect(
      isPlayerDeath([{ type: 'ricochet', pos: { x: 0, y: 0 }, bounceIndex: 0 } as SimEvent], TRACKED_PLAYER_ID),
    ).toBe(false);
    expect(isPlayerDeath([], TRACKED_PLAYER_ID)).toBe(false);
  });
});

describe('deathVignetteColor', () => {
  // Same mkTank shape tallyCoopKills' own tests use just below.
  const mkTank = (id: number, kind: string, controlledBy?: number, team?: number): Tank =>
    ({ id, kind, controlledBy, team }) as Tank;

  it('is the classic red at playerCount 1, unconditionally -- even if the tank has a slot', () => {
    // playerCount 1 short-circuits before the tank is even looked up: single-player
    // behaviour must not move regardless of what controlledBy happens to hold.
    const world = { mode: 'campaign-coop', tanks: [mkTank(1, 'player', 0)] } as World;
    expect(deathVignetteColor(world, 1, 1)).toBe(SINGLE_PLAYER_DEATH_VIGNETTE);
  });

  it('is the dying tank\'s own identity-ring colour at playerCount >= 2, by controlledBy', () => {
    const world = {
      mode: 'campaign-coop',
      tanks: [mkTank(1, 'player', 0), mkTank(2, 'player', 1)],
    } as World;
    // Derived from the exported palette, not a copied-out literal -- so retuning
    // IDENTITY_RING_COLORS cannot silently desync this assertion from it.
    expect(deathVignetteColor(world, 1, 2)).toBe(IDENTITY_RING_COLORS[0]);
    expect(deathVignetteColor(world, 2, 2)).toBe(IDENTITY_RING_COLORS[1]);
  });

  it('is the dying tank\'s TEAM colour in teams mode, not its identity-ring colour', () => {
    const world = {
      mode: 'teams',
      tanks: [mkTank(1, 'player', 0, 0), mkTank(2, 'player', 1, 1)],
    } as World;
    expect(deathVignetteColor(world, 1, 2)).toBe(TEAM_COLORS[0]);
    expect(deathVignetteColor(world, 2, 2)).toBe(TEAM_COLORS[1]);
    // Distinct from the identity-ring answer for the same slot -- otherwise this test
    // could pass even if the mode dispatch were wired backwards.
    expect(deathVignetteColor(world, 2, 2)).not.toBe(IDENTITY_RING_COLORS[1]);
  });

  it('falls back to the classic red if the tankId cannot be found in world.tanks', () => {
    const world = { mode: 'campaign-coop', tanks: [mkTank(1, 'player', 0)] } as World;
    expect(deathVignetteColor(world, 99, 2)).toBe(SINGLE_PLAYER_DEATH_VIGNETTE);
  });

  it('treats a missing controlledBy as slot 0, mirroring the render seam\'s own convention', () => {
    const world = { mode: 'campaign-coop', tanks: [mkTank(1, 'player', undefined)] } as World;
    expect(deathVignetteColor(world, 1, 2)).toBe(IDENTITY_RING_COLORS[0]);
  });
});

describe('tallyCoopKills', () => {
  const mkTank = (id: number, kind: string, controlledBy?: number): Tank =>
    ({ id, kind, controlledBy }) as Tank;

  const destroyedEnemy = (tankId: number, killedByOwnerId: number): SimEvent =>
    ({ type: 'tank-destroyed', tankId, kind: 'brown', by: { source: 'shell', ownerId: killedByOwnerId }, pos: { x: 0, y: 0 } }) as SimEvent;

  const twoPlayerWorld = () =>
    ({ tanks: [mkTank(1, 'player', 0), mkTank(2, 'player', 1), mkTank(3, 'brown'), mkTank(4, 'teal')] }) as World;

  it('an enemy killed by P2\'s shell increments coopKills[1], not coopKills[0]', () => {
    const into: number[] = [];
    tallyCoopKills([destroyedEnemy(3, 2)], twoPlayerWorld(), into, []); // by tankId 2 = P2 (controlledBy 1)
    expect(into[0]).toBeUndefined();
    expect(into[1]).toBe(1);
  });

  it('a MINE kill credits its owner\'s slot too -- by.source is irrelevant to attribution', () => {
    // Review probed this correct (tallyCoopKills reads only by.ownerId) but every
    // shipped case was shell-shaped; this pins the blast path so a future
    // source-discriminating refactor cannot silently drop mine kills from the tally.
    const into: number[] = [];
    const mineKill = { type: 'tank-destroyed', tankId: 3, kind: 'brown', by: { source: 'blast', ownerId: 2 }, pos: { x: 0, y: 0 } } as SimEvent;
    tallyCoopKills([mineKill], twoPlayerWorld(), into, []);
    expect(into[1]).toBe(1); // P2's mine, P2's kill
    expect(into[0]).toBeUndefined();
  });

  it('an enemy killed by P1\'s shell increments coopKills[0], not coopKills[1]', () => {
    const into: number[] = [];
    tallyCoopKills([destroyedEnemy(3, 1)], twoPlayerWorld(), into, []); // by tankId 1 = P1 (controlledBy 0)
    expect(into[0]).toBe(1);
    expect(into[1]).toBeUndefined();
  });

  it('AI-on-AI friendly fire (an enemy killing another enemy) increments neither slot', () => {
    const into: number[] = [];
    tallyCoopKills([destroyedEnemy(3, 4)], twoPlayerWorld(), into, []); // killer tankId 4 = teal, not a player
    expect(into[0]).toBeUndefined();
    expect(into[1]).toBeUndefined();
  });

  it('a player-kind death (e.kind === player) is excluded entirely, even if by.ownerId resolves to a player', () => {
    const playerDied: SimEvent = { type: 'tank-destroyed', tankId: 1, kind: 'player', by: { source: 'shell', ownerId: 2 }, pos: { x: 0, y: 0 } };
    const into: number[] = [];
    tallyCoopKills([playerDied], twoPlayerWorld(), into, []);
    expect(into[0]).toBeUndefined();
    expect(into[1]).toBeUndefined();
  });

  it('accumulates across multiple events in one batch, mixing attributed and excluded kills', () => {
    const into: number[] = [];
    tallyCoopKills(
      [destroyedEnemy(3, 1), destroyedEnemy(4, 2), destroyedEnemy(3, 4) /* friendly fire, excluded */],
      { tanks: [mkTank(1, 'player', 0), mkTank(2, 'player', 1), mkTank(3, 'brown'), mkTank(4, 'teal')] } as World,
      into,
      [],
    );
    expect(into[0]).toBe(1);
    expect(into[1]).toBe(1);
  });

  it('a single-player world (no controlledBy) falls back to slot 0', () => {
    const into: number[] = [];
    const world = { tanks: [mkTank(1, 'player'), mkTank(3, 'brown')] } as World;
    tallyCoopKills([destroyedEnemy(3, 1)], world, into, []);
    expect(into[0]).toBe(1);
  });
});

describe('tallyCoopKills: ffa/teams player-vs-player attribution (n-player arc PR 4)', () => {
  const mkTank = (id: number, kind: string, controlledBy?: number): Tank =>
    ({ id, kind, controlledBy }) as Tank;

  const versusWorld = (mode: 'ffa' | 'teams') =>
    ({
      mode,
      tanks: [mkTank(1, 'player', 0), mkTank(2, 'player', 1), mkTank(3, 'player', 2)],
    }) as World;

  const playerDestroyed = (victimTankId: number, killerOwnerId: number): SimEvent =>
    ({ type: 'tank-destroyed', tankId: victimTankId, kind: 'player', by: { source: 'shell', ownerId: killerOwnerId }, pos: { x: 0, y: 0 } }) as SimEvent;

  for (const mode of ['ffa', 'teams'] as const) {
    it(`${mode}: P2's shell killing P1 credits kills[1] and deaths[0]`, () => {
      const kills: number[] = [];
      const deaths: number[] = [];
      tallyCoopKills([playerDestroyed(1, 2)], versusWorld(mode), kills, deaths); // victim tankId 1 (P1), killer tankId 2 (P2)
      expect(kills[1]).toBe(1);
      expect(kills[0]).toBeUndefined();
      expect(deaths[0]).toBe(1);
      expect(deaths[1]).toBeUndefined();
    });

    it(`${mode}: self-elimination (killer id === victim id) credits a death to the victim's slot and a kill to NOBODY`, () => {
      const kills: number[] = [];
      const deaths: number[] = [];
      tallyCoopKills([playerDestroyed(1, 1)], versusWorld(mode), kills, deaths); // P1's own shell/mine kills P1
      expect(kills).toEqual([]); // no slot credited a kill
      expect(deaths[0]).toBe(1);
    });

    it(`${mode}: accumulates across multiple events, mixing a normal kill and a self-elimination`, () => {
      const kills: number[] = [];
      const deaths: number[] = [];
      tallyCoopKills(
        [playerDestroyed(1, 2) /* P2 kills P1 */, playerDestroyed(3, 3) /* P3 self-eliminates */],
        versusWorld(mode),
        kills,
        deaths,
      );
      expect(kills[1]).toBe(1);
      expect(kills[2]).toBeUndefined();
      expect(deaths[0]).toBe(1);
      expect(deaths[2]).toBe(1);
    });
  }

  it('campaign-coop ignores player-vs-player deaths entirely -- the dispatch does not leak the new rule into the old mode', () => {
    const kills: number[] = [];
    const deaths: number[] = [];
    const coopWorld = { mode: 'campaign-coop', tanks: [mkTank(1, 'player', 0), mkTank(2, 'player', 1)] } as World;
    tallyCoopKills([playerDestroyed(1, 2)], coopWorld, kills, deaths);
    expect(kills).toEqual([]);
    expect(deaths).toEqual([]);
  });
});

describe('startGameWith: a real player death reaches the HUD', () => {
  it('flashes the HUD when the player is actually killed in a driven frame', () => {
    // The predicate and the flash are tested separately; this is the seam
    // BETWEEN them, which two mutations survived without it -- emptying loop's
    // handler, and dropping the driver's call to it, both passed everything
    // else. Built by putting a live enemy shell on top of the player and
    // pumping one real frame, so the death comes from the real sim.
    const base = createArenaWorld(1);
    const player = base.tanks.find((t) => t.kind === 'player');
    if (!player) throw new Error('fixture has no player');
    const enemy = base.tanks.find((t) => t.kind !== 'player');
    if (!enemy) throw new Error('fixture has no enemy');
    const world = {
      ...base,
      roundStartTick: -1000, // past countdown+grace so nothing is gated
      bullets: [
        {
          id: 900,
          ownerId: enemy.id,
          type: 'normal' as const,
          pos: { x: player.pos.x, y: player.pos.y },
          vel: { x: 1, y: 0 },
          bouncesLeft: 1,
          alive: true,
        },
      ],
    };
    const h = boot(makeDeps({ world }));
    h.setState('playing');
    expect(h.rec.deathSignals).toBe(0);
    h.fireFrame(20);
    expect(h.rec.deathSignals).toBe(1);
    // Single-player (the default playerCount here): the classic red, derived from the
    // exported constant rather than a copied-out literal -- makeDeps passes no `players`
    // devFlag, so this is the playerCount-1 branch deathVignetteColor's own tests cover
    // directly below.
    expect(h.rec.deathColors).toEqual([SINGLE_PLAYER_DEATH_VIGNETTE]);
    h.handle.dispose();
  });

  it('does NOT flash when an enemy dies', () => {
    // The control. A presence-only check would flash on every kill the player
    // scores, which is the opposite of the signal intended.
    const base = createArenaWorld(1);
    const enemy = base.tanks.find((t) => t.kind !== 'player');
    const other = base.tanks.filter((t) => t.kind !== 'player')[1];
    if (!enemy || !other) throw new Error('fixture needs two enemies');
    const world = {
      ...base,
      roundStartTick: -1000,
      bullets: [
        {
          id: 901,
          ownerId: other.id,
          type: 'normal' as const,
          pos: { x: enemy.pos.x, y: enemy.pos.y },
          vel: { x: 1, y: 0 },
          bouncesLeft: 1,
          alive: true,
        },
      ],
    };
    const h = boot(makeDeps({ world }));
    h.setState('playing');
    h.fireFrame(20);
    expect(h.rec.deathSignals).toBe(0);
    h.handle.dispose();
  });
});

/**
 * A world where the player is one real driven frame from death: a live enemy shell
 * sits exactly on the player's position, roundStartTick pushed into the deep past so
 * nothing is gated. Same construction as the death-signal fixtures above -- factored
 * out here because the run tests below need several of them.
 */
function worldWithPlayerAboutToDie(): World {
  const base = createArenaWorld(1);
  const player = base.tanks.find((t) => t.kind === 'player');
  if (!player) throw new Error('fixture has no player');
  const enemy = base.tanks.find((t) => t.kind !== 'player');
  if (!enemy) throw new Error('fixture has no enemy');
  return {
    ...base,
    roundStartTick: -1000,
    bullets: [
      {
        id: 900,
        ownerId: enemy.id,
        type: 'normal' as const,
        pos: { x: player.pos.x, y: player.pos.y },
        vel: { x: 1, y: 0 },
        bouncesLeft: 1,
        alive: true,
      },
    ],
  };
}

/**
 * The active campaign run (issues #153 and #152, spec:
 * docs/superpowers/specs/2026-08-11-campaign-run-model.md). `deps.run` here is the
 * REAL run.ts store over the REAL (in-memory) `storage` -- not a hand-fake -- so
 * these tests pin the COMPOSITION: that loop.ts's wiring actually calls the real
 * store with the right arguments at the right moments, the blindness CLAUDE.md
 * warns a unit-level test (run.test.ts) cannot see on its own.
 */
describe('startGameWith: the active campaign run (issues #153/#152)', () => {
  describe('death persistence -- the #152 fix', () => {
    it('persists a lost life to the run store the instant it happens, before any click', () => {
      const world = worldWithPlayerAboutToDie();
      const h = boot(makeDeps({ world, savedRun: { level: 0, lives: LIVES } }));
      h.setState('playing');
      expect(h.deps.run.active()?.livesRemaining).toBe(LIVES);
      h.fireFrame(20);
      expect(h.rec.runLivesSets).toEqual([LIVES - 1]);
      expect(h.deps.run.active()?.livesRemaining).toBe(LIVES - 1);
      h.handle.dispose();
    });

    it('#152 repro: lose a life, "refresh" the page, the reduced count survives', () => {
      // The issue's own 4-step repro: start a run at the campaign's 3 lives, lose 1 in
      // level 1 (2 left), refresh. Campaign progress was already preserved before this
      // fix; the life counter was the part that came back to 3. It must not.
      const world = worldWithPlayerAboutToDie();
      const h = boot(makeDeps({ world, savedRun: { level: 0, lives: LIVES } }));
      h.setState('playing');
      h.fireFrame(20);
      expect(h.deps.run.active()?.livesRemaining).toBe(LIVES - 1);
      h.handle.dispose();

      // "Refresh": a brand NEW session, seeded from the same WIRE BYTES the first
      // session actually wrote -- not the same object reference, a copy of exactly
      // what a real page reload would read back out of localStorage.
      const runBlob = h.storage.getItem(RUN_KEY);
      expect(runBlob).not.toBeNull();
      const h2 = boot(makeDeps({ savedKeys: { [RUN_KEY]: runBlob! } }));
      expect(h2.deps.run.active()?.livesRemaining, 'refresh must not restore lost lives').toBe(
        LIVES - 1,
      );
      // And the reconstructed BOOT actually builds the world with that count -- the
      // composition point, not merely "the store remembers if asked".
      expect(h2.rec.levelBuilds[0]).toEqual({ level: 0, lives: LIVES - 1 });
      h2.handle.dispose();
    });

    it('still calls the store with no run active, which safely no-ops (run.ts is the guard, not loop.ts)', () => {
      const world = worldWithPlayerAboutToDie();
      const h = boot(makeDeps({ world })); // no run ever started
      h.setState('playing');
      h.fireFrame(20);
      expect(h.rec.runLivesSets).toEqual([LIVES - 1]); // the call happened
      expect(h.deps.run.active()).toBeNull(); // and the real store correctly ignored it
      h.handle.dispose();
    });
  });

  describe('practice isolation -- Level Select must never touch the run', () => {
    it('a life lost in practice never reaches the run store', () => {
      const world = worldWithPlayerAboutToDie();
      const h = boot(makeDeps({ levelCount: 2, world, savedRun: { level: 0, lives: 2 } }));
      h.hud.pickLevel(1); // enters PRACTICE on level 2 -- independent, fresh lives
      h.setState('playing');
      h.fireFrame(20); // the PRACTICE player dies
      expect(h.rec.deathSignals).toBe(1); // the death really happened
      expect(h.rec.runLivesSets).toEqual([]); // and never reached the run store
      expect(h.deps.run.active()?.livesRemaining, 'practice must not touch the run').toBe(2);
      h.handle.dispose();
    });

    it('a practice win cannot advance, replace or complete the run', () => {
      const h = boot(makeDeps({ levelCount: 2, savedRun: { level: 0, lives: LIVES } }));
      const before = h.deps.run.active();
      h.hud.pickLevel(1); // practice on the LAST level -- nowhere for it to advance to
      h.setState('playing');
      h.setState('win'); // a practice "clear"
      expect(h.rec.runAdvances).toEqual([]);
      expect(h.rec.runEnds).toBe(0);
      expect(h.deps.run.active()).toEqual(before); // byte-for-byte unchanged
      h.handle.dispose();
    });

    it('a practice loss cannot end the run', () => {
      const h = boot(makeDeps({ levelCount: 2, savedRun: { level: 0, lives: LIVES } }));
      const before = h.deps.run.active();
      h.hud.pickLevel(1); // practice
      h.setState('playing');
      h.setState('lose'); // a practice "game over"
      expect(h.rec.runEnds).toBe(0);
      expect(h.deps.run.active()).toEqual(before);
      h.handle.dispose();
    });

    it('Continue after leaving practice still resumes the campaign run exactly where it was', () => {
      const h = boot(makeDeps({ levelCount: 3, levelStart: 1, savedRun: { level: 1, lives: 2 } }));
      h.hud.pickLevel(2); // practice on level 3, fresh lives
      h.setState('playing');
      h.keydown({ key: 'Escape' });
      h.hud.quitToTitle(); // back to the menu
      // The board behind the title is the RUN's own position, not the practiced one.
      expect(h.rec.levelBuilds.at(-1)).toEqual({ level: 1, lives: 2 });
      expect(h.deps.run.active()).toEqual({
        campaignId: DEFAULT_CAMPAIGN_ID,
        currentLevelId: '1',
        livesRemaining: 2,
        status: 'active',
      } satisfies ActiveRun);
      h.handle.dispose();
    });
  });

  describe('New Run -- the one explicit, deliberate replacement', () => {
    it('creates a fresh run at level 1 with full lives, and starts playing', () => {
      const h = boot(makeDeps({ levelCount: 2 }));
      expect(h.deps.run.active()).toBeNull();
      h.hud.newGame();
      expect(h.rec.runNewRuns).toEqual([0]);
      expect(h.deps.run.active()).toEqual({
        campaignId: DEFAULT_CAMPAIGN_ID,
        currentLevelId: '0',
        livesRemaining: LIVES,
        status: 'active',
      } satisfies ActiveRun);
      expect(h.rec.levelBuilds.at(-1)).toEqual({ level: 0, lives: LIVES });
      expect(h.getState()).toBe('playing');
      expect(h.rec.unlocks).toBeGreaterThan(0); // a real gesture unlocks audio
      h.handle.dispose();
    });

    it('explicitly replaces an in-progress run, even one with lives remaining', () => {
      const h = boot(makeDeps({ levelCount: 3, savedRun: { level: 2, lives: 1 } })); // mid-campaign, level 3
      h.hud.newGame();
      expect(h.deps.run.active()).toEqual({
        campaignId: DEFAULT_CAMPAIGN_ID,
        currentLevelId: '0',
        livesRemaining: LIVES,
        status: 'active',
      } satisfies ActiveRun);
      h.handle.dispose();
    });

    it('is ignored outside the title screen, like every other title-only control', () => {
      const h = boot(makeDeps());
      h.setState('playing');
      h.hud.newGame();
      expect(h.rec.runNewRuns).toEqual([]);
      h.handle.dispose();
    });
  });

  describe('level clear -- advances the run reactively, not deferred to a click', () => {
    it('persists the next level and the carried lives the instant the win lands', () => {
      const won = { ...createArenaWorld(1), lives: 2 };
      const h = boot(makeDeps({ levelCount: 3, world: won, savedRun: { level: 0, lives: LIVES } }));
      expect(h.rec.runAdvances).toEqual([]); // nothing yet
      h.setState('win'); // level 1 cleared, not final (levelCount 3)
      expect(h.rec.runAdvances).toEqual([{ level: 1, lives: 2 }]);
      expect(h.deps.run.active()).toEqual({
        campaignId: DEFAULT_CAMPAIGN_ID,
        currentLevelId: '1',
        livesRemaining: 2,
        status: 'active',
      } satisfies ActiveRun);
      // Never clicked Next Level: a refresh right here must already see the advance.
      h.handle.dispose();
    });
  });

  describe('game over and campaign completion -- explicit run-ending transitions', () => {
    it('game over ends the active run; Retry starts a brand-new one at level 1', () => {
      const h = boot(makeDeps({ levelCount: 2, savedRun: { level: 1, lives: 1 } })); // mid-campaign, level 2
      h.setState('playing');
      h.setState('lose');
      expect(h.rec.runEnds).toBe(1);
      expect(h.deps.run.active()).toBeNull();
      h.hud.startRestart(); // Retry
      expect(h.rec.runNewRuns).toEqual([0]); // deps.levels.start with no run/jump: level 1
      expect(h.deps.run.active()?.livesRemaining).toBe(LIVES);
      h.handle.dispose();
    });

    it('a dev-flag jump\'s game-over Retry must not touch an unrelated run -- defect 1, adjudicated review of #156', () => {
      // Before the fix: Retry's fresh run was created AT deps.levels.start (dev-jump
      // beats the run beats level 1), which meant a JUMPED session's loss ended
      // whatever real run existed elsewhere, and Retry then created a brand-new one
      // pinned to the jumped level -- discarding the real run's own position and
      // lives entirely. A dev-flag jump is now excluded from campaign-run
      // bookkeeping the same way practice is (see campaignActive): the loss must not
      // end it, Retry must not replace it, and the jumped session lands on the
      // jumped level with fresh lives, leaving the untouched run exactly where it
      // was.
      const h = boot(makeDeps({ levelCount: 3, levelStart: 1, isDevJump: true, savedRun: { level: 2, lives: 1 } }));
      h.setState('playing');
      h.setState('lose');
      expect(h.rec.runEnds).toBe(0);
      h.hud.startRestart();
      expect(h.rec.runNewRuns).toEqual([]);
      expect(h.deps.run.active()).toEqual({
        campaignId: DEFAULT_CAMPAIGN_ID,
        currentLevelId: '2',
        livesRemaining: 1,
        status: 'active',
      } satisfies ActiveRun);
      expect(h.rec.levelBuilds.at(-1)).toEqual({ level: 1, lives: undefined });
      h.handle.dispose();
    });

    it('campaign completion ends the run without automatically creating a replacement', () => {
      // One level: any win is the final one.
      const h = boot(makeDeps({ levelCount: 1, savedRun: { level: 0, lives: LIVES } }));
      h.setState('playing');
      h.setState('win');
      expect(h.rec.runEnds).toBe(1);
      expect(h.rec.runAdvances).toEqual([]); // not a mid-campaign advance
      expect(h.deps.run.active()).toBeNull();
      h.handle.dispose();
    });

    it('the sandbox never touches the active run on win or loss', () => {
      // A real campaign run exists from earlier (non-sandbox) play.
      const h = boot(makeDeps({ levelCount: 1, tracksProgress: false, savedRun: { level: 0, lives: 2 } }));
      h.setState('playing');
      h.setState('win');
      expect(h.rec.runAdvances).toEqual([]);
      expect(h.rec.runEnds).toBe(0);
      expect(h.deps.run.active()?.livesRemaining, 'untouched by the sandbox').toBe(2);
      h.setState('lose');
      expect(h.rec.runEnds).toBe(0);
      h.handle.dispose();
    });
  });

  describe('quit, boot and Continue availability', () => {
    it('quitting to title never creates or replenishes the run', () => {
      const h = boot(makeDeps({ levelCount: 2 }));
      h.setState('playing');
      h.keydown({ key: 'Escape' });
      h.hud.quitToTitle();
      expect(h.deps.run.active()).toBeNull();
      expect(h.rec.runNewRuns).toEqual([]);
      h.handle.dispose();
    });

    it("boot resumes the run's own level and lives, not fresh ones", () => {
      const h = boot(makeDeps({ levelCount: 3, levelStart: 2, savedRun: { level: 2, lives: 1 } }));
      expect(h.rec.levelBuilds[0]).toEqual({ level: 2, lives: 1 });
      h.handle.dispose();
    });

    it('Continue availability reflects whether a run exists, refreshed at every arrival at the title screen', () => {
      const h = boot(makeDeps({ levelCount: 2 }));
      expect(h.rec.continueAvailable.at(-1), 'boot: no run yet').toBe(false);
      h.hud.newGame();
      expect(h.rec.continueAvailable.at(-1), 'New Game just created one').toBe(true);
      h.setState('lose'); // game over ends the run
      h.setState('title'); // arriving at the title screen refreshes the signal
      expect(h.rec.continueAvailable.at(-1), 'the run that just ended is gone').toBe(false);
      h.handle.dispose();
    });
  });

  describe('a dev-flag level jump must not touch an unrelated run (defect 1, adjudicated review of #156)', () => {
    // Reviewer's exact repro: a real run sitting at level 4 (currentLevelId '3'), a
    // boot jump to level 1 (index 0). Before the fix, `tracksProgress` alone could
    // not tell a jumped session apart from a real campaign one -- both are true, only
    // the sandbox is false -- so a win at the jumped level regressed the run to level
    // 2, and a loss destroyed it outright. `deps.levels.isDevJump` is now the seam
    // campaignActive() reads to exclude a jump the same structural way it already
    // excludes practice and the sandbox.
    it('a win at the jumped level does not advance, regress or complete the untouched run', () => {
      const won = { ...createArenaWorld(1), lives: 2 };
      const h = boot(makeDeps({
        levelCount: 11,
        levelStart: 0,
        isDevJump: true,
        world: won,
        savedRun: { level: 3, lives: LIVES },
      }));
      h.setState('win'); // the jumped level's own win, not the run's level 4
      expect(h.rec.runAdvances).toEqual([]);
      expect(h.rec.runEnds).toBe(0);
      expect(h.deps.run.active()).toEqual({
        campaignId: DEFAULT_CAMPAIGN_ID,
        currentLevelId: '3',
        livesRemaining: LIVES,
        status: 'active',
      } satisfies ActiveRun); // byte-for-byte unchanged
      // Permanent progress is NOT part of this exclusion and keeps its pre-existing
      // behaviour -- it is monotonic and was always writable from a dev jump.
      expect(h.rec.cleared).toEqual([1]);
      h.handle.dispose();
    });

    it('a loss at the jumped level does not end the untouched run', () => {
      const h = boot(makeDeps({
        levelCount: 11,
        levelStart: 0,
        isDevJump: true,
        savedRun: { level: 3, lives: LIVES },
      }));
      h.setState('playing');
      h.setState('lose'); // the jumped level's own game over
      expect(h.rec.runEnds).toBe(0);
      expect(h.deps.run.active()).toEqual({
        campaignId: DEFAULT_CAMPAIGN_ID,
        currentLevelId: '3',
        livesRemaining: LIVES,
        status: 'active',
      } satisfies ActiveRun);
      h.handle.dispose();
    });

    it('a life lost during a jumped session never reaches the run store', () => {
      // Same shape as the practice-isolation test above: the jumped session's own
      // death must not persist against a run it does not own.
      const world = worldWithPlayerAboutToDie();
      const h = boot(makeDeps({
        levelCount: 11,
        levelStart: 0,
        isDevJump: true,
        world,
        savedRun: { level: 3, lives: LIVES },
      }));
      h.setState('playing');
      h.fireFrame(20);
      expect(h.rec.deathSignals).toBe(1); // the death really happened
      expect(h.rec.runLivesSets).toEqual([]);
      expect(h.deps.run.active()?.livesRemaining, 'untouched by the jumped session').toBe(LIVES);
      h.handle.dispose();
    });

    it('boots with fresh lives, not the unrelated run\'s -- decided: a jumped session gets fresh lives, like practice', () => {
      // adopting the run's lives without ever writing them back was the odd half of
      // this defect: a jumped session would show a life count that belongs to a
      // level it is not showing, and there is no way it could ever change (the
      // session never writes back either). Fresh lives, matching bootLives' comment.
      const h = boot(makeDeps({ levelCount: 11, levelStart: 0, isDevJump: true, savedRun: { level: 3, lives: 1 } }));
      expect(h.rec.levelBuilds[0]).toEqual({ level: 0, lives: undefined });
      h.handle.dispose();
    });

    it('quitting a jumped session shows the jumped board with fresh lives, never leaking the unrelated run\'s', () => {
      const h = boot(makeDeps({ levelCount: 11, levelStart: 0, isDevJump: true, savedRun: { level: 3, lives: 1 } }));
      h.setState('playing');
      h.keydown({ key: 'Escape' });
      h.hud.quitToTitle();
      expect(h.rec.levelBuilds.at(-1)).toEqual({ level: 0, lives: undefined });
      expect(h.deps.run.active()?.livesRemaining, 'untouched').toBe(1); // exactly as saved
      h.handle.dispose();
    });
  });

  // The tests above drive the fake `levels` object's own `isDevJump` field, which
  // levels.test.ts separately proves the REAL createLevelSystem computes correctly.
  // These two reproduce the reviewer's original probe with NEITHER faked: the real
  // createLevelSystem, over a real createRunStore, wired into a real startGameWith --
  // only the renderer/audio/HUD/input collaborators stay fake, the same as every
  // other test in this file.
  describe('defect 1, reproduced with the REAL createLevelSystem + createRunStore (not the fake levels object above)', () => {
    function realJumpDeps(): { deps: GameDeps; run: ReturnType<typeof createRunStore>; base: ReturnType<typeof makeDeps> } {
      const storage = createMemoryStorage();
      const run = createRunStore(storage);
      run.startNewRun(CAMPAIGN_LEVELS[0].id);
      run.advanceLevel(CAMPAIGN_LEVELS[3].id, LIVES); // the run: currentLevelId CAMPAIGN_LEVELS[3].id, full lives
      const jumpFlags: DevFlags = { ...DEV_FLAGS_OFF, level: 1 }; // ?dev=1&level=1 -> index 0
      const levels = createLevelSystem(jumpFlags, run);
      const base = makeDeps({ world: { ...createArenaWorld(1), lives: 2 } });
      const deps: GameDeps = { ...base.deps, levels, run, devFlags: jumpFlags };
      return { deps, run, base };
    }

    it('a win at the jumped level leaves a real run at level 4 byte-for-byte unchanged', () => {
      const { deps, run, base } = realJumpDeps();
      const h = boot({ ...base, deps });
      h.setState('win');
      expect(run.active()).toEqual({
        campaignId: DEFAULT_CAMPAIGN_ID,
        currentLevelId: CAMPAIGN_LEVELS[3].id,
        livesRemaining: LIVES,
        status: 'active',
      } satisfies ActiveRun);
      h.handle.dispose();
    });

    it('a loss at the jumped level does not destroy a real run at level 4', () => {
      const { deps, run, base } = realJumpDeps();
      const h = boot({ ...base, deps });
      h.setState('playing');
      h.setState('lose');
      expect(run.active()).toEqual({
        campaignId: DEFAULT_CAMPAIGN_ID,
        currentLevelId: CAMPAIGN_LEVELS[3].id,
        livesRemaining: LIVES,
        status: 'active',
      } satisfies ActiveRun);
      h.handle.dispose();
    });

    // The one defect from the adjudicated review of #157: hud.onNewGame's startNewRun call had
    // no session-type guard at all -- unlike every other run mutation in this file,
    // which is gated on campaignActive(). The two tests below reproduce the two ways
    // that reached: the sandbox's synthetic level id poisoning the REAL run key, and a
    // dev jump's New Game replacing a run it does not own -- same structural exclusion
    // as #156's campaignActive, extended to cover New Game.
    it('New Game in the sandbox creates no run and writes no tanks.run.v2 key', () => {
      // Before the fix: hud.onNewGame called deps.run.startNewRun(deps.levels.levels[0].id)
      // unconditionally. For the sandbox that id is the synthetic 'sandbox' string --
      // never a member of CAMPAIGN_LEVELS -- so this persisted
      // {currentLevelId: 'sandbox', ...} into the REAL tanks.run.v2 key: a later normal
      // session would read it back as an unresolvable id and silently fall back to
      // level 1, discarding wherever the player's real run actually was.
      // campaignActive() is false here (tracksProgress is false for the sandbox), so
      // the fix must touch neither the in-memory run nor the storage key at all.
      const storage = createMemoryStorage();
      const run = createRunStore(storage);
      const sandboxFlags: DevFlags = { ...DEV_FLAGS_OFF, level: 'sandbox' };
      const levels = createLevelSystem(sandboxFlags, run);
      const base = makeDeps();
      const deps: GameDeps = { ...base.deps, levels, run, devFlags: sandboxFlags };
      const h = boot({ ...base, deps });
      h.hud.newGame();
      // Proves the handler actually ran (rather than the guard short-circuiting it
      // for an unrelated reason and leaving run.active() null incidentally): New
      // Game still starts play unconditionally.
      expect(h.getState(), 'the handler ran -- New Game still starts play').toBe('playing');
      expect(run.active()).toBeNull();
      expect(storage.getItem(RUN_KEY)).toBeNull();
      h.handle.dispose();
    });

    it("New Game in a dev-jumped session leaves an unrelated real run byte-for-byte untouched, and boots levels[0] with fresh lives", () => {
      // Before the fix, the same unconditional startNewRun call REPLACED a real run:
      // under `?dev=1&level=2`, New Game rewrote a run sitting at level 4 to a brand
      // new one at level 1 with full lives -- discarding wherever the run actually
      // was. #156's adjudicated model already excludes a dev jump from
      // consuming/restoring/advancing/completing the run; this defect showed New
      // Game -- Replace -- was never added to that exclusion list.
      //
      // The saved run is deliberately left at 1 life, not LIVES: both the buggy and
      // the fixed code boot levels[0] at LIVES-valued lives (startNewRun always
      // grants full LIVES, and the fixed path's `undefined` also defaults to LIVES),
      // so a saved run already at LIVES would make the lives assertion below a
      // tautology. At 1 life, a wrong fix that read the untouched run's own lives
      // back (deps.run.active()?.livesRemaining) instead of passing undefined would
      // still be caught.
      const storage = createMemoryStorage();
      const run = createRunStore(storage);
      run.startNewRun(CAMPAIGN_LEVELS[0].id);
      run.advanceLevel(CAMPAIGN_LEVELS[3].id, 1); // the run: level-04, 1 life left
      const savedRun = run.active();
      const jumpFlags: DevFlags = { ...DEV_FLAGS_OFF, level: 2 }; // ?dev=1&level=2 -> index 1
      const levels = createLevelSystem(jumpFlags, run);
      const base = makeDeps();
      const deps: GameDeps = { ...base.deps, levels, run, devFlags: jumpFlags };
      const h = boot({ ...base, deps });
      h.hud.newGame();
      expect(run.active()).toEqual(savedRun); // byte-for-byte unchanged
      // Boots levels[0] (ordinal 1 of 5), not the jumped level (index 1) or the run's
      // own level-04 -- ordinalOf/hud.setLevel is driven off deps.levels.levels, real
      // here, so this does not depend on the fake levels object's own recorder.
      expect(h.rec.hudLevels.at(-1)).toEqual([1, CAMPAIGN_LEVELS.length]);
      h.fireFrame(100);
      expect(h.rec.renders.at(-1)!.curr.lives).toBe(LIVES);
      h.handle.dispose();
    });
  });

  describe('coop exclusion (coop semantics plan, docs/superpowers/plans/2026-08-15-coop-semantics.md)', () => {
    // isPlayerDeath already keys on tankId, not kind, so P2 dying was ALREADY
    // invisible to setLivesRemaining before this exclusion existed -- the meaningful
    // case is the TRACKED player (P1/playerId) dying in a coop session, where
    // campaignActive() would otherwise still read true.
    it('the TRACKED player dying in coop never reaches the run store, even though tracksProgress/isDevJump/inPractice all say it could', () => {
      const h = boot(makeDeps({ devFlags: { players: 2 }, savedRun: { level: 0, lives: LIVES } }));
      const world = h.rec.builtWorlds[0];
      const p0 = world.tanks.find((t: Tank) => t.kind === 'player')!; // the tracked player
      const enemy = world.tanks.find((t: Tank) => t.kind !== 'player')!;
      world.bullets.push({
        id: 900, ownerId: enemy.id, type: 'normal', pos: { x: p0.pos.x, y: p0.pos.y },
        vel: { x: 1, y: 0 }, bouncesLeft: 1, alive: true,
      });
      h.setState('playing');
      h.fireFrame(20);
      expect(h.rec.deathSignals).toBe(1); // the death really happened
      expect(h.rec.runLivesSets).toEqual([]); // and never reached the run store
      h.handle.dispose();
    });

    it('a coop boot with an existing real run in progress gets fresh LIVES, not the run\'s stale count', () => {
      // 1 life, deliberately not LIVES: both the buggy and fixed paths would boot at
      // a value indistinguishable from LIVES if the saved run already held LIVES.
      const h = boot(makeDeps({ devFlags: { players: 2 }, savedRun: { level: 0, lives: 1 } }));
      expect(h.rec.levelBuilds[0].lives).toBeUndefined();
      h.handle.dispose();
    });
  });

  describe('coop kill attribution, end to end (coop semantics plan)', () => {
    // tallyCoopKills and hud.setCoopKills are each unit-tested directly (their own
    // describe blocks), which is exactly the CLAUDE.md-named blindness: a unit test
    // calling either directly cannot see whether onFrameEvents still calls them at
    // all. This drives a REAL kill through a driven frame and checks the tally
    // reaches the HUD -- the composition, not the arithmetic.
    it('a kill credited to P2 flows through tallyCoopKills into hud.setCoopKills, in a real driven frame', () => {
      const h = boot(makeDeps({ devFlags: { players: 2 } }));
      const world = h.rec.builtWorlds[0];
      const p2 = world.tanks.find((t: Tank) => t.kind === 'player' && t.controlledBy === 1)!;
      const enemy = world.tanks.find((t: Tank) => t.kind !== 'player')!;
      world.bullets.push({
        id: 901, ownerId: p2.id, type: 'normal', pos: { x: enemy.pos.x, y: enemy.pos.y },
        vel: { x: 1, y: 0 }, bouncesLeft: 1, alive: true,
      });
      h.setState('playing');
      h.fireFrame(20);
      const last = h.rec.coopKillPushes.at(-1);
      expect(last).not.toBeNull();
      expect(last![1]).toBe(1); // P2's slot, attributed by tallyCoopKills
      expect(last![0] ?? 0).toBe(0); // not misfiled onto P1's slot
      h.handle.dispose();
    });

    // n-player arc PR 4 (FFA + teams): the versus twin of the test above. tallyCoopKills
    // (loop.test.ts's own describe block) and hud.setVersusResults (hud.test.ts) are each
    // unit-tested directly -- neither can see whether onFrameEvents' mode dispatch
    // (`isVersus` above) still routes a real frame's kill into setVersusResults instead of
    // setCoopKills. Before this test, versusResultsPushes was recorded but nothing read
    // it -- a dangling hook: the dispatch branch that fires when isVersus is true was
    // exercised by no test in this file, only by the isVersus===false branch above.
    it('a versus (ffa) kill flows through tallyCoopKills into hud.setVersusResults, and setCoopKills gets null, in a real driven frame', () => {
      const h = boot(makeDeps({ devFlags: { players: 2, mode: 'ffa' } }));
      const world = h.rec.builtWorlds[0];
      // Confirms the fake levels.world() above actually threaded devFlags.mode into the
      // REAL createWorldFor call -- if it silently built a campaign-coop world instead
      // (as it did before this test motivated extending the fake), every assertion below
      // would either fail confusingly or pass vacuously against the wrong dispatch branch.
      expect(world.mode).toBe('ffa');
      const p1 = world.tanks.find((t: Tank) => t.kind === 'player' && t.controlledBy === 0)!;
      const p2 = world.tanks.find((t: Tank) => t.kind === 'player' && t.controlledBy === 1)!;
      world.bullets.push({
        id: 901, ownerId: p2.id, type: 'normal', pos: { x: p1.pos.x, y: p1.pos.y },
        vel: { x: 1, y: 0 }, bouncesLeft: 1, alive: true,
      });
      h.setState('playing');
      h.fireFrame(20);
      const lastVersus = h.rec.versusResultsPushes.at(-1);
      expect(lastVersus).not.toBeNull();
      expect(lastVersus!.mode).toBe('ffa');
      expect(lastVersus!.kills[1]).toBe(1); // P2's slot, attributed by tallyCoopKills
      expect(lastVersus!.deaths[0]).toBe(1); // P1's slot died
      // The coop line is suppressed while in a versus mode -- the two results lines are
      // never both live at once (loop.ts's isVersus dispatch).
      expect(h.rec.coopKillPushes.at(-1)).toBeNull();
      h.handle.dispose();
    });
  });

  describe('the in-match stock readout (Task 6, spec §3a)', () => {
    // The relocation this fix round makes: the readout is now dispatched from
    // onSimulated, which runs on EVERY 'playing' frame unconditionally -- unlike
    // onFrameEvents, which only fires `if (frameEvents.length > 0)` (driver.ts). Before
    // this fix, a frame with zero SimEvents (the pre-round countdown, or simply a quiet
    // first tick before anyone has acted) left the strip undispatched -- no SimEvent
    // marks "a versus match has started" for onFrameEvents to key off. `rec.directed`
    // (the events batch handed to `director.handle`) only grows on an event-bearing
    // frame, which is what proves THIS frame produced none -- without that check the
    // test could pass by accident on a frame that happened to carry an event anyway.
    it('populates from the very first simulated frame, even one with ZERO SimEvents', () => {
      const h = boot(makeDeps({ devFlags: { players: 2, mode: 'ffa' } }));
      h.setState('playing');
      const directedBefore = h.rec.directed.length;
      h.fireFrame(20);
      expect(
        h.rec.directed.length,
        'this frame produced a SimEvent -- not the zero-event path this test means to check',
      ).toBe(directedBefore);
      const last = h.rec.versusStocksPushes.at(-1);
      expect(last).not.toBeNull();
      const bySlot = new Map(last!.map((e) => [e.slot, e]));
      expect(bySlot.get(0)?.stock).toBe(VERSUS_STOCK);
      expect(bySlot.get(1)?.stock).toBe(VERSUS_STOCK);
      h.handle.dispose();
    });

    // Twin of the versus-results test just above: setVersusStocks (hud.test.ts) and
    // the derivation itself are each unit-testable in isolation, but neither can see
    // whether onSimulated's isVersusFrame branch actually calls the setter on a real,
    // driven frame. Reuses the exact bullet-on-P1 fixture the results test above
    // drives, so the kill is real, not fabricated.
    it('a versus kill updates the readout, decrementing the victim\'s stock and leaving the killer\'s untouched', () => {
      const h = boot(makeDeps({ devFlags: { players: 2, mode: 'ffa' } }));
      const world = h.rec.builtWorlds[0];
      expect(world.mode).toBe('ffa');
      const p1 = world.tanks.find((t: Tank) => t.kind === 'player' && t.controlledBy === 0)!;
      const p2 = world.tanks.find((t: Tank) => t.kind === 'player' && t.controlledBy === 1)!;
      // The negative control the advisor named: stockRemaining must actually be
      // stamped BEFORE the kill, or a 0 -> 0 "decrement" would pass while proving
      // nothing (stockRemaining's own `?? 0` fallback reads an unstamped tank as
      // already eliminated).
      expect(p1.stockRemaining).toBe(VERSUS_STOCK);
      expect(p2.stockRemaining).toBe(VERSUS_STOCK);
      world.bullets.push({
        id: 902, ownerId: p2.id, type: 'normal', pos: { x: p1.pos.x, y: p1.pos.y },
        vel: { x: 1, y: 0 }, bouncesLeft: 1, alive: true,
      });
      h.setState('playing');
      h.fireFrame(20);
      const last = h.rec.versusStocksPushes.at(-1);
      expect(last).not.toBeNull();
      const bySlot = new Map(last!.map((e) => [e.slot, e]));
      expect(bySlot.get(0)?.stock, "P1's own stock did not decrement").toBe(VERSUS_STOCK - 1);
      expect(bySlot.get(1)?.stock, "P2's stock was touched by a kill it did not take").toBe(VERSUS_STOCK);
      // ffa: no `team` on either entry.
      expect(bySlot.get(0)?.team).toBeUndefined();
      expect(bySlot.get(1)?.team).toBeUndefined();
      h.handle.dispose();
    });

    // The no-thrash control: onSimulated runs on EVERY 'playing' frame, event or no
    // event, so without the dedup guard EVERY frame of a live match would re-invoke the
    // setter -- a frame where the player fires but nothing dies is just one easy way to
    // prove it (firing is a REAL, common in-match action, not a contrived quiet frame).
    // h.firePlayerShot() drives a REAL shot through the sim (not a fabricated event),
    // so this measures the actual dedup guard in loop.ts, not a fixture that never
    // calls it.
    it('firing (an event, but no stock change) across several frames does not re-invoke the setter beyond the one triggering call', () => {
      const h = boot(makeDeps({ devFlags: { players: 2, mode: 'ffa' } }));
      // Teleport P1 into arena-01's fully-open top band before play starts (the same
      // reach-into-the-initial-world idiom the kill test above uses for its bullet).
      // The harness's fixed aim POINT (1, 0) sat directly above the hull-clearance
      // spawn cell (issue #225 moved P1 to world (1, 1)), so every shot went straight
      // up, bounced off the top boundary one unit away, and came back down through
      // the shooter -- a real self-kill that changed stocks and broke this test's
      // nothing-dies premise. From (11, 1) the same aim point is ~10 units away at a
      // shallow angle: a speed-6 shell cannot even REACH a wall inside this test's
      // ~1.3 simulated seconds, so no shot can hit anything -- which is exactly the
      // premise this test needs, now pinned structurally instead of inherited from
      // wherever the spawn picker happens to put P1.
      const w0 = h.rec.builtWorlds[0];
      const p1 = w0.tanks.find((t: Tank) => t.kind === 'player' && t.controlledBy === 0)!;
      p1.pos.x = 11;
      p1.pos.y = 1;
      h.setState('playing');
      h.firePlayerShot();
      h.fireFrame(20); // the first shot: an event lands, the setter fires once
      const afterFirstShot = h.rec.versusStocksPushes.length;
      expect(afterFirstShot).toBeGreaterThan(0);
      for (let i = 1; i <= 5; i++) {
        h.firePlayerShot();
        h.fireFrame(20 + i * 250); // spaced past the weapon cooldown, a real shot each time
      }
      // Breaks (fails to stay at afterFirstShot) if loop.ts's `key !== lastVersusStocksKey`
      // guard is removed -- measured by deleting it locally and confirming this goes red.
      expect(h.rec.versusStocksPushes.length, 'unchanged stocks re-invoked the setter').toBe(afterFirstShot);
      h.handle.dispose();
    });

    it("a campaign session gets exactly one null call at wiring, and never entries", () => {
      const h = boot(makeDeps());
      h.setState('playing');
      h.firePlayerShot();
      h.fireFrame(20);
      h.fireFrame(300);
      h.fireFrame(600);
      expect(h.rec.versusStocksPushes).toEqual([null]);
      h.handle.dispose();
    });
  });

  it('a versus fixture with NO players flag still gets a REAL versus world -- the fake cannot silently hand back campaign-coop', () => {
    // Review found this gap dormant: the fake took its real-world branch on playerCount
    // alone, so `mode: 'ffa'` without `players` fell through to a synthetic coop world
    // and any versus assertion would have been measuring the wrong dispatch branch.
    // Breaks if the fake's branch condition drops its mode term.
    const h = boot(makeDeps({ devFlags: { mode: 'ffa' } }));
    const world = h.rec.builtWorlds.at(-1)!;
    expect(world.mode).toBe('ffa');
    expect(world.tanks.every((t: Tank) => t.kind === 'player')).toBe(true); // enemies stripped
    h.handle.dispose();
  });

  describe('shared-attempts ruling (docs/superpowers/plans/2026-08-16-coop-attempts.md): level clear revives everyone', () => {
    // resolveStatusCoop's own unit tests (coop-attempts.test.ts) prove a full wipe's
    // resetArena revives every tank; they cannot see whether the GAME LAYER's own
    // level-advance path (switchTo -> buildWorld -> deps.levels.world(...)) produces a
    // fresh, fully-alive board on its own, independent of resetArena, for the ordinary
    // "one player died mid-level, the survivor cleared it" case the ruling names by
    // name ("if they clear the level, all players spawn in on the next level"). The
    // fake levels object's own `world()` function (see makeDeps above) already builds
    // coop worlds through the REAL createWorldFor/loadArena for playerCount > 1 --
    // exactly the composition this test needs, not a fixture that could paper over a
    // dropped revival.
    it('a cleared level with a dead P2 (attempts mode, the default) spawns BOTH players alive on the next board', () => {
      const h = boot(makeDeps({ devFlags: { players: 2 }, levelCount: 2 }));
      const world = h.rec.builtWorlds[0]; // level 1's real coop world
      expect(world.coopAttempts).toBe(true); // the default -- nothing opted into coopPool
      const p2 = world.tanks.find((t: Tank) => t.kind === 'player' && t.controlledBy === 1)!;
      p2.alive = false; // P2 died mid-level; the survivor (P1) carried the level per the ruling
      h.setState('win'); // level 1 cleared, not final (levelCount 2)
      h.hud.startRestart(); // Next Level click -- the real switchTo/buildWorld path

      const next = h.rec.builtWorlds.at(-1)!; // level 2's real coop world
      expect(next).not.toBe(world); // a genuinely NEW build, not the same object relived
      const nextPlayers = next.tanks.filter((t: Tank) => t.kind === 'player');
      expect(nextPlayers).toHaveLength(2);
      expect(nextPlayers.every((t: Tank) => t.alive)).toBe(true);
      h.handle.dispose();
    });

    it('the same holds under the shipped pool model (coopPool=1) -- a full wipe there also revives everyone via a fresh level build', () => {
      // Not a claim about pool mode's mid-level per-tank respawn (that stays
      // per-tank, unchanged); this only pins that a LEVEL CLEAR -- which always
      // rebuilds the world from scratch regardless of which coop mode was active --
      // still starts both players alive either way.
      const h = boot(makeDeps({ devFlags: { players: 2, coopPool: true }, levelCount: 2 }));
      const world = h.rec.builtWorlds[0];
      expect(world.coopAttempts).toBe(false);
      const p2 = world.tanks.find((t: Tank) => t.kind === 'player' && t.controlledBy === 1)!;
      p2.alive = false;
      p2.respawnAtTick = 99999; // a pool-mode corpse mid-respawn-wait when the level cleared
      h.setState('win');
      h.hud.startRestart();

      const next = h.rec.builtWorlds.at(-1)!;
      const nextPlayers = next.tanks.filter((t: Tank) => t.kind === 'player');
      expect(nextPlayers).toHaveLength(2);
      expect(nextPlayers.every((t: Tank) => t.alive)).toBe(true);
      expect(nextPlayers.every((t: Tank) => t.respawnAtTick === undefined)).toBe(true);
      h.handle.dispose();
    });
  });
});

describe('playerShellsInFlight', () => {
  const bullet = (id: number, ownerId: number, alive: boolean): Bullet =>
    ({ id, ownerId, type: 'normal', pos: { x: 0, y: 0 }, vel: { x: 1, y: 0 }, bouncesLeft: 1, alive }) as Bullet;

  it('counts only the player\'s LIVE shells', () => {
    // SHELL_CAP is enforced per owner, so counting the arena's whole traffic
    // would make the readout meaningless as a cap indicator.
    const w = {
      ...createArenaWorld(1),
      bullets: [bullet(1, 7, true), bullet(2, 7, false), bullet(3, 99, true)],
    };
    expect(playerShellsInFlight(w, 7)).toBe(1);
  });

  it('is 0 when there is no player', () => {
    expect(playerShellsInFlight(createArenaWorld(1), undefined)).toBe(0);
  });
});

describe('startGameWith: dev flags stay off by default', () => {
  it('never touches the shell readout with the flag off', () => {
    const h = boot();
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.shellCounts).toHaveLength(0);
    h.handle.dispose();
  });

  it('drives the shell readout when the flag is on', () => {
    const h = boot(makeDeps({ devFlags: { shellCount: true } }));
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.shellCounts.length).toBeGreaterThan(0);
    expect(h.rec.shellCounts[0]?.cap).toBe(5);
    h.handle.dispose();
  });

  it('asks the renderer for every dev overlay OFF by default', () => {
    // Deliberately an exact-object assertion, not toMatchObject: this is the test that
    // catches a NEW overlay flag shipped defaulting to on. Adding a flag should make you
    // come here and write `false`.
    const off = boot();
    expect(off.rec.rendererArgs[0][4]).toEqual({ aimRay: false, mineReach: false, mineTimer: false, playerColor: '#hex-blue', playerSkin: 'solid', playerAccent: null, quality: QUALITY_PRESETS.high, enemyDeathPulse: false });
    off.handle.dispose();
  });

  it('asks for each overlay only when its own flag is on', () => {
    // One at a time, so a wiring that turns them all on together -- or crosses two of
    // them -- fails rather than passing on the aggregate.
    const ray = boot(makeDeps({ devFlags: { aimRay: true } }));
    expect(ray.rec.rendererArgs[0][4]).toEqual({ aimRay: true, mineReach: false, mineTimer: false, playerColor: '#hex-blue', playerSkin: 'solid', playerAccent: null, quality: QUALITY_PRESETS.high, enemyDeathPulse: false });
    ray.handle.dispose();

    const reach = boot(makeDeps({ devFlags: { mineReach: true } }));
    expect(reach.rec.rendererArgs[0][4]).toEqual({ aimRay: false, mineReach: true, mineTimer: false, playerColor: '#hex-blue', playerSkin: 'solid', playerAccent: null, quality: QUALITY_PRESETS.high, enemyDeathPulse: false });
    reach.handle.dispose();

    const timer = boot(makeDeps({ devFlags: { mineTimer: true } }));
    expect(timer.rec.rendererArgs[0][4]).toEqual({ aimRay: false, mineReach: false, mineTimer: true, playerColor: '#hex-blue', playerSkin: 'solid', playerAccent: null, quality: QUALITY_PRESETS.high, enemyDeathPulse: false });
    timer.handle.dispose();
  });

  it('threads the enemyDeathPulse dev flag through to the renderer', () => {
    // The wiring this feature adds: devFlags.enemyDeathPulse -> the renderer's
    // construction options, the same shape as aimRay/mineReach/mineTimer above.
    const h = boot(makeDeps({ devFlags: { enemyDeathPulse: true } }));
    const options = h.rec.rendererArgs[0][4] as { enemyDeathPulse?: boolean };
    expect(options.enemyDeathPulse).toBe(true);
    h.handle.dispose();
  });

  it('threads the quality dev flag through to the renderer', () => {
    // The wiring this feature adds: devFlags.quality -> qualityFor -> the renderer's
    // construction options. Population: all 3 QualityPreset values, plus the
    // already-covered null-default case above.
    for (const q of ['low', 'medium', 'high'] as const) {
      const h = boot(makeDeps({ devFlags: { quality: q } }));
      const options = h.rec.rendererArgs[0][4] as { quality?: unknown };
      expect(options.quality).toEqual(QUALITY_PRESETS[q]);
      h.handle.dispose();
    }
  });
});

describe('startGameWith: autoplay wiring', () => {
  // driver.test.ts already proves the driver calls `deps.input.sample()` once per
  // simulated tick against a FAKE `input`; it cannot see whether loop.ts wires the REAL
  // input controller into that seam, let alone whether ?dev=1&autoplay=1 swaps it for
  // the scripted player -- the same composition-blindness gap loop.test.ts's other
  // "real frame, pumped" tests exist to close (CLAUDE.md: driver.test.ts injects fake
  // hooks and cannot see whether loop.ts wires the real collaborators into them).
  it('samples the real input controller with the flag off (unchanged from today)', () => {
    const h = boot(makeDeps({ devFlags: { autoplay: false } }));
    h.setState('playing');
    h.fireFrame(100); // 6 ticks
    expect(h.rec.samples).toBe(6);
    h.handle.dispose();
  });

  it('never touches the real input controller once autoplay is on', () => {
    // If loop.ts's effectiveInput still fell through to input.sample() this would be 6,
    // exactly like the test above -- the only way it lands at 0 is if the scripted
    // player (decidePlayerInput) is genuinely driving in its place.
    const h = boot(makeDeps({ devFlags: { autoplay: true } }));
    h.setState('playing');
    h.fireFrame(100); // 6 ticks
    expect(h.rec.samples).toBe(0);
    h.handle.dispose();
  });

  it('actually moves the player tank, not just a live world.tick', () => {
    // world.tick advances every simulated frame regardless of what InputState step()
    // receives -- even the all-zeros shape the fake input controller returns -- so a
    // wiring bug that samples SOMETHING but hands step() a static/neutral input (the
    // fake's own {move:{0,0}, aim:{1,0}, fire:false, mine:false}) would still pass a
    // bare tick>0 check. Checking the player's position moved off its spawn is what
    // actually distinguishes "decidePlayerInput is driving" from "some input arrived".
    // Player spawn position comes from the arena's fixed grid, not the seed, so any
    // seed gives the same reference point -- no need to touch the fake levels system
    // (and its recorder side effects) to get it.
    const spawn = createArenaWorld(1).tanks.find((t) => t.kind === 'player')!.pos;
    const h = boot(makeDeps({ devFlags: { autoplay: true } }));
    h.setState('playing');
    // A single fireFrame call is clamped to MAX_FRAME_DT (0.25s = 15 ticks, frame.ts),
    // so one huge `now` jump does NOT simulate the elapsed time -- many small frames do
    // (same pattern as the "routes events" test above). COUNTDOWN_TICKS (180, 3s) blocks
    // all movement, so this needs to clear that before the player can have moved at all.
    for (let i = 1; i <= 60; i++) h.fireFrame(i * 100); // 60 x 100ms, well under the clamp
    const r = h.rec.renders[h.rec.renders.length - 1];
    const player = r.curr.tanks.find((t: Tank) => t.kind === 'player')!;
    expect(player.pos).not.toEqual(spawn);
    h.handle.dispose();
  });

  it('leaves the real controller wired for its own calls (pause clear, mine tap, dispose)', () => {
    // Autoplay only replaces what feeds step(); pressMine/clearQueuedPresses/dispose
    // still belong to the real controller, unconditionally, so pausing or tearing down
    // an autoplay session behaves exactly like a normal one.
    const h = boot(makeDeps({ devFlags: { autoplay: true } }));
    h.setState('playing');
    h.hud.mineTap();
    expect(h.rec.minePresses).toBe(1);
    h.setState('paused');
    expect(h.rec.inputClears).toBeGreaterThan(0);
    h.handle.dispose();
    expect(h.rec.disposed).toContain('input');
  });
});

describe('startGameWith: a pinned dev seed', () => {
  it('uses the pinned seed instead of the clock', () => {
    const h = boot(makeDeps({ wallMs: 999, devFlags: { seed: 4242 } }));
    expect(h.rec.seeds[0]).toBe(4242);
    h.handle.dispose();
  });

  it('reuses it on restart, so a replay is the same fight', () => {
    // The whole point: without this a restart re-derives from the clock and
    // the comparison is against a different arena.
    const h = boot(makeDeps({ devFlags: { seed: 4242 } }));
    h.setState('win');
    h.hud.startRestart();
    expect(h.rec.seeds).toEqual([4242, 4242]);
    h.handle.dispose();
  });

  it('falls back to the clock when unpinned', () => {
    const h = boot(makeDeps({ wallMs: 1000 }));
    expect(h.rec.seeds[0]).toBe(deriveSeed(1000));
    h.handle.dispose();
  });
});

describe('startGameWith: the mine-trigger policy reaches the world', () => {
  it('passes the policy to createWorld', () => {
    const h = boot(makeDeps({
      devFlags: { aimRay: false, shellCount: false, seed: null, mineTrigger: 'both' },
    }));
    expect(h.rec.worldPolicies[0]).toBe('both');
    h.handle.dispose();
  });

  it('passes undefined when unset, so the world keeps its own default', () => {
    const h = boot();
    expect(h.rec.worldPolicies[0]).toBeUndefined();
    h.handle.dispose();
  });
});

describe('startGameWith: round-phase HUD', () => {
  function inCountdown(): ReturnType<typeof makeDeps> {
    // A world that starts in countdown: roundStartTick equal to tick.
    const base = createArenaWorld(1);
    return makeDeps({
      world: { ...base, tick: 0, roundStartTick: 0 },
    });
  }

  it('drives the HUD with NO flag needed: the countdown is shipped behaviour', () => {
    // The round opens with COUNTDOWN_TICKS in which movement is blocked. Without
    // this the player presses a direction, nothing happens for three seconds, and
    // the game reads as broken -- which is what it did while this sat behind a flag.
    // bootAtSplash, not boot: leaving the title screen pushes a round-phase CLEAR
    // (loop.ts nulls the chip on every non-playing state), which would sit at index 0
    // and knock these assertions out of step with `renders`.
    const h = bootAtSplash(inCountdown());
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.roundPhases.length).toBeGreaterThan(0);
    const first = h.rec.roundPhases[0];
    expect(first?.phase).toBe('countdown');
    expect(first?.secondsLeft).toBeGreaterThan(0);
    h.handle.dispose();
  });

  it('stops announcing EXACTLY when movement unblocks, not a tick before', () => {
    // ~17ms per frame is one tick at TICK_HZ, so every tick of the countdown gets
    // its own frame and the final one is genuinely exercised. Coarser frames skip
    // ~6 ticks each and a countdown that went quiet one tick early slipped through.
    // bootAtSplash, not boot: leaving the title screen pushes a round-phase CLEAR
    // (loop.ts nulls the chip on every non-playing state), which would sit at index 0
    // and knock these assertions out of step with `renders`.
    const h = bootAtSplash(inCountdown());
    h.setState('playing');
    for (let i = 1; i <= COUNTDOWN_TICKS + 20; i++) h.fireFrame(i * 17);
    // Per-frame push and per-frame render, so index i is the same frame in both.
    expect(h.rec.roundPhases.length).toBe(h.rec.renders.length);
    const firstSilent = h.rec.roundPhases.findIndex((p) => p === null);
    expect(firstSilent).toBeGreaterThan(0); // it announced before it stopped
    // BOTH edges. Too early: a countdown frame with no announcement is a frozen
    // tank the player has no explanation for. Too late: the frame before must
    // still have been countdown, or the chip outstays the block it explains.
    // Asserting only the first left a "goes quiet one tick LATE" mutant alive.
    expect(roundPhase(h.rec.renders[firstSilent].curr)).not.toBe('countdown');
    expect(roundPhase(h.rec.renders[firstSilent - 1].curr)).toBe('countdown');
    h.handle.dispose();
  });

  it('clears the indicator when play stops, so no frozen chip is left behind', () => {
    // refreshRoundPhase only runs from onSimulated, which the driver calls ONLY
    // while playing. Pause during the 3s countdown and the last push is whatever
    // was on screen -- and quitting to title leaves it there indefinitely, since
    // switchTo rebuilds the world without simulating a frame. The chip lives in
    // the topbar (z-index 1) and paints ABOVE the panel, so it is not subtle.
    // bootAtSplash, not boot: leaving the title screen pushes a round-phase CLEAR
    // (loop.ts nulls the chip on every non-playing state), which would sit at index 0
    // and knock these assertions out of step with `renders`.
    const h = bootAtSplash(inCountdown());
    h.setState('playing');
    h.fireFrame(20);
    expect(h.rec.roundPhases.at(-1)).not.toBeNull(); // it is announcing

    h.setState('paused');
    expect(h.rec.roundPhases.at(-1)).toBeNull(); // ... and stops when play does

    h.setState('title');
    expect(h.rec.roundPhases.at(-1)).toBeNull();
    h.handle.dispose();
  });

  // bootAtSplash for the same reason as its three siblings: leaving the title screen
  // pushes a round-phase clear, and this test's `length > 0` guard would be satisfied
  // by that null alone -- adjudication proved it passes with the live-branch clear
  // deleted.
  it('hides once the round goes live', () => {
    const base = createArenaWorld(1);
    const h = bootAtSplash(
      makeDeps({
        // Far past COUNTDOWN_TICKS + GRACE_TICKS.
        world: { ...base, tick: 5000, roundStartTick: 0 },
        }),
    );
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.roundPhases.length).toBeGreaterThan(0);
    expect(h.rec.roundPhases.every((p) => p === null)).toBe(true);
    h.handle.dispose();
  });
});

describe('startGameWith: level progression', () => {
  it('builds the opening world at levels.start and tells the HUD where it is', () => {
    const h = boot(makeDeps({ levelCount: 3, levelStart: 1 }));
    expect(h.rec.levelBuilds[0]).toEqual({ level: 1, lives: undefined });
    expect(h.rec.hudLevels[0]).toEqual([2, 3]); // 1-based for humans
    h.handle.dispose();
  });

  it('advances one level on an intermediate win, carrying the surviving lives', () => {
    // Lives 2, deliberately NOT the fresh-world LIVES (3): with the default fixture
    // this assertion could not tell "carried the survivor count" from "handed out a
    // fresh set" -- the mutation `carried = LIVES` passed it.
    const won = { ...createArenaWorld(1), lives: 2 };
    const h = boot(makeDeps({ levelCount: 2, world: won }));
    h.setState('win');
    h.hud.startRestart();
    expect(h.rec.levelBuilds[1]).toEqual({ level: 1, lives: 2 });
    expect(h.rec.hudLevels[1]).toEqual([2, 2]);
    // The FSM transition, not only the world rebuild -- Task 5's own wiring moved
    // this arm's `sm.restart()` off a trailing statement shared with the versus/
    // campaign branches into its own call inside `if (next !== null)`. Fails if that
    // call was dropped in the move: the world rebuild above would still happen (it
    // is unconditional) while the HUD stayed on the win screen underneath it.
    expect(h.getState()).toBe('playing');
    h.handle.dispose();
  });

  it('rebinds the audio director to the NEW world\'s player, not the old id', () => {
    // loadArena numbers tanks in scan order, so the player id is arena-dependent
    // (16 in ARENA_01, 15 in ARENA_02). The fake mirrors that: level 1's player id
    // differs from level 0's by exactly 71, so a loop that forgets to re-read the id
    // from the new world rebinds the STALE one and fails here.
    const h = boot(makeDeps({ levelCount: 2 }));
    h.setState('win');
    h.hud.startRestart();
    expect(h.rec.directorRebinds).toHaveLength(1);
    expect(h.rec.directorRebinds[0]).toBe(h.rec.directorPlayerIds[0] + 71);
    h.handle.dispose();
  });

  it('rebinds haptics to the NEW world\'s player too, on the same switch', () => {
    const h = boot(makeDeps({ levelCount: 2 }));
    h.setState('win');
    h.hud.startRestart();
    expect(h.rec.hapticsRebinds).toHaveLength(1);
    expect(h.rec.hapticsRebinds[0]).toBe(h.rec.hapticsPlayerIds[0] + 71);
    h.handle.dispose();
  });

  it('resets to the starting level with fresh lives on a game over', () => {
    const h = boot(makeDeps({ levelCount: 2, levelStart: 1 }));
    h.setState('lose');
    h.hud.startRestart();
    // levels.start, not 0: a dev who jumped to level 2 retries level 2. Game over
    // ends the active run (issue #153), and no run existed here (this test never
    // called New Game), so Retry's landOnCampaignBoard(true) creates a fresh one --
    // explicit LIVES now, not the `undefined`-defaults-to-LIVES this used to be.
    expect(h.rec.levelBuilds[1]).toEqual({ level: 1, lives: LIVES });
    h.handle.dispose();
  });

  it('treats the final win as Play Again at the furthest unlocked level, fresh lives', () => {
    // Everything that leaves a run -- quit, game over, the final win -- returns to
    // the LIVE furthest-unlocked level (user decision 2026-07-31). Having cleared
    // the whole two-level game, that is the last level; the level row goes back.
    const h = boot(makeDeps({ levelCount: 2 }));
    h.setState('win');
    h.hud.startRestart(); // -> level 1, the last
    h.setState('win');
    h.hud.startRestart(); // final win -> furthest unlocked, which is now level 2
    // Campaign completion ends the run (issue #153); no run was ever explicitly
    // started here, so the restart's landOnCampaignBoard(true) creates a fresh one.
    expect(h.rec.levelBuilds[2]).toEqual({ level: 1, lives: LIVES });
    h.handle.dispose();
  });
});

describe('startGameWith: pause', () => {
  it('Escape pauses a playing game and Escape resumes it, without a rebuild', () => {
    const h = boot(makeDeps());
    h.setState('playing');
    h.keydown({ key: 'Escape' });
    expect(h.getState()).toBe('paused');
    h.keydown({ key: 'Escape' });
    expect(h.getState()).toBe('playing');
    expect(h.rec.levelBuilds).toHaveLength(1); // pausing is not a restart
    h.handle.dispose();
  });

  it('P pauses too, but a repeat or a focused control does not', () => {
    const h = boot(makeDeps());
    h.setState('playing');
    h.keydown({ key: 'p', repeat: true });
    expect(h.getState()).toBe('playing');
    h.keydown({ key: 'P' });
    expect(h.getState()).toBe('paused');
    h.handle.dispose();
  });

  it('does nothing on the title or a finished game', () => {
    // Population: the three non-playing, non-paused states.
    const h = boot(makeDeps());
    for (const s of ['title', 'win', 'lose'] as const) {
      h.setState(s);
      h.keydown({ key: 'Escape' });
      expect(h.getState()).toBe(s);
    }
    h.handle.dispose();
  });

  it('auto-pauses when the window blurs mid-game, and only mid-game', () => {
    // A blurred tab must not keep eating lives; a blurred title screen needs nothing.
    const h = boot(makeDeps());
    h.setState('playing');
    h.blur();
    expect(h.getState()).toBe('paused');
    h.setState('title');
    h.blur();
    expect(h.getState()).toBe('title'); // and focus never auto-resumes
    h.handle.dispose();
  });

  it('the Resume button resumes; it must NOT fall into the rebuild path', () => {
    // The action button is shared with Play Again/Retry, whose handler rebuilds the
    // world. Resume from pause has to keep the game exactly as frozen.
    const h = boot(makeDeps());
    h.setState('playing');
    h.keydown({ key: 'Escape' });
    h.hud.startRestart();
    expect(h.getState()).toBe('playing');
    expect(h.rec.levelBuilds).toHaveLength(1);
    h.handle.dispose();
  });

  it('Quit to Title returns to the title over a FRESH board at the starting level', () => {
    const h = boot(makeDeps({ levelCount: 2, levelStart: 1 }));
    h.setState('playing');
    h.keydown({ key: 'Escape' });
    h.hud.quitToTitle();
    expect(h.getState()).toBe('title');
    // Rebuilt at levels.start; no active RUN was ever started here (see
    // 'startGameWith: New Run' below for that), so lives stay undefined -- quit must
    // never CREATE a run, only read one if it already exists.
    expect(h.rec.levelBuilds[1]).toEqual({ level: 1, lives: undefined });
    expect(h.rec.hudLevels.at(-1)).toEqual([2, 2]);
    h.handle.dispose();
  });

  it('removes the blur listener on dispose, like every other host listener', () => {
    const h = boot(makeDeps());
    h.handle.dispose();
    const added = h.rec.listeners.filter(([t]) => t === 'blur').length;
    const removed = h.rec.removed.filter(([t]) => t === 'blur').length;
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });
});

describe('startGameWith: pause drops queued input', () => {
  it('clears latched fire/mine presses on EVERY entry into paused', () => {
    // Found in review: the blur path was safe (input.ts clears itself on window blur)
    // but an Esc/P pause left a latched Space press to mine on the first resumed tick.
    // Wired at the state change, so hotkey, blur and any future pause trigger all pass
    // through the same clear.
    //
    // Counted as DELTAS, not absolutes. The clear now fires on every exit from play
    // rather than only on pause -- win and lose leak the same way, which review found
    // one call site later -- so the boot transitions contribute clears of their own and
    // an absolute count would be pinning boot bookkeeping rather than this behaviour.
    const h = boot(makeDeps());
    h.setState('playing');
    const base = h.rec.inputClears;
    h.keydown({ key: 'Escape' });
    expect(h.rec.inputClears - base, 'pausing did not clear').toBe(1);
    h.keydown({ key: 'Escape' }); // resume: no extra clear
    expect(h.rec.inputClears - base, 'resuming cleared, which it must not').toBe(1);
    h.blur(); // auto-pause: clears again
    expect(h.rec.inputClears - base, 'a blur-pause did not clear').toBe(2);
    h.handle.dispose();
  });
});

describe('startGameWith: quit is pause-only', () => {
  it('ignores a quit that arrives outside pause', () => {
    // The HUD hides the button in every other state, so in production this cannot
    // fire -- but a handler that rebuilds the world deserves its own guard, not a
    // CSS class as its only defence.
    const h = boot(makeDeps());
    h.setState('playing');
    h.hud.quitToTitle();
    expect(h.getState()).toBe('playing');
    expect(h.rec.levelBuilds).toHaveLength(1); // no rebuild
    h.handle.dispose();
  });
});

describe('startGameWith: the main menu', () => {
  it('tells the HUD the unlock state at boot: cleared+1 pickable, capped at the count', () => {
    const h = boot(makeDeps({ levelCount: 2, progressHighest: 0 }));
    expect(h.rec.levelSelects[0]).toEqual([1, 2]);
    h.handle.dispose();
    const h2 = boot(makeDeps({ levelCount: 2, progressHighest: 5 }));
    expect(h2.rec.levelSelects[0]).toEqual([2, 2]); // capped: 6 of 2 is nonsense
    h2.handle.dispose();
  });

  it('records the cleared level AT the win, and refreshes the unlock state', () => {
    // At the win event, not the Next Level click: quitting after a win keeps the
    // unlock.
    const h = boot(makeDeps({ levelCount: 2 }));
    h.setState('playing');
    h.setState('win');
    expect(h.rec.cleared).toEqual([1]);
    expect(h.rec.levelSelects.at(-1)).toEqual([2, 2]);
    h.handle.dispose();
  });

  it('records nothing for a sequence that does not track progress (the sandbox)', () => {
    const h = boot(makeDeps({ levelCount: 1, tracksProgress: false }));
    h.setState('playing');
    h.setState('win');
    expect(h.rec.cleared).toEqual([]);
    h.handle.dispose();
  });

  it('a level pick from the title rebuilds at that level and starts play', () => {
    const h = boot(makeDeps({ levelCount: 2, progressHighest: 1 }));
    h.hud.pickLevel(1);
    expect(h.rec.levelBuilds[1]).toEqual({ level: 1, lives: undefined });
    expect(h.getState()).toBe('playing');
    expect(h.rec.unlocks).toBe(1); // a level click is a user gesture: unlock audio here
    h.handle.dispose();
  });

  it('ignores a pick outside the title, like every other panel-only control', () => {
    const h = boot(makeDeps({ levelCount: 2, progressHighest: 1 }));
    h.setState('playing');
    h.hud.pickLevel(1);
    expect(h.rec.levelBuilds).toHaveLength(1);
    h.handle.dispose();
  });

  it('picking level 1 from the Levels panel starts level 1 and leaves recorded progress untouched', () => {
    // Before issue #153, hud.ts's New Game button reused this EXACT wiring (fired
    // onLevelSelect with 0, the same event as clicking level 1 in the panel) --
    // deliberately no longer true, see 'startGameWith: New Run' below. This test now
    // pins Level Select's own level-1 pick: it starts level 1 with fresh lives and
    // must not re-lock anything a prior session already unlocked, same as any other
    // practice pick.
    const h = boot(makeDeps({ levelCount: 3, progressHighest: 2 })); // level 3 already unlocked
    h.hud.pickLevel(0);
    expect(h.rec.levelBuilds.at(-1)).toEqual({ level: 0, lives: undefined });
    expect(h.getState()).toBe('playing');
    expect(h.deps.progress.highestCleared(), 'practice must not re-lock anything').toBe(2);
    // And it must not be mistaken for New Game: no run was touched.
    expect(h.rec.runNewRuns).toEqual([]);
    h.handle.dispose();
  });
});

describe('startGameWith: a level pick is bounds-checked', () => {
  it('ignores an out-of-range index rather than indexing past the sequence', () => {
    // The HUD only wires clicks for unlocked buttons, but a handler that rebuilds the
    // world from ARENAS[picked] deserves its own guard -- ARENAS[7] is undefined and
    // loadArena(undefined) is a crash, not a shrug.
    const h = boot(makeDeps({ levelCount: 2 }));
    h.hud.pickLevel(7);
    h.hud.pickLevel(-1);
    expect(h.rec.levelBuilds).toHaveLength(1); // only the boot build
    expect(h.getState()).toBe('title');
    h.handle.dispose();
  });
});

describe('startGameWith: quit and retry follow LIVE progress', () => {
  it('quit after unlocking a level this session rebuilds at the NEW furthest level', () => {
    // Reported 2026-07-31: clear level 1, advance, quit -- the menu background
    // rebuilt at level 1 even though level 2 was now unlocked, because levels.start
    // was a boot-time snapshot of saved progress.
    const h = boot(makeDeps({ levelCount: 2 }));
    h.setState('playing');
    h.setState('win'); // clears level 1 -> level 2 unlocked
    h.hud.startRestart(); // advance to level 2
    h.keydown({ key: 'Escape' });
    h.hud.quitToTitle();
    expect(h.rec.levelBuilds.at(-1)).toEqual({ level: 1, lives: undefined });
    h.handle.dispose();
  });

  it('game over after a mid-session unlock retries at the furthest level too', () => {
    const h = boot(makeDeps({ levelCount: 2 }));
    h.setState('playing');
    h.setState('win');
    h.hud.startRestart(); // now on level 2
    h.setState('lose');
    h.hud.startRestart(); // retry
    // No run was ever explicitly started (New Game) here, so game over's endRun() is
    // a no-op and Retry's landOnCampaignBoard(true) creates a fresh one at the same
    // live furthest-unlocked level -- explicit LIVES now, not undefined.
    expect(h.rec.levelBuilds.at(-1)).toEqual({ level: 1, lives: LIVES });
    h.handle.dispose();
  });
});

describe('startGameWith: invincibility (dev playtest mode)', () => {
  const playerOf = (w: World): Tank | undefined => w.tanks.find((t) => t.kind === 'player');

  it('marks the PLAYER invincible in every world it builds, and only the player', () => {
    const h = boot(makeDeps({ levelCount: 2, devFlags: { invincible: true } }));
    h.setState('win');
    h.hud.startRestart(); // the advance rebuild must apply it too, not just boot
    // Population: both worlds built so far (boot + advance).
    expect(h.rec.builtWorlds).toHaveLength(2);
    for (const w of h.rec.builtWorlds) {
      expect(playerOf(w)?.invincible).toBe(true);
      expect(w.tanks.filter((t) => t.kind !== 'player').every((t) => t.invincible === undefined)).toBe(true);
    }
    h.handle.dispose();
  });

  it('marks nobody without the flag', () => {
    const h = boot(makeDeps());
    expect(playerOf(h.rec.builtWorlds[0])?.invincible).toBeUndefined();
    h.handle.dispose();
  });
});

describe('startGameWith: per-level renderer refit', () => {
  it('refits the renderer when a rebuild lands on a different board', () => {
    const h = boot(makeDeps({
      levelCount: 2,
      boundsByLevel: [
        { width: 22, height: 18, cellSize: 2 },
        { width: 30, height: 18, cellSize: 2 },
      ],
    }));
    h.setState('win');
    h.hud.startRestart(); // advance to the wider level 2
    expect(h.rec.refits).toEqual([[30, 18, 2]]);
    h.handle.dispose();
  });

  it('does NOT refit for a same-size rebuild: a respawn-restart is not a new board', () => {
    const h = boot(makeDeps({ levelCount: 1 }));
    h.setState('lose');
    h.hud.startRestart(); // retry the same level
    expect(h.rec.refits).toEqual([]);
    h.handle.dispose();
  });
});

describe('startGameWith: stats wiring', () => {
  it('feeds every frame\'s events to the store, attributed to the CURRENT player id', () => {
    // The world is LIVE with an armed mine whose fuse expires within the first tick,
    // so the frame is guaranteed eventful. Review found the first version of this
    // test fired a COUNTDOWN frame: the driver only calls onFrameEvents on eventful
    // frames, so the assertion loop ran zero times and proved nothing.
    const world = { ...createArenaWorld(1), roundStartTick: -100000 };
    world.mines.push({ id: 500, ownerId: 99, pos: { x: 1, y: 1 }, timer: 0.001, armed: true, detonated: false });
    const h = boot(makeDeps({ world }));
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.statBatches.length).toBeGreaterThan(0); // the frame really was eventful
    const player = world.tanks.find((t) => t.kind === 'player')!;
    for (const b of h.rec.statBatches) expect(b.playerId).toBe(player.id);
    h.handle.dispose();
  });

  it('starts a fresh attempt tally at boot and on every level switch', () => {
    const h = boot(makeDeps({ levelCount: 2 }));
    expect(h.rec.statAttemptStarts).toBe(1); // boot
    h.setState('win');
    h.hud.startRestart(); // advance
    expect(h.rec.statAttemptStarts).toBe(2);
    h.setState('playing');
    h.keydown({ key: 'Escape' });
    h.hud.quitToTitle(); // quit rebuild
    expect(h.rec.statAttemptStarts).toBe(3);
    h.handle.dispose();
  });

  it('Reset stats zeroes the lifetime and refreshes the page', () => {
    const h = boot(makeDeps());
    const pushesBefore = h.rec.statPushes;
    h.hud.resetStats();
    expect(h.rec.statResets).toBe(1);
    expect(h.rec.statPushes).toBe(pushesBefore + 1); // exactly one refresh per reset
    h.handle.dispose();
  });

  it('Reset progress re-locks levels and refreshes the level select', () => {
    const h = boot(makeDeps({ levelCount: 2, progressHighest: 1 }));
    expect(h.rec.levelSelects.at(-1)).toEqual([2, 2]); // level 2 open at boot
    h.hud.resetProgress();
    expect(h.rec.progressResets).toBe(1);
    expect(h.rec.levelSelects.at(-1)).toEqual([1, 2]); // re-locked
    h.handle.dispose();
  });
});

describe('startGameWith: gamepad connect toast (issue #114)', () => {
  it('passes the gamepad devFlag through to createInput, off by default', () => {
    const off = boot(makeDeps());
    expect(off.rec.inputOptions).toEqual([{ gamepad: false }]);
    off.handle.dispose();

    const on = boot(makeDeps({ devFlags: { gamepad: true } }));
    expect(on.rec.inputOptions).toEqual([{ gamepad: true }]);
    on.handle.dispose();
  });

  it('toasts once on the tick input.gamepadConnected() first reports true', () => {
    const h = boot(makeDeps());
    h.setState('playing');
    h.setGamepadConnected(true);
    h.fireFrame(100); // several simulated ticks, all seeing the pad already connected
    expect(h.rec.plainToasts).toEqual(['Gamepad connected']);
    h.handle.dispose();
  });

  it('does not toast again while the pad stays connected across later frames', () => {
    const h = boot(makeDeps());
    h.setState('playing');
    h.setGamepadConnected(true);
    h.fireFrame(100);
    h.fireFrame(200);
    h.fireFrame(300);
    expect(h.rec.plainToasts).toEqual(['Gamepad connected']); // still exactly one
    h.handle.dispose();
  });

  it('never toasts when no pad is ever seen', () => {
    const h = boot(makeDeps());
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.plainToasts).toEqual([]);
    h.handle.dispose();
  });

  it('toasts on both edges across a disconnect/reconnect cycle (controller assignment UI: ' +
    'falling-edge disconnect toast)', () => {
    const h = boot(makeDeps());
    h.setState('playing');
    h.setGamepadConnected(true);
    h.fireFrame(100);
    h.setGamepadConnected(false);
    h.fireFrame(200);
    h.setGamepadConnected(true);
    h.fireFrame(300);
    expect(h.rec.plainToasts).toEqual([
      'Gamepad connected',
      'Gamepad disconnected',
      'Gamepad connected',
    ]);
    h.handle.dispose();
  });
});

describe('startGameWith: per-slot gamepad connect toast (pad[i] -> slot[i], n-player arc PR3)', () => {
  // Every test in the describe block above already pins this at `players` unset --
  // this one restates it explicitly as the regression signal for THIS PR's surface:
  // slot 0's toast copy and rising-edge rule must not move when this file's per-slot
  // array replaces the old single boolean.
  it("slot 0's existing single-player toast behaviour is UNCHANGED when only it has a pad (players unset)", () => {
    const h = boot(makeDeps());
    h.setState('playing');
    h.setGamepadConnected(true);
    h.fireFrame(100);
    expect(h.rec.plainToasts).toEqual(['Gamepad connected']);
    h.handle.dispose();
  });

  it('players=3: slot 2 toasts its OWN rising edge, copy named to the slot ("Player 3")', () => {
    const h = boot(makeDeps({ devFlags: { players: 3 } }));
    h.setState('playing');
    h.setSlotGamepadConnected(2, true);
    h.fireFrame(100);
    expect(h.rec.plainToasts).toEqual(["Player 3's controller connected"]);
    h.handle.dispose();
  });

  it('players=4: slots 1, 2 and 3 each toast independently, named to THEIR OWN slot, in the order their edges actually rise (not slot order)', () => {
    const h = boot(makeDeps({ devFlags: { players: 4 } }));
    h.setState('playing');
    h.setSlotGamepadConnected(1, true);
    h.fireFrame(100);
    h.setSlotGamepadConnected(3, true);
    h.fireFrame(200);
    h.setSlotGamepadConnected(2, true);
    h.fireFrame(300);
    expect(h.rec.plainToasts).toEqual([
      "Player 2's controller connected",
      "Player 4's controller connected",
      "Player 3's controller connected",
    ]);
    h.handle.dispose();
  });

  it('players=2: slot 0 and slot 1 toast INDEPENDENTLY -- connecting one does not toast the other, and both can toast in the same session', () => {
    const h = boot(makeDeps({ devFlags: { players: 2 } }));
    h.setState('playing');
    h.setSlotGamepadConnected(1, true);
    h.fireFrame(100);
    expect(h.rec.plainToasts).toEqual(["Player 2's controller connected"]);
    h.setGamepadConnected(true); // slot 0's own merge connects too, later
    h.fireFrame(200);
    expect(h.rec.plainToasts).toEqual(["Player 2's controller connected", 'Gamepad connected']);
    h.handle.dispose();
  });

  it('a bot-claimed slot never toasts: there is no PlayerInputSource there to report connected', () => {
    const h = boot(makeDeps({ devFlags: { players: 2, bots: 1 } })); // slot 1 is the bot
    h.setState('playing');
    h.fireFrame(500);
    expect(h.rec.plainToasts).toEqual([]);
    h.handle.dispose();
  });

  it('HOTPLUG at a non-zero slot (index 2): connecting mid-session toasts once, a later ' +
    'disconnect toasts too (controller assignment UI: falling-edge disconnect toast), and a ' +
    'reconnect toasts again -- both edges, the same rule slot 0 already had', () => {
    const h = boot(makeDeps({ devFlags: { players: 3 } }));
    h.setState('playing');
    h.fireFrame(100); // no pad yet at slot 2
    expect(h.rec.plainToasts).toEqual([]);
    h.setSlotGamepadConnected(2, true); // hotplug: connect mid-session
    h.fireFrame(200);
    expect(h.rec.plainToasts).toEqual(["Player 3's controller connected"]);
    h.setSlotGamepadConnected(2, false); // hotplug: disconnect mid-session
    h.fireFrame(300);
    h.setSlotGamepadConnected(2, true); // hotplug: reconnect
    h.fireFrame(400);
    expect(h.rec.plainToasts).toEqual([
      "Player 3's controller connected",
      "Player 3's controller disconnected",
      "Player 3's controller connected",
    ]);
    h.handle.dispose();
  });
});

describe('startGameWith: couch co-op input routing (players devflag)', () => {
  // (a) The regression signal: `players` unset (playerCount 1) must leave every
  // pre-existing fake and assertion in this file unchanged. The other 201 tests in this
  // file already prove this by construction (none of them touch `players`, and all pass
  // unmodified against the harness changes this PR made) -- this test states the
  // invariant explicitly, for the specific new surfaces this PR added, so a future
  // change that leaks multiplayer machinery into the off path fails HERE rather than
  // only being caught implicitly.
  it('players unset: no gamepad source is built, no playerCount is passed, slot 1 never samples or receives a position', () => {
    const h = boot(makeDeps());
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.gamepadSourceBuilds).toBe(0);
    expect(h.rec.playerCounts).toEqual([undefined]);
    expect(h.rec.slot1Samples).toBe(0);
    expect(h.rec.slot1Positions).toEqual([]);
    // Slot 0's own gamepad option is governed by `gamepad` alone, exactly as before
    // this PR -- `players` unset must not perturb it either way.
    expect(h.rec.inputOptions).toEqual([{ gamepad: false }]);
    h.handle.dispose();
    expect(h.rec.slot1Disposed).toBe(false); // nothing was ever built to dispose
  });

  // (b) The §5 integration test: ties input-slot order to loadArena's REAL
  // controlledBy alignment, not a hand-built fixture. deps.levels.world's fake
  // constructs a genuine 2-player world via createWorldFor/loadArena when handed
  // playerCount 2 (see the `world:` fake above), so `controlledBy === i` here is the
  // production spawn rule, not a stand-in for it.
  it('players=2: builds a REAL 2-player world (playerCount 2), and each slot\'s setPlayerPosition receives its OWN controlledBy tank\'s position', () => {
    const h = boot(makeDeps({ devFlags: { players: 2 } }));
    expect(h.rec.playerCounts).toEqual([2]);
    expect(h.rec.gamepadSourceBuilds).toBe(1);
    expect(h.rec.gamepadSourceBuildIndices).toEqual([1]); // pad[1] -> slot[1]
    // Slot 0's own gamepad option is governed by `deps.devFlags.gamepad` alone (default
    // off here) -- see the "players=2 + gamepad=1" test below for the reversed rule
    // that lets it be on too, composing with slot 1's own dedicated reader.
    expect(h.rec.inputOptions).toEqual([{ gamepad: false }]);

    const world = h.rec.builtWorlds[0];
    const p0 = world.tanks.find((t: Tank) => t.kind === 'player' && t.controlledBy === 0)!;
    const p1 = world.tanks.find((t: Tank) => t.kind === 'player' && t.controlledBy === 1)!;
    expect(p0).toBeDefined();
    expect(p1).toBeDefined();
    expect(p0.pos).not.toEqual(p1.pos); // sanity: a real, distinct co-op spawn pair

    h.setState('playing');
    h.fireFrame(100); // several simulated ticks, past countdown (world is back-dated)

    expect(h.rec.playerPosPushes).toBeGreaterThan(0);
    expect(h.rec.slot1Positions.length).toBeGreaterThan(0);
    expect(h.rec.slot1Positions.every((pos) => pos !== null)).toBe(true);

    // Slot 0's fake never moves (move is always {x:0,y:0}); slot 1's fake always
    // drives +x. So by the last frame, the tank slot 0 was pushed the position OF
    // has NOT moved from spawn, and the one slot 1 was pushed HAS -- proving the two
    // positions are not just both non-null, but each tied to the RIGHT tank.
    const lastSlot0Pos = h.rec.lastPlayerPos!;
    const lastSlot1Pos = h.rec.slot1Positions[h.rec.slot1Positions.length - 1]!;
    expect(lastSlot0Pos.x).toBeCloseTo(p0.pos.x, 6);
    expect(lastSlot1Pos.x).toBeGreaterThan(p1.pos.x);
    h.handle.dispose();
    expect(h.rec.slot1Disposed).toBe(true);
  });

  // (c) THE NAMED TRADEOFF, pinned here at the wiring level (gamepad.test.ts pins the
  // same tradeoff at the pure-function level). Under `pad[i] -> slot[i]`, slot 0's own
  // `?dev=1&gamepad=1` merge is NO LONGER forced off once a second player exists -- it
  // composes freely with any co-player slot's dedicated reader, because the two read
  // DIFFERENT pad indices. This is a deliberate reversal of the pre-PR3 rule (slot 0
  // always gamepad:false once players >= 2), which existed only to keep slot 0 off the
  // SAME index slot 1 used to own. The cost: a session's only physical pad (almost
  // always browser index 0) now feeds slot 0 here, not slot 1 -- "P1 keyboard, hand the
  // one pad to P2" has no zero-flag path anymore. Accepted, not fixed -- see
  // docs/superpowers/plans/2026-08-17-controllers-4.md.
  it('players=2 + gamepad=1 together: slot 0 now HONOURS its own gamepad flag (the reversed rule), and slot 1 still gets its own dedicated source at padIndex 1', () => {
    const h = boot(makeDeps({ devFlags: { players: 2, gamepad: true } }));
    expect(h.rec.inputOptions).toEqual([{ gamepad: true }]);
    // Slot 0's merge goes through createInput's own `gamepad` option, not through
    // deps.createGamepadSource -- so this factory is still called exactly once, for
    // slot 1 alone, whether or not slot 0's flag is on.
    expect(h.rec.gamepadSourceBuilds).toBe(1);
    expect(h.rec.gamepadSourceBuildIndices).toEqual([1]);
    h.handle.dispose();
  });

  // (d) The sandbox exclusion: createSandboxWorld takes no playerCount and has no
  // co-op spawn rule to inherit from loadArena, so `players` must degrade to a single
  // slot rather than either crashing or silently no-opping.
  it('players=2 + level=sandbox: degrades to a single-slot session -- no gamepad source, no playerCount 2', () => {
    const h = boot(makeDeps({ devFlags: { players: 2, level: 'sandbox' } }));
    expect(h.rec.gamepadSourceBuilds).toBe(0);
    expect(h.rec.playerCounts).toEqual([undefined]);
    // Slot 0 is unaffected: with the sandbox excluding multiplayer, its own gamepad
    // option reverts to devFlags.gamepad alone (off here, matching every
    // single-player boot).
    expect(h.rec.inputOptions).toEqual([{ gamepad: false }]);
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.slot1Samples).toBe(0);
    expect(h.rec.slot1Positions).toEqual([]);
    h.handle.dispose();
  });

  // (e)-(g): N=3/4, `pad[i] -> slot[i]` for EVERY co-player slot (n-player arc PR3) --
  // slot 1 no longer gets special treatment: slots 2 and 3 get their OWN dedicated
  // createGamepadSource(padIndex) call too, not a separate idle-fill function. The
  // build COUNT and the padIndex SEQUENCE are the load-bearing wiring assertions here;
  // the "no pad connected -> idle hold" behaviour itself is pinned once, at the pure-
  // function level, in gamepad.test.ts's "no-pad-ever-connected" describe block through
  // the REAL `createGamepadInputSource` -- re-deriving it here through this file's
  // always-driving fake would test the fake, not the production code.
  it('players=3: builds ONE gamepad source per co-player slot (padIndex 1 and 2, not just slot 1), each driving its OWN controlledBy tank', () => {
    const h = boot(makeDeps({ devFlags: { players: 3 } }));
    expect(h.rec.playerCounts).toEqual([3]);
    expect(h.rec.gamepadSourceBuilds).toBe(2); // slots 1 and 2
    expect(h.rec.gamepadSourceBuildIndices).toEqual([1, 2]); // pad[i] -> slot[i], in slot order

    const spawned = h.rec.builtWorlds[0].tanks.filter((t: Tank) => t.kind === 'player');
    expect(spawned).toHaveLength(3);
    const spawnPos2 = { ...spawned.find((t: Tank) => t.controlledBy === 2)!.pos };

    h.setState('playing');
    // `builtWorlds[0]` is the object `deps.levels.world` returned at BOOT -- the driver
    // never mutates it in place (`step` clones every tick and the driver reassigns its
    // OWN internal `curr`), so reading it again here would see the frozen spawn state
    // regardless of what slot 2's source actually did. `renders.at(-1)!.curr` is the
    // live world the LAST completed frame actually simulated.
    h.fireFrame(500);
    const live2 = h.rec.renders.at(-1)!.curr.tanks.find((t: Tank) => t.controlledBy === 2)!;
    expect(live2).toBeDefined();
    // The fake at padIndex 2 always drives +x -- proving slot 2's OWN source was
    // sampled and applied to slot 2's OWN tank, not slot 0's or slot 1's.
    expect(live2.pos.x).toBeGreaterThan(spawnPos2.x);
    h.handle.dispose();
    expect(h.rec.slotDisposed[2]).toBe(true);
  });

  it('players=4: builds one gamepad source for EACH of slots 1, 2 and 3 (padIndex sequence [1,2,3]), each driving its own tank', () => {
    const h = boot(makeDeps({ devFlags: { players: 4 } }));
    expect(h.rec.playerCounts).toEqual([4]);
    expect(h.rec.gamepadSourceBuilds).toBe(3);
    expect(h.rec.gamepadSourceBuildIndices).toEqual([1, 2, 3]);

    const spawned = h.rec.builtWorlds[0].tanks.filter((t: Tank) => t.kind === 'player');
    expect(spawned).toHaveLength(4);
    const spawnPositions = new Map(
      [1, 2, 3].map((slot) => [slot, { ...spawned.find((t: Tank) => t.controlledBy === slot)!.pos }]),
    );

    h.setState('playing');
    h.fireFrame(500);
    const liveTanks = h.rec.renders.at(-1)!.curr.tanks;
    for (const slot of [1, 2, 3]) {
      const p = liveTanks.find((t: Tank) => t.controlledBy === slot)!;
      expect(p, `slot ${slot}`).toBeDefined();
      expect(p.pos.x, `slot ${slot} moved`).toBeGreaterThan(spawnPositions.get(slot)!.x);
    }
    h.handle.dispose();
    for (const slot of [1, 2, 3]) expect(h.rec.slotDisposed[slot]).toBe(true);
  });

  it('players=1 (explicit no-op): behaves identically to players unset', () => {
    const h = boot(makeDeps({ devFlags: { players: 1 } }));
    expect(h.rec.playerCounts).toEqual([undefined]);
    expect(h.rec.gamepadSourceBuilds).toBe(0);
    h.handle.dispose();
  });
});

describe('botSlotsFor: bots=K fills the LAST K of N slots', () => {
  // Mutation 1 (bots plan, red-first): fill first-K instead of last-K. A first-K rule
  // would return {0,1} here, not {2,3} -- the assertion below is the exact one that
  // catches it.
  it('claims the highest-numbered slots, not the lowest', () => {
    expect(botSlotsFor(4, 2)).toEqual(new Set([2, 3]));
    expect(botSlotsFor(4, 1)).toEqual(new Set([3]));
    expect(botSlotsFor(4, 3)).toEqual(new Set([1, 2, 3]));
  });

  it('K=0 claims nothing', () => {
    expect(botSlotsFor(4, 0)).toEqual(new Set());
    expect(botSlotsFor(1, 0)).toEqual(new Set());
  });

  it('K=N claims every slot, including slot 0 -- the fully autonomous match owner directive 1 asks for', () => {
    expect(botSlotsFor(4, 4)).toEqual(new Set([0, 1, 2, 3]));
    expect(botSlotsFor(1, 1)).toEqual(new Set([0]));
  });
});

describe('createBotSources / BOT_SEED_SPACING: independence from every enemy-AI stream', () => {
  // Every per-tank enemy stream in targeting.ts (wanderMove, seekMove's retreat draw,
  // mineInclination, aimJitter) hashes `world.seed + tank.id * PRIME + bucket` with
  // PRIME one of {1000, 4243, 6101, 7919}, tank.id >= 1 (arena.ts's grid-scan counter
  // starts at 1) and bucket >= 0. The smallest value ANY of those keys can ever take is
  // therefore exactly `world.seed + 1000` (id=1, bucket=0, the smallest prime) -- so any
  // bot key strictly BELOW `world.seed` can never equal one, for any prime, not only
  // today's four.
  it('every bot key (world.seed - BOT_SEED_SPACING + slot, slot 0-3) is strictly less than world.seed, and every enemy key (world.seed + PRIME + 0, id=1 bucket=0, the smallest reachable case per prime) is strictly greater -- so they cannot coincide', () => {
    const seed = 7919; // arbitrary -- one of the enemy primes itself, deliberately, to
    // make sure a naive "seed happens to be small" argument isn't doing the work.
    const primes = [1000, 4243, 6101, 7919];
    for (let slot = 0; slot <= 3; slot++) {
      const botKey = seed - BOT_SEED_SPACING + slot;
      expect(botKey).toBeLessThan(seed);
      for (const prime of primes) {
        const enemyKey = seed + 1 * prime + 0; // id=1, bucket=0: the smallest this prime reaches
        expect(enemyKey).toBeGreaterThan(seed);
        expect(botKey).not.toBe(enemyKey);
      }
    }
  });

  // Mutation 2 (bots plan, red-first): the n-player arc design's own draft used
  // `mulberry32(seed + 1000 + slot)` -- an ADDITIVE offset of 1000, not a subtracted
  // spacing. This test states the exact collision that draft had, so the test above is
  // provably not vacuous: it is the one case (slot 0, id 1, bucket 0) where an additive
  // offset of 1000 hits the wander stream's own key exactly.
  it("the plan draft's offset (seed + 1000 + slot) DOES collide with wanderMove's key at slot 0 -- the reason BOT_SEED_SPACING subtracts instead", () => {
    const seed = 7919;
    const draftBotKey = seed + 1000 + 0; // the rejected draft, slot 0
    const wanderKey = seed + 1 * 1000 + 0; // wanderMove, tank.id=1, bucket=0
    expect(draftBotKey).toBe(wanderKey);
  });

  it('seeds every claimed slot independently, with its own PlayerAiState object', () => {
    const sources = createBotSources(100, new Set([0, 2]));
    expect(sources.size).toBe(2);
    expect(sources.has(1)).toBe(false);
    const s0 = sources.get(0)!;
    const s2 = sources.get(2)!;
    expect(s0.state).not.toBe(s2.state);
    expect(s0.rnd()).not.toBe(s2.rnd());
  });

  it('is a pure function of seed and slot set -- same inputs, same first draw', () => {
    const a = createBotSources(555, new Set([0])).get(0)!;
    const b = createBotSources(555, new Set([0])).get(0)!;
    expect(a.rnd()).toBe(b.rnd());
  });
});

describe('startGameWith: bots (createBotInputSource, bots=K)', () => {
  it('bots unset behaves identically to today: one gamepad source per co-player slot (PR3 baseline), unaffected by bots being off', () => {
    const h = boot(makeDeps({ devFlags: { players: 4 } }));
    expect(h.rec.gamepadSourceBuilds).toBe(3); // slots 1, 2, 3 -- no bots to claim any of them
    expect(h.rec.gamepadSourceBuildIndices).toEqual([1, 2, 3]);
    h.handle.dispose();
  });

  it('bots=2 at players=4 fills the LAST 2 slots (2 and 3): slot 1\'s real gamepad source is still built, slots 2/3 build NONE (mutation-1 discriminator -- a first-K rule would instead leave slot 1 at 0 and build slots 0/1)', () => {
    const h = boot(makeDeps({ devFlags: { players: 4, bots: 2 } }));
    expect(h.rec.playerCounts).toEqual([4]);
    expect(h.rec.gamepadSourceBuilds).toBe(1); // slot 1 only -- slots 2 and 3 are bot-claimed
    expect(h.rec.gamepadSourceBuildIndices).toEqual([1]);
    h.setState('playing');
    h.fireFrame(100);
    // Slot 1's real gamepad fake is sampled (it was built and is not bot-claimed).
    expect(h.rec.slot1Samples).toBeGreaterThan(0);
    h.handle.dispose();
  });

  // The n-player arc's PR3 composition claim, the exact scenario named in its own
  // doc comment: bots claim their declared slots FIRST (by dev-flag declaration,
  // known at session start), controllers fill whatever remains in `pad[i] -> slot[i]`
  // order. Spied via the construction count -- the established pattern this file
  // already uses for "was a collaborator built" claims (see GameDeps's own doc
  // comment on createGamepadSource).
  it('bots=1 & players=2: slot 1 is the bot, slot 0 is keyboard(+optional pad) -- the bot slot must NOT construct a gamepad source', () => {
    const h = boot(makeDeps({ devFlags: { players: 2, bots: 1 } }));
    expect(h.rec.gamepadSourceBuilds).toBe(0); // slot 1, the only non-zero slot, is bot-claimed
    expect(h.rec.gamepadSourceBuildIndices).toEqual([]);
    h.setState('playing');
    h.fireFrame(500);
    expect(h.rec.samples).toBeGreaterThan(0); // slot 0's real keyboard/mouse/touch controller IS sampled
    h.handle.dispose();
  });

  it('bots=playerCount claims every slot, including slot 0: no gamepad source is built and the real keyboard controller never samples', () => {
    const h = boot(makeDeps({ devFlags: { players: 3, bots: 3 } }));
    expect(h.rec.gamepadSourceBuilds).toBe(0);
    h.setState('playing');
    h.fireFrame(500);
    expect(h.rec.samples).toBe(0); // input.sample() (slot 0's real fake) never called
    expect(h.rec.slot1Samples).toBe(0); // no gamepad source was even built
    h.handle.dispose();
  });

  it('bots=1 with players unset claims the sole slot -- the fully autonomous single-tank match owner directive 1 asks for', () => {
    const h = boot(makeDeps({ devFlags: { bots: 1 } }));
    h.setState('playing');
    h.fireFrame(500);
    expect(h.rec.samples).toBe(0); // the bot drives instead of the real input controller
    h.handle.dispose();
  });

  it('a bot-claimed idle slot (2 or 3) is bot-DRIVEN, not idle-held: it moves off spawn in a real multiplayer world with live enemies', () => {
    // Contrast with the players=4 test above (no bots), which pins the OPPOSITE
    // claim for a real idle slot: turretAngle frozen, position exactly at spawn.
    // decidePlayerInput's move is `avoid ?? seekLikeMove(...)`, and seekLikeMove
    // never returns the zero vector (it falls back to a wander heading), so a
    // bot-driven tank always has a nonzero move each tick -- unlike idle's
    // literal `{x:0,y:0}`.
    const h = boot(makeDeps({ devFlags: { players: 4, bots: 2, seed: 42 } }));
    const spawned = h.rec.builtWorlds[0].tanks.filter((t: Tank) => t.kind === 'player');
    const spawnPos3 = { ...spawned.find((t: Tank) => t.controlledBy === 3)!.pos };
    h.setState('playing');
    h.fireFrame(2000); // many ticks -- plenty of chances to move
    const live3 = h.rec.renders.at(-1)!.curr.tanks.find((t: Tank) => t.controlledBy === 3)!;
    expect(live3).toBeDefined();
    const moved =
      Math.abs(live3.pos.x - spawnPos3.x) > 1e-6 || Math.abs(live3.pos.y - spawnPos3.y) > 1e-6;
    expect(moved).toBe(true);
    h.handle.dispose();
  });

  it('bots=4 + gamepad=1 together: createInput still receives gamepad:true (unconditional on devFlags.gamepad alone, unaffected by bots or playerCount), even though slot 0 is bot-claimed and never samples it', () => {
    const h = boot(makeDeps({ devFlags: { players: 4, bots: 4, gamepad: true } }));
    expect(h.rec.inputOptions).toEqual([{ gamepad: true }]);
    expect(h.rec.gamepadSourceBuilds).toBe(0); // every slot is bot-claimed
    h.handle.dispose();
  });

  it('bots=4 with players=2 clamps to the resolved playerCount: BOTH slots are claimed, not an error on the unreachable 4th', () => {
    // Both values are individually valid (bots' own range is 0-4, players' is 1-4);
    // the clamp is loop.ts's own Math.min(devFlags.bots, playerCount), since the two
    // flags parse independently and neither parser can see the other's value.
    const h = boot(makeDeps({ devFlags: { players: 2, bots: 4 } }));
    expect(h.rec.gamepadSourceBuilds).toBe(0); // slot 1 IS bot-claimed once clamped to 2
    h.setState('playing');
    h.fireFrame(500);
    expect(h.rec.samples).toBe(0); // slot 0 too
    h.handle.dispose();
  });

  it('autoplay takes precedence over a bot claiming slot 0: neither substitute ever samples the real input controller', () => {
    // Both flags claim slot 0. Whichever wins, the real input controller must not be
    // sampled (both substitute), and dispose must not throw walking realSources.
    const h = boot(makeDeps({ devFlags: { players: 2, bots: 2, autoplay: true } }));
    h.setState('playing');
    h.fireFrame(500);
    expect(h.rec.samples).toBe(0);
    h.handle.dispose();
  });

  it('autoplay actually DRIVES slot 0 when both claim it, not the bot: proven through the same wallMs-vs-seed signal the reproducibility test below uses', () => {
    // autoplay's stream is wallMs()-seeded; a bot's is world.seed-seeded. With `seed`
    // pinned identically across two sessions but wallMs DIFFERENT, slot 0's trajectory
    // must DIVERGE if autoplay is really the one driving it -- and must NOT diverge if
    // the bot branch (checked second) were somehow winning instead. `samples===0`
    // alone (the test above) cannot tell the two branches apart, since neither ever
    // calls the real controller; this one can, because only one of the two candidate
    // drivers is sensitive to wallMs at all.
    function slot0Trajectory(wallMs: number): Array<{ pos: Vec2; turretAngle: number }> {
      const h = boot(makeDeps({ devFlags: { seed: 42, bots: 1, autoplay: true }, wallMs }));
      h.setState('playing');
      const out: Array<{ pos: Vec2; turretAngle: number }> = [];
      // MANY SMALL steps, not a few big jumps: a single fireFrame call is clamped to
      // MAX_FRAME_DT (0.25s = 15 ticks, frame.ts), so a big `now` jump does NOT
      // simulate the elapsed wall time -- see the autoplay-wiring describe block's own
      // "actually moves the player tank" test, which this mirrors. The default
      // single-player fixture also does NOT back-date roundStartTick the way the
      // multiplayer path does, so COUNTDOWN_TICKS (180 ticks = 3s) blocks movement
      // first -- 80 steps of 100ms clears both.
      for (let i = 1; i <= 80; i++) {
        h.fireFrame(i * 100);
        if (i % 10 === 0) {
          const p0 = h.rec.renders.at(-1)!.curr.tanks.find((t: Tank) => t.kind === 'player')!;
          out.push({ pos: { ...p0.pos }, turretAngle: p0.turretAngle });
        }
      }
      h.handle.dispose();
      return out;
    }
    const a = slot0Trajectory(111);
    const b = slot0Trajectory(987654321);
    expect(a).not.toEqual(b);
  });

  describe('reproducibility (mutation 3, red-first): the resolved WORLD SEED, never wallMs', () => {
    // A bot's whole reason to exist (owner directive 1: "simulate multiplayer using
    // computer players") is a REPRODUCIBLE session: `?dev=1&seed=42&bots=K` must
    // replay identically. wallMs is real-clock and MUST NOT leak into a bot's stream,
    // unlike autoplay's own (deliberately session-scoped, non-reproducible) RNG.
    const NOW_SEQUENCE = [17, 100, 260, 500, 900, 1500, 2200, 3000, 4000];

    function runSession(wallMs: number): Array<Array<{ id: number; pos: Vec2; turretAngle: number; bodyAngle: number }>> {
      const h = boot(makeDeps({ devFlags: { seed: 42, players: 3, bots: 3 }, wallMs }));
      h.setState('playing');
      const snapshots: Array<Array<{ id: number; pos: Vec2; turretAngle: number; bodyAngle: number }>> = [];
      for (const now of NOW_SEQUENCE) {
        h.fireFrame(now);
        const curr = h.rec.renders.at(-1)!.curr as World;
        snapshots.push(
          curr.tanks.map((t) => ({ id: t.id, pos: { ...t.pos }, turretAngle: t.turretAngle, bodyAngle: t.bodyAngle })),
        );
      }
      h.handle.dispose();
      return snapshots;
    }

    it('two sessions, same ?seed, DIFFERENT wallMs: every tank\'s position and angles agree at every one of the 9 sampled ticks', () => {
      const a = runSession(111);
      const b = runSession(987654321);
      expect(a.length).toBe(NOW_SEQUENCE.length);
      expect(a).toEqual(b);
      // Sanity: the knob under test is actually wired -- prove the bots moved at all,
      // so a vacuous "nothing moved either way" cannot masquerade as reproducibility.
      const firstTick = a[0];
      const lastTick = a[a.length - 1];
      const anyMoved = firstTick.some((t0) => {
        const t1 = lastTick.find((t) => t.id === t0.id)!;
        return Math.abs(t1.pos.x - t0.pos.x) > 1e-6 || Math.abs(t1.pos.y - t0.pos.y) > 1e-6;
      });
      expect(anyMoved).toBe(true);
    });
  });

  describe('switchTo reseeds botSources from the NEW world, not the old stream carried forward', () => {
    // botSources is reassigned inside switchTo (see loop.ts), from that call's OWN
    // `world.seed` -- not merely built once at boot. Proof: drive one session through
    // real level-0 play (many ticks, real RNG draws consumed) before advancing, and a
    // second STRAIGHT to level 1 with nothing consumed first; if switchTo's reseed is
    // real, both land on an IDENTICAL fresh bot state once play resumes at level 1,
    // since createBotSources is a pure function of (seed, slots) and `seed` is pinned
    // identically across the whole session either way. `setState('win')` +
    // `hud.startRestart()` mirrors the existing "level progression" describe block's
    // own shortcut through the transition, without needing a real winnable fixture.
    function postSwitchTrajectory(prewarmAtLevel0: boolean): Array<Array<{ id: number; pos: Vec2; turretAngle: number; bodyAngle: number }>> {
      const h = boot(makeDeps({ devFlags: { seed: 42, players: 3, bots: 3 }, levelCount: 2 }));
      h.setState('playing');
      let elapsed = 0;
      if (prewarmAtLevel0) {
        // Many small steps, not one big jump -- fireFrame clamps to MAX_FRAME_DT (15
        // ticks) per call (see the autoplay-precedence test above for the same fix).
        for (let i = 1; i <= 80; i++) {
          elapsed = i * 100;
          h.fireFrame(elapsed);
        }
      }
      h.setState('win');
      h.hud.startRestart(); // switchTo(next level) + sm.restart() -> 'playing' again
      const snapshots: Array<Array<{ id: number; pos: Vec2; turretAngle: number; bodyAngle: number }>> = [];
      for (let i = 1; i <= 40; i++) {
        elapsed += 100;
        h.fireFrame(elapsed);
        if (i % 5 === 0) {
          snapshots.push(
            h.rec.renders.at(-1)!.curr.tanks.map((t: Tank) => ({
              id: t.id, pos: { ...t.pos }, turretAngle: t.turretAngle, bodyAngle: t.bodyAngle,
            })),
          );
        }
      }
      h.handle.dispose();
      return snapshots;
    }

    it('post-switch bot trajectory at level 1 is IDENTICAL whether or not level 0 consumed real RNG draws first', () => {
      const warmed = postSwitchTrajectory(true);
      const cold = postSwitchTrajectory(false);
      expect(warmed).toEqual(cold);
      // Sanity: the compared window is not vacuously frozen (both scenarios reach the
      // same non-spawn state, not just the same spawn state).
      const first = warmed[0];
      const last = warmed[warmed.length - 1];
      const anyMoved = first.some((t0) => {
        const t1 = last.find((t) => t.id === t0.id)!;
        return Math.abs(t1.pos.x - t0.pos.x) > 1e-6 || Math.abs(t1.pos.y - t0.pos.y) > 1e-6;
      });
      expect(anyMoved).toBe(true);
    });
  });
});

describe('startGameWith: reassignSlot (controller assignment UI, docs/superpowers/plans/2026-08-17-controller-assignment.md)', () => {
  it('reassigning a slot to a NEW gamepad padIndex disposes the OLD dedicated source and builds a fresh one at the new index', () => {
    const h = boot(makeDeps({ devFlags: { players: 3 } })); // slot1->pad1, slot2->pad2
    expect(h.rec.gamepadSourceBuildIndices).toEqual([1, 2]);

    h.hud.reassignSlot(2, { kind: 'gamepad', padIndex: 5 });
    expect(h.rec.slotDisposed[2]).toBe(true); // the OLD padIndex-2 source was torn down
    expect(h.rec.gamepadSourceBuildIndices).toEqual([1, 2, 5]); // a FRESH source, not a re-point
    expect(h.rec.gamepadSourceBuilds).toBe(3);
    // The UNRELATED slot 1's own dedicated source is untouched: reassigning slot 2 must
    // not dispose or rebuild anything at padIndex 1.
    expect(h.rec.slotDisposed[1]).toBeFalsy();

    h.setState('playing');
    h.fireFrame(100);
    // Slot 2 now samples the NEW padIndex-5 source, not the disposed padIndex-2 one.
    expect(h.rec.slotSamples[5]).toBeGreaterThan(0);
    h.handle.dispose();
  });

  it("keyboard reassignment bounces the old holder to 'none' -- BOTH slots' sources are " +
    'rebuilt, not just the target: the bounced slot must not keep sampling its old source ' +
    'while assignment says none (the exact exclusivity bug the bounce exists to prevent)', () => {
    const h = boot(makeDeps({ devFlags: { players: 2, seed: 42 } })); // slot0=keyboard, slot1=gamepad(1)
    expect(h.rec.gamepadSourceBuildIndices).toEqual([1]);
    const spawned = h.rec.builtWorlds[0].tanks.filter((t: Tank) => t.kind === 'player');
    const spawn0 = spawned.find((t: Tank) => t.controlledBy === 0)!;

    h.hud.reassignSlot(1, { kind: 'keyboard' }); // bounces slot 0 to 'none'
    // Slot 1 (the TARGET) disposes its old dedicated padIndex-1 source.
    expect(h.rec.slotDisposed[1]).toBe(true);
    // `input` (the keyboard singleton) is never disposed by a reassignment -- only slot
    // 0's dedicated realSources ENTRY is dropped, not the collaborator itself.
    expect(h.rec.disposed).not.toContain('input');

    h.setState('playing');
    h.fireFrame(500); // many ticks

    const live0 = h.rec.renders.at(-1)!.curr.tanks.find((t: Tank) => t.controlledBy === 0)!;
    const live1 = h.rec.renders.at(-1)!.curr.tanks.find((t: Tank) => t.controlledBy === 1)!;

    // Slot 0 (bounced to 'none'): HELD, not slewed -- createHeldInputSource echoes the
    // tank's own position, so aimDir is exactly {0,0} on every tick. If reassignSlot had
    // rebuilt only the TARGET and left slot 0 still pointing at its old `input` source,
    // this would instead show slot 0's turret slewing toward the fake keyboard's FIXED
    // aim point (1, 0) -- two slots sampling the same source, the exact bug the bounce
    // exists to prevent.
    expect(live0.pos).toEqual(spawn0.pos);
    expect(live0.turretAngle).toBe(spawn0.turretAngle);

    // Slot 1 (now keyboard): genuinely samples the fake `input` controller -- its FIXED
    // aim point (1, 0) slews the turret away from spawn, proving slot 1 is driven by
    // `input` now, not by the disposed gamepad(1) source (whose fake never touches
    // turretAngle via aim in a way distinguishable from spawn... it does move +x, so use
    // turretAngle specifically, which only `input`'s fixed-aim fake perturbs this way).
    expect(live1.turretAngle).not.toBe(0);
    h.handle.dispose();
  });

  it('reassigning a slot to \'none\' seeds setPlayerPosition IMMEDIATELY, before the first tick -- ' +
    'without it, the first sample() would run with playerPos===null and the turret would slew ' +
    'toward world-origin for one tick, undercutting the reserved-idle-hold guarantee', () => {
    const h = boot(makeDeps({ devFlags: { players: 2, seed: 42 } }));
    const spawned = h.rec.builtWorlds[0].tanks.filter((t: Tank) => t.kind === 'player');
    const spawn1 = spawned.find((t: Tank) => t.controlledBy === 1)!;
    // A non-origin spawn is load-bearing here -- see createHeldInputSource's own doc
    // comment: a literal {0,0} aim is only neutral for a tank spawned AT the origin.
    expect(spawn1.pos.x !== 0 || spawn1.pos.y !== 0).toBe(true);

    h.hud.reassignSlot(1, { kind: 'none' });
    h.setState('playing');
    h.fireFrame(500); // many ticks -- held is held at every one, not just the first

    const live1 = h.rec.renders.at(-1)!.curr.tanks.find((t: Tank) => t.controlledBy === 1)!;
    expect(live1.turretAngle).toBe(spawn1.turretAngle);
    h.handle.dispose();
  });

  describe("bot conversion touches exactly one botSources entry -- an UNRELATED bot's own RNG " +
    "draw is unchanged by a reassignment elsewhere", () => {
    // A FULL PHYSICAL-TRAJECTORY comparison (boot two sessions, reassign an unrelated
    // slot to bot in one, drive both for many ticks, compare) was tried FIRST and
    // rejected on evidence, not preference: it diverges by tick ~30 even with a
    // correct single-entry `reassignSlot`. The cause is real, not a test bug --
    // CLAUDE.md's "the bot brain reads the whole board" -- `assessThreats` only
    // treats non-player-kind tanks as opponents in campaign-coop (isOpponent,
    // player-profile.ts), so the newly-bot-claimed slot is never a TARGET, but its
    // shells and mines still land in `world.bullets`/`world.mines`, which every
    // bot's hazard-avoidance reads regardless of owner. So "an unrelated bot's
    // trajectory is identical" is FALSE by design the instant the reassigned slot
    // fires -- asserting it would be exactly the overclaim CLAUDE.md's "claims must
    // match evidence" warns against. What IS true, and what `reassignSlot` actually
    // promises, is narrower: the OTHER bot's `botSources` Map entry -- its `rnd`
    // stream and its `PlayerAiState` object -- is never rebuilt. That is provable at
    // two levels without the board-interaction confound: `createBotSources` itself
    // is a pure, per-slot-independent function (pinned already, see "createBotSources
    // / BOT_SEED_SPACING: independence from every enemy-AI stream" above -- the same
    // seed+slot always draws the same first value, regardless of what else is in the
    // passed slot Set, because the per-slot loop never reads another slot's entry);
    // and `reassignSlot`'s own bot-claim branch calls it with a Set containing ONLY
    // the slot being reassigned (`new Set([i])`, loop.ts), never the full bot roster
    // -- so it cannot rebuild an existing bot's Map entry at all. The two tests below
    // pin those two halves directly.
    it('createBotSources draws the SAME first value for a slot whether or not another slot ' +
      'shares the passed Set -- the mathematical half of "touches exactly one entry"', () => {
      const alone = createBotSources(100, new Set([3])).get(3)!;
      const withCompany = createBotSources(100, new Set([1, 3])).get(3)!;
      expect(withCompany.rnd()).toBe(alone.rnd());
    });

    it("reassigning slot 1 to bot never disposes or rebuilds slot 3's REAL-source entry -- " +
      'the wiring half, checkable without the AI board-reading confound above', () => {
      // players=4, bots=1: slot 3 is bot-claimed from boot (no realSources entry --
      // see botSlots' own doc comment). Slot 1 starts as a dedicated gamepad(1) source.
      const h = boot(makeDeps({ devFlags: { players: 4, bots: 1 } }));
      expect(h.rec.gamepadSourceBuildIndices).toEqual([1, 2]); // slots 1, 2 -- slot 3 is the bot
      h.hud.reassignSlot(1, { kind: 'bot' }); // slot 1: gamepad -> bot
      // Slot 1's OWN old source is disposed (it is the target)...
      expect(h.rec.slotDisposed[1]).toBe(true);
      // ...but slot 2's UNRELATED dedicated source is not, and no NEW gamepad source is
      // built for slot 3 (it never had one, and gaining a bot must not build one now).
      expect(h.rec.slotDisposed[2]).toBeFalsy();
      expect(h.rec.gamepadSourceBuildIndices).toEqual([1, 2]); // unchanged: no new build
      h.handle.dispose();
    });
  });

  it("reassigning a slot AWAY from a genuinely-connected pad does not fire a spurious " +
    "'disconnected' toast -- reassignSlot must re-sync gamepadConnectedPrev to the new " +
    "source's truth, or the falling edge fires for a deliberate UI move, not an unplug", () => {
    const h = boot(makeDeps({ devFlags: { players: 3 } })); // slot1->pad1, slot2->pad2
    h.setState('playing');
    h.setSlotGamepadConnected(2, true);
    h.fireFrame(100);
    expect(h.rec.plainToasts).toEqual(["Player 3's controller connected"]);

    h.hud.reassignSlot(2, { kind: 'bot' }); // move slot 2 away from its still-connected pad
    h.fireFrame(200); // many ticks past the reassignment, not just one

    // No new toast: the pad never physically disconnected, so nothing should read as a
    // falling edge. Without the re-sync this appends "Player 3's controller disconnected".
    expect(h.rec.plainToasts).toEqual(["Player 3's controller connected"]);
    h.handle.dispose();
  });
});

describe('startGameWith: reserved-idle hold END TO END -- a REAL mid-session disconnect ' +
  'leaves the tank holding, not stolen (docs/superpowers/plans/2026-08-17-controller-assignment.md ' +
  'section 4: "Reserved-idle semantics")', () => {
  // Every other test in this file drives slot >= 1 through the FAKE createGamepadSource
  // (always move +x, never touches turretAngle via a real hold/echo mechanism), which is
  // right for pinning loop.ts's OWN wiring but cannot show the reserved-idle guarantee
  // itself -- that lives inside gamepad.ts's REAL createGamepadInputSource. This test
  // substitutes the REAL production function for slot 1's source, wrapped only to COUNT
  // how many times it is built, so "the same source persists across a live disconnect/
  // reconnect, with no reassignment" is provable by that count staying at 1 -- there is
  // no other mechanism in loop.ts that could be driving slot 1's tank if this count never
  // moves.
  it('disconnecting a REAL pad mid-session holds the tank -- no move, turret frozen -- ' +
    'and reconnecting at the SAME index resumes it, with the underlying source rebuilt ZERO times', () => {
    let padPresent = true;
    let axes = [0, 0, 1, 0]; // aim stick deflected hard right while connected
    const getGamepads = () =>
      padPresent
        ? [null, { axes, buttons: [{ pressed: false }, { pressed: false }] }]
        : [];
    let builds = 0;
    const h = makeDeps({ devFlags: { players: 2, seed: 42 } });
    h.deps = {
      ...h.deps,
      createGamepadSource: (padIndex: number) => {
        builds += 1;
        return createGamepadInputSource(getGamepads, padIndex);
      },
    };
    const booted = boot(h);

    booted.setState('playing');
    booted.fireFrame(500); // past countdown; the deflected stick has time to slew the turret
    const spawned = booted.rec.builtWorlds[0].tanks.filter((t: Tank) => t.kind === 'player');
    const spawn1 = spawned.find((t: Tank) => t.controlledBy === 1)!;
    const live1AtConnect = booted.rec.renders.at(-1)!.curr.tanks.find((t: Tank) => t.controlledBy === 1)!;
    // Sanity: the deflected stick actually did something -- a vacuous "nothing ever
    // moves" comparison later would not prove the hold, it would just prove nothing runs.
    expect(live1AtConnect.turretAngle, 'the deflected stick never turned the turret').not.toBe(
      spawn1.turretAngle,
    );

    // DISCONNECT. No reassignSlot call anywhere in this test -- the descriptor never
    // changes; only the hardware does.
    padPresent = false;
    booted.fireFrame(1500); // many more ticks
    const held = booted.rec.renders.at(-1)!.curr.tanks.find((t: Tank) => t.controlledBy === 1)!;
    // Held: position unchanged (move is {0,0} while disconnected) and turret FROZEN at
    // whatever heading it had at the moment of disconnect -- not reset to spawn, not
    // slewed toward world-origin, not slewed anywhere further at all, since the real
    // gamepad source's no-pad fallback echoes the tank's OWN position as `aim`, making
    // `aimDir` exactly {0,0} on every subsequent tick.
    expect(held.pos).toEqual(live1AtConnect.pos);
    expect(held.turretAngle).toBe(live1AtConnect.turretAngle);
    expect(booted.rec.plainToasts).toContain("Player 2's controller disconnected");

    // RECLAIM: reconnect at the SAME index. No reassignSlot call here either --
    // reconnecting at the same index auto-resumes (the plan's own §2 rule), which this
    // proves by the source having never been rebuilt at all.
    axes = [0, 0, 0, 0]; // stick recentred on reconnect
    padPresent = true;
    booted.fireFrame(2500);
    expect(booted.rec.plainToasts).toContain("Player 2's controller connected");
    // Population: every call to the (wrapped) production factory across the WHOLE test,
    // boot included -- built exactly once, at boot, for padIndex 1. Neither the
    // disconnect nor the reconnect rebuilt it: reassignSlot was never called, so there
    // was nothing TO rebuild -- the descriptor stayed `{kind: 'gamepad', padIndex: 1}`
    // throughout, which is what "reserved-idle, not stolen" actually means.
    expect(builds).toBe(1);

    booted.handle.dispose();
  });
});

describe('startGameWith: the controller assignment panel\'s wiring (docs/superpowers/plans/' +
  '2026-08-17-controller-assignment.md)', () => {
  it('pushes hud.setControllers with the boot-derived assignment', () => {
    const h = boot(makeDeps({ devFlags: { players: 3, bots: 1 } })); // slot 2 is the bot
    expect(h.rec.controllersPushes[0]).toEqual([
      { kind: 'keyboard' },
      { kind: 'gamepad', padIndex: 1 },
      { kind: 'bot' },
    ]);
    h.handle.dispose();
  });

  it('reassignSlot pushes a FRESH hud.setControllers reflecting the new assignment', () => {
    // `bots: 0` rather than omitting it: the flag's PRESENCE is what opens the campaign
    // to bot players (`botAssignmentAllowed`), and 0 keeps the boot assignment free of
    // them, so this still starts from [keyboard, gamepad] and the reassignment below is
    // the only thing that introduces a bot. Without the flag the reassignment is refused
    // and this test would be asserting the boundary instead of the push.
    const h = boot(makeDeps({ devFlags: { players: 2, bots: 0 } }));
    const before = h.rec.controllersPushes.length;
    h.hud.reassignSlot(1, { kind: 'bot' });
    expect(h.rec.controllersPushes.length).toBe(before + 1);
    expect(h.rec.controllersPushes.at(-1)).toEqual([{ kind: 'keyboard' }, { kind: 'bot' }]);
    h.handle.dispose();
  });

  it('onControllersOpen reads deps.readDetectedPads ONCE immediately, then adds the two ' +
    'window listeners -- the events fire only on CHANGE, so opening over already-connected ' +
    'pads would otherwise show nothing until the next hotplug', () => {
    const h = boot(makeDeps());
    h.setDetectedPadsFixture([{ padIndex: 0, id: 'Pad' }]);
    expect(h.rec.detectedPadsPushes).toEqual([]);
    h.hud.openControllers();
    expect(h.rec.detectedPadsPushes).toEqual([[{ padIndex: 0, id: 'Pad' }]]);
    const types = h.rec.listeners.map(([t]) => t);
    expect(types).toContain('gamepadconnected');
    expect(types).toContain('gamepaddisconnected');
    h.handle.dispose();
  });

  it('a gamepadconnected/gamepaddisconnected event while open pushes a fresh read', () => {
    const h = boot(makeDeps());
    h.hud.openControllers();
    const connectedFn = h.rec.listeners.find(([t]) => t === 'gamepadconnected')![1] as () => void;
    h.setDetectedPadsFixture([{ padIndex: 5, id: 'Hotplugged Pad' }]);
    connectedFn();
    expect(h.rec.detectedPadsPushes.at(-1)).toEqual([{ padIndex: 5, id: 'Hotplugged Pad' }]);
    const disconnectedFn = h.rec.listeners.find(([t]) => t === 'gamepaddisconnected')![1] as () => void;
    h.setDetectedPadsFixture([]);
    disconnectedFn();
    expect(h.rec.detectedPadsPushes.at(-1)).toEqual([]);
    h.handle.dispose();
  });

  it('onControllersClose removes both window listeners -- scoped to exactly while the ' +
    'panel that reads them is on screen', () => {
    const h = boot(makeDeps());
    h.hud.openControllers();
    h.hud.closeControllers();
    const removedTypes = h.rec.removed.map(([t]) => t);
    expect(removedTypes).toContain('gamepadconnected');
    expect(removedTypes).toContain('gamepaddisconnected');
    h.handle.dispose();
  });
});

describe('startGameWith: achievements wiring', () => {
  /**
   * A world one tick from being cleared: the last enemy stands on a player-owned
   * mine whose fuse expires immediately, so the killing blow and the `win` event
   * ride ONE step() batch. That is how a real level ends, and driving it this way
   * (rather than calling setState('win')) is what exercises the ordering between
   * the state flip and stats.record.
   */
  const winningWorld = (over: Partial<World> = {}): World => {
    const base = createArenaWorld(1);
    const player = base.tanks.find((t) => t.kind === 'player')!;
    const enemy = base.tanks.find((t) => t.kind !== 'player')!;
    return {
      ...base,
      roundStartTick: -100000,
      tanks: [player, enemy],
      mines: [
        { id: 700, ownerId: player.id, pos: { ...enemy.pos }, timer: 0.001, armed: true, detonated: false },
      ],
      ...over,
    };
  };

  it('seeds the HUD with the SAVED earned set at boot', () => {
    // A pre-earned store, so the assertion can tell "read the store" from
    // "pushed an empty set" -- with an always-empty fixture both look identical.
    const h = boot(makeDeps({ savedAchievements: ['petard', 'trick-shot'] }));
    expect(h.rec.achPushes[0].sort()).toEqual(['petard', 'trick-shot']);
    h.handle.dispose();
  });

  it('evaluates per frame-batch with NO clearedLevel, so attempt feats stay dormant', () => {
    // Same fixture as the stats test, for the same reason: the driver only calls
    // onFrameEvents on EVENTFUL frames, so a countdown frame would leave the
    // assertion below vacuous. The mine's fuse expires within the first tick.
    const world = { ...createArenaWorld(1), roundStartTick: -100000 };
    world.mines.push({ id: 501, ownerId: 99, pos: { x: 1, y: 1 }, timer: 0.001, armed: true, detonated: false });
    const h = boot(makeDeps({ world }));
    h.setState('playing');
    h.fireFrame(100);
    // The mid-play checks must all carry a null clearedLevel; a non-null one here
    // would credit attempt feats on a level still being played.
    expect(h.rec.achChecks.length).toBeGreaterThan(0);
    expect(h.rec.achChecks.every((c) => c.clearedLevel === null)).toBe(true);
    h.handle.dispose();
  });

  it('evaluates at the win with the cleared level and the lives that survived', () => {
    // lives: 2, NOT the fixture default of 3 -- against a 3-life world a hardcoded
    // `livesLeft: 3` passes, which is the tautology that hid here first time round.
    const h = boot(makeDeps({ levelStart: 1, world: winningWorld({ lives: 2 }) }));
    h.setState('playing');
    h.fireFrame(100);
    const atWin = h.rec.achChecks.filter((c) => c.clearedLevel !== null);
    expect(atWin).toHaveLength(1);
    // 1-based level number, matching progress.recordCleared, not the 0-based index.
    expect(atWin[0].clearedLevel).toBe(2);
    expect(atWin[0].livesLeft).toBe(2);
    h.handle.dispose();
  });

  it('checks the win AFTER the clear is recorded, so level milestones see it', () => {
    // Ordering is the whole point: evaluating first would make Campaigner need a
    // SECOND win to notice the one that finished the game.
    const h = boot(makeDeps({ levelCount: 1, progressHighest: 0, world: winningWorld() }));
    h.setState('playing');
    h.fireFrame(100);
    const atWin = h.rec.achChecks.filter((c) => c.clearedLevel !== null);
    expect(atWin).toHaveLength(1);
    expect(atWin[0].highestCleared).toBe(1);
    h.handle.dispose();
  });

  it('the win-time context INCLUDES the winning frame\'s kill', () => {
    // The winning tank-destroyed and the win event ride the SAME step() batch, and
    // the state machine flips inside stateMachine.onEvents -- which the driver calls
    // BEFORE onFrameEvents, where stats.record runs. Evaluate attempt feats at the
    // state change and they see a tally one kill short: Dead Eye (shellKills ===
    // shotsFired) becomes unearnable on a normal clear and Bomb Squad misses a
    // single-mine-kill win. This asserts the check sees the FINISHED attempt.
    const h = boot(makeDeps({ world: winningWorld() }));
    h.setState('playing');
    h.fireFrame(100);
    const atWin = h.rec.achChecks.filter((c) => c.clearedLevel !== null);
    expect(atWin).toHaveLength(1); // the win really landed in-frame
    expect(atWin[0].attemptShellKills).toBeGreaterThan(0);
    h.handle.dispose();
  });

  it('toasts newly earned achievements and pushes the fresh set to the HUD', () => {
    const h = boot(
      makeDeps({
        world: winningWorld(),
        earnsOn: [{ id: 'boots-on-ground', when: (c) => c.clearedLevel !== null }],
      }),
    );
    const pushesBefore = h.rec.achPushes.length;
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.toasts).toEqual([['boots-on-ground']]);
    expect(h.rec.achPushes.length).toBe(pushesBefore + 1);
    expect(h.rec.achPushes.at(-1)).toEqual(['boots-on-ground']);
    h.handle.dispose();
  });

  it('does not toast when nothing new was earned', () => {
    const world = { ...createArenaWorld(1), roundStartTick: -100000 };
    world.mines.push({ id: 502, ownerId: 99, pos: { x: 1, y: 1 }, timer: 0.001, armed: true, detonated: false });
    const h = boot(makeDeps({ world }));
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.achChecks.length).toBeGreaterThan(0); // evaluations really happened
    h.setState('win');
    expect(h.rec.toasts).toEqual([]); // a toast per evaluation would spam every frame
    h.handle.dispose();
  });

  it('Reset progress clears achievements; Reset stats deliberately does not', () => {
    const h = boot(makeDeps());
    h.hud.resetStats();
    expect(h.rec.achResets).toBe(0); // statistics reset, the record of events stands
    h.hud.resetProgress();
    expect(h.rec.achResets).toBe(1);
    expect(h.rec.achPushes.at(-1)).toEqual([]); // and the HUD is told
    h.handle.dispose();
  });
});

describe('startGameWith: the paint shop wiring', () => {
  it('builds the renderer with the SAVED colour and echoes it to the HUD at boot', () => {
    const h = boot(makeDeps({ savedHull: 'purple' }));
    const options = h.rec.rendererArgs[0][4] as { playerColor?: string };
    expect(options.playerColor).toBe('#hex-purple');
    expect(h.rec.hullEchoes[0]).toBe('purple');
    h.handle.dispose();
  });

  it('a pick stores, repaints live, and echoes the ACCEPTED value back', () => {
    const h = boot(makeDeps());
    h.hud.pickHull('red');
    expect(h.rec.hullSets).toEqual(['red']);
    expect(h.rec.restyles).toEqual([{ hex: '#hex-red', skin: 'solid', accent: null }]);
    expect(h.rec.hullEchoes.at(-1)).toBe('red');
    h.handle.dispose();
  });

  it('an off-palette pick is refused by the store, and the echo says so', () => {
    // The HUD can only offer palette swatches, but the handler must not trust that:
    // the echo after a refused pick is the UNCHANGED stored value.
    const h = boot(makeDeps({ savedHull: 'green' }));
    h.hud.pickHull('teal' as never);
    expect(h.rec.hullEchoes.at(-1)).toBe('green');
    // restyled with the stored value
    expect(h.rec.restyles).toEqual([{ hex: '#hex-green', skin: 'solid', accent: null }]);
    h.handle.dispose();
  });

  it('builds the renderer with the SAVED skin and echoes it to the HUD at boot', () => {
    const h = boot(makeDeps({ savedSkin: 'camo' }));
    const options = h.rec.rendererArgs[0][4] as { playerSkin?: string };
    expect(options.playerSkin).toBe('camo');
    expect(h.rec.skinEchoes[0]).toBe('camo');
    h.handle.dispose();
  });

  it('a skin pick stores, restyles with the FULL style, and echoes back', () => {
    const h = boot(makeDeps({ savedHull: 'red' }));
    h.hud.pickSkin('checker');
    expect(h.rec.skinSets).toEqual(['checker']);
    // The restyle carries the stored hull too: sending part of the style would
    // silently reset the rest under a skin change.
    expect(h.rec.restyles).toEqual([{ hex: '#hex-red', skin: 'checker', accent: null }]);
    expect(h.rec.skinEchoes.at(-1)).toBe('checker');
    h.handle.dispose();
  });

  it('an off-list skin pick is refused by the store, and the echo says so', () => {
    const h = boot(makeDeps({ savedSkin: 'flow' }));
    h.hud.pickSkin('zebra' as never);
    expect(h.rec.skinEchoes.at(-1)).toBe('flow');
    expect(h.rec.restyles).toEqual([{ hex: '#hex-blue', skin: 'flow', accent: null }]);
    h.handle.dispose();
  });

  it('builds the renderer with the SAVED accent (auto resolves to a null hex) and echoes it at boot', () => {
    const h = boot(makeDeps());
    const options = h.rec.rendererArgs[0][4] as { playerAccent?: string | null };
    expect(options.playerAccent).toBeNull();
    expect(h.rec.accentEchoes[0]).toBe('auto');
    h.handle.dispose();
  });

  it('a non-auto saved accent resolves to its own hex at boot, not null', () => {
    const h = boot(makeDeps({ savedAccent: 'black' }));
    const options = h.rec.rendererArgs[0][4] as { playerAccent?: string | null };
    expect(options.playerAccent).toBe('#accent-black');
    h.handle.dispose();
  });

  it('an accent pick stores, restyles with the FULL style, and echoes back', () => {
    const h = boot(makeDeps({ savedHull: 'red', savedSkin: 'checker' }));
    h.hud.pickAccent('gold');
    expect(h.rec.accentSets).toEqual(['gold']);
    // Carries the stored hull AND skin: sending part of the style would silently
    // reset the rest under an accent change.
    expect(h.rec.restyles).toEqual([
      { hex: '#hex-red', skin: 'checker', accent: '#accent-gold' },
    ]);
    expect(h.rec.accentEchoes.at(-1)).toBe('gold');
    h.handle.dispose();
  });

  it('an off-list accent pick is refused by the store, and the echo says so', () => {
    const h = boot(makeDeps({ savedAccent: 'silver' }));
    h.hud.pickAccent('rainbow' as never);
    expect(h.rec.accentEchoes.at(-1)).toBe('silver');
    expect(h.rec.restyles).toEqual([
      { hex: '#hex-blue', skin: 'solid', accent: '#accent-silver' },
    ]);
    h.handle.dispose();
  });
});

describe('startGameWith: the live tank preview', () => {
  it('is built against the HUD\'s OWN canvas, styled with the current save, when the panel opens', () => {
    const h = boot(makeDeps({ savedHull: 'purple', savedSkin: 'camo', savedAccent: 'gold' }));
    expect(h.rec.previewCanvasesReceived).toHaveLength(0); // not built merely by booting
    h.hud.openCustomize();
    expect(h.rec.previewCanvasesReceived).toEqual([h.previewCanvas]);
    // The rotate cluster travels with it, from the SAME HUD. The preview's buttons are
    // optional in preview-controls.ts (every canvas scheme works without them), so
    // dropping this argument in loop.ts leaves a working preview with four dead buttons
    // and nothing else in the suite would notice -- this is the only pin on the wiring.
    expect(h.rec.previewButtonsReceived).toEqual([h.previewButtons]);
    expect(h.rec.previewRestyles).toEqual([
      { hex: '#hex-purple', skin: 'camo', accent: '#accent-gold' },
    ]);
    h.handle.dispose();
  });

  it('is disposed when the panel closes via the chokepoint the HUD fires on ANY close', () => {
    // Not just the Back button: hud.ts routes every close (Back, or a state change
    // while the panel is open, e.g. Start) through the same onCustomizeClose --
    // this fake exercises exactly that one callback, so it stands for both paths.
    const h = boot(makeDeps());
    h.hud.openCustomize();
    expect(h.rec.disposed).not.toContain('preview');
    h.hud.closeCustomize();
    expect(h.rec.disposed).toContain('preview');
    h.handle.dispose();
  });

  it('restyles alongside the main renderer on every pick, not just at open', () => {
    const h = boot(makeDeps({ savedHull: 'red' }));
    h.hud.openCustomize();
    h.rec.previewRestyles.length = 0; // clear the open-time restyle to isolate the pick
    h.hud.pickSkin('checker');
    expect(h.rec.previewRestyles).toEqual([{ hex: '#hex-red', skin: 'checker', accent: null }]);
    // And the main renderer got the SAME triple -- the tank behind the panel and the
    // one inside it must never disagree.
    expect(h.rec.restyles.at(-1)).toEqual(h.rec.previewRestyles.at(-1));
    h.handle.dispose();
  });

  it('a pick while the panel is CLOSED restyles the renderer but builds no preview', () => {
    // The whole point of scoping the preview's lifetime to the panel: a pick made
    // anywhere else in the game must not silently construct a second WebGL context.
    const h = boot(makeDeps());
    h.hud.pickHull('red');
    expect(h.rec.restyles).toHaveLength(1);
    expect(h.rec.previewCanvasesReceived).toHaveLength(0);
    expect(h.rec.previewRestyles).toHaveLength(0);
    h.handle.dispose();
  });

  it('createPreview returning null (no spare WebGL context) does not throw on later picks', () => {
    const h = boot(makeDeps({ previewUnavailable: true }));
    h.hud.openCustomize();
    // The panel opening must not throw even though no preview object came back --
    // this is the mutation that matters: an unguarded `preview.setStyle` (dot, not
    // `preview?.setStyle`) throws here on the null return.
    expect(() => h.hud.pickHull('red')).not.toThrow();
    expect(() => h.hud.closeCustomize()).not.toThrow();
    h.handle.dispose();
  });

  it('is resized alongside the main renderer on a window resize, while the panel is open', () => {
    const h = boot(makeDeps());
    h.hud.openCustomize();
    expect(h.rec.previewResizes).toBe(0); // opening does not itself resize
    h.resize();
    expect(h.rec.previewResizes).toBe(1);
    h.handle.dispose();
  });

  it('is NOT resized on a window resize once the panel has closed', () => {
    // The preview object is gone by then (disposed on close) -- a caller that keeps
    // calling resize() on a stale reference either throws (a plain `preview.resize()`)
    // or silently resizes something no longer on screen. `preview?.resize()` guards it.
    const h = boot(makeDeps());
    h.hud.openCustomize();
    h.hud.closeCustomize();
    h.resize();
    expect(h.rec.previewResizes).toBe(0);
    h.handle.dispose();
  });

  it('is disposed on teardown if the panel is still open when the game tears down', () => {
    // main.ts's pagehide path can call dispose() at any time, panel open or not --
    // see loop.ts's own comment on this. Not covered by the "closes via the
    // chokepoint" test above, which only exercises the Back/state-change path.
    const h = boot(makeDeps());
    h.hud.openCustomize();
    expect(h.rec.disposed).not.toContain('preview');
    h.handle.dispose();
    expect(h.rec.disposed).toContain('preview');
  });

  it('teardown does not double-dispose an ALREADY-closed preview', () => {
    const h = boot(makeDeps());
    h.hud.openCustomize();
    h.hud.closeCustomize();
    const disposedCountAtClose = h.rec.disposed.filter((d) => d === 'preview').length;
    expect(disposedCountAtClose).toBe(1);
    h.handle.dispose();
    expect(h.rec.disposed.filter((d) => d === 'preview')).toHaveLength(1); // still 1, not 2
  });
});

describe('createBrowserDeps', () => {
  // The one function in this module that reads the real globals. Callable under
  // jsdom because every heavyweight collaborator is a FACTORY -- nothing is
  // constructed here -- so the storage wiring the browser actually gets is
  // assertable rather than assumed. Everything below it is injected in tests, so
  // without this the real resolution is exercised by nothing.
  it('puts the browser localStorage on deps.storage AND under the stores', () => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem('tanks.progress.v1', '2');
    try {
      const deps = createBrowserDeps();
      // Identity: a shim here would mean the shipped game persists nothing.
      expect(deps.storage).toBe(globalThis.localStorage);
      // ...and the stores read through the same one, which is the half a storage
      // identity check cannot see.
      expect(deps.progress.highestCleared()).toBe(2);
      expect(deps.devConsole).toBe(globalThis);
    } finally {
      globalThis.localStorage.clear();
    }
  });
});

describe('startGameWith: versus entry, reboot-on-start, and return-to-setup (Task 5)', () => {
  // A concrete (non-'random') arenaId, same posture as the reboot-seam describe block's
  // own CONFIG just below -- a seed-driven map pick has no bearing on any test here.
  const CONFIG: VersusConfig = { mode: 'ffa', players: 2, arenaId: 'arena-02', stock: 3, friendlyFire: false };
  const REMATCH_CONFIG: VersusConfig = { mode: 'teams', players: 4, arenaId: 'arena-01', stock: 5, friendlyFire: true };

  /**
   * `makeDeps()`'s own GameDeps, widened the same way `applyVersusToDeps` widens a real
   * boot's (H2, carried from Task 2): `devFlags.players` set to `config.players`, so
   * `campaignActive()` reads false here exactly as it does for a real versus session --
   * without this, the default `playerCount 1` would leave `campaignActive()` true and a
   * win/lose here would also run the CAMPAIGN run-completion side effects (endRun/
   * advanceLevel), which is not what this describe block is testing. Deliberately keeps
   * `makeDeps`'s own FAKE `levels` (not the real `createVersusLevelSystem`) -- its
   * `world`/`bounds` recording (`rec.levelBuilds`, `rec.hudLevels`) is what proves a
   * "return to setup" click did NOT touch the world, which the real level system's
   * silent build would not expose.
   */
  function versusDeps(
    base: ReturnType<typeof makeDeps>,
    config: VersusConfig,
    requestVersusSession?: (c: VersusConfig) => void,
  ): GameDeps {
    return {
      ...base.deps,
      devFlags: { ...base.deps.devFlags, players: config.players },
      initialVersusConfig: config,
      ...(requestVersusSession ? { requestVersusSession } : {}),
    };
  }

  describe('the Versus button: opens the pane with the retained config', () => {
    it('a rebooted versus session retains its own config and hands it straight through', () => {
      // Fails if onVersusOpen's handler drops `deps.initialVersusConfig` (e.g. always
      // passing `null`, or omitting the argument) instead of forwarding it.
      const base = makeDeps();
      const h = boot({ ...base, deps: versusDeps(base, CONFIG) });
      h.hud.openVersus();
      expect(h.rec.versusSetupPushes.at(-1)).toEqual({ show: true, initial: CONFIG });
      h.handle.dispose();
    });

    it('a fresh campaign boot (no retained match) opens with null, not undefined or a stale default', () => {
      // The `?? null` half of the wiring: fails if the handler passes `undefined`
      // through unconverted, or hardcodes some other fallback.
      const h = boot(makeDeps());
      h.hud.openVersus();
      expect(h.rec.versusSetupPushes.at(-1)).toEqual({ show: true, initial: null });
      h.handle.dispose();
    });
  });

  describe('Start: forwards the pane\'s own config to requestVersusSession', () => {
    it('invokes the spy with exactly the config the pane handed back', () => {
      // Fails if the handler ignores its argument (e.g. calls
      // `deps.requestVersusSession?.(deps.initialVersusConfig)` instead of `(config)`),
      // or drops the call, or calls it with something else.
      const calls: VersusConfig[] = [];
      const base = makeDeps();
      const h = boot({ ...base, deps: versusDeps(base, CONFIG, (c) => calls.push(c)) });
      h.hud.startVersus(REMATCH_CONFIG);
      expect(calls).toEqual([REMATCH_CONFIG]);
      h.handle.dispose();
    });

    it('optional and absent: a Start click does not throw when nothing is wired to receive it', () => {
      // Kills the mutation that drops the `?.` guard (`deps.requestVersusSession!(config)`
      // or a bare call) -- GameDeps' own doc comment says every existing caller with no
      // reboot seam at all must keep WORKING, not merely compiling.
      const base = makeDeps();
      const h = boot({ ...base, deps: versusDeps(base, CONFIG) }); // no requestVersusSession
      expect(() => h.hud.startVersus(REMATCH_CONFIG)).not.toThrow();
      h.handle.dispose();
    });
  });

  describe('a finished versus session\'s "Play Again": returns to the setup pane, not a rebuilt match', () => {
    it('win: lands on title, reopens the pane with the retained config, and rebuilds nothing', () => {
      const calls: VersusConfig[] = [];
      const base = makeDeps();
      const h = boot({ ...base, deps: versusDeps(base, CONFIG, (c) => calls.push(c)) });
      const levelBuildsBeforeClick = h.rec.levelBuilds.length;
      h.setState('win');
      h.hud.startRestart(); // the win screen's ONLY affordance for a single-level session
      // Fails if the versus branch is missing entirely (falls through to the campaign
      // else-branch): state would land on 'playing', not 'title'.
      expect(h.getState()).toBe('title');
      // Fails if showVersusSetup is never called, or called with the wrong `show`/
      // `initial` -- e.g. `null` instead of the match just played.
      expect(h.rec.versusSetupPushes.at(-1)).toEqual({ show: true, initial: CONFIG });
      // Fails if the branch still rebuilds a world (switchTo/landOnCampaignBoard) before
      // showing the pane -- "no reboot until Start again" is the whole point of this
      // branch existing instead of reusing the campaign else-branch's `sm.restart()`.
      expect(h.rec.levelBuilds.length).toBe(levelBuildsBeforeClick);
      // The reboot seam itself must NOT have fired: only the pane's own Start does that.
      expect(calls).toEqual([]);
      h.handle.dispose();
    });

    it('lose: the same return-to-setup path, not the campaign Retry rebuild', () => {
      const base = makeDeps();
      const h = boot({ ...base, deps: versusDeps(base, CONFIG) });
      const levelBuildsBeforeClick = h.rec.levelBuilds.length;
      h.setState('lose');
      h.hud.startRestart();
      expect(h.getState()).toBe('title');
      expect(h.rec.versusSetupPushes.at(-1)).toEqual({ show: true, initial: CONFIG });
      expect(h.rec.levelBuilds.length).toBe(levelBuildsBeforeClick);
      h.handle.dispose();
    });

    it('order pin: setState(\'title\') runs BEFORE showVersusSetup -- a test that fails if the two calls are swapped', () => {
      // hud.ts's real setState unconditionally re-hides the versus pane on every state
      // change (its own close-all discipline) -- so showVersusSetup must run AFTER
      // sm.toTitle(), or the pane would open and then be immediately hidden again by
      // the state transition. This fake does not model that hide/show interaction
      // (it only records), so this test pins the ORDER directly via the one shared
      // log both calls write to -- a swap in loop.ts flips the last two entries here
      // even though every OTHER assertion in this describe block would keep passing.
      const base = makeDeps();
      const h = boot({ ...base, deps: versusDeps(base, CONFIG) });
      h.setState('win');
      h.rec.hudCallLog.length = 0; // isolate this one click's own call order
      h.hud.startRestart();
      expect(h.rec.hudCallLog).toEqual(['state:title', 'versusSetup:true']);
      h.handle.dispose();
    });
  });

  describe('campaign sessions: byte-identical behavior (negative controls)', () => {
    it('a plain campaign win/lose restart never calls requestVersusSession and never shows the pane uninvited', () => {
      // `requestVersusSession` wired (as a real boot always threads it, per
      // applyVersusToDeps/versusAwareDeps) but `initialVersusConfig` absent -- the
      // dev-flag-session shape the brief calls out (`?dev=1&mode=ffa` with no menu).
      // Fails if the branch condition is inverted (e.g. `!deps.initialVersusConfig`),
      // which would route EVERY session through the versus return-to-setup path.
      const calls: VersusConfig[] = [];
      const base = makeDeps();
      const h = boot({ ...base, deps: { ...base.deps, requestVersusSession: (c) => calls.push(c) } });
      h.setState('win');
      h.hud.startRestart();
      expect(h.getState()).toBe('playing'); // today's exact behavior: Play Again restarts directly
      expect(h.rec.versusSetupPushes).toEqual([]);
      expect(calls).toEqual([]);
      h.handle.dispose();
    });

    it('a campaign session with no reboot seam at all (no requestVersusSession, no initialVersusConfig) is untouched', () => {
      const h = boot(makeDeps());
      h.setState('lose');
      h.hud.startRestart();
      expect(h.getState()).toBe('playing');
      expect(h.rec.versusSetupPushes).toEqual([]);
      h.handle.dispose();
    });

    it('the Versus button and Start are never fired by a campaign session on its own -- both are pane-driven, never called uninvited', () => {
      // Not a wiring assertion on loop.ts (nothing in loop.ts would fire these without
      // the pane) -- this pins the harness's OWN triggers stay silent unless a test
      // calls them, so a passing suite above cannot be explained by these firing as a
      // side effect of boot/win/restart.
      const h = boot(makeDeps());
      h.setState('win');
      h.hud.startRestart();
      expect(h.rec.versusSetupPushes).toEqual([]);
      h.handle.dispose();
    });
  });
});

describe('startGameWith: campaign return from a versus session (Task 5b)', () => {
  // A concrete (non-'random') arenaId -- same posture as Task 5's own describe block's
  // CONFIG just above; a seed-driven map pick has no bearing on any test here.
  const CONFIG: VersusConfig = { mode: 'ffa', players: 3, arenaId: 'arena-02', stock: 3, friendlyFire: false };

  /** Same shape as Task 5's own `versusDeps` helper (scoped to its own describe block,
   *  so not reusable here) -- widens devFlags.players (H2) and stamps
   *  initialVersusConfig, optionally threading a requestCampaignSession spy. */
  function versusDeps(
    base: ReturnType<typeof makeDeps>,
    config: VersusConfig,
    requestCampaignSession?: () => void,
  ): GameDeps {
    return {
      ...base.deps,
      devFlags: { ...base.deps.devFlags, players: config.players },
      initialVersusConfig: config,
      ...(requestCampaignSession ? { requestCampaignSession } : {}),
    };
  }

  it("a versus session's construction pushes setSessionKind('versus') exactly once", () => {
    // Fails if the call is dropped, duplicated, or reads the wrong deps field (e.g.
    // always 'campaign', or keyed off something other than initialVersusConfig).
    const base = makeDeps();
    const h = boot({ ...base, deps: versusDeps(base, CONFIG) });
    expect(h.rec.sessionKinds).toEqual(['versus']);
    h.handle.dispose();
  });

  it("a plain campaign session's construction pushes setSessionKind('campaign') exactly once", () => {
    const h = boot(makeDeps());
    expect(h.rec.sessionKinds).toEqual(['campaign']);
    h.handle.dispose();
  });

  it('setSessionKind runs before the very first setState push -- order pin', () => {
    // hud.ts's real applyTitleAffordances reads sessionKind live, so this ordering is
    // not load-bearing there the way Task 5's setState/showVersusSetup swap is -- but a
    // FUTURE hud.ts that snapshotted sessionKind only at setState-time would need it,
    // and this fails immediately if setSessionKind is ever moved after the constructor's
    // first hud.setState/showVersusSetup calls.
    const base = makeDeps();
    const h = boot({ ...base, deps: versusDeps(base, CONFIG) });
    const kindIndex = h.rec.hudCallLog.findIndex((e) => e.startsWith('sessionKind:'));
    const stateIndex = h.rec.hudCallLog.findIndex((e) => e.startsWith('state:'));
    expect(kindIndex).toBeGreaterThanOrEqual(0);
    expect(stateIndex).toBeGreaterThan(kindIndex);
    h.handle.dispose();
  });

  it('the Campaign button click invokes requestCampaignSession exactly once, with no arguments', () => {
    // Fails if onCampaignOpen's handler drops the call, calls something else, or
    // forwards an argument requestCampaignSession does not take.
    const calls: unknown[][] = [];
    const base = makeDeps();
    const h = boot({ ...base, deps: versusDeps(base, CONFIG, (...args: unknown[]) => calls.push(args)) });
    h.hud.openCampaign();
    expect(calls).toEqual([[]]);
    h.handle.dispose();
  });

  it('optional and absent: a Campaign click does not throw when nothing is wired to receive it', () => {
    // Kills the mutation that drops the `?.` guard (a bare or `!`-asserted call) --
    // GameDeps' own doc comment says every existing caller with no reboot seam at all
    // must keep WORKING, not merely compiling.
    const base = makeDeps();
    const h = boot({ ...base, deps: versusDeps(base, CONFIG) }); // no requestCampaignSession
    expect(() => h.hud.openCampaign()).not.toThrow();
    h.handle.dispose();
  });

  it("negative control: a plain campaign session's sessionKind stays 'campaign' through a full win/restart cycle, with nothing calling openCampaign as a side effect", () => {
    // This fake has no real DOM, so it cannot show that a campaign session's Campaign
    // button is absent (hud.test.ts's own session-kind suite proves that half) -- what
    // IS assertable here is that loop.ts itself never flips sessionKind mid-session and
    // never invokes the harness's own openCampaign trigger unprompted, mirroring Task
    // 5's identical-shaped control for openVersus/startVersus.
    const h = boot(makeDeps());
    h.setState('win');
    h.hud.startRestart();
    expect(h.rec.sessionKinds).toEqual(['campaign']);
    h.handle.dispose();
  });
});

describe('applyVersusToDeps / versusAwareDeps: the reboot seam', () => {
  // A concrete (non-'random') arenaId suitable at players:3 -- see versus-config.test.ts
  // and levels.test.ts's own fixtures, reused here rather than hand-rolled -- so `world()`
  // below needs no seed-driven map pick to reason about.
  const CONFIG: VersusConfig = { mode: 'ffa', players: 3, arenaId: 'arena-02', stock: 3, friendlyFire: false };
  const noop = (_config: VersusConfig): void => {};

  /**
   * `createBrowserDeps()` with `run` swapped for a fresh in-memory store (so a real
   * run on this machine's actual localStorage cannot leak in -- `createVersusLevelSystem`
   * never reads it anyway, per its own doc comment) and `devFlags` overridable, so H1's
   * `corpseBlock` fixture does not have to round-trip through a real `location.search`.
   */
  function baseDeps(devFlags: Partial<DevFlags> = {}): GameDeps {
    const deps = createBrowserDeps();
    return { ...deps, run: createRunStore(createMemoryStorage()), devFlags: { ...deps.devFlags, ...devFlags } };
  }

  it('with no versus config: threads requestVersusSession and nulls initialVersusConfig, leaving levels/devFlags untouched', () => {
    // The H2 widening's own negative control: fails if the widening runs unconditionally
    // (e.g. `mode: config?.mode ?? null`), which would corrupt a plain campaign boot.
    const base = baseDeps();
    const result = applyVersusToDeps(base, null, noop);
    expect(result.levels).toBe(base.levels);
    expect(result.devFlags).toEqual(base.devFlags);
    expect(result.requestVersusSession).toBe(noop);
    expect(result.initialVersusConfig).toBeNull();
  });

  it('versusAwareDeps composes createBrowserDeps with the override, threading requestVersusSession through', () => {
    // Fails if versusAwareDeps drops `versus`/`requestVersusSession` on the floor instead
    // of forwarding to applyVersusToDeps -- otherwise nothing below exercises the composition.
    const fn = (_c: VersusConfig): void => {};
    const result = versusAwareDeps(null, fn);
    expect(result.requestVersusSession).toBe(fn);
    expect(result.initialVersusConfig).toBeNull();
  });

  describe('requestCampaignSession threading (Task 5b): versus-only, same posture as initialVersusConfig', () => {
    const campaignNoop = (): void => {};

    it('with no versus config: requestCampaignSession is left UNSET, not defaulted to a no-op', () => {
      // Fails if applyVersusToDeps stamps some fallback (e.g. `() => {}`) onto a plain
      // campaign boot instead of leaving the field absent -- a campaign session has no
      // Campaign button to call it from (hud.ts's own session-kind gating).
      const base = baseDeps();
      const result = applyVersusToDeps(base, null, noop, campaignNoop);
      expect(result.requestCampaignSession).toBeUndefined();
    });

    it('with a versus config: requestCampaignSession is threaded through by identity', () => {
      // Fails if the versus branch drops the 4th argument on the floor, or rebuilds a
      // fresh closure instead of passing the caller's own function through.
      const result = applyVersusToDeps(baseDeps(), { config: CONFIG }, noop, campaignNoop);
      expect(result.requestCampaignSession).toBe(campaignNoop);
    });

    it('versusAwareDeps forwards requestCampaignSession to applyVersusToDeps unchanged', () => {
      const result = versusAwareDeps({ config: CONFIG }, noop, campaignNoop);
      expect(result.requestCampaignSession).toBe(campaignNoop);
    });

    it('versusAwareDeps with no versus config also leaves requestCampaignSession unset', () => {
      const result = versusAwareDeps(null, noop, campaignNoop);
      expect(result.requestCampaignSession).toBeUndefined();
    });

    it('omitting requestCampaignSession entirely (an existing 3-arg caller) still compiles and works -- both functions stay optional', () => {
      // Every pre-Task-5b call site (this describe block's own two tests above pass
      // only 3 args in several places) must keep compiling AND keep returning a usable
      // GameDeps with no reboot-to-campaign seam at all.
      const result = applyVersusToDeps(baseDeps(), { config: CONFIG }, noop);
      expect(result.requestCampaignSession).toBeUndefined();
      expect(result.requestVersusSession).toBe(noop);
    });
  });

  describe('H1 (carried from Task 2): the real devFlags reach the versus world, not DEV_FLAGS_OFF', () => {
    it('devFlags.corpseBlock=true reaches the built world as corpseBlocksShells', () => {
      // Fails if applyVersusToDeps calls createVersusLevelSystem with only 2 args (its
      // own DEV_FLAGS_OFF default), or with a fresh DevFlags object instead of deps.devFlags.
      const result = applyVersusToDeps(baseDeps({ corpseBlock: true }), { config: CONFIG }, noop);
      const world = result.levels.world(result.levels.start, 7, undefined, 3);
      expect(world.corpseBlocksShells).toBe(true);
    });

    it('negative control: corpseBlock=false (the default) keeps corpseBlocksShells false', () => {
      // Without this, the positive case above would also pass a mutant that hard-codes
      // `true` regardless of deps.devFlags.
      const result = applyVersusToDeps(baseDeps({ corpseBlock: false }), { config: CONFIG }, noop);
      const world = result.levels.world(result.levels.start, 7, undefined, 3);
      expect(world.corpseBlocksShells).toBe(false);
    });
  });

  describe('H2 (carried from Task 2): devFlags.players agrees with config.players', () => {
    it('config.players widens devFlags.players, and the built world spawns that many player tanks', () => {
      // Both halves, per the brief: the devFlags field startGameWith's own playerCount
      // derivation reads (loop.ts's `deps.devFlags.players`), AND the world outcome --
      // fails if only one side is wired (e.g. devFlags widened but createVersusLevelSystem
      // still reads a stale config, or vice versa).
      const result = applyVersusToDeps(baseDeps(), { config: CONFIG }, noop);
      expect(result.devFlags.players).toBe(3);
      const world = result.levels.world(result.levels.start, 7, undefined, 3);
      expect(countPlayerTanks(world)).toBe(3);
      // The versus branch's other two fields, otherwise unasserted anywhere in this
      // describe block: fails if `initialVersusConfig`/`requestVersusSession` are
      // dropped (e.g. left at the no-versus branch's `null`/unset) when a config IS
      // present -- exactly what a later task's setup-pane prefill would read.
      expect(result.initialVersusConfig).toBe(CONFIG);
      expect(result.requestVersusSession).toBe(noop);
    });
  });

  describe('issue #278: the VS floor/camera are sized to the rolled arena, not the largest candidate', () => {
    // players:3, all 5 shipped arenas offerable (versus-config.test.ts) -- pinned wallMs
    // values, not swept at runtime, matched to the SAME measured deriveSeed/pickVersusArena
    // table versus-config.test.ts's own "distributes" case pins: deriveSeed is a no-op
    // for inputs under 512 (`wallMs ^ (wallMs >>> 9)` clears no bits), so wallMs 1/6 here
    // resolve through pickVersusArena exactly like seeds 1/6 do there.
    const random3: VersusConfig = { mode: 'ffa', players: 3, arenaId: 'random', stock: 3, friendlyFire: false };

    it("random resolves to a member of versusMapChoices(players), and levels.bounds matches THAT arena exactly -- the defect's direct oracle", () => {
      // wallMs 6 -> arena-03 (cols 33, the 22x18 class) -- deliberately NOT wallMs 1
      // (-> arena-04, the 30x22 "largest candidate" class the pre-#278 bounds() always
      // returned for 'random' regardless of what was actually rolled): a seed that
      // happens to land on the largest class would pass this assertion under the
      // UNFIXED code too, and prove nothing. arena-03 is the discriminating case.
      const deps = { ...baseDeps(), wallMs: () => 6 };
      const result = applyVersusToDeps(deps, { config: random3 }, noop);
      const resolvedId = result.levels.start.arenaId;
      expect(resolvedId).toBe('arena-03');
      expect(versusMapChoices(3, 'ffa')).toContain(resolvedId);
      const arena = arenaById(resolvedId);
      // Fails if bounds() ever falls back to a largest-candidate guess (the pre-#278
      // behavior) instead of the actually-resolved arena's own bounds.
      expect(result.levels.bounds(result.levels.start)).toEqual({
        ...arenaBounds(arena),
        cellSize: arena.cellSize,
      });
      // Spec ruling 4 (selections intact for rematch): the pane-facing config must
      // still say 'random', not whatever concrete arena this session actually rolled
      // -- fails if applyVersusToDeps ever stamps the RESOLVED config onto
      // initialVersusConfig instead of the original `random3` reference.
      expect(result.initialVersusConfig?.arenaId).toBe('random');
    });

    it('a rematch through Start (a fresh applyVersusToDeps call) CAN land on a different arena', () => {
      // Two independent Start-boundary resolutions, wallMs 1 and 6 -- measured to
      // differ (versus-config.test.ts's own "distributes" case). Proves the fix does
      // NOT collapse 'random' into a single fixed pick across sessions.
      const first = applyVersusToDeps({ ...baseDeps(), wallMs: () => 1 }, { config: random3 }, noop);
      const second = applyVersusToDeps({ ...baseDeps(), wallMs: () => 6 }, { config: random3 }, noop);
      expect(first.levels.start.arenaId).toBe('arena-04');
      expect(second.levels.start.arenaId).toBe('arena-03');
      expect(first.levels.bounds(first.levels.start)).not.toEqual(second.levels.bounds(second.levels.start));
    });

    it('quit/match-end inside ONE session cannot re-roll the arena: world() ignores its own seed once resolved', () => {
      // The unit-level half of acceptance criterion 3 ("Quit/match-end cannot
      // silently re-roll"): `landOnCampaignBoard` (loop.ts) rebuilds the world on
      // Quit/game-over/completion via `switchTo(deps.levels.start, lives)` ->
      // `buildWorld` -> `deps.levels.world(level, nextSeed())`, a FRESH seed every
      // time (loop.test.ts's own "starts a fresh attempt tally at boot and on every
      // level switch" pins that this chain really runs a rebuild on quit, for a
      // campaign session). This does not click through that full chain (see this
      // describe block's own note below) -- it proves the narrower, load-bearing half
      // directly: ONE resolved session's `levels.world()` must return the SAME arena
      // no matter what seed a later rebuild call passes it, which is exactly what
      // makes a Quit-triggered `nextSeed()` harmless.
      const result = applyVersusToDeps({ ...baseDeps(), wallMs: () => 6 }, { config: random3 }, noop);
      const initial = result.levels.world(result.levels.start, 6, undefined, 3);
      // Seed 1 is `pickVersusArena`'s own 'arena-04' pick (versus-config.test.ts) --
      // under the pre-#278 code, world() re-resolved 'random' from THIS seed on every
      // call, so a quit rebuild landing on seed 1 would have silently swapped the
      // arena from arena-03 to arena-04. Fails (build throws or returns arena-04) if
      // world() ever goes back to reading `config.arenaId === 'random'` per call.
      const quitRebuilt = result.levels.world(result.levels.start, 1, undefined, 3);
      expect(initial.arenaGeometry?.cols).toBe(33); // arena-03
      expect(quitRebuilt.arenaGeometry?.cols).toBe(33); // still arena-03, not arena-04
    });
  });
});

describe('startGameWith: the dev console surface', () => {
  // driver.test.ts and the sibling unit files (save.test.ts, replay.test.ts) prove
  // each piece against fakes. Only a test HERE can see whether loop.ts publishes
  // them, behind the right flags, from the right storage -- the composition
  // blindness CLAUDE.md names.
  function api(h: ReturnType<typeof boot>): DevConsole {
    return h.devConsole[DEV_CONSOLE_KEY] as DevConsole;
  }

  it('publishes NOTHING with both flags off', () => {
    // The whole property, not an empty object: a shipped build must carry no dev
    // surface at all.
    const h = boot();
    expect(DEV_CONSOLE_KEY in h.devConsole).toBe(false);
    h.handle.dispose();
  });

  it('publishes only save with saveIo on, and only replay with replay on', () => {
    // One at a time, so a wiring that publishes both together -- or crosses them --
    // fails rather than passing on the aggregate. Population: the 2 flags that can
    // publish, alone and together.
    const s = boot(makeDeps({ devFlags: { saveIo: true } }));
    expect(Object.keys(api(s)).sort()).toEqual(['save']);
    s.handle.dispose();

    const r = boot(makeDeps({ devFlags: { replay: true } }));
    expect(Object.keys(api(r)).sort()).toEqual(['replay']);
    r.handle.dispose();

    const both = boot(makeDeps({ devFlags: { saveIo: true, replay: true } }));
    expect(Object.keys(api(both)).sort()).toEqual(['replay', 'save']);
    both.handle.dispose();
  });

  it('removes what it published on dispose', () => {
    const h = boot(makeDeps({ devFlags: { saveIo: true } }));
    expect(DEV_CONSOLE_KEY in h.devConsole).toBe(true);
    h.handle.dispose();
    expect(DEV_CONSOLE_KEY in h.devConsole).toBe(false);
  });

  it('leaves a foreign entry alone when it published nothing itself', () => {
    // The shared-origin case: another page's object under the same key must survive
    // this game's teardown.
    const h = boot();
    h.devConsole[DEV_CONSOLE_KEY] = { notOurs: true };
    h.handle.dispose();
    expect(h.devConsole[DEV_CONSOLE_KEY]).toEqual({ notOurs: true });
  });
});

describe('startGameWith: save export/import reaches the real storage', () => {
  it('exports what is actually in deps.storage, not a snapshot of the stores', () => {
    // Seeded through the raw key layer: if loop.ts built the api from some other
    // storage (a fresh one, or the stores' own reads) this export would be empty.
    const h = boot(
      makeDeps({
        devFlags: { saveIo: true },
        savedKeys: { 'tanks.progress.v1': '2', 'tanks.custom.v1': '{"hull":"red"}' },
      }),
    );
    const save = (h.devConsole[DEV_CONSOLE_KEY] as DevConsole).save!;
    const blob = JSON.parse(save.export()) as SaveBlob;
    expect(blob.format).toBe(SAVE_FORMAT);
    expect(blob.keys['tanks.progress.v1']).toBe('2');
    expect(blob.keys['tanks.custom.v1']).toBe('{"hull":"red"}');
    expect(save.keys).toEqual(SAVE_KEYS);
    h.handle.dispose();
  });

  it('imports into that same storage', () => {
    const h = boot(makeDeps({ devFlags: { saveIo: true } }));
    const save = (h.devConsole[DEV_CONSOLE_KEY] as DevConsole).save!;
    const other = createMemoryStorage();
    other.setItem('tanks.progress.v1', '4');
    const result = save.import(exportSave(other));
    expect(result.ok).toBe(true);
    // Read back off the storage the deps were built with, not off the API.
    expect(h.storage.getItem('tanks.progress.v1')).toBe('4');
    h.handle.dispose();
  });
});

describe('startGameWith: the input recorder', () => {
  function trace(h: ReturnType<typeof boot>): ReturnType<NonNullable<DevConsole['replay']>> {
    return (h.devConsole[DEV_CONSOLE_KEY] as DevConsole).replay!();
  }

  it('records exactly one tick per simulated tick, and leaves sampling untouched', () => {
    const h = boot(makeDeps({ devFlags: { replay: true } }));
    h.setState('playing');
    h.fireFrame(100); // 6 ticks, same arithmetic as the autoplay block above
    expect(h.rec.samples).toBe(6);
    expect(trace(h).ticks).toHaveLength(6);
    h.handle.dispose();
  });

  it('records nothing while the game is not simulating', () => {
    // The driver only samples while 'playing'. A recorder that appended per FRAME
    // would pad the trace with ticks the sim never took, and every replay would
    // diverge.
    const h = boot(makeDeps({ devFlags: { replay: true } }));
    h.fireFrame(100); // still on the title screen
    expect(trace(h).ticks).toHaveLength(0);
    h.handle.dispose();
  });

  it('captures the AUTOPLAY stream, which is what wrapping effectiveInput buys', () => {
    // Wrapping `input` instead of `effectiveInput` would record the real
    // controller's samples -- of which autoplay takes none -- so the trace would be
    // empty here while looking perfect in a normal session.
    const h = boot(makeDeps({ devFlags: { replay: true, autoplay: true } }));
    h.setState('playing');
    for (let i = 1; i <= 60; i++) h.fireFrame(i * 100);
    const t = trace(h);
    expect(h.rec.samples).toBe(0); // the real controller was never asked
    expect(t.ticks.length).toBeGreaterThan(COUNTDOWN_TICKS);
    // and the scripted player really moved: an all-zero move stream would replay
    // as a tank standing still, which no assertion on LENGTH can see. Slot 0 (index
    // 0 of each tick, the only slot outside co-op) is autoplay's own.
    expect(t.ticks.some((tick) => decodeTick(tick)[0].move.x !== 0)).toBe(true);
    h.handle.dispose();
  });

  it('stamps the world it is recording against, and restarts on a level switch', () => {
    // A trace spans ONE world. After an advance the meta must describe the NEW
    // level, or the trace replays into a different game.
    const h = boot(makeDeps({ devFlags: { replay: true }, levelCount: 3 }));
    h.setState('playing');
    h.fireFrame(100);
    expect(trace(h).meta.arenaId).toBe(ARENA_DEFS[0].id);
    expect(trace(h).ticks).toHaveLength(6);
    expect(trace(h).meta.seed).toBe(h.rec.seeds[0]);

    h.setState('win');
    h.hud.startRestart(); // advance to level 2
    const after = trace(h);
    expect(after.meta.arenaId).toBe(ARENA_DEFS[1].id);
    expect(after.meta.seed).toBe(h.rec.seeds[1]);
    expect(after.ticks).toHaveLength(0);
    h.handle.dispose();
  });

  it('produces a trace that replays the recorded run exactly', () => {
    // The end-to-end claim: what the shipped loop captures is enough to rebuild the
    // run. The fake level system builds a REAL arena world, so the rebuild below is
    // the same construction the game used.
    const h = boot(
      makeDeps({ devFlags: { replay: true, autoplay: true, seed: 4242 }, staticRoundStart: true }),
    );
    h.setState('playing');
    for (let i = 1; i <= 40; i++) h.fireFrame(i * 100);
    const t = trace(h);
    expect(checkTrace(t)).toEqual({ ok: true, reason: null });

    const live = h.rec.renders[h.rec.renders.length - 1].curr;
    // ALL meta fields thread through, including the two sim switches -- a rebuild
    // that silently defaults them reproduces today's defaults, not the recorded
    // run's behaviour (the review of this PR caught exactly that staleness here).
    const rebuilt = createWorldFor(
      arenaById(t.meta.arenaId),
      t.meta.seed,
      t.meta.unarmedTrigger,
      t.meta.lives,
      t.meta.corpseBlocksShells,
      t.meta.muzzleClearsTanks,
      undefined,
      t.meta.coopAttempts,
    );
    const replayed = replayTrace(t, rebuilt);
    expect(replayed.world.tick).toBe(live.tick);
    expect(replayed.world.tanks.map((tk) => tk.pos)).toEqual(live.tanks.map((tk) => tk.pos));
    // Non-vacuous: the recorded run has to have gone somewhere.
    expect(live.tick).toBeGreaterThan(COUNTDOWN_TICKS);
    h.handle.dispose();
  });

  it('does not record at all with the flag off', () => {
    const h = boot();
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.samples).toBe(6); // the game is unchanged
    expect(DEV_CONSOLE_KEY in h.devConsole).toBe(false);
    h.handle.dispose();
  });
});

describe('startGameWith: bots may not drive a player tank in the campaign (boundary enforcement)', () => {
  it('refuses a reassignment to bot in the campaign when the bots flag is absent', () => {
    // The panel does not offer Bot there, so this is the SECOND enforcement point --
    // it exists so the rule survives a caller that does not go through the panel.
    // Fails if `reassignSlot`'s guard is removed: the assignment would change and a
    // fresh setControllers would be pushed.
    const h = boot(makeDeps({ devFlags: { players: 2 } }));
    const before = h.rec.controllersPushes.length;
    h.hud.reassignSlot(1, { kind: 'bot' });
    expect(h.rec.controllersPushes.length).toBe(before);
    h.handle.dispose();
  });

  it('leaves the refused slot on its previous source, not on none', () => {
    // Distinguishes "refused" from "bounced": `reassign` sends a displaced slot to
    // 'none', so a guard placed AFTER the reassign call would still corrupt the slot.
    const h = boot(makeDeps({ devFlags: { players: 2 } }));
    h.hud.reassignSlot(1, { kind: 'bot' });
    expect(h.rec.controllersPushes.at(-1)).toEqual([
      { kind: 'keyboard' },
      { kind: 'gamepad', padIndex: 1 },
    ]);
    h.handle.dispose();
  });

  it('permits it once the bots flag is present', () => {
    // The negative control for both tests above: without this, deleting the whole
    // reassign-to-bot path would satisfy them.
    const h = boot(makeDeps({ devFlags: { players: 2, bots: 0 } }));
    h.hud.reassignSlot(1, { kind: 'bot' });
    expect(h.rec.controllersPushes.at(-1)).toEqual([{ kind: 'keyboard' }, { kind: 'bot' }]);
    h.handle.dispose();
  });

  it('tells the hud whether to offer the candidate, matching the same rule', () => {
    // Fails if the loop stops pushing, or pushes a constant. The hud defaults to false,
    // so a dropped push would silently look correct in the campaign and wrong in versus
    // -- which is why both directions are asserted.
    const campaign = boot(makeDeps({ devFlags: { players: 2 } }));
    expect(campaign.rec.botAllowedPushes).toEqual([false]);
    campaign.handle.dispose();

    const withFlag = boot(makeDeps({ devFlags: { players: 2, bots: 0 } }));
    expect(withFlag.rec.botAllowedPushes).toEqual([true]);
    withFlag.handle.dispose();

    const versus = boot(makeDeps({ devFlags: { players: 2, mode: 'ffa' } }));
    expect(versus.rec.botAllowedPushes).toEqual([true]);
    versus.handle.dispose();
  });
});

describe('startGameWith: leaving a CLEARED level for the main menu keeps the run', () => {
  it('routes to title from win and leaves Continue available', () => {
    // A directive: clearing a level must offer the main menu, and the run persists --
    // going back is not abandoning it. `advanceLevel` already ran when the level
    // cleared, so the surviving run points at the NEXT level, not the one just beaten.
    // Fails if loop.ts's quit guard is narrowed back to `paused` only: the handler
    // returns early, the state never becomes 'title', and no fresh Continue signal is
    // pushed.
    // levelCount 5 / start 2 makes this an INTERMEDIATE win. It matters: loop.ts's own
    // state-change handler calls endRun() on a win with no next level (campaign
    // completion), so a default-sized harness would end the run before quit was ever
    // reached and this would be asserting the wrong thing entirely.
    const h = boot(
      makeDeps({ tracksProgress: true, levelCount: 5, levelStart: 2, savedRun: { level: 2, lives: 3 } }),
    );
    h.setState('win');
    h.hud.quitToTitle();
    expect(h.getState()).toBe('title');
    expect(h.rec.continueAvailable.at(-1)).toBe(true);
    h.handle.dispose();
  });

  it('still refuses to quit straight out of PLAYING', () => {
    // The negative control for the widened guard. Without it, replacing the guard with
    // an unconditional pass would satisfy the test above. Quit rebuilds the world, so
    // reaching it from a live game is exactly what the guard exists to stop.
    const h = boot(makeDeps({ tracksProgress: true, savedRun: { level: 2, lives: 3 } }));
    h.setState('playing');
    h.hud.quitToTitle();
    expect(h.getState()).toBe('playing');
    h.handle.dispose();
  });
});

