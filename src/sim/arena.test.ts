import { describe, it, expect } from 'vitest';
import { ARENA_01, arenaBounds, loadArena, createArenaWorld } from './arena';
import { raySegmentVsAABB } from './collision';
import { bankShot, lineOfSight } from './ai/targeting';
import { RICOCHET_BOUNCES, LIVES, COUNTDOWN_TICKS, GRACE_TICKS } from './constants';
import { step } from './world';
import type { InputState } from './types';

function countChar(grid: string[], ch: string): number {
  return grid.reduce((n, row) => n + [...row].filter((c) => c === ch).length, 0);
}

describe('arenaBounds', () => {
  it('reports the playable area, not the extent of the oversized boundary walls', () => {
    const bounds = arenaBounds(ARENA_01);

    expect(bounds).toEqual({ width: 22, height: 18 });
  });

  it('is strictly smaller than the wall extent, because boundaries sit outside play', () => {
    const { walls } = loadArena(ARENA_01);
    const wallMaxX = Math.max(...walls.map((w) => w.aabb.maxX));
    const wallMaxY = Math.max(...walls.map((w) => w.aabb.maxY));
    const bounds = arenaBounds(ARENA_01);

    // The renderer centres the ground plane at (width/2, height/2). Measuring
    // that from wall extent puts the felt one cell off-centre in both axes and
    // leaves the top/left boundary walls hanging over the clear colour.
    expect(wallMaxX).toBe(bounds.width + ARENA_01.cellSize);
    expect(wallMaxY).toBe(bounds.height + ARENA_01.cellSize);
  });
});

