import type { Arena } from './arena';
import { loadArena, ARENA_DEFS } from './arena';
import { lineOfSight } from './ai/targeting';
import { circleVsAABB } from './collision';
import { TANK_RADIUS } from './constants';

/**
 * A checkable definition of whether a board is fit for versus play at N players --
 * a directive that multiplayer maps need their own rules, distinct from campaign maps.
 * See docs/superpowers/plans/2026-08-17-versus-board-rules.md for the full design
 * ruling and the measured table this module produces.
 *
 * Campaign boards encode CAMPAIGN intent: `config/validate.ts` hard-locks every arena
 * to exactly one `P`, and `arena-claims.ts` checks claims about a single player facing
 * arranged enemies. Versus wants close to the opposite -- several mutually-hidden
 * starts and rough symmetry -- so this is its OWN rule set, not an extension of
 * `ArenaClaim`, and nothing here is stamped into `arenas.json`: the validator rejects
 * unknown keys, and a new field would move the replay data fingerprint (the STAMP
 * CLAUDE.md describes) for a change that has nothing to do with reproducing a replay.
 *
 * Every criterion is DERIVED from the arena's own geometry, exactly as
 * `pickVersusSpawnCell` (versus-spawns.ts) already is, rather than a second,
 * parallel measure of "fits" -- so it works on generated boards later, the same
 * reasoning versus-spawns.ts's own module doc gives for not using authored spawn
 * points.
 *
 * IMPORT GRAPH, checked before writing any code: this module imports `arena.ts` (for
 * `Arena`, `loadArena`, `ARENA_DEFS`) and `ai/targeting.ts` (for `lineOfSight`) --
 * exactly the same pair `arena-claims.ts` already imports together, so this is not a
 * new shape of dependency. Nothing under `src/sim/` imports `versus-board.ts` --
 * grepped, zero hits -- so there is no edge back into this module for either of those
 * two imports to close into a cycle with. `src/sim/config/` was checked too and is not
 * imported here at all: none of the three criteria below need a resolved tank config,
 * an AI profile or campaign identity, only grid characters and the wall/position output
 * `loadArena` already produces -- so the cycle question the brief raised for `config/`
 * does not arise because there is no import to raise it.
 *
 * NOTHING IN THE SHIPPED PATH CALLS THIS MODULE. `loadArena` does not gate on its
 * result -- a future map-selection menu is what would consult it, wiring that menu is
 * explicitly out of scope here (see the brief), and `BASELINE_HASH` is unmoved for
 * exactly that reason: this module is reachable from nothing the golden trace runs.
 */

/**
 * The real placement sequence, not a re-derivation of it: `loadArena(arena, playerCount,
 * 'ffa')` runs the exact `pickVersusSpawnCell` loop `loadArena`'s own versus branch
 * runs at real game start, against the exact wall geometry (`walls`, PASS 2a/2b plus
 * the boundary ring) real gameplay collides and sights against. Using 'ffa' rather than
 * 'teams' is a deliberate no-op choice, not an oversight: both modes share the identical
 * PASS 1b placement branch in `loadArena` and differ only in whether `tank.team` gets
 * stamped, which this module never reads -- so 'teams' would produce byte-identical
 * positions and walls at strictly more code to justify.
 */
function versusPlayerPositions(arena: Arena, playerCount: number): { positions: { x: number; y: number }[]; walls: ReturnType<typeof loadArena>['walls'] } {
  const { tanks, walls } = loadArena(arena, playerCount, 'ffa');
  const positions = tanks.filter((t) => t.kind === 'player').map((t) => t.pos);
  return { positions, walls };
}

/**
 * Open-floor cell count -- the SAME predicate `pickVersusSpawnCell` uses for its own
 * candidate pool (`isOpenFloor` in versus-spawns.ts: exactly the `.` cells, excluding
 * solid, destructible AND every spawn letter). Not imported from there because that
 * predicate is a private one-liner (`ch === '.'`) and this module's own doc comment on
 * `MIN_OPEN_FLOOR_PER_PLAYER` needs the reader to see plainly what is being counted;
 * duplicating a one-character comparison is the same call `cellCentre`'s own three
 * independent copies across this file, arena.ts and arena-claims.ts already made.
 */
function countOpenFloor(arena: Arena): number {
  let open = 0;
  for (const row of arena.grid) for (const ch of row) if (ch === '.') open++;
  return open;
}

/**
 * A tenth of the tightest figure measured across every shipped (arena, N) combination
 * -- arena-02 at N=4, 742 open-floor cells / 4 players = 185.50 -- floored: 185.50 / 10
 * = 18.55 -> 18. The same "comfortably below the measured floor, so a future board has
 * headroom before this needs retuning" pattern versus-spawns.ts's own >5-world-unit
 * separation bound used (that bound's own comment states the reasoning explicitly).
 *
 * MEASURED, NOT DISCRIMINATING ON SHIPPED DATA: every one of the 5 shipped arenas
 * clears this at every N in {2, 3, 4} by more than an order of magnitude (the
 * tightest, 185.50, is over 10x the bound by construction) -- 0 of 15 (arena, N)
 * combinations fail it. That is stated plainly rather than implied: shipped arenas are
 * all 33x27 or 45x33 and were never designed to be tight for 2-4 players, so no
 * threshold derived from their own numbers can currently reject one of them. The bound
 * exists for boards this module has not seen yet -- a future generated or hand-authored
 * small arena -- and `versus-board.test.ts`'s synthetic fixture proves it CAN reject a
 * board (small-pillar-room fails it at N=3 and N=4 while passing separation and
 * concealment cleanly), so it is a real, checkable gate rather than a decorative one
 * that happens to word "minimum" without ever applying.
 */
