import { createWorld, step, stepInputs } from '../../src/sim/world';
import type { World } from '../../src/sim/world';
import type { SimEvent } from '../../src/sim/events';
import type { ArenaGeometry, InputState, Wall } from '../../src/sim/types';
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
  /**
   * Ticks to simulate. Becomes GALLERY_FRAMES. Keep clips short: shipped moments run
   * 10-230 (4 of 9 -- fire, ricochet, drive, traverse -- sit in 20-45; pivot is the
   * short outlier at 10). The other four are justified, not drift: destroyed's 60 and
   * wall-break's 66 each add ~40 ticks past their kill/detonation tick (15, 26) so the
   * explosion/wall-destroyed particle burst (particles.ts's `burst()`, whose randomized
   * `life` can run past the shorter windows this task's final-review fix wave found
   * truncating them) has room to decay rather than cutting the clip mid-fade; respawn's
   * 180 is the measured kill tick plus RESPAWN_DELAY_TICKS plus a window for the
   * revival + entrance animation to play out; mine-cycle's 230 gives the full MINE_TIMER
   * fuse (drop to detonation) plus the same ~40-tick decay margin past its tick-190
   * detonation.
   */
  ticks: number;
  /** Events that MUST fire on exact ticks; moments.test.ts pins every entry. */
  expect: { type: SimEvent['type']; tick: number }[];
  /** The tick-0 world. Deterministic; sets roundStartTick past the countdown. */
  build(): World;
  /** Player input for a given tick (0-based). Pure function of tick. */
  input(tick: number): InputState;
  /**
   * OPTIONAL second player's input, for a moment that stages TWO moving tanks (issue
   * #231's overlapping-paths and multi-skin captures both need a second tank actually
   * driven, unlike `destroyed`/`respawn`'s stationary victim). Absent for every
   * single-player moment -- `simulateMoment` falls back to the one-input `step()`
   * adapter exactly as before, so this is additive and every existing moment is
   * untouched. When present, `simulateMoment` goes through `stepInputs(w, [input(t),
   * input2(t)])` instead -- the SAME multiplayer entry point `stepInputs` (world.ts)
   * is everywhere else in the tree, not a second bespoke driver. `applyPlayerInputs`
   * (world.ts) maps `inputs[i]` to the i-th `kind === 'player'` tank in `world.tanks`
   * ARRAY ORDER, not `Tank.controlledBy` (that field is a RENDER seam only -- see
   * `entities.ts`'s `styleFor`) -- so a moment using `input2` must build its second
   * tank second in `world.tanks` for this to drive the tank it means to.
   */
  input2?(tick: number): InputState;
  /** Camera focus point and span, same meaning as subjects.ts's Composed. */
  focus: [number, number, number];
  span: number;
}

export interface MomentTimeline { worlds: World[]; events: SimEvent[][]; }

/**
 * Replays a MomentDef tick by tick with the pure sim `step` (or, for a two-tank
 * moment, `stepInputs` -- see `MomentDef.input2`'s own doc comment).
 *
 * `worlds[t]` and `events[t]` line up so `events[t]` is what firing `input(t - 1)`
 * produced: `worlds[0]`/`events[0]` are the tick-0 world and no events (nothing has
 * stepped yet), and each following step call appends its result at index `t + 1`. An
 * input pressed at tick 9 therefore lands its event at `events[10]`.
 */
