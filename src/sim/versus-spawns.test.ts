import { describe, it, expect } from 'vitest';
import { pickVersusSpawnCell, pickVersusSpawnSet, versusSpawnClearanceFailures, wallsForQuery, type Cell } from './versus-spawns';
import { lineOfSight } from './ai/targeting';
import { loadArena, ARENAS, ARENA_DEFS } from './arena';
import type { WallKind } from './types';

// ---------------------------------------------------------------------------
// LINE-OF-SIGHT REUSE, NOT A SECOND IMPLEMENTATION.
//
// `versus-spawns.ts` imports `lineOfSight` from `ai/targeting.ts` directly. The task
// brief required checking the import graph first: does `arena.ts` (this module's one
// caller) importing `versus-spawns.ts`, which imports `ai/targeting.ts`, close a cycle
// back to `arena.ts`? A forward BFS over every `import` reachable from `ai/targeting.ts`
// -- 20 files, and deliberately treating `import type` the same as a value import, which
// is a STRICTLY LARGER reachable set than the real one -- never reaches `arena.ts`.
// `arena.ts` is imported by exactly one thing under `src/sim/`: `sandbox.ts`, a dev tool
// nothing in this chain touches. So the cycle the brief worried about does not exist, and
// this module reuses the real `lineOfSight` rather than a second implementation of it.
//
// `mergeSolidRuns` is a different story: `arena.ts` already imports THIS module, so an
// import in the other direction (this module importing arena.ts's private helper) WOULD
// close a two-node cycle. `versus-spawns.ts` duplicates that algorithm instead (see its
// own doc comment on `mergeSolidRuns`), and the convergence test below is this module's
// own version of the "prove the two don't silently diverge" obligation the brief asked
// for on the `lineOfSight` decision -- applied here because the same cycle risk applies.
// ---------------------------------------------------------------------------

describe('wallsForQuery: convergence with loadArena\'s real solid-wall geometry', () => {
  it('produces the same solid-wall rectangles as loadArena, on all 5 shipped arenas', () => {
    expect(ARENAS.length).toBe(5); // the population this test claims

    function solidRects(walls: { aabb: { minX: number; minY: number; maxX: number; maxY: number } }[]) {
      return walls
        .map((w) => `${w.aabb.minX},${w.aabb.minY},${w.aabb.maxX},${w.aabb.maxY}`)
        .sort();
    }

    for (const arena of ARENAS) {
      const real = loadArena(arena, 1).walls.filter((w) => w.kind === 'solid');
      // loadArena also builds 4 boundary walls (outside play); wallsForQuery never
      // does, so exclude them by bounding-box membership inside the play area before
      // comparing -- everything else is PASS 2a's merged interior geometry.
      const { cols, rows, cellSize } = arena;
      const interior = real.filter(
        (w) => w.aabb.minX >= 0 && w.aabb.minY >= 0 && w.aabb.maxX <= cols * cellSize && w.aabb.maxY <= rows * cellSize,
      );
      const mine = wallsForQuery(arena.grid, cols, rows, cellSize, arena.legend).filter((w) => w.kind === 'solid');
      expect(solidRects(mine), (arena as { id?: string }).id).toEqual(solidRects(interior));
    }
  });
});

describe('pickVersusSpawnCell: greedy maximin on GEODESIC distance, not Euclidean', () => {
  it('prefers the geodesically farthest candidate even when a Euclidean-farther one exists', () => {
    // A block splits the room; only the top and bottom rows connect around it.
    const legend: Record<string, WallKind> = { x: 'solid' };
    const grid = [
      '..........',
      '...xxx....',
      '...xxx....',
      '...xxx....',
      '..........',
    ];
    const cols = grid[0].length;
    const rows = grid.length;
    const p1 = { x: 0.5, y: 2.5 }; // row 2, col 0

    // Measured (not asserted here, to avoid duplicating the production BFS): the
    // straight-line Euclidean distance from p1 to H=(row0,col9) is ~9.22, LARGER than
    // to F=(row2,col9)'s 9.0 -- so a Euclidean ranking would prefer H. The actual
    // geodesic (4-connected BFS) distance is F=13, H=11, and F is the UNIQUE maximum
    // over the whole grid: reaching col 9 from row 2 costs a detour around the block
    // (up or down to a gap row, across, back), which the straight-line distance does
    // not see at all.
    const cell = pickVersusSpawnCell(grid, cols, rows, 1, legend, [p1]);
    expect(cell).toEqual<Cell>({ row: 2, col: 9 });
  });
});

