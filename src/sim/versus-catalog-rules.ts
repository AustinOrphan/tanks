import type { Arena } from './arena';
import { arenaById, loadArena } from './arena';
import { evaluateVersusBoard, MIN_OPEN_FLOOR_PER_PLAYER } from './versus-board';
import { buildVariantGrid, DESTRUCTIBLE_REMOVAL_FRACTION } from './versus-variants';
import { versusSpawnClearanceFailures } from './versus-spawns';
import type { VersusCatalogEntry } from './config/versus-catalog-types';
import { VERSUS_CATALOG } from './config/versus-catalog';

/**
 * Deterministic geometry validators for the VS arena catalog (issue #270): prove
 * every DECLARATION a `versus-catalog.json` entry makes -- supported player counts
 * and modes, advertised variants -- against the real spawn/sightline machinery,
 * and report each violation as one line naming the exact entry, player count,
 * mode, variant, and failed rule.
 *
 * Layering: `validateVersusCatalog` (config/validate.ts) already rejected
 * malformed entries at load; this module answers the question the schema cannot
 * -- does the geometry actually deliver what the entry advertises? It runs in
 * tests (versus-catalog-rules.test.ts's sweep), not in the shipped path: the
 * shipped menu trusts the declarations precisely because the sweep pins them to
 * measured ground truth in CI. That replaces the pane's old per-render
 * `versusBoardCatalog()` sweep (~15 `loadArena` calls) with a data read.
 *
 * IMPORT GRAPH: imports `arena.ts`, `versus-board.ts`, `versus-variants.ts` and
 * `config/versus-catalog.ts`. Nothing under `src/sim/` imports this module
 * (grepped at the point it was written), so none of those edges can close a
 * cycle. Everything here is a pure function of validated static data.
 */

/** Everything #225's authoritative clearance rule will need when it lands. */
export interface SpawnClearanceContext {
  readonly arena: Arena;
  readonly grid: string[];
  readonly playerCount: number;
  readonly positions: readonly { x: number; y: number }[];
}

/**
 * The #225 consumption seam: an injectable rule receiving the real picked spawn
 * positions for one declared player count on the authored grid, returning
 * human-readable violations (empty = clean). Defaults to the REAL rule
 * (`defaultClearanceRule` below, issue #312); inject to override.
 */
export type SpawnClearanceRule = (ctx: SpawnClearanceContext) => string[];

/**
 * The DEFAULT clearance rule (issue #312): #225's real
 * `versusSpawnClearanceFailures`, wired now that both halves are merged. Spawn
 * positions are already clearance-filtered at pick time (#225), so on healthy
 * boards this re-verifies to zero lines; a board whose eligible pool empties
 * (the picker's documented fallback) is exactly what it surfaces in the sweep.
 * Still injectable: tests and future policies override via
 * `VersusCatalogRuleOptions.clearanceRule`.
 */
const defaultClearanceRule: SpawnClearanceRule = (ctx) =>
  versusSpawnClearanceFailures(
    ctx.grid, ctx.arena.cols, ctx.arena.rows, ctx.arena.cellSize, ctx.arena.legend, ctx.positions,
  );

/**
 * The pinned seed sample behind every `seeded-destructible` declaration: 5 seeds
 * x each declared N, ungated draws at the shipped operating fraction
 * (`DESTRUCTIBLE_REMOVAL_FRACTION`, 0.4). Pinned constants keep the check
 * deterministic -- same tree, same verdict, forever. Population context: the
 * map-variants plan measured 0 unsuitable draws in 1500 at this fraction, so a
 * failure here is signal, not sampling noise; the runtime additionally gates
 * every real draw (`pickVersusVariantGrid`'s retry/fallback), so this validates
 * the advertisement's health, not the last line of defence.
 */
export const VARIANT_VALIDATION_SEEDS: readonly number[] = [1, 2, 3, 4, 5];

export interface VersusCatalogRuleOptions {
  /** Arena lookup seam; defaults to the real `arenaById`. Fixtures inject theirs. */
  arenaFor?: (arenaId: string) => Arena;
  /** Seed sample for variant coverage; defaults to `VARIANT_VALIDATION_SEEDS`. */
  variantSeeds?: readonly number[];
  /** The #225 seam -- see `SpawnClearanceRule`. */
  clearanceRule?: SpawnClearanceRule;
}

/** One failure line: entry, player count, mode, variant, rule, detail -- issue
 * #270's required identification, in one grep-able shape. `N=any mode=any` marks
 * entry-level failures no specific combination owns. */
function diag(
  entry: VersusCatalogEntry,
  n: number | 'any',
  mode: string,
  variant: string,
  rule: string,
  detail: string,
): string {
  return `${entry.id} (${entry.arenaId}) N=${n} mode=${mode} variant=${variant}: ${rule}: ${detail}`;
}

/** The real placement sequence for one (arena, N) -- the same
 * `loadArena(..., 'ffa')` call `evaluateVersusBoard` makes (its own doc comment
 * covers why 'ffa' stands for both modes: placement is mode-identical). */
function playerPositions(arena: Arena, playerCount: number): { x: number; y: number }[] {
  return loadArena(arena, playerCount, 'ffa')
    .tanks.filter((t) => t.kind === 'player')
    .map((t) => t.pos);
}

/**
 * Spawn cells not reachable from the P cell through non-solid cells. Destructible
 * cells COUNT as traversable here: they are breachable, so a spawn behind them is
 * eventually reachable -- the same solid/breachable distinction
 * `arena-claims.ts`'s sealed-pocket rule draws. What this catches is the case
 * `evaluateVersusBoard` cannot see: the maximin picker gladly places a spawn
 * across a fully SOLID divider (distance is exactly what it maximises, and the
 * divider even grants concealment), leaving two players who can never meet.
 */
