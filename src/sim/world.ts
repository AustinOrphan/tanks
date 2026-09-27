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
 * The field split is a contract (issue #472). `rules` holds every policy fixed for the
 * world's life: resolved once, frozen, and passed through `cloneWorld` as one reference,
 * so no copy path can forget an individual rule. `seed` and `spawns` are fixed too but
 * are not policy, and as required fields a clone cannot drop them the way it could an
 * optional rule. `spawns` is only ever read (by resetArena and stepRespawns) yet, unlike
 * `seed`, is not `readonly` but deep-copied: moving it was outside #472's scope.
 * Everything else is the mutable snapshot a tick's stages write to.
 */
export interface World {
  tick: number;
  nextId: number;
  readonly seed: number;
  readonly rules: WorldRules;
  tanks: Tank[];
  bullets: Bullet[];
  mines: Mine[];
  blasts: Blast[];
  walls: Wall[];
  spawns: Spawn[];
  status: 'playing' | 'win' | 'lose';
  lives: number;
  roundStartTick: number;
}

export interface StepResult {
  world: World;
  events: SimEvent[];
}

/**
 * Rules are resolved here and nowhere later, so no consumer downstream needs a fallback
 * of its own. `init` stays flat rather than nesting a `rules:` object so every existing
 * caller (createWorldFor, the sandbox, the gallery, every test) keeps its shape.
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
    // first simulated tick is tick 1. Anchoring at 0 would cost the countdown a tick.
    roundStartTick: 1,
  };
}

function cloneTank(t: Tank): Tank {
  return {
    ...t,
    pos: { ...t.pos },
    desiredMove: { ...t.desiredMove },
    activeMineIds: [...t.activeMineIds],
    // Nothing edits this in place today (ai/target-memory.ts assigns a fresh object), but a
    // shallow copy would make the first in-place edit alias it across every clone.
    ...(t.aiLastSeenPos ? { aiLastSeenPos: { ...t.aiLastSeenPos } } : {}),
  };
}

export function cloneWorld(world: World): World {
  return {
    tick: world.tick,
    nextId: world.nextId,
    seed: world.seed,
    // One reference, never re-resolved or enumerated: the object is frozen (rules.ts), so
    // sharing it is safe, and a rule added later needs no line here. Enumerating is how
    // #471 lost `aiTargetPerception`, read back through a `?? 'full'` that looked like the
    // default.
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

// Tank-vs-tank separation can shove a tank straight into a wall. Run once, last,
// the buried position would be the end-of-tick state: what rendered, what
// bullets tested against, and what the AI read. Three tanks ganging on a
// fourth drove its centre 0.375 units inside a solid block, or 0.366 units
// outside the arena entirely. Alternating the two resolvers converges on a
// position that satisfies both.
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
 * Shared by applyPlayerInput and applyPlayerInputs so the golden trace
 * (tools/baseline/trace.test.ts) pins the one copy both use.
 */
function driveTank(world: World, player: Tank, input: InputState, events: SimEvent[]): void {
  const pcfg = configFor(player.kind);

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

  // Aim updates in every phase: aiming is the countdown's whole point (spec: "you can see
  // and aim, but can't shoot or move").
  // `!== 0` is true for NaN, so without the finiteness checks an unlaid-out canvas
  // (screenToGround divides by a zero-width rect) would slew the turret to NaN permanently.
  const aimDir = vsub(input.aim, player.pos);
  if (Number.isFinite(aimDir.x) && Number.isFinite(aimDir.y) && (aimDir.x !== 0 || aimDir.y !== 0)) {
    player.turretAngle = slewAngle(player.turretAngle, angleOf(aimDir), PLAYER_TURRET_TURN_RATE * DT);
  }

  if (player.fireCooldown > 0) player.fireCooldown -= 1;
  if (player.mineCooldown > 0) player.mineCooldown -= 1;

  // Spawn protection locks fire and mines only, never movement or aim. A bot-claimed
  // slot's input (ai/player-profile.ts's decidePlayerInput) reaches here through the same
  // applyPlayerInputs path a human's does, so this one gate covers both.
  const canAct = phase === 'live' && !isActionLocked(player, world.tick);

  if (canAct && input.fire && player.fireCooldown <= 0) {
    // A shot refused by the shell cap still costs the cooldown (issue #356). Uncharged, a
    // trigger held at the cap would retry every tick and fire the `fire-blocked` cue 60
    // times a second; charged, a refusal is paced like a real shot. It is also a deliberate
    // small punishment for spraying with every shell in the air. No other refusal pays: it
    // is not the shooter's doing. Pinned in cap-refusal-cooldown.test.ts.
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
 * Three decisions, each pinned in step-inputs.test.ts:
 *
 *  - A dead player keeps its slot, so one player dying cannot shift another player's
 *    input onto a different tank mid-round.
 *  - Players past the end of `inputs` get no input, not a synthesised idle one: an idle
 *    input still decrements cooldowns and slews the turret toward `aim`.
 *  - Slot order is `world.tanks` order, which nothing reorders (see resetArena), so a
 *    recorded input list replays.
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

/** Called by tests only; `stepInputs` goes through applyPlayerInputs. */
export function applyPlayerInput(world: World, input: InputState, events: SimEvent[]): void {
  const player = world.tanks.find((t) => t.kind === 'player');
  if (!player || !player.alive) return;
  driveTank(world, player, input, events);
}

export function countPlayerTanks(world: World): number {
  return world.tanks.filter((t) => t.kind === 'player').length;
}

/**
 * The authored spawn is returned as a copy: aliasing world.spawns[i].pos would let a
 * later mutation of the revived tank's `pos` corrupt the spawn table. A null
 * arenaGeometry is not an error: most of this file's test fixtures and sandbox.ts's dev
 * worlds build a World with no grid behind it, leaving pickVersusSpawnCell nothing to
 * search.
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
 * Touches only the reviving tank: resetArena is whole-board and would erase a live
 * partner's fight. It leaves activeMineIds alone: resetArena zeroes it only together with
 * world.mines, and zeroing it here while the tank's mines are still live would let it
 * exceed dropMine's cap.
 *
 * Tanks revive in array order with `t.alive` set in place, so a second tank reviving on
 * the same tick already avoids the first. Facing stays `s.angle`: arena.ts stamps 0 on
 * every ffa/teams spawn anyway.
 *
 * The mode and player-count gate is the caller's (stepInputs).
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
    t.shieldUntilTick = world.tick + RESPAWN_SHIELD_TICKS;
    events.push({ type: 'respawn', tankId: t.id, controlledBy: t.controlledBy ?? 0, pos: { x: t.pos.x, y: t.pos.y } });
  }
}

// Relies on the loadArena invariant that world.tanks[i] was built from world.spawns[i]:
// tanks are never removed or reordered (dead tanks stay in place with alive=false).
function resetArena(world: World): void {
  // Restart the round's opening phases too: without this, countdown/grace only ever
  // apply once at game start, and a respawned player is exposed to full-strength AI
  // fire the instant the new life begins.
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
 * The win check is duplicated from the 1P body in resolveStatus rather than shared, so
 * that body -- the golden trace's path -- stays untouched.
 *
 * `coopAttempts` true (the default) is the owner's shared-attempts ruling (2026-08-16):
 * "If all players in co op die, then a life/attempt is lost. If one player dies, the
 * remaining can continue on ...". False (`?dev=1&coopPool=1`) is the shared life pool of
 * docs/superpowers/plans/2026-08-15-coop-semantics.md.
 */
function resolveStatusCoop(world: World, events: SimEvent[]): void {
  const enemies = world.tanks.filter((t) => t.kind !== 'player');
  const allEnemiesDead = enemies.length > 0 && enemies.every((e) => !e.alive);
  // A mutual kill is a win, so this runs before any death handling.
  if (allEnemiesDead) {
    world.status = 'win';
    events.push({ type: 'win' });
    return;
  }

  if (!world.rules.coopAttempts) {
    // Pool mode: drained per player death, with no resetArena, which would erase a live
    // partner's fight.
    //
    // Simultaneous deaths (the plan's adopted default 3) are processed in event order: at
    // pool 2 the first decrement schedules a respawn and the second does not, so one
    // partner stays down for the round; at pool 1 neither schedules.
    //
    // `pendingRespawn` is half the lose guard because a respawn scheduled on an earlier
    // tick was already paid for; checking the pool alone would call `lose` mid-window.
    for (const e of events) {
      if (e.type !== 'tank-destroyed' || e.kind !== 'player') continue;
      const tank = world.tanks.find((t) => t.id === e.tankId);
      // A corpse already waiting on a respawn has been tallied.
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

  // Attempts mode: state-based rather than a per-event tally, because one player's death
  // costs nothing on its own; the corpse stays down and the survivor fights on.
  //
  // No idempotency guard is needed: a wipe is resolved in this same call, either by
  // resetArena reviving every tank or by `status` leaving 'playing' (which resolveStatus's
  // first guard then skips), so the same wipe cannot be counted twice.
  const players = world.tanks.filter((t) => t.kind === 'player');
  const noneStanding = players.length > 0 && players.every((t) => !t.alive);
  if (!noneStanding) return;
  world.lives = Math.max(0, world.lives - 1);
  if (world.lives > 0) {
    // No partner's fight is left to protect, so the whole-arena reset is right here.
    resetArena(world);
  } else {
    world.status = 'lose';
    events.push({ type: 'lose' });
  }
}

/**
 * Not the same as `!t.alive`: a player awaiting a scheduled respawn is dead but still in
 * the match, and counting bare `alive` would end a stock match on the first death
 * (versus-modes.test.ts, "a mid-stock death does not end the match").
 *
 * An unset stockRemaining reads as 0, single-life. Real ffa/teams play never leaves it
 * unset: loadArena stamps a stock on every player tank in those modes.
 */
export function isVersusEliminated(t: Tank): boolean {
  return !t.alive && (t.stockRemaining ?? 0) === 0;
}

/**
 * A corpse already waiting on a respawn is not charged twice. Runs before the ffa/teams
 * counts, so a last-stock death is an elimination on the same tick. The delay is coop's
 * RESPAWN_DELAY_TICKS on purpose, not a new feel value.
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
 * A simultaneous final wipeout (the last two players trade a last-stock kill) resolves
 * to 'lose'. Deliberately no 'draw': growing `World.status` touches game/state.ts, HUD
 * copy and achievements gating, which no owner directive asked for.
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
 * arena.ts stamps `Tank.team` on every player tank in teams mode, so each one here has a
 * team. A simultaneous wipe of both teams' last stock resolves to 'lose', as in FFA.
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

  // The versus modes route around the campaign body below, never alter it: `mode`
  // defaults to 'campaign-coop' (tools/baseline/trace.ts passes none), so BASELINE_HASH
  // pins that body.
  if (world.rules.mode === 'ffa') {
    resolveStatusFfa(world, events);
    return;
  }
  if (world.rules.mode === 'teams') {
    resolveStatusTeams(world, events);
    return;
  }

  // The golden trace drives one player and never reaches coop; coop-respawn.test.ts pins
  // it (plan: docs/superpowers/plans/2026-08-16-coop-attempts.md).
  if (countPlayerTanks(world) >= 2) {
    resolveStatusCoop(world, events);
    return;
  }

  const player = world.tanks.find((t) => t.kind === 'player');
  const enemies = world.tanks.filter((t) => t.kind !== 'player');
  // Snapshot before resetArena, which revives every tank. Read afterwards, a player
  // who traded their last kill for a life would see the win silently discarded, a life
  // deducted, and the whole arena reset instead.
  const allEnemiesDead = enemies.length > 0 && enemies.every((e) => !e.alive);

  // A mutual kill is a win, so this runs before the death branch.
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
 * Two names rather than one overloaded `step(world, input | inputs)`: a union parameter
 * would put an `Array.isArray` branch in the pure core's hot path and would let a caller
 * silently pass the wrong shape at a call site that still typechecks.
 */
export function stepInputs(world: World, inputs: InputState[]): StepResult {
  const draft = cloneWorld(world);
  draft.tick += 1;
  const events: SimEvent[] = [];

  if (draft.status === 'playing') {
    // Before applyPlayerInputs, so a tank reviving this tick also gets this tick's input.
    // Campaign-coop schedules respawns only in pool mode with two or more players;
    // applyVersusStock can schedule one at any player count. The explicit
    // `mode === 'campaign-coop'` keeps the mode boundary legible here, not only inside
    // resolveStatus.
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
 * Keep this `[input]` and nothing else: the golden trace hash
 * (tools/baseline/trace.test.ts) is taken through `step` and pins stepInputs only while
 * this adds no branch of its own.
 */
export function step(world: World, input: InputState): StepResult {
  return stepInputs(world, [input]);
}
