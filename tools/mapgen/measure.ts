import type { Arena } from '../../src/sim/arena';
import { loadArena } from '../../src/sim/arena';
import { lineOfSight } from '../../src/sim/ai/targeting';
import { circleVsAABB, reflectSweep } from '../../src/sim/collision';
import type { Wall } from '../../src/sim/types';
import {
  TANK_RADIUS,
  BULLET_RADIUS,
  NORMAL_SPEED,
  NORMAL_BOUNCES,
  AI_SHOT_LOOKAHEAD,
} from '../../src/sim/constants';

/**
 * QUALITY measures for a versus board -- the tier that RANKS two boards which both
 * already pass validation, which is the one thing `src/sim/versus-board.ts` deliberately
 * does not do.
 *
 * That module's own doc comment says so plainly: "MEASURED, NOT DISCRIMINATING ON SHIPPED
 * DATA ... 0 of 15 (arena, N) combinations fail it". Its criteria are a FILTER that rejects
 * broken boards -- spawns that share a cell, spawns that cannot drive to each other, a
 * pocket too small to survive your own mine. Nothing in it says whether a board is worth
 * playing on. A generator tuned against a filter converges on "not broken", which is not
 * the target.
 *
 * So this module is a separate tier with a separate job, and the split is deliberate:
 *
 *   acceptance (src/sim/versus-board.ts)  pass/fail, gates, already shipped, unchanged
 *   quality    (this file)                numbers, never gates, ranks passing boards
 *
 * NOTHING HERE GATES ANYTHING and nothing here is imported by the game. It lives under
 * `tools/` rather than `src/sim/` for exactly that reason: a new field on an arena or a new
 * module under `src/sim/` is a determinism-surface change (`arena-types.ts` records that the
 * validator rejects unknown keys, and `versus-board.ts` records that it was kept unreachable
 * so `BASELINE_HASH` stays put). A measurement tool has no business moving either.
 *
 * TWO SPACES, NEVER CONFLATED. Every measure below states which one it lives in.
 *
 *   TANK SPACE -- where a tank may legally BE. A tank is 1.0 across and `cellSize` is
 *   0.667, so a one-cell gap is "open floor" to a cell-based flood fill and contains no
 *   legal tank centre at all. Every mobility measure is therefore computed on a sub-cell
 *   lattice of points at least TANK_RADIUS from every wall box and from the board edge --
 *   the same construction `versus-board.ts`'s own `tankLegalComponents` uses, and for the
 *   same reason (issue #423: Keystone and Quarters passed clearance, connectivity,
 *   symmetry and path-distance and were still unplayable, because players could not leave
 *   their spawns).
 *
 *   SHELL SPACE -- where a SHELL may go. A shell is 0.1 across, so it crosses the
 *   one-cell slits no tank can use, and a normal shell BOUNCES ONCE. Sightline and
 *   bank-shot measures live here, and they are computed with the real `reflectSweep` the
 *   sim flies shells through, not a re-derivation of it.
 *
 * THE LATTICE IS DUPLICATED FROM `versus-board.ts`, ON PURPOSE. That module's copy is
 * private, and exporting it would widen a shipped sim module's surface for a tool's
 * convenience. The duplication is a liability worth naming: if the clearance rule there
 * changes, this file is wrong until it is changed too. It is checked against the original
 * in `measure.test.ts`, which asserts this lattice's connected-component verdict agrees
 * with `evaluateVersusBoard`'s `egressOk` on every shipped board.
 */

/** A point on the sub-cell lattice, in world units. */
export interface LatticePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The tank-legal lattice for one board.
 *
 * `step` is `cellSize / 8`, matching `versus-board.ts`: the narrowest passage a tank can
 * use is 2 cells (1.333), leaving a legal centre band of `1.333 - 1.0 = 0.333`, and four
 * samples across that band means the minimum legal passage cannot alias closed.
 *
 * `radius` defaults to a tank's own, which is the only value the mobility measures use.
 * `bottleneckWidth` sweeps it upward instead, asking how WIDE a body could still make the
 * same journey -- see that measure for why that is the exact question `routeCount` only
 * bounds.
 */
export interface TankLattice {
  readonly nx: number;
  readonly ny: number;
  readonly step: number;
  /** 1 where a tank centre may legally sit, 0 elsewhere. Indexed `i * ny + j`. */
  readonly legal: Uint8Array;
  readonly legalCount: number;
}

