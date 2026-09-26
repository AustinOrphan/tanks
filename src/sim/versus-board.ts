import type { Arena } from './arena';
import { loadArena, ARENA_DEFS } from './arena';
import { lineOfSight } from './ai/targeting';
import { circleVsAABB } from './collision';
import { TANK_RADIUS, MINE_BLAST_RADIUS } from './constants';

/**
 * A checkable definition of whether a board is fit for versus play at N players --
 * a directive that multiplayer maps need their own rules, distinct from campaign maps.
 * See docs/superpowers/plans/2026-08-17-versus-board-rules.md for the full design
 * ruling and the measured table this module produces.
 *
 * Campaign boards encode campaign intent: `config/validate.ts` locks every arena to
 * exactly one `P`, and `arena-claims.ts` checks claims about a single player facing
 * arranged enemies. Versus wants close to the opposite -- several mutually-hidden
 * starts and rough symmetry -- so this is its own rule set, not an extension of
 * `ArenaClaim`, and nothing here is stamped into `arenas.json`: the validator rejects
 * unknown keys, and a new field would move the replay data fingerprint (the stamp
 * docs/agent/architecture.md describes) for a change that has nothing to do with
 * reproducing a replay.
 *
 * Every criterion is derived from the arena's own geometry, as versus spawn placement
 * (versus-spawns.ts) is, rather than from authored data -- so it works on generated boards
 * too (tools/mapgen gates on it), the same reasoning versus-spawns.ts's module doc gives
 * for not using authored spawn points.
 *
 * Nothing in the shipped path calls this module, and nothing the golden trace runs reaches
 * it. The versus menu offers boards from the declarations in `versus-catalog.json`, and
 * versus-catalog-rules.ts checks each declaration against `evaluateVersusBoard` in CI.
 */

/**
 * The real placement sequence, not a re-derivation of it: `loadArena(arena, playerCount,
 * 'ffa')` runs the same `pickVersusSpawnSet` placement `loadArena`'s versus branch runs
 * at real game start, against the exact wall geometry (`walls`, PASS 2a/2b plus the
 * boundary ring) real gameplay collides and sights against. 'ffa' stands in for both
 * versus modes: they share PASS 1b's placement branch and differ only in whether
 * `tank.team` gets stamped, which this module never reads. versus-board.test.ts pins that
 * 'teams' places every player identically.
 */
function versusPlayerPositions(arena: Arena, playerCount: number): { positions: { x: number; y: number }[]; walls: ReturnType<typeof loadArena>['walls'] } {
  const { tanks, walls } = loadArena(arena, playerCount, 'ffa');
  const positions = tanks.filter((t) => t.kind === 'player').map((t) => t.pos);
  return { positions, walls };
}

/**
 * Open-floor cell count -- the same predicate versus spawn placement uses for its
 * candidate pool (`isOpenFloor` in versus-spawns.ts: exactly the `.` cells, excluding
 * solid, destructible and every spawn letter). Not imported from there because that
 * predicate is a private one-liner (`ch === '.'`), and spelling it out here shows plainly
 * what `MIN_OPEN_FLOOR_PER_PLAYER` counts.
 */
function countOpenFloor(arena: Arena): number {
  let open = 0;
  for (const row of arena.grid) for (const ch of row) if (ch === '.') open++;
  return open;
}

/**
 * A tenth of the tightest figure measured across every shipped (arena, N) combination when
 * this was derived -- arena-02 at N=4, 742 open-floor cells / 4 players = 185.50 --
 * floored: 185.50 / 10 = 18.55 -> 18. Comfortably below the measured floor, so a future
 * board has headroom before this needs retuning.
 *
 * That derivation no longer describes the fleet. Two boards authored for versus are
 * smaller than any campaign board (vs-duel-01 27x21, vs-tri-01 27x17); no shipped
 * combination fails the bound, but the tightest is now 72.25 (vs-tri-01 at N=4, 4.01x the
 * bound, a count it is not offered at) and the tightest offered one is 96.33 (vs-tri-01 at
 * N=3).
 * `versus-board.test.ts` enforces a 4x margin over the offered combinations and only
 * reports the shipped ones (issue #722); issue #418 tracks replacing the multiplier with a
 * floor from playtest evidence.
 *
 * The bound is a real, checkable gate rather than a decorative one: `versus-board.test.ts`'s
 * synthetic small-pillar-room fixture fails it at N=3 and N=4 while passing separation and
 * concealment cleanly.
 */
