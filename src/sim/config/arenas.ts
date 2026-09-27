import { createCatalog } from './catalog';
import type { ArenaDefinition } from './arena-types';
import { validateArenas } from './validate';
import arenasJson from './data/arenas.json';

/**
 * Array order is CATALOG order, not level order; campaign order (issue #154) lives in
 * `campaign.ts`, decoupled on purpose so the two can be edited independently.
 */
export const ARENA_DEFS: ArenaDefinition[] = validateArenas(arenasJson);

const BY_ID = createCatalog<string, ArenaDefinition, ArenaDefinition>(
  Object.fromEntries(ARENA_DEFS.map((a) => [a.id, a])),
  (id, defs) => defs[id],
);

export function arenaById(id: string): ArenaDefinition {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown arena id: ${id}`);
  return found;
}
