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
import type { DevFlags } from './devflags';
import type { RunStore } from './run';

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
