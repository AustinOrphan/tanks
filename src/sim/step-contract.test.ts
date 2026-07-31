import { describe, it, expect } from 'vitest';
import { createWorld, step } from './world';
import type { World } from './world';
import type { Tank, Spawn, InputState } from './types';
import type { SimEvent } from './events';
import { COUNTDOWN_TICKS, GRACE_TICKS, MUZZLE_OFFSET } from './constants';

/**
 * Pins step()'s CONTRACT WITH ITS CALLER -- the parts of step() that are not about which
 * stages run (step-pipeline.test.ts owns that) but about what step() hands back and when.
 *
 * Each test here corresponds to a mutation that survived the whole 484-test suite when
 * this file was written, verified one at a time against c9a783d:
 *   - `if (draft.status === 'playing')` -> `!== 'win'`      (a lost world keeps simulating)
 *   - `applyPlayerInput(draft, input, events)` -> `[]`      (fire / mine-dropped dropped)
 *   - `stepBullets(draft, DT, events)` -> `[]`              (ricochet dropped)
 *   - `if (canAct && input.mine && ...)` -> `if (false && ...)`  (mine key does nothing)
 *   - `draft.tick += 1` moved below the pipeline           (round phases off by one)
 *
 * The event assertions matter because that stream is how the rest of the game hears about
 * anything: render and audio are the main consumers, and game/state.ts's onEvents reads
 * win/lose to drive the game-over screen. A dropped `fire` is a silent gun, a dropped
 * `ricochet` is a silent bounce. Both were invisible to every other test in the suite.
 *
 * SWEEP RECORD -- whole classes, with their populations, not a sample:
 *   - events discarded, one stage at a time:  6 of 6 now caught (population: all 6 stages
 *     that take an `events` array). Four were already caught elsewhere; this file closes
 *     the two that were not, applyPlayerInput and stepBullets.
 *   - step()'s status guard:                  4 of 4 variants now caught (population:
 *     `!== 'win'`, `!== 'lose'`, no guard, inverted). Only the 'lose' case was uncovered.
 * Zero survivors in either class. The denominators are stated because on the previous
 * pipeline PR a count without its population read as a sweep and hid a real defect twice.
 */

const PLAYER_ID = 1;
const BROWN_ID = 2;
const GREY_ID = 3;

function makeTank(kind: Tank['kind'], id: number, x: number, y: number): Tank {
  return {
    id, kind, pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  };
}

const SPAWNS: Spawn[] = [
  { kind: 'player', pos: { x: 5, y: 5 }, angle: 0 },
  { kind: 'brown', pos: { x: 20, y: 20 }, angle: 0 },
  { kind: 'grey', pos: { x: 30, y: 30 }, angle: 0 },
];

/** Past countdown+grace, so player input is live. */
function liveWorld(walls: World['walls'] = []): World {
  const w = createWorld({
    walls,
    tanks: [makeTank('player', PLAYER_ID, 5, 5), makeTank('brown', BROWN_ID, 20, 20), makeTank('grey', GREY_ID, 30, 30)],
    spawns: SPAWNS,
    lives: 3,
  });
  w.roundStartTick = -(COUNTDOWN_TICKS + GRACE_TICKS) - 1;
  return w;
}

/** Fresh world at the real createWorld default, so round phases run from the start. */
function freshWorld(): World {
  return createWorld({
    walls: [],
    tanks: [makeTank('player', PLAYER_ID, 5, 5), makeTank('brown', BROWN_ID, 20, 20), makeTank('grey', GREY_ID, 30, 30)],
    spawns: SPAWNS,
    lives: 3,
  });
}

const idle: InputState = { move: { x: 0, y: 0 }, aim: { x: 10, y: 5 }, fire: false, mine: false };
const firing: InputState = { ...idle, fire: true };
const mining: InputState = { ...idle, mine: true };
const tankById = (w: World, id: number) => w.tanks.find((t) => t.id === id)!;

describe('step() latches a finished game', () => {
  it('a LOST game stops simulating, not just a won one', () => {
    // step-integration.test.ts pins this for 'win'. Nothing pinned it for 'lose', so the
    // guard could be narrowed to `status !== 'win'` and a lost world would keep running
    // its AI behind the game-over screen -- tanks driving around under the overlay.
    const w = liveWorld();
    w.lives = 1;
    tankById(w, PLAYER_ID).alive = false;

    const lost = step(w, idle).world;
    expect(lost.status).toBe('lose');

    const r = step(lost, firing);

    // Asserted as "the whole world is untouched except the tick", not as a list of
    // individual things that did not happen. Review showed the narrower form was mostly
    // decoration: only the grey-position check was load-bearing, and even that would be
    // satisfied by an unrelated AI change ("enemies hold position when no lives remain")
    // while the latch stayed broken. Deep equality cannot drift that way, and it also
    // covers bullets, mines, walls and lives without a line each.
    expect({ ...r.world, tick: lost.tick }).toEqual(lost);
    expect(r.events).toEqual([]);
  });
});

