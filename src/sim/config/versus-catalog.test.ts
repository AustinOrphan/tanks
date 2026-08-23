import { describe, it, expect } from 'vitest';
import { VERSUS_CATALOG, versusCatalogEntryById } from './versus-catalog';
import { ARENA_DEFS } from './arenas';

describe('VERSUS_CATALOG', () => {
  it('ships 5 entries whose ids equal their arena ids, in arena order', () => {
    // Population pin: the shipped catalog migrates exactly the 5 shipped arenas
    // (setup-menu spec ruling 2). A 6th entry moves this count deliberately.
    expect(VERSUS_CATALOG.map((e) => e.id)).toEqual([
      'arena-01', 'arena-02', 'arena-03', 'arena-04', 'arena-05',
    ]);
    for (const e of VERSUS_CATALOG) expect(e.arenaId, e.id).toBe(e.id);
  });

  it('every entry points at a real arena definition', () => {
    const known = new Set(ARENA_DEFS.map((a) => a.id));
    for (const e of VERSUS_CATALOG) expect(known.has(e.arenaId), e.id).toBe(true);
  });

  it('declares full support on every shipped entry: N in {2,3,4}, both modes, seeded variants', () => {
    // versus-catalog-rules.test.ts proves these declarations against real geometry;
    // this pin means a narrowed declaration is a deliberate two-file edit.
    for (const e of VERSUS_CATALOG) {
      expect(e.players, e.id).toEqual([2, 3, 4]);
      expect(e.modes, e.id).toEqual(['ffa', 'teams']);
      expect(e.variants, e.id).toEqual(['seeded-destructible']);
      expect(e.spawnPolicy, e.id).toBe('maximin');
    }
  });

  it('versusCatalogEntryById round-trips and throws on an unknown id', () => {
    expect(versusCatalogEntryById('arena-03')).toBe(VERSUS_CATALOG[2]);
    expect(() => versusCatalogEntryById('arena-99')).toThrow(/Unknown versus catalog id/);
    expect(() => versusCatalogEntryById('random')).toThrow(/Unknown versus catalog id/);
  });
});
