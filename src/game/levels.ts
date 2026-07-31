import type { UnarmedTrigger } from '../sim/types';
import type { World } from '../sim/world';
import { ARENAS, createWorldFor } from '../sim/arena';
import { createSandboxWorld } from '../sim/sandbox';
import type { DevFlags } from './devflags';

/**
 * The one object that knows how many levels exist, where a session starts, and how to
 * build the world for any of them. loop.ts consumes this through GameDeps, so tests can
 * substitute a fake sequence and still exercise the real advance/reset wiring.
 */
export interface LevelSystem {
  /** How many levels this session's sequence holds. */
  readonly count: number;
  /** Where the session starts: 0 normally, elsewhere under a dev-flag jump. */
  readonly start: number;
  /** Build the world for a level. `lives` carries a cleared level's remainder forward. */
  world(level: number, seed: number, unarmedTrigger?: UnarmedTrigger, lives?: number): World;
}

export function createLevelSystem(flags: DevFlags): LevelSystem {
  if (flags.level === 'sandbox') {
    // A one-level sequence: clearing the sandbox is a final win, and losing it
    // rebuilds the sandbox, never level 1 of the shipped game.
    return {
      count: 1,
      start: 0,
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

  // Clamped, not rejected: a stale dev link pointing past the end should land on the
  // last level, not crash the session it was meant to speed up.
  const start = flags.level === null ? 0 : Math.min(flags.level - 1, ARENAS.length - 1);
  return {
    count: ARENAS.length,
    start,
    world: (level, seed, unarmedTrigger, lives) =>
      createWorldFor(ARENAS[level], seed, unarmedTrigger, lives),
  };
}