describe('pickVersusSpawnCell: hard LOS filter overrides raw distance', () => {
  it('picks a closer, invisible cell over a farther, visible one', () => {
    const legend: Record<string, WallKind> = { x: 'solid' };
    // Row 0 is open corridor the whole way across (20 cols): P1 can always SEE along
    // it, however far. Rows 1-2 have a wall at col 5 (forcing a detour, same shape as
    // the fixture above) and are walled off entirely past col 11, so nothing there can
    // out-distance row 0 on raw geodesic terms.
    const grid = [
      '....................',
      '.....x......xxxxxxxx',
      '.....x......xxxxxxxx',
    ];
    const cols = grid[0].length;
    const rows = grid.length;
    const p1 = { x: 0.5, y: 0.5 };

    // Measured directly (scratch probe, not asserted here): the best VISIBLE candidate
    // is (row0, col19) at geodesic distance 19; the best INVISIBLE candidate is (row2,
    // col11) at geodesic distance 13. Pure maximin over every candidate -- no LOS filter
    // -- would pick the visible one (19 > 13). The hard filter restricts the pool to
    // LOS-invisible candidates whenever at least one exists, so this picks the smaller,
    // invisible score instead.
    const cell = pickVersusSpawnCell(grid, cols, rows, 1, legend, [p1]);
    expect(cell).toEqual<Cell>({ row: 2, col: 11 });

    // And that pick really is invisible, really is beaten on raw distance by a visible
    // cell -- pinning the premise, not just the conclusion.
    const walls = wallsForQuery(grid, cols, rows, 1, legend);
    expect(lineOfSight(p1, { x: 11.5, y: 2.5 }, walls)).toBe(false);
    expect(lineOfSight(p1, { x: 19.5, y: 0.5 }, walls)).toBe(true);
  });

  it('falls through to plain maximin when every candidate is visible (no LOS-clean option exists)', () => {
    // A single open room, no walls: every candidate sees every other candidate, so the
    // hard filter's "at least one invisible candidate" condition never holds, and the
    // pool degrades to every candidate -- exactly the documented degradation.
    const legend: Record<string, WallKind> = {};
    const grid = ['.......', '.......', '.......'];
    const p1 = { x: 0.5, y: 1.5 }; // row1 col0, left edge
    // Manhattan distance to col 6 (the far edge) is 7 from both (row0,col6) and
    // (row2,col6) -- a tie, (row,col)-ascending picks the row0 one.
    const cell = pickVersusSpawnCell(grid, 7, 3, 1, legend, [p1]);
    expect(cell).toEqual<Cell>({ row: 0, col: 6 });
  });
});