describe('loadArena', () => {
  it('produces the interior walls plus exactly 4 solid boundary walls', () => {
    const { walls } = loadArena(ARENA_01);
    const solidCells = countChar(ARENA_01.grid, '#');
    const destructibleCells = countChar(ARENA_01.grid, 'x');

    expect(walls.length).toBe(solidCells + destructibleCells + 4);

    const destructible = walls.filter((w) => w.kind === 'destructible');
    const solid = walls.filter((w) => w.kind === 'solid');
    expect(destructible.length).toBe(destructibleCells);
    expect(solid.length).toBe(solidCells + 4); // interior solids + 4 boundaries
  });

  it('assigns unique ids across walls and tanks', () => {
    const { walls, tanks } = loadArena(ARENA_01);
    const ids = [...walls.map((w) => w.id), ...tanks.map((t) => t.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps spawn chars to the right TankKind at grid-to-world coordinates', () => {
    const { tanks } = loadArena(ARENA_01);
    const kinds = tanks.map((t) => t.kind).sort();
    expect(kinds).toEqual(['brown', 'grey', 'player', 'teal']);

    // Teal spawn is at grid (col 16, row 10), cellSize 2/3 -> center (11, 7). (Was
    // (col 5, row 3), cellSize 2, pre-upscale -- same world-space centre either way,
    // which is the invariant this assertion pins.)
    const teal = tanks.find((t) => t.kind === 'teal')!;
    expect(teal.pos).toEqual({ x: 11, y: 7 });
    expect(teal.alive).toBe(true);
  });

  it('has geometry where Teal cannot hit the player directly (bank shot required)', () => {
    const { tanks, walls } = loadArena(ARENA_01);
    const teal = tanks.find((t) => t.kind === 'teal')!;
    const player = tanks.find((t) => t.kind === 'player')!;
    // A direct line from Teal to the player must be blocked by some solid wall,
    // which is exactly what forces Teal into a bank shot.
    const blocked = walls.some(
      (w) => w.kind === 'solid' && raySegmentVsAABB(teal.pos, player.pos, w.aabb) !== null,
    );
    expect(blocked).toBe(true);
  });

  it('affords Teal a real single-bounce bank shot at the player (signature slice feature)', () => {
    const { tanks, walls } = loadArena(ARENA_01);
    const teal = tanks.find((t) => t.kind === 'teal')!;
    const player = tanks.find((t) => t.kind === 'player')!;
    // The direct line is blocked (previous test), so ricochet-around-cover REQUIRES a
    // valid bank path to exist — it is the whole reason Teal (and this slice) exists.
    // If this assertion fails, the geometry does not afford one: TUNE ARENA_01 (widen
    // the side lanes / reposition the flanking blocks) until a single-bounce path is
    // found. Do NOT ship the slice with this red — a bank-less Teal just repositions
    // forever and the signature behavior never appears.
    expect(bankShot(teal.pos, player.pos, walls, RICOCHET_BOUNCES)).not.toBeNull();
  });

  it('gives the player spawn REAL cover: neither Brown nor Grey has line-of-sight, even ' +
    'perturbed by ±0.5 units in x and y (the original arena failed exactly this: the ' +
    'center block put both lines exactly tangent to its corners, a knife edge where a ' +
    '0.1-unit nudge gave one attacker a fully clear 10-unit lane)', () => {
    const { tanks, walls } = loadArena(ARENA_01);
    const brown = tanks.find((t) => t.kind === 'brown')!;
    const grey = tanks.find((t) => t.kind === 'grey')!;
    const player = tanks.find((t) => t.kind === 'player')!;

    const deltas = [-0.5, 0, 0.5];
    for (const dx of deltas) {
      for (const dy of deltas) {
        const p = { x: player.pos.x + dx, y: player.pos.y + dy };
        expect(lineOfSight(brown.pos, p, walls), `brown LOS at dx=${dx}, dy=${dy}`).toBe(false);
        expect(lineOfSight(grey.pos, p, walls), `grey LOS at dx=${dx}, dy=${dy}`).toBe(false);
      }
    }
  });

  it('keeps tanks and spawns in lockstep (index, kind, and position) for resetArena', () => {
    const { tanks, spawns } = loadArena(ARENA_01);
    expect(tanks.length).toBe(spawns.length);
    for (let i = 0; i < tanks.length; i++) {
      expect(tanks[i].kind).toBe(spawns[i].kind);
      expect(tanks[i].pos).toEqual(spawns[i].pos);
    }
  });

  it('encloses the play area with 4 boundary walls and no corner gaps', () => {
    const { walls } = loadArena(ARENA_01);
    const W = ARENA_01.cols * ARENA_01.cellSize;
    const H = ARENA_01.rows * ARENA_01.cellSize;
    const t = ARENA_01.cellSize;

    // Find the 4 boundary walls (one per edge).
    const boundaries = walls.filter(
      (w) =>
        w.kind === 'solid' &&
        (w.aabb.minX <= 0 || w.aabb.maxX >= W || w.aabb.minY <= 0 || w.aabb.maxY >= H) &&
        (w.aabb.minX < 0 || w.aabb.maxX > W || w.aabb.minY < 0 || w.aabb.maxY > H),
    );
    expect(boundaries.length).toBe(4);

    // Assert exact AABB extent of each boundary: this proves each edge is fully covered.
    // Play area is [0, W] × [0, H]. Boundaries wrap it with thickness t.
    const top = boundaries.find((w) => w.aabb.maxY === 0);
    expect(top).toBeDefined();
    expect(top!.aabb).toEqual({ minX: -t, minY: -t, maxX: W + t, maxY: 0 });

    const bottom = boundaries.find((w) => w.aabb.minY === H);
    expect(bottom).toBeDefined();
    expect(bottom!.aabb).toEqual({ minX: -t, minY: H, maxX: W + t, maxY: H + t });

    const left = boundaries.find((w) => w.aabb.maxX === 0);
    expect(left).toBeDefined();
    expect(left!.aabb).toEqual({ minX: -t, minY: 0, maxX: 0, maxY: H });

    const right = boundaries.find((w) => w.aabb.minX === W);
    expect(right).toBeDefined();
    expect(right!.aabb).toEqual({ minX: W, minY: 0, maxX: W + t, maxY: H });

    // Verify coverage: sample points walked along the outside perimeter (including exact
    // corners and edge midpoints) must each be contained by at least one boundary AABB.
    // This proves there are no gaps where a projectile could escape.
    //
    // The off-edge offset is t/2, not a literal 1: the boundary ring is only `t` thick
    // (t = cellSize, now 2/3, was 2), so a sample point has to land strictly inside that
    // ring to prove coverage. A hardcoded "1 unit out" happened to fit inside the old
    // 2-unit ring but overshoots clean through the new 2/3-unit one, landing in open space
    // beyond it and failing every one of these checks -- not because a wall moved, but
    // because the probe distance was never derived from the ring it was measuring.
    const off = t / 2;
    const samplePointsOnOutside = [
      // Top edge
      { x: 0, y: -off },
      { x: W / 2, y: -off },
      { x: W, y: -off },
      // Bottom edge
      { x: 0, y: H + off },
      { x: W / 2, y: H + off },
      { x: W, y: H + off },
      // Left edge
      { x: -off, y: 0 },
      { x: -off, y: H / 2 },
      { x: -off, y: H },
      // Right edge
      { x: W + off, y: 0 },
      { x: W + off, y: H / 2 },
      { x: W + off, y: H },
      // Exact corners
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: 0, y: H },
      { x: W, y: H },
    ];

    for (const point of samplePointsOnOutside) {
      const covered = boundaries.some(
        (w) =>
          point.x >= w.aabb.minX &&
          point.x <= w.aabb.maxX &&
          point.y >= w.aabb.minY &&
          point.y <= w.aabb.maxY,
      );
      expect(covered).toBe(true);
    }
  });

  it('maps legend chars to the right WallKind and skips empty/spawn chars', () => {
    const { walls } = loadArena(ARENA_01);
    // Every interior wall (not one of the 4 appended boundaries) must come from
    // a '#' (solid) or 'x' (destructible) cell — never from '.' or a spawn char.
    const interior = walls.slice(0, walls.length - 4);
    for (const w of interior) {
      expect(['solid', 'destructible']).toContain(w.kind);
    }
    const solidCells = countChar(ARENA_01.grid, '#');
    const destructibleCells = countChar(ARENA_01.grid, 'x');
    expect(interior.filter((w) => w.kind === 'solid').length).toBe(solidCells);
    expect(interior.filter((w) => w.kind === 'destructible').length).toBe(destructibleCells);
  });

  it('validates that ARENA_01 passes grid dimension and character checks', () => {
    expect(() => loadArena(ARENA_01)).not.toThrow();
  });

  it('numbers tanks independently of how many wall cells precede them', () => {
    // Same spawns, same order, different wall counts. A tank's id must not move.
    const base = {
      cols: 5, rows: 3, cellSize: 2,
      legend: { '#': 'solid' as const },
      grid: ['.....', '..P..', '.....'],
    };
    const walled = { ...base, grid: ['#####', '#.P..', '.....'] };
    const a = loadArena({ id: 'a', ...base } as never);
    const b = loadArena({ id: 'b', ...walled } as never);
    expect(a.tanks.map((t) => t.id)).toEqual(b.tanks.map((t) => t.id));
    // ...and ids are still globally unique, which createWorld's nextId relies on.
    const all = [...b.tanks.map((t) => t.id), ...b.walls.map((w) => w.id)];
    expect(new Set(all).size).toBe(all.length);
  });

  it('throws when grid.length does not match arena.rows', () => {
    const badArena = {
      cols: 3,
      rows: 2,
      cellSize: 2,
      legend: { '#': 'solid' as const },
      grid: ['...', '...', '...'], // 3 rows instead of 2
    };
    expect(() => loadArena(badArena)).toThrow(
      /Grid has 3 rows but Arena declares 2 rows/,
    );
  });

  it('throws when a row.length does not match arena.cols', () => {
    const badArena = {
      cols: 5,
      rows: 2,
      cellSize: 2,
      legend: { '#': 'solid' as const },
      grid: ['.....', '........'], // row 1 has length 8 instead of 5
    };
    expect(() => loadArena(badArena)).toThrow(
      /Row 1 has length 8 but Arena declares 5 columns/,
    );
  });

  it('throws when grid contains an unrecognized character', () => {
    const badArena = {
      cols: 3,
      rows: 2,
      cellSize: 2,
      legend: { '#': 'solid' as const },
      grid: ['...', '.?#'],
    };
    expect(() => loadArena(badArena)).toThrow(
      /Unrecognized character '\?' at \(row 1, col 1\)/,
    );
  });
});

describe('createArenaWorld', () => {
  it('yields a playing world with a player and three enemies', () => {
    const w = createArenaWorld();
    expect(w.status).toBe('playing');
    expect(w.lives).toBe(3);
    expect(w.tanks.filter((t) => t.kind === 'player').length).toBe(1);
    expect(w.tanks.filter((t) => t.kind !== 'player').length).toBe(3);
    expect(w.nextId).toBeGreaterThan(Math.max(...w.walls.map((wall) => wall.id)));
  });

  it('is a smoke-testable World: playing status, LIVES lives, non-empty arrays, one of each kind', () => {
    const w = createArenaWorld();
    expect(w.status).toBe('playing');
    expect(w.lives).toBe(LIVES);
    expect(w.tanks.length).toBeGreaterThan(0);
    expect(w.walls.length).toBeGreaterThan(0);
    expect(w.spawns.length).toBeGreaterThan(0);
    expect(w.tanks.filter((t) => t.kind === 'player').length).toBe(1);
    expect(w.tanks.filter((t) => t.kind === 'brown').length).toBe(1);
    expect(w.tanks.filter((t) => t.kind === 'grey').length).toBe(1);
    expect(w.tanks.filter((t) => t.kind === 'teal').length).toBe(1);
  });

  it('steps without throwing and stays in playing status under no-op input', () => {
    let world = createArenaWorld();
    const startTick = world.tick;
    const noInput: InputState = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false };
    // Must clear the round's countdown + grace phases (nobody can fire until then) with
    // margin to spare, so Teal gets a real chance to fire once normal play begins.
    const stepCount = COUNTDOWN_TICKS + GRACE_TICKS + 10;

    let tealShotAppeared = false;
    const tealId = world.tanks.find((t) => t.kind === 'teal')?.id;
    expect(tealId).toBeDefined();

    expect(() => {
      for (let i = 0; i < stepCount; i++) {
        world = step(world, noInput).world;
        // Round-phase guard: nobody, not even the AI, may have fired yet while still in
        // the countdown/grace window of the assembled arena's own real timing.
        if (world.tick < COUNTDOWN_TICKS + GRACE_TICKS) {
          expect(world.bullets.length).toBe(0);
        }
        // Latch: check if Teal has fired a bullet (at least one bullet with Teal's id as owner).
        if (!tealShotAppeared && world.bullets.some((b) => b.ownerId === tealId)) {
          tealShotAppeared = true;
        }
      }
    }).not.toThrow();

    expect(world.status).toBe('playing');
    expect(world.tick).toBe(startTick + stepCount);
    expect(tealShotAppeared).toBe(true);
  });
});
