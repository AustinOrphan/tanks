import type { UnarmedTrigger } from '../sim/types';
import type { World } from '../sim/world';
import {
  arenaBounds,
  arenaById,
  createWorldFor,
  CAMPAIGN_LEVELS,
  FIRST_CAMPAIGN_LEVEL,
  type CampaignLevel,
} from '../sim/arena';
import { createSandboxWorld } from '../sim/sandbox';
import { DEV_FLAGS_OFF, type DevFlags } from './devflags';
import type { RunStore } from './run';
import { pickVersusArena, versusMapChoices, type VersusConfig } from './versus-config';

/**
 * The one object that knows how many levels exist, where a session starts, and how to
 * build the world for any of them. loop.ts consumes this through GameDeps, so tests can
 * substitute a fake sequence and still exercise the real advance/reset wiring.
 */
export interface LevelSystem {
  /** This session's own level sequence, in play order. */
  readonly levels: readonly CampaignLevel[];
  /** Where the session starts: the furthest unlocked level, or a dev-flag jump. */
  readonly start: CampaignLevel;
  /** Whether wins here record progress. TRUE for the shipped sequence; the sandbox is
   *  a test rig, and a sandbox win must never unlock real levels. */
  readonly tracksProgress: boolean;
  /**
   * Whether `start` came from a `?dev=1&level=N` jump rather than the active run.
   *
   * `tracksProgress` alone cannot tell a real campaign session apart from a jumped
   * one -- both are `true`, only the sandbox is `false`. A jumped session still
   * records permanent progress on a win (that was always true of dev jumps and stays
   * true -- see loop.ts's `sm.onChange`), but it must NOT be treated as owning the
   * active RUN: it opened on a level the run's own position did not choose, so
   * writing an advance/end back to the run would move it to a level the player did
   * not actually reach by playing the campaign in order (see loop.ts's
   * `campaignActive`). False for the sandbox too, which is excluded from run
   * bookkeeping already via `tracksProgress`.
   */
  readonly isDevJump: boolean;
  /**
   * Build the world for a level. `lives` carries a cleared level's remainder forward.
   * `playerCount` threads straight to `createWorldFor`/`loadArena`; no real call site
   * passes a non-default value yet -- see arena.ts's `loadArena` for the co-op spawn
   * rule this exists to reach.
   */
  world(
    level: CampaignLevel,
    seed: number,
    unarmedTrigger?: UnarmedTrigger,
    lives?: number,
    playerCount?: number,
  ): World;
  /**
   * The level's board size, for the renderer's per-level refit. From the arena's own
   * cols/rows -- walls are deliberately NOT measurable (the boundary ring overhangs).
   */
  bounds(level: CampaignLevel): { width: number; height: number; cellSize: number };
}

