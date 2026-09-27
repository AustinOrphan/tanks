import type { WallKind } from './types';
import { nextRng } from './types';

/**
 * A seeded VARIANT of an authored board for versus modes: a subset of its destructible
 * cells, never a superset. See docs/superpowers/plans/2026-08-17-versus-map-variants.md for
 * the design ruling and the measured tables.
 *
 * Destructible only, never solid: solid geometry defines the arena's shape (its merged runs
 * feed collision and bank shots), while turning a destructible cell into open floor is the
 * same edit a mine blast already makes mid-round.
 *
 * `arena.ts` imports this module, so this module must never import `arena.ts`: it takes
 * grid/cols/rows/cellSize/legend as primitives rather than an `Arena`, as `versus-spawns.ts`
 * does for the same reason.
 */

import { pickVersusSpawnCell, wallsForQuery } from './versus-spawns';
import { lineOfSight } from './ai/targeting';
import { SPAWN_LETTERS } from './config/arena-types';

interface DestructibleCell {
  readonly row: number;
  readonly col: number;
}

/**
 * Row-major, the order `loadArena`'s PASS 2b walks, so this is exactly the set of
 * destructible `Wall`s a campaign-coop load of the same arena builds.
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
 * Returns `grid` itself, not a copy, when there is nothing to remove. versus-variants.test.ts's
 * determinism block proves different seeds draw different subsets, i.e. `seed` is not a dead
 * parameter.
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

/** A measurement helper for tests and the plan doc's tables. */
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
 * Not the placement `loadArena`'s ffa/teams branch runs: that picks the whole set at once
 * with `pickVersusSpawnSet` (versus-spawns.ts), P1 included, so the suitability probe below
 * judges a variant by a different placement from the one the match will use.
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
 * Checks the two `evaluateVersusBoard` (versus-board.ts) criteria that removing a
 * destructible cell can regress: `distinctSpawns` and `allPairsConcealed`. `roomOk` is not
 * re-checked: removal only adds open floor, so it holds for every variant of a board that
 * passes it (proved in `versus-variants.test.ts`'s monotonicity block; `versus-board.test.ts`
 * asserts it for every offered board).
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
 * Chosen from the measured sweep in docs/superpowers/plans/2026-08-17-versus-map-variants.md.
 * `versus-variants.test.ts` pins that at this fraction no offered (arena, N) combination
 * draws a variant `evaluateVersusBoard` calls unsuitable, over ten seeds.
 */
export const DESTRUCTIBLE_REMOVAL_FRACTION = 0.4;

/** Generous relative to what shipped data needs; see the plan doc's measurement. */
export const VARIANT_RETRY_BOUND = 5;

/**
 * The entry point `loadArena` calls. `fraction` is a parameter so `versus-variants.test.ts`
 * can force an unsuitable first draw on a synthetic fixture and exercise the retry path.
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
