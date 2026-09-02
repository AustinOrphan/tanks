import type { Tank, Bullet, Blast, Mine, Wall, Spawn, InputState, Vec2 } from './types';
import { angleOf, slewAngle, vsub, isActionLocked } from './types';
import type { SimEvent } from './events';
import { resolveWorldRules, type WorldRules, type WorldRulesInit } from './rules';
import { moveTank, separateTanks, resolveWalls } from './collision';
import { spawnBullet, shellCapReached, stepBullets, resolveBulletHits } from './bullets';
import { dropMine, stepBlasts, stepMines } from './mines';
import { stepAi } from './ai';
import { DT, MINE_COOLDOWN_TICKS, PLAYER_TURRET_TURN_RATE, RESPAWN_DELAY_TICKS, RESPAWN_SHIELD_TICKS } from './constants';
import { configFor, hasAbility, TankAbility } from './config';
import { roundPhase } from './round';
import { pickVersusSpawnCell } from './versus-spawns';

/**
 * One simulated match, as of one tick. Two kinds of field live here, and the split is a
 * contract rather than a tidiness (issue #472):
 *
 *  - `rules` is every POLICY fixed for the world's life -- mode, friendly fire, mine
 *    trigger, AI perception, the corpse/muzzle switches, the coop model, the arena grid.
 *    Resolved once by `resolveWorldRules` (rules.ts) before the world exists, frozen, and
 *    carried through `cloneWorld` as ONE reference, so a rule cannot be individually
 *    forgotten by a copy path the way #471's `aiTargetPerception` was.
 *  - `tick`, `nextId`, `tanks`, `bullets`, `mines`, `blasts`, `walls`, `status`, `lives`
 *    and `roundStartTick` are the mutable snapshot, which `cloneWorld` deep-copies field
 *    by field and a tick's stages write to.
 *  - `seed` and `spawns` are fixed for the world's life too, and deliberately NOT in
 *    `rules`: neither is a policy (`seed` is the entropy key; `spawns` is immutable arena
 *    data that `resetArena` and `stepRespawns` only ever read), and both are required
 *    and typechecked already, so a clone cannot forget them the way it could an optional
 *    rule. `seed` is `readonly` so the claim is enforced the way `rules` is; `spawns`
 *    stays a deep-copied array because moving it is World-shape churn this issue's
 *    boundaries exclude. See WorldRules's own doc comment.
 */
export interface World {
  tick: number;
  nextId: number;
  readonly seed: number;
  /** The immutable match rules. See WorldRules (rules.ts) for every field and its default. */
  readonly rules: WorldRules;
  tanks: Tank[];
  bullets: Bullet[];
  mines: Mine[];
  /** Detonations in flight. Empty except in the ~10 ticks after a mine goes off. */
  blasts: Blast[];
  walls: Wall[];
  spawns: Spawn[];
  status: 'playing' | 'win' | 'lose';
  lives: number;
  // Tick at which the current round (countdown + grace + live) began. Reset by
  // resetArena on every respawn so the opening-phase protection applies after every
  // life lost, not just at game start. See src/sim/round.ts's roundPhase().
  roundStartTick: number;
}

export interface StepResult {
  world: World;
  events: SimEvent[];
}

/**
 * The world-creation boundary. The rule keys of `init` (every `WorldRulesInit` field,
 * all optional) are resolved into `World.rules` HERE, through `resolveWorldRules`, and
 * nowhere later: a `World` this function returns carries a complete, frozen rule set,
 * so no consumer downstream needs a fallback of its own. The init stays flat rather
 * than nesting a `rules:` object so every existing caller -- createWorldFor, the
 * sandbox, the gallery, every test -- keeps its shape.
 */
export function createWorld(init: {
  walls: Wall[];
  tanks: Tank[];
  spawns: Spawn[];
  lives: number;
  seed?: number;
} & WorldRulesInit): World {
  const maxId = Math.max(
    0,
    ...init.walls.map((w) => w.id),
    ...init.tanks.map((t) => t.id),
  );
  return {
    tick: 0,
    nextId: maxId + 1,
    seed: init.seed ?? 1,
    rules: resolveWorldRules(init),
    tanks: init.tanks,
    bullets: [],
    mines: [],
    blasts: [],
    walls: init.walls,
    spawns: init.spawns,
    status: 'playing',
    lives: init.lives,
    // 1, not 0: step() increments `tick` before evaluating the phase, so the
    // first simulated tick is tick 1. Anchoring at 0 cost the countdown a tick.
    roundStartTick: 1,
  };
}