export function createLevelSystem(
  flags: DevFlags,
  run: RunStore,
  // Injectable so a test can prove levels.ts resolves through CAMPAIGN LEVELS and
  // not ARENAS position -- see levels.test.ts's reordered-fixture regression test.
  campaignLevels: readonly CampaignLevel[] = CAMPAIGN_LEVELS,
): LevelSystem {
  if (flags.level === 'sandbox') {
    // A one-level sequence: clearing the sandbox is a final win, and losing it
    // rebuilds the sandbox, never level 1 of the shipped game.
    //
    // A synthetic CampaignLevel, not a real campaign entry -- `'sandbox'` is never a
    // member of CAMPAIGN_LEVELS (or of any injected `campaignLevels`), which is
    // exactly why loop.ts's ordinalOf/nextInSession helpers work against THIS
    // session's own `levels` array rather than the global catalog.
    const sandboxLevel: CampaignLevel = { id: 'sandbox', arenaId: FIRST_CAMPAIGN_LEVEL.arenaId };
    return {
      levels: [sandboxLevel],
      start: sandboxLevel,
      tracksProgress: false,
      isDevJump: false,
      // The sandbox is built on the standard board (see sandboxArena).
      bounds: () => ({
        ...arenaBounds(arenaById(sandboxLevel.arenaId)),
        cellSize: arenaById(sandboxLevel.arenaId).cellSize,
      }),
      world: (_level, seed, unarmedTrigger) =>
        createSandboxWorld(
          {
            tanks: flags.sandboxTanks ?? undefined,
            disarmed: flags.sandboxDisarmed,
            walls: flags.sandboxWalls ?? 0,
            seed,
          },
          unarmedTrigger,
          // Same two playtest switches as the campaign branch below -- see there for why
          // these are closed over rather than threaded as `world()` parameters.
          flags.corpseBlock,
          !flags.muzzleInside,
        ),
    };
  }

  // A dev-flag jump beats the active run; otherwise the run's own persisted level, or
  // level 1 if no run is active yet. `start` is a LIVE getter, not a boot-time
  // snapshot: quit-to-title and game over both return to it, and a level clear or a
  // New Game earned THIS SESSION must move it -- a snapshot sent the player back to
  // the old position after they had just moved on (visible as "correct after a
  // refresh, wrong within the session"). Clamped either way: a stale link or a
  // corrupt/over-generous run record should land on the last level, not crash.
  //
  // Deliberately NOT `progress.highestCleared()` any more (issue #153/#152): that was
  // the "current ambiguous use of run for level-sized statistics" the spec calls a
  // bug, not a feature -- Continue must resume the RUN's own position, which can
  // legitimately differ (a player who returned to an earlier level in practice, or
  // whose run has not caught up to the furthest permanent unlock).
  //
  // `jump` is captured outside the getter: the sandbox early-return above already
  // narrows flags.level in this scope, but narrowing does not survive into a closure.
  const jump: number | null = typeof flags.level === 'number' ? flags.level : null;
  return {
    levels: campaignLevels,
    get start(): CampaignLevel {
      if (jump !== null) {
        return campaignLevels[Math.min(jump - 1, campaignLevels.length - 1)];
      }
      const active = run.active();
      // No run yet: New Game/Continue decide from title.
      if (active === null) return campaignLevels[0];
      // The untrusted-persisted-string-to-domain-object lookup, WITH graceful
      // fallback -- never via the throwing campaignLevelById, since a stale or
      // corrupt/foreign currentLevelId must land on level 1, not crash the boot.
      return campaignLevels.find((l) => l.id === active.currentLevelId) ?? campaignLevels[0];
    },
    tracksProgress: true,
    isDevJump: jump !== null,
    // corpseBlock/muzzleInside/coopPool/mode/friendlyFire are closed over rather than
    // added to the `world()` signature, the same treatment sandboxTanks/
    // sandboxDisarmed/sandboxWalls already get: they are devFlags-driven playtest
    // switches with one value for the whole session, not a per-call construction
    // parameter the way unarmedTrigger and lives are (both vary call to call --
    // unarmedTrigger per dev-flag override, lives across a level transition).
    // `!flags.coopPool` -- absent/false means the shared-attempts default (true);
    // `coopPool=1` restores the shipped pool model. Only meaningful once a second
    // player exists; harmless (never read by resolveStatusCoop) at playerCount 1.
    // `flags.mode ?? 'campaign-coop'` (n-player arc PR 4): absent/unrecognised leaves
    // the shipped rule; `friendlyFire` defaults to createWorld's own false and is
    // self-disabling outside 'teams' by construction (World.friendlyFire's own doc
    // comment) -- so passing it here whatever `mode` is set to is harmless.
    world: (level, seed, unarmedTrigger, lives, playerCount) =>
      createWorldFor(
        arenaById(level.arenaId), seed, unarmedTrigger, lives,
        flags.corpseBlock, !flags.muzzleInside, playerCount, !flags.coopPool,
        flags.mode ?? 'campaign-coop', flags.friendlyFire,
      ),
    bounds: (level) => ({
      ...arenaBounds(arenaById(level.arenaId)),
      cellSize: arenaById(level.arenaId).cellSize,
    }),
  };
}

/**
 * A `LevelSystem` for one versus match: a single synthetic level (never a member of
 * `CAMPAIGN_LEVELS`, same posture as `createLevelSystem`'s own sandbox branch above),
 * built from a `VersusConfig` rather than dev flags. `tracksProgress`/`isDevJump` are
 * both `false` -- a versus session is exactly as far outside campaign-run bookkeeping
 * as the sandbox, and by the same CLAUDE.md rule ("Practice/level-select state must
 * not create or mutate a campaign run"): this function never calls a single method on
 * `run`. It is accepted anyway (unread, hence the `_` prefix -- same treatment
 * `createLevelSystem`'s own sandbox `world` gives its unused `_level`) purely so
 * `createVersusLevelSystem(config, run)` has the identical two-argument shape
 * `createLevelSystem(flags, run)` already has; the versus-setup-menu plan's boot
 * wiring (`versusAwareDeps`, a later task) picks between the two LevelSystem builders
 * uniformly rather than special-casing arity. `versus-config.test.ts`'s "never reads
 * or writes the run it is handed" case is the negative control that would catch an
 * accidental future call creeping in here.
 *
 * `flags` is a trailing, DEFAULTED third parameter -- not in the versus-setup-menu
 * plan's own "Produces" signature, but Step 3's own implementation instructions call
 * for the exact `corpseBlock`/`muzzleInside` dev-flag sourcing `createLevelSystem`'s
 * campaign branch already does (so `?dev=1&corpseBlock=1` keeps working during a
 * versus playtest session, orthogonal to `VersusConfig`, which has no field for
 * either). Defaulting to `DEV_FLAGS_OFF` keeps the plan's literal 2-arg call sites
 * (`createVersusLevelSystem(config, run)`) compiling unchanged, on the shipped
 * defaults (`corpseBlocksShells` false, `muzzleClearsTanks` true -- `createWorld`'s
 * own defaults, see the campaign branch's identical comment above) -- so a caller that
 * does not thread real dev flags through (as today's brief's own Task 2 tests do not)
 * gets exactly what an undecorated versus match should.
 */
