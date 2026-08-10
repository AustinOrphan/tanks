import { step, type World } from '../sim/world';
import type { InputState } from '../sim/types';
import type { SimEvent } from '../sim/events';
import type { GameState } from './state';
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
 * `state` is read LIVE, twice per frame, and the two reads are deliberately
 * not hoisted -- see the frame body.
 */
export interface DriverStateMachine {
  readonly state: GameState;
  onEvents(events: SimEvent[]): void;
}

export interface DriverDeps {
  /** Monotonic milliseconds. `performance.now` in the browser. */
  now(): number;
  raf: RafScheduler;
  input: { sample(): InputState };
  renderer: {
    render(prev: World, curr: World, alpha: number, events: SimEvent[], dt: number): void;
  };
  director: { handle(events: SimEvent[]): void };
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

export interface Driver {
  /** Live, not a snapshot -- see the getter note in createDriver. */
  readonly world: World;
  /** The pose the last render interpolated FROM. */
  readonly prevWorld: World;
  start(): void;
  stop(): void;
  /** Fresh round: prev = curr = world, accumulator dropped. */
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

    const frameEvents: SimEvent[] = [];

    // Read LIVE, and deliberately not hoisted into a const shared with the
    // alpha read below: onEvents can flip 'playing' -> 'win'/'lose' in between,
    // and the frame that ends the game must render the final pose whole rather
    // than interpolating a fraction of a tick past it.
    if (deps.stateMachine.state === 'playing') {
      for (let i = 0; i < plan.ticks; i++) {
        prev = curr;
        const result = step(curr, deps.input.sample());
        curr = result.world;
        for (const ev of result.events) frameEvents.push(ev);
      }
      if (frameEvents.length > 0) {
        deps.director.handle(frameEvents);
        deps.stateMachine.onEvents(frameEvents);
        deps.onFrameEvents(frameEvents);
      }
      deps.onSimulated(curr);
    } else {
      // Not simulating: hold a static pose, and drop any debt so that resuming
      // does not immediately repay time that passed on the title screen.
      acc = 0;
      prev = curr;
    }

    // Second, deliberate read. See above. Hoisted into a const only HERE, below the
    // branch -- the two uses on this line must agree with each other, and both must
    // see the state as it is AFTER onEvents, not before.
    const state = deps.stateMachine.state;
    const alpha = renderAlpha(acc, state === 'playing');
    // Not plan.dt: the render animation clock is its own decision, and it stops while
    // the game is paused. See animationDt.
    deps.renderer.render(prev, curr, alpha, frameEvents, animationDt(plan.dt, state));
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
    },
  };
}
