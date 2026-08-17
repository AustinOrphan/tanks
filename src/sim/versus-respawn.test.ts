import { describe, it, expect } from 'vitest';
import { createWorld, stepInputs, stepRespawns } from './world';
import { loadArena, ARENA_01 } from './arena';
import { pickVersusSpawnCell } from './versus-spawns';
import type { SimEvent } from './events';
import type { Vec2 } from './types';

/**
 * WHERE a versus (ffa/teams) respawn lands -- `stepRespawns`' `respawnPos` helper
 * (world.ts), wired to `pickVersusSpawnCell` (versus-spawns.ts) via `World.arenaGeometry`.
 * `versus-spawns.test.ts` already proves `pickVersusSpawnCell` itself picks a
 * well-separated cell; this file proves the WIRING -- that a real respawn reaches it (not
 * just that `World.arenaGeometry` exists), that it degrades to today's authored-spawn
 * behaviour when that field is absent, and that `avoid` is built from LIVING tanks only.
 *
 * `stepRespawns` is called DIRECTLY (coop-respawn.test.ts's own established pattern for
 * exact-position assertions), not through `stepInputs`: the full pipeline's own
 * `stepMovement` (resolveWalls/separateTanks) runs immediately AFTER stepRespawns in the
 * SAME tick and can nudge a freshly placed tank off a raw cell centre if that cell sits
 * against a wall -- observed directly while writing this file (a corner cell picked as
 * "farthest from the one other player" left the hull overlapping the boundary wall,
 * and the post-tick position differed from the cell centre by exactly the overlap). That
 * nudge is correct, existing sim behaviour, not a defect in the respawn wiring, so
 * position-exactness is checked at `stepRespawns`' own boundary, before physics can touch
 * it; `versus-modes.test.ts` already covers reachability (does it revive at all) through
 * the full `stepInputs` pipeline.
 *
 * Every test here computes its own expectation via a direct `pickVersusSpawnCell` call
 * on the same inputs and asserts that expectation actually differs from the authored
 * spawn before trusting the comparison -- a fixture where the picked cell happens to
 * coincide with the authored spawn would let a silently dropped `arenaGeometry` (e.g. a
 * `cloneWorld` that forgot to carry it) pass by coincidence.
 */

const cellPos = (cell: { row: number; col: number }, cellSize: number): Vec2 => ({
  x: (cell.col + 0.5) * cellSize,
  y: (cell.row + 0.5) * cellSize,
});

