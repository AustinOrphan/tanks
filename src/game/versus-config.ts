import { VERSUS_CATALOG } from '../sim/config/versus-catalog';
import type { VersusCatalogEntry, VersusMode } from '../sim/config/versus-catalog-types';
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
import type { VersusSlotSetup } from './versus-setup';

/**
 * One versus match's selections -- what the setup pane collects and what
 * `createVersusLevelSystem` (levels.ts) builds a `LevelSystem` from.
 *
 * NO LONGER SESSION-ONLY. This comment used to read "Deliberately NOT persisted (spec: 'no
 * new store, no persistence' -- same posture as controller assignment)". Issue #260
 * supersedes that: the retained setup now lives in `versusSetupStore`
 * (versus-setup-store.ts), because the pane's displayed choices were being discarded at
 * Start -- Start disposes the session those choices were mutating.
 *
 * What persists is the ROLE PATTERN and the match rules; the device behind each human slot
 * is re-resolved every page-session and never stored. See versus-setup.ts.
 */
export interface VersusConfig {
  mode: 'ffa' | 'teams';
  players: 2 | 3 | 4;
  /**
   * A stable VS catalog id (`versus-catalog.json` -- issue #270; the five migrated
   * entries' ids equal their arena ids), or `'random'`. After Start resolution the
   * field carries the entry's underlying ARENA id -- see `resolveVersusConfig`'s
   * doc comment for the namespace boundary. `'random'` is resolved to a concrete id
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
  /**
   * WHO IS PLAYING EACH SLOT -- the canonical representation (issue #260), length
   * `players`.
   *
   * Required, not optional, and that is the point of the issue: before this the config
   * carried no per-slot field, so the pane's displayed "Who's playing" rows mutated the
   * RUNNING session's assignment while Start disposed that very session and rebuilt from
   * defaults. An optional field would have left exactly that hole open for any caller that
   * forgot it.
   *
   * A bot COUNT is derived from this (`botSlotsOf`), never stored beside it -- the issue's
   * binding decision. The DEVICE behind each human slot is not here either: it is resolved
   * per page-session by `resolveSources`, so nothing stale can bind a controller.
   */
  slots: VersusSlotSetup[];
}

/**
 * Stable VS ids offerable at (`players`, `mode`): the dedicated catalog entries
 * (issue #270) whose DECLARED support covers the combination. Order follows the
 * catalog's own entry order -- the setup pane's offer order.
 *
 * A data read, not a measurement: before #270 this ran `versusBoardCatalog()` --
 * 15 `loadArena` calls plus pairwise `lineOfSight` sweeps, measured 240-370ms,
 * memoized behind a module cache the pane paid on first render. The declarations
 * are trustworthy at runtime precisely because versus-catalog-rules.test.ts's
 * sweep proves every one of them against that same real machinery in CI (plus a
 * cross-check in versus-config.test.ts tying this function's shipped output to
 * the live `versusBoardCatalog` measurement), so the cache and the lazy-init
 * dance went away with the sweep cost.
 *
 * `entries` is an injected seam, same idiom as the `rows` parameter it replaces:
 * every shipped entry declares all of {2,3,4} x both modes, so only a synthetic
 * narrower entry can prove the two predicates actually filter (see
 * versus-config.test.ts's fails-if-a-predicate-is-dropped cases).
 */
export function versusMapChoices(
  players: number,
  mode: VersusMode,
  entries: readonly VersusCatalogEntry[] = VERSUS_CATALOG,
): string[] {
  return entries
    .filter((e) => e.players.includes(players) && e.modes.includes(mode))
    .map((e) => e.id);
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
export function pickVersusArena(
  config: VersusConfig,
  seed: number,
  entries: readonly VersusCatalogEntry[] = VERSUS_CATALOG,
): string {
  if (config.arenaId !== 'random') return config.arenaId;
  const choices = versusMapChoices(config.players, config.mode, entries);
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
 *
 * Since issue #270 this is ALSO the launch gate and the namespace boundary:
 *
 * - The resolved id must name a `VERSUS_CATALOG` entry whose DECLARED support covers
 *   the config's (players, mode), or this throws. Unreachable from the shipped pane
 *   (its offer list is already filtered by the same declarations), so the throw is
 *   the loud backstop for a future narrower entry (#271-#273) meeting a stale
 *   retained selection -- fail at Start, never launch an unsupported combination.
 * - `config.arenaId` holds a STABLE VS id (the selection namespace) before this
 *   call, and the entry's underlying ARENA id after it -- what `arenaById`
 *   (levels.ts) and `replayMetaFor` actually need. The five migrated entries have
 *   id === arenaId, so identity pass-through still holds for every shipped concrete
 *   config; a purpose-built entry whose ids differ gets a translated copy.
 */
export function resolveVersusConfig(
  config: VersusConfig,
  seed: number,
  entries: readonly VersusCatalogEntry[] = VERSUS_CATALOG,
): VersusConfig {
  const id = pickVersusArena(config, seed, entries);
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error(`versus-config: '${id}' names no versus catalog entry`);
  if (!entry.players.includes(config.players) || !entry.modes.includes(config.mode)) {
    throw new Error(
      `versus-config: map '${id}' does not support N=${config.players} mode=${config.mode}`,
    );
  }
  if (config.arenaId === entry.arenaId) return config;
  return { ...config, arenaId: entry.arenaId };
}
