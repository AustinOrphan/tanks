// No `@vitest-environment` pragma: this runs under the global `environment:
// 'node'`, which is what keeps driver.ts free of the DOM.
//
// These tests use the REAL `step` and a real arena world, and fake only what
// the driver is handed. That is deliberate: faking `step` would make this file
// blind to whether the loop actually simulates, which is the entire defect
// being closed here.
import { describe, it, expect } from 'vitest';
import { createArenaWorld } from '../sim/arena';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import type { InputState } from '../sim/types';
import type { GameState } from './state';
import { createDriver, type Driver, type RafScheduler } from './driver';
import { MAX_FRAME_DT } from './frame';

const IDLE: InputState = { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: false, mine: false };

interface RenderCall {
  prev: World;
  curr: World;
  alpha: number;
  events: SimEvent[];
  dt: number;
}

/**
 * A rAF that never runs anything by itself. The test decides when a frame
 * happens and what the clock says, so a frame is an assertion, not a race.
 */
function fakeRaf(): {
  scheduler: RafScheduler;
  pending: Array<(now: number) => void>;
  issued: number[];
  cancelled: number[];
  /** Fire the most recently queued callback with this timestamp. */
  fire(now: number): void;
  /** The callback the driver last queued, to invoke by hand after stop(). */
  last(): (now: number) => void;
} {
  const pending: Array<(now: number) => void> = [];
  const issued: number[] = [];
  const cancelled: number[] = [];
  let next = 1;
  return {
    pending,
    issued,
    cancelled,
    scheduler: {
      request(cb): number {
        pending.push(cb);
        const h = next++;
        issued.push(h);
        return h;
      },
      cancel(h): void {
        cancelled.push(h);
      },
    },
    fire(now): void {
      const cb = pending.pop();
      if (!cb) throw new Error('no frame queued');
      pending.length = 0;
      cb(now);
    },
    last(): (now: number) => void {
      const cb = pending[pending.length - 1];
      if (!cb) throw new Error('no frame queued');
      return cb;
    },
  };
}

function harness(
  opts: {
    state?: GameState;
    input?: InputState;
    world?: World;
    /** Mirrors the real machine: onEvents can flip 'playing' -> 'win'/'lose'. */
    endOnEvents?: GameState;
  } = {},
): {
  driver: Driver;
  raf: ReturnType<typeof fakeRaf>;
  renders: RenderCall[];
  directed: SimEvent[][];
  hapticsSaw: SimEvent[][];
  machineSaw: SimEvent[][];
  simulated: World[];
  framed: SimEvent[][];
  samples: number;
  setState(s: GameState): void;
  state(): GameState;
} {
  const raf = fakeRaf();
  const renders: RenderCall[] = [];
  const directed: SimEvent[][] = [];
  const hapticsSaw: SimEvent[][] = [];
  const machineSaw: SimEvent[][] = [];
  const simulated: World[] = [];
  const framed: SimEvent[][] = [];
  let state: GameState = opts.state ?? 'playing';
  const box = { samples: 0 };

  const driver = createDriver({
    now: () => 0,
    raf: raf.scheduler,
    input: {
      sample(): InputState {
        box.samples += 1;
        return opts.input ?? IDLE;
      },
    },
    renderer: {
      render(prev, curr, alpha, events, dt): void {
        renders.push({ prev, curr, alpha, events, dt });
      },
    },
    director: {
      handle(events): void {
        directed.push(events);
      },
    },
    haptics: {
      handle(events): void {
        hapticsSaw.push(events);
      },
    },
    stateMachine: {
      get state(): GameState {
        return state;
      },
      onEvents(events): void {
        machineSaw.push(events);
        // The real machine transitions HERE, inside the frame, between the
        // driver's two reads of `state`.
        if (opts.endOnEvents) state = opts.endOnEvents;
      },
    },
    world: opts.world ?? createArenaWorld(1),
    onFrameEvents(evs): void {
      framed.push(evs);
    },
    onSimulated(w): void {
      simulated.push(w);
    },
  });

  return {
    driver,
    raf,
    renders,
    directed,
    hapticsSaw,
    machineSaw,
    simulated,
    framed,
    get samples(): number {
      return box.samples;
    },
    setState(s): void {
      state = s;
    },
    state: () => state,
  };
}

