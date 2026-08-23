import type { Vec2, Wall, WallKind } from './types';
import { lineOfSight } from './ai/targeting';
import { mergeSolidRuns } from './wall-merge';
import { TANK_RADIUS } from './constants';

/**
 * Well-separated versus spawn cells, derived from the arena's OWN geometry rather than
 * authored data -- see docs/superpowers/plans/2026-08-17-versus-spawns.md for the design
 * ruling this implements. `loadArena`'s pre-existing co-player placement
 * (`findCoPlayerSpawnCell`, arena.ts) is a bounded ring search radiating from P1's cell,
 * which is exactly right for co-op (partners start together) and exactly wrong for FFA/
 * teams: every player lands in one small ring, in mutual point-blank line of sight.
 *
 * A derived ranking works on any board -- including the procedurally generated maps this
 * repo intends to add later, which cannot carry authored spawn points -- and the same
 * function will later serve "respawn at the safest cell" (the `avoid` parameter is written
 * for that reuse: initial placement passes the already-chosen spawns, a later increment
 * can pass live opponent positions instead -- see `pickVersusSpawnCell`'s own doc comment).
 * Wiring that reuse is out of scope here.
 *
 * CYCLE NOTE: this module imports `lineOfSight` from `ai/targeting.ts`. `arena.ts` (the
 * one caller) already depends on that module transitively, via `world.ts` -> `ai/index.ts`
 * -> `ai/targeting.ts`, so importing it directly here does not add a new dependency
 * direction, only a more direct edge on one that already existed. Checked empirically, not
 * just argued: a forward BFS over every `import` in `ai/targeting.ts`'s own closure (20
 * files, following even type-only imports as if they were value imports, which is a
 * strictly larger reachable set than the real one) never reaches `arena.ts`. This module
 * therefore must never import from `arena.ts` -- that WOULD close the cycle, since
 * `arena.ts` imports this module.
 */

/** A grid cell, row-major -- `arena.ts`'s own coordinate convention. */
export interface Cell {
  readonly row: number;
  readonly col: number;
}

/**
 * The world-space centre of a grid cell. Duplicates the `(c + 0.5) * cellSize` formula
 * that already exists in `arena.ts` (`loadArena`'s own spawn placement) and in
 * `arena-claims.ts`'s `cellCentre` -- that file's own doc comment already flags this
 * formula as recurring with nothing pinning the copies together (`cell-mapping.test.ts`
 * pins two of them). A third copy here is not a new problem, and importing either existing
 * one is not an option: `arena-claims.ts` imports `arena.ts`, and `arena.ts` imports THIS
 * module, so either import would close a cycle back through here.
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
 * `wall-merge.ts`; originally duplicated here, extracted to a shared leaf module once
 * two byte-identical copies of collision-relevant geometry became a maintenance hazard
 * rather than a cycle-avoidance necessity -- see wall-merge.ts's own doc comment),
 * destructible cells one box per cell, never merged, matching PASS 2a/2b of `loadArena`
 * exactly (a destructible cell is a destruction unit, and at spawn time none is
 * destroyed yet, so both kinds block a fresh line of sight the same way they block one
 * mid-round). Deliberately NOT the boundary ring `loadArena` also builds: a query
 * between two interior cell centres can never reach it. These ids are throwaway --
 * `lineOfSight` never inspects `id` -- and this array is never written into a `World`.
 *
 * Exported (only) so `versus-spawns.test.ts` can check its solid-wall rectangles against
 * `loadArena`'s real ones on every shipped arena -- now a proof that both call sites of
 * the SAME shared `mergeSolidRuns` agree with the wall array `loadArena` actually builds
 * from it, rather than a cross-check between two independent copies.
 */
