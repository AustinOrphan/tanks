// @vitest-environment jsdom
//
// jsdom, as hud.test.ts and input.test.ts already do: isMuteHotkey does an
// `instanceof HTMLElement` check and the dispose path hands real elements
// around. frame.test.ts and driver.test.ts deliberately do NOT use jsdom.
import { describe, it, expect } from 'vitest';
import { DEV_FLAGS_OFF, type DevFlags } from './devflags';
import { CURRENT_ARENA, arenaBounds, createArenaWorld } from '../sim/arena';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import type { Vec2, Bullet, UnarmedTrigger } from '../sim/types';
import type { GameState } from './state';
import {
  isPlayerDeath,
  playerShellsInFlight,
  startGameWith,
  deriveSeed,
  isMuteHotkey,
  type GameDeps,
  type HostWindow,
} from './loop';

interface Recorder {
  rendererArgs: Array<[unknown, number, number, number, unknown]>;
  screenToGroundArgs: Array<[number, number]>;
  directorPlayerIds: number[];
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
  deathSignals: number;
  volumes: number[];
  resizes: Array<[number, number]>;
  listeners: Array<[string, (e: never) => void]>;
  removed: Array<[string, (e: never) => void]>;
  disposed: string[];
  musicStarts: number;
  unlocks: number;
  samples: number;
  hudRoots: HTMLElement[];
}

function makeDeps(opts: { world?: World; wallMs?: number; devFlags?: Partial<DevFlags> } = {}): {
  deps: GameDeps;
  rec: Recorder;
  fireFrame(now: number): void;
  hasFrame(): boolean;
  hud: {
    mute(): void;
    volume(v: number): void;
    startRestart(): void;
  };
  setState(s: GameState): void;
  keydown(e: Partial<KeyboardEvent>): void;
  resize(): void;
} {
  const rec: Recorder = {
    rendererArgs: [],
    screenToGroundArgs: [],
    directorPlayerIds: [],
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
    deathSignals: 0,
    volumes: [],
    resizes: [],
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
        dispose: () => rec.disposed.push('hud'),
      };
    },
    createWorld: (seed, policy) => {
      rec.seeds.push(seed);
      rec.worldPolicies.push(policy);
      return opts.world ?? createArenaWorld(seed);
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
    },
    setState: (s) => {
      state = s;
      emit();
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
  it('registers keydown and resize, and sizes the canvas once at boot', () => {
    const h = boot();
    expect(h.rec.listeners.map(([t]) => t).sort()).toEqual(['keydown', 'resize']);
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
    expect(h.rec.removed).toHaveLength(2);
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
    // Population: all three enemy kinds in TankKind.
    for (const kind of ['brown', 'grey', 'teal']) {
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
