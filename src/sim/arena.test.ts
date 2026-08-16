import { describe, it, expect } from 'vitest';
import { ARENA_01, ARENAS, arenaBounds, arenaById, loadArena, createArenaWorld } from './arena';
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
  // Regression pin, written and passing BEFORE loadArena grew a playerCount param's
  // real logic: at playerCount 1 (the default, and passed explicitly), output must
  // stay byte-identical to today's single-arg call -- across all 5 shipped arenas,
  // not just ARENA_01, since the co-op spawn-offset rule reads every arena's own
  // grid. This is the claim CLAUDE.md's arena.ts section calls "stronger than the
  // prototype made": conditional controlledBy stamping means PASS 1a is the ENTIRE
  // function body relevant to spawns at playerCount 1, so nothing here should ever
  // need editing when PASS 1b (playerCount > 1) lands.
  it('at playerCount 1 (default and explicit) is byte-identical to the single-arg call, on all 5 shipped arenas', () => {
    ARENAS.forEach((arena, i) => {
      const noArg = loadArena(arena);
      const explicit1 = loadArena(arena, 1);
      expect(explicit1, `ARENAS[${i}]`).toEqual(noArg);
      for (const t of noArg.tanks) {
        expect(t.controlledBy, `ARENAS[${i}] tank ${t.id}`).toBeUndefined();
      }
    });
  });

  it('produces the interior walls plus exactly 4 solid boundary walls', () => {
    const { walls } = loadArena(ARENA_01);
    const destructibleCells = countChar(ARENA_01.grid, 'x');

    // Solid cells merge into maximal rectangles (mergeSolidRuns, arena.ts) before
    // becoming walls, so raw '#' cell count no longer predicts solid wall count --
    // only destructible cells (never merged) still map 1:1. mergedSolidBoxes is
    // measured directly by running loadArena against ARENA_01's current grid, not
    // re-derived from raw cell count (which would just re-run the merge in the test).
    const mergedSolidBoxes = 5;

    expect(walls.length).toBe(mergedSolidBoxes + destructibleCells + 4);

    const destructible = walls.filter((w) => w.kind === 'destructible');
    const solid = walls.filter((w) => w.kind === 'solid');
    expect(destructible.length).toBe(destructibleCells);
    expect(solid.length).toBe(mergedSolidBoxes + 4); // interior solids + 4 boundaries
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

  // Measured directly (ring 1, cellsNeeded=2 at the shipped cellSize 2/3, all 8
  // RING_DIRECTIONS in priority order): the FIRST candidate, E (+2 cols, +0 rows),
  // is open ('.', in-bounds) in all 5 of 5 shipped arenas. arena-01/02/03 share a P
  // spawn at (row 22, col 16) and resolve P2 to (row 22, col 18); arena-04/05 share
  // (row 28, col 22) and resolve to (row 28, col 24). Zero grid edits needed.
  it('resolves P2 to the measured E-ring cell on every shipped arena, with controlledBy 0/1', () => {
    const cases: [string, number, number][] = [
      ['arena-01', 22, 18],
      ['arena-02', 22, 18],
      ['arena-03', 22, 18],
      ['arena-04', 28, 24],
      ['arena-05', 28, 24],
    ];
    for (const [id, row, col] of cases) {
      const arena = arenaById(id);
      const { tanks } = loadArena(arena, 2);
      const players = tanks.filter((t) => t.kind === 'player');
      expect(players, id).toHaveLength(2);

      const p1 = players.find((t) => t.controlledBy === 0)!;
      const p2 = players.find((t) => t.controlledBy === 1)!;
      expect(p1, id).toBeDefined();
      expect(p2, id).toBeDefined();

      const expectedPos = { x: (col + 0.5) * arena.cellSize, y: (row + 0.5) * arena.cellSize };
      expect(p2.pos, id).toEqual(expectedPos);
      expect(p2.alive, id).toBe(true);
    }
  });

  // Measured directly (ring 1, cellsNeeded=2, all 8 RING_DIRECTIONS in priority order),
  // per the N-player plan's red-first step: `loadArena(arena, 3)` and `loadArena(arena,
  // 4)` on all 5 shipped arenas, asserting the CONCRETE resolved cell rather than merely
  // "found one". On every one of the 5, P3's ring-1-S candidate (dist 2, direction
  // [0,1]) and P4's ring-1-W candidate (dist 2, direction [-1,0]) are BOTH open -- no
  // arena falls through to ring 2 or the co-locate fallback, so those paths stay
  // reachable only through the synthetic fixtures below.
  it('resolves P3 to the measured ring-1-S cell and P4 to ring-1-W, on every shipped arena', () => {
    const cases: [string, number, number][] = [
      ['arena-01', 22, 16],
      ['arena-02', 22, 16],
      ['arena-03', 22, 16],
      ['arena-04', 28, 22],
      ['arena-05', 28, 22],
    ];
    for (const [id, p1Row, p1Col] of cases) {
      const arena = arenaById(id);
      const { tanks } = loadArena(arena, 4);
      const players = tanks.filter((t) => t.kind === 'player');
      expect(players, id).toHaveLength(4);

      const p3 = players.find((t) => t.controlledBy === 2)!;
      const p4 = players.find((t) => t.controlledBy === 3)!;
      expect(p3, id).toBeDefined();
      expect(p4, id).toBeDefined();

      // Ring-1-S: (p1Row + 2, p1Col).
      const p3Expected = {
        x: (p1Col + 0.5) * arena.cellSize, y: (p1Row + 2 + 0.5) * arena.cellSize,
      };
      // Ring-1-W: (p1Row, p1Col - 2).
      const p4Expected = {
        x: (p1Col - 2 + 0.5) * arena.cellSize, y: (p1Row + 0.5) * arena.cellSize,
      };
      expect(p3.pos, id).toEqual(p3Expected);
      expect(p3.alive, id).toBe(true);
      expect(p4.pos, id).toEqual(p4Expected);
      expect(p4.alive, id).toBe(true);
    }
  });

  it('resolves N=3 identically to N=4\'s own first three slots (P3 does not move when a 4th player joins)', () => {
    for (const id of ['arena-01', 'arena-02', 'arena-03', 'arena-04', 'arena-05']) {
      const arena = arenaById(id);
      const three = loadArena(arena, 3).tanks.filter((t) => t.kind === 'player');
      const four = loadArena(arena, 4).tanks.filter((t) => t.kind === 'player');
      expect(three, id).toHaveLength(3);
      for (const t of three) {
        const match = four.find((f) => f.controlledBy === t.controlledBy)!;
        expect(match.pos, `${id} slot ${t.controlledBy}`).toEqual(t.pos);
      }
    }
  });

  it('appends P2 strictly after every enemy, so every enemy id is unchanged from playerCount 1', () => {
    for (const arena of ARENAS) {
      const single = loadArena(arena, 1);
      const coop = loadArena(arena, 2);
      const singleEnemyIds = single.tanks.filter((t) => t.kind !== 'player').map((t) => t.id);
      const coopEnemyIds = coop.tanks.filter((t) => t.kind !== 'player').map((t) => t.id);
      expect(coopEnemyIds).toEqual(singleEnemyIds);

      // P2 is the LAST tank, appended after PASS 1a finished.
      const last = coop.tanks[coop.tanks.length - 1];
      expect(last.kind).toBe('player');
      expect(last.controlledBy).toBe(1);

      // And its id CONTINUES the shared counter with no gap or reuse -- one `id`
      // variable threads PASS 1a -> 1b -> the wall pass, and this is what keeps every
      // wall id merely SHIFTED (not scrambled) at playerCount 2. Breaks if PASS 1b
      // ever grows its own counter.
      const maxSingleId = Math.max(...single.tanks.map((t) => t.id));
      expect(last.id).toBe(maxSingleId + 1);
      expect(coop.walls[0]?.id ?? last.id + 1).toBe(last.id + 1);
    }
  });

  describe('co-op spawn, ring-expansion and the co-locate fallback (synthetic fixtures)', () => {
    // cellSize 2/3 matches every shipped arena, so cellsNeeded (ceil(1.0 / 0.6667) = 2)
    // matches production. No shipped arena is cramped enough to reach ring-expansion
    // or the fallback, so these are the only way to exercise that code at all.
    const CELL_SIZE = 2 / 3;

    it('reaches ring 2 when ring 1 is fully blocked', () => {
      // P at (2,2). Ring 1 (dist 2) candidates all land on row/col 0 or 4 -- surround
      // those with '#' so every ring-1 direction is blocked, leaving only ring 2
      // (dist 4) open, which is out of a 5x5 grid on every axis except staying at
      // distance 4 wraps out of bounds too -- so use a 9x9 grid instead so ring 2 has
      // room to land in-bounds.
      const cols = 9, rows = 9;
      const grid: string[] = [];
      for (let r = 0; r < rows; r++) {
        let row = '';
        for (let c = 0; c < cols; c++) {
          if (r === 4 && c === 4) row += 'P';
          else row += '.';
          }
        grid.push(row);
      }
      // Ring 1 = distance 2 from (4,4): block every one of the 8 ring-1 cells.
      const ring1: [number, number][] = [
        [6, 4], [4, 6], [2, 4], [4, 2], [6, 6], [2, 6], [6, 2], [2, 2],
      ];
      for (const [r, c] of ring1) {
        grid[r] = grid[r].slice(0, c) + '#' + grid[r].slice(c + 1);
      }
      const arena = { cols, rows, cellSize: CELL_SIZE, legend: { '#': 'solid' as const }, grid } as never;
      const { tanks } = loadArena(arena, 2);
      const p2 = tanks.find((t) => t.controlledBy === 1)!;
      expect(p2).toBeDefined();
      // Ring 2 = distance 4, first direction E: (row 4, col 8).
      expect(p2.pos).toEqual({ x: (8 + 0.5) * CELL_SIZE, y: (4 + 0.5) * CELL_SIZE });
    });

    it('co-locates P2 with P1 when every ring (1..4) is fully boxed in solid walls', () => {
      // P boxed in on all sides within reach of any of the 4 searched rings: an 11x11
      // grid with every non-P cell solid guarantees no ring candidate is ever '.'.
      const cols = 11, rows = 11;
      const grid: string[] = [];
      for (let r = 0; r < rows; r++) {
        let row = '';
        for (let c = 0; c < cols; c++) row += (r === 5 && c === 5) ? 'P' : '#';
        grid.push(row);
      }
      const arena = { cols, rows, cellSize: CELL_SIZE, legend: { '#': 'solid' as const }, grid } as never;
      const { tanks } = loadArena(arena, 2);
      const p1 = tanks.find((t) => t.controlledBy === 0)!;
      const p2 = tanks.find((t) => t.controlledBy === 1)!;
      expect(p2.pos).toEqual(p1.pos);
    });

    it('N=4: P2 fills ring-1-E; P3, with every OTHER ring-1 direction blocked, escalates ' +
      'to ring-2-E; P4, finding ring-2-E already claimed by P3, escalates further to ' +
      'ring-2-S -- ring expansion and the `claimed` set both exercised past N=2', () => {
      // P at (4,4) in a 9x9 grid (room for ring-2, dist 4, to land in-bounds on every
      // axis). Every ring-1 cell EXCEPT E is walled, so P2's own ring-1-E search still
      // succeeds immediately (unchanged from N=2), but P3 -- finding E already in
      // `claimed` -- has nowhere left in ring 1 and must escalate.
      const cols = 9, rows = 9;
      const grid: string[] = [];
      for (let r = 0; r < rows; r++) {
        let row = '';
        for (let c = 0; c < cols; c++) row += (r === 4 && c === 4) ? 'P' : '.';
        grid.push(row);
      }
      // Ring 1 (dist 2) cells, every direction except E (4,6).
      const blocked: [number, number][] = [
        [6, 4], [4, 2], [2, 4], [6, 6], [6, 2], [2, 6], [2, 2], // S, W, N, SE, SW, NE, NW
      ];
      for (const [r, c] of blocked) {
        grid[r] = grid[r].slice(0, c) + '#' + grid[r].slice(c + 1);
      }
      const arena = { cols, rows, cellSize: CELL_SIZE, legend: { '#': 'solid' as const }, grid } as never;
      const { tanks } = loadArena(arena, 4);
      const players = new Map(
        tanks.filter((t) => t.kind === 'player').map((t) => [t.controlledBy, t]),
      );
      expect(players.size).toBe(4);

      // P2: ring-1-E, unchanged from the N=2 fixture above.
      expect(players.get(1)!.pos).toEqual({ x: (6 + 0.5) * CELL_SIZE, y: (4 + 0.5) * CELL_SIZE });
      // P3: every ring-1 direction is blocked or (for E) claimed -- ring-2-E, (row 4, col 8).
      expect(players.get(2)!.pos).toEqual({ x: (8 + 0.5) * CELL_SIZE, y: (4 + 0.5) * CELL_SIZE });
      // P4: ring-1 exhausted the same way, and ring-2-E is now claimed by P3 -- the next
      // direction in ring-2 priority order, S, (row 8, col 4), is open.
      expect(players.get(3)!.pos).toEqual({ x: (4 + 0.5) * CELL_SIZE, y: (8 + 0.5) * CELL_SIZE });
    });

    it('N=4, fully boxed: P2, P3 AND P4 all co-locate with P1 at the SAME cell -- the ' +
      'fallback does not check `claimed`, unlike every ring search above it', () => {
      const cols = 11, rows = 11;
      const grid: string[] = [];
      for (let r = 0; r < rows; r++) {
        let row = '';
        for (let c = 0; c < cols; c++) row += (r === 5 && c === 5) ? 'P' : '#';
        grid.push(row);
      }
      const arena = { cols, rows, cellSize: CELL_SIZE, legend: { '#': 'solid' as const }, grid } as never;
      const { tanks } = loadArena(arena, 4);
      const players = new Map(
        tanks.filter((t) => t.kind === 'player').map((t) => [t.controlledBy, t]),
      );
      expect(players.size).toBe(4);
      const p1Pos = players.get(0)!.pos;
      expect(players.get(1)!.pos).toEqual(p1Pos);
      expect(players.get(2)!.pos).toEqual(p1Pos);
      expect(players.get(3)!.pos).toEqual(p1Pos);
    });
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
    const destructibleCells = countChar(ARENA_01.grid, 'x');
    // Merged, per the previous test's comment: raw '#' count no longer predicts
    // solid wall count once adjacent solid cells merge into maximal rectangles.
    const mergedSolidBoxes = 5;
    expect(interior.filter((w) => w.kind === 'solid').length).toBe(mergedSolidBoxes);
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

  it('emits one wall per maximal solid rectangle', () => {
    const a = loadArena({
      id: 'run', cols: 5, rows: 3, cellSize: 2,
      legend: { '#': 'solid' as const },
      grid: ['###..', '.....', '.....'],
    } as never);
    // 3 cells in a row -> ONE wall spanning them, plus the 4 boundary walls appended
    // last (same convention as the 'maps legend chars' test below). A minX/minY >= 0
    // filter looks equivalent but is not: the right boundary sits at minX = W (here
    // 10), minY = 0 -- both non-negative -- so it leaks through and silently inflates
    // this to 2 regardless of whether the merge is correct. slice(0, -4) has no such
    // edge case.
    const interior = a.walls.slice(0, -4);
    expect(interior).toHaveLength(1);
    expect(interior[0].aabb).toEqual({ minX: 0, minY: 0, maxX: 6, maxY: 2 });
  });

  it('never merges destructible cells, which are destruction units', () => {
    const a = loadArena({
      id: 'bar', cols: 5, rows: 3, cellSize: 2,
      legend: { x: 'destructible' as const },
      grid: ['xxx..', '.....', '.....'],
    } as never);
    const dest = a.walls.filter((w) => w.kind === 'destructible');
    expect(dest).toHaveLength(3);
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