describe('driver: simulation', () => {
  it('steps the sim on a playing frame', () => {
    // THE canonical hole: `while (false && acc >= DT)` passes the whole gate on
    // main. Only pumping a frame through the real driver can see it.
    const h = harness();
    h.driver.start();
    h.raf.fire(20);
    expect(h.driver.world.tick).toBe(1);
  });

  it('runs the whole tick debt of a slow frame', () => {
    // A steady-60Hz test cannot distinguish "runs the debt" from "runs one".
    const h = harness();
    h.driver.start();
    h.raf.fire(100);
    expect(h.driver.world.tick).toBe(6);
  });

  it.each(['title', 'paused'] as const)(
    'does not step while %s, but still renders the frozen pose',
    (state) => {
      // 'paused' deliberately rides the same hold-pose path as the title screen:
      // sim frozen, renderer live, accumulator dropped so resume repays nothing.
      const h = harness({ state });
      h.driver.start();
      h.raf.fire(100);
      expect(h.driver.world.tick).toBe(0);
      expect(h.renders).toHaveLength(1);
    },
  );

  it('samples input once per tick, not once per frame', () => {
    const h = harness();
    h.driver.start();
    h.raf.fire(100);
    expect(h.samples).toBe(6);
  });

  it('reports the live world once per simulating frame', () => {
    // Dropping this freezes lives and enemies-remaining on the HUD for the
    // whole game while the sim runs on underneath.
    const h = harness();
    h.driver.start();
    h.raf.fire(20);
    expect(h.simulated).toHaveLength(1);
    expect(h.simulated[0].tick).toBe(1);
  });

  it('does not report a non-simulating frame', () => {
    const h = harness({ state: 'title' });
    h.driver.start();
    h.raf.fire(100);
    expect(h.simulated).toHaveLength(0);
  });
});

describe('driver: event routing', () => {
  // A shared stream: asserting `events.some(e => e.type === 'fire')` passes on
  // an AI tank's shell even when the player's is dropped entirely. Discriminate
  // by ownerId, and assert the payload -- particles draw at exactly ev.pos.
  function firedByPlayer(): {
    h: ReturnType<typeof harness>;
    playerId: number;
  } {
    // The round opens with 180 countdown ticks (GRACE_TICKS is 0, so no grace span), and
    // `canAct` is false through both, so a fresh world cannot fire on tick 1.
    // Back-dating roundStartTick starts the fixture 'live' -- pumping the real
    // 5 seconds instead would hand the AI 300 ticks to destroy the player and
    // make this test depend on the seed surviving a firefight.
    const world = { ...createArenaWorld(1), roundStartTick: -1000 };
    const player = world.tanks.find((t) => t.kind === 'player');
    if (!player) throw new Error('fixture has no player tank');
    const h = harness({
      world,
      input: { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: true, mine: false },
    });
    h.driver.start();
    h.raf.fire(20);
    return { h, playerId: player.id };
  }

  it("hands the director the player's own shell, with the position it was fired from", () => {
    const { h, playerId } = firedByPlayer();
    const all = h.directed.flat();
    const mine = all.filter((e) => e.type === 'fire' && e.ownerId === playerId);
    expect(mine).toHaveLength(1);
    const ev = mine[0] as Extract<SimEvent, { type: 'fire' }>;
    expect(Number.isFinite(ev.pos.x)).toBe(true);
    expect(Number.isFinite(ev.pos.y)).toBe(true);
    expect(typeof ev.angle).toBe('number');
  });

  it('feeds the same events to the state machine', () => {
    const { h, playerId } = firedByPlayer();
    const seen = h.machineSaw.flat().filter((e) => e.type === 'fire' && e.ownerId === playerId);
    expect(seen).toHaveLength(1);
  });

  it('feeds the same events to haptics, on the same terms as the director', () => {
    // A fourth consumer (haptics.ts) is wired at the same call site as the
    // director -- if it drifted to a different batch, a player-fire pulse could
    // land on a frame that carried an enemy shot instead.
    const { h, playerId } = firedByPlayer();
    expect(h.hapticsSaw).toHaveLength(1);
    expect(h.hapticsSaw[0].filter((e) => e.type === 'fire' && e.ownerId === playerId)).toHaveLength(1);
    expect(h.hapticsSaw[0]).toEqual(h.directed[0]);
  });

  it('passes this frame\'s events to the renderer, and an empty list when there were none', () => {
    const { h, playerId } = firedByPlayer();
    const first = h.renders[0];
    expect(first.events.filter((e) => e.type === 'fire' && e.ownerId === playerId)).toHaveLength(1);
    // A second frame with nothing happening must not re-deliver the first
    // frame's events, or particles would burst again at a stale position.
    h.raf.fire(40);
    expect(h.renders[1].events.every((e) => e.type !== 'fire')).toBe(true);
  });

  it('hands the same frame events to the extra consumer', () => {
    // A fourth consumer (loop.ts drives HUD damage feedback from it) must see
    // the same frame the director, haptics and the machine do, or they drift.
    const { h, playerId } = firedByPlayer();
    expect(h.framed).toHaveLength(1);
    expect(h.framed[0].filter((e) => e.type === 'fire' && e.ownerId === playerId)).toHaveLength(1);
    expect(h.framed[0]).toEqual(h.directed[0]);
  });

  it('routes nothing when the frame produced no events', () => {
    const h = harness();
    h.driver.start();
    h.raf.fire(20);
    expect(h.directed).toHaveLength(0);
    expect(h.hapticsSaw).toHaveLength(0);
    expect(h.machineSaw).toHaveLength(0);
    expect(h.framed).toHaveLength(0);
  });
});

