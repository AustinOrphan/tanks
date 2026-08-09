import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import type { Vec2 } from '../sim/types';
import { createLevelSystem, type LevelSystem } from './levels';
import { createProgressStore, type ProgressStore } from './progress';
import { createStatsStore, type StatsStore } from './stats';
import { createCustomizationStore, type CustomizationStore, type SkinId } from './customization';
import {
  createAchievementsStore,
  type AchievementsStore,
  type AchievementContext,
} from './achievements';
import { createInputController, type InputController } from '../input/input';
import { createRenderer, type Renderer3D } from '../render/renderer';
import { createAudioEngine, type AudioEngine } from '../audio/engine';
import { AUDIO_MANIFEST } from '../audio/manifest';
import type { SuiteContext } from '../audio/suites';
import type { GameState } from './state';
import { createAudioDirector, type AudioDirector } from '../audio/director';
import { createGameStateMachine, type GameStateMachine } from './state';
import { createHud, type Hud } from './hud';
import { createDriver, type RafScheduler } from './driver';
import { roundPhase, roundPhaseTicksLeft } from '../sim/round';
import { TICK_HZ } from '../sim/constants';
import { parseDevFlags, type DevFlags } from './devflags';
import { configFor } from '../sim/config';

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
    },
  ) => Renderer3D;
  readonly createInput: (
    target: HTMLElement,
    screenToGround: (clientX: number, clientY: number) => Vec2,
  ) => InputController;
  readonly createAudio: () => AudioEngine;
  /**
   * playerId is required here even though createAudioDirector defaults it. The
   * default is DEFAULT_PLAYER_ID = 0 and no live tank is ever id 0, so taking
   * the default is a silent wrong answer -- the player never hears their own
   * cannon. Requiring it makes that a compile error instead of a defect.
   */
  readonly createDirector: (engine: AudioEngine, playerId: number) => AudioDirector;
  readonly createStateMachine: () => GameStateMachine;
  readonly createHud: (root: HTMLElement) => Hud;
  /**
   * The level sequence: how many levels exist, where this session starts, and how
   * to build the world for any of them. Injected as one object so a test can
   * substitute a two-level fake and still exercise the real advance/carry/reset
   * wiring in startGameWith.
   */
  readonly levels: LevelSystem;
  /** Saved progress: which levels are cleared. Drives level select and Start's level. */
  readonly progress: ProgressStore;
  /** The lifetime and per-run tallies, fed from the attributed event stream. */
  readonly stats: StatsStore;
  /** The paint shop's saved choice. Render-only downstream. */
  readonly customization: CustomizationStore;
  readonly achievements: AchievementsStore;
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
/**
 * localStorage can be absent or throw at ACCESS time in locked-down contexts; the
 * progress store handles throwing METHODS, so only the property access needs guarding.
 */
function browserStorage(): Storage {
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch {
    // fall through to the inert stand-in
  }
  return { getItem: () => null, setItem: () => {} } as unknown as Storage;
}

