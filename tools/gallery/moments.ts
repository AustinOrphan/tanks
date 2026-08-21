import { createWorld, step } from '../../src/sim/world';
import type { World } from '../../src/sim/world';
import type { SimEvent } from '../../src/sim/events';
import type { InputState } from '../../src/sim/types';

const IDLE: InputState = { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: false, mine: false };

/**
 * A short, deterministic, scripted sim timeline the gallery can render as a gif/clip.
 *
 * Unlike subjects.ts's ELEMENTS (a static or looping pose, driven by `age`), a moment
 * is a NARRATIVE: `input(tick)` scripts one player's actions across a fixed span, and
 * `expect` pins which SimEvents that script must produce and exactly when -- so a moment
 * is also a tripwire that render evidence is being regenerated against the sim that
 * ships (see moments.test.ts).
 */
export interface MomentDef {
  /** Ticks to simulate. Becomes GALLERY_FRAMES. Keep clips short: 30-120. */
  ticks: number;
  /** Events that MUST fire on exact ticks; moments.test.ts pins every entry. */
  expect: { type: SimEvent['type']; tick: number }[];
  /** The tick-0 world. Deterministic; sets roundStartTick past the countdown. */
  build(): World;
  /** Player input for a given tick (0-based). Pure function of tick. */
  input(tick: number): InputState;
  /** Camera focus point and span, same meaning as subjects.ts's Composed. */
  focus: [number, number, number];
  span: number;
}

export interface MomentTimeline { worlds: World[]; events: SimEvent[][]; }

/**
 * Replays a MomentDef tick by tick with the pure sim `step`.
 *
 * `worlds[t]` and `events[t]` line up so `events[t]` is what firing `input(t - 1)`
 * produced: `worlds[0]`/`events[0]` are the tick-0 world and no events (nothing has
 * stepped yet), and each following `step(w, def.input(t))` call appends its result at
 * index `t + 1`. An input pressed at tick 9 therefore lands its event at `events[10]`.
 */
export function simulateMoment(def: MomentDef): MomentTimeline {
  let w = def.build();
  const worlds: World[] = [w];
  const events: SimEvent[][] = [[]];
  for (let t = 0; t < def.ticks; t++) {
    const r = step(w, def.input(t)); // step() does not mutate its input world
    w = r.world;
    worlds.push(w);
    events.push(r.events);
  }
  return { worlds, events };
}

export const MOMENTS: Record<string, MomentDef> = {
  /** One tank, one trigger pull: the muzzle flash / fire event, dead centre. */
  fire: {
    ticks: 40,
    expect: [{ type: 'fire', tick: 10 }],
    focus: [0, 0.3, 0], span: 3,
    build: () => {
      const w = createWorld({
        walls: [], spawns: [{ pos: { x: 0, y: 0 }, angle: 0 }], lives: 3,
        tanks: [{
          id: 1, kind: 'player',
          pos: { x: 0, y: 0 }, bodyAngle: 0, turretAngle: 0, alive: true,
          desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
          aiState: 'idle', aiTimer: 0,
        }],
        seed: 7,
      });
      // Long past the countdown (180 ticks): a fresh world's roundStartTick locks fire
      // through the round-start countdown/grace phase, so tick 0 must already be live.
      w.roundStartTick = -600;
      return w;
    },
    input: (t) => (t === 9 ? { ...IDLE, fire: true } : IDLE),
  },
};