/** Row-major index into a lattice. `nx` is unused by the arithmetic and named only so a
 *  caller passes the lattice's own two dimensions in the order they are declared. */
const idxOf = (_nx: number, ny: number) => (i: number, j: number) => i * ny + j;

/**
 * Build the lattice. Walls are RASTERISED into the cells they can possibly block rather
 * than every wall being tested against every point -- `versus-board.ts` records that the
 * naive loop measured 44s on one variant sweep. The exact `circleVsAABB` test still
 * decides every cell, so this is a speed change and not an approximation.
 */
export function tankLattice(arena: Arena, walls: readonly Wall[], radius: number = TANK_RADIUS): TankLattice {
  const width = arena.cols * arena.cellSize;
  const height = arena.rows * arena.cellSize;
  const step = arena.cellSize / 8;
  const nx = Math.max(1, Math.floor(width / step));
  const ny = Math.max(1, Math.floor(height / step));
  const idx = idxOf(nx, ny);
  const legal = new Uint8Array(nx * ny);

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x = (i + 0.5) * step;
      const y = (j + 0.5) * step;
      if (x - radius < 0 || y - radius < 0) continue;
      if (x + radius > width || y + radius > height) continue;
      legal[idx(i, j)] = 1;
    }
  }
  for (const wall of walls) {
    if (wall.destroyed) continue;
    const b = wall.aabb;
    const i0 = Math.max(0, Math.floor((b.minX - radius) / step) - 1);
    const i1 = Math.min(nx - 1, Math.ceil((b.maxX + radius) / step) + 1);
    const j0 = Math.max(0, Math.floor((b.minY - radius) / step) - 1);
    const j1 = Math.min(ny - 1, Math.ceil((b.maxY + radius) / step) + 1);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = idx(i, j);
        if (legal[k] !== 1) continue;
        const x = (i + 0.5) * step;
        const y = (j + 0.5) * step;
        // `.hit`, and the missing property is not a style point: `circleVsAABB` returns a
        // `Hit` OBJECT, which is truthy whether or not it hit, so without this the rasterised
        // neighbourhood of every wall -- the box grown by `radius` plus a step, square corners
        // and all -- was marked illegal. The lattice still looked broadly right, because that
        // neighbourhood mostly IS the blocked region, which is what made it survive a first
        // calibration run over all 8 shipped boards. It cost the rounded corners a tank can
        // really occupy and one lattice step of margin everywhere, and it read a 3-cell
        // doorway as impassable to anything wider than a 2-cell one. `versus-board.ts:241`
        // has the same call written correctly; this copy dropped the property.
        if (circleVsAABB({ x, y }, radius, b).hit) legal[k] = 0;
      }
    }
  }
  let legalCount = 0;
  for (let k = 0; k < legal.length; k++) legalCount += legal[k];
  return { nx, ny, step, legal, legalCount };
}