describe('step() hands its events back to the caller', () => {
  // Render and audio are the main consumers; game/state.ts's onEvents also reads win/lose
  // to drive the game-over screen. Each event below is produced by a stage whose `events`
  // argument could be replaced with a throwaway array with the whole suite still green.

  it("the player's own fire event reaches the caller, with its position", () => {
    // Discriminated by ownerId because GREY (id 3) also fires on this tick in this
    // fixture, so a bare `some(e => e.type === 'fire')` passes even when the player's
    // event is dropped -- which is exactly what step-integration.test.ts does.
    // `pos` and `angle` are asserted too: particles.ts spawns every burst at exactly
    // ev.pos, so a wrong position is a visible defect that no presence-only assertion
    // catches. The position is the MUZZLE now, not the owner's centre: shells used to be
    // born inside the tank that fired them and fly out through it.
    const w = liveWorld();
    // Turret pre-aimed at +y and the aim point placed on that same bearing, so slewAngle
    // leaves it exactly at PI/2 this tick. A NON-ZERO angle on purpose: with the fixture's
    // default of 0, `angle: 0` is satisfied by a mutation that hardcodes the field to 0 --
    // which is exactly what happened on the first attempt at this assertion.
    tankById(w, PLAYER_ID).turretAngle = Math.PI / 2;
    const aimedUp: InputState = { ...firing, aim: { x: 5, y: 10 } };

    const r = step(w, aimedUp);

    expect(r.events).toContainEqual(
      expect.objectContaining({
        type: 'fire',
        ownerId: PLAYER_ID,
        bulletType: 'normal',
        // Firing along +y from (5,5), so the muzzle is MUZZLE_OFFSET up-axis.
        pos: { x: 5, y: 5 + MUZZLE_OFFSET },
        angle: Math.PI / 2,
      }),
    );
  });

  it('pressing the mine key drops a mine, and the mine-dropped event reaches the caller', () => {
    // Two mutants in one: disabling the player's mine branch outright, and dropping
    // applyPlayerInput's events.
    const r = step(liveWorld(), mining);

    const mine = r.world.mines.find((m) => m.ownerId === PLAYER_ID);
    expect(mine).toBeDefined();
    expect(r.events).toContainEqual({
      type: 'mine-dropped',
      mineId: mine!.id,
      pos: { x: 5, y: 5 },
    });
  });

  it('a shell bouncing off a wall reaches the caller as a ricochet event', () => {
    // stepBullets is the only source of `ricochet`, and it is the audio layer's bounce
    // cue. The shell is aimed at a wall close enough to be hit within this tick.
    const wall: World['walls'][number] = {
      id: 90,
      aabb: { minX: 6, minY: 3, maxX: 8, maxY: 7 },
      kind: 'solid',
      destroyed: false,
    };
    const w = liveWorld([wall]);
    w.tanks[0].turretAngle = 0; // aiming +x, straight at the wall face 1 unit away

    let world = w;
    const events: SimEvent[] = [];
    // The shell covers bulletConfig.normal.speed * DT per tick, so crossing the 1-unit gap
    // takes ~10 ticks; 20 leaves room for the muzzle offset without being open-ended.
    for (let i = 0; i < 20; i++) {
      const r = step(world, i === 0 ? firing : idle);
      world = r.world;
      events.push(...r.events);
    }
    // Position asserted, not just presence: the bounce point is where the spark burst is
    // drawn. The shell travels along y=5 into the wall's minX face at x=6.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'ricochet', pos: { x: 6, y: 5 } }),
    );
  });
});

describe('step() advances the tick before evaluating the round phase', () => {
  it('firing becomes legal on exactly the first live tick, not one later', () => {
    // `draft.tick += 1` sits above the pipeline so the first simulated tick is tick 1 and
    // roundStartTick can be 1. Move the increment below and every phase boundary shifts by
    // one tick -- the documented off-by-one this ordering exists to prevent.
    const firstLiveStep = COUNTDOWN_TICKS + GRACE_TICKS + 1;
    let world = freshWorld();
    let firedOnStep = -1;

    for (let i = 1; i <= firstLiveStep; i++) {
      const r = step(world, firing);
      world = r.world;
      if (firedOnStep === -1 && r.events.some((e) => e.type === 'fire' && e.ownerId === PLAYER_ID)) {
        firedOnStep = i;
      }
    }

    expect(firedOnStep).toBe(firstLiveStep);
  });
});
