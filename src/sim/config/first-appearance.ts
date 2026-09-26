import type { TankKind } from '../types';
import { SPAWN_LETTERS } from './arena-types';
import type { CampaignLevel } from './campaign-types';

/**
 * Where a tank kind first appears in a campaign (issue #777).
 *
 * #360's ruling of 2026-08-31: campaign composition is the only source of an enemy's
 * introduction. This is derived per campaign rather than authored on the tank definition,
 * so a campaign edit cannot leave a stale number behind and a second campaign gets its own
 * answer rather than one global value.
 *
 * Pure: the arena lookup is injected, so a caller can ask about any campaign, including a
 * synthetic one, without the shipped catalog.
 */

/** The part of an arena this reads: its grid rows. */
export interface SpawnGrid {
  readonly grid: readonly string[];
}

/**
 * The 1-based position, in `levels`, of the earliest level whose arena spawns `kind`, or
 * `null` when no level does.
 *
 * Position, never the level id: ids are opaque and order comes only from the array
 * (campaign-types.ts).
 *
 * A cell spawns `kind` exactly when `SPAWN_LETTERS` maps its character to `kind` -- the
 * rule `buildArena` spawns by (arena.ts). Legend characters need no separate check:
 * validation refuses a legend key that is a spawn letter (`validateArenaShape`), so a wall
 * character can never read as a spawn.
 *
 * `player` is not special-cased: every validated arena has exactly one player spawn, so it
 * answers 1 for any non-empty campaign. The README roster lists enemies only.
 */
export function firstAppearanceFor(
  levels: readonly CampaignLevel[],
  arenaFor: (arenaId: string) => SpawnGrid,
  kind: TankKind,
): number | null {
  for (let i = 0; i < levels.length; i++) {
    const { grid } = arenaFor(levels[i].arenaId);
    for (const row of grid) {
      for (const ch of row) {
        if (SPAWN_LETTERS[ch] === kind) return i + 1;
      }
    }
  }
  return null;
}
