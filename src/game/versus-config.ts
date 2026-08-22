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
  /**
   * A shipped arena id, or `'random'`. `'random'` is resolved to a concrete id
   * exactly ONCE per session, at the Start boundary (`applyVersusToDeps`'s call to
   * `resolveVersusConfig`, loop.ts) -- not once per pane session (the pane's own
   * `versusConfigState`, hud.ts, keeps `'random'` selected across a whole run of
   * rematches) and not once per `world()`/`bounds()` call (the historical bug this
   * field's `'random'` handling used to invite -- issue #278). A rematch THROUGH
   * Start re-resolves fresh, from that Start's own seed, and can land on a
   * different board; quitting or a match ending mid-session cannot, because the
   * running session's own `LevelSystem` (levels.ts) is built from the
   * already-resolved id and never reads `'random'` again for the rest of that
   * session's life. See `resolveVersusConfig`'s own doc comment for the resolver,
   * and `GameDeps.initialVersusConfig` (loop.ts) for why the UNRESOLVED config
   * (the one still carrying `'random'`) is what the pane reopens with.
   */
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

// Measured (vite-node, this tree): one `versusBoardCatalog()` call -- 15 `loadArena`
// calls plus their pairwise `lineOfSight` sweeps -- costs ~240-370ms. `versus-board.ts`'s
// own module doc states nothing in the shipped path calls it; the shipped callers are
// this module's own `versusMapChoices` (hud.ts's map-picker row reads it directly, on
// every pane render) and `pickVersusArena` (read exactly ONCE per session, by
// `resolveVersusConfig` below -- see its own doc comment). `createVersusLevelSystem`'s
// `world()`/`bounds()` (levels.ts) do NOT call either any more (issue #278 fixed this:
// both now require an already-resolved id and never touch `'random'` in the shipped
// path), so a 'random' versus match no longer re-runs this sweep on every build or
// retry the way it once did. Memoized lazily -- computed on the FIRST call that omits
// `rows`, cached for the life of the module -- rather than at module load (a top-level
// `versusBoardCatalog()` call here would tax every CAMPAIGN boot too, since loop.ts ->
// levels.ts imports this module regardless of mode; a campaign session never calls
// `versusMapChoices`/`pickVersusArena` at all, so it must never pay this cost). Safe to
// cache: `ARENA_DEFS` is validated, static data loaded once at import (config/arenas.ts)
// and never mutated, so the catalog is a pure function of unchanging input for the
// process's whole lifetime.
let cachedDefaultRows: VersusBoardCatalogRow[] | null = null;
function defaultCatalogRows(): VersusBoardCatalogRow[] {
  if (cachedDefaultRows === null) cachedDefaultRows = versusBoardCatalog();
  return cachedDefaultRows;
}

/**
 * Arena ids offerable at `players`: the `versusBoardCatalog` rows for that player count
 * whose `suitable` flag holds (every one of the three versus-board criteria -- distinct
 * spawns, full mutual concealment, room). Order follows the catalog's own arena order
 * (`ARENA_DEFS`'s), not alphabetical or measured-quality order -- nothing downstream
 * needs the second thing yet.
 *
 * `rows` is an injected seam, exactly like `versusBoardCatalog`'s own `arenas`/
 * `playerCounts` parameters -- so a synthetic fixture with a MIX of suitable/unsuitable
 * rows at one player count can prove this actually filters, rather than only ever
 * seeing the shipped catalog where all 15 (arena, N) rows already pass (a
 * `rows.map(...)` with no filter at all would look identical on that data). See
 * versus-config.test.ts's synthetic-fixture case -- passing `rows` explicitly bypasses
 * `defaultCatalogRows()`'s cache entirely, so that test exercises the real filter, not
 * a memoized value from an earlier test.  Omitting `rows` uses the memoized real
 * catalog -- see `defaultCatalogRows`'s own comment for why that is NOT simply
 * `= versusBoardCatalog()` as a default expression.
 */
export function versusMapChoices(
  players: number,
  rows: readonly VersusBoardCatalogRow[] = defaultCatalogRows(),
): string[] {
  return rows.filter((r) => r.playerCount === players && r.suitable).map((r) => r.arenaId);
}

/**
 * Resolves `config.arenaId` to a concrete, `arenaById`-loadable id. A concrete id
 * passes straight through unchanged (untouched by `players`/`seed` -- a deliberate
 * choice picked by name is never second-guessed). `'random'` draws deterministically
 * from `versusMapChoices(config.players)` using `mulberry32(seed)`'s first value: same
 * seed, same pick, forever -- no `Math.random`. Since issue #278 the seed handed in is
 * the START-BOUNDARY resolution seed (see `resolveVersusConfig`'s caller in loop.ts),
 * which in general is NOT the world's own `trace.meta.seed` -- a recorded replay does
 * not re-derive a `'random'` board from its seed; it reads the concrete
 * `ReplayMeta.arenaId` stamped from the resolved config. Do not "restore" the old
 * property by calling this per world() build with the world seed: that per-call,
 * seed-blind resolution is exactly the #278 coupling the single-call contract removed.
 *
 * A pure function of `(config, seed)` with no opinion on how often it is called --
 * `resolveVersusConfig` below is the one shipped caller (issue #278: exactly ONCE per
 * session, at Start), and `createVersusLevelSystem`'s `world()`/`bounds()` (levels.ts)
 * do NOT call this any more, having already been handed a resolved config. Direct
 * callers (this module's own tests) can still call it per-seed to characterize the
 * distribution itself.
 */
export function pickVersusArena(config: VersusConfig, seed: number): string {
  if (config.arenaId !== 'random') return config.arenaId;
  const choices = versusMapChoices(config.players);
  const rnd = mulberry32(seed);
  const idx = Math.min(Math.floor(rnd() * choices.length), choices.length - 1);
  return choices[idx];
}

/**
 * The Start-boundary fix for issue #278: resolves `config.arenaId` to a concrete id
 * ONCE, up front, rather than leaving `'random'` in the `VersusConfig` a `LevelSystem`
 * is built from. A concrete `config` passes through BY IDENTITY (not a copy) --
 * `applyVersusToDeps`'s own H1/H2 tests (loop.test.ts) rely on this to prove a
 * concrete-arena session is untouched by this call. For `'random'`, returns a NEW
 * `VersusConfig` (a shallow copy with `arenaId` replaced) via `pickVersusArena(config,
 * seed)` -- the SAME resolver `'random'` always went through, just called once instead
 * of once per `world()`/`bounds()` call.
 *
 * The ORIGINAL `config` (still carrying `'random'`) is never this function's business
 * to discard: its one caller, `applyVersusToDeps` (loop.ts), keeps a reference to it
 * for `GameDeps.initialVersusConfig` -- see that field's own doc comment for why the
 * setup pane must reopen showing `'random'` selected, not whatever concrete arena this
 * session actually rolled.
 */
export function resolveVersusConfig(config: VersusConfig, seed: number): VersusConfig {
  if (config.arenaId !== 'random') return config;
  return { ...config, arenaId: pickVersusArena(config, seed) };
}