function unreachableSpawnCells(
  arena: Arena,
  positions: readonly { x: number; y: number }[],
): [number, number][] {
  const solid = (c: number, r: number): boolean => arena.legend[arena.grid[r][c]] === 'solid';
  let start: [number, number] | null = null;
  for (let r = 0; r < arena.rows && !start; r++) {
    const c = arena.grid[r].indexOf('P');
    if (c !== -1) start = [c, r];
  }
  // No P cell means a fixture this rule has nothing to anchor on; the schema and
  // arena validator own that failure, not this one.
  if (!start) return [];

  const seen = new Set<number>([start[1] * arena.cols + start[0]]);
  const queue: [number, number][] = [start];
  while (queue.length > 0) {
    const [c, r] = queue.pop()!;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nc >= arena.cols || nr < 0 || nr >= arena.rows) continue;
      const key = nr * arena.cols + nc;
      if (seen.has(key) || solid(nc, nr)) continue;
      seen.add(key);
      queue.push([nc, nr]);
    }
  }

  const out: [number, number][] = [];
  for (const p of positions) {
    const c = Math.floor(p.x / arena.cellSize);
    const r = Math.floor(p.y / arena.cellSize);
    if (!seen.has(r * arena.cols + c)) out.push([c, r]);
  }
  return out;
}

/** Count of cells whose legend kind is `destructible` -- the population a
 * `seeded-destructible` declaration draws from; zero makes it vacuous. */
function destructibleCellCount(arena: Arena): number {
  let count = 0;
  for (const row of arena.grid) {
    for (const ch of row) if (arena.legend[ch] === 'destructible') count++;
  }
  return count;
}

/**
 * Every violation of one entry's declarations, as diagnostic lines (empty =
 * clean). Deterministic: pure function of the entry, the arena data, and the
 * pinned seeds -- no RNG outside `buildVariantGrid`'s seeded draw.
 */
export function versusCatalogEntryFailures(
  entry: VersusCatalogEntry,
  opts: VersusCatalogRuleOptions = {},
): string[] {
  const arena = (opts.arenaFor ?? arenaById)(entry.arenaId);
  const seeds = opts.variantSeeds ?? VARIANT_VALIDATION_SEEDS;
  const failures: string[] = [];

  const destructibles = destructibleCellCount(arena);
  for (const kind of entry.variants) {
    if (kind === 'seeded-destructible' && destructibles === 0) {
      failures.push(diag(entry, 'any', 'any', kind, 'variant-coverage',
        'arena has 0 destructible cells; the declaration is vacuous'));
    }
  }

  for (const n of entry.players) {
    // Declared support on the authored grid -- the real evaluateVersusBoard
    // criteria, one evaluation per N (geometry is mode-independent; see
    // versus-board.ts's 'ffa'-stands-for-both note), reported per declared mode.
    const authored = evaluateVersusBoard(arena, n);
    const unreachable = unreachableSpawnCells(arena, playerPositions(arena, n));

    // Advertised seeded variants, ungated draws at the shipped fraction: the two
    // criteria destructible removal can regress (the map-variants plan's proof
    // covers why room cannot).
    const variantFailures: { seed: number; detail: string }[] = [];
    if (entry.variants.includes('seeded-destructible') && destructibles > 0) {
      for (const seed of seeds) {
        const grid = buildVariantGrid(
          arena.grid, arena.cols, arena.rows, arena.legend, seed, DESTRUCTIBLE_REMOVAL_FRACTION,
        );
        const v = evaluateVersusBoard({ ...arena, grid }, n);
        if (!v.distinctSpawns) {
          variantFailures.push({ seed, detail: `${v.spawnCount} of ${n} spawn cells distinct` });
        } else if (!v.allPairsConcealed) {
          variantFailures.push({ seed, detail: `${v.concealedPairs} of ${v.totalPairs} spawn pairs concealed` });
        }
      }
    }

    const clearance = (opts.clearanceRule ?? defaultClearanceRule)({
      arena, grid: arena.grid, playerCount: n, positions: playerPositions(arena, n),
    });

    for (const mode of entry.modes) {
      if (!authored.distinctSpawns) {
        failures.push(diag(entry, n, mode, 'authored', 'spawn-count',
          `${authored.spawnCount} of ${n} spawn cells distinct`));
      }
      if (!authored.allPairsConcealed) {
        failures.push(diag(entry, n, mode, 'authored', 'opening-sightlines',
          `${authored.concealedPairs} of ${authored.totalPairs} spawn pairs concealed`));
      }
      if (!authored.roomOk) {
        failures.push(diag(entry, n, mode, 'authored', 'room',
          `${authored.openFloorPerPlayer.toFixed(2)} open-floor cells per player < ${MIN_OPEN_FLOOR_PER_PLAYER}`));
      }
      for (const [c, r] of unreachable) {
        failures.push(diag(entry, n, mode, 'authored', 'connectivity',
          `spawn cell (${c}, ${r}) is not reachable from the P cell through non-solid cells`));
      }
      for (const vf of variantFailures) {
        failures.push(diag(entry, n, mode, `seeded-destructible seed=${vf.seed}`, 'variant-coverage', vf.detail));
      }
      for (const detail of clearance) {
        failures.push(diag(entry, n, mode, 'authored', 'spawn-clearance', detail));
      }
    }
  }

  return failures;
}

/** The whole catalog's violations -- the sweep test's single entry point. */
export function versusCatalogFailures(
  entries: readonly VersusCatalogEntry[] = VERSUS_CATALOG,
  opts: VersusCatalogRuleOptions = {},
): string[] {
  return entries.flatMap((e) => versusCatalogEntryFailures(e, opts));
}
