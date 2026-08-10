// @vitest-environment jsdom
//
// jsdom, as hud.test.ts and input.test.ts already do: isMuteHotkey does an
// `instanceof HTMLElement` check and the dispose path hands real elements
// around. frame.test.ts and driver.test.ts deliberately do NOT use jsdom.
import { describe, it, expect } from 'vitest';
import { DEV_FLAGS_OFF, type DevFlags } from './devflags';
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
import { COUNTDOWN_TICKS } from '../sim/constants';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import type { Tank, Vec2, Bullet, UnarmedTrigger } from '../sim/types';
import type { GameState } from './state';
import {
  isPlayerDeath,
  playerShellsInFlight,
  startGameWith,
  deriveSeed,
  isMuteHotkey,
  musicIntensity,
  isPauseHotkey,
  DEV_CONSOLE_KEY,
  createBrowserDeps,
  type GameDeps,
  type HostWindow,
  type DevConsole,
  type DevConsoleTarget,
} from './loop';
import type { LevelSelectState } from './hud';
import { createMemoryStorage } from './storage';
import { SAVE_KEYS, SAVE_FORMAT, exportSave, type SaveBlob } from './save';
import { decodeInput, replayTrace, checkTrace } from './replay';
import { createWorldFor, ARENAS } from '../sim/arena';