function cloneTank(t: Tank): Tank {
  return {
    ...t,
    pos: { ...t.pos },
    desiredMove: { ...t.desiredMove },
    activeMineIds: [...t.activeMineIds],
    // Deep-copied like pos/desiredMove above, not left to the spread. Nothing mutates a
    // remembered contact in place today -- ai/target-memory.ts always assigns a fresh
    // object -- but every other object field here is copied, and a shallow one would make
    // the first in-place edit alias the memory across every clone of the world.
    ...(t.aiLastSeenPos ? { aiLastSeenPos: { ...t.aiLastSeenPos } } : {}),
  };
}

export function cloneWorld(world: World): World {
  return {
    tick: world.tick,
    nextId: world.nextId,
    seed: world.seed,
    // The rules travel as ONE reference, never re-resolved and never enumerated: the
    // object is frozen (rules.ts), so sharing it across every tick's clone is safe, and a
    // rule added later rides along with no line here to forget. Enumerating them is
    // exactly how #471 lost `aiTargetPerception` -- an optional field, omitted from this
    // list, read back through a `?? 'full'` that made the loss look like the default.
    rules: world.rules,
    status: world.status,
    lives: world.lives,
    roundStartTick: world.roundStartTick,
    tanks: world.tanks.map(cloneTank),
    bullets: world.bullets.map((b) => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } })),
    mines: world.mines.map((m) => ({ ...m, pos: { ...m.pos } })),
    blasts: world.blasts.map((b) => ({ ...b, pos: { ...b.pos } })),
    walls: world.walls.map((w) => ({ ...w, aabb: { ...w.aabb } })),
    spawns: world.spawns.map((s) => ({ ...s, pos: { ...s.pos } })),
  };
}

// Tank-vs-tank separation can shove a tank straight into a wall, and it used to
// run last -- so the buried position was the end-of-tick state: what rendered,
// what bullets tested against, and what the AI read. Three tanks ganging on a
// fourth drove its centre 0.375 units inside a solid block, or 0.366 units
// outside the arena entirely. Alternating the two resolvers converges on a
// position that satisfies both, and the arena ships exactly the four tanks
// needed to reproduce it.
const SEPARATION_PASSES = 3;

export function stepMovement(world: World, dt: number): void {
  for (const tank of world.tanks) {
    if (!tank.alive) continue;
    moveTank(tank, world.walls, dt);
  }
  for (let i = 0; i < SEPARATION_PASSES; i++) {
    separateTanks(world.tanks);
    for (const tank of world.tanks) {
      if (!tank.alive) continue;
      resolveWalls(tank, world.walls);
    }
  }
}

/**
 * Drives ONE named player tank from ONE input. Split out of applyPlayerInput so the
 * multi-input path (applyPlayerInputs) reuses the identical body rather than a second
 * copy of it: the single-player behaviour this function encodes is pinned by the golden
 * trace (tools/baseline/trace.test.ts), and a second copy would not be.
 *
 * The caller decides WHICH tank; nothing here searches for one.
 */
