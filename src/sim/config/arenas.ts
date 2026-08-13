import { createCatalog } from './catalog';
import type { ArenaDefinition } from './arena-types';
import { validateArenas } from './validate';
import arenasJson from './data/arenas.json';

/**
 * The shipped arenas -- a catalog of reusable boards, looked up by id. Array order
 * is CATALOG order, not level order; campaign order (issue #154, which level plays
 * which arena and in what sequence) lives in `campaign.ts`, decoupled on purpose so
 * the two can be edited independently. Validated at load: a bad edit is a boot
 * failure naming the exact path (arenas[2].grid[4]), never a silently malformed
 * board.
 */
export const ARENA_DEFS: ArenaDefinition[] = validateArenas(arenasJson);

const BY_ID = createCatalog<string, ArenaDefinition, ArenaDefinition>(
  Object.fromEntries(ARENA_DEFS.map((a) => [a.id, a])),
  (id, defs) => defs[id],
);

/** Lookup by id, for tests and tooling that name an arena rather than index it. */
export function arenaById(id: string): ArenaDefinition {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown arena id: ${id}`);
  return found;
}