export function createBrowserDeps(): GameDeps {
  const devFlags = parseDevFlags(globalThis.location?.search ?? '');
  const progress = createProgressStore(browserStorage());
  const stats = createStatsStore(browserStorage());
  const customization = createCustomizationStore(browserStorage());
  const achievements = createAchievementsStore(browserStorage());
  return {
    createRenderer,
    createInput: createInputController,
    createAudio: () => createAudioEngine(AUDIO_MANIFEST),
    createDirector: createAudioDirector,
    createStateMachine: createGameStateMachine,
    createHud,
    levels: createLevelSystem(devFlags, progress),
    progress,
    stats,
    customization,
    achievements,
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

  let level = deps.levels.start;
  let world = buildWorld(level);

  // Constructed EAGERLY and synchronously. main.ts wraps this call in a
  // try/catch to render a "this browser has no WebGL" page, and that only
  // works if the renderer throws out of HERE rather than out of a later
  // start(). Deferring construction breaks an error path nothing tests.
  const renderer = deps.createRenderer(canvas, width, height, shownBounds.cellSize, {
    aimRay: deps.devFlags.aimRay,
    mineReach: deps.devFlags.mineReach,
    mineTimer: deps.devFlags.mineTimer,
    // The paint shop's saved colour and skin, applied from the first frame.
    playerColor: deps.customization.hexFor(deps.customization.hull()),
    playerSkin: deps.customization.skin(),
  });
  const input = deps.createInput(canvas, (x, y) => renderer.screenToGround(x, y));
  const audio = deps.createAudio();
  // MUTABLE: loadArena numbers tanks in grid-scan order, so the player's id differs
  // per arena (16 in ARENA_01, 15 in ARENA_02). Every world rebuild recomputes it and
  // rebinds the director, or the player's own cannon scores as an enemy's.
  let playerId = world.tanks.find((t) => t.kind === 'player')?.id;
  const director = deps.createDirector(audio, playerId ?? -1);
  const sm = deps.createStateMachine();
  const hud = deps.createHud(uiRoot);

  /**
   * The two evaluation moments live here. `clearedLevel` is non-null ONLY when a win
   * has just landed, which is what stops a run feat firing mid-round on a tally that
   * happens to qualify. Newly earned entries come back and become toasts.
   */
  /**
   * Set when a win lands, consumed on the SAME frame once that frame's stats are
   * recorded. The winning tank-destroyed and the win event ride one step() batch,
   * and the driver routes it to the state machine (which flips synchronously)
   * BEFORE onFrameEvents, where stats.record runs. Evaluating run feats straight
   * from the state change therefore reads a tally one kill short -- Dead Eye
   * unearnable on a normal clear, Bomb Squad blind to a single-mine-kill win,
   * Flawless granted for a mutual kill the player did not survive.
   */
  let pendingClear: number | null = null;

  function checkAchievements(clearedLevel: number | null): void {
    const ctx: AchievementContext = {
      lifetime: deps.stats.lifetime(),
      run: deps.stats.run(),
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
    input,
    renderer,
    director,
    stateMachine: sm,
    world,
    onSimulated(w): void {
      refreshStats(w);
      refreshRoundPhase(w);
      audio.setMusicIntensity(musicIntensity(countEnemies(w), enemiesAtRoundStart));
    },
    // The event stream is shared, so a bare `some(e => e.type === 'tank-destroyed')`
    // fires on every enemy kill too -- exactly the presence-only mistake
    // CLAUDE.md warns about. Discriminate on kind.
    onFrameEvents(events): void {
      if (isPlayerDeath(events)) hud.signalPlayerDeath();
      // Attributed against the CURRENT world's player: ids are arena-dependent, and
      // a stale id would misfile every stat from level 2 onward.
      deps.stats.record(events, playerId ?? -1);
      // AFTER record, so a run feat sees the run that just finished.
      checkAchievements(pendingClear);
      pendingClear = null;
      // Keep the HUD's copy fresh: the stats page re-renders only while visible, and
      // the win/lose run-summary line updates a beat after the state flips -- the
      // winning kill is in THIS batch, not the one before the panel opened.
      hud.setStats({ lifetime: deps.stats.lifetime(), run: deps.stats.run() });
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
      // Final win or game over -> back to the session's starting level with fresh
      // lives (levels.start, not 0: a dev who jumped to level 2 retries level 2).
      const advancing = sm.state === 'win' && level + 1 < deps.levels.count;
      const carried = advancing ? driver.world.lives : undefined;
      switchTo(advancing ? level + 1 : deps.levels.start, carried);
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
    playerId = world.tanks.find((t) => t.kind === 'player')?.id;
    director.setPlayerId(playerId ?? -1);
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
    // A switch is a new run: the per-run tally starts over, the lifetime rolls on.
    deps.stats.startRun();
    hud.setStats({ lifetime: deps.stats.lifetime(), run: deps.stats.run() });
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
    switchTo(picked);
    // A level click is as real a gesture as the Start button, and it starts play, so
    // it must unlock the audio context too -- Safari accepts no later opportunity.
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

  hud.onQuitToTitle(() => {
    // The HUD hides the Quit button outside pause, but a handler that rebuilds the
    // world deserves its own guard, not a CSS class as its only defence.
    if (sm.state !== 'paused') return;
    // Like the game-over path: the next Start begins a FRESH run at the session's
    // starting level with fresh lives. Rebuilt NOW rather than lazily on Start, so
    // the title screen renders over the new arena, not the abandoned game.
    switchTo(deps.levels.start);
    sm.toTitle();
  });

  // Hull and skin restyle through ONE renderer call: the style is a pair, and
  // sending half of it would reset the other half to a default.
  function restyle(): void {
    renderer.setPlayerStyle(
      deps.customization.hexFor(deps.customization.hull()),
      deps.customization.skin(),
    );
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

  hud.onResetStats(() => {
    deps.stats.resetLifetime();
    hud.setStats({ lifetime: deps.stats.lifetime(), run: deps.stats.run() });
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
    // The driver stops sampling while paused and only sample() resets the fire/mine
    // latches, so a Space pressed around or during a pause would mine on the first
    // resumed tick. At the state change, so hotkey, blur and any future pause trigger
    // all pass through the same clear. (input.ts clears itself on window blur too;
    // that covers alt-tab, this covers Esc/P.)
    if (s === 'paused') input.clearQueuedPresses();
  });

  hud.setState(sm.state); // initial title panel
  followMusic(sm.state); // ...and its music: this path bypasses sm.onChange
  hud.setLevel(level + 1, deps.levels.count);
  hud.setLevelSelect(unlockedLevels(), deps.levels.count);
  deps.stats.startRun();
  hud.setStats({ lifetime: deps.stats.lifetime(), run: deps.stats.run() });
  hud.setHullColor(deps.customization.hull());
  hud.setSkin(deps.customization.skin());
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
  };
  deps.host.addEventListener('resize', onResize);
  onResize();

  driver.start();

  return {
    dispose(): void {
      driver.stop();
      deps.host.removeEventListener('keydown', onKey);
      deps.host.removeEventListener('resize', onResize);
      deps.host.removeEventListener('blur', onBlur);
      deps.host.removeEventListener('pointerdown', onSplashGesture);
      input.dispose();
      renderer.dispose();
      audio.dispose();
      hud.dispose();
    },
  };
}