export const MIN_OPEN_FLOOR_PER_PLAYER = 18;

/**
 * A structured verdict for one (arena, N) pair -- the measured figures behind
 * `suitable`, not just the boolean. `versus-board.test.ts`'s shipped-arena sweep
 * asserts every field here, not only `suitable`, so a criterion regressing silently
 * (a correct `suitable` for the wrong reason) is still visible.
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
  /** `concealedPairs === totalPairs` -- see this constant's own doc comment for why
   * the bar is "every pair", not a fraction. */
  readonly allPairsConcealed: boolean;

  /** The arena's open-floor cell count (constant across N; carried per-verdict for
   * convenience, since a caller iterating a table wants it alongside the ratio). */
  readonly openFloorCells: number;
  /** `openFloorCells / playerCount`. */
  readonly openFloorPerPlayer: number;
  /** `openFloorPerPlayer >= MIN_OPEN_FLOOR_PER_PLAYER`. */
  readonly roomOk: boolean;

  /**
   * How many spawns share the LARGEST connected region of tank-legal space (issue #423).
   * `playerCount` means every player can reach every other without changing the map.
   */
  readonly spawnsInLargestRegion: number;
  /** `spawnsInLargestRegion === playerCount`. */
  readonly egressOk: boolean;
  /**
   * How many spawns share no destructible-free region with any other spawn -- i.e. must
   * shoot to meet anyone. REPORTED, not gated: arena-02 and vs-duel-01 are legitimately
   * like this. See `evaluateSpawnEgress` for the full reasoning.
   */
  readonly sealedSpawns: number;
  /**
   * Human-readable cause when `egressOk` is false: which spawns are cut off from which,
   * so a failure names the blocked slot instead of only the board. Empty when it holds.
   */
  readonly egressDiagnosis: string;
}

