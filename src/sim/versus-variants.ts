import type { WallKind } from './types';
import { nextRng } from './types';

/**
 * A seeded, deterministic VARIANT of an authored board's destructible cells, for versus
 * modes -- see docs/superpowers/plans/2026-08-17-versus-map-variants.md for the full
 * design ruling and the measured tables this module produces.
 *
 * "Randomized subsets before full procedural generation": versus maps are meant to move
 * from authored boards, played identically every time, to authored boards with a
 * randomized SUBSET of their own destructible cells, and later to boards generated from
 * nothing. This module builds the middle step. Solid walls, board dimensions and the
 * authored `P` cell are NEVER touched -- only which destructible cells are PRESENT
 * varies, and only ever as a SUBSET of what the author placed (never a superset: a
 * variant cannot invent a destructible the author did not draw).
 *
 * WHY DESTRUCTIBLE ONLY, NEVER SOLID: solid geometry defines the arena's shape -- its
 * merged runs (`wall-merge.ts`) feed collision and bank shots, and varying it would
 * change the board's IDENTITY rather than vary it, the same distinction CLAUDE.md's
 * "Destructible walls are never merged" section draws for a different reason (a
 * destructible cell is a destruction UNIT; arena-02's centre barrier is authored as
 * adjacent blocks whose separate destruction is the level's design). Turning a
 * destructible cell into open floor here is the same kind of edit a mine blast already
 * makes mid-round -- this module just makes the choice of WHICH cells at load time
 * instead of at detonation time.
 *
 * IMPORT GRAPH, checked before writing any code: `arena.ts` is the one real caller
 * (`loadArena` needs this module to build a versus variant's grid before running its own
 * PASS 1a/1b/2a/2b), so this module must never import `arena.ts` -- that would close a
 * two-node cycle. It takes grid/cols/rows/cellSize/legend as PRIMITIVES rather than an
 * `Arena` object for exactly that reason -- the same shape `versus-spawns.ts` already
 * takes, for the identical cycle-avoidance reason (see that module's own doc comment).
 * The two imports below (`versus-spawns.ts` for `pickVersusSpawnCell`/`wallsForQuery`,
 * `ai/targeting.ts` for `lineOfSight`) are both leaves `versus-spawns.ts` itself already
 * uses, so reaching them from here adds no new direction to the graph.
 *
 * SEEDED, NOT RANDOM: every draw here goes through `nextRng` (types.ts's mulberry32),
 * chained -- never `Math.random`. `purity.test.ts` scans this file like every other one
 * under `src/sim/`.
 */

import { pickVersusSpawnCell, wallsForQuery } from './versus-spawns';
import { lineOfSight } from './ai/targeting';
import { SPAWN_LETTERS } from './config/arena-types';

/** A grid cell holding a destructible wall, row-major -- matches versus-spawns.ts's own
 *  `Cell` convention. */
interface DestructibleCell {
  readonly row: number;
  readonly col: number;
}

/**
 * Every destructible cell in the grid, in fixed row-major scan order -- the same order
 * `loadArena`'s own PASS 2b walks, so the population this module draws from is exactly
 * the set of destructible `Wall`s a campaign-coop load of the SAME arena would build.
 */
function destructibleCells(grid: string[], cols: number, rows: number, legend: Record<string, WallKind>): DestructibleCell[] {
  const cells: DestructibleCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (legend[grid[r][c]] === 'destructible') cells.push({ row: r, col: c });
    }
  }
  return cells;
}

/**
 * Fisher-Yates over `[0, n)`, seeded from `nextRng`. Each draw CHAINS the returned seed
 * into the next call -- re-calling `nextRng(seed)` with the same integer on every
 * iteration would vary by seed but produce a fixed permutation pattern shared by every
 * subset size, not a real per-position shuffle.
 */
