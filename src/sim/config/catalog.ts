// ---------------------------------------------------------------------------
// The shared catalog every entity family rides (tanks, walls, arenas, campaign levels,
// versus-catalog entries): a new family supplies its Definition type, its Resolved type
// and a pure resolver rather than its own plumbing. Resolution happens once at module
// load, never per tick, so the sim's hot path only ever does a record lookup.
// ---------------------------------------------------------------------------

export interface EntityCatalog<K extends string, D, R> {
  readonly defs: Record<K, D>;
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
