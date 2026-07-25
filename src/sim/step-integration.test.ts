import { describe, it, expect } from 'vitest';
import { createWorld, applyPlayerInput, resolveStatus, step } from './world';
import type { World } from './world';
import type { Tank, Spawn, InputState } from './types';
import type { SimEvent } from './events';
import { FIRE_COOLDOWN } from './constants';

function makeTank(kind: Tank['kind'], id: number, x: number, y: number): Tank {
  return {
    id,
    kind,
    pos: { x, y },
    bodyAngle: 0,
    turretAngle: 0,
    alive: true,
    desiredMove: { x: 0, y: 0 },
    activeMineIds: [],
    fireCooldown: 0,
    mineCooldown: 0,
    aiState: 'idle',
    aiTimer: 0,
  };
}

function makeWorld(): World {
  const player = makeTank('player', 1, 5, 5);
  const brown = makeTank('brown', 2, 5, 15);
  const spawns: Spawn[] = [
    { kind: 'player', pos: { x: 5, y: 5 }, angle: 0 },
    { kind: 'brown', pos: { x: 5, y: 15 }, angle: 0 },
  ];
  return createWorld({ walls: [], tanks: [player, brown], spawns, lives: 3 });
}

const fireInput: InputState = {
  move: { x: 0, y: 0 },
  aim: { x: 10, y: 5 }, // straight to the +x of the player at (5,5) -> angle 0
  fire: true,
  mine: false,
};

describe('applyPlayerInput', () => {
  it('aims the turret at the cursor independent of body facing', () => {
    const w = makeWorld();
    const player = w.tanks[0];
    player.bodyAngle = Math.PI; // body faces the other way
    applyPlayerInput(w, { ...fireInput, fire: false }, []);
    expect(player.turretAngle).toBeCloseTo(0, 10);
    expect(player.bodyAngle).toBe(Math.PI); // unchanged
  });

  it('fires once, spends the cooldown, then refuses until it elapses', () => {
    const w = makeWorld();
    const events: SimEvent[] = [];
    applyPlayerInput(w, fireInput, events);
    expect(w.bullets.length).toBe(1);
    expect(events.some((e) => e.type === 'fire')).toBe(true);
    expect(w.tanks[0].fireCooldown).toBeCloseTo(FIRE_COOLDOWN, 10);

    // Immediately press fire again: cooldown not yet elapsed -> no new shell.
    applyPlayerInput(w, fireInput, []);
    expect(w.bullets.length).toBe(1);
  });
});

describe('resolveStatus', () => {
  it('restarts the arena (revives enemies, restores walls) and decrements lives while lives remain', () => {
    const w = makeWorld();
    const player = w.tanks[0];
    const enemy = w.tanks[1]; // brown, spawn-aligned at index 1
    player.alive = false;
    player.pos = { x: 99, y: 99 };
    enemy.alive = false; // was destroyed earlier this life
    // a destructible wall blown open earlier this life
    w.walls.push({ id: 99, aabb: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, kind: 'destructible', destroyed: true });
    resolveStatus(w, []);
    expect(w.lives).toBe(2);
    expect(player.alive).toBe(true);
    expect(player.pos).toEqual({ x: 5, y: 5 }); // player back at spawn
    expect(enemy.alive).toBe(true); // arena restarted -> enemy revived
    expect(enemy.pos).toEqual({ x: 5, y: 15 }); // enemy back at its spawn
    expect(w.walls[0].destroyed).toBe(false); // destroyed wall restored
    expect(w.status).toBe('playing');
  });

  it('emits lose and sets status when the player dies at 1 life', () => {
    const w = makeWorld();
    w.lives = 1;
    w.tanks[0].alive = false;
    const events: SimEvent[] = [];
    resolveStatus(w, events);
    expect(w.lives).toBe(0);
    expect(w.status).toBe('lose');
    expect(events).toContainEqual({ type: 'lose' });
  });

  it('emits win when the last enemy is destroyed', () => {
    const w = makeWorld();
    w.tanks[1].alive = false; // only enemy dead
    const events: SimEvent[] = [];
    resolveStatus(w, events);
    expect(w.status).toBe('win');
    expect(events).toContainEqual({ type: 'win' });
  });

  it('does nothing while both sides have live tanks', () => {
    const w = makeWorld();
    const events: SimEvent[] = [];
    resolveStatus(w, events);
    expect(w.status).toBe('playing');
    expect(events).toEqual([]);
  });
});

describe('step() composition (full pipeline)', () => {
  it('runs the whole pipeline in one tick: fires, threads the fire event, and advances the shell', () => {
    const w = makeWorld();
    const r1 = step(w, fireInput);
    expect(r1.world.bullets.length).toBe(1);
    expect(r1.events.some((e) => e.type === 'fire')).toBe(true);
    const bx1 = r1.world.bullets[0].pos.x; // spawned at x=5, advanced +x this same tick
    expect(bx1).toBeGreaterThan(5);
    // next tick (no new fire): the existing shell keeps advancing along +x
    const r2 = step(r1.world, { ...fireInput, fire: false });
    expect(r2.world.bullets.length).toBe(1);
    expect(r2.world.bullets[0].pos.x).toBeGreaterThan(bx1);
  });

  it('reports win through the pipeline when the last enemy is already dead', () => {
    const w = makeWorld();
    w.tanks[1].alive = false; // only enemy dead going in
    const r = step(w, { ...fireInput, fire: false });
    expect(r.world.status).toBe('win');
    expect(r.events).toContainEqual({ type: 'win' });
  });

  it('latches a finished game: once status is not playing, step() skips the pipeline', () => {
    const w = makeWorld();
    w.tanks[1].alive = false;
    const won = step(w, { ...fireInput, fire: false }).world;
    expect(won.status).toBe('win');
    // further input is ignored: firing produces no shell, status stays win
    const after = step(won, fireInput);
    expect(after.world.bullets.length).toBe(0);
    expect(after.world.status).toBe('win');
  });
});