function shuffledIndices(n: number, seed: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  let s = seed;
  for (let i = n - 1; i > 0; i--) {
    const draw = nextRng(s);
    s = draw.seed;
    const j = Math.floor(draw.value * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  return order;
}

/**
 * The pure grid transform: replaces a seeded, deterministic SUBSET of `grid`'s
 * destructible cells with open floor (`.`), sized to `fraction` of the destructible
 * count (rounded to the nearest cell). Returns `grid` UNCHANGED (same array reference)
 * when there are no destructible cells to vary, or when the rounded removal count is 0
 * -- both are legitimate no-op cases, not errors.
 *
 * Deterministic: the same `(grid, cols, rows, legend, seed, fraction)` always yields the
 * same output array, because `shuffledIndices` is a pure function of `seed` and
 * `destructibleCells.length`. Different seeds draw different subsets (see
 * versus-variants.test.ts's determinism block for the measured sweep proving the seed is
 * actually wired, not a dead parameter).
 */
export function buildVariantGrid(
  grid: string[],
  cols: number,
  rows: number,
  legend: Record<string, WallKind>,
  seed: number,
  fraction: number,
): string[] {
  const cells = destructibleCells(grid, cols, rows, legend);
  if (cells.length === 0) return grid;
  const removeCount = Math.round(cells.length * fraction);
  if (removeCount <= 0) return grid;
  const order = shuffledIndices(cells.length, seed);
  const toRemove = order.slice(0, Math.min(removeCount, cells.length));
  const next = grid.slice();
  for (const idx of toRemove) {
    const { row, col } = cells[idx];
    next[row] = next[row].slice(0, col) + '.' + next[row].slice(col + 1);
  }
  return next;
}

/**
 * How many of `grid`'s destructible cells got turned to open floor between `before` and
 * `after` -- a measurement helper for tests and the plan doc's tables, not used by
 * `buildVariantGrid` itself (which already knows this number internally; a caller
 * comparing two already-built grids does not).
 */
export function countRemoved(before: string[], after: string[]): number {
  let removed = 0;
  for (let r = 0; r < before.length; r++) {
    for (let c = 0; c < before[r].length; c++) {
      if (before[r][c] !== '.' && after[r][c] === '.') removed++;
    }
  }
  return removed;
}

/**
 * The real versus placement sequence for a CANDIDATE grid -- P1 at the grid's own `P`
 * cell, then `playerCount - 1` co-players via `pickVersusSpawnCell`, exactly the shape
 * `loadArena`'s PASS 1b ffa/teams branch runs (arena.ts) -- duplicated here rather than
 * imported for the same cycle reason `wallsForQuery`'s own doc comment gives: getting
 * REAL geometry for a query without building a whole `World`. Returns an empty array if
 * the grid carries no `P` cell (should not happen on any grid this module is ever
 * handed -- every caller derives `grid` from an already-`validateArenas`-checked shipped
 * arena -- but a defensive empty result is cheaper than a throw for a suitability probe).
 */
function versusPositions(
  grid: string[],
  cols: number,
  rows: number,
  cellSize: number,
  legend: Record<string, WallKind>,
  playerCount: number,
): { x: number; y: number }[] {
  let p1: { x: number; y: number } | null = null;
  for (let r = 0; r < rows && !p1; r++) {
    for (let c = 0; c < cols; c++) {
      if (SPAWN_LETTERS[grid[r][c]] === 'player') {
        p1 = { x: (c + 0.5) * cellSize, y: (r + 0.5) * cellSize };
        break;
      }
    }
  }
  if (!p1) return [];
  const chosen = [p1];
  for (let i = 1; i < playerCount; i++) {
    const cell = pickVersusSpawnCell(grid, cols, rows, cellSize, legend, chosen);
    chosen.push({ x: (cell.col + 0.5) * cellSize, y: (cell.row + 0.5) * cellSize });
  }
  return chosen;
}

/**
 * Whether a candidate grid is fit for versus play at `playerCount`, using the SAME two
 * criteria from `versus-board.ts`'s `evaluateVersusBoard` that can actually regress when
 * a destructible cell disappears: `distinctSpawns` and `allPairsConcealed`. `roomOk` is
 * DELIBERATELY not re-checked here -- see `versus-variants.test.ts`'s monotonicity
 * block for the proof and the measurement backing it: turning a destructible cell into
 * `.` strictly increases `openFloorCells` by exactly the removed count (every removed
 * character was not `.` and becomes `.`), so `openFloorPerPlayer` can only rise, and if
 * `roomOk` held for the authored board (measured true on all 15 shipped (arena, N)
 * combinations, `versus-board.test.ts`) it holds for every variant of it. Concealment is
 * NOT similarly guaranteed: removing a destructible wall can open a sightline between
 * two spawn cells that was blocked before, and `pickVersusSpawnCell`'s own ranking can
 * pick DIFFERENT cells once more candidates exist -- both are genuinely empirical, which
 * is why this function exists rather than relying on argument alone.
 */
function isVariantSuitable(
  grid: string[],
  cols: number,
  rows: number,
  cellSize: number,
  legend: Record<string, WallKind>,
  playerCount: number,
): boolean {
  const positions = versusPositions(grid, cols, rows, cellSize, legend, playerCount);
  if (positions.length !== playerCount) return false;
  const spawnCount = new Set(positions.map((p) => `${p.x},${p.y}`)).size;
  if (spawnCount !== playerCount) return false;
  const walls = wallsForQuery(grid, cols, rows, cellSize, legend);
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      if (lineOfSight(positions[i], positions[j], walls)) return false;
    }
  }
  return true;
}

