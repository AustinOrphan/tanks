import type { UnarmedTrigger } from '../sim/types';
import type { World } from '../sim/world';
import { ARENAS, createWorldFor } from '../sim/arena';
import { createSandboxWorld } from '../sim/sandbox';
import type { DevFlags } from './devflags';
import type { ProgressStore } from './progress';

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
  /** Build the world for a level. `lives` carries a cleared level's remainder forward. */
  world(level: number, seed: number, unarmedTrigger?: UnarmedTrigger, lives?: number): World;
}

export function createLevelSystem(flags: DevFlags, progress: ProgressStore): LevelSystem {
  if (flags.level === 'sandbox') {
    // A one-level sequence: clearing the sandbox is a final win, and losing it
    // rebuilds the sandbox, never level 1 of the shipped game.
    return {
      count: 1,
      start: 0,
      tracksProgress: false,
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

  // A dev-flag jump beats saved progress; otherwise the session opens at the furthest
  // unlocked level. Clamped either way: a stale link or an over-generous save should
  // land on the last level, not crash the session.
  const start = flags.level === null
    ? Math.min(progress.highestCleared(), ARENAS.length - 1)
    : Math.min(flags.level - 1, ARENAS.length - 1);
  return {
    count: ARENAS.length,
    start,
    tracksProgress: true,
    world: (level, seed, unarmedTrigger, lives) =>
      createWorldFor(ARENAS[level], seed, unarmedTrigger, lives),
  };
}
