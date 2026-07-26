// The sim's headline guarantee: same seed + same inputs => same world, tick for
// tick. Everything else in the architecture leans on it -- cloneWorld branching,
// the render layer holding `prev` while `curr` advances, and any future replay
// or netcode. It was verified once by hand; this pins it.
import { describe, it, expect } from 'vitest';
import { createArenaWorld } from './arena';
import { cloneWorld, step, type World } from './world';
import type { InputState } from './types';
import { nextRng } from './types';

/**
 * A scripted, seed-derived input stream. Deterministic but non-trivial: a
 * constant input would leave most of the pipeline unexercised, and a random one
 * would make failures unreproducible.
 */
function inputAt(tick: number): InputState {
  const a = nextRng(tick * 7 + 1).value;
  const b = nextRng(tick * 13 + 5).value;
  return {
    move: { x: Math.round(a * 2) - 1, y: Math.round(b * 2) - 1 },
    aim: { x: 4 + a * 14, y: 4 + b * 10 },
    fire: a > 0.7,
    mine: b > 0.93,
  };
}

/**
 * Structural fingerprint. `JSON.stringify` would hide -0 and turn NaN into
 * null -- exactly the two values a determinism bug is most likely to produce --
 * so numbers go through a DataView as raw float64 bits.
 */
function fingerprint(w: World): string {
  const nums: number[] = [];
  const push = (...xs: number[]): void => {
    nums.push(...xs);
  };
  push(w.tick, w.nextId, w.seed, w.lives, w.roundStartTick, w.status === 'playing' ? 0 : 1);
  for (const t of w.tanks) {
    push(t.id, t.pos.x, t.pos.y, t.bodyAngle, t.turretAngle, t.alive ? 1 : 0);
    push(t.desiredMove.x, t.desiredMove.y, t.fireCooldown, t.mineCooldown, t.aiTimer);
  }
  for (const b of w.bullets) push(b.id, b.pos.x, b.pos.y, b.vel.x, b.vel.y, b.bouncesLeft);
  for (const m of w.mines) push(m.id, m.pos.x, m.pos.y, m.timer, m.armed ? 1 : 0);
  for (const wl of w.walls) push(wl.id, wl.destroyed ? 1 : 0);

  const view = new DataView(new ArrayBuffer(8));
  return nums
    .map((n) => {
      view.setFloat64(0, n);
      return view.getBigUint64(0).toString(36);
    })
    .join(',');
}

function run(world: World, ticks: number, from = 0): World {
  let w = world;
  for (let i = 0; i < ticks; i++) w = step(w, inputAt(from + i)).world;
  return w;
}

const TICKS = 1200;

describe('sim determinism', () => {
  it('produces an identical world from an identical seed and input stream', () => {
    const a = fingerprint(run(createArenaWorld(42), TICKS));
    const b = fingerprint(run(createArenaWorld(42), TICKS));
    expect(a).toBe(b);
  });

  it('produces a DIFFERENT world from a different seed', () => {
    // The anti-vacuity control: without it, a fingerprint that collapsed
    // everything to a constant would satisfy the test above perfectly.
    const a = fingerprint(run(createArenaWorld(42), TICKS));
    const b = fingerprint(run(createArenaWorld(1337), TICKS));
    expect(a).not.toBe(b);
  });

  it('survives cloneWorld branching: a clone advanced alone matches the unbranched run', () => {
    const straight = fingerprint(run(createArenaWorld(7), TICKS));

    const mid = run(createArenaWorld(7), 500);
    const branch = run(cloneWorld(mid), TICKS - 500, 500);

    expect(fingerprint(branch)).toBe(straight);
  });

  it('keeps two clones of one world independent when stepped interleaved', () => {
    // Interleaving is what would expose any module-level mutable RNG state:
    // two worlds advancing in lockstep would consume each other's draws.
    const mid = run(createArenaWorld(9), 300);
    let x = cloneWorld(mid);
    let y = cloneWorld(mid);
    for (let i = 0; i < 400; i++) {
      x = step(x, inputAt(300 + i)).world;
      y = step(y, inputAt(300 + i)).world;
    }
    expect(fingerprint(x)).toBe(fingerprint(y));
    expect(fingerprint(x)).toBe(fingerprint(run(cloneWorld(mid), 400, 300)));
  });

  it('never lets a NaN or Infinity into world state', () => {
    const w = run(createArenaWorld(23), TICKS);
    for (const n of fingerprint(w).split(',')) expect(n).toBeTruthy();
    for (const t of w.tanks) {
      expect(Number.isFinite(t.pos.x) && Number.isFinite(t.pos.y)).toBe(true);
      expect(Number.isFinite(t.turretAngle) && Number.isFinite(t.bodyAngle)).toBe(true);
    }
    for (const b of w.bullets) {
      expect(Number.isFinite(b.pos.x) && Number.isFinite(b.vel.x)).toBe(true);
    }
  });

  it('retires dead bullets instead of accumulating them for the whole round', () => {
    // Corpses used to stay in world.bullets forever, and cloneWorld deep-copies
    // the array every tick -- 100k ticks in one round measured 3,987 bullets,
    // 3 of them alive, and a 10.8x per-tick slowdown.
    const w = run(createArenaWorld(11), TICKS);
    expect(w.bullets.every((b) => b.alive)).toBe(true);
    expect(w.bullets.length).toBeLessThan(32);
  });

  it('does not mutate the world handed to step()', () => {
    // loop.ts keeps `prev` aliased to the world it passes in, so a mutating
    // step() would silently corrupt render interpolation.
    const w = run(createArenaWorld(5), 400);
    const before = fingerprint(w);
    step(w, inputAt(400));
    expect(fingerprint(w)).toBe(before);
  });
});