function driveTank(world: World, player: Tank, input: InputState, events: SimEvent[]): void {
  // The player's weapon (bullet type + fire cadence) and abilities come from the
  // same resolved config as every enemy -- no 'normal'/cooldown literals here.
  const pcfg = configFor(player.kind);

  // Round phases (see round.ts): countdown blocks movement entirely (pure orientation --
  // aim only); grace allows movement but still blocks fire/mines; live is unrestricted.
  // Cooldowns keep ticking through both phases regardless (simpler, and harmless since
  // fire/mine are gated below anyway).
  const phase = roundPhase(world);

  // Input crosses the boundary from the impure world (a mouse ray unprojected
  // against the ground plane) into the deterministic core, so it is validated
  // here rather than trusted. A non-finite move writes NaN straight into
  // tank.pos, where nothing can ever clear it.
  const move =
    Number.isFinite(input.move.x) && Number.isFinite(input.move.y)
      ? { x: input.move.x, y: input.move.y }
      : { x: 0, y: 0 };
  player.desiredMove = phase === 'countdown' ? { x: 0, y: 0 } : move;

  // Turret angle ALWAYS updates, even during countdown: aiming is the whole point of
  // that phase (spec: "you can see and aim, but can't shoot or move"). It turns at a
  // finite rate rather than snapping instantly (slewAngle, types.ts) -- see
  // PLAYER_TURRET_TURN_RATE's comment in constants.ts.
  // `!== 0` is true for NaN, so an unlaid-out canvas (screenToGround divides by
  // a zero-width rect) used to slew the turret to NaN permanently.
  const aimDir = vsub(input.aim, player.pos);
  if (Number.isFinite(aimDir.x) && Number.isFinite(aimDir.y) && (aimDir.x !== 0 || aimDir.y !== 0)) {
    player.turretAngle = slewAngle(player.turretAngle, angleOf(aimDir), PLAYER_TURRET_TURN_RATE * DT);
  }

  if (player.fireCooldown > 0) player.fireCooldown -= 1;
  if (player.mineCooldown > 0) player.mineCooldown -= 1;

  // `!isActionLocked` -- spawn protection's fire/mine lockout (types.ts). This is the
  // ONE place every kind==='player' tank's fire/mine input is consumed, human or bot:
  // a bot-claimed slot's InputState (ai/player-profile.ts's decidePlayerInput, wired in
  // game/loop.ts) arrives here through the exact same applyPlayerInputs -> driveTank
  // path a human's does, so gating here covers both without a second gate anywhere
  // else. Deliberately NOT the per-WORLD round countdown/grace (`phase`, just above) --
  // that already blocks every tank uniformly; this is per-TANK, reusing the freshly
  // respawned tank's own shieldUntilTick rather than a second timer. Movement and aim
  // above are untouched: the directive is fire/mine only.
  const canAct = phase === 'live' && !isActionLocked(player, world.tick);

  if (canAct && input.fire && player.fireCooldown <= 0) {
    // A SHOT REFUSED BY THE SHELL CAP COSTS THE COOLDOWN ANYWAY (issue #356).
    //
    // Two things follow from it, and the second is the reason. Mechanically, a refusal used
    // to leave the cooldown at zero, so holding the trigger at the cap re-attempted every
    // tick: the `fire-blocked` cue could fire 60 times a second against a real shot's 2.5
    // (`cooldownSeconds` 0.4), and any cue attached to it needed a rate limiter of its own.
    // Now a refusal is paced by the same clock a real shot is, so it cannot outrun one.
    //
    // And it gives the rule teeth: spraying while every shell is still in the air now costs
    // the same beat a real shot costs, so paying attention to how many you have out there is
    // worth something. That is a deliberate, small punishment, not an accident of the fix.
    //
    // Only the CAP refusal pays. A shot held because a teammate crossed the lane, because the
    // round has not started, or because the tank is dead is not the shooter's doing, and
    // `dispatch.test.ts` still pins that those leave the cooldown alone.
    const fired = spawnBullet(world, player.id, player.turretAngle, pcfg.weapon.bulletType, events);
    if (fired || shellCapReached(world, player.id)) {
      player.fireCooldown = pcfg.weapon.fireCooldown;
    }
  }

  if (canAct && input.mine && hasAbility(player.kind, TankAbility.MINE_LAYER) && player.mineCooldown <= 0) {
    if (dropMine(world, player.id, events)) {
      player.mineCooldown = MINE_COOLDOWN_TICKS;
    }
  }
}

/**
 * Applies one input per human-controlled tank, pairing `inputs[i]` with the i-th
 * `kind === 'player'` tank in TANK-ARRAY ORDER.
 *
 * Three rules, each with a test in step-inputs.test.ts, because each is a decision and
 * not a consequence:
 *
 *  - The pairing indexes over EVERY player tank, alive or not. A dead player still
 *    consumes its slot, so one player dying cannot shift another player's input onto a
 *    different tank mid-round. (Filtering to the living first would do exactly that.)
 *  - Surplus inputs are ignored, and players past the end of the list get no input at
 *    all -- not a synthesised idle one. Those differ: an idle input still decrements
 *    cooldowns and still slews the turret toward `aim`.
 *  - Order comes from `world.tanks`, which loadArena builds from `world.spawns` in grid
 *    order and never reorders (see resetArena's comment) -- so slot i is stable for the
 *    whole game, which is what makes a recorded input list replayable.
 *
 * With one player and one input this is exactly what applyPlayerInput did, and the
 * golden trace (tools/baseline/trace.test.ts) is what proves it.
 */
export function applyPlayerInputs(world: World, inputs: InputState[], events: SimEvent[]): void {
  const players = world.tanks.filter((t) => t.kind === 'player');
  const n = Math.min(players.length, inputs.length);
  for (let i = 0; i < n; i++) {
    const player = players[i];
    if (!player.alive) continue;
    driveTank(world, player, inputs[i], events);
  }
}

/**
 * The one-player form: drives the FIRST player tank. Kept because it is what every
 * caller in the tree means, and because `stepInputs` reaching it through a
 * one-element list is the whole argument that the list refactor changed nothing.
 */
export function applyPlayerInput(world: World, input: InputState, events: SimEvent[]): void {
  const player = world.tanks.find((t) => t.kind === 'player');
  if (!player || !player.alive) return;
  driveTank(world, player, input, events);
}

/**
 * How many `kind === 'player'` tanks the world holds -- the coop discriminator, used
 * exactly two places: resolveStatus's guard and stepInputs' gate for stepRespawns. A
 * pure derivation off world.tanks, not a stored field, matching the established
 * convention (replayMetaFor derives playerCount the same way) -- it cannot desync
 * from the tank array because there is nothing to desync from.
 */
export function countPlayerTanks(world: World): number {
  return world.tanks.filter((t) => t.kind === 'player').length;
}

