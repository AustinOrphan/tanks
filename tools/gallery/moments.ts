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
    // RE-MEASURED for issue #237's muzzle inset (buildKillWorld, fire at input(9) ->
    // events[10]): the shooter sits at (3.5, 4.5) and the shell (speed 6 = 0.1 unit/tick)
    // is now born at (4.025, 4.5) rather than a third of a unit further out. events[10]'s
    // world already shows it one step along at (4.125, 4.5) -- world.ts spawns in
    // applyPlayerInputs and moves in stepBullets within the same tick -- which is 1.375
    // units from the victim's centre at (5.5, 4.5). It closes to the TANK_RADIUS +
    // BULLET_RADIUS = 0.6 hit threshold 8 ticks after that, landing the kill at tick 18. The whole 3-tick slip is the inset
    // divided by the shell's speed (0.325 / 0.1), which is why every shell-driven pin in
    // this file moved by the same amount. `destroyed` intentionally stops well short of
    // RESPAWN_DELAY_TICKS later (tick 138), so the revival never enters this shorter clip.
    expect: [
      { type: 'tank-destroyed', tick: 18 },
      // MEASURED alongside tank-destroyed, same tick, no ricochet: point-blank range
      // means the shell's lethal hit and its explosion fire on the SAME tick,
      // unconditionally, in resolveBulletHits (bullets.ts) -- every fatal shell impact
      // emits `tank-destroyed` then `explosion` before the loop breaks.
      { type: 'explosion', tick: 18 },
    ],
    focus: [4.5, 0.3, 4.5], span: 4,
    build: buildKillWorld,
    input: (t) => (t === 9 ? { ...KILL_IDLE, fire: true } : KILL_IDLE),
  },

  /** Kill then stock respawn: #201's before/after and three-up media source. */
  respawn: {
    // MEASURED kill tick (18, see `destroyed` above) + RESPAWN_DELAY_TICKS (the shipped
    // revival delay) + 45 ticks so the entrance animation has room to play out after the
    // revival tick. Deriving the WINDOW size from RESPAWN_DELAY_TICKS is fine here --
    // it only decides how long simulateMoment runs, not what a pin claims happened --
    // the tautology risk the comment below guards against is specific to `expect[]`
    // tick literals, which moments.test.ts's own delay assertion re-derives against.
    ticks: 18 + RESPAWN_DELAY_TICKS + 45,
    expect: [
      { type: 'tank-destroyed', tick: 18 },
      // MEASURED alongside tank-destroyed, same tick, same point-blank shot `destroyed`
      // documents: the kill also emits `explosion` unconditionally (resolveBulletHits,
      // bullets.ts). Pinned here too, deliberately, rather than left to `destroyed`
      // alone -- the generic per-moment purity check runs independently per moment
      // over EACH one's own window, so `destroyed` pinning it says nothing about
      // whether `explosion` also fires again somewhere inside respawn's much longer
      // 0..183 window; pinning it here confirms it does not.
      { type: 'explosion', tick: 18 },
      // MEASURED: tick 138 (was 135 before issue #237's muzzle inset pushed the kill
      // from 15 to 18; the revival delay itself is unchanged). Pinned as a literal,
      // deliberately NOT `18 + RESPAWN_DELAY_TICKS` -- moments.test.ts's own delay
      // assertion computes `revived - killed` and compares it to the SAME imported
      // RESPAWN_DELAY_TICKS constant, so a derived expression here would make that
      // comparison `(18 + C) - 18 === C`, true for every value of C and incapable of
      // failing. A literal is what lets a future balance change to RESPAWN_DELAY_TICKS
      // actually red both that assertion and the generic per-tick pin below,
      // independently.
      { type: 'respawn', tick: 138 },
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
      // MEASURED (throwaway vite-node probe, duplicate fixture, deleted before commit;
      // RE-MEASURED for issue #237's muzzle inset): fire lands at events[10] (input(9) ->
      // events[10], the shared convention every other moment uses); the shell (0.1
      // unit/tick) reaches the wall and ricochets at events[36] -- 3 ticks later than
      // before, the inset over the shell's speed -- with no second bounce anywhere in a
      // 60-tick probe, consistent with
      // the normal shell's 1-bounce budget: after the first ricochet event bouncesLeft
      // is 0, so a later wall hit would stop the shell dead rather than emit a second
      // ricochet event.
      ticks: 45,
      expect: [
        { type: 'fire', tick: 10 },
        { type: 'ricochet', tick: 36 },
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
   * `world.rules.unarmedTrigger`) and parked well clear of the shooter (see below), neither
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
      // MEASURED (throwaway vite-node probe; RE-MEASURED for issue #237's muzzle inset):
      // fire at events[10]; the shell reaches the mine's trigger radius
      // (MINE_TRIGGER_RADIUS + BULLET_RADIUS = 0.45) and detonates it at events[30] --
      // IMMEDIATELY, by owner direction on PR #311 (shooting a mine is deliberately
      // setting it off; no reaction window) -- and the age-0 blast (already ~0.72 radius,
      // comfortably past the wall's 0.3-unit gap from the mine) destroys the wall on that
      // SAME tick -- `mine-detonate` and `wall-destroyed` both land at events[30], not
      // two ticks.
      // FOUR ticks later than the old pin of 26, where the other shell-driven moments in
      // this file moved three. The inset is 3.25 ticks of flight at 0.1 unit/tick, so
      // whether it costs 3 ticks or 4 depends on which side of a tick boundary the
      // threshold crossing already sat on -- this one sat close enough to the boundary to
      // be pushed over it. Both numbers are measured, not derived; do not "correct" one
      // to match the other.
      // 66, not 36 (final-review finding I2): the wall-destroyed particle burst
      // (particles.ts's `burst()`) needs room past tick 30 to decay, same reasoning as
      // `destroyed` above -- see MomentDef.ticks's doc comment.
      ticks: 66,
      expect: [
        { type: 'mine-detonate', tick: 30 },
        { type: 'wall-destroyed', tick: 30 },
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
  /**
   * The PROXIMITY half of the mine warnings (issue #276), which no other moment stages:
   * `mine-cycle` runs a fuse down to expiry, and `wall-break` shoots a mine (immediate, no
   * warning at all). Here a tank walks into an already-armed mine, so the clip shows the
   * reaction window itself -- the fill growing from the middle of the mine outward and
   * reaching full on the frame the blast starts.
   *
   * The mine is owned by a tank id that is NOT in the world (99), which is what keeps it
   * armed without staging an owner who would have to walk clear first. Same shortcut
   * `wall-break` takes, and harmless for the same reason: nothing reads that owner except
   * blast credit, and this moment pins no credit.
   */
  'mine-proximity': (() => {
    const AIM = { x: 1000, y: 0 };
    const WALK: InputState = { move: { x: 1, y: 0 }, aim: AIM, fire: false, mine: false };
    return {
      // MEASURED (throwaway probe through simulateMoment itself, this tree): walking from
      // x=-2.4 the tank crosses MINE_PROXIMITY_RADIUS and trips the mine at events[19]; the
      // blast lands at events[49], exactly MINE_PROXIMITY_DELAY_TICKS (30) later, and kills
      // the tank that tripped it on the same tick. 89 leaves the usual ~40-tick margin past
      // the detonation for the explosion burst to decay rather than cutting mid-fade.
      //
      // Measured THROUGH simulateMoment, not through a hand-rolled step() loop: the two
      // disagree by one. `events[0]` is the tick-0 world's own events, so a bare loop's
      // index t lands at events[t + 1] here. The first probe reported 18/48 and pinned
      // ticks that fire nothing.
      ticks: 89,
      expect: [
        { type: 'mine-triggered', tick: 19 },
        { type: 'mine-detonate', tick: 49 },
      ],
      focus: [-0.8, 0.3, 0], span: 4.5,
      build: () => {
        const w = createWorld({
          walls: [], spawns: [{ pos: { x: -2.4, y: 0 }, angle: 0 }], lives: 3,
          tanks: [{
            id: 1, kind: 'player',
            pos: { x: -2.4, y: 0 }, bodyAngle: 0, turretAngle: 0, alive: true,
            desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
            aiState: 'idle', aiTimer: 0,
          }],
          seed: 7,
        });
        w.roundStartTick = -600;
        w.mines.push({ id: 500, ownerId: 99, pos: { x: 0, y: 0 }, timer: 999, armed: true, detonated: false });
        return w;
      },
      input: () => WALK,
    };
  })(),

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
      // never re-entering blast range) -- the fuse alone ends it, at events[190],
      // exactly as before issue #275: the fuse warning is the fuse's FINAL window
      // (owner direction on PR #311), so `mine-fuse-warning` fires at events[160]
      // (exactly 30 ticks before expiry -- measured, this alignment carries no
      // accumulated-DT drift) and expiry timing is untouched. No 'explosion'/'tank-destroyed' anywhere in the
      // 230-tick window: by tick 190 the owner is 9 units clear, well outside
      // MINE_BLAST_RADIUS + TANK_RADIUS (2.5), and only keeps walking further away.
      // 230, not 200 (final-review finding I2): the mine-detonate particle burst
      // (particles.ts's `burst()`) needs room past tick 190 to decay, same
      // reasoning as `destroyed`/`wall-break` above -- see MomentDef.ticks's doc
      // comment.
      ticks: 230,
      expect: [
        { type: 'mine-dropped', tick: 10 },
        { type: 'mine-armed', tick: 40 },
        { type: 'mine-fuse-warning', tick: 160 },
        { type: 'mine-detonate', tick: 190 },
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

  /**
   * Issue #330's artefact: a STATIONARY AI tank's turret visibly tracking a moving
   * player. Brown is the only kind that isolates this to pure turret motion -- its
   * `brownDecision` (brown.ts) hardcodes `desiredMove: { x: 0, y: 0 }` on every path
   * (the STATIONARY behaviour), so the hull never moves and any motion on screen is
   * the turret alone, unlike grey/teal which also reposition.
   *
   * Unlike every earlier moment's single scripted tank, the thing being demonstrated
   * here is NOT the scripted player's own input -- it is `stepAi`'s per-tick
   * recompute of `AiDecision.turretAngle` (via `aimLead` against the player's
   * position, slewed at `AI_TURRET_TURN_RATE`, ai/index.ts), which #330 reports as a
   * continuous micro-shimmer because there is no deadband yet. This moment does not
   * fix or even measure that shimmer (no deadband exists to sweep) -- it only stages
   * the ONE thing #335 identifies as missing tooling for: a capture where a
   * stationary AI's turret has a moving target to track at all.
   *
   * DO NOT reach for this moment to demonstrate a turret DEADBAND, and do not read a
   * flat before/after here as evidence a deadband does nothing. MEASURED against issue
   * #330's deadband (0.25 degrees), sweeping AI_TURRET_DEADBAND over 0 and 0.25 on a
   * tree that carried both: 46 of the 47 rendered frames came out BYTE-IDENTICAL, the
   * single exception being frame 29. The reason is in the tick-by-tick note below --
   * the turret here slews at the 2.39deg/tick turn-rate cap on essentially every tick,
   * an order of magnitude above any deadband worth shipping, so the guard is inert
   * except right at the closest-approach turnaround (~tick 28), where the turret
   * reverses and the error passes through zero. Demonstrating shimmer needs the
   * OPPOSITE regime: a target whose bearing changes by well UNDER a degree per tick,
   * i.e. slow or distant enough that the turret makes small corrections instead of
   * saturating. That scenario is not authored yet.
   *
   * The player drives due east at a fixed y = 2, passing almost directly over the
   * AI at x = 0 -- "laterally across the AI's field of view" -- so the turret sweeps
   * through a wide arc rather than a narrow one, and REVERSES direction partway
   * through (the closest-approach point), rather than merely slewing toward one
   * fixed heading the way `traverse`'s single fixed aim point does.
   */
  'ai-tracking': (() => {
    const AI_TRACKING_PLAYER_Y = 2;
    const AI_TRACKING_PLAYER_X0 = -1.5;
    const AI_TRACKING_INPUT: InputState = { move: { x: 1, y: 0 }, aim: { x: 1000, y: 0 }, fire: false, mine: false };
    return {
      // MEASURED (throwaway vite-node probe, duplicate fixture, deleted before
      // commit): with the AI's turret starting at angle 0 and the player entering
      // already visible (no walls, los true from tick 0), turretAngle slews at the
      // turn-rate cap every tick -- 2.39deg/tick -- climbing to a peak of ~64.70deg
      // at tick 28 (the player's closest approach to x = 0) and then falling back to
      // 40.68deg by tick 47 as the player continues past. No plateau anywhere in
      // that window: each tick's turretAngle differs from its predecessor.
      //
      // 47, not longer: brownDecision's firing GATE (stepAi, ai/index.ts) requires
      // `aimTicks >= round(reactionTime * TICK_HZ)` -- STATIC_BASIC's reactionTime is
      // 0.8s, so 48 ticks -- before an actual shot leaves, and aimTicks climbs by
      // exactly 1 every tick once line of sight holds (which it does from tick 1
      // here). But `decision.fire` (brown.ts's state machine) only goes true on an
      // 'aim'-state tick, and tank.aiState cycles idle -> aim -> fire -> reposition ->
      // idle every 4 ticks REGARDLESS of whether the reaction gate actually let a shot
      // through (stepAi writes `tank.aiState = decision.nextState` unconditionally) --
      // so a firing OPPORTUNITY exists only on ticks 2, 6, 10, ..., 4k + 2. The first
      // one at or past the 48-tick gate is tick 50 (4*12 + 2), not 48. MEASURED:
      // extending this same fixture to 55 ticks does fire at tick 50, confirming the
      // derivation. Stopping at 47 keeps this moment PURE turret-tracking, with
      // nothing else to pin -- see the never-fires test in moments.test.ts, whose own
      // negative control is exactly this 55-tick extension.
      ticks: 47,
      expect: [],
      // Framed on the midpoint of the AI (0, 0) and the player's path's closest
      // stretch (x in [-1.5, 0.85] at y = 2), so both the turret and the tank
      // crossing its sights stay in frame the whole clip.
      focus: [-0.3, 0.3, 1], span: 5,
      build: () => {
        const w = createWorld({
          walls: [],
          spawns: [
            { kind: 'brown', pos: { x: 0, y: 0 }, angle: 0 },
            { kind: 'player', pos: { x: AI_TRACKING_PLAYER_X0, y: AI_TRACKING_PLAYER_Y }, angle: 0 },
          ],
          lives: 3,
          tanks: [
            {
              id: 1, kind: 'brown',
              pos: { x: 0, y: 0 }, bodyAngle: 0, turretAngle: 0, alive: true,
              desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
              aiState: 'idle', aiTimer: 0,
            },
            {
              id: 2, kind: 'player',
              pos: { x: AI_TRACKING_PLAYER_X0, y: AI_TRACKING_PLAYER_Y }, bodyAngle: 0, turretAngle: 0, alive: true,
              desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
              aiState: 'idle', aiTimer: 0,
            },
          ],
          seed: 7,
        });
        // Same landmine every other moment in this file documents: a fresh world's
        // roundStartTick locks fire/mine (and here, the player's own move) through the
        // round-start countdown/grace phase, so tick 0 must already be live.
        w.roundStartTick = -600;
        return w;
      },
      // aim far down the tank's own due-east heading, same "aim is a world-space point"
      // landmine every other moment here documents -- irrelevant to what's on screen
      // (the player never fires), kept only so the player's own turret doesn't wander.
      input: () => AI_TRACKING_INPUT,
    };
  })(),

  /**
   * Issue #372's artefact: an AI that LOSES sight of its target keeps looking at the last
   * place it actually saw it, for a bounded span, and only then falls back to #371's
   * search. `ai-tracking` above stages the easy half of that -- a turret following a
   * target it can see. This stages the half the issue is actually about, which is what
   * the turret does once it CANNOT.
   *
   * Brown again, and for the same reason `ai-tracking` gives (`brownDecision` hardcodes
   * `desiredMove: { x: 0, y: 0 }`, so every pixel of motion is turret), plus a second one
   * that matters only here: the shipped STATIC_BASIC carries `bankShotWeight` 0, so
   * brown.ts's `bankAngle` is null on every tick and its `hasSolution` reduces EXACTLY to
   * `lineOfSight`. That makes the wall below the single variable -- losing sight is the
   * whole cause of the behaviour on screen, with no banked solution keeping the tank on
   * target through it.
   *
   * MEASURED (throwaway vite-node probe, duplicate fixture, deleted before commit), on
   * this exact geometry:
   *
   *   tick 28  last tick with line of sight; the player is at x = 0.400, bearing 82.41deg
   *   tick 29  line of sight breaks and stays broken for the rest of the moment
   *   tick 46  the turret finishes slewing and sits at 82.4054deg
   *   ..118    FLAT. 73 consecutive ticks at that one value, to 4 decimal places
   *   tick 119 `aiLastSeenTicks` reaches 0 -- 29 + AI_LAST_SEEN_TICKS (90) exactly
   *   tick 120 the turret leaves the held bearing and starts #371's search sweep
   *
   * 82.4054deg is not "roughly where the player went". It is `atan2(3, 0.400)`, the
   * bearing to the position observed on tick 28 -- the LAST OBSERVED one, which is the
   * distinction issue #372 draws between remembering and knowing.
   *
   * WHY THE PLAYER PATROLS. See `input` below for the reasoning; the measurement is that
   * the player reverses direction three times inside the plateau while the turret reports
   * exactly ONE distinct value, 82.4054, across ticks 70-118. The tank cannot be
   * following, because the thing it would be following keeps turning around. The band is
   * also held clear of the remembered point, so the turret is never accidentally on
   * target: over the whole plateau the held bearing sits between 15.83 and 32.21deg off
   * the bearing to where the player actually is.
   *
   * THE CONTRAST IS REAL, and was checked before this moment was authored rather than
   * assumed -- `ai-tracking`'s own comment records the opposite outcome (46 of 47 frames
   * byte-identical when the knob under test turned out to be inert). Re-running this
   * fixture with the memory suppressed (`aiLastSeenTicks`/`aiLastSeenPos` cleared after
   * every step, so `rememberedContact` is always null and the aim chain falls through to
   * `searchAim`): the two timelines differ by up to 95.70deg, and only 39 of 165 ticks
   * come out byte-identical. The control is NOT motionless either -- its longest flat run
   * is 21 ticks, since a drawn search heading can be reached and then held for the rest of
   * its AI_SEARCH_HOLD_TICKS window. 73 against 21 is the contrast, not stillness against
   * motion.
   *
   * 165 ticks: 29 of tracking, 90 of held attention, and 46 more so the handoff INTO the
   * search sweep is on screen rather than implied by the clip ending.
   *
   * `expect: []` is load-bearing, and is why the wall sits where it does. brown's firing
   * gate needs `aimTicks >= 48` (STATIC_BASIC's 0.8s reaction) and its first firing
   * OPPORTUNITY past that gate is tick 50 -- the derivation is in `ai-tracking`'s comment
   * above. Sight breaks here on tick 29, which resets `aimTicks` 19 ticks before the gate
   * could close, so no shot is ever armed: the probe above reports NO events of any type
   * across all 165 ticks, in both the live and the suppressed arm.
   */
  'ai-last-seen': (() => {
    const LAST_SEEN_PLAYER_Y = 3;
    const LAST_SEEN_PLAYER_X0 = -1.0;
    // Starts at x 0.25 so the sightline from the AI at the origin is still clear at tick 0
    // and is cut at tick 29; ends at 2.8 so the whole slab is in frame, which is well east
    // of anywhere the script takes the player (max x 2.50), so sight never comes back.
    const LAST_SEEN_WALL: Wall = {
      id: 1, kind: 'solid', destroyed: false,
      aabb: { minX: 0.25, minY: 1.2, maxX: 2.8, maxY: 1.8 },
    };
    const EAST: InputState = { move: { x: 1, y: 0 }, aim: { x: 1000, y: 0 }, fire: false, mine: false };
    const WEST: InputState = { move: { x: -1, y: 0 }, aim: { x: 1000, y: 0 }, fire: false, mine: false };
    return {
      ticks: 165,
      expect: [],
      // The AI (0, 0), the wall it hides behind (x 0.25..2.8 at y 1.5) and the player's
      // whole excursion (x -1.0..2.50 at y 3) all sit inside this box. Framed for the
      // TOP view the capture recipe uses: this moment's whole content is where a turret
      // points relative to a target it cannot see, and the game camera's oblique angle
      // foreshortens exactly that bearing.
      focus: [0.75, 0.3, 1.4], span: 4.8,
      build: () => {
        const w = createWorld({
          walls: [LAST_SEEN_WALL],
          spawns: [
            { kind: 'brown', pos: { x: 0, y: 0 }, angle: 0 },
            { kind: 'player', pos: { x: LAST_SEEN_PLAYER_X0, y: LAST_SEEN_PLAYER_Y }, angle: 0 },
          ],
          lives: 3,
          tanks: [
            {
              id: 1, kind: 'brown',
              // 1.8 rad is ~5deg off the bearing to the player's start, so the clip opens
              // on the turret closing that gap rather than already welded to the target.
              pos: { x: 0, y: 0 }, bodyAngle: 0, turretAngle: 1.8, alive: true,
              desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
              aiState: 'idle', aiTimer: 0,
            },
            {
              id: 2, kind: 'player',
              pos: { x: LAST_SEEN_PLAYER_X0, y: LAST_SEEN_PLAYER_Y }, bodyAngle: 0, turretAngle: 0, alive: true,
              desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
              aiState: 'idle', aiTimer: 0,
            },
          ],
          seed: 7,
        });
        // Same round-start landmine every other moment here documents.
        w.roundStartTick = -600;
        return w;
      },
      // Once it is hidden the player PATROLS -- 18 ticks west, 18 ticks east, repeating
      // from tick 70 -- rather than driving on in a straight line. Two reasons, both
      // about what a viewer can conclude from the clip. A target that simply left could
      // not distinguish an attentive turret from a frozen one. And a target that came
      // back THROUGH the remembered point would put the turret momentarily on top of it
      // by coincidence, which is exactly the frame someone would screenshot to argue the
      // opposite; the patrol band (x 1.60..2.50) is bounded away from the remembered
      // x = 0.400 so that never happens. Reversals land on both sides of the expiry, so
      // the clip shows a moving target being ignored while remembering AND while
      // searching.
      input: (t: number) => (t < 70 ? EAST : Math.floor((t - 70) / 18) % 2 === 0 ? WEST : EAST),
    };
  })(),

  /**
   * Issue #359's artefact: two AIs, two players, and each AI sticking to the opponent it
   * committed to while both of them cross the board.
   *
   * WHAT DECIDES WHO TARGETS WHOM, because it is not "the nearest one". `selectPerceived`
   * ranks candidates by `rangeCost` -- distance from the profile's `preferredDistance` --
   * and STATIC_BASIC prefers 10. The geometry below is built backwards from that: the
   * player on each AI's own side sits 12 units away (cost 2) and the far one 13.4 (cost
   * 3.4), so the left AI commits to the left player and the right AI to the right one.
   * A symmetric fixture does NOT produce this -- an earlier draft put both players
   * equidistant and both AIs picked the same one, which is correct behaviour and shows
   * no distribution at all.
   *
   * MEASURED (throwaway vite-node probe, duplicate fixture, deleted before commit):
   *
   *   tick   1   tank 1 commits to player 3, tank 2 to player 4, both for the full
   *              90-tick span (`targetCommitmentTime` 1.5s)
   *   tick  25   the players start driving, each toward the other's side
   *   ..178      NEITHER AI CHANGES TARGET. tank 1 holds player 3 and tank 2 holds
   *              player 4 for all 178 ticks, across the entire crossing
   *   turrets    they start 16.4deg apart (80.6 and 97.0) and finish 121.2deg apart
   *              (27.8 and 149.0), because each is following its own player past the other
   *
   * That divergence is the whole artefact: two turrets sweeping APART while the tanks they
   * track swap sides is what "pressure distribution" looks like from outside, and a
   * per-tick retarget would instead show them converging as each AI grabbed whichever
   * opponent was momentarily better placed.
   *
   * SEPARATE LANES (y 12 and 13.6), not one. Two players driven at each other down the
   * same lane collide and bounce, which ends the crossing halfway and was how the first
   * draft failed.
   *
   * 178 TICKS, and the number is a kill. Unlike `ai-last-seen`, this moment needs
   * continuous line of sight for the turrets to track at all, so brown's 48-tick reaction
   * gate fires on schedule and the clip legitimately contains shots. MEASURED: the first
   * `tank-destroyed` lands on tick 182, from a shell fired at 170/174. Stopping at 178
   * keeps every shot in flight and no death in frame -- a kill mid-clip would reset the
   * victim's position AND `roundStartTick`, which is the landmine `mine-escape`'s harness
   * documents and it would silently corrupt everything after it.
   *
   * WHAT THIS MOMENT DOES NOT SHOW: a retarget. Commitment expires every 90 ticks and
   * re-commits unless a challenger beats the held target by AI_TARGET_SWITCH_MARGIN (2),
   * and MEASURED, the first switch here lands at tick ~181 -- past the kill, so it cannot
   * be filmed on this fixture. #359's "target changes" half needs its own moment built
   * around a challenger that becomes materially better before a shell can connect.
   */
  'ai-commitment': (() => {
    const LEFT = { x: -3, y: 0 };
    const RIGHT = { x: 3, y: 0 };
    const P1 = { x: -3, y: 12 };
    const P2 = { x: 3, y: 13.6 };
    const hold = (y: number, dir: number): InputState => ({ move: { x: 0, y: 0 }, aim: { x: dir * 1000, y }, fire: false, mine: false });
    const run = (y: number, dir: number): InputState => ({ move: { x: dir, y: 0 }, aim: { x: dir * 1000, y }, fire: false, mine: false });
    return {
      ticks: 178,
      // Both AIs fire on tick 50, then drift apart as their reaction clocks diverge.
      // Pinned rather than avoided: see the doc comment on why the shots are unavoidable
      // here and why the clip stops before the first one connects.
      expect: [
        { type: 'fire' as const, tick: 50 },
        { type: 'fire' as const, tick: 90 },
        { type: 'fire' as const, tick: 94 },
        { type: 'fire' as const, tick: 130 },
        { type: 'fire' as const, tick: 134 },
        { type: 'fire' as const, tick: 170 },
        { type: 'fire' as const, tick: 174 },
      ],
      // Both AIs (y 0) and both player lanes (y 12 and 13.6) in frame, centred on the
      // crossing rather than on either side.
      focus: [0, 0.3, 6.8], span: 17,
      build: () => {
        const w = createWorld({
          walls: [],
          spawns: [
            { kind: 'brown', pos: { ...LEFT }, angle: 0 },
            { kind: 'brown', pos: { ...RIGHT }, angle: 0 },
            { kind: 'player', pos: { ...P1 }, angle: 0 },
            { kind: 'player', pos: { ...P2 }, angle: 0 },
          ],
          lives: 9,
          tanks: [
            // Turrets start near, but not on, their targets' bearings, so the clip opens
            // on two turrets settling rather than two already welded in place.
            { id: 1, kind: 'brown', pos: { ...LEFT }, bodyAngle: 0, turretAngle: 1.4, alive: true,
              desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0, aiState: 'idle', aiTimer: 0 },
            { id: 2, kind: 'brown', pos: { ...RIGHT }, bodyAngle: 0, turretAngle: 1.7, alive: true,
              desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0, aiState: 'idle', aiTimer: 0 },
            { id: 3, kind: 'player', pos: { ...P1 }, bodyAngle: 0, turretAngle: 0, alive: true,
              desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0, aiState: 'idle', aiTimer: 0 },
            { id: 4, kind: 'player', pos: { ...P2 }, bodyAngle: 0, turretAngle: 0, alive: true,
              desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0, aiState: 'idle', aiTimer: 0 },
          ],
          seed: 7,
        });
        // Same round-start landmine every other moment here documents.
        w.roundStartTick = -600;
        return w;
      },
      // 25 still ticks first, so the commitment is visibly established BEFORE anything
      // moves -- otherwise a viewer cannot tell a held target from a lucky initial pick.
      input: (t: number) => (t >= 25 ? run(12, 1) : hold(12, 1)),
      input2: (t: number) => (t >= 25 ? run(13.6, -1) : hold(13.6, -1)),
    };
  })(),

  /**
   * Issue #359's other half: the RETARGET. `ai-commitment` above shows an AI refusing to
   * be pulled off its committed opponent; this shows the same rule letting go.
   *
   * Both halves are the same mechanism seen from opposite sides, and neither is legible
   * without the other -- a turret that never switches looks stubborn rather than
   * committed, and one that switches looks like it is simply chasing the best target.
   * What makes it a COMMITMENT is the gap between "a better target exists" and "the AI
   * acts on it", and that gap is what this moment measures.
   *
   * MEASURED (throwaway vite-node probe, duplicate fixture, deleted before commit). One
   * brown at the origin, preferred distance 10; the held player drives AWAY from that
   * band while the challenger drives INTO it:
   *
   *   tick   1   commits to player 2 -- cost 0.66 against the challenger's 4.80
   *   tick  55   the challenger becomes CHEAPER (2.42 against 2.81) and stays cheaper
   *   tick  92   switches to player 3: costs 4.09 against 1.24
   *   ..140      turret swings 25.8deg (tick 91) to 108.1deg (tick 130)
   *
   * WHAT HOLDS IT FOR THOSE 37 TICKS, measured by removing each rule from the tree and
   * re-reading the switch tick rather than by reasoning about the code:
   *
   *   shipped                    switches at 92
   *   commitment span = 0        switches at 82   <- the span is worth 10 ticks
   *   AI_TARGET_SWITCH_MARGIN 0  switches at 92   <- the margin is worth NOTHING here
   *
   * So the long first stretch, ticks 55 to 82, is neither of the rules this moment is
   * named for. It is `selectPerceived` comparing BANDED costs (AI_TARGET_TIE_BAND, 0.5):
   * a challenger that is cheaper by less than a band is not even selected, so there is
   * nothing for the margin or the span to refuse. By the time the span does expire the
   * challenger already wins by more than the margin, which is why deleting the margin
   * moves nothing on this fixture.
   *
   * Two earlier drafts of this comment got that attribution wrong -- the first credited
   * all 37 ticks to the span, the second credited 26 of them to the margin. Both were
   * plausible from reading `commitTarget` and both are contradicted by the table above.
   * The moment is worth filming for the 37-tick hold; only 10 of it is the commitment.
   *
   * BOTH PLAYERS DRIVE EAST, which is why they never collide despite sharing a lane: they
   * start 19.5 units apart and move in parallel. `ai-commitment`'s first draft put two
   * players on a collision course down one lane and they bounced apart halfway.
   *
   * 140 TICKS. Shots leave at 50, 90 and 130 -- brown's reaction gate again, unavoidable
   * with continuous sight -- and MEASURED, nothing connects: extending this same fixture
   * to 200 ticks adds only a fourth `fire` at 170 and still no `tank-destroyed`. The
   * targets are 10-16 units out and a shell covers 0.1 units a tick, so every shot here
   * is still in flight when the clip ends.
   */
  'ai-retarget': (() => {
    const AI = { x: 0, y: 0 };
    const HELD = { x: 7, y: 8 };
    const CHALLENGER = { x: -12.5, y: 8 };
    const EAST: InputState = { move: { x: 1, y: 0 }, aim: { x: 1000, y: 8 }, fire: false, mine: false };
    return {
      ticks: 140,
      expect: [
        { type: 'fire' as const, tick: 50 },
        { type: 'fire' as const, tick: 90 },
        { type: 'fire' as const, tick: 130 },
      ],
      // Wide on purpose: the mechanic IS distance, so the frame has to hold a tank at 10
      // units and another at 16 at the same time. Centred between the AI and the lane.
      focus: [0.5, 0.3, 4.2], span: 21,
      build: () => {
        const w = createWorld({
          walls: [],
          spawns: [
            { kind: 'brown', pos: { ...AI }, angle: 0 },
            { kind: 'player', pos: { ...HELD }, angle: 0 },
            { kind: 'player', pos: { ...CHALLENGER }, angle: 0 },
          ],
          lives: 9,
          tanks: [
            { id: 1, kind: 'brown', pos: { ...AI }, bodyAngle: 0, turretAngle: 1.0, alive: true,
              desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0, aiState: 'idle', aiTimer: 0 },
            { id: 2, kind: 'player', pos: { ...HELD }, bodyAngle: 0, turretAngle: 0, alive: true,
              desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0, aiState: 'idle', aiTimer: 0 },
            { id: 3, kind: 'player', pos: { ...CHALLENGER }, bodyAngle: 0, turretAngle: 0, alive: true,
              desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0, aiState: 'idle', aiTimer: 0 },
          ],
          seed: 7,
        });
        // Same round-start landmine every other moment here documents.
        w.roundStartTick = -600;
        return w;
      },
      input: () => EAST,
      input2: () => EAST,
    };
  })(),
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
