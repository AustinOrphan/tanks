import type { WallKind } from './types';
import { nextRng } from './types';

/**
 * A seeded, deterministic VARIANT of an authored board's destructible cells, for versus
 * modes -- see docs/superpowers/plans/2026-08-17-versus-map-variants.md for the full
 * design ruling and the measured tables this module produces.
 *
 * "Randomized subsets before full procedural generation": versus maps are meant to move
 * from authored boards, played identically every time, to authored boards with a
 * randomized subset of their own destructible cells, and later to boards generated from
 * nothing. This module builds the middle step. Solid walls, board dimensions and the
 * authored `P` cell are never touched -- only which destructible cells are present
 * varies, and only ever as a subset of what the author placed (never a superset: a
 * variant cannot invent a destructible the author did not draw).
 *
 * Why destructible only, never solid: solid geometry defines the arena's shape -- its
 * merged runs (`wall-merge.ts`) feed collision and bank shots, and varying it would
 * change the board's identity rather than vary it, the same distinction
 * docs/agent/architecture.md's "Destructible walls are never merged" section draws for a
 * different reason (a destructible cell is a destruction unit; arena-02's centre barrier
 * is authored as adjacent blocks whose separate destruction is the level's design).
 * Turning a destructible cell into open floor here is the same kind of edit a mine blast
 * already makes mid-round -- this module just makes the choice of which cells at load
 * time instead of at detonation time.
 *
 * Import graph: `arena.ts` imports this module (`loadArena` builds a versus variant's grid
 * before its own PASS 1a/1b/2a/2b), so this module must never import `arena.ts` -- that
 * would close a two-node cycle. It takes grid/cols/rows/cellSize/legend as primitives
 * rather than an `Arena` object for that reason -- the same shape `versus-spawns.ts`
 * takes, for the identical cycle-avoidance reason (see that module's own doc comment).
 * The imports below (`versus-spawns.ts`, `ai/targeting.ts`, `config/arena-types.ts`) are
 * all modules `arena.ts` already reaches, so importing them here adds no new direction to
 * the graph.
 *
 * Seeded, not random: every draw here goes through `nextRng` (types.ts's mulberry32),
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
 * Versus spawn positions for a candidate grid: P1 at the grid's own `P` cell, then
 * `playerCount - 1` co-players via `pickVersusSpawnCell`. This is not the placement
 * `loadArena`'s ffa/teams branch runs: that picks the whole set at once with
 * `pickVersusSpawnSet` (versus-spawns.ts), P1 included, so the suitability probe below
 * judges a variant by a different placement from the one the match will use. Written here
 * rather than borrowed from `arena.ts`, which this module must never import. Returns an
 * empty array if the grid carries no `P` cell -- a defensive empty result is cheaper than a
 * throw for a suitability probe.
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
 * Whether a candidate grid is fit for versus play at `playerCount`, using the same two
 * criteria from `versus-board.ts`'s `evaluateVersusBoard` that can actually regress when
 * a destructible cell disappears: `distinctSpawns` and `allPairsConcealed` (over
 * `versusPositions` above, not `evaluateVersusBoard`'s own placement). `roomOk` is
 * deliberately not re-checked here -- see `versus-variants.test.ts`'s monotonicity
 * block for the proof and the measurement backing it: turning a destructible cell into
 * `.` strictly increases `openFloorCells` by exactly the removed count (every removed
 * character was not `.` and becomes `.`), so `openFloorPerPlayer` can only rise, and if
 * `roomOk` held for the authored board (`versus-board.test.ts` asserts it for every
 * offered one) it holds for every variant of it. Concealment is not similarly guaranteed:
 * removing a destructible wall can open a sightline between two spawn cells that was
 * blocked before, and `pickVersusSpawnCell`'s own ranking can pick different cells once
 * more candidates exist -- both are genuinely empirical, which is why this function
 * exists rather than relying on argument alone.
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
 * The fraction of an arena's destructible cells a versus variant omits, chosen from the
 * measured sweep in docs/superpowers/plans/2026-08-17-versus-map-variants.md.
 * `versus-variants.test.ts` pins that at this fraction no offered (arena, N) combination
 * draws a variant `evaluateVersusBoard` calls unsuitable, over ten seeds. The
 * retry/fallback machinery below is a defensive bound; the same test file exercises it on
 * a synthetic fixture at a higher fraction.
 */
export const DESTRUCTIBLE_REMOVAL_FRACTION = 0.4;

/** Bounded retry: a deterministic sim may not loop unboundedly. See the plan doc's
 *  measurement for why this bound is generous relative to what shipped data needs. */
export const VARIANT_RETRY_BOUND = 5;

/**
 * Picks a suitable versus variant grid, retrying with a freshly chained seed up to
 * `VARIANT_RETRY_BOUND` times if a draw fails `isVariantSuitable`, and falling back to
 * the authored grid unchanged if every attempt is exhausted -- never an unsuitable
 * variant, and never an unbounded loop. This is the one function `arena.ts`'s
 * `loadArena` calls; every other export above is measured directly in
 * `versus-variants.test.ts` and by the plan doc's sweep.
 *
 * `fraction` defaults to `DESTRUCTIBLE_REMOVAL_FRACTION` (the shipped operating point)
 * but is a parameter, not a hardcoded read, so `versus-variants.test.ts` can drive this
 * exact function at a fraction that produces an unsuitable first draw on its synthetic
 * fixture -- proving the retry path really executes, not merely arguing that it would.
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