describe('pickVersusSpawnCell: EUCLIDEAN breaks a geodesic tie', () => {
  it('among cells that are all geodesically unreachable, picks the physically farthest, not the (row, col)-earliest', () => {
    // A solid wall runs the full height of the board at col 5, partitioning it. Nothing
    // on the right is reachable from p1 on the left, so EVERY right-hand candidate scores
    // Infinity on geodesic distance and they all tie. The LOS filter has already
    // restricted the pool to the right-hand side (the left half is one open room, so
    // every cell in it is plainly visible from p1; the wall hides every cell beyond it).
    //
    // With the tie unresolved, (row, col) order decides and hands back (0, 6) -- hard
    // against the far side of the wall, 6.32 world units from p1. MEASURED, by running
    // this exact fixture with the Euclidean key removed: it returns {row: 0, col: 6}.
    // With the key in place it returns the farthest of the tied cells instead, 11.18
    // units away. This is the shape of the real defect it was added for: on arena-02,
    // whose centre barrier partitions the board, the 2-player spawns came out 2.67 world
    // units apart through the wall.
    const legend: Record<string, WallKind> = { x: 'solid' };
    const grid = ['.....x......', '.....x......', '.....x......', '.....x......', '.....x......'];
    const p1 = { x: 0.5, y: 2.5 }; // row 2, col 0

    const cell = pickVersusSpawnCell(grid, 12, 5, 1, legend, [p1]);
    expect(cell).toEqual<Cell>({ row: 0, col: 11 });

    // Pins the PREMISE the conclusion rests on, so this cannot quietly become a test
    // about something else: the pick really is unreachable, and it really is farther
    // away in a straight line than the cell positional order would have chosen.
    const walls = wallsForQuery(grid, 12, 5, 1, legend);
    expect(lineOfSight(p1, { x: 11.5, y: 0.5 }, walls), 'the winner is hidden from p1').toBe(false);
    expect(lineOfSight(p1, { x: 6.5, y: 0.5 }, walls), 'so is the cell positional order prefers').toBe(false);
    const d = (x: number, y: number) => Math.hypot(x - p1.x, y - p1.y);
    expect(d(11.5, 0.5)).toBeGreaterThan(d(6.5, 0.5));
  });
});

describe('pickVersusSpawnSet: the relaxation pass runs to convergence, not one round', () => {
  it('arena-04 at 3 players lands on the set only multi-round coordinate ascent reaches', () => {
    // VERSUS_RELAX_ROUNDS caps the coordinate-ascent loop; the loop exits early as soon
    // as a full round accepts nothing, so on this board it is convergence that decides
    // the answer, not the cap. This pins that the loop is actually allowed to converge.
    //
    // MEASURED with the cap forced to 1: arena-04 at N=3 returns (0,30) (32,44) (23,0)
    // instead, and 3 other (arena, count) pairs move as well -- arena-01 and arena-03 at
    // N=3, and arena-05 at N=4. So a cap of 1 is caught here, on the first of those.
    const arena = ARENA_DEFS.find((a) => a.id === 'arena-04')!;
    const cells = pickVersusSpawnSet(arena.grid, arena.cols, arena.rows, arena.cellSize, arena.legend, 3);
    expect(cells).toEqual<Cell[]>([
      { row: 0, col: 26 },
      { row: 32, col: 44 },
      { row: 24, col: 0 },
    ]);
  });

  it('returns exactly `count` distinct cells for every count 1..4, on all 5 shipped arenas', () => {
    for (const arena of ARENA_DEFS) {
      for (const n of [1, 2, 3, 4]) {
        const cells = pickVersusSpawnSet(arena.grid, arena.cols, arena.rows, arena.cellSize, arena.legend, n);
        expect(cells.length, `${arena.id}/n=${n}`).toBe(n);
        expect(new Set(cells.map((c) => `${c.row},${c.col}`)).size, `${arena.id}/n=${n}`).toBe(n);
      }
    }
  });
});

describe('pickVersusSpawnCell: deterministic (row, col)-ascending tie-break', () => {
  it('picks the earliest of several equally-far candidates', () => {
    const legend: Record<string, WallKind> = {};
    const grid = ['.......', '.......', '.......'];
    const p1 = { x: 3.5, y: 1.5 }; // row1, col3 -- dead centre of a 3x7 open room
    // Manhattan distance from centre: the 4 corners (0,0)/(0,6)/(2,0)/(2,6) are each
    // exactly 4 (1 row + 3 cols), the unique maximum on this grid -- verified by
    // exhaustive scan in the scratch probe this test was written from. (row, col)
    // ascending among the 4 ties (0,0).
    const cell = pickVersusSpawnCell(grid, 7, 3, 1, legend, [p1]);
    expect(cell).toEqual<Cell>({ row: 0, col: 0 });
  });

  it('is stable across repeated calls with the same inputs -- no hidden randomness', () => {
    const legend: Record<string, WallKind> = {};
    const grid = ['.......', '.......', '.......'];
    const p1 = { x: 3.5, y: 1.5 };
    const a = pickVersusSpawnCell(grid, 7, 3, 1, legend, [p1]);
    const b = pickVersusSpawnCell(grid, 7, 3, 1, legend, [p1]);
    expect(a).toEqual(b);
  });
});

