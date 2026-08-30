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
      'arena-01', 'arena-02', 'arena-03', 'arena-04', 'arena-05', 'vs-duel-01', 'vs-tri-01',
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
      // Issue #272: the same narrowing, one count further along. vs-tri-01 measures
      // suitable at N=2 and N=4 as well, and is curated for 3 alone -- a board whose three
      // maximin spawns were placed an equal 26 walkable cells apart has nothing to offer
      // two players or four.
      'vs-tri-01': [3],
    };
    // Set equality first, so a new entry cannot ship without a row here to review.
    expect(new Set(VERSUS_CATALOG.map((e) => e.id))).toEqual(new Set(Object.keys(CURATED_COUNTS)));
    for (const e of VERSUS_CATALOG) {
      expect(e.players, e.id).toEqual(CURATED_COUNTS[e.id]);
      // `modes` is no longer uniform, and this is the deliberate edit that records why
      // rather than the table quietly absorbing it: three players cannot be split into
      // fair teams, so vs-tri-01 declares `ffa` alone. Pinned per entry for the same
      // reason the counts are -- a board silently gaining or losing a mode fails here.
      expect(e.modes, e.id).toEqual(e.id === 'vs-tri-01' ? ['ffa'] : ['ffa', 'teams']);
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

describe('displayName is what the map row renders (issue #271, criterion 5)', () => {
  it('the five migrated entries name themselves exactly as hud.ts\'s old regex did', () => {
    // The equivalence that makes reading the catalog a SWAP rather than a retitling.
    // `arenaLabel` was `/^arena-(\d+)$/` -> `Arena N`; if any migrated entry's
    // displayName differed from that, changing hud.ts to read the catalog would have
    // silently renamed a board on screen. Asserted here, in the file that owns the data,
    // so the equivalence is checked against the DECLARATIONS rather than against a copy.
    for (const e of VERSUS_CATALOG) {
      const m = /^arena-(\d+)$/.exec(e.id);
      if (!m) continue;
      expect(e.displayName, e.id).toBe(`Arena ${Number(m[1])}`);
    }
  });

  it('a board whose id is not arena-NN carries a real name, not a fallback to its id', () => {
    // The case the regex could not serve, and the reason it had to go. Would fail if
    // vs-duel-01 shipped with `displayName: 'vs-duel-01'`, which validates fine and
    // would put a slug on the button.
    const duel = VERSUS_CATALOG.find((e) => e.id === 'vs-duel-01')!;
    expect(duel.displayName).toBe('Pinwheel');
    expect(duel.displayName, 'the name fell back to the id').not.toBe(duel.id);
    expect(duel.intent.length, 'the intent note is empty').toBeGreaterThan(20);
  });
});