/**
 * Where a reviving player tank reappears.
 *
 * Campaign-coop keeps EXACTLY today's behaviour -- the tank's own authored
 * world.spawns[i] position, a fresh copy -- which is what keeps coop-respawn.test.ts's
 * pins byte-for-byte and is why this returns a plain object rather than the stored
 * Vec2 itself (aliasing world.spawns[i].pos would let a later mutation of the revived
 * tank's own `pos` corrupt the world's spawn table).
 *
 * Versus modes (ffa/teams) instead ask pickVersusSpawnCell (versus-spawns.ts) for the
 * cell farthest, by that function's own greedy-maximin/line-of-sight ranking, from
 * every currently LIVING tank -- "the most isolated/safest spawn point" per the
 * directive this implements. That ranking is a documented APPROXIMATION of true
 * p-dispersion, not an optimum (see pickVersusSpawnCell's own doc comment); this
 * function does not claim otherwise. Falls back to the tank's own authored spawn --
 * campaign-coop's behaviour -- when world.rules.arenaGeometry is null: most of this
 * file's own test fixtures (and sandbox.ts's dev worlds) build a World from raw
 * tanks/walls/spawns with no grid behind it, so there is nothing for
 * pickVersusSpawnCell to search. Total, no-throw degradation, the same posture
 * pickVersusSpawnCell's own zero-candidate fallback already takes.
 */
function respawnPos(world: World, tankIndex: number): Vec2 {
  const authored = world.spawns[tankIndex].pos;
  const { mode, arenaGeometry } = world.rules;
  if (mode === 'campaign-coop' || arenaGeometry === null) return { x: authored.x, y: authored.y };
  const avoid: Vec2[] = world.tanks.filter((t) => t.alive).map((t) => ({ x: t.pos.x, y: t.pos.y }));
  const { cols, rows, cellSize, grid, legend } = arenaGeometry;
  const cell = pickVersusSpawnCell(grid, cols, rows, cellSize, legend, avoid);
  return { x: (cell.col + 0.5) * cellSize, y: (cell.row + 0.5) * cellSize };
}

/**
 * Revives any player tank whose respawnAtTick has arrived. Per-tank, deliberately a
 * SHORTER field list than resetArena's -- see the coop semantics plan
 * (docs/superpowers/plans/2026-08-15-coop-semantics.md) for the "hard problem" this
 * exists to solve: resetArena is whole-board (repositions every tank, restores every
 * wall, clears world-level bullets/mines/blasts) and would erase a live partner's
 * fight. This touches only the reviving tank.
 *
 * Deliberately does NOT touch activeMineIds, and does NOT clear world.mines/
 * world.bullets/world.blasts -- resetArena clears mines board-wide and zeroes every
 * tank's activeMineIds together, as one atomic reset; doing that here while the
 * tank's own mines are still live in world.mines would desync the count dropMine's
 * cap check reads, letting the revived tank exceed its mine cap.
 *
 * WHERE it reappears is respawnPos's decision (above) -- campaign-coop's own
 * world.spawns[i], or, in ffa/teams, a cell pickVersusSpawnCell picks fresh on every
 * call, scored against whichever OTHER tanks are alive at that exact moment. Processing
 * `world.tanks` in array order and mutating `t.alive` in place (below) means that if two
 * tanks revive on the SAME tick, the second one's pick already sees the first one as
 * alive and avoids it -- no extra bookkeeping needed for that case. Facing angle stays
 * `s.angle` in every mode (arena.ts stamps 0 for every ffa/teams spawn, same as initial
 * placement, so there is no separate "safe facing" decision to make here).
 *
 * Called from stepInputs, gated on countPlayerTanks(draft) >= 2 in campaign-coop, or
 * unconditionally in ffa/teams -- see that gate's own comment for why it runs BEFORE
 * applyPlayerInputs. No internal mode/player-count gate of its own: that is stepInputs'
 * job, matching resolveStatus's guard-first split one level up (pinned directly in
 * coop-respawn.test.ts and versus-modes.test.ts).
 */
export function stepRespawns(world: World, events: SimEvent[]): void {
  for (let i = 0; i < world.tanks.length; i++) {
    const t = world.tanks[i];
    if (t.kind !== 'player' || t.alive) continue;
    if (t.respawnAtTick === undefined || world.tick < t.respawnAtTick) continue;
    const s = world.spawns[i];
    t.pos = respawnPos(world, i);
    t.bodyAngle = s.angle;
    t.turretAngle = s.angle;
    t.turretVel = undefined; // same reason as resetArena below (issue #347)
    t.alive = true;
    t.desiredMove = { x: 0, y: 0 };
    t.fireCooldown = 0;
    t.mineCooldown = 0;
    t.aiState = 'idle';
    t.aiTimer = 0;
    t.aimTicks = 0;
    t.respawnAtTick = undefined;
    // Set only at the moment of revival, no explicit clear -- self-expires by
    // comparison in isDamageImmune/isActionLocked (types.ts), the same idiom
    // roundPhase's own elapsed-based checks already use. isActionLocked is what makes
    // this ALSO a fire/mine lockout in versus, not merely a damage shield.
    t.shieldUntilTick = world.tick + RESPAWN_SHIELD_TICKS;
    events.push({ type: 'respawn', tankId: t.id, controlledBy: t.controlledBy ?? 0, pos: { x: t.pos.x, y: t.pos.y } });
  }
}