export function wallsForQuery(
  grid: string[],
  cols: number,
  rows: number,
  cellSize: number,
  legend: Record<string, WallKind>,
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
 * Whether a tank can occupy `ch` as open floor -- the SAME test `arena.ts`'s
 * `findCoPlayerSpawnCell` already uses (`grid[row][col] === '.'`), reused rather than
 * reinvented so this module and the ring search it replaces agree on what "fits" means:
 * exactly the plain-floor cells, excluding solid, destructible AND every spawn letter
 * (a spawn letter marks an enemy's authored start, still present in the grid string even
 * though versus mode never instantiates the tank there -- see `loadArena`'s PASS 1a).
 */
function isOpenFloor(ch: string): boolean {
  return ch === '.';
}

/**
 * Whether a tank can DRIVE THROUGH `ch` **at any point in the round** -- broader than
 * `isOpenFloor` in two separate ways, and the second one is a design ruling.
 *
 * First, a former enemy spawn letter is real floor once the game is running (the letter
 * is a data marker, not a wall), so the geodesic graph walks through it even though it is
 * not itself a candidate spawn cell.
 *
 * Second, and deliberately: **a destructible cell counts as traversable.** This is the
 * BREACHED phase, and it is the conservative reading -- a destructible wall is temporary
 * by construction, so two spawns separated only by one are not actually separated for the
 * length of a match. It is the same both-wall-phases discipline `spawnBlockRobust` already
 * applies in `arena-claims.ts`, and it is load-bearing rather than pedantic: measured over
 * all 5 shipped arenas x player counts 2/3/4 (15 pairs), optimising against the INTACT
 * graph instead puts arena-02's 4-player spawns 4 breached-cell-steps and 2.67 world units
 * apart -- two tanks either side of that level's centre barrier, which the level is
 * designed to blow open. Against the breached graph the same board gives 25 steps and
 * 13.74 units. The two graphs pick identical sets on arena-01, arena-03 and arena-04 at
 * every count, so the choice only bites where destructibles partition space -- which is
 * exactly where it matters.
 *
 * The LINE-OF-SIGHT filter in `pickVersusSpawnCell` deliberately does NOT follow this
 * rule: it runs against intact geometry (`wallsForQuery`), because a destructible wall
 * really does block sight at the instant players spawn, and the opening seconds are what
 * that filter is for. Distance is a question about the whole round; concealment is a
 * question about spawn time. Consequence, measured and NOT papered over: on 4 of those 15
 * (arena, count) pairs exactly one spawn pair becomes mutually visible once every
 * destructible is gone. The filter's guarantee is an at-spawn one, never a match-long one.
 */
function isWalkable(ch: string, legend: Record<string, WallKind>): boolean {
  return legend[ch] !== 'solid';
}

/**
 * BFS distances (in CELL STEPS, not world units) from `start` to every walkable cell,
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
 * Picks ONE well-separated versus spawn cell, scoring every open-floor candidate
 * (`isOpenFloor`, same predicate `findCoPlayerSpawnCell` uses) in priority order:
 *
 *  1. HARD FILTER, where achievable: no line of sight to any position in `avoid`. If at
 *     least one candidate qualifies, every candidate that does not is discarded outright
 *     -- a candidate in plain sight of an already-chosen spawn never wins over one that
 *     is not, however far apart the two might be. If NO candidate qualifies (a cramped or
 *     heavily-walled board where every remaining cell can see something in `avoid`), the
 *     filter is skipped and every candidate stays in play: a hard filter that can reject
 *     every candidate is not a filter a caller can use, so falling through to plain
 *     maximin on the full pool is the deliberate degradation.
 *  2. Among the survivors, GREEDY MAXIMIN on GEODESIC distance (BFS cell-steps through
 *     open floor, `geodesicDistances` above, respecting walls -- not Euclidean: two cells
 *     either side of a wall are far apart in play, and two Euclidean-distant cells down
 *     one open lane are not safe from each other). The candidate whose distance to its
 *     NEAREST `avoid` entry is largest wins. This is an APPROXIMATION of the true
 *     "farthest cell from everything already placed" problem (classic p-dispersion), not
 *     its optimum -- see `versus-spawns.test.ts` for a measured gap on one small fixture
 *     via brute force, and `pickVersusSpawnSet` for the relaxation pass that closes some
 *     of that gap in practice.
 *  3. Geodesic ties broken on EUCLIDEAN distance to the nearest `avoid` entry, largest
 *     wins. This is not cosmetic. Geodesic distance saturates at `Infinity` for any cell
 *     in a component `avoid` cannot reach, so on a board whose walls partition it, EVERY
 *     unreachable cell ties at `Infinity` and the positional tie-break below decides --
 *     which picked a cell 2.67 world units from the anchor, straight through the wall, on
 *     arena-02 at 2 players. Preferring the physically-farthest of the equally-unreachable
 *     cells took that to 27.49. Ties still arise constantly on connected boards too (cell
 *     steps are integers), so this key does work on every board, not only partitioned ones.
 *  4. Remaining ties broken deterministically on (row, col) ascending (`isEarlier`), which
 *     is what keeps the whole ranking a pure function of the grid.
 *
 * `avoid` is world-space `Vec2[]`, not cells, so this same signature can later take LIVE
 * OPPONENT POSITIONS for a respawn increment without a type change: today's one caller
 * (`arena.ts`'s `loadArena`) passes the already-chosen spawn positions, converted to
 * `Vec2` from the cells this function itself returned. Wiring an actual respawn call site
 * is out of scope for this change.
 *
 * Falls back to co-locating at `avoid[0]`'s own cell when no open-floor candidate exists
 * anywhere on the board -- the same total, no-throw degradation `findCoPlayerSpawnCell`
 * already uses for its own exhausted-ring case (`separateTanks`, world.ts, already runs
 * every tick and already handles worse overlaps than this). Not reachable on any shipped
 * arena; exercised only by a synthetic negative-control fixture in the test file, because
 * every shipped arena ships far more open floor than 4 players need.
 */
export function pickVersusSpawnCell(
  grid: string[],
  cols: number,
  rows: number,
  cellSize: number,
  legend: Record<string, WallKind>,
  avoid: Vec2[],
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
  // `avoidCells[0]` is P1's cell at every real call site (arena.ts always passes at
  // least one avoid position); the `?? {row:0,col:0}` further guards a hypothetical
  // empty `avoid` array, which no caller sends today, so a truly pathological board
  // still returns a cell rather than throwing.
  if (candidates.length === 0) return avoidCells[0] ?? { row: 0, col: 0 };

  const walls = wallsForQuery(grid, cols, rows, cellSize, legend);
  const avoidDist = avoidCells.map((a) => geodesicDistances(a, walkable, cols, rows));

  const invisible = candidates.filter((cand) => {
    const candPos = cellCentre(cand, cellSize);
    return avoid.every((a) => !lineOfSight(candPos, a, walls));
  });
  const pool = invisible.length > 0 ? invisible : candidates;

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
 * work and the pass only ever accepts a STRICT improvement, so the loop terminates on its
 * own; this is a backstop, not the termination argument. Measured over all 5 shipped
 * arenas x player counts 2/3/4 (15 pairs) the pass converged in at most 4 rounds, so 8 is
 * roughly double the observed worst case and is reached by nothing shipped.
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
 * The ANCHOR: where the first spawn goes when nothing is placed yet.
 *
 * `pickVersusSpawnCell` cannot answer this -- with an empty `avoid` every candidate scores
 * `Infinity` and its own tie-breaks hand back the (row, col)-earliest open cell, which is
 * a board corner by construction and an accident of the tie-break rather than a decision.
 *
 * So the anchor is derived instead, by the standard double-sweep: BFS from an arbitrary
 * deterministic candidate to find the farthest one, then BFS again from THAT to find the
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
 * Picks the WHOLE versus spawn set at once -- `count` mutually well-separated cells, with
 * **no player privileged over any other**.
 *
 * This is the design ruling this function exists to implement. Before it, P1 sat on the
 * campaign-authored `P` cell and every other player was placed to be far from P1. That
 * makes P1's spawn a property of a CAMPAIGN level's design -- where `P` marks "the spot
 * the level was built to be entered from" -- carried unexamined into a symmetric mode
 * where no such spot should exist. In versus the authored `P` is now ignored entirely for
 * placement; it remains in the grid as data, and `loadArena` still stamps P1's tank there
 * in PASS 1a before relocating it here, which is what keeps tank ids (and therefore every
 * seeded RNG stream keyed on them) identical to a one-player load.
 *
 * Three stages, each earning its place against the measured alternative:
 *
 *  1. ANCHOR (`anchorCell`) -- an approximate geodesic-diameter endpoint.
 *  2. GREEDY CHAIN -- `pickVersusSpawnCell` once per remaining player, each against the
 *     spawns already chosen. Classic farthest-point sampling.
 *  3. RELAXATION -- bounded coordinate ascent. Each round re-picks every spawn in turn
 *     against the other `count - 1`, keeping the new cell only if the WHOLE SET's
 *     separation strictly improves. Stops as soon as a full round changes nothing.
 *
 * Stage 3 is not polish. Greedy farthest-point sampling is anchor-sensitive: measured over
 * all 5 shipped arenas x counts 2/3/4 (15 pairs), the chain alone is WORSE than the old
 * P-cell placement on 2 of them (arena-01 and arena-03 at 3 players, 29 breached
 * cell-steps against 34 and 32). With relaxation it beats the old placement on **15 of
 * those 15 pairs, on both the geodesic and the Euclidean measure, with zero regressions**,
 * and improves on the chain alone on 8 of 15. Whole sweep, not a sample: 15 is every
 * (shipped arena, supported player count) pair there is.
 *
 * Returns exactly `count` cells, `[0]` being P1's. Degenerate boards degrade rather than
 * throw, inheriting `pickVersusSpawnCell`'s own zero-candidate fallback.
 */
export function pickVersusSpawnSet(
  grid: string[],
  cols: number,
  rows: number,
  cellSize: number,
  legend: Record<string, WallKind>,
  count: number,
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
  // Distinct objects, not `new Array(count).fill(cell)` -- that fills every slot with ONE
  // shared reference, and callers treat these as their own to keep.
  if (cands.length === 0) return Array.from({ length: count }, () => ({ row: 0, col: 0 }));

  let cells: Cell[] = [anchorCell(cands, walkable, cols, rows)];
  for (let i = 1; i < count; i++) {
    cells.push(pickVersusSpawnCell(grid, cols, rows, cellSize, legend, cells.map((c) => cellCentre(c, cellSize))));
  }

  let score = setSeparation(cells, walkable, cols, rows, cellSize);
  for (let round = 0; round < VERSUS_RELAX_ROUNDS; round++) {
    let changed = false;
    for (let i = 0; i < cells.length; i++) {
      const others = cells.filter((_, j) => j !== i);
      if (others.length === 0) break; // a 1-player set has nothing to be separated from
      const cand = pickVersusSpawnCell(grid, cols, rows, cellSize, legend, others.map((c) => cellCentre(c, cellSize)));
      const next = cells.slice();
      next[i] = cand;
      const nextScore = setSeparation(next, walkable, cols, rows, cellSize);
      // STRICT improvement only. This is the termination argument: the score is bounded
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
 * spawn by `2 * TANK_RADIUS + this`. 0.15 is DERIVED, not taste: the arena-geometry
 * spec's traversability rule calls a point free at >= 0.65 world units from every
 * wall (half the 1.3 corridor minimum), and 0.65 - TANK_RADIUS (0.5) = 0.15 -- so
 * spawn-eligible points are exactly free points, and a tank never spawns anywhere
 * the traversability check would not let it drive. Shipped boards cannot feel this
 * bound: at cellSize 2 an open cell's centre is >= 1.0 from every wall face and
 * boundary (slack 0.5) and distinct centres are >= 2.0 apart (slack 0.85) -- the
 * parity sweep in versus-spawns.test.ts pins that as byte-identical behaviour
 * rather than leaving it as this comment's word.
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
 * violation (empty = clean) -- the loud half of issue #225, and the function
 * versus-catalog-rules.ts's `spawn-clearance` seam (issue #270) consumes once both
 * changes land. Callers pass the MATCH-START grid (the variant-applied one --
 * every real caller already holds exactly that), so "validate clearance against
 * destructible-wall variants as they exist at match start" costs nothing extra:
 * `wallsForQuery` builds intact solids AND intact destructibles, and a destructible
 * really does block a hull at the instant of spawning.
 *
 * Deterministic and total: a pure function of its arguments; no throw on any input.
 */
export function versusSpawnClearanceFailures(
  grid: string[],
  cols: number,
  rows: number,
  cellSize: number,
  legend: Record<string, WallKind>,
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