/**
 * The fraction of an arena's destructible cells a versus variant omits. See
 * docs/superpowers/plans/2026-08-17-versus-map-variants.md for the measured sweep this
 * was chosen from: at this fraction, 0 of the sampled (arena, N, seed) draws across all
 * 5 shipped arenas came out unsuitable -- the retry/fallback machinery below exists as a
 * defensive bound, not because shipped data ever exercises it.
 */
export const DESTRUCTIBLE_REMOVAL_FRACTION = 0.4;

/** Bounded retry: a deterministic sim may not loop unboundedly. See the plan doc's
 *  measurement for why this bound is generous relative to what shipped data needs. */
export const VARIANT_RETRY_BOUND = 5;

/**
 * Picks a suitable versus variant grid, retrying with a freshly chained seed up to
 * `VARIANT_RETRY_BOUND` times if a draw fails `isVariantSuitable`, and falling back to
 * the AUTHORED grid unchanged if every attempt is exhausted -- never an unsuitable
 * variant, and never an unbounded loop. This is the one function `arena.ts`'s
 * `loadArena` calls; every other export above is measured directly in
 * `versus-variants.test.ts` and by the plan doc's sweep.
 *
 * `fraction` defaults to `DESTRUCTIBLE_REMOVAL_FRACTION` (the shipped operating point)
 * but is a parameter, not a hardcoded read, so `versus-variants.test.ts` can drive this
 * exact function at a fraction the measured sweep shows CAN produce an unsuitable first
 * draw -- proving the retry path really executes, not merely arguing that it would.
 */
export function pickVersusVariantGrid(
  grid: string[],
  cols: number,
  rows: number,
  cellSize: number,
  legend: Record<string, WallKind>,
  playerCount: number,
  seed: number,
  fraction: number = DESTRUCTIBLE_REMOVAL_FRACTION,
): string[] {
  let trySeed = seed;
  for (let attempt = 0; attempt < VARIANT_RETRY_BOUND; attempt++) {
    const candidate = buildVariantGrid(grid, cols, rows, legend, trySeed, fraction);
    if (isVariantSuitable(candidate, cols, rows, cellSize, legend, playerCount)) return candidate;
    trySeed = nextRng(trySeed).seed;
  }
  return grid;
}