/** The lattice index nearest a world position, or -1 if no legal point is within `reach`. */
export function nearestLegal(lat: TankLattice, p: LatticePoint, reach = 1.0): number {
  const idx = idxOf(lat.nx, lat.ny);
  const ci = Math.floor(p.x / lat.step);
  const cj = Math.floor(p.y / lat.step);
  const span = Math.ceil(reach / lat.step);
  let best = -1;
  let bestD = Infinity;
  for (let i = Math.max(0, ci - span); i <= Math.min(lat.nx - 1, ci + span); i++) {
    for (let j = Math.max(0, cj - span); j <= Math.min(lat.ny - 1, cj + span); j++) {
      const k = idx(i, j);
      if (lat.legal[k] !== 1) continue;
      const dx = (i + 0.5) * lat.step - p.x;
      const dy = (j + 0.5) * lat.step - p.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
  }
  return best;
}

/**
 * 4-neighbour BFS over legal lattice points from one source, returning distance in WORLD
 * UNITS (hops * step). 4-neighbour rather than 8 because a diagonal hop between two legal
 * points can cut a corner the tank's hull cannot: the two orthogonal neighbours may both
 * be blocked. That makes every distance here an over-estimate of the true geodesic by up
 * to a factor of sqrt(2) in open ground -- stated rather than hidden, and harmless for the
 * purpose, since every board is measured the same way and only the CONTRASTS are read.
 */
export function geodesic(lat: TankLattice, source: number, blocked?: Uint8Array): Float64Array {
  const dist = new Float64Array(lat.nx * lat.ny).fill(-1);
  if (source < 0 || lat.legal[source] !== 1) return dist;
  if (blocked && blocked[source]) return dist;
  const queue = new Int32Array(lat.legalCount + 1);
  let head = 0;
  let tail = 0;
  queue[tail++] = source;
  dist[source] = 0;
  const { nx, ny, legal } = lat;
  while (head < tail) {
    const k = queue[head++];
    const i = (k / ny) | 0;
    const j = k - i * ny;
    const d = dist[k] + 1;
    if (i > 0) { const n = k - ny; if (legal[n] === 1 && dist[n] < 0 && !(blocked && blocked[n])) { dist[n] = d; queue[tail++] = n; } }
    if (i < nx - 1) { const n = k + ny; if (legal[n] === 1 && dist[n] < 0 && !(blocked && blocked[n])) { dist[n] = d; queue[tail++] = n; } }
    if (j > 0) { const n = k - 1; if (legal[n] === 1 && dist[n] < 0 && !(blocked && blocked[n])) { dist[n] = d; queue[tail++] = n; } }
    if (j < ny - 1) { const n = k + 1; if (legal[n] === 1 && dist[n] < 0 && !(blocked && blocked[n])) { dist[n] = d; queue[tail++] = n; } }
  }
  for (let k = 0; k < dist.length; k++) if (dist[k] > 0) dist[k] *= lat.step;
  return dist;
}

/**
 * How far a shell is worth tracing, in world units: `NORMAL_SPEED * AI_SHOT_LOOKAHEAD` =
 * 6 * 1.5 = 9. Not an invented budget -- it is the horizon the sim's OWN shot-safety check
 * already reasons over, whose comment records it as "about half the arena's long axis, and
 * comfortably past the first two bounces". A bank shot that lands outside a horizon the AI
 * itself will not reason about is not a feature of the board.
 */
export const SHELL_TRACE_REACH = NORMAL_SPEED * AI_SHOT_LOOKAHEAD;

/** A shell grazes a tank at exactly this distance from its centre. */
const HIT_RADIUS = TANK_RADIUS + BULLET_RADIUS;

/** Distance from `p` to segment [a,b], clamped at the endpoints. */
function pointSegmentDistance(p: LatticePoint, a: LatticePoint, b: LatticePoint): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = a.x + t * abx - p.x;
  const dy = a.y + t * aby - p.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * The polyline one shell fired from `from` at `angle` actually flies, as the sim flies it:
 * `reflectSweep` with `NORMAL_BOUNCES` is the same call `bullets.ts` makes every tick, so a
 * carom measured here is a carom the game really offers. The returned array is
 * `[muzzle, bounce..., end]`, and its FIRST segment is the direct-fire part -- everything
 * after the first vertex is only reachable by banking.
 */
export function shellPath(
  from: LatticePoint,
  angle: number,
  wallBoxes: ReturnType<typeof wallAABBs>,
): LatticePoint[] {
  const to = { x: from.x + Math.cos(angle) * SHELL_TRACE_REACH, y: from.y + Math.sin(angle) * SHELL_TRACE_REACH };
  const result = reflectSweep(from, to, wallBoxes, NORMAL_BOUNCES);
  return [from, ...result.hits.map((h) => h.point), result.end];
}

export function wallAABBs(walls: readonly Wall[]) {
  return walls.filter((w) => !w.destroyed).map((w) => w.aabb);
}

/** Everything one board measures. Every field names its space in the doc comment. */
export interface BoardMeasures {
  readonly arenaId: string;
  readonly playerCount: number;
  readonly cols: number;
  readonly rows: number;

  // ---- texture: what the board is made of (CELL space, descriptive) ----
  /** Fraction of grid cells carrying a wall of either kind. */
  readonly wallFraction: number;
  /** Fraction of grid cells carrying a DESTRUCTIBLE wall -- the mine-clearable budget. */
  readonly destructibleFraction: number;
  /** Merged wall rectangles `loadArena` really builds. Solid runs merge; destructibles never do. */
  readonly coverPieces: number;
  /** Mean distance from each wall rectangle's centre to the nearest other one, world units. */
  readonly coverSpacing: number;

  // ---- mobility (TANK space) ----
  /** Fraction of the board's area where a tank centre may legally sit. */
  readonly legalAreaFraction: number;
  /** Fraction of legal area with 2 or fewer of 8 directions clear for 1.5 tank diameters:
   *  corridors, pockets and dead ends, as against rooms you can circle in. NOT the same as
   *  "can be cornered" -- a straight corridor with two exits scores here too. High means the
   *  board is made of lanes, which is a style, not a fault. */
  readonly corridorAreaFraction: number;
  /**
   * Fraction of legal area with 6 or more of 8 clear -- open ground with room to manoeuvre.
   *
   * EDGE-SENSITIVE, by design and worth knowing before reading it: the probe reaches 1.5
   * tank diameters, so every legal point within 1.5 units of the board's own frame loses the
   * directions pointing at it. A completely empty 22x18 board measures 0.68 here, not 1.0,
   * and the missing third is its own rim. Compare boards of the same size, or read the
   * contrast against `corridorAreaFraction` rather than the absolute number.
   */
  readonly openGroundFraction: number;

  // ---- fairness and flow (TANK space, per spawn pair) ----
  /** How many spawn pairs were measurable at all. Every figure below is over THIS
   *  denominator, not `C(playerCount, 2)`: a pair with no solid-only route contributes
   *  nothing rather than a zero, and `unreachablePairs` counts those separately. */
  readonly spawnPairs: number;
  /** Pairs with no tank-legal route even with destructibles removed -- `egressOk`'s failure. */
  readonly unreachablePairs: number;
  /** Pairs that ARE routable through solid-only space but NOT on the intact board: you must
   *  mine through a destructible to reach them. Descriptive, never a fault -- arena-02 and
   *  vs-duel-01 are both deliberately like this. */
  readonly mineGatedPairs: number;
  /** Shortest tank-legal path between spawns, world units: over every measurable pair. */
  readonly pathMin: number;
  readonly pathMean: number;
  readonly pathMax: number;
  /** `(pathMax - pathMin) / pathMean`: 0 means every pair starts equally far apart. */
  readonly pathSpread: number;
  /**
   * The narrowest passage any spawn pair's journey must squeeze through, in world units:
   * the widest body that can still get from one spawn to the other, over every pair, taking
   * the tightest pair. Exact to the ladder step, with no path choice and no cap -- which is
   * what `routeCount` cannot offer, since it is greedy.
   *
   * It reads directly in the gap taxonomy the arena-geometry spec sets out, which is the
   * language a board should be argued in:
   *
   *   0      no route at all, at any width
   *   1.000  a tank fits and nothing wider -- the hull's own width, a scrape
   *   1.333  the MINIMUM legal corridor: 2 cells
   *   2.000  a comfortable corridor: 3 cells, today's standard
   *   2.667+ a room rather than a corridor
   */
  readonly bottleneckWidth: number;
  /**
   * Mean over pairs of how many ROUTE-DISJOINT ways there are from one spawn to the other,
   * counted up to `ROUTE_CAP`. 1.0 means every pair is joined by a single corridor.
   *
   * A GREEDY LOWER BOUND, not the true maximum. Routes are taken shortest-first and each
   * one's hull sweep is removed before the next is sought, so a shortest first route that
   * zig-zags across several lanes can consume ground a smarter pair of routes would have
   * split between them. By Menger's theorem the true figure is the minimum vertex cut; this
   * never exceeds it and can fall below it. Read it as "at least this many ways round".
   */
  readonly routeCount: number;
  /** Mean over pairs that HAVE a second route of (second route length / first). 1.0 means
   *  the alternate costs nothing; large means it is a long way round. */
  readonly secondRouteDetour: number;
  /** How many pairs have only ONE route -- cut that corridor and the pair is separated. */
  readonly singleRoutePairs: number;

  // ---- sightlines and carom (SHELL space, sampled) ----
  /**
   * How many legal sample points the shell measures used -- the DENOMINATOR behind
   * `openSightFraction`, `bankGain` and `bankOnlyFraction`, all three of which are means
   * over pairs drawn from it. It is not a constant: the sample is a 2-unit grid snapped to
   * legal ground, so a tight board yields far fewer points than an open one of the same
   * size, and a bigger board yields more. Read the three fractions beside it, never alone.
   */
  readonly samplePoints: number;
  /** Mean fraction of other sample points with direct line of sight. */
  readonly openSightFraction: number;
  /** Longest direct line of sight between two sample points, world units. */
  readonly longestSightline: number;
  /** ...as a fraction of the board diagonal. */
  readonly longestSightlineRelative: number;
  /** Of the ordered sample pairs with NO direct line of sight and within shell reach, the
   *  fraction a single bounce can still hit. The board's carom offer. */
  readonly bankGain: number;
  /** Of ALL ordered sample pairs within shell reach, the fraction hittable only by banking. */
  readonly bankOnlyFraction: number;

  // ---- symmetry (CELL space) ----
  /** Fraction of cells whose wall kind disagrees with their image under 180-degree
   *  rotation / horizontal mirror / vertical mirror. 0 is exact symmetry. */
  readonly asymmetryRotational: number;
  readonly asymmetryMirrorH: number;
  readonly asymmetryMirrorV: number;
}

/**
 * How many route-disjoint ways between one spawn pair are worth counting. A cap is needed
 * because the search is greedy and an open board would otherwise keep finding lanes until
 * the board ran out; 4 rather than 3 because at 3 every open campaign board saturated the
 * top of the scale and the measure stopped separating them.
 */
export const ROUTE_CAP = 4;

/** 8 compass directions, for the corridor/open-ground probe. */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/**
 * Measure one board at one player count. `mode` is 'ffa' throughout for the same reason
 * `versus-board.ts` gives: both versus modes share the identical placement branch in
 * `loadArena` and differ only in whether `tank.team` is stamped, which nothing here reads,
 * so 'teams' would produce byte-identical positions and walls.
 *
 * `arenaId` is passed in rather than read off the board: the narrow `Arena` shape
 * deliberately carries no id (only `ARENA_DEFS` entries do), and a measurement tool has no
 * reason to demand the wider one -- a generated board has no entry to be looked up in.
 */
export function measureBoard(arena: Arena, playerCount: number, arenaId: string): BoardMeasures {
  const { walls, tanks } = loadArena(arena, playerCount, 'ffa');
  const positions = tanks.filter((t) => t.kind === 'player').map((t) => t.pos);
  const boxes = wallAABBs(walls);
  const lat = tankLattice(arena, walls);
  const width = arena.cols * arena.cellSize;
  const height = arena.rows * arena.cellSize;

  // ---- texture ----
  let wallCells = 0;
  let destructibleCells = 0;
  for (const row of arena.grid) {
    for (const ch of row) {
      const kind = arena.legend[ch];
      if (kind) wallCells++;
      if (kind === 'destructible') destructibleCells++;
    }
  }
  const totalCells = arena.cols * arena.rows;
  // THE BOUNDARY RING IS NOT COVER. `loadArena` frames every board with four walls that lie
  // entirely OUTSIDE the playfield -- on a 5x5 test board they measure y in [-0.667, 0] and
  // y in [3.333, 4.0] against a 3.333-unit board -- so an interior piece is one whose box
  // actually overlaps the open rectangle. Counting the frame gave an empty board 4 pieces of
  // cover, which is what the control in `measure.test.ts` caught.
  const interior = boxes.filter((b) => b.maxX > 0 && b.minX < width && b.maxY > 0 && b.minY < height);
  const centres = interior.map((b) => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }));
  let spacingSum = 0;
  for (let a = 0; a < centres.length; a++) {
    let best = Infinity;
    for (let b = 0; b < centres.length; b++) {
      if (a === b) continue;
      const dx = centres[a].x - centres[b].x;
      const dy = centres[a].y - centres[b].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < best) best = d;
    }
    if (best < Infinity) spacingSum += best;
  }
  const coverSpacing = centres.length > 1 ? spacingSum / centres.length : 0;

  // ---- trap area ----
  // Subsampled every 4th lattice point per axis: the full lattice is ~57k points and this
  // probe is 8 rays each, which is not a cost worth paying for a fraction that does not
  // move between neighbouring points. The subsample is a fixed stride, not a draw, so the
  // figure is reproducible.
  const idx = idxOf(lat.nx, lat.ny);
  const probeReach = 1.5 * (2 * TANK_RADIUS);
  const probeSteps = Math.max(2, Math.round(probeReach / lat.step));
  let probed = 0;
  let corridorLike = 0;
  let openGround = 0;
  for (let i = 0; i < lat.nx; i += 4) {
    for (let j = 0; j < lat.ny; j += 4) {
      if (lat.legal[idx(i, j)] !== 1) continue;
      probed++;
      let open = 0;
      for (const [di, dj] of DIRS) {
        let clear = true;
        for (let s = 1; s <= probeSteps && clear; s++) {
          const ni = i + di * s;
          const nj = j + dj * s;
          if (ni < 0 || nj < 0 || ni >= lat.nx || nj >= lat.ny) clear = false;
          else if (lat.legal[idx(ni, nj)] !== 1) clear = false;
        }
        if (clear) open++;
      }
      if (open <= 2) corridorLike++;
      if (open >= 6) openGround++;
    }
  }

  // ---- fairness and flow ----
  // TWO WALL SETS, and the distinction is the one `versus-board.ts` already draws. Mobility
  // is measured over SOLID-ONLY space, because a player may mine through a destructible and
  // the solid layout is the topology no play can change -- that is the same reasoning
  // `evaluateSpawnEgress` gives for gating on destructible-free connectivity. The intact
  // board is then measured separately, and a pair routable only through a destructible is
  // reported as MINE-GATED rather than as a failure: arena-02's centre barrier and
  // vs-duel-01's divide are both deliberate, and blowing through to reach an opponent is
  // their design.
  const solidWalls = walls.filter((w) => w.kind !== 'destructible');
  const solidLat = tankLattice(arena, solidWalls);
  const intactLat = lat;

  const spawnNodes = positions.map((p) => nearestLegal(solidLat, p));
  const intactNodes = positions.map((p) => nearestLegal(intactLat, p));
  const pairPaths: number[] = [];
  const routeCounts: number[] = [];
  const secondDetours: number[] = [];
  let unreachablePairs = 0;
  let mineGatedPairs = 0;
  let singleRoutePairs = 0;
  for (let a = 0; a < spawnNodes.length; a++) {
    for (let b = a + 1; b < spawnNodes.length; b++) {
      if (spawnNodes[a] < 0 || spawnNodes[b] < 0) { unreachablePairs++; continue; }
      const first = geodesic(solidLat, spawnNodes[a]);
      const open = first[spawnNodes[b]];
      if (open < 0) { unreachablePairs++; continue; }
      pairPaths.push(open);

      // On the INTACT board, is this pair joined without mining?
      if (intactNodes[a] < 0 || intactNodes[b] < 0) mineGatedPairs++;
      else if (geodesic(intactLat, intactNodes[a])[intactNodes[b]] < 0) mineGatedPairs++;

      // ROUTE-DISJOINT COUNT, with no tunable plug radius: walk the shortest route, block
      // every lattice point the TANK'S OWN HULL would sweep along it, and ask for another.
      // Repeat up to three times. An earlier draft plugged a disc at the route's midpoint
      // instead and had to choose that disc's radius; at 2 cells it was wide enough to close
      // a junction as well as the lane, and reported every vs-tri-01 pair as cut on a board
      // that is visibly an open lattice of lanes. Removing exactly the corridor the first
      // route uses asks the question the measure is actually about -- is there another way
      // round -- and the only length in it is TANK_RADIUS, which is not a tuning knob.
      const blocked = new Uint8Array(solidLat.nx * solidLat.ny);
      let routes = 0;
      let lengths: number[] = [];
      let dist: Float64Array | null = first;
      for (let attempt = 0; attempt < ROUTE_CAP; attempt++) {
        if (!dist) dist = geodesic(solidLat, spawnNodes[a], blocked);
        const len = dist[spawnNodes[b]];
        if (len < 0) break;
        routes++;
        lengths.push(len);
        // ONE TANK DIAMETER, not one radius. The block is not "the ground this tank's hull
        // covers" -- it is "where a SECOND tank's centre may not go", and two tanks overlap
        // whenever their centres are closer than 2 * TANK_RADIUS. At one radius a 3-cell
        // doorway (2.0 wide, a 1.0-wide legal band) counted as TWO routes, because the first
        // route ran down one side of the band and left the other side open for a tank that
        // would have been driving through it. The control in `measure.test.ts` pins that.
        for (const node of pathNodes(solidLat, dist, spawnNodes[b])) {
          markDisc(solidLat, blocked, node, 2 * TANK_RADIUS);
        }
        // BOTH ENDPOINTS ARE RE-OPENED, and without this the measure is dead. Two routes
        // between the same two spawns necessarily SHARE those spawns, so blocking the first
        // route's hull sweep blocks the source it started from -- and `geodesic` returns an
        // empty field when its own source is blocked, so every board on every count reported
        // exactly one route and every pair as single-route. That is what a wired knob is
        // supposed to look like when it is not wired. One tank diameter is the clearance
        // re-opened: the two routes may share the ground within a tank-length of each spawn,
        // which they must, and nothing beyond it.
        markDisc(solidLat, blocked, spawnNodes[a], 2 * TANK_RADIUS, 0);
        markDisc(solidLat, blocked, spawnNodes[b], 2 * TANK_RADIUS, 0);
        dist = null;
      }
      routeCounts.push(routes);
      if (routes === 1) singleRoutePairs++;
      if (routes >= 2) secondDetours.push(lengths[1] / lengths[0]);
    }
  }

  // ---- bottleneck width ----
  // Rebuild the legal lattice for a BODY of increasing size and ask, each time, whether the
  // spawns are still joined. The widest body that still gets through is the narrowest
  // passage on the journey. The ladder walks the gap taxonomy's own rungs -- a tank's own
  // width, then whole cells -- rather than an arbitrary sweep, and each radius is pulled one
  // lattice step below the rung so a passage exactly that wide reads as passable rather than
  // aliasing shut on the boundary.
  const rungs: number[] = [2 * TANK_RADIUS];
  for (let cells = 2; cells * arena.cellSize <= Math.min(width, height); cells++) {
    rungs.push(cells * arena.cellSize);
  }
  let bottleneck = 0;
  for (const rung of rungs) {
    const wide = tankLattice(arena, solidWalls, rung / 2 - lat.step);
    const nodes = positions.map((p) => nearestLegal(wide, p, 2.0));
    let allJoined = pairPaths.length > 0;
    for (let a = 0; a < nodes.length && allJoined; a++) {
      if (nodes[a] < 0) { allJoined = false; break; }
      const d = geodesic(wide, nodes[a]);
      for (let b = a + 1; b < nodes.length; b++) {
        if (nodes[b] < 0 || d[nodes[b]] < 0) { allJoined = false; break; }
      }
    }
    if (!allJoined) break;
    bottleneck = rung;
  }

  // ---- sightlines and carom ----
  // A fixed stratified sample: legal points nearest each node of a 2-world-unit grid over
  // the board. Deterministic, evenly spread, and about 90-130 points on shipped sizes --
  // the ordered-pair sweep below is quadratic in this count.
  const sample: LatticePoint[] = [];
  const seen = new Set<number>();
  for (let x = 1; x < width; x += 2) {
    for (let y = 1; y < height; y += 2) {
      const k = nearestLegal(lat, { x, y }, 1.0);
      if (k < 0 || seen.has(k)) continue;
      seen.add(k);
      const i = (k / lat.ny) | 0;
      sample.push({ x: (i + 0.5) * lat.step, y: (k - i * lat.ny + 0.5) * lat.step });
    }
  }
  let sightPairs = 0;
  let sightOpen = 0;
  let longest = 0;
  for (let a = 0; a < sample.length; a++) {
    for (let b = a + 1; b < sample.length; b++) {
      sightPairs++;
      if (!lineOfSight(sample[a], sample[b], walls as Wall[])) continue;
      sightOpen++;
      const dx = sample[a].x - sample[b].x;
      const dy = sample[a].y - sample[b].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > longest) longest = d;
    }
  }

  // Carom: fire a fan from every sample point and record which other sample points each
  // shell's polyline grazes, split by whether the graze happened BEFORE the first bounce
  // (direct fire) or after it (only reachable by banking). 720 angles is half a degree --
  // finer than a player can aim with a 5 rad/s turret and fine enough that a 0.6-radius
  // target at the 9-unit trace reach cannot fall between two rays.
  const ANGLES = 720;
  let inReach = 0;
  let blockedInReach = 0;
  let bankOnly = 0;
  for (let a = 0; a < sample.length; a++) {
    const direct = new Uint8Array(sample.length);
    const banked = new Uint8Array(sample.length);
    for (let t = 0; t < ANGLES; t++) {
      const path = shellPath(sample[a], (t / ANGLES) * Math.PI * 2, boxes);
      for (let b = 0; b < sample.length; b++) {
        if (b === a) continue;
        for (let s = 0; s + 1 < path.length; s++) {
          if (pointSegmentDistance(sample[b], path[s], path[s + 1]) > HIT_RADIUS) continue;
          if (s === 0) direct[b] = 1;
          else banked[b] = 1;
          break;
        }
      }
    }
    for (let b = 0; b < sample.length; b++) {
      if (b === a) continue;
      const dx = sample[a].x - sample[b].x;
      const dy = sample[a].y - sample[b].y;
      if (Math.sqrt(dx * dx + dy * dy) > SHELL_TRACE_REACH) continue;
      inReach++;
      if (direct[b]) continue;
      blockedInReach++;
      if (banked[b]) bankOnly++;
    }
  }

  // ---- symmetry ----
  const kindAt = (r: number, c: number): number => {
    const kind = arena.legend[arena.grid[r][c]];
    return kind === 'solid' ? 2 : kind === 'destructible' ? 1 : 0;
  };
  let rot = 0;
  let mirH = 0;
  let mirV = 0;
  for (let r = 0; r < arena.rows; r++) {
    for (let c = 0; c < arena.cols; c++) {
      const k = kindAt(r, c);
      if (k !== kindAt(arena.rows - 1 - r, arena.cols - 1 - c)) rot++;
      if (k !== kindAt(r, arena.cols - 1 - c)) mirH++;
      if (k !== kindAt(arena.rows - 1 - r, c)) mirV++;
    }
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
  const pathMean = mean(pairPaths);
  return {
    arenaId,
    playerCount,
    cols: arena.cols,
    rows: arena.rows,
    wallFraction: wallCells / totalCells,
    destructibleFraction: destructibleCells / totalCells,
    coverPieces: interior.length,
    coverSpacing,
    legalAreaFraction: lat.legalCount / (lat.nx * lat.ny),
    corridorAreaFraction: probed ? corridorLike / probed : 0,
    openGroundFraction: probed ? openGround / probed : 0,
    spawnPairs: pairPaths.length,
    unreachablePairs,
    mineGatedPairs,
    pathMin: pairPaths.length ? Math.min(...pairPaths) : 0,
    pathMean,
    pathMax: pairPaths.length ? Math.max(...pairPaths) : 0,
    pathSpread: pathMean > 0 ? (Math.max(...pairPaths) - Math.min(...pairPaths)) / pathMean : 0,
    bottleneckWidth: bottleneck,
    routeCount: mean(routeCounts),
    secondRouteDetour: mean(secondDetours),
    singleRoutePairs,
    samplePoints: sample.length,
    openSightFraction: sightPairs ? sightOpen / sightPairs : 0,
    longestSightline: longest,
    longestSightlineRelative: longest / Math.sqrt(width * width + height * height),
    bankGain: blockedInReach ? bankOnly / blockedInReach : 0,
    bankOnlyFraction: inReach ? bankOnly / inReach : 0,
    asymmetryRotational: rot / totalCells,
    asymmetryMirrorH: mirH / totalCells,
    asymmetryMirrorV: mirV / totalCells,
  };
}

