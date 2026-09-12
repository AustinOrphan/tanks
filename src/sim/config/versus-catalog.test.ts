import { describe, it, expect } from 'vitest';
import { VERSUS_CATALOG, versusCatalogEntryById } from './versus-catalog';
import { ARENA_DEFS } from './arenas';

describe('VERSUS_CATALOG', () => {
  it('ships 8 entries whose ids equal their arena ids, in arena order', () => {
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
    // It reached 7 when issue #424 rebuilt vs-tri-01's geometry to a stated minimum passage
    // width, and **8** now that issue #425 has done the same for vs-quad-01. Both clear the
    // tank-egress gate at N=2, 3 and 4 -- `evaluateVersusBoard` reports egressOk true,
    // sealedSpawns 0 and fatalEscapes 0 for each, where Keystone reported 3 of 3 spawns
    // fatal at N=3 and Quarters reported every spawn in a disjoint region. That is the
    // whole of the difference between the two rows below.
    expect(VERSUS_CATALOG.map((e) => e.id)).toEqual([
      'arena-01', 'arena-02', 'arena-03', 'arena-04', 'arena-05', 'vs-duel-01', 'vs-tri-01',
      'vs-quad-01',
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
      // reports 22 of 24 suitable and vs-tri-01 is in neither of the 2 failures), so the [3]
      // here is curation, exactly like vs-duel-01's [2]: a board authored for three players
      // is withheld where it is playable but not designed.
      'vs-tri-01': [3],
      // vs-quad-01 is BACK (issue #425), at [4] alone, and by the same curation rule as its
      // two siblings: `versusBoardCatalog` now reports it suitable at N=2, 3 and 4 (22 of 24
      // suitable, and vs-quad-01 is in neither of the 2 remaining failures), so restricting
      // it to 4 is a design choice about the board it was authored for, not a limit the
      // measurements impose.
      'vs-quad-01': [4],
    };
    // Set equality first, so a new entry cannot ship without a row here to review.
    expect(new Set(VERSUS_CATALOG.map((e) => e.id))).toEqual(new Set(Object.keys(CURATED_COUNTS)));
    for (const e of VERSUS_CATALOG) {
      expect(e.players, e.id).toEqual(CURATED_COUNTS[e.id]);
      // `modes` is UNIFORM again, and the history is the point. vs-tri-01 was the only
      // entry that ever narrowed it, declaring `ffa` alone on the reasoning that three
      // players cannot be split into fair teams. Issue #627 retired that reasoning:
      // #584 established that asymmetric Teams are intentionally supported in PP1, so
      // 2v1 at three players is a supported split rather than a defect, and numerical
      // asymmetry is not by itself grounds for withholding a combination.
      // Pinned per entry for the same reason the counts are -- a board silently gaining
      // or losing a mode fails here, in either direction. That a uniform expectation
      // now reads as a table with no exceptions is exactly what the pin is for: the
      // next narrowed board has to come back here and say why.
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

  it('keeps every intent inside the map card\'s clamp, so no board truncates -- population: all 8', () => {
    // The card's intent is line-clamped (hud.css, `.hud-versus-map-intent`) so that swapping
    // which boards a row offers cannot resize the cards beside them. The clamp is the
    // structural guarantee; this bound is what keeps it from ever having to FIRE.
    //
    // 88 characters, DERIVED rather than chosen: the binding case is the desktop card, whose
    // text column measured 138px beside the 74px canvas in a 240px grid column, at 11px. The
    // four-line boundary was measured in real Chromium to sit between 95 characters
    // (Pinwheel's old intent, four lines) and 100 (Arena 1's old intent, five), so 88 clears
    // it with room for a word break landing badly. Phone is not the constraint: the same
    // text column measured 288px there and the clamp is 2.
    //
    // Failing here is not "the copy is wrong" -- it means the card will ellipsise that
    // board, which is a silent loss of the sentence #274 put on the card deliberately.
    // Shorten the intent, or move the clamp and re-derive this number against a measurement.
    const LONGEST = 88;
    for (const entry of VERSUS_CATALOG) {
      expect(entry.intent.length, `${entry.id} would be truncated on its card`)
        .toBeLessThanOrEqual(LONGEST);
    }
    // The bound is only meaningful while it is near the real maximum: a bound of 500 would
    // pass forever and assert nothing. MEASURED: the longest shipped intent is 85.
    const longest = Math.max(...VERSUS_CATALOG.map((e) => e.intent.length));
    expect(longest, 'the shipped maximum this bound was derived against').toBe(85);
  });
});