// A life loss restarts the WHOLE arena (spec §4: "restart arena on death"): every
// tank returns to its spawn alive, destroyed walls come back, and all bullets/mines
// clear. Relies on the loadArena invariant that world.tanks[i] was built from
// world.spawns[i] — tanks are never removed or reordered (dead tanks stay in place
// with alive=false), so that index alignment holds for the whole game.
function resetArena(world: World): void {
  // Restart the round's opening phases too: without this, countdown/grace only ever
  // apply once at game start, and a respawned player is exposed to full-strength AI
  // fire the instant the new life begins -- the same sniping bug this feature exists
  // to fix, just relocated to every respawn instead of only tick 0.
  world.roundStartTick = world.tick + 1; // the next tick step() will simulate
  for (let i = 0; i < world.tanks.length; i++) {
    const t = world.tanks[i];
    const s = world.spawns[i];
    t.pos = { ...s.pos };
    t.bodyAngle = s.angle;
    t.turretAngle = s.angle;
    // Angular momentum does not survive the round (issue #347). The line above snaps the
    // turret to its spawn angle; leaving the velocity behind would open the new round with
    // a gun already swinging, which accelSlew then has to brake before it can track.
    t.turretVel = undefined; // round restart (issue #347)
    t.alive = true;
    t.desiredMove = { x: 0, y: 0 };
    t.activeMineIds = [];
    t.fireCooldown = 0;
    t.mineCooldown = 0;
    t.aiState = 'idle';
    t.aiTimer = 0;
    t.aimTicks = 0;
  }
  for (const w of world.walls) w.destroyed = false;
  world.bullets = [];
  world.mines = [];
  // A blast outlives the tick it started on, so unlike every other hazard here it can
  // still be lethal when the next life begins. Leaving it behind respawned the player
  // inside the explosion that had just killed him and burned every remaining life in
  // the ~10 ticks before it faded.
  world.blasts = [];
}

/**
 * Coop's win/lose rule, split on `world.rules.coopAttempts` into two entirely separate
 * bodies. Both share the same ~4-line win check up front (duplicated from the 1P body
 * below rather than shared, which is what keeps THAT body a literal byte-for-byte
 * no-diff) -- win is decided ahead of either branch's death handling, and holds
 * whether or not lives remain, exactly like 1P.
 *
 * `world.rules.coopAttempts` TRUE (the default): the shared-attempts ruling (owner,
 * 2026-08-16 -- "lives are more like shared attempts. If all players in co op die,
 * then a life/attempt is lost. If one player dies, the remaining can continue on and
 * if they clear the level, all players spawn in on the next level.") See the
 * ATTEMPTS MODE block below.
 *
 * `world.rules.coopAttempts` FALSE (`?dev=1&coopPool=1`): the shipped POOL model this
 * replaces as default -- see docs/superpowers/plans/2026-08-15-coop-semantics.md.
 * The POOL MODE block below is that plan's `resolveStatusCoop` body, byte-untouched.
 */
