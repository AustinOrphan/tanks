import { stepInputs, type World } from '../sim/world';
import type { InputState } from '../sim/types';
import type { SimEvent } from '../sim/events';
import { animationDt, planFrame, renderAlpha } from './frame';

/**
 * The frame loop, with its clock and its scheduler handed in.
 *
 * `startGame` used to own this inline, closed over `performance.now` and
 * `requestAnimationFrame`, which is why nothing could observe it: every
 * mutation of the loop body passed the full CI gate, including the one that
 * stops the game simulating altogether.
 *
 * Injecting the clock is what makes composition provable. `frame.test.ts` can
 * assert the accumulator arithmetic, but only a test that pumps a fake rAF
 * through this driver can prove the loop CALLS that arithmetic and feeds the
 * result to `step`. That distinction is the same one `step-pipeline.test.ts`
 * draws for the sim stages.
 */

export interface RafScheduler {
  request(cb: (now: number) => void): number;
  cancel(handle: number): void;
}

/**
 * The slice of GameStateMachine the driver uses.
 *
 * `isSimulating` and `isPaused` are read LIVE, and the reads are deliberately
 * not hoisted into a single const -- see the frame body. `onEvents` can flip
 * `playing` -> `outcome` in between, and the frame that ends the game must
 * render the final pose whole rather than a fraction of a tick past it.
 *
 * Two booleans rather than the whole AppLocation: the driver has no
 * legitimate business with routes or descriptors, and taking a bare enum
 * kept its `state === 'title'` foot-gun that CLAUDE.md's "keep both reads"
 * rule already exists to warn about. See `src/game/state.ts` for the
 * canonical model.
 */
export interface DriverStateMachine {
  /** True while the sim should step this frame. */
  readonly isSimulating: boolean;
  /**
   * True while cosmetics should freeze (pause is a phase of a live session).
   * All other non-simulating locations (launch, main-menu, outcome...) leave
   * the animation clock running -- see `animationDt`.
   */
  readonly isPaused: boolean;
  onEvents(events: SimEvent[]): void;
}

export interface DriverDeps {
  /** Monotonic milliseconds. `performance.now` in the browser. */
  now(): number;
  raf: RafScheduler;
  /**
   * List-shaped ALWAYS, even at playerCount 1 -- no `if (n === 1) step() else
   * stepInputs()` branch below. `step-inputs.test.ts`'s "step() is an adapter over
   * stepInputs" describe block proves `stepInputs(world, [input])` is value-identical
   * to `step(world, input)`, byte for byte; `driver.test.ts`'s own N=1 structural
   * regression proves this DRIVER wires that adapter correctly, one layer up (the
   * composition-blindness gap CLAUDE.md names for `step-pipeline.test.ts`).
   */
  input: { sample(): InputState[] };
  renderer: {
    render(prev: World, curr: World, alpha: number, events: SimEvent[], dt: number): void;
    /**
     * Told on every `reset`, before the world it replaced can be rendered again. See
     * `reset` below for why the driver is the site that owes this call.
     */
    worldReplaced(): void;
  };
  director: { handle(events: SimEvent[]): void };
  /** haptics.ts's consumer, wired on the SAME terms as director -- see the call site below. */
  haptics: { handle(events: SimEvent[]): void };
  stateMachine: DriverStateMachine;
  /** The world to start on. `reset` replaces it. */
  world: World;
  /** Once per SIMULATING frame, after events are routed. loop.ts refreshes HUD stats here. */
  onSimulated(world: World): void;
  /**
   * This frame's events, for consumers that are not the audio director or the
   * state machine. loop.ts drives the HUD's damage feedback from here.
   *
   * Called only when the frame produced events, on the same terms as the other
   * two -- so the three consumers cannot drift apart in when they see a frame.
   */
  onFrameEvents(events: SimEvent[]): void;
}

/**
 * A `SimEvent`, stamped with the sim tick that produced it -- lost by the time it
 * reaches consumers otherwise: `stepInputs` (world.ts) increments `draft.tick` before
 * running the stage block that populates `events`, so `result.world.tick` already
 * IS the tick that produced `result.events`, for every call. What actually loses that
 * identity is the per-frame flatten below: a catch-up frame can run `plan.ticks > 1`,
 * and pushing bare `SimEvent`s into one array discards which of those ticks each one
 * came from.
 *
 * Deliberately a structural superset of `SimEvent`, not a `{tick, events}[]` envelope:
 * every consumer today (`renderer.render`, `particles.spawn`, `director.handle`,
 * `haptics.handle`, `state.onEvents`, `loop.ts`'s `onFrameEvents`) takes a plain
 * `SimEvent[]`, and a `FrameEvent[]` is assignable there without touching any of them.
 * Nothing reads `.tick` yet -- it exists for a future rollback layer's dedup, which does
 * not exist today (no transport, no rollback buffer, no peer protocol).
 */
