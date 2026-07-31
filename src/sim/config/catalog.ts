// ---------------------------------------------------------------------------
// The generic entity-catalog machinery: a definition table keyed by id, resolved
// once at module load through a supplied resolver, then read through `get`.
//
// This is the shape every entity family shares -- tanks today (definitions +
// balance classes -> ResolvedTankConfig), walls today (definitions resolved by
// identity, no balance classes yet), and whatever comes next (power-ups, bosses,
// turrets, destructibles; arenas are already plain data in arena.ts). A new
// family supplies its Definition type, its Resolved type, and a pure resolver;
// the catalog supplies resolve-once semantics and the keyed accessor.
//
// Pure by construction: definitions in, resolved plain objects out, nothing
// imported. Resolution happens at module load, never per tick, so the sim's
// hot path only ever does a record lookup.
// ---------------------------------------------------------------------------

export interface EntityCatalog<K extends string, D, R> {
  /** The raw definitions, exposed for tests and tooling. */
  readonly defs: Record<K, D>;
  /** The resolved runtime config for one entity id. */
  get(key: K): R;
}

export function createCatalog<K extends string, D, R>(
  defs: Record<K, D>,
  resolve: (key: K, defs: Record<K, D>) => R,
): EntityCatalog<K, D, R> {
  const resolved = {} as Record<K, R>;
  for (const key of Object.keys(defs) as K[]) {
    resolved[key] = resolve(key, defs);
  }
  return { defs, get: (key) => resolved[key] };
}