export const MIN_OPEN_FLOOR_PER_PLAYER = 18;

/**
 * A structured verdict for one (arena, N) pair -- the measured figures behind
 * `suitable`, not just the boolean. `versus-board.test.ts`'s shipped-arena sweep
 * asserts the separation, concealment and room fields alongside `suitable`, so a
 * criterion regressing silently (a correct `suitable` for the wrong reason) is still
 * visible.
 */
export interface VersusBoardVerdict {
  readonly playerCount: number;

  /** True iff every field below that gates `suitable` holds. */
  readonly suitable: boolean;

  /** How many of the `playerCount` real placements landed on distinct cells. */
  readonly spawnCount: number;
  /** `spawnCount === playerCount`. */
  readonly distinctSpawns: boolean;

  /** `C(playerCount, 2)` -- every spawn pair once. */
  readonly totalPairs: number;
  /** How many of `totalPairs` lack mutual line of sight. */
  readonly concealedPairs: number;
  /** `concealedPairs === totalPairs` -- the versus-board-rules plan named in the module
   * doc records why the bar is "every pair", not a fraction. */
  readonly allPairsConcealed: boolean;

  /** The arena's open-floor cell count (constant across N; carried per-verdict for
   * convenience, since a caller iterating a table wants it alongside the ratio). */
  readonly openFloorCells: number;
  /** `openFloorCells / playerCount`. */
  readonly openFloorPerPlayer: number;
  /** `openFloorPerPlayer >= MIN_OPEN_FLOOR_PER_PLAYER`. */
  readonly roomOk: boolean;

  /**
   * How many spawns share the largest connected region of tank-legal space with
   * destructible walls removed (issue #423). `playerCount` means every player can reach
   * every other once destructibles are cleared.
   */
  readonly spawnsInLargestRegion: number;
  /**
   * Two conditions, not one: `solidlyConnected` -- every spawn standing on tank-legal
   * space and all of them sharing the largest region of it -- and `fatalEscapes === 0`.
   * See `evaluateSpawnEgress`.
   *
   * The two disagree on shipped data, so `spawnsInLargestRegion === playerCount` is not a
   * stand-in for this field (issue #818): vs-duel-01 at N=3 and N=4 has every spawn in the
   * largest region and is still refused, for 1 and 2 fatal escapes.
   */
  readonly egressOk: boolean;
  /**
   * How many spawns share no destructible-free region with any other spawn -- i.e. must
   * blow a way out with a mine to meet anyone. Reported, not gated: arena-02 at N=2 and
   * N=3 is legitimately like this. See `tankLegalComponents` for the full reasoning.
   */
  readonly sealedSpawns: number;
  /**
   * How many spawns are sealed by destructibles in a pocket too small to retreat out of a
   * mine blast -- i.e. the player must spend a life to leave the start line. Gated: only a
   * mine clears a destructible, and a mine kills within `MINE_KILL_RADIUS`.
   */
  readonly fatalEscapes: number;
  /**
   * Human-readable cause when `egressOk` is false: which spawns are cut off from which,
   * so a failure names the blocked slot instead of only the board. Empty when it holds.
   */
  readonly egressDiagnosis: string;
}

