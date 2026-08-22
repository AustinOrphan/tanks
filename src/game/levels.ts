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
import type { VersusConfig } from './versus-config';

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
 *
 * REQUIRES a resolved `config.arenaId` (issue #278): the one shipped caller
 * (`applyVersusToDeps`, loop.ts) resolves `'random'` to a concrete id exactly once,
 * before ever constructing this `LevelSystem` (`resolveVersusConfig`,
 * versus-config.ts), which is what lets `bounds()`/`world()`/the replay-meta arena id
 * below all read `config.arenaId` directly and agree with each other for this
 * session's whole life. `'random'` was previously handled HERE, per call, on all three
 * -- the exact seed-blind coupling issue #278 is named for (`bounds` has no seed to
 * resolve `'random'` with, so it fell back to guessing the largest candidate, which
 * could disagree with whatever `world()` actually built). That defensive handling is
 * deliberately NOT kept: a `config.arenaId` that is still `'random'` here is a caller
 * bug, not a case to paper over, and `arenaById` (below, all three sites) already
 * throws a clear `Unknown arena id: random` for it -- fail loud, so a future change
 * that drops the Start-boundary resolution breaks LOUDLY here, in the constructor,
 * rather than reintroducing #278's silent mismatch. See `versus-config.test.ts`'s and
 * this file's own tests for the throw as the documented, deliberate contract.
 */
export function createVersusLevelSystem(
  config: VersusConfig,
  _run: RunStore,
  flags: DevFlags = DEV_FLAGS_OFF,
): LevelSystem {
  // The synthetic level's own `arenaId` -- read by loop.ts's `replayMetaFor` for
  // replay metadata, and now (issue #278) always the SAME id `world()` below actually
  // builds on, since `config.arenaId` is required to already be concrete. Previously
  // this was a placeholder ("first offerable choice at this player count") for
  // `'random'`, which could disagree with the real per-call pick `world()` made --
  // that mismatch is fixed as a byproduct of requiring resolution up front, not
  // separately patched here.
  const versusLevel: CampaignLevel = { id: 'versus', arenaId: config.arenaId };

  return {
    levels: [versusLevel],
    start: versusLevel,
    // Neither campaign progress nor a dev-flag jump -- see this function's own doc
    // comment above.
    tracksProgress: false,
    isDevJump: false,
    world: (_level, seed, unarmedTrigger, lives) =>
      createWorldFor(
        // `config.arenaId` directly -- no `pickVersusArena` call, and so no seed
        // dependence: this function's own doc comment above is the fail-loud contract
        // that makes that safe. `arenaById` throws if `config.arenaId` is still
        // `'random'` (a caller bug), rather than silently re-rolling per call the way
        // the pre-#278 code did.
        arenaById(config.arenaId), seed, unarmedTrigger, lives,
        flags.corpseBlock, !flags.muzzleInside,
        // `config.players`, not the positional `playerCount` this method's own
        // interface accepts -- a versus session's player count is authoritative from
        // its OWN config, closed over here, the same treatment `createLevelSystem`'s
        // campaign branch gives `flags.mode`/`flags.friendlyFire` above rather than
        // trusting a call-site argument that (today) always agrees with it anyway.
        config.players, undefined, config.mode, config.friendlyFire, config.stock,
      ),
    // That arena's own bounds -- same shape as the campaign branch above. Requires a
    // resolved `config.arenaId` for the same reason `world()` above does; see this
    // function's own doc comment for why the pre-#278 seed-blind "largest candidate"
    // fallback for `'random'` was removed rather than kept as a silent default.
    bounds: (_level) => {
      const arena = arenaById(config.arenaId);
      return { ...arenaBounds(arena), cellSize: arena.cellSize };
    },
  };
}
