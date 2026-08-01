// @vitest-environment jsdom
//
// jsdom, as hud.test.ts and input.test.ts already do: isMuteHotkey does an
// `instanceof HTMLElement` check and the dispose path hands real elements
// around. frame.test.ts and driver.test.ts deliberately do NOT use jsdom.
import { describe, it, expect } from 'vitest';
import { DEV_FLAGS_OFF, type DevFlags } from './devflags';
import { ZERO_STATS } from './stats';
import { TANK_KINDS } from '../sim/config';
import { CURRENT_ARENA, arenaBounds, createArenaWorld } from '../sim/arena';
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
  isPauseHotkey,
  type GameDeps,
  type HostWindow,
} from './loop';

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
  cleared: number[];
  progressResets: number;
  statBatches: Array<{ count: number; playerId: number }>;
  statRunStarts: number;
  statResets: number;
  statPushes: number;
  levelSelects: Array<[number, number]>;
  builtWorlds: World[];
  volumes: number[];
  resizes: Array<[number, number]>;
  refits: Array<[number, number, number]>;
  listeners: Array<[string, (e: never) => void]>;
  removed: Array<[string, (e: never) => void]>;
  disposed: string[];
  musicStarts: number;
  unlocks: number;
  samples: number;
  hudRoots: HTMLElement[];
}

function makeDeps(opts: { world?: World; wallMs?: number; devFlags?: Partial<DevFlags>; levelCount?: number; levelStart?: number; staticRoundStart?: boolean; tracksProgress?: boolean; progressHighest?: number; boundsByLevel?: Array<{ width: number; height: number; cellSize: number }> } = {}): {
  deps: GameDeps;
  rec: Recorder;
  fireFrame(now: number): void;
  hasFrame(): boolean;
  hud: {
    mute(): void;
    volume(v: number): void;
    startRestart(): void;
    quitToTitle(): void;
    pickLevel(i: number): void;
    resetStats(): void;
    resetProgress(): void;
  };
  setState(s: GameState): void;
  getState(): GameState;
  keydown(e: Partial<KeyboardEvent>): void;
  blur(): void;
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
    listeners: [],
    removed: [],
    disposed: [],
    musicStarts: 0,
    unlocks: 0,
    samples: 0,
    hudRoots: [],
  };

  let pending: ((now: number) => void) | null = null;
  let state: GameState = 'title';
  const changeCbs: Array<(s: GameState) => void> = [];
  let onMute = (): void => {};
  let onVolume = (_v: number): void => {};
  let onStartRestart = (): void => {};
  let onQuit = (): void => {};
  let onResetStats = (): void => {};
  let onResetProgress = (): void => {};
  let onPickLevel = (_i: number): void => {};

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
        dispose(): void {
          rec.disposed.push('renderer');
        },
      };
    },
    createInput: (_target, screenToGround) => ({
      sample() {
        rec.samples += 1;
        // Prove the wiring passes x and y through in that order, not swapped.
        screenToGround(3, 7);
        return { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: false, mine: false };
      },
      clearQueuedPresses(): void {
        rec.inputClears += 1;
      },
      dispose(): void {
        rec.disposed.push('input');
      },
    }),
    createAudio: () => ({
      play: () => {},
      startMusic: () => {
        rec.musicStarts += 1;
      },
      stopMusic: () => {},
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
      },
      toTitle(): void {
        state = 'title';
        emit();
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
        setMuted: (m) => rec.muted.push(m),
        setShellCount: (i) => rec.shellCounts.push(i),
        setLevel: (c: number, t: number) => rec.hudLevels.push([c, t]),
        setRoundPhase: (info) => rec.roundPhases.push(info),
        signalPlayerDeath: () => { rec.deathSignals += 1; },
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
        setStats: () => {
          rec.statPushes += 1;
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
        dispose: () => rec.disposed.push('hud'),
      };
    },
    stats: {
      lifetime: () => ({ ...ZERO_STATS }),
      run: () => ({ ...ZERO_STATS }),
      record: (events: SimEvent[], playerId: number) => {
        rec.statBatches.push({ count: events.length, playerId });
      },
      startRun: () => {
        rec.statRunStarts += 1;
      },
      resetLifetime: () => {
        rec.statResets += 1;
      },
    },
    progress: (() => {
      // Mutable base so reset() models the real store: everything re-locks,
      // including clears that predate this session.
      let base = opts.progressHighest ?? 0;
      return {
        highestCleared: () => Math.max(base, ...rec.cleared, 0),
        recordCleared: (level: number) => {
          rec.cleared.push(level);
        },
        reset: () => {
          rec.progressResets += 1;
          rec.cleared.length = 0;
          base = 0;
        },
      };
    })(),
    levels: {
      // Defaults to a ONE-level sequence: every pre-progression test in this file was
      // written against "restart rebuilds the same arena", which is exactly what a
      // one-level sequence still does. Progression tests opt into more.
      count: opts.levelCount ?? 1,
      // LIVE, like the real system: an unlock earned mid-session must move the
      // session's start. A fixed opts.levelStart models a dev-flag jump.
      get start(): number {
        if (opts.levelStart !== undefined) return opts.levelStart;
        const cleared = Math.max(opts.progressHighest ?? 0, ...rec.cleared, 0);
        return Math.min(cleared, (opts.levelCount ?? 1) - 1);
      },
      tracksProgress: opts.tracksProgress ?? true,
      bounds: (level: number) =>
        opts.boundsByLevel?.[level] ?? { width: 22, height: 18, cellSize: 2 },
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
        const tanks = level === 0 ? base.tanks
          : base.tanks.map((t) => (t.kind === 'player' ? { ...t, id: t.id + 70 + level } : t));
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
    devFlags: { ...DEV_FLAGS_OFF, ...opts.devFlags },
  };

  return {
    deps,
    rec,
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
      pickLevel: (i) => onPickLevel(i),
      resetStats: () => onResetStats(),
      resetProgress: () => onResetProgress(),
    },
    setState: (s) => {
      state = s;
      emit();
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
    resize(): void {
      const entry = rec.listeners.find(([t]) => t === 'resize');
      if (!entry) throw new Error('no resize listener');
      (entry[1] as () => void)();
    },
  };
}