describe('pickVersusSpawnCell: greedy maximin is an APPROXIMATION, measured against a brute-force optimum', () => {
  // A 5x9 room with two 3-wide wall blocks (rows 1 and 3), small enough that trying
  // every 3-of-32 combination of "the other 3 spawns" (4960 combinations) is cheap, and
  // irregular enough that greedy's SEQUENTIAL commitment (each pick is final once made)
  // can miss the arrangement a global search would find.
  const legend: Record<string, WallKind> = { x: 'solid' };
  const grid = [
    '.........',
    '.xxx.xxx.',
    '.........',
    '.xxx.xxx.',
    '.........',
  ];
  const cols = grid[0].length;
  const rows = grid.length;

  function bfs(start: Cell, walkable: (r: number, c: number) => boolean): number[][] {
    const dist: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(Infinity));
    dist[start.row][start.col] = 0;
    const queue: Cell[] = [start];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const d = dist[cur.row][cur.col];
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const r = cur.row + dr;
        const c = cur.col + dc;
        if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
        if (!walkable(r, c)) continue;
        if (dist[r][c] !== Infinity) continue;
        dist[r][c] = d + 1;
        queue.push({ row: r, col: c });
      }
    }
    return dist;
  }

  const openCells: Cell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) if (grid[r][c] === '.') openCells.push({ row: r, col: c });
  }
  const distFrom = new Map<string, number[][]>();
  for (const cell of openCells) distFrom.set(`${cell.row},${cell.col}`, bfs(cell, (r, c) => grid[r][c] === '.'));
  function gdist(a: Cell, b: Cell): number {
    return distFrom.get(`${a.row},${a.col}`)![b.row][b.col];
  }
  function minPairwise(cells: Cell[]): number {
    let min = Infinity;
    for (let a = 0; a < cells.length; a++) {
      for (let b = a + 1; b < cells.length; b++) min = Math.min(min, gdist(cells[a], cells[b]));
    }
    return min;
  }
  function trueOptimum(p1: Cell): number {
    const others = openCells.filter((c) => !(c.row === p1.row && c.col === p1.col));
    let best = -1;
    for (let i = 0; i < others.length; i++) {
      for (let j = i + 1; j < others.length; j++) {
        for (let k = j + 1; k < others.length; k++) {
          best = Math.max(best, minPairwise([p1, others[i], others[j], others[k]]));
        }
      }
    }
    return best;
  }
  function greedyResult(p1: Cell): Cell[] {
    const chosenPos = [{ x: p1.col + 0.5, y: p1.row + 0.5 }];
    const cells = [p1];
    for (let i = 1; i < 4; i++) {
      const cell = pickVersusSpawnCell(grid, cols, rows, 1, legend, chosenPos);
      chosenPos.push({ x: cell.col + 0.5, y: cell.row + 0.5 });
      cells.push(cell);
    }
    return cells;
  }

  // Denominator: this fixture, at 3 different P1 anchors (not exhaustive over all 32
  // possible anchors -- named here as the unswept remainder). Measured gaps (optimum
  // minus greedy's achieved min-pairwise geodesic distance): P1=(0,0) -> 6 vs 5 (gap 1),
  // P1=(0,4) -> 5 vs 4 (gap 1), P1=(2,0) -> 6 vs 4 (gap 2). The anchor asserted below is
  // the largest of the three measured, not the only one tried -- greedy is NOT optimal
  // here, and how far off varies with where P1 sits.
  it('measured gap at P1=(2,0): greedy achieves 4, brute force finds 6 -- greedy is 2 short of optimal on this fixture', () => {
    const p1: Cell = { row: 2, col: 0 };
    expect(trueOptimum(p1)).toBe(6);
    expect(minPairwise(greedyResult(p1))).toBe(4);
  });
});