describe('driver: interpolation', () => {
  it('renders FROM the pre-tick pose TO the post-tick pose', () => {
    const h = harness();
    h.driver.start();
    h.raf.fire(20);
    const r = h.renders[0];
    expect(r.prev.tick).toBe(0);
    expect(r.curr.tick).toBe(1);
  });

  it('advances prev with curr across frames, one tick apart', () => {
    const h = harness();
    h.driver.start();
    h.raf.fire(20);
    h.raf.fire(40);
    const r = h.renders[1];
    expect(r.curr.tick).toBe(2);
    expect(r.prev.tick).toBe(1);
  });

  it('renders at the fraction of a tick the accumulator is holding', () => {
    // Assert the alpha ARGUMENT. entities.sync clamps to [0,1], so a rendered
    // position absorbs both Infinity and an unbounded alpha without complaint.
    const h = harness();
    h.driver.start();
    h.raf.fire(25); // 1.5 ticks: one runs, half a tick is carried
    expect(h.renders[0].alpha).toBeCloseTo(0.5, 6);
  });

  it('renders a non-simulating frame at a full alpha', () => {
    const h = harness({ state: 'title' });
    h.driver.start();
    h.raf.fire(25);
    expect(h.renders[0].alpha).toBe(1);
  });

  it('renders the frame that ENDS the game at a full alpha', () => {
    // The machine flips to 'win' inside onEvents -- DURING this frame, between
    // the driver's two reads of sm.state. The frame that ends the game must
    // show the final pose whole, not a fraction of a tick short of it.
    // Hoisting both reads into one const renders it at the carried 0.5 instead;
    // hoisting only the second read is harmless and must keep passing.
    const world = { ...createArenaWorld(1), roundStartTick: -1000 };
    const h = harness({
      world,
      input: { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: true, mine: false },
      endOnEvents: 'win',
    });
    h.driver.start();
    h.raf.fire(25); // 1.5 ticks: one runs and fires, half a tick is carried
    expect(h.machineSaw.length).toBeGreaterThan(0); // the flip really happened
    expect(h.state()).toBe('win');
    const r = h.renders[0];
    expect(r.alpha).toBe(1);
    // and it really did simulate this frame, so this is not the idle branch
    expect(r.curr.tick).toBe(1);
  });

  it("renders curr's pose on the frames after a game ends mid-run", () => {
    // The frame AFTER the end takes the idle branch: prev collapses onto curr
    // so nothing lerps, and alpha is full. Scoping this to a title frame from
    // boot would make the prev === curr half unfalsifiable, since they are
    // already identical before any tick runs.
    const world = { ...createArenaWorld(1), roundStartTick: -1000 };
    const h = harness({
      world,
      input: { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: true, mine: false },
      endOnEvents: 'win',
    });
    h.driver.start();
    h.raf.fire(25);
    expect(h.renders[0].prev).not.toBe(h.renders[0].curr); // it ticked first
    h.raf.fire(50);
    const after = h.renders[1];
    expect(after.prev).toBe(after.curr);
    expect(after.alpha).toBe(1);
  });

  it('passes the CLAMPED real dt to the renderer', () => {
    // particles.update integrates this; passing 0 freezes every explosion at
    // its spawn point and the pool never recycles.
    const h = harness();
    h.driver.start();
    h.raf.fire(20);
    expect(h.renders[0].dt).toBeCloseTo(0.02, 9);
    h.raf.fire(20 + 5000);
    expect(h.renders[1].dt).toBe(MAX_FRAME_DT);
  });
});