/**
 * Whether every spawn can actually DRIVE to every other one (issue #423).
 *
 * This exists because every other check in this module reasons about CELLS, and a cell is
 * not a tank. `cellSize` on the dedicated boards is 0.6667 while a tank is
 * `2 * TANK_RADIUS` = 1.0 across -- 1.5 cells -- so a one-cell gap is "walkable" to a
 * cell-based check and has no legal tank-centre position at all. Keystone and Quarters both
 * passed clearance, connectivity, symmetry, path-distance and scripted playtests and were
 * still unplayable: players could not leave their spawns. That is the gap.
 *
 * WHAT IS GATED: with destructible walls REMOVED -- a player may shoot through those --
 * every spawn must sit in one shared connected region of tank-legal space. That is the
 * issue's "usable tank-sized egress into a shared combat space", and it is the requirement
 * no board can argue with: if the SOLID layout partitions the spawns, no amount of play
 * brings the players together.
 *
 * WHAT IS DELIBERATELY NOT GATED, and why: "leaving spawn must not require destroying a
 * wall" is also in the issue's scope, and it is reported below as `sealedSpawns` rather
 * than folded into the verdict. Measured against the shipped catalog, gating it would
 * reject arena-02 and vs-duel-01, which are split into two regions by DESTRUCTIBLES alone
 * (both are single-region once those are removed) -- on a board carrying 72 destructible
 * blocks, shooting through to reach an opponent is the design, not a defect. Separating
 * the two would need a "how much shared space is enough" threshold, and no non-arbitrary
 * one presented itself. So the hard rule gates and the soft one reports.
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
): { labels: number[]; sizes: number[] } {
  const width = arena.cols * arena.cellSize;
  const height = arena.rows * arena.cellSize;
  const step = arena.cellSize / 8;
  const nx = Math.max(1, Math.floor(width / step));
  const ny = Math.max(1, Math.floor(height / step));
  const idx = (i: number, j: number) => i * ny + j;

  const legal = new Uint8Array(nx * ny);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x = (i + 0.5) * step;
      const y = (j + 0.5) * step;
      if (x - TANK_RADIUS < 0 || y - TANK_RADIUS < 0 || x + TANK_RADIUS > width || y + TANK_RADIUS > height) continue;
      let blocked = false;
      for (const wall of walls) {
        if (circleVsAABB({ x, y }, TANK_RADIUS, wall.aabb).hit) { blocked = true; break; }
      }
      if (!blocked) legal[idx(i, j)] = 1;
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

  const labels = positions.map((p) => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor(p.x / step)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor(p.y / step)));
    return label[idx(i, j)];
  });
  return { labels, sizes };
}

function evaluateSpawnEgress(
  arena: Arena,
  positions: readonly { x: number; y: number }[],
  walls: ReturnType<typeof loadArena>['walls'],
): { spawnsInLargestRegion: number; egressOk: boolean; sealedSpawns: number; egressDiagnosis: string } {
  const solid = walls.filter((w) => w.kind !== 'destructible');
  const { labels, sizes } = tankLegalComponents(arena, positions, solid);

  const tally = new Map<number, number>();
  for (const l of labels) tally.set(l, (tally.get(l) ?? 0) + 1);
  let spawnsInLargestRegion = 0;
  for (const n of tally.values()) if (n > spawnsInLargestRegion) spawnsInLargestRegion = n;
  const egressOk = positions.length > 0
    && spawnsInLargestRegion === positions.length
    && labels.every((l) => l >= 0);

  // REPORTED, not gated -- see this module's doc comment above for why. A spawn is
  // "sealed" when it shares no destructible-free region with any other spawn, i.e. the
  // player must shoot to meet anyone.
  const withDestructibles = tankLegalComponents(arena, positions, walls);
  const softTally = new Map<number, number>();
  for (const l of withDestructibles.labels) softTally.set(l, (softTally.get(l) ?? 0) + 1);
  const sealedSpawns = withDestructibles.labels.filter((l) => (softTally.get(l) ?? 0) === 1).length;

  let egressDiagnosis = '';
  if (!egressOk) {
    const groups = [...tally.entries()].map(([l]) => {
      const slots = labels.map((x, s) => (x === l ? `P${s + 1}` : '')).filter(Boolean).join('+');
      return l < 0 ? `${slots} on no tank-legal cell` : `${slots} in a solid-walled region of ${sizes[l]} lattice cells`;
    });
    egressDiagnosis = `${groups.length} disjoint spawn region(s) with destructibles removed: ${groups.join('; ')}`;
  }
  return { spawnsInLargestRegion, egressOk, sealedSpawns, egressDiagnosis };
}

/**
 * Evaluates one arena at one player count. Pure and deterministic: `loadArena` and
 * `lineOfSight` take no wall clock and no `Math.random` (the sim core CLAUDE.md pins
 * as pure), so the same `(arena, playerCount)` always yields the same verdict --
 * `versus-board.test.ts` pins this directly, the same shape `pickVersusSpawnCell`'s own
 * "stable across repeated calls" test already takes.
 *
 * REPORT, DON'T GATEKEEP: nothing here throws or truncates a player count, and nothing
 * in `loadArena` consults this function's result -- a board `suitable: false` still
 * loads and plays exactly as it does today. Wiring a menu to refuse an unsuitable
 * board is a later increment.
 *
 * `distinctSpawns` is measured and reported honestly, but it is worth naming what
 * this module found while proving it independently mutation-testable: given
 * `MIN_OPEN_FLOOR_PER_PLAYER` >= 1, `roomOk` (`openFloorCells / playerCount >=
 * MIN_OPEN_FLOOR_PER_PLAYER`) already implies `openFloorCells >= playerCount`, which
 * is exactly as many open-floor cells as the picks need to stay distinct. (That
 * arithmetic changed shape when P1 stopped sitting on the authored `P` cell and joined
 * the maximin set -- see `pickVersusSpawnSet`. All `playerCount` spawns now come out of
 * the open-floor pool rather than `playerCount - 1` of them, so the margin is exact
 * instead of one to spare. The implication still holds: each pick excludes the cells
 * already taken, so `openFloorCells >= playerCount` is sufficient.)
 * So on every fixture this module's own criteria can construct, `distinctSpawns` false
 * implies `roomOk` false too, never the other way round. `versus-board.test.ts`
 * discloses this the same way versus-spawns.test.ts discloses its own two equivalent
 * mutations: `distinctSpawns` is still checked directly (a dedicated mutation targets
 * its OWN computation, not its participation in `suitable`), and dropping it from the
 * `suitable` conjunction specifically is named as an equivalent mutation, not added to
 * the manifest as `killed`, because no fixture -- shipped or synthetic -- can tell the
 * difference. This is a fact about THIS module's specific formulas (both keyed off the
 * same open-floor cell count), not a general law; a future room metric not based on
 * raw floor-cell count could decouple them again, which is part of why the field stays
 * independently reported rather than folded away.
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
  const { spawnsInLargestRegion, egressOk, sealedSpawns, egressDiagnosis } = evaluateSpawnEgress(arena, positions, walls);

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
    egressDiagnosis,
    roomOk,
  };
}

/** One `evaluateVersusBoard` row, labelled with the arena it measured -- what a table
 * or a future map-selection menu actually wants to iterate. */
export interface VersusBoardCatalogRow extends VersusBoardVerdict {
  readonly arenaId: string;
}

/**
 * Every (arena, N) verdict in the catalog -- the measurement a future map-selection
 * menu would consult to decide which maps to offer at a given player count.
 * `arenas` defaults to `ARENA_DEFS` (the 5 shipped boards) and `playerCounts` to `[2,
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