export function simulateMoment(def: MomentDef): MomentTimeline {
  let w = def.build();
  const worlds: World[] = [w];
  const events: SimEvent[][] = [[]];
  for (let t = 0; t < def.ticks; t++) {
    // step() does not mutate its input world; neither does stepInputs().
    const r = def.input2 ? stepInputs(w, [def.input(t), def.input2(t)]) : step(w, def.input(t));
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

/**
 * One player tank alone on an open, wall-less floor -- the shared skeleton for every
 * Task 6 moment below that does not need a second tank (unlike `buildKillWorld`'s
 * versus pair). `walls` defaults empty because most of these moments need none;
 * `ricochet`/`wall-break` are the only two that pass one.
 */
function buildSoloWorld(walls: Wall[] = []): World {
  const w = createWorld({
    walls,
    spawns: [{ pos: { x: 0, y: 0 }, angle: 0 }],
    lives: 3,
    tanks: [{
      id: 1, kind: 'player',
      pos: { x: 0, y: 0 }, bodyAngle: 0, turretAngle: 0, alive: true,
      desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
      aiState: 'idle', aiTimer: 0,
    }],
    seed: 7,
  });
  // Same landmine `fire` and `buildKillWorld` both document: a fresh world's
  // roundStartTick locks fire/mine actions through the round-start countdown/grace
  // phase, so tick 0 must already be live.
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
    // 60, not the tick-15 kill plus a token margin: `destroyed`'s whole point is the
    // death pulse / explosion burst, so the clip needs to run long enough for both to
    // finish, not just long enough to show the kill tick (final-review finding I2 --
    // the original 20-tick window cut the explosion burst off mid-fade). See
    // MomentDef.ticks's doc comment for the particle-decay math.
    ticks: 60,
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
    // revival tick. Deriving the WINDOW size from RESPAWN_DELAY_TICKS is fine here --
    // it only decides how long simulateMoment runs, not what a pin claims happened --
    // the tautology risk the comment below guards against is specific to `expect[]`
    // tick literals, which moments.test.ts's own delay assertion re-derives against.
    ticks: 15 + RESPAWN_DELAY_TICKS + 45,
    expect: [
      { type: 'tank-destroyed', tick: 15 },
      // MEASURED alongside tank-destroyed, same tick, same point-blank shot `destroyed`
      // documents: the kill also emits `explosion` unconditionally (resolveBulletHits,
      // bullets.ts). Pinned here too, deliberately, rather than left to `destroyed`
      // alone -- the generic per-moment purity check runs independently per moment
      // over EACH one's own window, so `destroyed` pinning it says nothing about
      // whether `explosion` also fires again somewhere inside respawn's much longer
      // 0..180 window; pinning it here confirms it does not.
      { type: 'explosion', tick: 15 },
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

  /**
   * A solid wall face, hit at a shallow angle so the shell bounces off rather than
   * stopping dead -- the normal shell (`shells.normal.bounces` in balance.json) budgets
   * exactly 1 bounce, so this fixture only ever needs to show the first one.
   */
  ricochet: (() => {
    // atan2(1, 3): shallow relative to the wall's face (the x = RICOCHET_WALL.aabb.minX
    // plane) rather than a near-perpendicular hit, so the shell visibly deflects instead
    // of bouncing straight back the way it came.
    const RICOCHET_ANGLE = Math.atan2(1, 3);
    const RICOCHET_WALL: Wall = {
      id: 1, kind: 'solid', destroyed: false,
      aabb: { minX: 3.0, minY: -5, maxX: 3.2, maxY: 5 },
    };
    // Same `aim`-is-a-world-point landmine `KILL_IDLE` documents: a point far along the
    // firing direction from the tank's own (fixed) position keeps the turret's aimDir --
    // and so the shell's heading -- steady at RICOCHET_ANGLE with no slew needed, since
    // the shooter never moves in this moment.
    const RICOCHET_IDLE: InputState = {
      move: { x: 0, y: 0 },
      aim: { x: Math.cos(RICOCHET_ANGLE) * 1000, y: Math.sin(RICOCHET_ANGLE) * 1000 },
      fire: false, mine: false,
    };
    return {
      // MEASURED (throwaway vite-node probe, duplicate fixture, deleted before commit):
      // fire lands at events[10] (input(9) -> events[10], the shared convention every
      // other moment uses); the shell (0.1 unit/tick) reaches the wall and ricochets at
      // events[33], with no second bounce anywhere in a 60-tick probe -- consistent with
      // the normal shell's 1-bounce budget: after the first ricochet event bouncesLeft
      // is 0, so a later wall hit would stop the shell dead rather than emit a second
      // ricochet event.
      ticks: 45,
      expect: [
        { type: 'fire', tick: 10 },
        { type: 'ricochet', tick: 33 },
      ],
      focus: [1.5, 0.3, 0.5], span: 5,
      build: () => buildSoloWorld([RICOCHET_WALL]),
      input: (t) => (t === 9 ? { ...RICOCHET_IDLE, fire: true } : RICOCHET_IDLE),
    };
  })(),

  /**
   * `wall-destroyed` has exactly one production emission site in the whole sim
   * (`applyBlast`, mines.ts) -- a shell alone never touches a destructible wall's
   * `destroyed` flag; `stepBullets`/`resolveBulletHits` only ever bounce or stop a
   * shell against one (grep confirms no other `destroyed = true` write in src/sim).
   * So "shooter fires at a destructible cell" can only be staged through the ONE path
   * that credits the shooter with a wall kill: a shell detonating a MINE next to the
   * wall (resolveBulletHits' mine loop passes `{source: 'shell', ownerId: b.ownerId}`
   * as the blast's credit), whose blast then destroys the wall.
   *
   * The mine is pushed into `world.mines` directly rather than staged through a real
   * `mine: true` input + `dropMine` -- it needs to be ARMED from tick 0 (so
   * `shellMayDetonate` accepts the shell unconditionally, independent of
   * `world.unarmedTrigger`) and parked well clear of the shooter (see below), neither
   * of which a scripted drop-then-walk-away input buys anything for here (that sequence
   * IS the `mine-cycle` moment). This skips `dropMine`'s `owner.activeMineIds`
   * bookkeeping and the `mine-dropped` event, both harmless here: `detonateMine` only
   * reads `activeMineIds` to remove an ID that was never added, and this moment never
   * claims a `mine-dropped` pin.
   */
  'wall-break': (() => {
    const WALLBREAK_WALL: Wall = {
      id: 1, kind: 'destructible', destroyed: false,
      aabb: { minX: 3.3, minY: -0.5, maxX: 3.6, maxY: 0.5 },
    };
    const WALLBREAK_MINE_POS = { x: 3.0, y: 0 };
    // Far enough from the mine (distance 3.0) that the shooter sits outside
    // MINE_BLAST_RADIUS + TANK_RADIUS (2.0 + 0.5 = 2.5) at every age of the blast, so
    // this moment stays a pure wall-break with no incidental self-kill to also pin.
    const WALLBREAK_IDLE: InputState = { move: { x: 0, y: 0 }, aim: { x: 1000, y: 0 }, fire: false, mine: false };
    return {
      // MEASURED (throwaway vite-node probe): fire at events[10]; the shell reaches the
      // mine's trigger radius (MINE_TRIGGER_RADIUS + BULLET_RADIUS = 0.45) and TRIGGERS
      // it at events[26] -- since issue #275 the hit opens the warning. The shell
      // stage runs BEFORE that tick's stepMines, so the trigger tick itself takes the
      // first countdown decrement and the detonation lands at events[55] (26 + 29),
      // one tick EARLIER than the fuse path's spacing (contrast mine-cycle, whose
      // fuse triggers INSIDE stepMines and detonates a full 30 ticks on). The age-0
      // blast (already ~0.72 radius, comfortably past the wall's 0.3-unit gap from
      // the mine) destroys the wall on that SAME tick -- `mine-detonate` and
      // `wall-destroyed` both land at events[55], not two ticks.
      // 95 = 55 + 40 decay margin: the wall-destroyed particle burst (particles.ts's
      // `burst()`) needs room past the detonation to decay, same reasoning as
      // `destroyed` above -- see MomentDef.ticks's doc comment.
      ticks: 95,
      expect: [
        { type: 'mine-triggered', tick: 26 },
        { type: 'mine-detonate', tick: 55 },
        { type: 'wall-destroyed', tick: 55 },
      ],
      focus: [2, 0.3, 0], span: 5,
      build: () => {
        const w = buildSoloWorld([WALLBREAK_WALL]);
        w.mines.push({
          id: 500, ownerId: 1, pos: { ...WALLBREAK_MINE_POS },
          // Large enough that the fuse never expires on its own before the shell
          // reaches it (the shell arrives well under 30 ticks in); this moment is
          // about the shell-triggered path, not the timer, which `mine-cycle` covers.
          timer: 999, armed: true, detonated: false,
        });
        return w;
      },
      input: (t) => (t === 9 ? { ...WALLBREAK_IDLE, fire: true } : WALLBREAK_IDLE),
    };
  })(),

  /**
   * The full mine lifecycle, staged through the real drop input rather than a
   * hand-placed mine (contrast `wall-break` above, which needs an already-armed one):
   * lay it, walk clear so it arms, then let the fuse run out on its own -- the `fuse`
   * element (subjects.ts) renders a single POSE at a chosen age using the same
   * MINE_TIMER math; this is the sim actually living through that countdown tick by
   * tick and detonating at the end of it.
   */
  'mine-cycle': (() => {
    // Fixed far downrange so aimDir stays steady while the tank walks (same
    // aim-is-a-world-point landmine every other moment here documents); unrelated to
    // the mine mechanic itself, just keeps the turret from wandering on screen.
    const MINE_CYCLE_AIM = { x: 1000, y: 0 };
    const MINE_CYCLE_IDLE: InputState = { move: { x: 0, y: 0 }, aim: MINE_CYCLE_AIM, fire: false, mine: false };
    const MINE_CYCLE_WALK: InputState = { move: { x: 1, y: 0 }, aim: MINE_CYCLE_AIM, fire: false, mine: false };
    return {
      // MEASURED (throwaway vite-node probe): the mine is dropped at rest (owner hasn't
      // moved yet) at events[10], at the owner's position (0, 0) -- it stays there for
      // the rest of the clip; only the owner walks. Starting tick 10 the owner walks
      // east and clears MINE_PROXIMITY_RADIUS (stepMines' arming distance) at
      // events[40]. No shell, no proximity re-trigger (the owner keeps walking away,
      // never re-entering blast range) -- the fuse alone TRIGGERS it, at events[190];
      // since issue #275 that opens the warning, and the detonation lands exactly
      // MINE_WARNING_TICKS (30) later, at events[220]. No 'explosion'/'tank-destroyed'
      // anywhere in the window: by tick 220 the owner is 10+ units clear, well outside
      // MINE_BLAST_RADIUS + TANK_RADIUS (2.5), and only keeps walking further away.
      // 260 = 220 + 40 decay margin: the mine-detonate particle burst (particles.ts's
      // `burst()`) needs room past the detonation to decay, same reasoning as
      // `destroyed`/`wall-break` above -- see MomentDef.ticks's doc comment; the margin
      // is walked through by the same MINE_CYCLE_WALK input the fuse-running portion
      // already uses.
      ticks: 260,
      expect: [
        { type: 'mine-dropped', tick: 10 },
        { type: 'mine-armed', tick: 40 },
        { type: 'mine-triggered', tick: 190 },
        { type: 'mine-detonate', tick: 220 },
      ],
      // Tight on the mine's own (fixed) position rather than the walking owner, same
      // choice `respawn` makes for its frozen shooter: the mine is the subject.
      focus: [0, 0.3, 0], span: 3,
      build: buildSoloWorld,
      input: (t) => {
        if (t === 9) return { ...MINE_CYCLE_IDLE, mine: true };
        if (t > 9) return MINE_CYCLE_WALK;
        return MINE_CYCLE_IDLE;
      },
    };
  })(),

  /**
   * Straight-line motion, no event to pin: the issue's `drive` state, isolated so a
   * moment can prove position moves while the other two axes hold still.
   *
   * bodyAngle is already aligned with the move direction at spawn (both 0, due east),
   * so `moveTank` (collision.ts) never needs to turn the hull -- `align` (its own
   * dot-product term) is 1 on every tick from the first, not ramping up from a turn.
   * That is what makes this moment's "holds still" EXACT rather than the bounded
   * approximation `pivot` below needs: with no turn in progress there is nothing for
   * "a turn costs ground" (collision.ts's own phrase) to cost.
   */
  drive: {
    ticks: 30,
    expect: [],
    focus: [0.75, 0.3, 0], span: 4,
    build: buildSoloWorld,
    // aim far down the SAME line the tank drives, so aimDir (a world-space point minus
    // the tank's own, ever-advancing position) keeps angle 0 the whole clip -- the
    // aim-is-a-world-point landmine every other moment here documents, satisfied by
    // construction rather than by re-aiming every tick.
    input: () => ({ move: { x: 1, y: 0 }, aim: { x: 1000, y: 0 }, fire: false, mine: false }),
  },

  /**
   * Turning in place, no event to pin: the issue's `pivot` state.
   *
   * UNLIKE `drive`, position here cannot be held EXACTLY still: `moveTank`
   * (collision.ts) updates bodyAngle first and only then computes `align` from the
   * JUST-turned heading, so any tick that turns the hull at all also drives it forward
   * by `align` -- the file's own comment calls this "a turn costs ground rather than
   * being free". MEASURED (throwaway vite-node probe) with a target held 90 degrees
   * off the tank's OWN starting heading: over 10 ticks bodyAngle sweeps a full 0.8333
   * rad (strictly increasing every tick, no plateau -- the tank does not reach the
   * 90-degree target until tick ~19) while position drifts to a maximum straight-line
   * distance of 0.2104 from the start -- bounded well under PIVOT_POSITION_BOUND below,
   * and a fraction of what 10 ticks of an aligned (`drive`-shaped) move would cover
   * (0.5). That contrast, not literal zero, is what "holds still" means here.
   */
  pivot: {
    ticks: 10,
    expect: [],
    focus: [0, 0.3, 0], span: 3,
    build: buildSoloWorld,
    // move: north -- 90 degrees off the tank's initial (east) bodyAngle, so it turns
    // rather than reverses (moveTank's reverse gear only engages past 90 degrees).
    // aim: a point far enough away (1e6) that the position drift above moves the
    // turret's target angle by an amount PIVOT_TURRET_EPS can absorb -- unrelated to
    // `move` on purpose, so a turret-vs-hull coupling bug would show up here.
    input: () => ({ move: { x: 0, y: 1 }, aim: { x: 1e6, y: 0 }, fire: false, mine: false }),
  },

  /**
   * Turret traverse, no event to pin: the issue's `traverse` state.
   *
   * move stays zero for the whole clip, so `moveTank` (collision.ts) never even enters
   * its `mlen > 0` branch -- position and bodyAngle are untouched, not merely close:
   * this moment's "holds still" IS exact, the same as `drive`'s, for the opposite
   * reason (no motion attempted at all, rather than motion already fully aligned).
   * turretAngle is independent of both (`driveTank`, world.ts, slews it from `aimDir`
   * with no reference to bodyAngle or position), so aiming a fixed point ~170 degrees
   * around from the turret's own start sweeps it steadily without the two ever moving.
   * MEASURED (throwaway vite-node probe): turretAngle increases every tick through
   * tick 23 (arrival), so this moment's whole 20-tick clip stays inside that window --
   * no plateau to design around, unlike the shorter margin `pivot` needed.
   */
  traverse: {
    ticks: 20,
    expect: [],
    focus: [0, 0.3, 0], span: 3,
    build: buildSoloWorld,
    input: () => {
      // 170 degrees, not 180 or beyond: angleDelta (types.ts) wraps its result to
      // (-PI, PI], so a target more than a half-turn from the turret's current angle
      // would flip sign mid-sweep instead of continuing to grow. Staying 10 degrees
      // under that boundary keeps every tick's raw (target - current) delta inside
      // (0, PI) for the whole 0 -> ~2.967 rad sweep, so it never trips the wrap
      // correction -- which is what keeps this moment's monotonic-increase assertion
      // (moments.test.ts) positive from start to arrival, not just at the endpoints.
      const theta = (170 * Math.PI) / 180;
      return { move: { x: 0, y: 0 }, aim: { x: Math.cos(theta) * 1000, y: Math.sin(theta) * 1000 }, fire: false, mine: false };
    },
  },

  /**
   * Issue #231's `stopping` capture: a tank drives far enough to print several
   * tread-decal pairs, then stops, so the gif shows the trail PERSISTING and FADING
   * behind a now-stationary tank with no new decals after the stop.
   *
   * The first `TRAIL_STOP_DRIVE_TICKS` ticks are exactly `drive`'s own input/build
   * (bodyAngle already aligned with due-east at spawn, so -- same reasoning as
   * `drive`'s own doc comment -- position.x's growth is exact, not the bounded
   * approximation `pivot` needs). At `movementSpeed` `TANK_SPEED` = 3.0 world
   * units/second (balance.json), that covers 30 * 3.0 / 60 = 1.5 world units --
   * 1.5 / EMIT_SPACING (0.25, tread-trails.ts) = 6 decal PAIRS before the tank ever
   * stops, comfortably "several".
   */
  'trail-stop': {
    // MEASURED (throwaway vite-node probe): with the drive phase ending at tick 30,
    // position is IDENTICAL (bit-for-bit, not just close) at every tick from 30 through
    // 90 -- once `move` drops to zero, `moveTank` (collision.ts) never enters its
    // `mlen > 0` branch again, so there is nothing left to accumulate. LIFETIME_SECONDS
    // (tread-trails.ts) is 2.0s = 120 ticks at TICK_HZ, so a 90-tick clip (drive 30 +
    // stopped 60) deliberately stops well short of full decay: the runner's own draw
    // loop only ever reaches age `ticks - 1` (see `buildMomentScene`'s own comment on
    // why `frames: def.ticks` -- not `+1` -- is correct), so the LAST drawn frame here
    // sits at age 89, putting the freshest decal (printed at tick 30) at 59 ticks old
    // (opacity ~0.25 of peak) and the oldest (tick 5) at 84 (~0.15) -- both still
    // plainly visible against the ground, not faded to invisibility the way a window
    // that ran the stopped phase out past LIFETIME_SECONDS would leave the last frame.
    ticks: 90,
    expect: [],
    // Same framing `drive` itself uses: the whole path (x: 0 -> 1.5) and the parked
    // tank both sit inside it already, and the trail never extends past where the tank
    // itself was driven, so nothing new needs to fit.
    focus: [0.75, 0.3, 0], span: 4,
    build: buildSoloWorld,
    input: (t) => (t < 30
      ? { move: { x: 1, y: 0 }, aim: { x: 1000, y: 0 }, fire: false, mine: false }
      : { move: { x: 0, y: 0 }, aim: { x: 1000, y: 0 }, fire: false, mine: false }),
  },

  /**
   * Issue #231's `overlapping paths` capture: two tanks whose driven paths cross, so
   * the gif shows both trails including the region where they overlap.
   *
   * Tank A (world.tanks[0], id 1, slot 0) drives due east from (0, 0) for 40 ticks
   * (2.0 world units -- 8 EMIT_SPACING crossings) then stops, exactly `trail-stop`'s
   * own shape. Tank B (world.tanks[1], id 2, slot 1, `controlledBy: 1`) sits idle at
   * (0.75, -1.05) -- ON the x = 0.75 line A's own path crosses at tick 15 -- until tick
   * 30, then drives due north (bodyAngle already Ο€/2, aligned with its own move, same
   * "no turn cost" reasoning `drive`'s doc comment gives the east-facing case) for the
   * rest of the clip, crossing y = 0 (A's path) partway through.
   *
   * The staggering -- B idle through A's own closest approach, only starting once A is
   * either past it or fully parked -- exists to clear `separateTanks` (collision.ts)'s
   * `TANK_RADIUS * 2` = 1.0 unit push-apart radius, not for the trail itself: two tank
   * BODIES within that range get shoved apart mid-tick, which would silently bend both
   * paths off their scripted lines. MEASURED (throwaway vite-node probe) over the whole
   * clip: minimum centre-to-centre distance is 1.05 world units, at tick 15 (A passing
   * B's still-idle x = 0.75 row, 1.05 world units of clearance in y alone) -- above 1.0
   * throughout (a tighter margin than an earlier draft's 1.3, traded deliberately for a
   * SHORTER clip -- see the ticks comment below -- so the two tanks still never touch
   * and every position below is the exact, uninterrupted kinematic path, not a
   * collision-nudged approximation of it).
   */
  'trail-cross': {
    // MEASURED (throwaway vite-node probe): B crosses y = 0 -- A's path -- at tick 51,
    // by which point A has been parked at (2.0, 0) for 11 ticks. 70, not longer: the
    // runner's draw loop only ever reaches age `ticks - 1` (69 here), so keeping the
    // clip SHORT is what keeps A's own crossing-region decal (printed at tick 15, when
    // A itself passed x = 0.75) recognisable in the last drawn frame -- at age 69 it is
    // 54 ticks old (opacity ~0.28 of peak, against LIFETIME_SECONDS' 120-tick full
    // decay), not the ~0.15 an earlier draft's longer (100-tick) window left it at.
    // B's own crossing decal (tick 51) is fresher still, 18 ticks old (~0.43), and the
    // clip still gives it 19 ticks (0.32s) to extend past the crossing before the last
    // frame. MEASURED (throwaway vite-node probe): exact alphas 0.275 / 0.425.
    ticks: 70,
    expect: [],
    // Both paths' combined bounding box is x: [0, 2.0], y: [-1.05, 0.95] -- a ~2 unit
    // square. Centred on it (not on the crossing point alone) so both full trails, not
    // just their intersection, are in frame. span 3, not the wider 4 an earlier draft
    // used: at a peak decal opacity of 0.5 (TREAD_OPACITY, tread-trails.ts) already
    // faded further by age (see the ticks comment above), a tighter shot is what keeps
    // an individual decal enough SCREEN pixels to actually read in a still --
    // MEASURED (rendered PNG, cropped and contrast-boosted): span 4 left the far ends
    // of both trails imperceptible even after a 2x contrast boost; span 3 keeps the
    // whole ~2-unit bounding box in frame with less margin but visibly larger decals.
    focus: [1.0, 0.3, -0.05], span: 3,
    build: () => {
      const BX = 0.75;
      const BY0 = -1.05;
      const BANGLE = Math.PI / 2;
      const w = createWorld({
        walls: [],
        spawns: [{ pos: { x: 0, y: 0 }, angle: 0 }, { pos: { x: BX, y: BY0 }, angle: BANGLE }],
        lives: 3,
        tanks: [
          {
            id: 1, kind: 'player',
            pos: { x: 0, y: 0 }, bodyAngle: 0, turretAngle: 0, alive: true,
            desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
            aiState: 'idle', aiTimer: 0, controlledBy: 0,
          },
          {
            id: 2, kind: 'player',
            pos: { x: BX, y: BY0 }, bodyAngle: BANGLE, turretAngle: BANGLE, alive: true,
            desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
            aiState: 'idle', aiTimer: 0, controlledBy: 1,
          },
        ],
        seed: 7,
      });
      // Same landmine every other moment in this file documents: a fresh world's
      // roundStartTick locks fire/mine through the round-start countdown, irrelevant
      // here (neither tank ever fires or mines) but kept for consistency with every
      // other build() in this file, in case a later edit adds one.
      w.roundStartTick = -600;
      return w;
    },
    input: (t) => (t < 40
      ? { move: { x: 1, y: 0 }, aim: { x: 1000, y: 0 }, fire: false, mine: false }
      : { move: { x: 0, y: 0 }, aim: { x: 1000, y: 0 }, fire: false, mine: false }),
    // aim.x pins B's OWN fixed x (0.75, the BX literal above) with a huge y: since B
    // only ever moves along that same vertical line, dx stays exactly 0 the whole
    // clip, keeping aimDir exactly north -- already matching BANGLE at spawn, so
    // turretAngle never slews, the same "aim is a world-space point" treatment every
    // other moment here gives a tank whose own path is known in advance.
    //
    // Idle through tick 30, not all the way to 40: A's own closest approach to B's row
    // is tick 15 (MEASURED above), and by tick 30 A is 0.75 world units clear of it
    // (dx = |1.5 - 0.75|) even while still driving -- enough clearance, combined with
    // B's own dy, to stay outside TANK_RADIUS * 2 for the rest of A's approach to its
    // tick-40 park (MEASURED via the same probe, minimum 1.05 throughout).
    input2: (t) => (t < 30
      ? { move: { x: 0, y: 0 }, aim: { x: 0.75, y: 1e6 }, fire: false, mine: false }
      : { move: { x: 0, y: 1 }, aim: { x: 0.75, y: 1e6 }, fire: false, mine: false }),
  },

  /**
   * Issue #231's `multiple tank skins/colors` capture: trails under two visibly
   * different hull paints, proving the decal colour (TREAD_COLOR, tread-trails.ts) is
   * paint-independent rather than sampled from the tank that printed it.
   *
   * Both tanks drive due east in parallel lanes (no crossing -- that is `trail-cross`'s
   * job) so both trails read clearly side by side. The colour contrast itself needs no
   * code here: `buildMomentScene` (moment-scene.ts) already dresses `world.tanks[0]`
   * (`controlledBy: 0`, slot 0) with whatever `--skin`/`--hull`/`--accent` the CLI
   * passes, and hardcodes every OTHER slot -- `world.tanks[1]` here, `controlledBy: 1`,
   * slot 1 -- to `('solid', hull: null)`, which resolves to the same roster default
   * blue slot 0 itself would be without CLI overrides (see that file's own "VISIBLE
   * SIDE EFFECT" comment). So rendering this moment with any non-default `--skin`/
   * `--hull` already puts two DIFFERENT paints on screen with no per-slot styling knob
   * needed in this file.
   */
  'trail-skins': {
    // 40 ticks: 2.0 world units (3.0 * 40 / 60) -- 2.0 / EMIT_SPACING (0.25) = 8 decal
    // pairs per tank, comfortably "several", without a stop (unlike `trail-stop`,
    // this capture is about paint, not the stopped state).
    ticks: 40,
    expect: [],
    // Path x: [0, 2.0], lanes at y = +-0.75 (1.5 apart -- clear of the TANK_RADIUS * 2
    // = 1.0 collision radius the whole clip, with margin, since the two tanks never
    // close that gap: same y offset from tick 0, identical east-facing speed).
    focus: [1.0, 0.3, 0], span: 4.5,
    build: () => {
      const LANE = 0.75;
      const w = createWorld({
        walls: [],
        spawns: [{ pos: { x: 0, y: LANE }, angle: 0 }, { pos: { x: 0, y: -LANE }, angle: 0 }],
        lives: 3,
        tanks: [
          {
            id: 1, kind: 'player',
            pos: { x: 0, y: LANE }, bodyAngle: 0, turretAngle: 0, alive: true,
            desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
            aiState: 'idle', aiTimer: 0, controlledBy: 0,
          },
          {
            id: 2, kind: 'player',
            pos: { x: 0, y: -LANE }, bodyAngle: 0, turretAngle: 0, alive: true,
            desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
            aiState: 'idle', aiTimer: 0, controlledBy: 1,
          },
        ],
        seed: 7,
      });
      w.roundStartTick = -600;
      return w;
    },
    // aim.y matches each tank's OWN lane (not 0) so aimDir stays exactly horizontal --
    // the same "aim is a world-space point, not a direction" landmine every other
    // moment here documents -- keeping turretAngle exactly 0 for both, the whole clip.
    input: () => ({ move: { x: 1, y: 0 }, aim: { x: 1000, y: 0.75 }, fire: false, mine: false }),
    input2: () => ({ move: { x: 1, y: 0 }, aim: { x: 1000, y: -0.75 }, fire: false, mine: false }),
  },
};

/**
 * `pivot`'s own tuned tolerances, not a generic `MomentDef` field -- `MOMENTS.pivot`
 * cannot hold still exactly (see its doc comment), so its motion-specific test in
 * moments.test.ts needs a bound to compare against. Exported here, next to the
 * geometry and measurements that set them, rather than re-derived or duplicated in
 * the test file.
 */
// Comfortably above the measured 0.2104 (margin for the exact float path taken),
// comfortably below what 10 ticks of a `drive`-shaped, fully-aligned move covers
// (0.5) -- verified live in this task's report (pivot-negctrl-aligned-move probe).
export const PIVOT_POSITION_BOUND = 0.25;
// The turret slews toward a FIXED aim point every tick; with position bounded under
// 0.21 and the aim point 1e6 units away, the resulting angleDelta is ~1e-7 rad at
// worst -- effectively zero for anything this bound needs to catch. A NEARER aim
// point (verified live: 10 units away) pushes it past 1e-4 by tick 4.
export const PIVOT_TURRET_EPS = 1e-4;
