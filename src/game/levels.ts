import type { UnarmedTrigger } from '../sim/types';
import type { World } from '../sim/world';
import { ARENAS, arenaBounds, createWorldFor } from '../sim/arena';
import { createSandboxWorld } from '../sim/sandbox';
import type { DevFlags } from './devflags';
import { levelIndexFromId, type RunStore } from './run';

/**
 * The one object that knows how many levels exist, where a session starts, and how to
 * build the world for any of them. loop.ts consumes this through GameDeps, so tests can
 * substitute a fake sequence and still exercise the real advance/reset wiring.
 */
export interface LevelSystem {
  /** How many levels this session's sequence holds. */
  readonly count: number;
  /** Where the session starts: the furthest unlocked level, or a dev-flag jump. */
  readonly start: number;
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
  /** Build the world for a level. `lives` carries a cleared level's remainder forward. */
  world(level: number, seed: number, unarmedTrigger?: UnarmedTrigger, lives?: number): World;
  /**
   * The level's board size, for the renderer's per-level refit. From the arena's own
   * cols/rows -- walls are deliberately NOT measurable (the boundary ring overhangs).
   */
  bounds(level: number): { width: number; height: number; cellSize: number };
}

export function createLevelSystem(flags: DevFlags, run: RunStore): LevelSystem {
  if (flags.level === 'sandbox') {
    // A one-level sequence: clearing the sandbox is a final win, and losing it
    // rebuilds the sandbox, never level 1 of the shipped game.
    return {
      count: 1,
      start: 0,
      tracksProgress: false,
      isDevJump: false,
      // The sandbox is built on the standard board (see sandboxArena).
      bounds: () => ({ ...arenaBounds(ARENAS[0]), cellSize: ARENAS[0].cellSize }),
      world: (_level, seed, unarmedTrigger) =>
        createSandboxWorld(
          {
            tanks: flags.sandboxTanks ?? undefined,
            disarmed: flags.sandboxDisarmed,
            walls: flags.sandboxWalls ?? 0,
            seed,
          },
          unarmedTrigger,
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
    count: ARENAS.length,
    get start(): number {
      if (jump !== null) return Math.min(jump - 1, ARENAS.length - 1);
      const active = run.active();
      if (active === null) return 0; // no run yet: New Game/Continue decide from title
      return Math.min(levelIndexFromId(active.currentLevelId), ARENAS.length - 1);
    },
    tracksProgress: true,
    isDevJump: jump !== null,
    world: (level, seed, unarmedTrigger, lives) =>
      createWorldFor(ARENAS[level], seed, unarmedTrigger, lives),
    bounds: (level) => ({ ...arenaBounds(ARENAS[level]), cellSize: ARENAS[level].cellSize }),
  };
}