/**
 * Whether every spawn can actually drive to every other one (issue #423).
 *
 * Every other check in this module reasons about cells, and a cell is not a tank.
 * `cellSize` on the dedicated boards is 0.6667 while a tank is `2 * TANK_RADIUS` = 1.0
 * across -- 1.5 cells -- so a one-cell gap is "walkable" to a cell-based check and has no
 * legal tank-centre position at all. Keystone and Quarters (vs-tri-01 and vs-quad-01
 * before their rebuilds) passed clearance, connectivity, symmetry, path-distance and
 * scripted playtests and still left players unable to leave their spawns.
 *
 * What is gated: with destructible walls removed -- a player may blow through those --
 * every spawn must sit in one shared connected region of tank-legal space. That is the
 * issue's "usable tank-sized egress into a shared combat space": if the solid layout
 * partitions the spawns, no amount of play brings the players together.
 *
 * Second gate: a sealed spawn must survive its own escape. Only a mine clears a
 * destructible wall -- `destructibleByBlast` in mines.ts; shells treat every intact wall
 * alike -- and a mine kills within `MINE_BLAST_RADIUS + TANK_RADIUS` = 2.5. So a spawn
 * walled in by destructibles is playable only if its pocket is big enough to lay the mine
 * and then retreat out of the blast. If it is not, the player pays a life simply to leave
 * the start line, which is not a board being hard -- it is a board being broken.
 *
 * On shipped data the two cases are far apart: arena-02's destructible-sealed pockets are
 * about 22 across, and it stays suitable (on a board carrying 72 destructible blocks,
 * blowing through to reach an opponent is the design), while vs-duel-01's third and fourth
 * spawns land in pockets 2.24 across and it is refused at N=3 and N=4.
 *
 * Residual, stated rather than hidden: the pocket-diameter test is necessary, not
 * sufficient. It proves the player has somewhere to retreat to; it does not prove the
 * retreat is reachable from the specific spot the mine must be laid. A pocket shaped like
 * a long dead-end corridor could pass this and still be fatal. Closing that needs a
 * per-mine-position reachability search, which is worth doing if a board ever fails
 * playtesting while passing here.
 *
 * The lattice step is `cellSize / 8`, not a magic constant. The narrowest passage a tank
 * can use is 2 cells (1.333), leaving a legal centre band of `1.333 - 1.0 = 0.333`; four
 * samples across that band means the minimum legal passage cannot alias closed.
 * `versus-board.test.ts` pins both ends: a 1-cell passage fails and a 2-cell passage passes.
 */
function tankLegalComponents(
  arena: Arena,
  positions: readonly { x: number; y: number }[],
  walls: ReturnType<typeof loadArena>['walls'],
): { labels: number[]; sizes: number[]; diameters: number[] } {
  const width = arena.cols * arena.cellSize;
  const height = arena.rows * arena.cellSize;
  const step = arena.cellSize / 8;
  const nx = Math.max(1, Math.floor(width / step));
  const ny = Math.max(1, Math.floor(height / step));
  const idx = (i: number, j: number) => i * ny + j;

  // Start from "legal everywhere inside the wall-free border", then rasterise each wall
  // into the lattice cells it can possibly block. Testing every wall at every lattice
  // point is O(lattice x walls) (measured at 44s on one variant sweep). A wall can only
  // block points within TANK_RADIUS of its box, so each wall touches a small
  // neighbourhood; the exact `circleVsAABB` test still decides every cell, so this is a
  // speed change and not an approximation. (Expanding the AABB and marking the whole
  // rectangle would be an approximation -- it would block the rounded corners a tank can
  // actually occupy.)
  const legal = new Uint8Array(nx * ny);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x = (i + 0.5) * step;
      const y = (j + 0.5) * step;
      if (x - TANK_RADIUS < 0 || y - TANK_RADIUS < 0 || x + TANK_RADIUS > width || y + TANK_RADIUS > height) continue;
      legal[idx(i, j)] = 1;
    }
  }
  for (const wall of walls) {
    const b = wall.aabb;
    const i0 = Math.max(0, Math.floor((b.minX - TANK_RADIUS) / step) - 1);
    const i1 = Math.min(nx - 1, Math.ceil((b.maxX + TANK_RADIUS) / step) + 1);
    const j0 = Math.max(0, Math.floor((b.minY - TANK_RADIUS) / step) - 1);
    const j1 = Math.min(ny - 1, Math.ceil((b.maxY + TANK_RADIUS) / step) + 1);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = idx(i, j);
        if (legal[k] !== 1) continue;
        if (circleVsAABB({ x: (i + 0.5) * step, y: (j + 0.5) * step }, TANK_RADIUS, b).hit) legal[k] = 0;
      }
    }
  }

  const label = new Int32Array(nx * ny).fill(-1);
  const sizes: number[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (legal[idx(i, j)] !== 1 || label[idx(i, j)] !== -1) continue;
      const id = sizes.length;
      let count = 0;
      const stack = [i, j];
      label[idx(i, j)] = id;
      while (stack.length > 0) {
        const cy = stack.pop() as number;
        const cx = stack.pop() as number;
        count += 1;
        const around = [cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1];
        for (let n = 0; n < around.length; n += 2) {
          const ax = around[n];
          const ay = around[n + 1];
          if (ax < 0 || ay < 0 || ax >= nx || ay >= ny) continue;
          const k = idx(ax, ay);
          if (legal[k] !== 1 || label[k] !== -1) continue;
          label[k] = id;
          stack.push(ax, ay);
        }
      }
      sizes.push(count);
    }
  }

  // Per-component extent, as the bounding-box diagonal of its lattice cells. Used only to
  // ask whether a sealed pocket is wide enough to retreat out of a mine blast, so an
  // over-estimate is the safe direction: it can only let a marginal board through, never
  // refuse a roomy one, and the shipped pockets this separates (2.24 against about 22)
  // differ by nearly a factor of ten.
  const box = sizes.map(() => ({ minI: Infinity, maxI: -Infinity, minJ: Infinity, maxJ: -Infinity }));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const id = label[idx(i, j)];
      if (id < 0) continue;
      const b = box[id];
      if (i < b.minI) b.minI = i;
      if (i > b.maxI) b.maxI = i;
      if (j < b.minJ) b.minJ = j;
      if (j > b.maxJ) b.maxJ = j;
    }
  }
  const diameters = box.map((b) => Math.hypot((b.maxI - b.minI) * step, (b.maxJ - b.minJ) * step));

  const labels = positions.map((p) => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor(p.x / step)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor(p.y / step)));
    return label[idx(i, j)];
  });
  return { labels, sizes, diameters };
}

