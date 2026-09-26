import type { Vec2, Wall, WallKind } from './types';
import { lineOfSight } from './ai/targeting';
import { mergeSolidRuns } from './wall-merge';
import { TANK_RADIUS } from './constants';

/**
 * Well-separated versus spawn cells, derived from the arena's own geometry rather than
 * authored data -- see docs/superpowers/plans/2026-08-17-versus-spawns.md for the design
 * ruling this implements. `loadArena`'s campaign-coop placement (`findCoPlayerSpawnCell`,
 * arena.ts) is a bounded ring search radiating from P1's cell, which is exactly right for
 * co-op (partners start together) and exactly wrong for FFA/teams: every player lands in
 * one small ring, in mutual point-blank line of sight.
 *
 * A derived ranking works on any board -- including procedurally generated maps, which
 * cannot carry authored spawn points -- and the same ranking serves both initial placement
 * and versus respawn (`respawnPos`, world.ts, passes live tank positions as `avoid`).
 *
 * Cycle note: this module imports `lineOfSight` from `ai/targeting.ts`. `arena.ts` already
 * depends on that module transitively, via `world.ts` -> `ai/index.ts` -> `ai/targeting.ts`,
 * so importing it directly here does not add a new dependency direction, and
 * `ai/targeting.ts`'s import closure (type-only imports included) never reaches `arena.ts`.
 * This module must never import from `arena.ts` -- that would close a cycle, since
 * `arena.ts` imports this module.
 */

/** A grid cell, row-major -- `arena.ts`'s own coordinate convention. */
export interface Cell {
  readonly row: number;
  readonly col: number;
}

/**
 * The world-space centre of a grid cell. A copy of the `(c + 0.5) * cellSize` formula in
 * `arena.ts` (`loadArena`'s own spawn placement) and `arena-claims.ts`'s `cellCentre`.
 * `cell-mapping.test.ts` pins those two to each other; nothing pins this copy to either.
 * Importing either is not an option: `arena-claims.ts` imports `arena.ts`, and `arena.ts`
 * imports this module, so either import would close a cycle back through here.
 */
function cellCentre(cell: Cell, cellSize: number): Vec2 {
  return { x: (cell.col + 0.5) * cellSize, y: (cell.row + 0.5) * cellSize };
}

/** Which cell a world position sits in nearest to -- the inverse of `cellCentre`. */
function cellOfPos(pos: Vec2, cellSize: number): Cell {
  return { row: Math.round(pos.y / cellSize - 0.5), col: Math.round(pos.x / cellSize - 0.5) };
}

/**
 * Wall geometry for a visibility query -- solid cells merged (`mergeSolidRuns`,
 * `wall-merge.ts`, the same merge `loadArena` uses), destructible cells one box per cell,
 * never merged, matching PASS 2a/2b of `loadArena` exactly (a destructible cell is a
 * destruction unit, and at spawn time none is destroyed yet, so both kinds block a fresh
 * line of sight the same way they block one mid-round). Deliberately not the boundary
 * ring `loadArena` also builds: a query between two interior cell centres can never reach
 * it. These ids are throwaway -- `lineOfSight` never inspects `id` -- and this array is
 * never written into a `World`.
 *
 * `versus-spawns.test.ts` checks its solid-wall rectangles against `loadArena`'s real ones
 * on every shipped arena.
 */
export function wallsForQuery(
  grid: readonly string[],
  cols: number,
  rows: number,
  cellSize: number,
  legend: Readonly<Record<string, WallKind>>,
): Wall[] {
  const solid: boolean[][] = [];
  for (let r = 0; r < rows; r++) {
    solid.push([]);
    for (let c = 0; c < cols; c++) solid[r].push(legend[grid[r][c]] === 'solid');
  }
  const walls: Wall[] = [];
  let id = 0;
  for (const [c0, r0, c1, r1] of mergeSolidRuns(solid, cols, rows)) {
    walls.push({
      id: id++,
      aabb: { minX: c0 * cellSize, minY: r0 * cellSize, maxX: c1 * cellSize, maxY: r1 * cellSize },
      kind: 'solid',
      destroyed: false,
    });
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (legend[grid[r][c]] !== 'destructible') continue;
      walls.push({
        id: id++,
        aabb: { minX: c * cellSize, minY: r * cellSize, maxX: (c + 1) * cellSize, maxY: (r + 1) * cellSize },
        kind: 'destructible',
        destroyed: false,
      });
    }
  }
  return walls;
}

