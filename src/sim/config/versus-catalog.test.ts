import { describe, it, expect } from 'vitest';
import { VERSUS_CATALOG, versusCatalogEntryById } from './versus-catalog';
import { ARENA_DEFS } from './arenas';

describe('VERSUS_CATALOG', () => {
  it('ships 6 entries whose ids equal their arena ids, in arena order', () => {
    // Population pin: the catalog began as a straight migration of the 5 campaign arenas
    // (setup-menu spec ruling 2), and said a 6th entry would move this count
    // deliberately. This is that edit -- issue #271's vs-duel-01, the first entry that is
    // not a borrowed campaign board.
    expect(VERSUS_CATALOG.map((e) => e.id)).toEqual([
      'arena-01', 'arena-02', 'arena-03', 'arena-04', 'arena-05', 'vs-duel-01',
    ]);
    for (const e of VERSUS_CATALOG) expect(e.arenaId, e.id).toBe(e.id);
  });

  it('every entry points at a real arena definition', () => {
    const known = new Set(ARENA_DEFS.map((a) => a.id));
    for (const e of VERSUS_CATALOG) expect(known.has(e.arenaId), e.id).toBe(true);
  });

  it('declares the player counts each entry is CURATED for, not merely the ones it passes at', () => {
    // versus-catalog-rules.test.ts proves these declarations against real geometry; this
    // pin means a narrowed declaration is a deliberate two-file edit, and vs-duel-01 is
    // the first narrowing. It measures suitable at N=3 and N=4 too (versus-board.test.ts
    // sweeps all 18 combinations) and is offered at neither: a dedicated duel board is
    // withheld where it is playable but not designed for. The offer is curation; the
    // geometry verdict is only the floor beneath it.
    const CURATED_COUNTS: Record<string, number[]> = {
      'arena-01': [2, 3, 4], 'arena-02': [2, 3, 4], 'arena-03': [2, 3, 4],
      'arena-04': [2, 3, 4], 'arena-05': [2, 3, 4],
      'vs-duel-01': [2],
    };
    // Set equality first, so a new entry cannot ship without a row here to review.
    expect(new Set(VERSUS_CATALOG.map((e) => e.id))).toEqual(new Set(Object.keys(CURATED_COUNTS)));
    for (const e of VERSUS_CATALOG) {
      expect(e.players, e.id).toEqual(CURATED_COUNTS[e.id]);
      // These three are still uniform, and a narrowing of any of them would be its own
      // decision rather than something this table quietly absorbs.
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