describe('versus respawn: picks a cell via pickVersusSpawnCell when arenaGeometry is present', () => {
  it('ffa N=2: the revived tank lands on the picked cell, not its own authored spawn', () => {
    const { walls, tanks, spawns, arenaGeometry } = loadArena(ARENA_01, 2, 'ffa');
    const world = createWorld({ walls, tanks, spawns, lives: 3, mode: 'ffa', arenaGeometry });

    const dead = world.tanks[0]; // P1
    const survivor = world.tanks[1]; // P2, still at its own spawn
    dead.alive = false;
    dead.respawnAtTick = 1; // due on the very first simulated tick
    world.tick = 1;

    const { cols, rows, cellSize, grid, legend } = arenaGeometry;
    const expected = cellPos(
      pickVersusSpawnCell(grid, cols, rows, cellSize, legend, [{ x: survivor.pos.x, y: survivor.pos.y }]),
      cellSize,
    );
    // Sanity: this fixture must actually discriminate pick-from-fallback, or a dropped
    // arenaGeometry could pass this test by landing on the authored spawn anyway.
    expect(expected).not.toEqual(spawns[0].pos);

    stepRespawns(world, []);
    expect(dead.alive).toBe(true);
    expect(dead.pos).toEqual(expected);
  });

  it('teams N=2: same wiring reaches the teams branch too', () => {
    const { walls, tanks, spawns, arenaGeometry } = loadArena(ARENA_01, 2, 'teams');
    const world = createWorld({ walls, tanks, spawns, lives: 3, mode: 'teams', arenaGeometry });

    const dead = world.tanks[0];
    const survivor = world.tanks[1];
    dead.alive = false;
    dead.respawnAtTick = 1;
    world.tick = 1;

    const { cols, rows, cellSize, grid, legend } = arenaGeometry;
    const expected = cellPos(
      pickVersusSpawnCell(grid, cols, rows, cellSize, legend, [{ x: survivor.pos.x, y: survivor.pos.y }]),
      cellSize,
    );
    expect(expected).not.toEqual(spawns[0].pos);

    stepRespawns(world, []);
    expect(dead.pos).toEqual(expected);
  });

  it('avoid excludes a tank that is itself currently dead: only the living survivor constrains the pick', () => {
    const { walls, tanks, spawns, arenaGeometry } = loadArena(ARENA_01, 3, 'ffa');
    const world = createWorld({ walls, tanks, spawns, lives: 3, mode: 'ffa', arenaGeometry });

    const reviving = world.tanks[0]; // P1, due to respawn this tick
    const alsoDead = world.tanks[1]; // P2, dead but NOT yet due -- must not appear in avoid
    const survivor = world.tanks[2]; // P3, the only living tank
    reviving.alive = false;
    reviving.respawnAtTick = 1;
    alsoDead.alive = false;
    alsoDead.respawnAtTick = 999; // due much later -- irrelevant to this tick's pick
    world.tick = 1;

    const { cols, rows, cellSize, grid, legend } = arenaGeometry;
    // Computed against survivor ONLY -- if avoid wrongly included alsoDead's position, a
    // picker weighing distance from BOTH would generally land somewhere else.
    const expected = cellPos(
      pickVersusSpawnCell(grid, cols, rows, cellSize, legend, [{ x: survivor.pos.x, y: survivor.pos.y }]),
      cellSize,
    );
    const expectedIfWronglyIncludingDead = cellPos(
      pickVersusSpawnCell(grid, cols, rows, cellSize, legend, [
        { x: survivor.pos.x, y: survivor.pos.y },
        { x: alsoDead.pos.x, y: alsoDead.pos.y },
      ]),
      cellSize,
    );
    // Sanity: the two candidate expectations must actually differ, or this fixture
    // cannot tell the two implementations apart.
    expect(expected).not.toEqual(expectedIfWronglyIncludingDead);

    stepRespawns(world, []);
    expect(reviving.pos).toEqual(expected);
  });

  it('two same-tick revivals: the second sees the first as already alive at its NEW cell', () => {
    const { walls, tanks, spawns, arenaGeometry } = loadArena(ARENA_01, 3, 'ffa');
    const world = createWorld({ walls, tanks, spawns, lives: 3, mode: 'ffa', arenaGeometry });

    const first = world.tanks[0]; // P1, tanks-array order -- processed first by stepRespawns
    const second = world.tanks[1]; // P2, processed second
    const survivor = world.tanks[2]; // P3
    first.alive = false;
    first.respawnAtTick = 1;
    second.alive = false;
    second.respawnAtTick = 1;
    world.tick = 1;

    const { cols, rows, cellSize, grid, legend } = arenaGeometry;
    const firstPick = cellPos(
      pickVersusSpawnCell(grid, cols, rows, cellSize, legend, [{ x: survivor.pos.x, y: survivor.pos.y }]),
      cellSize,
    );
    // The second pick must avoid the FIRST tank's freshly-revived position, not its
    // stale pre-death one -- so it is scored against [survivor, firstPick].
    const secondPick = cellPos(
      pickVersusSpawnCell(grid, cols, rows, cellSize, legend, [
        { x: survivor.pos.x, y: survivor.pos.y },
        firstPick,
      ]),
      cellSize,
    );
    expect(firstPick).not.toEqual(secondPick); // otherwise this fixture can't discriminate order

    stepRespawns(world, []);
    expect(first.pos).toEqual(firstPick);
    expect(second.pos).toEqual(secondPick);
  });

  it('end to end through the full pipeline (stepInputs): the revived tank is alive and off its authored spawn', () => {
    // Complements the direct-call tests above: proves the wiring survives cloneWorld and
    // the rest of stepInputs' pipeline, without asserting an exact post-physics position
    // (see this file's own doc comment on why that would be fragile here).
    const { walls, tanks, spawns, arenaGeometry } = loadArena(ARENA_01, 2, 'ffa');
    const world = createWorld({ walls, tanks, spawns, lives: 3, mode: 'ffa', arenaGeometry });
    const dead = world.tanks[0];
    dead.alive = false;
    dead.respawnAtTick = 1;
    const idle = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false };
    const r = stepInputs(world, [idle, idle]);
    const revived = r.world.tanks.find((t) => t.id === dead.id)!;
    expect(revived.alive).toBe(true);
    expect(revived.pos).not.toEqual(spawns[0].pos);
  });
});

describe('versus respawn: degrades to the authored spawn when arenaGeometry is absent', () => {
  it('a hand-built ffa World (no loadArena, no arenaGeometry) respawns at world.spawns[i], unchanged', () => {
    const spawnPos = { x: 3, y: 4 };
    const world = createWorld({
      walls: [],
      tanks: [
        { id: 1, kind: 'player', pos: { x: 3, y: 4 }, bodyAngle: 0, turretAngle: 0, alive: true, desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0, aiState: 'idle', aiTimer: 0, controlledBy: 0, stockRemaining: 2 },
        { id: 2, kind: 'player', pos: { x: 9, y: 4 }, bodyAngle: 0, turretAngle: 0, alive: true, desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0, aiState: 'idle', aiTimer: 0, controlledBy: 1, stockRemaining: 2 },
      ],
      spawns: [
        { kind: 'player', pos: spawnPos, angle: 0 },
        { kind: 'player', pos: { x: 9, y: 4 }, angle: 0 },
      ],
      lives: 3,
      mode: 'ffa',
      // No arenaGeometry -- this World was never built by loadArena.
    });
    const dead = world.tanks[0];
    dead.alive = false;
    dead.respawnAtTick = 1;
    world.tick = 1;

    const events: SimEvent[] = [];
    stepRespawns(world, events);
    expect(dead.alive).toBe(true);
    expect(dead.pos).toEqual(spawnPos);
  });
});