/** The radius `detonateMine` actually kills at -- the distance a player must retreat. */
export const MINE_KILL_RADIUS = MINE_BLAST_RADIUS + TANK_RADIUS;

function evaluateSpawnEgress(
  arena: Arena,
  positions: readonly { x: number; y: number }[],
  walls: ReturnType<typeof loadArena>['walls'],
): {
  spawnsInLargestRegion: number;
  egressOk: boolean;
  sealedSpawns: number;
  fatalEscapes: number;
  egressDiagnosis: string;
} {
  const solid = walls.filter((w) => w.kind !== 'destructible');
  const { labels, sizes } = tankLegalComponents(arena, positions, solid);

  const tally = new Map<number, number>();
  for (const l of labels) tally.set(l, (tally.get(l) ?? 0) + 1);
  let spawnsInLargestRegion = 0;
  for (const n of tally.values()) if (n > spawnsInLargestRegion) spawnsInLargestRegion = n;
  const solidlyConnected = positions.length > 0
    && spawnsInLargestRegion === positions.length
    && labels.every((l) => l >= 0);

  // The state the player actually starts in: nothing destroyed yet.
  const intact = tankLegalComponents(arena, positions, walls);
  const softTally = new Map<number, number>();
  for (const l of intact.labels) softTally.set(l, (softTally.get(l) ?? 0) + 1);
  const sealedSpawns = intact.labels.filter((l) => (softTally.get(l) ?? 0) === 1).length;

  // A sealed spawn must have room to lay the mine and get clear of it.
  const fatal: number[] = [];
  for (let s = 0; s < positions.length; s++) {
    const l = intact.labels[s];
    if (l < 0) { fatal.push(s); continue; }
    if ((softTally.get(l) ?? 0) > 1) continue; // shares its pocket with another player
    if ((intact.diameters[l] ?? 0) < MINE_KILL_RADIUS) fatal.push(s);
  }
  const fatalEscapes = fatal.length;

  const egressOk = solidlyConnected && fatalEscapes === 0;

  const parts: string[] = [];
  if (!solidlyConnected) {
    const groups = [...tally.entries()].map(([l]) => {
      const slots = labels.map((x, s) => (x === l ? `P${s + 1}` : '')).filter(Boolean).join('+');
      return l < 0 ? `${slots} on no tank-legal cell` : `${slots} in a solid-walled region of ${sizes[l]} lattice cells`;
    });
    parts.push(`${groups.length} disjoint spawn region(s) with destructibles removed: ${groups.join('; ')}`);
  }
  if (fatalEscapes > 0) {
    parts.push(fatal.map((s) => {
      const l = intact.labels[s];
      const d = l < 0 ? 0 : (intact.diameters[l] ?? 0);
      return `P${s + 1} is sealed by destructibles in a pocket only ${d.toFixed(2)} across, under the ${MINE_KILL_RADIUS} mine kill radius -- escaping costs a life`;
    }).join('; '));
  }
  return { spawnsInLargestRegion, egressOk, sealedSpawns, fatalEscapes, egressDiagnosis: parts.join(' | ') };
}

