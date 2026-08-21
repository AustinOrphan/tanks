import { createWorld, step } from '../../src/sim/world';
import type { World } from '../../src/sim/world';
import type { SimEvent } from '../../src/sim/events';
import type { ArenaGeometry, InputState } from '../../src/sim/types';
import { RESPAWN_DELAY_TICKS } from '../../src/sim/constants';

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

/**
 * A small open 9x9 floor, no walls -- built directly rather than via loadArena(ARENA_01,
 * ...), so a versus kill can be staged at a controlled point-blank range while STILL
 * carrying a real `arenaGeometry`. That is the field stepRespawns' `respawnPos` (world.ts)
 * checks before it will route a revival through `pickVersusSpawnCell` (versus-spawns.ts)
 * instead of falling back to the authored spawn -- see versus-respawn.test.ts:8-33's own
 * doc comment for how that wiring resolves. `legend: {}` is enough: every cell is '.',
 * and `isWalkable`/`isOpenFloor` (versus-spawns.ts) both treat an unlisted character as
 * open floor.
 */
const KILL_ARENA_COLS = 9;
const KILL_ARENA_ROWS = 9;
const KILL_ARENA_CELL = 1;
const killArenaGeometry: ArenaGeometry = {
  cols: KILL_ARENA_COLS,
  rows: KILL_ARENA_ROWS,
  cellSize: KILL_ARENA_CELL,
  grid: Array.from({ length: KILL_ARENA_ROWS }, () => '.'.repeat(KILL_ARENA_COLS)),
  legend: {},
};

const KILL_SHOOTER_POS = { x: 3.5, y: 4.5 };
const KILL_VICTIM_POS = { x: 5.5, y: 4.5 };

/**
 * `driveTank` (world.ts) reads `InputState.aim` as a WORLD-SPACE TARGET POINT --
 * `aimDir = vsub(input.aim, player.pos)` -- not a direction vector. The `fire` moment's
 * shared `IDLE` only behaves like a unit vector because that tank sits at the world
 * origin; `buildKillWorld`'s shooter does not, so aiming it with `IDLE` slews the turret
 * toward `(1, 0) - (3.5, 4.5)` (south-west) a little further every tick instead of
 * holding east -- MEASURED: with `IDLE` reused unmodified, the shot missed the victim
 * entirely and neither `tank-destroyed` nor `explosion` fired anywhere in a 300-tick
 * run. Aiming at a point far east of the shooter's own position keeps `aimDir` due east
 * from tick 0, matching the shooter's already-0 `turretAngle` with no slew needed.
 */
const KILL_IDLE: InputState = {
  move: { x: 0, y: 0 },
  aim: { x: KILL_SHOOTER_POS.x + 100, y: KILL_SHOOTER_POS.y },
  fire: false,
  mine: false,
};

/**
 * Two-tank ffa world for a staged versus kill: shooter at (3.5, 4.5), victim 2 units
 * east at (5.5, 4.5), both facing east (matching `KILL_IDLE`'s aim target). Shared by
 * `destroyed` and `respawn` -- same shooter, same victim, same shot; the two moments
 * differ only in how long they keep simulating past the kill. `createWorld({ walls,
 * tanks, spawns, lives: 3, mode: 'ffa', arenaGeometry })` is the same shape
 * versus-respawn.test.ts:60 builds via `loadArena`; this fixture builds the fields
 * directly instead of loading ARENA_01 so the shot distance is exact and independent of
 * that arena's authored layout.
 */
