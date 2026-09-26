import { nextRng } from '../../src/sim/types';

/**
 * Shared pieces every candidate ruleset builds on, so the rulesets differ in their RULES
 * and not in their plumbing. A comparison between generators that each roll their own
 * symmetry operator and spawn placement is a comparison of four things at once.
 *
 * SEEDED, NEVER RANDOM. Every draw goes through `nextRng` -- the same mulberry32 chain
 * `src/sim/versus-variants.ts` uses -- so a board is a pure function of its seed and can be
 * regenerated, re-measured and re-photographed forever. `Math.random` appears nowhere.
 */

/** A seeded draw stream. `next()` returns [0, 1); `int(n)` returns an integer in [0, n). */
export function rng(seed) {
  let s = seed >>> 0;
  const next = () => {
    const draw = nextRng(s);
    s = draw.seed;
    return draw.value;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    /** Fisher-Yates, in place, returning the same array. */
    shuffle: (xs) => {
      for (let i = xs.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [xs[i], xs[j]] = [xs[j], xs[i]];
      }
      return xs;
    },
  };
}

/**
 * The seeds one sweep runs: `offset + 1` through `offset + count`.
 *
 * THE OFFSET IS THE POINT, and it exists so a second, DISJOINT sample is reachable at all.
 * A ranking taken from one seed set is not a finding: on the AI sweep a per-profile ordering
 * held across all four commitment values with n = 50-154 per cell, and flipped outright on
 * seeds 1001-2000. `sweep.mjs` could only ever run `1..N`, so the set that catches that could
 * not be asked for -- `--seeds 30` then `--seeds 30 --seed-offset 30` is two disjoint samples
 * of the same size, and disagreement between them is the signal.
 *
 * Seeds are ONE-BASED because every ruleset's generator is `generate(seed)` over a mulberry32
 * chain and seed 0 is not distinguished; the existing sweeps and their published tables all
 * start at 1, so an offset of 0 has to reproduce them exactly.
 *
 * THROWS rather than coercing. `Number('--seeds')` of a missing or misspelled value is `NaN`,
 * and a `for` loop over `NaN` runs zero times: the sweep would print a table of empty rows and
 * look like a generator that accepts nothing rather than like a typo.
 */
export function seedRange(offset, count) {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`seed offset must be a non-negative integer, got ${offset}`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`seed count must be a positive integer, got ${count}`);
  }
  return Array.from({ length: count }, (_, i) => offset + i + 1);
}

/** The one board size every ruleset is compared at. */
export const BOARD = { cols: 33, rows: 27, cellSize: 2 / 3 };

/**
 * FIXED ACROSS RULESETS, deliberately. `openGroundFraction` loses the directions pointing at
 * the board's own rim and `coverSpacing` is a mean over however many pieces fit, so both move
 * with board size; comparing rulesets at different sizes would put that drift in the same
 * column as the thing being compared. 33x27 is the size of arena-01, arena-02, arena-03 and
 * vs-quad-01, so the generated boards sit in the same column as four shipped ones.
 */

export const LEGEND = { '#': 'solid', x: 'destructible' };

/** A mutable grid of open floor. */
export function blankCells({ cols, rows } = BOARD) {
  return Array.from({ length: rows }, () => Array(cols).fill('.'));
}

/**
 * Impose 180-degree rotational symmetry: whatever is at (r, c) is copied to its antipode.
 * The SOURCE half is the first half in row-major order, so the operator is idempotent and
 * two rulesets that draw the same shapes get the same board.
 *
 * WHY ROTATIONAL AND NOT MIRROR is a real design question rather than a default, and the
 * shipped data already answers half of it: vs-duel-01 and vs-quad-01 both measure 0.00
 * rotational asymmetry, while no shipped board is mirror-symmetric. A mirror puts each
 * player's cover on the opposite hand, so a right-handed approach on one side is a
 * left-handed one on the other; a rotation gives both players the identical approach in a
 * different compass direction.
 */
export function rotate180(cells) {
  const rows = cells.length;
  const cols = cells[0].length;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r * cols + c >= (rows * cols) / 2) break;
      cells[rows - 1 - r][cols - 1 - c] = cells[r][c];
    }
  }
  return cells;
}

/** Impose left-right mirror symmetry about the vertical axis. */
export function mirrorH(cells) {
  const cols = cells[0].length;
  for (const row of cells) {
    for (let c = 0; c < Math.floor(cols / 2); c++) row[cols - 1 - c] = row[c];
  }
  return cells;
}

/**
 * Finish a board: stamp the single authored `P` and hand back an `Arena`.
 *
 * ONE `P` IS NOT OPTIONAL, BUT ITS POSITION IS IGNORED. Both halves were measured rather than
 * assumed, and an earlier version of this comment had the second half backwards.
 *
 * The letter is required: a 33x27 board with no spawn letter at all loads with ZERO players at
 * 2, 3 and 4, and `evaluateVersusBoard` then reports `suitable: false` over 0 pairs. It is a
 * trigger for the versus placement branch, nothing more.
 *
 * Where it sits does nothing. The same board with `P` at cell (4, 2) and at cell (30, 25)
 * produces byte-identical player positions at every player count -- versus placement derives
 * every spawn from the geometry, and `versus-spawns.ts` states it outright: "In versus the
 * authored `P` is now ignored entirely for placement." The campaign path is the contrast:
 * those same two boards start a campaign player 17 world units apart.
 *
 * So `anchor` picks a cell that must be legal and need not be good. A ruleset should keep it
 * clear of walls and otherwise spend no effort on it.
 */
export function toArena(cells, anchor, board = BOARD) {
  const [ac, ar] = anchor;
  const grid = cells.map((row, r) => row.map((ch, c) => (r === ar && c === ac ? 'P' : ch)).join(''));
  return { cols: board.cols, rows: board.rows, cellSize: board.cellSize, legend: LEGEND, grid };
}

/** 4-neighbour flood fill over open cells; true when every open cell is reachable. */
export function cellsConnected(cells) {
  const rows = cells.length;
  const cols = cells[0].length;
  let start = null;
  let open = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cells[r][c] === '#') continue;
      open++;
      if (!start) start = [r, c];
    }
  }
  if (!start) return false;
  const seen = cells.map((row) => row.map(() => false));
  const stack = [start];
  seen[start[0]][start[1]] = true;
  let reached = 0;
  while (stack.length) {
    const [r, c] = stack.pop();
    reached++;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      if (seen[nr][nc] || cells[nr][nc] === '#') continue;
      seen[nr][nc] = true;
      stack.push([nr, nc]);
    }
  }
  return reached === open;
}