/**
 * Evaluates one arena at one player count. Pure and deterministic: `loadArena` and
 * `lineOfSight` take no wall clock and no `Math.random` (src/sim/purity.test.ts bans both
 * in the sim), so the same `(arena, playerCount)` always yields the same verdict --
 * `versus-board.test.ts` pins this directly.
 *
 * Report, don't gatekeep: nothing here throws or truncates a player count, and nothing
 * in `loadArena` consults this function's result -- a board with `suitable: false` still
 * loads and plays. What the menu offers comes from `versus-catalog.json` (see the module
 * doc).
 *
 * `distinctSpawns` is measured and reported, but it cannot fail on its own: given
 * `MIN_OPEN_FLOOR_PER_PLAYER` >= 1, `roomOk` (`openFloorCells / playerCount >=
 * MIN_OPEN_FLOOR_PER_PLAYER`) already implies `openFloorCells >= playerCount`, and since
 * all `playerCount` spawns, P1 included, come out of the open-floor pool (see
 * `pickVersusSpawnSet`) and each pick excludes the cells already taken, that is enough
 * for them to stay distinct. So on every fixture this module's own criteria can
 * construct, `distinctSpawns` false implies `roomOk` false too, never the other way
 * round. `versus-board.test.ts` discloses this: a dedicated mutation targets
 * `distinctSpawns`'s own computation, and dropping it from the `suitable` conjunction is
 * named as an equivalent mutation rather than added to the manifest as `killed`, because
 * no fixture -- shipped or synthetic -- can tell the difference. This is a fact about
 * this module's specific formulas (both keyed off the same open-floor cell count), not a
 * general law; a room metric not based on raw floor-cell count could decouple them, which
 * is part of why the field stays independently reported rather than folded away.
 */
export function evaluateVersusBoard(arena: Arena, playerCount: number): VersusBoardVerdict {
  const { positions, walls } = versusPlayerPositions(arena, playerCount);

  const spawnCount = new Set(positions.map((p) => `${p.x},${p.y}`)).size;
  const distinctSpawns = spawnCount === playerCount;

  let totalPairs = 0;
  let concealedPairs = 0;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      totalPairs++;
      if (!lineOfSight(positions[i], positions[j], walls)) concealedPairs++;
    }
  }
  const allPairsConcealed = concealedPairs === totalPairs;

  const openFloorCells = countOpenFloor(arena);
  const openFloorPerPlayer = openFloorCells / playerCount;
  const roomOk = openFloorPerPlayer >= MIN_OPEN_FLOOR_PER_PLAYER;

  // Issue #423. Folded into `suitable` rather than merely reported, because the two
  // boards this caught were suitable by every other measure and unplayable in fact.
  const { spawnsInLargestRegion, egressOk, sealedSpawns, fatalEscapes, egressDiagnosis } = evaluateSpawnEgress(arena, positions, walls);

  return {
    playerCount,
    suitable: distinctSpawns && allPairsConcealed && roomOk && egressOk,
    spawnCount,
    distinctSpawns,
    totalPairs,
    concealedPairs,
    allPairsConcealed,
    openFloorCells,
    openFloorPerPlayer,
    spawnsInLargestRegion,
    egressOk,
    sealedSpawns,
    fatalEscapes,
    egressDiagnosis,
    roomOk,
  };
}

/** One `evaluateVersusBoard` row, labelled with the arena it measured -- what a table
 * or a sweep wants to iterate. */
export interface VersusBoardCatalogRow extends VersusBoardVerdict {
  readonly arenaId: string;
}

/**
 * Every (arena, N) verdict in the catalog -- the measurement behind which maps may be
 * offered at a given player count (versus-config.test.ts checks the shipped offer against
 * it). `arenas` defaults to `ARENA_DEFS` (8 shipped boards) and `playerCounts` to `[2,
 * 3, 4]` (versus mode's own supported range -- `devflags.ts`'s `players` flag rejects
 * anything outside 1-4), but both are parameters rather than hardcoded so
 * `versus-board.test.ts` can run the same function against synthetic fixtures.
 */
export function versusBoardCatalog(
  arenas: readonly (Arena & { readonly id: string })[] = ARENA_DEFS,
  playerCounts: readonly number[] = [2, 3, 4],
): VersusBoardCatalogRow[] {
  const rows: VersusBoardCatalogRow[] = [];
  for (const arena of arenas) {
    for (const playerCount of playerCounts) {
      rows.push({ arenaId: arena.id, ...evaluateVersusBoard(arena, playerCount) });
    }
  }
  return rows;
}
