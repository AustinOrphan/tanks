import { versusBoardCatalog, type VersusBoardCatalogRow } from '../sim/versus-board';
// Reused, not re-hand-rolled: `mulberry32` is already the sim's deterministic PRNG
// (src/sim/ai/player-profile.ts), exported precisely so callers outside that file --
// pacifist.test.ts's own local copy is the thing this avoids repeating a third time --
// share one implementation. NOT `Math.random`, NOT `Date.now`: this module lives in
// `src/game/`, outside the sim-purity gate, but a versus rematch's map pick must still
// be a pure function of the seed it is handed (the same seed the replay/session already
// carries -- see arena.ts's `createWorldFor` doc comment on why `seed` alone is enough
// to reproduce a board), so this borrows the sim's own discipline rather than reaching
// for a wall-clock or engine RNG that would make two "random" picks with the same seed
// disagree.
import { mulberry32 } from '../sim/ai/player-profile';

/**
 * One versus match's session-scoped selections -- what the setup pane (a later task)
 * collects and what `createVersusLevelSystem` (levels.ts) builds a `LevelSystem` from.
 * Deliberately NOT persisted (spec: "no new store, no persistence" -- same posture as
 * controller assignment): this is plain session state, constructed fresh each time the
 * pane is opened and handed straight to `requestVersusSession`.
 */
export interface VersusConfig {
  mode: 'ffa' | 'teams';
  players: 2 | 3 | 4;
  /** A shipped arena id, or `'random'` -- resolved per match BUILD (see
   *  `pickVersusArena`), not once per pane session. A rematch with the same
   *  `VersusConfig` object can therefore land on a different board. */
  arenaId: string | 'random';
  /** 1..5; the setup pane's own default is `VERSUS_STOCK` (constants.ts). Not
   *  re-defaulted here -- an omitted field is a caller bug, not this module's to paper
   *  over, matching `createWorldFor`'s own "no non-default caller yet" precedent. */
  stock: number;
  /** Meaningful only when `mode === 'teams'`; `loadArena`/`createWorld` already ignore
   *  it outside that mode (see `World.friendlyFire`'s own doc comment), so carrying it
   *  unconditionally here is harmless. */
  friendlyFire: boolean;
}

/**
 * Arena ids offerable at `players`: the `versusBoardCatalog` rows for that player count
 * whose `suitable` flag holds (every one of the three versus-board criteria -- distinct
 * spawns, full mutual concealment, room). Order follows the catalog's own arena order
 * (`ARENA_DEFS`'s), not alphabetical or measured-quality order -- nothing downstream
 * needs the second thing yet.
 *
 * `rows` is an injected seam, exactly like `versusBoardCatalog`'s own `arenas`/
 * `playerCounts` parameters, defaulting to the real catalog -- so a synthetic fixture
 * with a MIX of suitable/unsuitable rows at one player count can prove this actually
 * filters, rather than only ever seeing the shipped catalog where all 15 (arena, N)
 * rows already pass (a `return rows.map(...)` with no filter at all would look
 * identical on that data). See versus-config.test.ts's synthetic-fixture case.
 */
export function versusMapChoices(
  players: number,
  rows: readonly VersusBoardCatalogRow[] = versusBoardCatalog(),
): string[] {
  return rows.filter((r) => r.playerCount === players && r.suitable).map((r) => r.arenaId);
}

/**
 * Resolves `config.arenaId` to a concrete, `arenaById`-loadable id. A concrete id
 * passes straight through unchanged (untouched by `players`/`seed` -- a deliberate
 * choice picked by name is never second-guessed). `'random'` draws deterministically
 * from `versusMapChoices(config.players)` using `mulberry32(seed)`'s first value: same
 * seed, same pick, forever -- no `Math.random`, so a recorded replay's own seed
 * reproduces the exact board a `'random'` match was played on, with no extra stored
 * field (the same argument `createWorldFor`'s doc comment makes for reusing `seed`
 * itself as the versus-variant picker).
 *
 * Deliberately called ONCE PER MATCH BUILD (from the seed `LevelSystem.world` is
 * handed), not once per pane session -- see `createVersusLevelSystem` (levels.ts) for
 * the call site and its own doc comment on the consequence for `bounds()`.
 */
export function pickVersusArena(config: VersusConfig, seed: number): string {
  if (config.arenaId !== 'random') return config.arenaId;
  const choices = versusMapChoices(config.players);
  const rnd = mulberry32(seed);
  const idx = Math.min(Math.floor(rnd() * choices.length), choices.length - 1);
  return choices[idx];
}
