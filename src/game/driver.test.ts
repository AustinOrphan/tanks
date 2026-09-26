// No `@vitest-environment` pragma: this runs under the global `environment:
// 'node'`, which is what keeps driver.ts free of the DOM.
//
// These tests use the REAL `step` and a real arena world, and fake only what
// the driver is handed. That is deliberate: faking `step` would make this file
// blind to whether the loop actually simulates, which is the entire defect
// being closed here.
import { describe, it, expect } from 'vitest';
import { createArenaWorld, createWorldFor, arenaById } from '../sim/arena';
import { step, type World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import type { InputState } from '../sim/types';
import { createDriver, type Driver, type RafScheduler, type FrameEvent } from './driver';
import { MAX_FRAME_DT } from './frame';

/**
 * The fixture's canonical driver-facing session state -- the six positions the
 * production state machine can end up in that this driver cares about, mapped
 * to the two bools the driver reads (`isSimulating`, `isPaused`).
 *
 * `launch` was `'splash'`, `main-menu` was `'title'`, and `outcome` was
 * `'win'`/`'lose'` in the retired GameState union.
 */
type DriverState = 'launch' | 'main-menu' | 'playing' | 'paused' | 'outcome';

const isSimulatingFor = (s: DriverState): boolean => s === 'playing';
const isPausedFor = (s: DriverState): boolean => s === 'paused';

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
    state?: DriverState;
    input?: InputState;
    /**
     * The FULL per-slot list `sample()` returns, for a co-op fixture. Takes priority
     * over `input` when given -- `input` alone stays the single-slot shorthand every
     * pre-existing test in this file uses.
     */
    inputs?: InputState[];
    world?: World;
    /** Mirrors the real machine: onEvents can flip `playing` -> `outcome`. */
    endOnEvents?: DriverState;
    /** Throw this from the FIRST `input.sample()` only, and sample normally after (issue #690). */
    throwOnFirstSample?: unknown;
  } = {},
): {
  driver: Driver;
  raf: ReturnType<typeof fakeRaf>;
  renders: RenderCall[];
  announcements: number[];
  directed: SimEvent[][];
  hapticsSaw: SimEvent[][];
  machineSaw: SimEvent[][];
  /** Every batch routed through `settleSteppedTick` (issue #253), apart from `onEvents`'. */
  settled: SimEvent[][];
  simulated: World[];
  framed: SimEvent[][];
  samples: number;
  setState(s: DriverState): void;
  state(): DriverState;
} {
  const raf = fakeRaf();
  const renders: RenderCall[] = [];
  /** `renders.length` at each `worldReplaced()` call -- see the renderer double below. */
  const announcements: number[] = [];
  const directed: SimEvent[][] = [];
  const hapticsSaw: SimEvent[][] = [];
  const machineSaw: SimEvent[][] = [];
  const settled: SimEvent[][] = [];
  const simulated: World[] = [];
  const framed: SimEvent[][] = [];
  let state: DriverState = opts.state ?? 'playing';
  const box = { samples: 0 };

  const driver = createDriver({
    now: () => 0,
    raf: raf.scheduler,
    input: {
      sample(): InputState[] {
        box.samples += 1;
        if (box.samples === 1 && 'throwOnFirstSample' in opts) throw opts.throwOnFirstSample;
        return opts.inputs ?? [opts.input ?? IDLE];
      },
    },
    renderer: {
      render(prev, curr, alpha, events, dt): void {
        renders.push({ prev, curr, alpha, events, dt });
      },
      worldReplaced(): void {
        // Pushed at the moment of the call, not counted, so a test can assert the
        // announcement's ORDER against the renders around it -- the property that
        // matters is that no frame renders a replaced world before hearing about it.
        announcements.push(renders.length);
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
      get isSimulating(): boolean {
        return isSimulatingFor(state);
      },
      get isPaused(): boolean {
        return isPausedFor(state);
      },
      onEvents(events): void {
        machineSaw.push(events);
        // The real machine transitions HERE, inside the frame, between the
        // driver's two reads of `isSimulating`/`isPaused`.
        if (opts.endOnEvents) state = opts.endOnEvents;
      },
      settleSteppedTick(events): void {
        settled.push(events);
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
    announcements,
    directed,
    hapticsSaw,
    machineSaw,
    settled,
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

  it.each(['main-menu', 'paused'] as const)(
    'does not step while %s, but still renders the frozen pose',
    (state) => {
      // `paused` deliberately rides the same hold-pose path as the Main Menu route:
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
    const h = harness({ state: 'main-menu' });
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

  it('stamps each event with the tick that produced it, not the frame\'s final tick', () => {
    // Same fixture firedByPlayer() uses (backdated roundStartTick, held fire) but driven
    // through ONE frame spanning several ticks, so the shot -- fired on the frame's
    // FIRST simulated tick -- is not also the frame's last tick. That is what makes the
    // assertion below discriminate both a missing stamp (undefined is never < anything)
    // and a mutant that stamps every event with the frame's final tick (equal is not
    // strictly less).
    const world = { ...createArenaWorld(1), roundStartTick: -1000 };
    const h = harness({
      world,
      input: { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: true, mine: false },
    });
    h.driver.start();
    h.raf.fire(60); // dtReal 60ms at DT ~16.667ms -> floor(0.06 * 60) = 3 ticks, one frame
    const events = h.directed[0] as FrameEvent[];
    const fire = events.find((e) => e.type === 'fire');
    expect(fire).toBeDefined();
    expect(fire!.tick).toBeLessThan(h.driver.world.tick);
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

describe('driver: list-shaped input (couch co-op)', () => {
  // driver.ts's own step -> stepInputs migration: `DriverDeps.input` is now
  // `sample(): InputState[]`, always, even at playerCount 1 -- no branch on list
  // length. These two tests are the driver-layer half of that claim; the sim-layer
  // half (stepInputs pairs inputs[i] with the i-th player tank, and step() is exactly
  // stepInputs(world, [input])) is pinned in sim/step-inputs.test.ts and is NOT
  // re-proven here -- what step-inputs.test.ts cannot see is whether THIS driver
  // actually calls stepInputs with the list its own input collaborator hands it,
  // which is the composition-blindness gap docs/agent/testing-and-review.md names for
  // step-pipeline.test.ts.

  it('pairs slot i with the i-th controlledBy tank in a REAL 2-player world -- the driver-layer twin of step-inputs.test.ts\'s "pairs by position" test', () => {
    const base = createWorldFor(arenaById('arena-01'), 1, { lives: 3, playerCount: 2, rules: { unarmedTrigger: 'none', corpseBlocksShells: false, muzzleClearsTanks: true } });
    // Past countdown+grace, so input is live -- same convention firedByPlayer() above
    // uses, for the same reason (a fresh world cannot act on tick 1).
    const world = { ...base, roundStartTick: -1000 };
    const spawnA = world.tanks.find((t) => t.controlledBy === 0)!.pos;
    const spawnB = world.tanks.find((t) => t.controlledBy === 1)!.pos;
    // Sanity: this is really a co-op world, or the test below would pass vacuously
    // with only one player tank ever driven.
    expect(world.tanks.filter((t) => t.kind === 'player')).toHaveLength(2);

    const inputA: InputState = { move: { x: 1, y: 0 }, aim: { x: 5, y: 15 }, fire: false, mine: false };
    const inputB: InputState = { move: { x: -1, y: 0 }, aim: { x: -5, y: 15 }, fire: false, mine: false };
    const h = harness({ world, inputs: [inputA, inputB] });
    h.driver.start();
    h.raf.fire(20); // one tick

    const a = h.driver.world.tanks.find((t) => t.controlledBy === 0)!;
    const b = h.driver.world.tanks.find((t) => t.controlledBy === 1)!;
    expect(a.desiredMove).toEqual({ x: 1, y: 0 });
    expect(b.desiredMove).toEqual({ x: -1, y: 0 });
    // Positions too, not just the intent field, and each relative to its OWN spawn --
    // a slot mix-up would move A the way B's input says instead.
    expect(a.pos.x).toBeGreaterThan(spawnA.x);
    expect(b.pos.x).toBeLessThan(spawnB.x);
  });

  it('N=1 structural identity: the resulting world and events equal what a step()-based driver would have produced', () => {
    // "Feed the OLD driver-shape fixture as a 1-length list" (the plan's own framing):
    // the LEFT side here never touches the driver at all -- it drives step(), the
    // pre-existing single-input adapter, directly and by hand. The RIGHT side is the
    // real driver, whose own input collaborator hands it a 1-length list every tick.
    const world = { ...createArenaWorld(1), roundStartTick: -1000 };
    const input: InputState = { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: true, mine: false };
    const TICKS = 3;

    let expectedWorld = world;
    const expectedEvents: SimEvent[] = [];
    for (let i = 0; i < TICKS; i++) {
      const r = step(expectedWorld, input);
      expectedWorld = r.world;
      for (const ev of r.events) expectedEvents.push(ev);
    }

    const h = harness({ world, input });
    h.driver.start();
    h.raf.fire(60); // dtReal 60ms at DT ~16.667ms -> floor(0.06 * 60) = 3 ticks

    expect(h.driver.world).toEqual(expectedWorld);
    // Compare events with the FrameEvent stamp stripped: the driver adds `.tick`,
    // which step() driven by hand here never produces, and is not part of this claim.
    const stripTick = (events: SimEvent[]): unknown[] =>
      events.map((e) => {
        const { tick: _tick, ...rest } = e as SimEvent & { tick?: number };
        return rest;
      });
    expect(stripTick(h.directed.flat())).toEqual(stripTick(expectedEvents));
    expect(expectedEvents.length).toBeGreaterThan(0); // non-vacuous: the shot really fired
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
    const h = harness({ state: 'main-menu' });
    h.driver.start();
    h.raf.fire(25);
    expect(h.renders[0].alpha).toBe(1);
  });

  it('renders the frame that ENDS the game at a full alpha', () => {
    // The machine flips to `outcome` inside onEvents -- DURING this frame,
    // between the driver's two reads of the state machine. The frame that ends
    // the game must show the final pose whole, not a fraction of a tick short
    // of it. Hoisting both reads into one const renders it at the carried 0.5
    // instead; hoisting only the second read is harmless and must keep passing.
    const world = { ...createArenaWorld(1), roundStartTick: -1000 };
    const h = harness({
      world,
      input: { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: true, mine: false },
      endOnEvents: 'outcome',
    });
    h.driver.start();
    h.raf.fire(25); // 1.5 ticks: one runs and fires, half a tick is carried
    expect(h.machineSaw.length).toBeGreaterThan(0); // the flip really happened
    expect(h.state()).toBe('outcome');
    const r = h.renders[0];
    expect(r.alpha).toBe(1);
    // and it really did simulate this frame, so this is not the idle branch
    expect(r.curr.tick).toBe(1);
  });

  it("renders curr's pose on the frames after a game ends mid-run", () => {
    // The frame AFTER the end takes the idle branch: prev collapses onto curr
    // so nothing lerps, and alpha is full. Scoping this to a menu frame from
    // boot would make the prev === curr half unfalsifiable, since they are
    // already identical before any tick runs.
    const world = { ...createArenaWorld(1), roundStartTick: -1000 };
    const h = harness({
      world,
      input: { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: true, mine: false },
      endOnEvents: 'outcome',
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

  it.each(['launch', 'main-menu', 'outcome'] as const)(
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

describe('driver: the developer single-tick step (issue #253)', () => {
  /** A fresh arena world whose enemies are already dead, so the next simulated tick decides the round. */
  function worldWonOnNextTick(): World {
    const w = createArenaWorld(1);
    for (const t of w.tanks) if (t.kind !== 'player') t.alive = false;
    return w;
  }

  it.each(['playing', 'launch', 'main-menu', 'outcome'] as const)(
    'refuses while %s, without sampling, stepping or rendering',
    (state) => {
      // The gate is PAUSED, not "not simulating": a step from a live match would hand out a
      // tick the frame loop is also about to take, and one from a menu or an ended round would
      // move a world nobody is playing.
      const h = harness({ state });
      h.driver.start();
      expect(h.driver.advanceOneTick()).toBe(false);
      expect(h.samples).toBe(0);
      expect(h.renders).toHaveLength(0);
      expect(h.driver.world.tick).toBe(0);
    },
  );

  it('advances exactly one tick from one sample, and renders it whole with effects frozen', () => {
    const h = harness({ state: 'paused' });
    h.driver.start();
    h.raf.fire(100); // a paused frame: renders, steps nothing
    expect(h.driver.world.tick).toBe(0);
    const before = h.driver.world;
    expect(h.driver.advanceOneTick()).toBe(true);
    expect(h.driver.world.tick).toBe(1);
    expect(h.samples).toBe(1);
    expect(h.simulated).toEqual([h.driver.world]);
    const frame = h.renders[h.renders.length - 1];
    expect(h.renders).toHaveLength(2);
    expect(frame.prev).toBe(before);
    expect(frame.curr).toBe(h.driver.world);
    // Alpha 1: the stepped pose whole. Dt 0: paused, so debris and animated skins hold still.
    expect(frame.alpha).toBe(1);
    expect(frame.dt).toBe(0);
  });

  it('advances exactly N ticks for N steps, one sample each', () => {
    const h = harness({ state: 'paused' });
    h.driver.start();
    for (let i = 0; i < 5; i++) h.driver.advanceOneTick();
    expect(h.driver.world.tick).toBe(5);
    expect(h.samples).toBe(5);
    expect(h.renders).toHaveLength(5);
    expect(h.renders.map((r) => r.curr.tick)).toEqual([1, 2, 3, 4, 5]);
  });

  it('equals the same number of stepInputs calls on the same inputs, tick for tick', () => {
    // The determinism trace: stepping is the sim's own step, not an approximation of one.
    const inputs: InputState[] = [
      { move: { x: 1, y: 0 }, aim: { x: 3, y: 2 }, fire: false, mine: false },
      { move: { x: 0, y: -1 }, aim: { x: -2, y: 5 }, fire: true, mine: false },
      { move: { x: -1, y: 1 }, aim: { x: 7, y: -1 }, fire: false, mine: true },
    ];
    const TICKS = 200;
    const start = createWorldFor(arenaById('arena-01'), 321, {});
    let expected = start;
    for (let tick = 0; tick < TICKS; tick++) expected = step(expected, inputs[tick % inputs.length]).world;

    const stepped = harnessWithScript(start, inputs);
    for (let i = 0; i < TICKS; i++) stepped.driver.advanceOneTick();
    expect(stepped.driver.world).toEqual(expected);

    // The negative control: one step fewer lands somewhere else, so the equality above can see a
    // single tick. Without it a comparison of two worlds that never diverge would pass anything.
    const short = harnessWithScript(start, inputs);
    for (let i = 0; i < TICKS - 1; i++) short.driver.advanceOneTick();
    expect(short.driver.world).not.toEqual(expected);
  });

  it('RESUMING after steps neither repeats them nor catches up the paused time', () => {
    // The same shape as reset()'s carried-time test. The paused frame at 25 anchors `last`; three
    // steps later, Resume and a frame 14ms on (under DT) must run no tick, and a frame 17ms after
    // that must run exactly one. A step that left time owed, or re-ran itself, moves the tick.
    const h = harness({ state: 'paused' });
    h.driver.start();
    h.raf.fire(25);
    for (let i = 0; i < 3; i++) h.driver.advanceOneTick();
    expect(h.driver.world.tick).toBe(3);
    h.setState('playing');
    h.raf.fire(39);
    expect(h.driver.world.tick).toBe(3);
    h.raf.fire(56);
    expect(h.driver.world.tick).toBe(4);
  });

  it("routes a stepped tick's events as a simulating frame does, and its round ending through settleSteppedTick", () => {
    const h = harness({ state: 'paused', world: worldWonOnNextTick() });
    h.driver.start();
    h.driver.advanceOneTick();
    const win = [{ type: 'win', tick: 1 }];
    expect(h.directed).toEqual([win]);
    expect(h.hapticsSaw).toEqual([win]);
    expect(h.framed).toEqual([win]);
    expect(h.settled).toEqual([win]);
    // NOT onEvents: the real machine ignores a paused session there, and the sim never emits
    // this `win` again, so the round would never end.
    expect(h.machineSaw).toEqual([]);
  });

  it('a simulating frame never routes through settleSteppedTick', () => {
    // Negative control for the over-correction: sending every frame's events to the paused-only
    // entry would pass the case above and silently drop every ending in a live match.
    const h = harness({ state: 'playing', world: worldWonOnNextTick() });
    h.driver.start();
    h.raf.fire(25);
    expect(h.machineSaw).toEqual([[{ type: 'win', tick: 1 }]]);
    expect(h.settled).toEqual([]);
  });
});

/** A paused driver whose input plays `inputs` in turn, one per sample. */
function harnessWithScript(world: World, inputs: InputState[]): { driver: Driver } {
  let i = 0;
  const driver = createDriver({
    now: () => 0,
    raf: fakeRaf().scheduler,
    input: { sample: () => [inputs[i++ % inputs.length]] },
    renderer: { render: () => {}, worldReplaced: () => {} },
    director: { handle: () => {} },
    haptics: { handle: () => {} },
    stateMachine: { isSimulating: false, isPaused: true, onEvents: () => {}, settleSteppedTick: () => {} },
    world,
    onFrameEvents: () => {},
    onSimulated: () => {},
  });
  return { driver };
}

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

  it('a frame that throws stops the loop, so the throw surfaces once rather than every frame (#690)', () => {
    // The frame requests its successor BEFORE doing its work. A throw after that request
    // used to leave the next frame queued, and it threw identically forever. Sampling throws
    // only once here, so a loop that kept running would sample again and quietly succeed --
    // which is why "no second sample" is asserted, not just "no second throw".
    const boom = new Error('input sampling threw');
    const h = harness({ throwOnFirstSample: boom });
    h.driver.start();

    expect(() => h.raf.fire(20)).toThrow(boom);
    const queuedByTheThrowingFrame = h.raf.issued[h.raf.issued.length - 1];
    expect(h.raf.cancelled, 'the frame queued before the throw was not cancelled').toContain(queuedByTheThrowingFrame);

    // The browser may already have committed to that callback; it must now do nothing.
    const queued = h.raf.last();
    expect(() => queued(40)).not.toThrow();
    expect(h.samples, 'the loop kept running after the throw').toBe(1);
    expect(h.renders).toHaveLength(0);
    expect(h.raf.issued, 'the stopped loop requested another frame').toHaveLength(2);
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

  it('tells the renderer the world was replaced, before any frame can render it (#531)', () => {
    // The driver is the seam that owes this call: it holds the only two world
    // references (`prev`, `curr`) that reach `render`, and `reset` reassigns both. The
    // renderer's cross-frame state -- interpolation history, tread anchors -- belongs to
    // a board that no longer exists the instant those two lines run.
    //
    // Ordering, not just occurrence: presentation may not paint a replaced world before
    // it has been told, so the announcement is recorded as the render count standing
    // behind it. `announcements` in the harness above captures exactly that.
    const h = harness();
    h.driver.start();
    h.raf.fire(25);
    expect(h.renders).toHaveLength(1);

    const fresh = createArenaWorld(99);
    h.driver.reset(fresh);
    // Announced with that one frame behind it, and no frame between the swap and the
    // announcement. A `worldReplaced()` moved after the next render would read [2].
    expect(h.announcements).toEqual([1]);

    // 39 is 14ms on from the last frame, under DT, so this frame renders without
    // stepping -- the pose the renderer sees is the replaced world untouched.
    h.raf.fire(39);
    expect(h.renders).toHaveLength(2);
    expect(h.renders[1].curr).toBe(fresh);
    expect(h.renders[1].prev).toBe(fresh);
  });

  it('announces nothing while it is merely stepping the world it already has', () => {
    // Negative control for the obvious over-correction: announcing from the frame body
    // rather than from `reset` would make every frame a discontinuity, and the renderer
    // would drop its interpolation history 60 times a second while passing the test
    // above. Frames here both simulate (25ms crosses DT) and hold still (a second fire
    // under DT), so neither shape announces.
    const h = harness();
    h.driver.start();
    h.raf.fire(25);
    h.raf.fire(40);
    expect(h.renders).toHaveLength(2);
    expect(h.announcements).toEqual([]);
  });
});
