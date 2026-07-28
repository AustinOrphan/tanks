import type { Tank, Bullet, Mine, Wall, Spawn, InputState } from './types';
import { angleOf, slewAngle, vsub } from './types';
import type { SimEvent } from './events';
import { moveTank, separateTanks, resolveWalls } from './collision';
import { spawnBullet, stepBullets, resolveBulletHits } from './bullets';
import { dropMine, stepMines } from './mines';
import { stepAi } from './ai';
import { DT, FIRE_COOLDOWN_TICKS, MINE_COOLDOWN_TICKS, PLAYER_TURRET_TURN_RATE } from './constants';
import { roundPhase } from './round';

export interface World {
  tick: number;
  nextId: number;
  seed: number;
  tanks: Tank[];
  bullets: Bullet[];
  mines: Mine[];
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
    tanks: init.tanks,
    bullets: [],
    mines: [],
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
    status: world.status,
    lives: world.lives,
    roundStartTick: world.roundStartTick,
    tanks: world.tanks.map(cloneTank),
    bullets: world.bullets.map((b) => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } })),
    mines: world.mines.map((m) => ({ ...m, pos: { ...m.pos } })),
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

export function applyPlayerInput(world: World, input: InputState, events: SimEvent[]): void {
  const player = world.tanks.find((t) => t.kind === 'player');
  if (!player || !player.alive) return;

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
    if (spawnBullet(world, player.id, player.turretAngle, 'normal', events)) {
      player.fireCooldown = FIRE_COOLDOWN_TICKS;
    }
  }

  if (canAct && input.mine && player.mineCooldown <= 0) {
    if (dropMine(world, player.id, events)) {
      player.mineCooldown = MINE_COOLDOWN_TICKS;
    }
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
    t.alive = true;
    t.desiredMove = { x: 0, y: 0 };
    t.activeMineIds = [];
    t.fireCooldown = 0;
    t.mineCooldown = 0;
    t.aiState = 'idle';
    t.aiTimer = 0;
  }
  for (const w of world.walls) w.destroyed = false;
  world.bullets = [];
  world.mines = [];
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

export function step(world: World, input: InputState): StepResult {
  const draft = cloneWorld(world);
  draft.tick += 1;
  const events: SimEvent[] = [];

  if (draft.status === 'playing') {
    applyPlayerInput(draft, input, events);
    stepAi(draft, events);
    stepMovement(draft, DT);
    stepBullets(draft, DT, events);
    resolveBulletHits(draft, events);
    stepMines(draft, DT, events);
    resolveStatus(draft, events);
  }

  return { world: draft, events };
}
