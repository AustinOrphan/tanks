import type { Tank, Bullet, Blast, Mine, Wall, Spawn, InputState, UnarmedTrigger } from './types';
import { angleOf, slewAngle, vsub } from './types';
import type { SimEvent } from './events';
import { moveTank, separateTanks, resolveWalls } from './collision';
import { spawnBullet, stepBullets, resolveBulletHits } from './bullets';
import { dropMine, stepBlasts, stepMines } from './mines';
import { stepAi } from './ai';
import { DT, MINE_COOLDOWN_TICKS, PLAYER_TURRET_TURN_RATE } from './constants';
import { configFor, hasAbility, TankAbility } from './config';
import { roundPhase } from './round';

export interface World {
  tick: number;
  nextId: number;
  seed: number;
  /** What may detonate an UNARMED mine. See UnarmedTrigger. */
  unarmedTrigger: UnarmedTrigger;
  /**
   * Whether a tank killed earlier in the SAME resolveBulletHits pass still blocks a
   * later bullet aimed at it, instead of letting it pass through untouched.
   *
   * Default false: today's shipped rule, a GHOST -- resolveBulletHits skips any tank
   * whose `alive` is already false, so a second shell in the same tick sails through
   * the spot its target just vacated. Adopted ruling (2026-08-14): "Just-killed tank is a
   * ghost for now. Flippable switch in the future to playtest." `true` is the WALL
   * variant: resolveBulletHits snapshots which tanks were alive at the START of its
   * pass, and a bullet that reaches one which died EARLIER IN THE SAME PASS is
   * consumed right there -- `b.alive = false`, one 'explosion' event at the hit --
   * without re-killing the tank or re-emitting 'tank-destroyed'. A corpse from an
   * EARLIER stage (a mine kill from a prior tick, or from the shell-detonates-a-mine
   * loop earlier in this same resolveBulletHits call) is not in that snapshot and
   * keeps ghosting in BOTH positions -- this switch changes only the same-pass case.
   * See bullets.ts's resolveBulletHits.
   */
  corpseBlocksShells: boolean;
  /**
   * Whether a shell's muzzle spawn point falls back to the owner's centre when it
   * would land inside a LIVE non-owner tank's hit circle (TANK_RADIUS + BULLET_RADIUS
   * -- resolveBulletHits' own collision threshold), the same fallback shape
   * muzzlePoint already uses for a muzzle inside a wall.
   *
   * Default true -- the adopted lean (2026-08-14): "Spawn at hull center might be the
   * way to go but im not certain. Maybe set that up but also have it be flippable."
   * `false` restores today's shipped behaviour, where the muzzle can spawn already
   * inside a neighbour's hit circle -- the triage that motivated this switch measured
   * the harmful variant as a ~0.5-3 degree tangent-escape sliver at exact minimum
   * separation. See bullets.ts's muzzlePoint.
   */
  muzzleClearsTanks: boolean;
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

export function createWorld(init: {
  walls: Wall[];
  tanks: Tank[];
  spawns: Spawn[];
  lives: number;
  seed?: number;
  /** Defaults to 'none', the shipped rule. */
  unarmedTrigger?: UnarmedTrigger;
  /** Defaults to false, the shipped GHOST rule. See World.corpseBlocksShells. */
  corpseBlocksShells?: boolean;
  /** Defaults to true, the adopted lean. See World.muzzleClearsTanks. */
  muzzleClearsTanks?: boolean;
}): World {
  const maxId = Math.max(
    0,
    ...init.walls.map((w) => w.id),
    ...init.tanks.map((t) => t.id),
  );
  return {
    tick: 0,
    nextId: maxId + 1,
    seed: init.seed ?? 1,
    unarmedTrigger: init.unarmedTrigger ?? 'none',
    corpseBlocksShells: init.corpseBlocksShells ?? false,
    muzzleClearsTanks: init.muzzleClearsTanks ?? true,
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
  };
}

export function cloneWorld(world: World): World {
  return {
    tick: world.tick,
    nextId: world.nextId,
    seed: world.seed,
    unarmedTrigger: world.unarmedTrigger,
    corpseBlocksShells: world.corpseBlocksShells,
    muzzleClearsTanks: world.muzzleClearsTanks,
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

  const canAct = phase === 'live';

  if (canAct && input.fire && player.fireCooldown <= 0) {
    if (spawnBullet(world, player.id, player.turretAngle, pcfg.weapon.bulletType, events)) {
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

export function resolveStatus(world: World, events: SimEvent[]): void {
  // step() latches on status, but the export is called directly by tests and by
  // anything embedding the sim. Without this guard a second call on a won world
  // pushes a second `win` -- and a second victory stinger.
  if (world.status !== 'playing') return;

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
