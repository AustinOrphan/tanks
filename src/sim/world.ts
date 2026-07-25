import type { Tank, Bullet, Mine, Wall, Spawn, InputState } from './types';
import type { SimEvent } from './events';

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

// Skeleton. Update calls (movement, AI, bullets, mines, status) are inserted in a
// fixed order by tasks 9-15 and 22. CONTRACT: input world is immutable; we clone a
// draft, mutate the draft, and return it, so render can keep prev/curr distinct.
export function step(world: World, _input: InputState): StepResult {
  const draft = cloneWorld(world);
  draft.tick += 1;
  return { world: draft, events: [] };
}