function resolveStatusCoop(world: World, events: SimEvent[]): void {
  const enemies = world.tanks.filter((t) => t.kind !== 'player');
  const allEnemiesDead = enemies.length > 0 && enemies.every((e) => !e.alive);
  // A mutual kill is a win, decided ahead of any death handling below, exactly like
  // the 1P body -- it holds whether or not lives remain.
  if (allEnemiesDead) {
    world.status = 'win';
    events.push({ type: 'win' });
    return;
  }

  if (!world.rules.coopAttempts) {
    // POOL MODE -- docs/superpowers/plans/2026-08-15-coop-semantics.md, shipped
    // default before the shared-attempts ruling, now behind `?dev=1&coopPool=1`.
    // Byte-untouched from that plan's implementation: a SHARED life pool, drained per
    // player death (not per-round like 1P's resetArena call -- resetArena itself is
    // wrong here, since it would erase a live partner's fight).
    //
    // Adopted default 3's refinement, walked through against simultaneous deaths: two
    // players dying the SAME tick are processed in event order, so at pool 2 the first
    // decrement (2 -> 1) schedules a respawn and the second (1 -> 0) does not -- one
    // partner revives in RESPAWN_DELAY_TICKS, the other stays down for the rest of the
    // round. At pool 1 both decrements land on 0 and neither schedules: a shared pool of
    // 1 genuinely cannot survive two simultaneous deaths.
    //
    // `pendingRespawn` (not just `world.lives > 0`) is the second half of the lose guard
    // because a tank can carry a respawn scheduled on an EARLIER tick while the pool
    // drops to 0 from a DIFFERENT, LATER death -- that scheduled respawn was already
    // paid for and must be honored; checking the pool alone would call `lose` mid-window.
    for (const e of events) {
      if (e.type !== 'tank-destroyed' || e.kind !== 'player') continue;
      const tank = world.tanks.find((t) => t.id === e.tankId);
      // respawnAtTick !== undefined: this tank's death was already tallied (a corpse
      // waiting on its scheduled tick cannot be tallied a second time).
      if (!tank || tank.respawnAtTick !== undefined) continue;
      world.lives = Math.max(0, world.lives - 1);
      if (world.lives > 0) tank.respawnAtTick = world.tick + RESPAWN_DELAY_TICKS;
    }
    const players = world.tanks.filter((t) => t.kind === 'player');
    const noneStanding = players.every((t) => !t.alive);
    const pendingRespawn = players.some((t) => t.respawnAtTick !== undefined);
    if (noneStanding && !pendingRespawn) {
      world.status = 'lose';
      events.push({ type: 'lose' });
    }
    return;
  }

  // ATTEMPTS MODE (default) -- the shared-attempts ruling. State-based, not
  // event-based, deliberately mirroring the 1P body's own `if (player && !player.alive)`
  // shape one level up rather than pool mode's per-event tally immediately above: a
  // single player's death costs nothing on its own (no lives decrement, no
  // respawnAtTick -- the corpse simply stays down and the survivor fights on), so
  // there is nothing here for an individual death EVENT to drive. Only the STATE "is
  // anyone still standing" matters, and it is checked fresh on every call.
  //
  // No idempotency guard is needed the way pool mode's `respawnAtTick !== undefined`
  // is: the moment `noneStanding` goes true, this function resolves it SYNCHRONOUSLY,
  // in the same call -- either resetArena revives every tank before returning (so
  // `noneStanding` is false again by the very next call), or `world.status` leaves
  // 'playing' entirely (so resolveStatus's own top-of-function guard skips this
  // function on every later call). Neither leaves a window where the same wipe could
  // be counted twice.
  const players = world.tanks.filter((t) => t.kind === 'player');
  const noneStanding = players.length > 0 && players.every((t) => !t.alive);
  if (!noneStanding) return; // a survivor is still up -- no decrement, no respawn
  world.lives = Math.max(0, world.lives - 1);
  if (world.lives > 0) {
    // Nobody is left standing: there is no partner's board left to protect, so this
    // is exactly the single-player death experience, generalized -- resetArena
    // revives every tank (players AND enemies), restores every wall, clears
    // bullets/mines/blasts, and re-arms the round's countdown/grace for everyone.
    resetArena(world);
  } else {
    world.status = 'lose';
    events.push({ type: 'lose' });
  }
}

/**
 * A versus player-kind tank is ELIMINATED -- out for the rest of the round, no more
 * respawns coming -- exactly when it is currently dead AND has no stock left. This is
 * NOT the same question `!t.alive` answers: a player awaiting a scheduled respawn
 * (stock > 0, respawnAtTick set by applyVersusStock below) is dead right now but is
 * very much still IN the match. Getting this distinction wrong is the specific failure
 * named for this feature: counting bare `alive` here ends a stock match on the very
 * first death, stock or no stock -- versus-modes.test.ts's
 * "a mid-stock death must not end the match" tests exist to catch exactly that.
 *
 * `?? 0`: a hand-built Tank fixture that never sets stockRemaining reads as already at
 * zero -- i.e. today's pre-stock single-life behaviour, unchanged for every existing
 * test that does not opt into the field. Real ffa/teams play always sets it (loadArena
 * stamps VERSUS_STOCK on every player-kind tank in those modes).
 */
export function isVersusEliminated(t: Tank): boolean {
  return !t.alive && (t.stockRemaining ?? 0) === 0;
}

/**
 * Versus's stock bookkeeping: for every player-kind death THIS tick, decrement the
 * dying tank's own stock and, if any remains, schedule its respawn. Same event-tally
 * shape resolveStatusCoop's POOL MODE block above already uses -- `tank-destroyed`
 * events, idempotency-guarded on `respawnAtTick !== undefined` so a corpse already
 * tallied (waiting on an earlier-scheduled respawn) is never charged twice for the same
 * death. Runs before either resolveStatusFfa or resolveStatusTeams counts who remains,
 * so a stock-exhausted death is reflected in THIS SAME tick's elimination count --
 * exactly what lets a mutual last-stock kill still resolve to 'lose' immediately below,
 * matching the pre-existing simultaneous-wipe behaviour (a named gap, not fixed here).
 *
 * Reuses RESPAWN_DELAY_TICKS rather than a second delay constant: versus's respawn
 * timing is not a new feel value, it is coop's own.
 */