/**
 * Every lattice node on one shortest route, from `end` back to the BFS source, by walking
 * downhill through the distance field. Each hop reduces the distance by exactly one lattice
 * step, so the walk terminates in `dist[end] / step` iterations; the guard is a backstop
 * against a corrupted field, not an expected exit.
 */
function pathNodes(lat: TankLattice, dist: Float64Array, end: number): number[] {
  const idx = idxOf(lat.nx, lat.ny);
  const out: number[] = [];
  let k = end;
  if (dist[k] < 0) return out;
  for (let guard = 0; guard < lat.nx * lat.ny; guard++) {
    out.push(k);
    if (dist[k] === 0) break;
    const i = (k / lat.ny) | 0;
    const j = k - i * lat.ny;
    let next = -1;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= lat.nx || nj >= lat.ny) continue;
      const n = idx(ni, nj);
      if (dist[n] >= 0 && dist[n] < dist[k]) { next = n; break; }
    }
    if (next < 0) break;
    k = next;
  }
  return out;
}

/** Write `value` into every lattice point within `radius` of node `k`, in place. */
function markDisc(lat: TankLattice, mask: Uint8Array, k: number, radius: number, value = 1): void {
  const idx = idxOf(lat.nx, lat.ny);
  const ci = (k / lat.ny) | 0;
  const cj = k - ci * lat.ny;
  const span = Math.ceil(radius / lat.step);
  for (let i = Math.max(0, ci - span); i <= Math.min(lat.nx - 1, ci + span); i++) {
    for (let j = Math.max(0, cj - span); j <= Math.min(lat.ny - 1, cj + span); j++) {
      const dx = (i - ci) * lat.step;
      const dy = (j - cj) * lat.step;
      if (dx * dx + dy * dy <= radius * radius) mask[idx(i, j)] = value;
    }
  }
}