export function createVersusLevelSystem(
  config: VersusConfig,
  _run: RunStore,
  flags: DevFlags = DEV_FLAGS_OFF,
): LevelSystem {
  // A stable, decorative arena id for the synthetic level's own `arenaId` field --
  // read by loop.ts (replayMetaFor) and nothing this task's tests exercise, but
  // `arenaById` THROWS on an unresolvable id, and `'random'` is not a real arena --
  // see this module's `createLevelSystem` sandbox branch, which stamps a real
  // `arenaId` on its own synthetic level for the identical reason. For a concrete
  // config this is just `config.arenaId`; for `'random'` it is `versusMapChoices`'s
  // first offerable id at this player count -- NEVER read by `world()` below, which
  // re-resolves `'random'` fresh, per call, from the real match seed (see
  // `pickVersusArena`'s own doc comment) -- so this placeholder cannot drift the
  // actually-built board, only the label loop.ts stamps into replay metadata for a
  // 'random' config (a residual named in this task's own report, not fixed here: no
  // consumer in this tree reads that label back to reconstruct a board).
  const placeholderArenaId =
    config.arenaId !== 'random' ? config.arenaId : versusMapChoices(config.players)[0];
  const versusLevel: CampaignLevel = { id: 'versus', arenaId: placeholderArenaId };

  return {
    levels: [versusLevel],
    start: versusLevel,
    // Neither campaign progress nor a dev-flag jump -- see this function's own doc
    // comment above.
    tracksProgress: false,
    isDevJump: false,
    world: (_level, seed, unarmedTrigger, lives) =>
      createWorldFor(
        // Resolved HERE, from the seed THIS call was handed -- not from
        // `placeholderArenaId` above and not once per `LevelSystem` -- so a rematch
        // (a fresh seed, same `VersusConfig` object) can re-roll a `'random'` pick.
        // See `bounds` below for the one place this per-call resolution cannot be
        // mirrored, and this task's own report for the named consequence.
        arenaById(pickVersusArena(config, seed)), seed, unarmedTrigger, lives,
        flags.corpseBlock, !flags.muzzleInside,
        // `config.players`, not the positional `playerCount` this method's own
        // interface accepts -- a versus session's player count is authoritative from
        // its OWN config, closed over here, the same treatment `createLevelSystem`'s
        // campaign branch gives `flags.mode`/`flags.friendlyFire` above rather than
        // trusting a call-site argument that (today) always agrees with it anyway.
        config.players, undefined, config.mode, config.friendlyFire, config.stock,
      ),
    /**
     * DOCUMENTED COUPLING (the versus-setup-menu plan flags this by name): `bounds`
     * takes no `seed`, but for `arenaId: 'random'` the actual board `world()` builds
     * above is a function of the seed IT receives -- one `bounds` never sees. Read
     * concretely off loop.ts: `startGameWith` calls `deps.levels.bounds(deps.levels
     * .start)` at BOOT, before `nextSeed()` (its `deriveSeed(wallMs())`/dev-flag-seed
     * source) is ever invoked for the first `buildWorld` -- so there is no seed here
     * to resolve 'random' WITH, in general, not merely as an implementation gap.
     *
     * For a concrete `config.arenaId` this is exact: that arena's own bounds, same as
     * the campaign branch above. For `'random'`, this returns the LARGEST bounds
     * among `versusMapChoices(config.players)`'s own candidates (today, at every N in
     * 2..4: arena-04/05, 30x22 world units, dominating arena-01/02/03's 22x18 in BOTH
     * dimensions under the shared cellSize -- so "largest" is one real candidate
     * arena's own {width,height,cellSize} triple, never a synthesized box mixing
     * dimensions from two different arenas). Consequence, named plainly rather than
     * assumed to self-correct: `switchTo` (loop.ts) re-checks `bounds(level)` on
     * every retry/advance/quit and refits the renderer on a mismatch -- but it calls
     * this SAME seed-blind function again, so if the actual resolved arena is ever
     * the smaller class, the mismatch never resolves for the rest of that match
     * (every subsequent call returns the identical largest-candidate answer). The
     * board itself is never clipped -- the tradeoff is a possibly-oversized ground
     * plane with empty margin outside the boundary walls, not a board rendered too
     * small to see. See this task's report for the measured candidate set.
     */
    bounds: (level) => {
      if (config.arenaId !== 'random') {
        const arena = arenaById(config.arenaId);
        return { ...arenaBounds(arena), cellSize: arena.cellSize };
      }
      const candidates = versusMapChoices(config.players).map((id) => arenaById(id));
      const area = (a: ReturnType<typeof arenaById>) => arenaBounds(a).width * arenaBounds(a).height;
      // Falls back to `level`'s own placeholder arena if the catalog somehow offered
      // nothing at this player count (guards `reduce` on an empty array; not reached
      // by any shipped arena/playerCount combination -- versusMapChoices's own
      // non-empty invariant, see versus-config.test.ts).
      const fallback = arenaById(level.arenaId);
      const largest = candidates.reduce((best, a) => (area(a) > area(best) ? a : best), candidates[0] ?? fallback);
      return { ...arenaBounds(largest), cellSize: largest.cellSize };
    },
  };
}