function applyVersusStock(world: World, events: SimEvent[]): void {
  for (const e of events) {
    if (e.type !== 'tank-destroyed' || e.kind !== 'player') continue;
    const tank = world.tanks.find((t) => t.id === e.tankId);
    if (!tank || tank.respawnAtTick !== undefined) continue;
    tank.stockRemaining = Math.max(0, (tank.stockRemaining ?? 0) - 1);
    if (tank.stockRemaining > 0) tank.respawnAtTick = world.tick + RESPAWN_DELAY_TICKS;
  }
}

/**
 * FFA's win rule (n-player arc PR 4, extended by the stock PR): exactly one player tank
 * NOT ELIMINATED, every other player tank eliminated -- see isVersusEliminated's own
 * doc comment for why that is "not eliminated", not "alive". Stock bookkeeping
 * (applyVersusStock) runs first, every call, so a death that still has respawns coming
 * never counts as an elimination.
 *
 * A simultaneous final wipeout (the last two players trade a last-stock kill the same
 * tick) leaves ZERO non-eliminated, which fails "exactly one remains" -- resolves to
 * 'lose', not a third status. Deliberately no `'draw'`: growing `World.status`'s
 * 3-value union touches game/state.ts, HUD copy and achievements gating, real
 * separately-scoped surface no owner directive asked for -- named residual, not a
 * silent gap. This is the SAME named gap resolveStatusFfa always had; the stock PR
 * does not touch it, only what "wipeout" means before that fires.
 */
function resolveStatusFfa(world: World, events: SimEvent[]): void {
  applyVersusStock(world, events);
  const players = world.tanks.filter((t) => t.kind === 'player');
  const remaining = players.filter((t) => !isVersusEliminated(t));
  if (remaining.length === 1) {
    world.status = 'win';
    events.push({ type: 'win' });
  } else if (remaining.length === 0) {
    world.status = 'lose';
    events.push({ type: 'lose' });
  }
}

/**
 * Teams' win rule (n-player arc PR 4, extended by the stock PR): one team's players are
 * all ELIMINATED, the other team has a non-eliminated survivor. `Tank.team` is
 * `teamOf(slot) = slot % 2` (arena.ts), stamped only when `mode === 'teams'`, so every
 * player tank here carries one. Same stock-then-eliminated shape as resolveStatusFfa --
 * see its own doc comment, including the unfixed simultaneous-wipe gap.
 *
 * A simultaneous wipeout of BOTH teams' last stock the same tick leaves neither with a
 * survivor, which is neither team's win -- resolves to 'lose', matching FFA's own
 * simultaneous case rather than inventing a second rule for it.
 */
function resolveStatusTeams(world: World, events: SimEvent[]): void {
  applyVersusStock(world, events);
  const players = world.tanks.filter((t) => t.kind === 'player');
  const teamsRemaining = new Set(players.filter((t) => !isVersusEliminated(t)).map((t) => t.team));
  if (teamsRemaining.size === 1) {
    world.status = 'win';
    events.push({ type: 'win' });
  } else if (teamsRemaining.size === 0) {
    world.status = 'lose';
    events.push({ type: 'lose' });
  }
}