/**
 * Whether a tank can occupy `ch` as open floor -- the same test `arena.ts`'s
 * `findCoPlayerSpawnCell` uses (`grid[row][col] === '.'`), so the versus and co-op
 * placements agree on what "fits" means: exactly the plain-floor cells, excluding solid,
 * destructible and every spawn letter (a spawn letter marks an enemy's authored start,
 * still present in the grid string even though versus mode never instantiates the tank
 * there -- see `loadArena`'s PASS 1a).
 */
function isOpenFloor(ch: string): boolean {
  return ch === '.';
}

/**
 * Whether a tank can drive through `ch` at any point in the round -- broader than
 * `isOpenFloor` in two separate ways, and the second one is a design ruling.
 *
 * First, a former enemy spawn letter is real floor once the game is running (the letter
 * is a data marker, not a wall), so the geodesic graph walks through it even though it is
 * not itself a candidate spawn cell.
 *
 * Second, and deliberately: a destructible cell counts as traversable. This is the
 * breached phase, and it is the conservative reading -- a destructible wall is temporary
 * by construction, so two spawns separated only by one are not actually separated for the
 * length of a match. It is the same both-wall-phases discipline `spawnBlockRobust`
 * applies in `arena-claims.ts`, and it is load-bearing rather than pedantic: when
 * measured, optimising against the intact graph instead put arena-02's 4-player spawns
 * 2.67 world units apart, either side of the centre barrier that level is designed to
 * blow open.
 *
 * The line-of-sight filter in `pickVersusSpawnCell` deliberately does not follow this
 * rule: it runs against intact geometry (`wallsForQuery`), because a destructible wall
 * really does block sight at the instant players spawn, and the opening seconds are what
 * that filter is for. Distance is a question about the whole round; concealment is a
 * question about spawn time. The filter's guarantee is an at-spawn one, never a
 * match-long one: a spawn pair can become mutually visible once every destructible is
 * gone (measured on 4 of 15 (arena, count) pairs when this landed).
 */
function isWalkable(ch: string, legend: Readonly<Record<string, WallKind>>): boolean {
  return legend[ch] !== 'solid';
}

/**
 * BFS distances (in cell steps, not world units) from `start` to every walkable cell,
 * 4-connected. Deliberately not 8-connected: a tank's hull has nonzero radius, so a
 * diagonal step between two cells whose shared corner is walled off on both orthogonal
 * sides is not reliably free in continuous space, and this ranking is already a greedy
 * approximation (see `pickVersusSpawnCell`'s own doc comment) -- treating the reachability
 * graph as orthogonal is the conservative reading, not a shortcut taken for speed.
 * Unreached cells stay `Infinity`.
 */
function geodesicDistances(start: Cell, walkable: boolean[][], cols: number, rows: number): number[][] {
  const dist: number[][] = [];
  for (let r = 0; r < rows; r++) dist.push(new Array(cols).fill(Infinity));
  if (!walkable[start.row]?.[start.col]) return dist; // degenerate: start itself is walled
  dist[start.row][start.col] = 0;
  const queue: Cell[] = [start];
  let head = 0;
  const STEPS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (head < queue.length) {
    const cur = queue[head++];
    const d = dist[cur.row][cur.col];
    for (const [dCol, dRow] of STEPS) {
      const row = cur.row + dRow;
      const col = cur.col + dCol;
      if (row < 0 || row >= rows || col < 0 || col >= cols) continue;
      if (!walkable[row][col]) continue;
      if (dist[row][col] !== Infinity) continue;
      dist[row][col] = d + 1;
      queue.push({ row, col });
    }
  }
  return dist;
}

/** Deterministic tie-break: `a` sorts before `b` iff `a` is (row, col) earlier. */
function isEarlier(a: Cell, b: Cell): boolean {
  return a.row !== b.row ? a.row < b.row : a.col < b.col;
}

/**
 * Options shared by both pickers. `clearanceMargin` defaults to
 * `VERSUS_SPAWN_CLEARANCE_MARGIN`; `null` disables the hull-clearance filter
 * entirely -- a seam for tests that isolate the ranking or LOS layer and for negative
 * controls; nothing shipped uses it.
 */
export interface SpawnPickOptions {
  readonly clearanceMargin?: number | null;
}