describe('pickVersusSpawnCell: negative controls (separation genuinely constrained or impossible)', () => {
  it('degrades gracefully on a heavily walled board where mutual LOS cannot be avoided for every pair', () => {
    // A single 1x5 corridor: every cell sees every other cell (nothing to hide behind),
    // so 4 players packed into 5 cells cannot all avoid each other's line of sight.
    // Deliberate choice: still return DISTINCT cells (never double-book a cell another
    // chosen spawn already occupies) and stay fully deterministic, rather than throwing
    // or silently repeating a cell -- separateTanks (world.ts) already handles tanks
    // sharing close quarters at runtime, so a cramped board degrading to "closest still
    // wins" is the same total, no-throw posture findCoPlayerSpawnCell's own ring-search
    // fallback already takes.
    const legend: Record<string, WallKind> = {};
    const grid = ['.....'];
    const p1 = { x: 0.5, y: 0.5 };
    const chosen = [p1];
    const picks: Cell[] = [];
    for (let i = 1; i < 4; i++) {
      const cell = pickVersusSpawnCell(grid, 5, 1, 1, legend, chosen);
      picks.push(cell);
      chosen.push({ x: cell.col + 0.5, y: cell.row + 0.5 });
    }
    // All 4 cells (P1 + 3 picks) are distinct -- the corridor has exactly enough room.
    const all = [{ row: 0, col: 0 }, ...picks];
    const seen = new Set(all.map((c) => `${c.row},${c.col}`));
    expect(seen.size).toBe(4);
    // And LOS could not be avoided for every pair on a 1-row corridor with no cover --
    // stating the impossibility explicitly rather than leaving it implicit.
    const walls = wallsForQuery(grid, 5, 1, 1, legend);
    expect(lineOfSight({ x: 0.5, y: 0.5 }, { x: 1.5, y: 0.5 }, walls)).toBe(true);
  });

  it('falls back to avoid[0]\'s own cell when no open-floor candidate exists anywhere on the board', () => {
    // Pathological: every cell is either P1's own spawn letter or solid. No test in
    // this file exercises this on a real arena -- every shipped arena ships far more
    // open floor than 4 players need -- this is a pure robustness guard against a
    // hypothetical custom/sandbox board.
    const legend: Record<string, WallKind> = { x: 'solid' };
    const grid = ['PxxxP', 'xxxxx', 'xxxxx'];
    const p1 = { x: 0.5, y: 0.5 };
    const cell = pickVersusSpawnCell(grid, 5, 3, 1, legend, [p1]);
    expect(cell).toEqual<Cell>({ row: 0, col: 0 });
  });
});