function buildKillWorld(): World {
  const shooterPos = KILL_SHOOTER_POS;
  const victimPos = KILL_VICTIM_POS;
  const w = createWorld({
    walls: [],
    spawns: [
      { kind: 'player', pos: { ...shooterPos }, angle: 0 },
      { kind: 'player', pos: { ...victimPos }, angle: 0 },
    ],
    tanks: [
      {
        id: 1, kind: 'player',
        pos: { ...shooterPos }, bodyAngle: 0, turretAngle: 0, alive: true,
        desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
        aiState: 'idle', aiTimer: 0, controlledBy: 0, stockRemaining: 3,
      },
      {
        id: 2, kind: 'player',
        pos: { ...victimPos }, bodyAngle: 0, turretAngle: 0, alive: true,
        desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
        aiState: 'idle', aiTimer: 0, controlledBy: 1, stockRemaining: 3,
      },
    ],
    lives: 3,
    mode: 'ffa',
    arenaGeometry: killArenaGeometry,
    seed: 7,
  });
  // Long past the countdown (180 ticks) -- same landmine the fire moment already
  // documents: a fresh world's roundStartTick locks fire through the round-start
  // countdown/grace phase, so tick 0 must already be live.
  w.roundStartTick = -600;
  return w;
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

  /** Versus kill only -- the death pulse moment. Two tanks, a bullet already lethal. */
  destroyed: {
    ticks: 20,
    // MEASURED (buildKillWorld, fire at input(9) -> events[10]): the shell (speed
    // 6 = 0.1 unit/tick) leaves the muzzle at (4.35, 4.5), 1.15 units from the victim's
    // centre, and closes to the TANK_RADIUS + BULLET_RADIUS = 0.6 hit threshold 5 ticks
    // later, landing the kill at tick 15. `destroyed` intentionally stops well short of
    // RESPAWN_DELAY_TICKS later (tick 135), so the revival never enters this shorter clip.
    expect: [
      { type: 'tank-destroyed', tick: 15 },
      // MEASURED alongside tank-destroyed, same tick, no ricochet: point-blank range
      // means the shell's lethal hit and its explosion fire on the SAME tick,
      // unconditionally, in resolveBulletHits (bullets.ts) -- every fatal shell impact
      // emits `tank-destroyed` then `explosion` before the loop breaks.
      { type: 'explosion', tick: 15 },
    ],
    focus: [4.5, 0.3, 4.5], span: 4,
    build: buildKillWorld,
    input: (t) => (t === 9 ? { ...KILL_IDLE, fire: true } : KILL_IDLE),
  },

  /** Kill then stock respawn: #201's before/after and three-up media source. */
  respawn: {
    // MEASURED kill tick (15, see `destroyed` above) + RESPAWN_DELAY_TICKS (the shipped
    // revival delay) + 45 ticks so the entrance animation has room to play out after the
    // revival tick.
    ticks: 15 + RESPAWN_DELAY_TICKS + 45,
    expect: [
      { type: 'tank-destroyed', tick: 15 },
      // MEASURED: tick 135. Pinned as a literal, deliberately NOT `15 +
      // RESPAWN_DELAY_TICKS` -- moments.test.ts's own delay assertion computes
      // `revived - killed` and compares it to the SAME imported RESPAWN_DELAY_TICKS
      // constant, so a derived expression here would make that comparison
      // `(15 + C) - 15 === C`, true for every value of C and incapable of failing. A
      // literal is what lets a future balance change to RESPAWN_DELAY_TICKS actually
      // red both that assertion and the generic per-tick pin below, independently.
      { type: 'respawn', tick: 135 },
    ],
    // Landmine (versus-respawn.test.ts:8-33): stepRespawns routes the revival through
    // pickVersusSpawnCell, scored against every LIVING tank -- here, only the shooter,
    // frozen at (3.5, 4.5) for the whole clip (it never gets driven again after the
    // fire tick). On killArenaGeometry's open 9x9 floor that maximin search has no wall
    // to bound it, so it lands the revived tank in the FAR corner from the shooter --
    // MEASURED at (8.5, 0.5), a straight-line 5.0 units from the death position (5.5,
    // 4.5) and nothing like it. Focus therefore sits at the grid's own centre (4.5, *,
    // 4.5) rather than the kill position, and span is set to 13 -- comfortably above
    // 2 * the 5.66-unit centre-to-corner reach of ANY of the grid's 4 corner cells (not
    // just the one this exact fixture happens to pick), so the entrance never animates
    // off-camera.
    focus: [4.5, 0.3, 4.5], span: 13,
    build: buildKillWorld,
    input: (t) => (t === 9 ? { ...KILL_IDLE, fire: true } : KILL_IDLE),
  },
};
