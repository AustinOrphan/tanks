import { createCatalog } from './catalog';
import type { VersusCatalogEntry } from './versus-catalog-types';
import { validateVersusCatalog } from './validate';
import { ARENA_DEFS } from './arenas';
import versusCatalogJson from './data/versus-catalog.json';

/**
 * The dedicated VS arena catalog (issue #270) -- the maps advertised for
 * competitive play, looked up by STABLE VS id. Array order is the setup pane's
 * offer order. Distinct from campaign ordering by construction: entries point at
 * arena geometry via `arenaId`, and nothing here touches `campaign.json`.
 * Validated at load, exactly like `ARENA_DEFS`: a bad edit is a boot failure
 * naming the exact path (versus-catalog.json: entries[2].players[0]), never a
 * silently malformed offer list.
 *
 * The five initial entries migrate the shipped arenas (setup-menu spec ruling 2:
 * shipped arenas plus Random stay offered), so each entry's id EQUALS its
 * arenaId. The contract does not require that: a future purpose-built VS map
 * (#271-#273) declares its own id, and `resolveVersusConfig`
 * (game/versus-config.ts) translates entry id -> arenaId at the Start boundary.
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

/** Lookup by stable VS id; throws on an unknown id rather than returning undefined. */
export function versusCatalogEntryById(id: string): VersusCatalogEntry {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown versus catalog id: ${id}`);
  return found;
}