function boot(h = makeDeps()): ReturnType<typeof makeDeps> & { handle: { dispose(): void } } {
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
    expect(boundary).toBe(CURRENT_ARENA.cellSize);
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

  it('starts the music when, and only when, play begins', () => {
    const h = boot();
    expect(h.rec.musicStarts).toBe(0);
    h.setState('playing');
    expect(h.rec.musicStarts).toBe(1);
    h.handle.dispose();
  });

  it('shows the initial state and stats before any frame runs', () => {
    const h = boot();
    expect(h.rec.hudStates[0]).toBe('title');
    expect(h.rec.lives.length).toBeGreaterThan(0);
    h.handle.dispose();
  });
});

describe('startGameWith: listeners and teardown', () => {
  it('registers keydown, resize and blur, and sizes the canvas once at boot', () => {
    const h = boot();
    expect(h.rec.listeners.map(([t]) => t).sort()).toEqual(['blur', 'keydown', 'resize']);
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
    expect(h.rec.removed).toHaveLength(3);
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
    // to fire through the fake input.
    for (let i = 1; i <= 12; i++) h.fireFrame(i * 100);
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
    expect(off.rec.rendererArgs[0][4]).toEqual({ aimRay: false, mineReach: false, mineTimer: false });
    off.handle.dispose();
  });

  it('asks for each overlay only when its own flag is on', () => {
    // One at a time, so a wiring that turns them all on together -- or crosses two of
    // them -- fails rather than passing on the aggregate.
    const ray = boot(makeDeps({ devFlags: { aimRay: true } }));
    expect(ray.rec.rendererArgs[0][4]).toEqual({ aimRay: true, mineReach: false, mineTimer: false });
    ray.handle.dispose();

    const reach = boot(makeDeps({ devFlags: { mineReach: true } }));
    expect(reach.rec.rendererArgs[0][4]).toEqual({ aimRay: false, mineReach: true, mineTimer: false });
    reach.handle.dispose();

    const timer = boot(makeDeps({ devFlags: { mineTimer: true } }));
    expect(timer.rec.rendererArgs[0][4]).toEqual({ aimRay: false, mineReach: false, mineTimer: true });
    timer.handle.dispose();
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

describe('startGameWith: round-phase HUD (dev flag)', () => {
  function withFlag(on: boolean): ReturnType<typeof makeDeps> {
    // A world that starts in countdown: roundStartTick equal to tick.
    const base = createArenaWorld(1);
    return makeDeps({
      world: { ...base, tick: 0, roundStartTick: 0 },
      devFlags: { roundPhaseHud: on, aimRay: false, shellCount: false },
    });
  }

  it('says NOTHING to the HUD when the flag is off', () => {
    // Default-off must be byte-identical to not having the feature.
    const h = boot(withFlag(false));
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.roundPhases).toHaveLength(0);
    h.handle.dispose();
  });

  it('drives the HUD when the flag is on', () => {
    const h = boot(withFlag(true));
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.roundPhases.length).toBeGreaterThan(0);
    const first = h.rec.roundPhases[0];
    expect(first?.phase).toBe('countdown');
    expect(first?.secondsLeft).toBeGreaterThan(0);
    h.handle.dispose();
  });

  it('makes the FIRST round of the page load prominent', () => {
    const h = boot(withFlag(true));
    h.setState('playing');
    h.fireFrame(100);
    expect(h.rec.roundPhases[0]?.prominent).toBe(true);
    h.handle.dispose();
  });

  it('drops to the quiet chip on the next round', () => {
    // Rounds restart on every respawn, not just a new game -- resetArena moves
    // roundStartTick -- so the second round must not re-teach.
    const h = boot(withFlag(true));
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

  it('hides once the round goes live', () => {
    const base = createArenaWorld(1);
    const h = boot(
      makeDeps({
        // Far past COUNTDOWN_TICKS + GRACE_TICKS.
        world: { ...base, tick: 5000, roundStartTick: 0 },
        devFlags: { roundPhaseHud: true, aimRay: false, shellCount: false },
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
      devFlags: { roundPhaseHud: true },
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
    const h = boot(makeDeps());
    h.setState('playing');
    h.keydown({ key: 'Escape' });
    expect(h.rec.inputClears).toBe(1);
    h.keydown({ key: 'Escape' }); // resume: no extra clear
    h.blur(); // auto-pause: clears again
    expect(h.rec.inputClears).toBe(2);
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
    expect(h.rec.levelSelects.at(-1)).toEqual([2, 2]); // level 2 open at boot
    h.hud.resetProgress();
    expect(h.rec.progressResets).toBe(1);
    expect(h.rec.levelSelects.at(-1)).toEqual([1, 2]); // re-locked
    h.handle.dispose();
  });
});
