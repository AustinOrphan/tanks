import { describe, it, expect } from 'vitest';
import { VERSUS_CATALOG, versusCatalogEntryById } from './versus-catalog';
import { ARENA_DEFS } from './arenas';

describe('VERSUS_CATALOG', () => {
  it('ships 7 entries whose ids equal their arena ids, in arena order', () => {
    // Population pin: the catalog began as a straight migration of the 5 campaign arenas
    // (setup-menu spec ruling 2), and said a 6th entry would move this count
    // deliberately. That was issue #271's vs-duel-01, the first entry that is not a
    // borrowed campaign board.
    //
    // It reached 8 with vs-tri-01 (#272) and vs-quad-01 (#273), then fell to 6 when both
    // were WITHDRAWN pending #424/#425: human playtesting found players could not leave
    // their spawns on either board (#423 measured each Keystone spawn reaching 2.4% or
    // less of the tank-legal floor, each Quarters spawn about 11%).
    //
    // 7, because issue #424 rebuilt vs-tri-01's geometry to a stated minimum passage width
    // and it now CLEARS the tank-egress gate at N=2, 3 and 4 -- `evaluateVersusBoard`
    // reports egressOk true, sealedSpawns 0 and fatalEscapes 0, where it reported 3 of 3
    // spawns fatal at N=3 before. vs-quad-01 stays withdrawn pending #425; that is the
    // whole of the difference between the two rows below.
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
      // vs-tri-01 is BACK (issue #424), and at [3] alone -- the same narrowing it declared
      // before it was withdrawn. It measures suitable at N=2 and N=4 too (versusBoardCatalog
      // reports 19 of 24 suitable and vs-tri-01 is in none of the 5 failures), so the [3]
      // here is curation, exactly like vs-duel-01's [2]: a board authored for three players
      // is withheld where it is playable but not designed.
      'vs-tri-01': [3],
      // vs-quad-01 (#273) still has no row: it remains withdrawn pending #425. When it
      // returns it needs a row here AND must pass the tank-egress gate in
      // versus-board.test.ts, which is what would have caught it (#423).
    };
    // Set equality first, so a new entry cannot ship without a row here to review.
    expect(new Set(VERSUS_CATALOG.map((e) => e.id))).toEqual(new Set(Object.keys(CURATED_COUNTS)));
    for (const e of VERSUS_CATALOG) {
      expect(e.players, e.id).toEqual(CURATED_COUNTS[e.id]);
      // `modes` is NOT uniform, and this is the deliberate edit that records why rather
      // than the table quietly absorbing it: three players cannot be split into fair
      // teams, so vs-tri-01 declares `ffa` alone. It is the only entry that ever has.
      // Pinned per entry for the same reason the counts are -- a board silently gaining
      // or losing a mode fails here, in either direction.
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