/**
 * Picks one well-separated versus spawn cell. Every open-floor candidate (`isOpenFloor`,
 * same predicate `findCoPlayerSpawnCell` uses) goes through the hull-clearance filter
 * (below), then is scored in priority order:
 *
 *  1. Hard filter, where achievable: no line of sight to any position in `avoid`. If at
 *     least one candidate qualifies, every candidate that does not is discarded outright
 *     -- a candidate in plain sight of an already-chosen spawn never wins over one that
 *     is not, however far apart the two might be. If no candidate qualifies (a cramped or
 *     heavily-walled board where every remaining cell can see something in `avoid`), the
 *     filter is skipped and every candidate stays in play: a hard filter that can reject
 *     every candidate is not a filter a caller can use, so falling through to plain
 *     maximin on the full pool is the deliberate degradation.
 *  2. Among the survivors, greedy maximin on geodesic distance (BFS cell-steps through
 *     walkable cells, `geodesicDistances` above, respecting walls -- not Euclidean: two
 *     cells either side of a wall are far apart in play, and two Euclidean-distant cells
 *     down one open lane are not safe from each other). The candidate whose distance to
 *     its nearest `avoid` entry is largest wins. This is an approximation of the true
 *     "farthest cell from everything already placed" problem (classic p-dispersion), not
 *     its optimum -- see `versus-spawns.test.ts` for a measured gap on one small fixture
 *     via brute force, and `pickVersusSpawnSet` for the relaxation pass that closes some
 *     of that gap in practice.
 *  3. Geodesic ties broken on Euclidean distance to the nearest `avoid` entry, largest
 *     wins. This is not cosmetic. Geodesic distance saturates at `Infinity` for any cell
 *     in a component `avoid` cannot reach, so on a board whose walls partition it, every
 *     unreachable cell ties at `Infinity` and the positional tie-break below would decide
 *     (measured on arena-02 at 2 players: a cell 2.67 world units from the anchor,
 *     straight through the wall, against 27.49 with this key). Ties still arise constantly
 *     on connected boards too (cell steps are integers), so this key does work on every
 *     board, not only partitioned ones.
 *  4. Remaining ties broken deterministically on (row, col) ascending (`isEarlier`), which
 *     is what keeps the whole ranking a pure function of the grid.
 *
 * `avoid` is world-space `Vec2[]`, not cells, so the same signature serves placement (the
 * spawns already chosen: `pickVersusSpawnSet`, versus-variants.ts) and versus respawn
 * (live tank positions: `respawnPos`, world.ts).
 *
 * Falls back to co-locating at `avoid[0]`'s own cell when no open-floor candidate exists
 * anywhere on the board -- the same total, no-throw degradation `findCoPlayerSpawnCell`
 * already uses for its own exhausted-ring case (`separateTanks`, world.ts, already runs
 * every tick and already handles worse overlaps than this). Not reachable on any shipped
 * arena; exercised only by a synthetic negative-control fixture in the test file, because
 * every shipped arena ships far more open floor than 4 players need.
 */
