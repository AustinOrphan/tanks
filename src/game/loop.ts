import { CURRENT_ARENA, arenaBounds, createArenaWorld } from '../sim/arena';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import type { Vec2, UnarmedTrigger } from '../sim/types';
import { createInputController, type InputController } from '../input/input';
import { createRenderer, type Renderer3D } from '../render/renderer';
import { createAudioEngine, type AudioEngine } from '../audio/engine';
import { AUDIO_MANIFEST } from '../audio/manifest';
import { createAudioDirector, type AudioDirector } from '../audio/director';
import { createGameStateMachine, type GameStateMachine } from './state';
import { createHud, type Hud } from './hud';
import { createDriver, type RafScheduler } from './driver';
import { roundPhase, roundPhaseTicksLeft } from '../sim/round';
import { TICK_HZ } from '../sim/constants';
import { parseDevFlags, type DevFlags } from './devflags';
import { SHELL_CAP } from '../sim/constants';

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
  removeEventListener(type: 'keydown', fn: (e: KeyboardEvent) => void): void;
  removeEventListener(type: 'resize', fn: (e: Event) => void): void;
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
    options?: { aimRay?: boolean; mineReach?: boolean; mineTimer?: boolean },
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
  readonly createWorld: (seed: number, unarmedTrigger?: UnarmedTrigger) => World;
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
  return {
    createRenderer,
    createInput: createInputController,
    createAudio: () => createAudioEngine(AUDIO_MANIFEST),
    createDirector: createAudioDirector,
    createStateMachine: createGameStateMachine,
    createHud,
    createWorld: createArenaWorld,
    now: () => performance.now(),
    wallMs: () => Date.now(),
    raf: {
      request: (cb) => requestAnimationFrame(cb),
      cancel: (h) => cancelAnimationFrame(h),
    },
    host: globalThis.window as unknown as HostWindow,
    devFlags: parseDevFlags(globalThis.location?.search ?? ''),
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
  const { width, height } = arenaBounds(CURRENT_ARENA);

  // A pinned dev seed makes a scripted playthrough reproducible; without one
  // every session is a different fight, which is right for playing and useless
  // for a before/after comparison.
  const nextSeed = (): number => deps.devFlags.seed ?? deriveSeed(deps.wallMs());

  let world = deps.createWorld(nextSeed(), deps.devFlags.mineTrigger ?? undefined);

  // Constructed EAGERLY and synchronously. main.ts wraps this call in a
  // try/catch to render a "this browser has no WebGL" page, and that only
  // works if the renderer throws out of HERE rather than out of a later
  // start(). Deferring construction breaks an error path nothing tests.
  const renderer = deps.createRenderer(canvas, width, height, CURRENT_ARENA.cellSize, {
    aimRay: deps.devFlags.aimRay,
    mineReach: deps.devFlags.mineReach,
    mineTimer: deps.devFlags.mineTimer,
  });
  const input = deps.createInput(canvas, (x, y) => renderer.screenToGround(x, y));
  const audio = deps.createAudio();
  const player = world.tanks.find((t) => t.kind === 'player');
  const director = deps.createDirector(audio, player ? player.id : -1);
  const sm = deps.createStateMachine();
  const hud = deps.createHud(uiRoot);

  function refreshStats(w: World): void {
    hud.setLives(w.lives);
    hud.setEnemiesRemaining(countEnemies(w));
    if (deps.devFlags.shellCount) {
      hud.setShellCount({ inFlight: playerShellsInFlight(w, player?.id), cap: SHELL_CAP });
    }
  }

  // Rounds restart on every RESPAWN, not just at game start (resetArena moves
  // roundStartTick), so a player with 3 lives sees the opening phases at least
  // three times. The banner teaches once per page load; every round after it
  // gets the quiet chip.
  let lastRoundStartTick: number | null = null;
  let roundsSeen = 0;
  function refreshRoundPhase(w: World): void {
    if (!deps.devFlags.roundPhaseHud) return;
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
    },
    // The event stream is shared, so a bare `some(e => e.type === 'tank-destroyed')`
    // fires on every enemy kill too -- exactly the presence-only mistake
    // CLAUDE.md warns about. Discriminate on kind.
    onFrameEvents(events): void {
      if (isPlayerDeath(events)) hud.signalPlayerDeath();
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
    } else {
      // win or lose -> rebuild a fresh arena and re-enter playing
      world = deps.createWorld(nextSeed(), deps.devFlags.mineTrigger ?? undefined);
      driver.reset(world);
      refreshStats(world);
      sm.restart();
    }
  });

  sm.onChange((s) => {
    hud.setState(s);
    if (s === 'playing') audio.startMusic();
  });

  hud.setState(sm.state); // initial title panel
  refreshStats(world);

  const onKey = (e: KeyboardEvent): void => {
    if (isMuteHotkey(e)) hud.setMuted(audio.toggleMute());
  };
  deps.host.addEventListener('keydown', onKey);

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
      input.dispose();
      renderer.dispose();
      audio.dispose();
      hud.dispose();
    },
  };
}
