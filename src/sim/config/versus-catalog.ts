import { createCatalog } from './catalog';
import type { VersusCatalogEntry } from './versus-catalog-types';
import { validateVersusCatalog } from './validate';
import { ARENA_DEFS } from './arenas';
import versusCatalogJson from './data/versus-catalog.json';

/**
 * The VS arena catalog (issue #270), looked up by stable VS id. Array order is the setup
 * pane's offer order. The five campaign arenas are entries too (setup-menu spec ruling 2).
 *
 * Every entry's id currently equals its arenaId, but the contract does not require that:
 * `resolveVersusConfig` (game/versus-config.ts) translates entry id -> arenaId at the Start
 * boundary.
 *
 * Geometry promises made by these declarations are proven by
 * `versus-catalog-rules.ts` and its sweep test, not here.
 */
export const VERSUS_CATALOG: readonly VersusCatalogEntry[] = validateVersusCatalog(
  versusCatalogJson,
  new Set(ARENA_DEFS.map((a) => a.id)),
);

const BY_ID = createCatalog<string, VersusCatalogEntry, VersusCatalogEntry>(
  Object.fromEntries(VERSUS_CATALOG.map((e) => [e.id, e])),
  (id, defs) => defs[id],
);

export function versusCatalogEntryById(id: string): VersusCatalogEntry {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown versus catalog id: ${id}`);
  return found;
}