interface Recorder {
  rendererArgs: Array<[unknown, number, number, number, unknown]>;
  screenToGroundArgs: Array<[number, number]>;
  directorPlayerIds: number[];
  directorRebinds: number[];
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
  roundPhases: Array<{ phase: string; secondsLeft: number; prominent: boolean } | null>;
  deathSignals: number;
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
  playerPosPushes: number;
  lastPlayerPos: { x: number; y: number } | null;
  touchPushes: TouchIndicator[];
  fireSignals: number;
  cleared: number[];
  progressResets: number;
  statBatches: Array<{ count: number; playerId: number }>;
  statRunStarts: number;
  statResets: number;
  statPushes: number;
  levelSelects: LevelSelectState[];
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
  achPushes: string[][];
  achChecks: Array<{
    clearedLevel: number | null;
    livesLeft: number;
    highestCleared: number;
    runShellKills: number;
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
}

function makeDeps(opts: { world?: World; wallMs?: number; devFlags?: Partial<DevFlags>; levelCount?: number; levelStart?: number; staticRoundStart?: boolean; tracksProgress?: boolean; progressHighest?: number; boundsByLevel?: Array<{ width: number; height: number; cellSize: number }>; savedHull?: string; savedSkin?: string; savedAccent?: string; savedScheme?: string; savedFireMode?: string; earnsOn?: Array<{ id: string; when: (c: AchievementContext) => boolean }>; savedAchievements?: string[]; enemiesByLevel?: number[]; previewUnavailable?: boolean; savedKeys?: Record<string, string> } = {}): {
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
    pickLevel(i: number): void;
    newGame(): void;
    resetStats(): void;
    resetProgress(): void;
    pickHull(id: HullColorId): void;
    pickSkin(id: SkinId): void;
    pickAccent(id: AccentId): void;
    openCustomize(): void;
    closeCustomize(): void;
  };
  setState(s: GameState): void;
  setTouch(t: TouchIndicator): void;
  firePlayerShot(): void;
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
    inputClears: 0,
    minePresses: 0,
    firePresses: 0,
    schemeSets: [],
    schemeStoreSets: [],
    schemeEchoes: [],
    fireModeSets: [],
    fireModeStoreSets: [],
    fireModeEchoes: [],
    playerPosPushes: 0,
    lastPlayerPos: null,
    touchPushes: [],
    fireSignals: 0,
    cleared: [],
    progressResets: 0,
    statBatches: [],
    statRunStarts: 0,
    statResets: 0,
    statPushes: 0,
    levelSelects: [],
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
  let onQuit = (): void => {};
  let onPauseTap = (): void => {};
  let onMineTap = (): void => {};
  let onFireTap = (): void => {};
  let onTouchSchemeChange = (_s: TouchScheme): void => {};
  let onFireModeChange = (_m: FireMode): void => {};
  let onResetStats = (): void => {};
  let onPickHull = (_id: HullColorId): void => {};
  let onPickSkin = (_id: SkinId): void => {};
  let onPickAccent = (_id: AccentId): void => {};
  let onResetProgress = (): void => {};
  let onPickLevel = (_i: number): void => {};
  let onNewGame = (): void => {};
  // Mutable, so reset() models the real store: everything re-locks, including clears
  // that predate this session. SHARED between the progress fake and the levels fake,
  // because the real `levels.start` reads the real progress store -- see its getter.
  let progressBase = opts.progressHighest ?? 0;
  let onCustomizeOpen = (): void => {};
  let onCustomizeClose = (): void => {};
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
  const devConsole: DevConsoleTarget = {};

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
    createInput: (_target, screenToGround) => ({
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
      dispose(): void {
        rec.disposed.push('input');
      },
    }),
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
        setState: (s) => rec.hudStates.push(s),
        setTouchIndicator: (t: TouchIndicator) => rec.touchPushes.push(t),
        setMuted: (m) => rec.muted.push(m),
        setShellCount: (i) => rec.shellCounts.push(i),
        setLevel: (c: number, t: number) => rec.hudLevels.push([c, t]),
        setRoundPhase: (info) => rec.roundPhases.push(info),
        signalPlayerDeath: () => { rec.deathSignals += 1; },
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
        setStats: () => {
          rec.statPushes += 1;
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
        onResetStats: (cb: () => void) => {
          onResetStats = cb;
        },
        onResetProgress: (cb: () => void) => {
          onResetProgress = cb;
        },
        setLevelSelect: (s: LevelSelectState) => rec.levelSelects.push({ ...s }),
        onLevelSelect: (cb: (i: number) => void) => {
          onPickLevel = cb;
        },
        onNewGame: (cb: () => void) => {
          onNewGame = cb;
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
            runShellKills: ctx.run.shellKills,
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
      let run = { ...ZERO_STATS };
      let lifetime = { ...ZERO_STATS };
      const fold = (events: SimEvent[]): void => {
        const kills = events.filter((e) => e.type === 'tank-destroyed').length;
        run = { ...run, shellKills: run.shellKills + kills };
        lifetime = { ...lifetime, shellKills: lifetime.shellKills + kills };
      };
      return {
        lifetime: () => ({ ...lifetime }),
        run: () => ({ ...run }),
        record: (events: SimEvent[], playerId: number) => {
          rec.statBatches.push({ count: events.length, playerId });
          fold(events);
        },
        startRun: () => {
          run = { ...ZERO_STATS };
          rec.statRunStarts += 1;
        },
        resetLifetime: () => {
          lifetime = { ...ZERO_STATS };
          rec.statResets += 1;
        },
      };
    })(),
    progress: {
      highestCleared: () => Math.max(progressBase, ...rec.cleared, 0),
      recordCleared: (level: number) => {
        rec.cleared.push(level);
      },
      reset: () => {
        rec.progressResets += 1;
        rec.cleared.length = 0;
        progressBase = 0;
      },
    },
    levels: {
      // Defaults to a ONE-level sequence: every pre-progression test in this file was
      // written against "restart rebuilds the same arena", which is exactly what a
      // one-level sequence still does. Progression tests opt into more.
      count: opts.levelCount ?? 1,
      // LIVE, like the real system: an unlock earned mid-session must move the
      // session's start. A fixed opts.levelStart models a dev-flag jump.
      get start(): number {
        if (opts.levelStart !== undefined) return opts.levelStart;
        // Through the PROGRESS STORE, not through `opts.progressHighest`, because the
        // real one is `min(progress.highestCleared(), count - 1)` and the store is
        // mutable: Reset progress zeroes it. Reading the frozen option instead left
        // this fake reporting a resume level of 1 after a reset that had re-locked
        // every level -- a divergence from production that only showed up once
        // something (the Continue label) actually read `start` after a reset.
        const cleared = Math.max(progressBase, ...rec.cleared, 0);
        return Math.min(cleared, (opts.levelCount ?? 1) - 1);
      },
      tracksProgress: opts.tracksProgress ?? true,
      bounds: (level: number) =>
        // Width/height are world-space (arenaBounds(ARENA_01)); cellSize is DELIBERATELY
        // not ARENA_01.cellSize. While the fake echoed the shipped constant, the
        // "sizes the renderer to the arena" assertion below could not tell "loop.ts
        // passes shownBounds.cellSize through" from "loop.ts hardcodes the constant" --
        // hardcoding it in loop.ts left all 142 tests in this file, levels.test.ts and
        // framing.test.ts passing. An unshipped value makes the assertion discriminate.
        opts.boundsByLevel?.[level] ?? { width: 22, height: 18, cellSize: 1.5 },
      world: (level, seed, policy, lives) => {
        rec.levelBuilds.push({ level, lives });
        // The same reference the loop receives: post-build mutations (invincibility)
        // are visible here.
        rec.seeds.push(seed);
        rec.worldPolicies.push(policy);
        // The real createArenaWorld returns a FRESH world each call, and
        // resetArena moves roundStartTick forward -- so a fixed fixture object
        // would make every round look like the same round to loop.ts. Advance it
        // per call, as a respawn does. staticRoundStart turns that OFF, modelling
        // the level-advance case where two fresh worlds collide on the same tick.
        const base = opts.world ?? createArenaWorld(seed);
        // Each level's player gets a DIFFERENT id, as loadArena's grid-scan numbering
        // really does (16 in ARENA_01, 15 in ARENA_02) -- a fake where every level's
        // player id matches let a stale-id bug pass the rebind test.
        let tanks = level === 0 ? base.tanks
          : base.tanks.map((t) => (t.kind === 'player' ? { ...t, id: t.id + 70 + level } : t));
        // Real arenas differ in enemy count (ARENA_01 has 3, ARENA_03 more), and
        // anything computed from "how many did this round start with" is wrong if
        // the fake keeps every level the same size.
        const want = opts.enemiesByLevel?.[level];
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
      pickLevel: (i) => onPickLevel(i),
      newGame: () => onNewGame(),
      resetStats: () => onResetStats(),
      pickHull: (id: HullColorId) => onPickHull(id),
      pickSkin: (id: SkinId) => onPickSkin(id),
      pickAccent: (id: AccentId) => onPickAccent(id),
      resetProgress: () => onResetProgress(),
      openCustomize: () => onCustomizeOpen(),
      closeCustomize: () => onCustomizeClose(),
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

  it('routes the events a real tick produced to BOTH the director and the machine', () => {
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
    h.handle.dispose();
  });
});

describe('isPlayerDeath', () => {
  const destroyed = (kind: string): SimEvent =>
    ({ type: 'tank-destroyed', tankId: 1, kind, pos: { x: 0, y: 0 } }) as SimEvent;

  it('is true for the player', () => {
    expect(isPlayerDeath([destroyed('player')])).toBe(true);
  });

  it('is FALSE for every enemy kind', () => {
    // The whole point: the stream is shared, so a presence-only check would
    // flash the screen red every time the player scored a kill.
    // Population: DERIVED -- every non-player kind in the canonical TANK_KINDS,
    // so a new enemy kind is swept the moment it exists (review: this was a
    // hand-kept list of three whose "all" claim silently went stale).
    for (const kind of TANK_KINDS.filter((k) => k !== 'player')) {
      expect(isPlayerDeath([destroyed(kind)])).toBe(false);
    }
  });

  it('finds the player among a mixed frame', () => {
    expect(isPlayerDeath([destroyed('brown'), destroyed('player'), destroyed('teal')])).toBe(true);
  });

  it('is false for a frame with no deaths at all', () => {
    expect(isPlayerDeath([{ type: 'ricochet', pos: { x: 0, y: 0 }, bounceIndex: 0 } as SimEvent])).toBe(false);
    expect(isPlayerDeath([])).toBe(false);
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
    expect(off.rec.rendererArgs[0][4]).toEqual({ aimRay: false, mineReach: false, mineTimer: false, playerColor: '#hex-blue', playerSkin: 'solid', playerAccent: null });
    off.handle.dispose();
  });

  it('asks for each overlay only when its own flag is on', () => {
    // One at a time, so a wiring that turns them all on together -- or crosses two of
    // them -- fails rather than passing on the aggregate.
    const ray = boot(makeDeps({ devFlags: { aimRay: true } }));
    expect(ray.rec.rendererArgs[0][4]).toEqual({ aimRay: true, mineReach: false, mineTimer: false, playerColor: '#hex-blue', playerSkin: 'solid', playerAccent: null });
    ray.handle.dispose();

    const reach = boot(makeDeps({ devFlags: { mineReach: true } }));
    expect(reach.rec.rendererArgs[0][4]).toEqual({ aimRay: false, mineReach: true, mineTimer: false, playerColor: '#hex-blue', playerSkin: 'solid', playerAccent: null });
    reach.handle.dispose();

    const timer = boot(makeDeps({ devFlags: { mineTimer: true } }));
    expect(timer.rec.rendererArgs[0][4]).toEqual({ aimRay: false, mineReach: false, mineTimer: true, playerColor: '#hex-blue', playerSkin: 'solid', playerAccent: null });
    timer.handle.dispose();
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

  it('makes the FIRST round of the page load prominent', () => {
    // bootAtSplash, not boot: leaving the title screen pushes a round-phase CLEAR
    // (loop.ts nulls the chip on every non-playing state), which would sit at index 0
    // and knock these assertions out of step with `renders`.
    const h = bootAtSplash(inCountdown());
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.roundPhases[0]?.prominent).toBe(true);
    h.handle.dispose();
  });

  it('drops to the quiet chip on the next round', () => {
    // Rounds restart on every respawn, not just a new game -- resetArena moves
    // roundStartTick -- so the second round must not re-teach.
    // bootAtSplash, not boot: leaving the title screen pushes a round-phase CLEAR
    // (loop.ts nulls the chip on every non-playing state), which would sit at index 0
    // and knock these assertions out of step with `renders`.
    const h = bootAtSplash(inCountdown());
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.roundPhases[0]?.prominent).toBe(true);
    // A restart builds a fresh world, which carries a different roundStartTick.
    h.setState('win');
    h.hud.startRestart();
    h.setState('playing');
    h.fireFrame(200);
    const last = h.rec.roundPhases[h.rec.roundPhases.length - 1];
    expect(last?.prominent).toBe(false);
    h.handle.dispose();
  });

  // bootAtSplash for the same reason as its five siblings: leaving the title screen
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

  it('counts the next level\'s opening round, so the teaching banner does not re-show', () => {
    // Two FRESH worlds start on the same roundStartTick, so without an explicit reset
    // the round tracker cannot tell level 2's opening round from level 1's -- and the
    // prominent banner, promised "once per page load", re-taught on every advance.
    const h = boot(makeDeps({
      levelCount: 2,
      staticRoundStart: true,
    }));
    h.setState('playing');
    h.fireFrame(16);
    expect(h.rec.roundPhases.at(-1)?.prominent).toBe(true); // level 1 teaches
    h.setState('win');
    h.hud.startRestart();
    h.fireFrame(32);
    expect(h.rec.roundPhases.at(-1)?.prominent).toBe(false); // level 2 gets the chip
    h.handle.dispose();
  });

  it('resets to the starting level with fresh lives on a game over', () => {
    const h = boot(makeDeps({ levelCount: 2, levelStart: 1 }));
    h.setState('lose');
    h.hud.startRestart();
    // levels.start, not 0: a dev who jumped to level 2 retries level 2.
    expect(h.rec.levelBuilds[1]).toEqual({ level: 1, lives: undefined });
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
    expect(h.rec.levelBuilds[2]).toEqual({ level: 1, lives: undefined });
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

  it('Quit to Title returns to the title over a FRESH run at the starting level', () => {
    const h = boot(makeDeps({ levelCount: 2, levelStart: 1 }));
    h.setState('playing');
    h.keydown({ key: 'Escape' });
    h.hud.quitToTitle();
    expect(h.getState()).toBe('title');
    // Rebuilt at levels.start with fresh lives, like the game-over path.
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
    expect(h.rec.levelSelects[0]).toEqual({ total: 2, unlocked: 1, cleared: 0, resume: 0 });
    h.handle.dispose();
    const h2 = boot(makeDeps({ levelCount: 2, progressHighest: 5 }));
    // Capped, on all three counts: 6 of 2 is nonsense, and so is resuming level 6.
    expect(h2.rec.levelSelects[0]).toEqual({ total: 2, unlocked: 2, cleared: 2, resume: 1 });
    h2.handle.dispose();
  });

  it('tells the HUD which level Continue resumes, including a dev-flag jump', () => {
    // The Continue button's whole claim is that it names where it lands, and where it
    // lands is `levels.start` -- which a `?dev=1&level=N` jump moves with NOTHING
    // cleared. Pushing `highestCleared` in its place would label that session "Start"
    // and then drop the player into level 3.
    //
    // Proved: hardcoding `resume: 0` fails 4 of this file's 165 tests, this one among
    // them -- and it is the only one of the four a dev-flag jump reaches.
    const h = boot(makeDeps({ levelCount: 3, levelStart: 2, progressHighest: 0 }));
    expect(h.rec.levelSelects[0]).toEqual({ total: 3, unlocked: 1, cleared: 0, resume: 2 });
    h.handle.dispose();
  });

  it('reports no progress at all for a sequence that does not track it (the sandbox)', () => {
    // A campaign unlock must not decorate a test rig's single level as cleared.
    const h = boot(makeDeps({ levelCount: 1, tracksProgress: false, progressHighest: 3 }));
    expect(h.rec.levelSelects[0]).toEqual({ total: 1, unlocked: 1, cleared: 0, resume: 0 });
    h.handle.dispose();
  });

  it('records the cleared level AT the win, and refreshes the unlock state', () => {
    // At the win event, not the Next Level click: quitting after a win keeps the
    // unlock.
    const h = boot(makeDeps({ levelCount: 2 }));
    h.setState('playing');
    h.setState('win');
    expect(h.rec.cleared).toEqual([1]);
    // `resume` moves with it, in the SAME push: `levels.start` is a live getter, so a
    // Continue button that were told only about `unlocked` would keep naming level 1
    // for the rest of the session.
    expect(h.rec.levelSelects.at(-1)).toEqual({ total: 2, unlocked: 2, cleared: 1, resume: 1 });
    h.handle.dispose();
  });

  it('starts level 1 on New Game, and leaves the unlocks alone', () => {
    // The other half of the split. `recordCleared` keeps a maximum (progress.ts), so a
    // fresh run must not re-lock anything -- and the player must not have to choose
    // between starting over and keeping what they earned.
    //
    // Proved: swapping `switchTo(0)` for `switchTo(deps.levels.start)` -- i.e. making
    // New Game a second Continue -- fails 1 of this file's 165 tests, this one.
    const h = boot(makeDeps({ levelCount: 3, progressHighest: 2 }));
    const buildsBefore = h.rec.levelBuilds.length;
    h.hud.newGame();
    // Level 1 (0-based 0) with FRESH lives, not the run's remainder: this is a new
    // game, and `undefined` is what buildWorld reads as "the arena's own default".
    expect(h.rec.levelBuilds.at(-1)).toEqual({ level: 0, lives: undefined });
    expect(h.rec.levelBuilds.length).toBe(buildsBefore + 1);
    expect(h.getState()).toBe('playing');
    // Progress untouched: nothing cleared, nothing reset, and the unlock state the HUD
    // was last told is still the full one.
    expect(h.rec.cleared).toEqual([]);
    expect(h.rec.progressResets).toBe(0);
    expect(h.rec.levelSelects.at(-1)?.unlocked).toBe(3);
    h.handle.dispose();
  });

  it('ignores a New Game that arrives outside the title screen', () => {
    // The HUD hides the button everywhere else, but a handler that rebuilds the world
    // deserves its own guard -- the same rule Quit and the level tiles follow.
    //
    // Proved: deleting the `sm.state !== 'title'` line fails 1 of this file's 165, this
    // one.
    const h = boot(makeDeps({ levelCount: 3, progressHighest: 2 }));
    h.setState('playing');
    const buildsBefore = h.rec.levelBuilds.length;
    h.hud.newGame();
    expect(h.rec.levelBuilds.length).toBe(buildsBefore);
    expect(h.getState()).toBe('playing');
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
    expect(h.rec.levelBuilds.at(-1)).toEqual({ level: 1, lives: undefined });
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

  it('starts a fresh run tally at boot and on every level switch', () => {
    const h = boot(makeDeps({ levelCount: 2 }));
    expect(h.rec.statRunStarts).toBe(1); // boot
    h.setState('win');
    h.hud.startRestart(); // advance
    expect(h.rec.statRunStarts).toBe(2);
    h.setState('playing');
    h.keydown({ key: 'Escape' });
    h.hud.quitToTitle(); // quit rebuild
    expect(h.rec.statRunStarts).toBe(3);
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
    // Level 2 open at boot, and Continue naming it.
    expect(h.rec.levelSelects.at(-1)).toEqual({ total: 2, unlocked: 2, cleared: 1, resume: 1 });
    h.hud.resetProgress();
    expect(h.rec.progressResets).toBe(1);
    // Re-locked, uncleared, and Continue back to a plain Start at level 1 -- all three
    // in the one push, so the menu cannot keep offering a level the save no longer
    // justifies.
    expect(h.rec.levelSelects.at(-1)).toEqual({ total: 2, unlocked: 1, cleared: 0, resume: 0 });
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

  it('evaluates per frame-batch with NO clearedLevel, so run feats stay dormant', () => {
    // Same fixture as the stats test, for the same reason: the driver only calls
    // onFrameEvents on EVENTFUL frames, so a countdown frame would leave the
    // assertion below vacuous. The mine's fuse expires within the first tick.
    const world = { ...createArenaWorld(1), roundStartTick: -100000 };
    world.mines.push({ id: 501, ownerId: 99, pos: { x: 1, y: 1 }, timer: 0.001, armed: true, detonated: false });
    const h = boot(makeDeps({ world }));
    h.setState('playing');
    h.fireFrame(100);
    // The mid-play checks must all carry a null clearedLevel; a non-null one here
    // would credit run feats on a level still being played.
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
    // BEFORE onFrameEvents, where stats.record runs. Evaluate run feats at the state
    // change and they see a tally one kill short: Dead Eye (shellKills ===
    // shotsFired) becomes unearnable on a normal clear and Bomb Squad misses a
    // single-mine-kill win. This asserts the check sees the FINISHED run.
    const h = boot(makeDeps({ world: winningWorld() }));
    h.setState('playing');
    h.fireFrame(100);
    const atWin = h.rec.achChecks.filter((c) => c.clearedLevel !== null);
    expect(atWin).toHaveLength(1); // the win really landed in-frame
    expect(atWin[0].runShellKills).toBeGreaterThan(0);
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
    // as a tank standing still, which no assertion on LENGTH can see.
    expect(t.ticks.some((tick) => decodeInput(tick).move.x !== 0)).toBe(true);
    h.handle.dispose();
  });

  it('stamps the world it is recording against, and restarts on a level switch', () => {
    // A trace spans ONE world. After an advance the meta must describe the NEW
    // level, or the trace replays into a different game.
    const h = boot(makeDeps({ devFlags: { replay: true }, levelCount: 3 }));
    h.setState('playing');
    h.fireFrame(100);
    expect(trace(h).meta.level).toBe(0);
    expect(trace(h).ticks).toHaveLength(6);
    expect(trace(h).meta.seed).toBe(h.rec.seeds[0]);

    h.setState('win');
    h.hud.startRestart(); // advance to level 2
    const after = trace(h);
    expect(after.meta.level).toBe(1);
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
    const rebuilt = createWorldFor(
      ARENAS[t.meta.level],
      t.meta.seed,
      t.meta.unarmedTrigger,
      t.meta.lives,
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
