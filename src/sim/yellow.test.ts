// End-to-end proof for issue #136's "cheap case": YELLOW is data-only, reusing teal's
// shipped MOBILE_MINE_LAYER profile. This file exercises the one site none of the other
// pins reach -- a FIXTURE arena that carries a real 'Y' spawn cell, loaded through the
// real loadArena/SPAWN_LETTERS path, driven through the real step() pipeline (not a
// stage called directly, per this repo's own rule against composition blindness).
//
// TEST-ONLY, like arena-fixtures.ts's fixtures: never in ARENAS/ARENA_DEFS, so it cannot
// reach the shipped sequence and cannot move any shipped count (arena-validation.test.ts's
// EXPECTED_CLAIMS and cell-mapping.test.ts's totals are keyed off ARENA_DEFS/WIDE_ARENA
// alone). Campaign placement is explicitly deferred by the issue's own last paragraph, so
// this arena is deliberately unreachable from play.
//
// The player is walled into a sealed 1-cell alcove (solid on all 4 orthogonal faces) so
// no direct OR bank shot can ever land -- yellow is free to fire the whole run without a
// death mid-test resetting the world (resetArena would wipe the running mine count this
// file is trying to observe). This makes the fixture unfit for structuralFailures (a fully
// sealed cell fails the "sealed pocket" rule), which is fine: that rule polices SHIPPED
// safety, and this arena never ships.
import { describe, it, expect } from 'vitest';
import { validateArenas } from './config/validate';
import { createWorldFor } from './arena';
import { step } from './world';
import type { InputState } from './types';
import { COUNTDOWN_TICKS, GRACE_TICKS } from './constants';
import { configFor } from './config';

const YELLOW_MINE_ARENA = validateArenas(
  {
    arenas: [
      {
        id: 'fixture-yellow',
        cols: 9, rows: 9, cellSize: 2,
        legend: { '#': 'solid' },
        grid: [
          '.........',
          '.........',
          '.........',
          '.........',
          '..Y......',
          '...###...',
          '...#P#...',
          '...###...',
          '.........',
        ],
        notes: ['Fixture: yellow spawns, drives and mines through the real pipeline. Player sealed in, deliberately unsafe by structuralFailures -- never shipped.'],
        claims: [],
      },
    ],
  },
  'yellow.test.ts',
)[0];

const idleInput: InputState = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false };

describe('YELLOW (issue #136): a fixture arena reaches it through the real spawn path', () => {
  it('the Y letter resolves to a yellow tank via loadArena/SPAWN_LETTERS', () => {
    const world = createWorldFor(YELLOW_MINE_ARENA, 7);
    const yellow = world.tanks.find((t) => t.kind === 'yellow');
    expect(yellow).toBeDefined();
    expect(world.tanks.find((t) => t.kind === 'player')).toBeDefined();
  });

  it('through step(), yellow MOVES (behaviourally teal-like: TACTICAL, seekMove-driven)', () => {
    let world = createWorldFor(YELLOW_MINE_ARENA, 7);
    // Skip the countdown outright -- movement being blocked there is a general round-phase
    // rule (frame.test.ts, step-integration.test.ts), not something specific to yellow.
    world.roundStartTick = -(COUNTDOWN_TICKS + GRACE_TICKS) - 1;
    const start = { ...world.tanks.find((t) => t.kind === 'yellow')!.pos };
    for (let i = 0; i < 120; i++) {
      world = step(world, idleInput).world;
    }
    const now = world.tanks.find((t) => t.kind === 'yellow')!.pos;
    const moved = Math.hypot(now.x - start.x, now.y - start.y);
    expect(moved).toBeGreaterThan(0.05);
  });

  it('through step(), yellow actually lays a mine (decideAi -> stepAi -> dropMine, wired end to end for the new kind)', () => {
    // Reaching the FULL 4-mine cap simultaneously is not this test's job -- measured over
    // this same fixture, running 4000 ticks peaks at 2 concurrently active, because
    // MINE_TIMER (180 ticks) expires early mines faster than the 30-tick cooldown x 0.3
    // per-bucket draw x yellow's own dangerAvoidMove (it dodges its own live mines, which
    // also gates the NEXT drop) can refill the cap. That the cap is 4, not teal's 2, is
    // pinned deterministically in mines.test.ts's dropMine cap test instead, which does not
    // depend on the AI's probability draw. This test's job is narrower and end-to-end: that
    // the real dispatcher (ai/index.ts stepAi), not a direct dropMine call, actually places
    // one for this new kind, discriminated by OWNER and PAYLOAD (a 'mine-dropped' event
    // whose ownerId is yellow's), not mere stream presence (teal-style events look the same).
    let world = createWorldFor(YELLOW_MINE_ARENA, 7);
    world.roundStartTick = -(COUNTDOWN_TICKS + GRACE_TICKS) - 1;
    const yellowId = world.tanks.find((t) => t.kind === 'yellow')!.id;
    let sawOwnMineEvent = false;
    let maxActive = 0;
    for (let i = 0; i < 400; i++) {
      const r = step(world, idleInput);
      world = r.world;
      if (r.events.some((e) => e.type === 'mine-dropped' && e.ownerId === yellowId)) sawOwnMineEvent = true;
      maxActive = Math.max(maxActive, world.tanks.find((t) => t.id === yellowId)!.activeMineIds.length);
    }
    expect(sawOwnMineEvent).toBe(true);
    expect(maxActive).toBeGreaterThan(0);
    expect(maxActive).toBeLessThanOrEqual(configFor('yellow').mineCapacity); // never exceeds its own cap
  });
});