export function pickVersusSpawnCell(
  grid: readonly string[],
  cols: number,
  rows: number,
  cellSize: number,
  legend: Readonly<Record<string, WallKind>>,
  avoid: Vec2[],
  opts: SpawnPickOptions = {},
): Cell {
  const avoidCells = avoid.map((p) => cellOfPos(p, cellSize));
  const walkable: boolean[][] = [];
  const candidates: Cell[] = [];
  for (let r = 0; r < rows; r++) {
    walkable.push([]);
    for (let c = 0; c < cols; c++) {
      const ch = grid[r][c];
      walkable[r].push(isWalkable(ch, legend));
      if (!isOpenFloor(ch)) continue;
      if (avoidCells.some((a) => a.row === r && a.col === c)) continue;
      candidates.push({ row: r, col: c });
    }
  }
  // No candidate: co-locate at the first `avoid` position's cell, or at (0, 0) when
  // `avoid` is empty, so a truly pathological board still returns a cell rather than
  // throwing.
  if (candidates.length === 0) return avoidCells[0] ?? { row: 0, col: 0 };

  const walls = wallsForQuery(grid, cols, rows, cellSize, legend);
  const avoidDist = avoidCells.map((a) => geodesicDistances(a, walkable, cols, rows));

  // Hull clearance filter (issue #225), ahead of the LOS filter and the maximin
  // ranking exactly as the issue's own ordering asks ("preserve the existing
  // line-of-sight and geodesic/maximin quality rules after invalid candidates are
  // removed"). An emptied pool falls back to the full candidate list -- the same
  // total-degradation posture as the zero-candidate and no-concealment fallbacks
  // (never throw mid-match-start); versusSpawnClearanceFailures is the loud half,
  // and CI-time validation is what keeps advertised combinations off this path.
  const margin = opts.clearanceMargin === undefined ? VERSUS_SPAWN_CLEARANCE_MARGIN : opts.clearanceMargin;
  let eligible = candidates;
  if (margin !== null) {
    const wallRequired = TANK_RADIUS + margin;
    const pairRequired = 2 * TANK_RADIUS + margin;
    const clear = candidates.filter((cand) => {
      const p = cellCentre(cand, cellSize);
      if (Math.min(p.x, p.y, cols * cellSize - p.x, rows * cellSize - p.y) < wallRequired) return false;
      for (const w of walls) if (wallDistance(p, w) < wallRequired) return false;
      for (const a of avoid) if (Math.hypot(a.x - p.x, a.y - p.y) < pairRequired) return false;
      return true;
    });
    if (clear.length > 0) eligible = clear;
  }

  const invisible = eligible.filter((cand) => {
    const candPos = cellCentre(cand, cellSize);
    return avoid.every((a) => !lineOfSight(candPos, a, walls));
  });
  const pool = invisible.length > 0 ? invisible : eligible;

  let best = pool[0];
  let bestGeo = -Infinity;
  let bestEuclid = -Infinity;
  for (const cand of pool) {
    let geo = Infinity;
    for (const dg of avoidDist) geo = Math.min(geo, dg[cand.row][cand.col]);
    const candPos = cellCentre(cand, cellSize);
    let euclid = Infinity;
    for (const a of avoid) euclid = Math.min(euclid, Math.hypot(candPos.x - a.x, candPos.y - a.y));
    let wins: boolean;
    if (geo !== bestGeo) wins = geo > bestGeo;
    else if (euclid !== bestEuclid) wins = euclid > bestEuclid;
    else wins = isEarlier(cand, best);
    if (wins) {
      best = cand;
      bestGeo = geo;
      bestEuclid = euclid;
    }
  }
  return best;
}

/**
 * How many coordinate-ascent rounds `pickVersusSpawnSet` may run. Each round is bounded
 * work and the pass only ever accepts a strict improvement, so the loop terminates on its
 * own; this is a backstop, not the termination argument. When chosen, the pass converged
 * in at most 4 rounds on every shipped (arena, player count) pair, so 8 is roughly double
 * the observed worst case.
 */
export const VERSUS_RELAX_ROUNDS = 8;