export function resolveStatus(world: World, events: SimEvent[]): void {
  // step() latches on status, but the export is called directly by tests and by
  // anything embedding the sim. Without this guard a second call on a won world
  // pushes a second `win` -- and a second victory stinger.
  if (world.status !== 'playing') return;

  // n-player arc PR 4: a mode dispatch, generalizing the coop guard-first split above
  // (see resolveStatusCoop's own doc comment) a fourth way. 'campaign-coop' falls
  // through to the ORIGINAL body below, byte-untouched -- this switch's whole job is to
  // route around it, never to alter it -- which is the entire trace argument: `mode`
  // defaults to 'campaign-coop' at every call site that does not pass one (including
  // tools/baseline/trace.ts's), so BASELINE_HASH is unmoved by this PR (confirmed
  // empirically, not merely argued -- see tools/baseline/trace.test.ts).
  if (world.rules.mode === 'ffa') {
    resolveStatusFfa(world, events);
    return;
  }
  if (world.rules.mode === 'teams') {
    resolveStatusTeams(world, events);
    return;
  }

  // Two or more player-kind tanks: coop semantics, entirely separate machinery
  // (resolveStatusCoop above) -- shared ATTEMPTS by default since the 2026-08-16
  // ruling (docs/superpowers/plans/2026-08-16-coop-attempts.md), with the original
  // shared-pool model behind ?dev=1&coopPool=1 (the 2026-08-15 plan, which answered
  // docs/research/multiplayer.md's open question 3). Returns unconditionally, so
  // nothing below this line ever runs at playerCount >= 2 -- everything below is
  // today's 1P body, byte-for-byte, unmodified (pinned in coop-respawn.test.ts and by
  // tools/baseline/trace.test.ts's BASELINE_HASH, which drives exactly one player and
  // cannot see this branch at all).
  if (countPlayerTanks(world) >= 2) {
    resolveStatusCoop(world, events);
    return;
  }

  // `.find` takes the FIRST player-kind tank -- correct-as-P1, deliberately not
  // generalised here. At playerCount > 1 a second player-kind tank exists and its
  // life/death is invisible to this function entirely: only P1's death drains
  // `world.lives`, and a co-op teammate dying neither costs a life nor can end the
  // round. What win/lose MEAN in co-op (shared lives? does a survivor play on?) is
  // a product decision, not a bug fix -- see docs/research/multiplayer.md's open
  // question 3, "Write the rule down before touching resolveStatus".
  const player = world.tanks.find((t) => t.kind === 'player');
  const enemies = world.tanks.filter((t) => t.kind !== 'player');
  // Snapshot BEFORE resetArena, which revives every tank. Reading it afterwards
  // meant a player who traded their last kill for a life saw the win silently
  // discarded, a life deducted, and the whole arena reset instead.
  const allEnemiesDead = enemies.length > 0 && enemies.every((e) => !e.alive);

  // A mutual kill is a win: the player cleared the arena. This is decided ahead
  // of the death branch so it holds whether or not lives remain.
  if (allEnemiesDead) {
    world.status = 'win';
    events.push({ type: 'win' });
    return;
  }

  if (player && !player.alive) {
    world.lives -= 1;
    if (world.lives > 0) {
      resetArena(world);
    } else {
      world.status = 'lose';
      events.push({ type: 'lose' });
    }
  }
}

/**
 * Advances the world one tick from a LIST of inputs -- one per human-controlled tank,
 * paired by position (see applyPlayerInputs). This is the primitive; `step` below is the
 * one-argument adapter every caller in the tree still uses.
 *
 * Two names rather than one overloaded `step(world, input | inputs)`: a union parameter
 * would put an `Array.isArray` branch in the pure core's hot path and would let a caller
 * silently pass the wrong shape at a call site that still typechecks. Nothing here is
 * multiplayer -- no second player spawn, no win/lose rule for one (config/validate.ts
 * still hard-fails any grid without exactly one `P`). It is only the seam.
 */
export function stepInputs(world: World, inputs: InputState[]): StepResult {
  const draft = cloneWorld(world);
  draft.tick += 1;
  const events: SimEvent[] = [];

  if (draft.status === 'playing') {
    // BEFORE applyPlayerInputs, every mode: a tank that crosses its revival tick gets
    // that same tick's input rather than sitting inert one extra frame -- a deliberate
    // improvement on resetArena's incidental one-tick lag. At campaign-coop N < 2 the
    // whole expression always evaluates but is always false -- a value-identical no-op
    // (cheap booleans, touches nothing when false), not a "never even called"
    // structural no-op; see tools/baseline/trace.test.ts's comment on why the golden
    // trace cannot distinguish the two.
    //
    // Two independent conditions, not one shared gate: campaign-coop keeps its original
    // player-count guard (only resolveStatusCoop's POOL MODE ever sets respawnAtTick
    // there, and only once a second player exists); ffa/teams have no such guard because
    // the stock PR's applyVersusStock (resolveStatusFfa/resolveStatusTeams, above) can
    // schedule a respawn at any player count. `mode === 'campaign-coop' &&` on the first
    // arm still exists to make the mode boundary legible at every place it is checked,
    // not only inside resolveStatus -- see the arc design.
    if (
      draft.rules.mode === 'ffa' ||
      draft.rules.mode === 'teams' ||
      (draft.rules.mode === 'campaign-coop' && countPlayerTanks(draft) >= 2)
    ) {
      stepRespawns(draft, events);
    }
    applyPlayerInputs(draft, inputs, events);
    stepAi(draft, events);
    stepBlasts(draft, events);
    stepMovement(draft, DT);
    stepBullets(draft, DT, events);
    resolveBulletHits(draft, events);
    stepMines(draft, DT, events);
    resolveStatus(draft, events);
  }

  return { world: draft, events };
}

/**
 * One tick from one player's input: the shipped game's shape, and every caller in the
 * tree today (game/driver.ts, the gallery and every test).
 *
 * It is an ADAPTER, not a second implementation -- `[input]` and nothing else. That is
 * deliberate: it means the single-player behaviour cannot drift from the list path, and
 * it is why the golden trace hash in tools/baseline/trace.test.ts is unchanged by this
 * refactor. If this ever grows a branch of its own, that argument is gone.
 */
export function step(world: World, input: InputState): StepResult {
  return stepInputs(world, [input]);
}