describe('driver: the render animation clock', () => {
  // frame.test.ts pins what `animationDt` decides. This block pins that the driver
  // APPLIES it -- the composition blindness `step-pipeline.test.ts` exists for, one
  // layer up: deleting the call and passing `plan.dt` straight through leaves every
  // animationDt case in frame.test.ts green.
  //
  // The renderer forwards this dt to BOTH `entities.sync` (an animated skin's texture
  // offset) and `particles.update` (debris in flight), so these two cases are the
  // whole of what stops and what keeps running.

  it('freezes the clock while PAUSED, on a frame that really did render', () => {
    // The production change this catches: removing the pause carve-out from
    // driver.ts -- i.e. going back to `render(..., plan.dt)`, which is what main
    // shipped. Debris then keeps expanding and fading through a pause taken to look
    // at the board, and `flow` keeps scrolling.
    const h = harness({ state: 'paused' });
    h.driver.start();
    h.raf.fire(100);
    expect(h.renders).toHaveLength(1);
    expect(h.renders[0].dt).toBe(0);
  });

  it.each(['splash', 'title', 'win', 'lose'] as const)(
    'keeps running while %s, which does NOT simulate either',
    (state) => {
      // The opposite production change, and the reason the paused case above is not
      // just "the else branch zeroes dt": widening the carve-out to the whole
      // non-playing branch would kill this. 100ms is under MAX_FRAME_DT, so the
      // clamp is not what is being read here.
      const h = harness({ state });
      h.driver.start();
      h.raf.fire(100);
      expect(h.driver.world.tick).toBe(0); // really the non-simulating branch
      expect(h.renders[0].dt).toBeCloseTo(0.1, 9);
    },
  );
});

describe('driver: lifecycle', () => {
  it('schedules nothing until start(), then schedules the first frame', () => {
    const h = harness();
    expect(h.raf.issued).toHaveLength(0);
    h.driver.start();
    expect(h.raf.issued).toHaveLength(1);
  });

  it('reschedules itself, so there is a second frame and a third', () => {
    const h = harness();
    h.driver.start();
    h.raf.fire(20);
    h.raf.fire(40);
    h.raf.fire(60);
    expect(h.renders).toHaveLength(3);
    expect(h.driver.world.tick).toBe(3);
  });

  it('cancels the handle it issued MOST RECENTLY, not a stale one', () => {
    // A render-count-after-dispose assertion kills neither the missing cancel
    // nor a handle that is never reassigned inside the frame.
    const h = harness();
    h.driver.start();
    h.raf.fire(20);
    h.raf.fire(40);
    const newest = h.raf.issued[h.raf.issued.length - 1];
    h.driver.stop();
    expect(h.raf.cancelled).toContain(newest);
  });

  it('does nothing when an already-queued callback fires after stop()', () => {
    const h = harness();
    h.driver.start();
    h.raf.fire(20);
    const queued = h.raf.last();
    h.driver.stop();
    const before = h.driver.world.tick;
    queued(40); // the browser had already committed to this callback
    expect(h.driver.world.tick).toBe(before);
    expect(h.renders).toHaveLength(1);
  });

  it('reset() replaces the world and drops carried time', () => {
    // `world`/`prevWorld` must be getters: a plain property snapshots the
    // reference at construction and this reads the pre-reset world.
    const h = harness();
    h.driver.start();
    h.raf.fire(25); // one tick, half a tick carried
    const fresh = createArenaWorld(99);
    h.driver.reset(fresh);
    expect(h.driver.world).toBe(fresh);
    expect(h.driver.prevWorld).toBe(fresh);
    // Carried time dropped: 14ms alone is under DT, so no tick may run. Had the
    // half-tick survived the reset, this frame would tick.
    h.raf.fire(39);
    expect(h.driver.world.tick).toBe(0);
  });
});