/** Lexicographic separation score for a whole spawn set: (min geodesic, min Euclidean). */
function setSeparation(cells: Cell[], walkable: boolean[][], cols: number, rows: number, cellSize: number): [number, number] {
  let minGeo = Infinity;
  let minEuclid = Infinity;
  for (let i = 0; i < cells.length; i++) {
    const dist = geodesicDistances(cells[i], walkable, cols, rows);
    for (let j = i + 1; j < cells.length; j++) {
      minGeo = Math.min(minGeo, dist[cells[j].row][cells[j].col]);
      const a = cellCentre(cells[i], cellSize);
      const b = cellCentre(cells[j], cellSize);
      minEuclid = Math.min(minEuclid, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  return [minGeo, minEuclid];
}

/** Strictly better on the lexicographic (geodesic, Euclidean) separation score. */
function isBetterSeparation(a: [number, number], b: [number, number]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
}

/**
 * The anchor: where the first spawn goes when nothing is placed yet.
 *
 * `pickVersusSpawnCell` cannot answer this -- with an empty `avoid` every candidate scores
 * `Infinity` and its own tie-breaks hand back the (row, col)-earliest open cell, which is
 * a board corner by construction and an accident of the tie-break rather than a decision.
 *
 * So the anchor is derived instead, by the standard double-sweep: BFS from an arbitrary
 * deterministic candidate to find the farthest one, then BFS again from that to find the
 * farthest from it. In a tree the second sweep lands on a true diameter endpoint; on a
 * general graph -- which an arena is -- it is a well-known approximation, and an
 * approximation is all this needs, since the relaxation pass below re-picks every spawn
 * anyway. Deterministic at every step: the arbitrary start is the (row, col)-earliest
 * candidate and both sweeps break ties with `isEarlier`.
 */
function anchorCell(cands: Cell[], walkable: boolean[][], cols: number, rows: number): Cell {
  const sweep = (from: Cell): Cell => {
    const dist = geodesicDistances(from, walkable, cols, rows);
    let best = cands[0];
    let bestDist = -Infinity;
    for (const cand of cands) {
      const d = dist[cand.row][cand.col];
      if (d === Infinity) continue; // unreachable tells us nothing about which end is far
      if (d > bestDist || (d === bestDist && isEarlier(cand, best))) {
        best = cand;
        bestDist = d;
      }
    }
    return best;
  };
  return sweep(sweep(cands[0]));
}

/**
 * Picks the whole versus spawn set at once -- `count` mutually well-separated cells, with
 * no player privileged over any other.
 *
 * This is the design ruling this function exists to implement. The campaign-authored `P`
 * cell marks "the spot the level was built to be entered from", and a symmetric mode
 * should have no such spot, so P1 does not inherit it. In versus the authored `P` is
 * ignored for placement; it remains in the grid as data, and `loadArena` still stamps
 * P1's tank there in PASS 1a before relocating it here, which is what keeps tank ids (and
 * therefore every seeded RNG stream keyed on them) identical to a one-player load.
 *
 * Three stages, each earning its place against the measured alternative:
 *
 *  1. Anchor (`anchorCell`) -- an approximate geodesic-diameter endpoint.
 *  2. Greedy chain -- `pickVersusSpawnCell` once per remaining player, each against the
 *     spawns already chosen. Classic farthest-point sampling.
 *  3. Relaxation -- bounded coordinate ascent. Each round re-picks every spawn in turn
 *     against the other `count - 1`, keeping the new cell only if the whole set's
 *     separation strictly improves. Stops as soon as a full round changes nothing.
 *
 * Stage 3 is not polish: greedy farthest-point sampling is anchor-sensitive. Measured
 * over the 15 (shipped arena, player count) pairs when this landed, the chain alone was
 * worse than P1-on-`P` placement on 2 of them; with relaxation it beat that placement on
 * all 15, on both the geodesic and the Euclidean measure, with zero regressions.
 *
 * Returns exactly `count` cells, `[0]` being P1's. Degenerate boards degrade rather than
 * throw, inheriting `pickVersusSpawnCell`'s own zero-candidate fallback.
 */
export function pickVersusSpawnSet(
  grid: readonly string[],
  cols: number,
  rows: number,
  cellSize: number,
  legend: Readonly<Record<string, WallKind>>,
  count: number,
  opts: SpawnPickOptions = {},
): Cell[] {
  const walkable: boolean[][] = [];
  const cands: Cell[] = [];
  for (let r = 0; r < rows; r++) {
    walkable.push([]);
    for (let c = 0; c < cols; c++) {
      const ch = grid[r][c];
      walkable[r].push(isWalkable(ch, legend));
      if (isOpenFloor(ch)) cands.push({ row: r, col: c });
    }
  }
  if (count <= 0) return [];
  // No open floor anywhere: the same total, no-throw degradation pickVersusSpawnCell
  // takes. separateTanks (world.ts) already runs every tick and handles worse overlaps.
  // Distinct objects, not `new Array(count).fill(cell)` -- that fills every slot with one
  // shared reference, and callers treat these as their own to keep.
  if (cands.length === 0) return Array.from({ length: count }, () => ({ row: 0, col: 0 }));

  // The anchor honours the same wall/boundary clearance as every later pick (no
  // pairwise term -- nothing is placed yet), with the same fall-back-to-unfiltered
  // degradation when a cramped board leaves nothing eligible.
  const margin = opts.clearanceMargin === undefined ? VERSUS_SPAWN_CLEARANCE_MARGIN : opts.clearanceMargin;
  let anchorCands = cands;
  if (margin !== null) {
    const wallRequired = TANK_RADIUS + margin;
    const walls = wallsForQuery(grid, cols, rows, cellSize, legend);
    const clear = cands.filter((cand) => {
      const p = cellCentre(cand, cellSize);
      if (Math.min(p.x, p.y, cols * cellSize - p.x, rows * cellSize - p.y) < wallRequired) return false;
      for (const w of walls) if (wallDistance(p, w) < wallRequired) return false;
      return true;
    });
    if (clear.length > 0) anchorCands = clear;
  }

  let cells: Cell[] = [anchorCell(anchorCands, walkable, cols, rows)];
  for (let i = 1; i < count; i++) {
    cells.push(pickVersusSpawnCell(grid, cols, rows, cellSize, legend, cells.map((c) => cellCentre(c, cellSize)), opts));
  }

  let score = setSeparation(cells, walkable, cols, rows, cellSize);
  for (let round = 0; round < VERSUS_RELAX_ROUNDS; round++) {
    let changed = false;
    for (let i = 0; i < cells.length; i++) {
      const others = cells.filter((_, j) => j !== i);
      if (others.length === 0) break; // a 1-player set has nothing to be separated from
      const cand = pickVersusSpawnCell(grid, cols, rows, cellSize, legend, others.map((c) => cellCentre(c, cellSize)), opts);
      const next = cells.slice();
      next[i] = cand;
      const nextScore = setSeparation(next, walkable, cols, rows, cellSize);
      // Strict improvement only. This is the termination argument: the score is bounded
      // above and rises every time the set moves, so the loop cannot cycle.
      if (isBetterSeparation(nextScore, score)) {
        cells = next;
        score = nextScore;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return cells;
}

/**
 * The hull-clearance safety margin (issue #225): a spawn centre must clear every
 * intact wall AABB and the arena boundary by `TANK_RADIUS + this`, and every other
 * spawn by `2 * TANK_RADIUS + this`. 0.15 is derived, not taste: the arena-geometry
 * spec's traversability rule calls a point free at >= 0.65 world units from every
 * wall (half the 1.3 corridor minimum), and 0.65 - TANK_RADIUS (0.5) = 0.15 -- so
 * spawn-eligible points are exactly free points, and a tank never spawns anywhere
 * the traversability check would not let it drive. Shipped boards do feel this
 * bound: at cellSize 2/3 a cell beside a wall face or the boundary has its centre
 * only 1/3 from it, so the filter moves spawns off those cells; the shipped sweep in
 * versus-spawns.test.ts pins every shipped (arena, N) spawn set hull-clear.
 */
export const VERSUS_SPAWN_CLEARANCE_MARGIN = 0.15;

/** Point-to-AABB surface distance: 0 inside, the usual per-axis clamp outside. */
function wallDistance(p: Vec2, w: Wall): number {
  const dx = Math.max(w.aabb.minX - p.x, p.x - w.aabb.maxX, 0);
  const dy = Math.max(w.aabb.minY - p.y, p.y - w.aabb.maxY, 0);
  return Math.hypot(dx, dy);
}

/**
 * Every hull-clearance violation for already-picked spawn positions, one line per
 * violation (empty = clean) -- the loud half of issue #225, and the default rule
 * behind versus-catalog-rules.ts's `spawn-clearance` seam (issue #312). Callers pass
 * the match-start grid (the variant-applied one -- every real caller already holds
 * exactly that), so "validate clearance against destructible-wall variants as they
 * exist at match start" costs nothing extra: `wallsForQuery` builds intact solids
 * and intact destructibles, and a destructible really does block a hull at the
 * instant of spawning.
 *
 * Deterministic and total: a pure function of its arguments; no throw on any input.
 */
export function versusSpawnClearanceFailures(
  grid: readonly string[],
  cols: number,
  rows: number,
  cellSize: number,
  legend: Readonly<Record<string, WallKind>>,
  positions: readonly Vec2[],
  margin: number = VERSUS_SPAWN_CLEARANCE_MARGIN,
): string[] {
  const walls = wallsForQuery(grid, cols, rows, cellSize, legend);
  const wallRequired = TANK_RADIUS + margin;
  const pairRequired = 2 * TANK_RADIUS + margin;
  const failures: string[] = [];
  positions.forEach((p, i) => {
    const at = `spawn[${i}] at (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`;
    let nearestWall = Infinity;
    for (const w of walls) nearestWall = Math.min(nearestWall, wallDistance(p, w));
    if (nearestWall < wallRequired) {
      failures.push(`${at}: wall clearance ${nearestWall.toFixed(3)} < ${wallRequired.toFixed(3)}`);
    }
    const boundary = Math.min(p.x, p.y, cols * cellSize - p.x, rows * cellSize - p.y);
    if (boundary < wallRequired) {
      failures.push(`${at}: boundary clearance ${boundary.toFixed(3)} < ${wallRequired.toFixed(3)}`);
    }
    for (let j = i + 1; j < positions.length; j++) {
      const d = Math.hypot(positions[j].x - p.x, positions[j].y - p.y);
      if (d < pairRequired) {
        failures.push(`spawn[${i}]..spawn[${j}]: pairwise distance ${d.toFixed(3)} < ${pairRequired.toFixed(3)}`);
      }
    }
  });
  return failures;
}
