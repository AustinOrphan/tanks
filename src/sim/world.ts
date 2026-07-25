import type { Tank, Bullet, Mine, Wall, Spawn, InputState } from './types';
import { angleOf, vsub } from './types';
import type { SimEvent } from './events';
import { moveTank, separateTanks } from './collision';
import { spawnBullet, stepBullets, resolveBulletHits } from './bullets';
import { dropMine, stepMines } from './mines';
import { stepAi } from './ai';
import { DT, FIRE_COOLDOWN, MINE_COOLDOWN } from './constants';

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
    tanks: world.tanks.map(cloneTank),
    bullets: world.bullets.map((b) => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } })),
    mines: world.mines.map((m) => ({ ...m, pos: { ...m.pos } })),
    walls: world.walls.map((w) => ({ ...w, aabb: { ...w.aabb } })),
    spawns: world.spawns.map((s) => ({ ...s, pos: { ...s.pos } })),
  };
}

export function stepMovement(world: World, dt: number): void {
  for (const tank of world.tanks) {
    if (!tank.alive) continue;
    moveTank(tank, world.walls, dt);
  }
  separateTanks(world.tanks);
}

export function applyPlayerInput(world: World, input: InputState, events: SimEvent[]): void {
  const player = world.tanks.find((t) => t.kind === 'player');
  if (!player || !player.alive) return;

  player.desiredMove = { x: input.move.x, y: input.move.y };

  const aimDir = vsub(input.aim, player.pos);
  if (aimDir.x !== 0 || aimDir.y !== 0) {
    player.turretAngle = angleOf(aimDir);
  }

  if (player.fireCooldown > 0) player.fireCooldown -= DT;
  if (player.mineCooldown > 0) player.mineCooldown -= DT;

  if (input.fire && player.fireCooldown <= 0) {
    if (spawnBullet(world, player.id, player.turretAngle, 'normal', events)) {
      player.fireCooldown = FIRE_COOLDOWN;
    }
  }

  if (input.mine && player.mineCooldown <= 0) {
    if (dropMine(world, player.id, events)) {
      player.mineCooldown = MINE_COOLDOWN;
    }
  }
}

// A life loss restarts the WHOLE arena (spec §4: "restart arena on death"): every
// tank returns to its spawn alive, destroyed walls come back, and all bullets/mines
// clear. Relies on the loadArena invariant that world.tanks[i] was built from
// world.spawns[i] — tanks are never removed or reordered (dead tanks stay in place
// with alive=false), so that index alignment holds for the whole game.
function resetArena(world: World): void {
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
  const player = world.tanks.find((t) => t.kind === 'player');
  if (player && !player.alive) {
    world.lives -= 1;
    if (world.lives > 0) {
      resetArena(world);
    } else {
      world.status = 'lose';
      events.push({ type: 'lose' });
      return; // dying on the last life = lose, even if an enemy died the same tick
    }
  }

  const enemies = world.tanks.filter((t) => t.kind !== 'player');
  if (enemies.length > 0 && enemies.every((e) => !e.alive)) {
    world.status = 'win';
    events.push({ type: 'win' });
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