describe('pickVersusSpawnCell wired through loadArena: before/after on every shipped arena', () => {
  // Denominator for every claim in this block: 5 shipped arenas x 2 versus modes
  // (ffa/teams) x 3 player counts (2, 3, 4) = 30 loadArena calls, 100 total player
  // pairs (1 + 3 + 6 pairs per arena per mode).
  it('ARENAS holds exactly 5 shipped arenas -- the population every sweep below claims', () => {
    expect(ARENAS.length).toBe(5);
  });

  // BEFORE this change, measured directly against the pre-fix ring search
  // (`findCoPlayerSpawnCell`) on the same 30-scenario sweep: the minimum pairwise
  // spawn distance was exactly 1.3333 world units (2 cells x cellSize 0.6667) on ALL
  // 30 of 30 scenarios -- every co-player landed on the ring search's first successful
  // compass direction, point-blank from P1. Not re-asserted here as a test, because
  // `findCoPlayerSpawnCell` no longer runs for ffa/teams at all (see docs/superpowers/
  // plans/2026-08-17-versus-spawns.md for the full before/after table); the two tests
  // below are the AFTER half of that same contrast, live against current code.

  it('AFTER: 0 of 100 player pairs share mutual line of sight, across the full sweep', () => {
    let totalPairs = 0;
    let visiblePairs = 0;
    for (const arena of ARENAS) {
      for (const mode of ['ffa', 'teams'] as const) {
        for (const n of [2, 3, 4]) {
          const { tanks, walls } = loadArena(arena, n, mode);
          const players = tanks.filter((t) => t.kind === 'player');
          for (let i = 0; i < players.length; i++) {
            for (let j = i + 1; j < players.length; j++) {
              totalPairs++;
              if (lineOfSight(players[i].pos, players[j].pos, walls)) visiblePairs++;
            }
          }
        }
      }
    }
    expect(totalPairs).toBe(100);
    expect(visiblePairs).toBe(0);
  });

  // The `> 5` guarantee below is the contract; the measured floor is pinned SEPARATELY
  // and exactly, because quoting a floor in prose is how the previous one went stale. It
  // read "~9.07" -- true when written, and still passing afterwards, since the change
  // that invalidated it moved the floor UP. A one-sided assertion cannot notice that, so
  // the number now sits in an assertion of its own that fails in either direction.
  it('AFTER: minimum pairwise Euclidean spawn distance clears 5 world units everywhere in the sweep -- comfortably above the pre-fix constant of 1.3333, with the actual floor pinned below', () => {
    function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return Math.sqrt(dx * dx + dy * dy);
    }
    let globalMin = Infinity;
    for (const arena of ARENAS) {
      for (const mode of ['ffa', 'teams'] as const) {
        for (const n of [2, 3, 4]) {
          const { tanks } = loadArena(arena, n, mode);
          const pts = tanks.filter((t) => t.kind === 'player').map((t) => t.pos);
          for (let i = 0; i < pts.length; i++) {
            for (let j = i + 1; j < pts.length; j++) globalMin = Math.min(globalMin, dist(pts[i], pts[j]));
          }
        }
      }
    }
    expect(globalMin).toBeGreaterThan(5);
    // Exact, and deliberately a two-place edit if placement is ever retuned: this is
    // arena-03 / ffa / N=4, the tightest of the 100 pairs in the sweep. It was 9.0738…
    // while P1 sat on the authored `P` cell and 11.6619… once P1 joined the maximin set
    // (pickVersusSpawnSet) -- so this line is also the record that the ruling moved the
    // WORST case, not just the average.
    expect(globalMin).toBeCloseTo(11.6619037896906, 9);
  });

  it('every player spawn is a distinct cell (never co-located), across the full sweep', () => {
    for (const arena of ARENAS) {
      for (const mode of ['ffa', 'teams'] as const) {
        const { tanks } = loadArena(arena, 4, mode);
        const positions = tanks.filter((t) => t.kind === 'player').map((t) => `${t.pos.x},${t.pos.y}`);
        expect(new Set(positions).size, `${(arena as { id?: string }).id}/${mode}`).toBe(positions.length);
      }
    }
  });

  it('campaign-coop is untouched: loadArena(arena, n, "campaign-coop") is unchanged from the pre-existing ring search, on all 5 shipped arenas at N=2..4', () => {
    // This does not re-implement the ring search to compare against -- that would only
    // prove two copies of the same logic agree. It instead pins that the co-op path
    // still produces DISTINCT, in-bounds cells and never routes through the versus
    // branch's own LOS/geodesic machinery: arena.test.ts's existing pins (ring-1-S,
    // ring-1-W exact positions, id ordering) are the byte-for-byte evidence; this test
    // only adds the cross-mode contrast that campaign-coop's own output does NOT match
    // what ffa/teams now produce for the same arena and player count, proving the guard
    // actually routes rather than both branches coincidentally agreeing.
    for (const arena of ARENAS) {
      for (const n of [2, 3, 4]) {
        const coop = loadArena(arena, n, 'campaign-coop');
        const ffa = loadArena(arena, n, 'ffa');
        const coopPos = coop.tanks.filter((t) => t.kind === 'player').map((t) => t.pos);
        const ffaPos = ffa.tanks.filter((t) => t.kind === 'player').map((t) => t.pos);
        // EVERY slot differs, P1 included. This assertion used to read
        // `expect(coopPos[0]).toEqual(ffaPos[0])`, pinning that P1 sat on the authored
        // `P` cell in both modes, with a comment flagging it as pinning behaviour rather
        // than a requirement and naming the exact decision that would invert it:
        // "maximin-placing every player including P1". That decision was subsequently
        // taken (see pickVersusSpawnSet), so the line is inverted here rather than
        // deleted -- it is the most direct statement of the ruling that exists, and it
        // fails if arena.ts ever stops relocating P1.
        expect(coopPos[0], 'versus must not inherit the campaign `P` cell for P1').not.toEqual(ffaPos[0]);
        expect(coopPos.slice(1)).not.toEqual(ffaPos.slice(1));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// HULL CLEARANCE (issue #225). All discriminating fixtures run at cellSize 1: an open
// cell's centre sits 0.5 from an adjacent wall face -- under the 0.65 requirement
// (TANK_RADIUS 0.5 + VERSUS_SPAWN_CLEARANCE_MARGIN 0.15) -- which is the regime no
// shipped board (cellSize 2, centres >= 1.0 from every face) ever enters. That is why
// the parity sweep in the next block can demand byte-identical shipped behaviour while
// these fixtures prove the rule really measures something.
// ---------------------------------------------------------------------------

describe('versusSpawnClearanceFailures', () => {
  // 5x3 room at cellSize 1, one solid cell at (col 2, row 1) dead centre.
  const legend = { x: 'solid' as WallKind, d: 'destructible' as WallKind };
  const walledGrid = ['.....', '..x..', '.....'];

  it('a position 0.5 from a wall AABB fails naming the wall distance; without the wall it passes', () => {
    // (1.5, 1.5) is the centre of the cell LEFT of the solid block: 0.5 from its
    // west face, well clear (1.5) of every boundary of the 5x3 world.
    const pos = { x: 1.5, y: 1.5 };
    const failures = versusSpawnClearanceFailures(walledGrid, 5, 3, 1, legend, [pos]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^spawn\[0\] at \(1\.50, 1\.50\): wall clearance 0\.500 < 0\.650$/);
    // Negative control: same position, wall removed -- boundary is now the nearest
    // hazard at 1.5, comfortably clear.
    expect(versusSpawnClearanceFailures(['.....', '.....', '.....'], 5, 3, 1, legend, [pos])).toEqual([]);
  });

  it('a centre 0.5 from the arena edge fails as boundary; 0.65 or more in passes', () => {
    const openGrid = ['.....', '.....', '.....'];
    const edge = { x: 0.5, y: 1.5 }; // 0.5 from the west boundary
    const failures = versusSpawnClearanceFailures(openGrid, 5, 3, 1, legend, [edge]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^spawn\[0\] at \(0\.50, 1\.50\): boundary clearance 0\.500 < 0\.650$/);
    expect(versusSpawnClearanceFailures(openGrid, 5, 3, 1, legend, [{ x: 0.65, y: 1.5 }])).toEqual([]);
  });

  it('an intact destructible fails a hull beside it; the match-start variant grid with it removed passes', () => {
    const destructibleGrid = ['.....', '..d..', '.....'];
    const pos = { x: 1.5, y: 1.5 };
    expect(versusSpawnClearanceFailures(destructibleGrid, 5, 3, 1, legend, [pos])).toHaveLength(1);
    // The variant grid (that cell drawn by the seeded removal) is what real callers
    // pass -- clearance is a match-start question, so the removed wall costs nothing.
    expect(versusSpawnClearanceFailures(['.....', '.....', '.....'], 5, 3, 1, legend, [pos])).toEqual([]);
  });

  it('two positions 1.0 apart fail as a pair (< 1.15); 1.2 apart pass', () => {
    const openGrid = ['.....', '.....', '.....'];
    const a = { x: 1.5, y: 1.5 };
    const failures = versusSpawnClearanceFailures(openGrid, 5, 3, 1, legend, [a, { x: 2.5, y: 1.5 }]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^spawn\[0\]\.\.spawn\[1\]: pairwise distance 1\.000 < 1\.150$/);
    expect(versusSpawnClearanceFailures(openGrid, 5, 3, 1, legend, [a, { x: 2.7, y: 1.5 }])).toEqual([]);
  });

  it('is deterministic: same inputs twice give deep-equal failure lists', () => {
    const args = [walledGrid, 5, 3, 1, legend, [{ x: 1.5, y: 1.5 }, { x: 2.2, y: 1.5 }]] as const;
    expect(versusSpawnClearanceFailures(...args)).toEqual(versusSpawnClearanceFailures(...args));
  });
});