export type FrameEvent = SimEvent & { tick: number };

export interface Driver {
  /** Live, not a snapshot -- see the getter note in createDriver. */
  readonly world: World;
  /** The pose the last render interpolated FROM. */
  readonly prevWorld: World;
  start(): void;
  stop(): void;
  /**
   * Land on a new world: prev = curr = world, accumulator dropped, and the renderer
   * told that its cross-frame state belongs to a board that no longer exists.
   */
  reset(world: World): void;
}

export function createDriver(deps: DriverDeps): Driver {
  let curr: World = deps.world;
  let prev: World = curr;
  let acc = 0;
  let last = deps.now();
  let handle = 0;
  let running = false;

  const frame = (now: number): void => {
    // An already-queued callback can still fire after stop(); without this the
    // world keeps advancing after dispose.
    if (!running) return;
    handle = deps.raf.request(frame);

    const plan = planFrame(acc, (now - last) / 1000);
    last = now;
    acc = plan.acc;

    const frameEvents: FrameEvent[] = [];

    // Read LIVE, and deliberately not hoisted into a const shared with the
    // alpha read below: onEvents can flip `playing` -> `outcome` in between,
    // and the frame that ends the game must render the final pose whole rather
    // than interpolating a fraction of a tick past it.
    if (deps.stateMachine.isSimulating) {
      for (let i = 0; i < plan.ticks; i++) {
        prev = curr;
        const result = stepInputs(curr, deps.input.sample());
        curr = result.world;
        // Stamped per-step, with THIS step's tick -- not the frame's final tick after
        // the loop ends. A catch-up frame's earlier events must report the tick that
        // actually produced them.
        for (const ev of result.events) frameEvents.push({ ...ev, tick: result.world.tick });
      }
      if (frameEvents.length > 0) {
        deps.director.handle(frameEvents);
        deps.haptics.handle(frameEvents);
        deps.stateMachine.onEvents(frameEvents);
        deps.onFrameEvents(frameEvents);
      }
      deps.onSimulated(curr);
    } else {
      // Not simulating: hold a static pose, and drop any debt so that resuming
      // does not immediately repay time that passed on a menu.
      acc = 0;
      prev = curr;
    }

    // Second, deliberate reads. See above. Both must see the state as it is
    // AFTER onEvents, not before -- the flip from `playing` to `outcome` in
    // this same frame is precisely why they are not hoisted with the first
    // simulating check above.
    const simulatingAfter = deps.stateMachine.isSimulating;
    const pausedAfter = deps.stateMachine.isPaused;
    const alpha = renderAlpha(acc, simulatingAfter);
    // Not plan.dt: the render animation clock is its own decision, and it stops while
    // the game is paused. See animationDt.
    deps.renderer.render(prev, curr, alpha, frameEvents, animationDt(plan.dt, pausedAfter));
  };

  return {
    // Getters, not properties. `curr` and `prev` are reassigned on every tick,
    // and a plain `world: curr` would capture the reference at construction --
    // so every assertion after a reset would read the pre-reset world and pass
    // for the wrong reason. `readonly world: World` is satisfied by either
    // form, so tsc gives no warning here.
    get world(): World {
      return curr;
    },
    get prevWorld(): World {
      return prev;
    },
    start(): void {
      if (running) return;
      running = true;
      last = deps.now();
      handle = deps.raf.request(frame);
    },
    stop(): void {
      running = false;
      deps.raf.cancel(handle);
    },
    reset(world: World): void {
      curr = world;
      prev = world;
      acc = 0;
      // The renderer is told HERE, and not by `loop.ts`'s `switchTo` beside its own call
      // to this method, because this is the seam a replaced world cannot get past: the
      // driver owns the only two references (`prev`, `curr`) that reach `render`, and
      // both are reassigned immediately above. A future second caller of `reset`
      // inherits the announcement instead of having to remember to make it.
      //
      // Why an announcement at all (issue #531): presentation used to infer a level
      // switch by comparing `roundStartTick` across the two worlds, which cannot work --
      // `createWorld` starts every world at 1, so a level cleared on its first round is
      // indistinguishable from an ordinary frame and the tread trails streaked from the
      // old board's coordinates to the new spawn. See renderer.ts's `worldReplaced`.
      deps.renderer.worldReplaced();
    },
  };
}
