// VersusConfig's pure helpers: the map filter and the deterministic 'random' resolver.
import { defaultSlots } from './versus-setup';
// Both are consumed by createVersusLevelSystem (levels.test.ts), but are pure and
// node-testable on their own -- no World, no RunStore.
import { describe, it, expect } from 'vitest';
import {
  versusMapChoices,
  pickVersusArena,
  resolveVersusConfig,
  retainArenaChoice,
  type VersusConfig,
} from './versus-config';
import { versusBoardCatalog } from '../sim/versus-board';
import type { VersusCatalogEntry, VersusMode } from '../sim/config/versus-catalog-types';
import { VERSUS_CATALOG } from '../sim/config/versus-catalog';
import { CAMPAIGN_LEVELS } from '../sim/config/campaign';

/** Synthetic catalog entries for the filter/translation negative controls below --
 * plain literals, same idiom as versus-catalog-rules.test.ts's fixtures (the schema
 * validator has its own suite in config/validate.test.ts). */
function entryFixture(overrides: Partial<VersusCatalogEntry>): VersusCatalogEntry {
  return {
    id: 'vs-fixture', arenaId: 'arena-02', displayName: 'Fixture', intent: 'test fixture',
    preview: 'arena-02', players: [2, 3, 4], modes: ['ffa', 'teams'],
    spawnPolicy: 'maximin', variants: [], ...overrides,
  };
}

describe('versusMapChoices', () => {
  const CAMPAIGN_BOARDS = ['arena-01', 'arena-02', 'arena-03', 'arena-04', 'arena-05'];
  /** N=2 additionally offers the dedicated duel board (issue #271). */
  const DUEL = 'vs-duel-01';
  /** The dedicated tri board (issue #272, rebuilt by #424, and given `teams` alongside `ffa`
   *  by issue #627), offered at N=3 and, since issue #1035, at N=2. */
  const TRI = 'vs-tri-01';
  /** Quarters (issue #273, rebuilt by #425), offered at N=4 and, since issue #1035, at N=2
   *  and N=3. */
  const QUAD = 'vs-quad-01';
  /** N=4's second dedicated board (issue #1036), offered at 4 in both modes like Quarters. */
  const QUAD2 = 'vs-quad-02';

  it('parity pin: offers the 5 migrated boards at every (N, mode), plus each dedicated board at exactly its declared counts', () => {
    // The pre-#270 implementation offered the same 5 ids at every N (measured 15/15
    // suitable, versus-board-rules plan), and the declared catalog must not move that
    // offer. Each dedicated board adds to it rather than moving it: 6 (N, mode)
    // combinations swept, and since issue #627 every dedicated board declares both modes.
    // Each appeared at exactly one count -- the duel board at N=2, the tri board at N=3, the
    // quad boards at N=4 -- until issue #1035 offered the tri board at N=2 and Quarters at
    // N=2 and N=3, so the tri board now appears in 4 combinations and Quarters in 6.
    //
    // THE MODE PREDICATE NO LONGER HAS SHIPPED-DATA COVERAGE HERE, and that is a
    // deliberate, recorded loss rather than an oversight. vs-tri-01's `ffa`-only
    // declaration used to be the one asymmetry that made this pin discriminate
    // `e.modes.includes(mode)`: drop that conjunct and the tri board leaked into N=3
    // `teams`, and this pin caught it. #627 gave the board `teams`, so every shipped
    // entry declares both modes again and dropping the conjunct changes nothing here.
    // The synthetic fails-if-a-predicate-is-dropped fixture below is now the SOLE killer
    // of that mutation (`versus-config-choices-drop-mode-predicate`, expectFailures 2 ->
    // 1), which is the right place for it: a fixture that owns its own narrow entry
    // cannot be invalidated by a curation ruling about a shipped board, and this count
    // has already oscillated with vs-tri-01's existence three times before this one.
    //
    // The sweep stays written per (N, mode) rather than collapsing to per N. It costs
    // nothing, and the next narrowed board has to come back here and restate its case
    // instead of finding a loop that silently cannot express it.
    for (const n of [2, 3, 4] as const) {
      for (const mode of ['ffa', 'teams'] as const) {
        // Each dedicated board returns at its declared counts and at BOTH modes. vs-tri-01
        // (issue #424 rebuilt its geometry; it clears the tank-egress gate in
        // versus-board.test.ts at N=2, 3 and 4) gained `teams` in issue #627: #584
        // established that asymmetric Teams are intentionally supported, so the 2v1 a
        // three-player split produces is a supported match rather than the unfairness
        // the old `ffa`-only declaration was justified by. vs-quad-01 (issue #425)
        // splits its four corner spawns into a top pair and a bottom pair holding
        // mirrored territory. All three arms are now unconditional on mode. vs-quad-02
        // (issue #1036) joins N=4 beside it, in both modes, so N=4 offers two boards.
        //
        // Issue #1035 offers vs-tri-01 at N=2 and vs-quad-01 at N=2 and N=3, the lower counts
        // each already measures suitable at, under the "offer now; the sign-off can withdraw"
        // ruling on #229. A dedicated board is therefore no longer offered at exactly one
        // count, and the lists below are its declared counts in catalogue order.
        const extra = n === 2 ? [DUEL, TRI, QUAD] : n === 3 ? [TRI, QUAD] : n === 4 ? [QUAD, QUAD2] : [];
        expect(versusMapChoices(n, mode), `N=${n} mode=${mode}`).toEqual([...CAMPAIGN_BOARDS, ...extra]);
      }
    }
  });

  it('cross-check: everything offered is measured suitable, and what is withheld is named', () => {
    // Declarations are promises; this ties the shipped offer back to the live measurement
    // the old implementation derived it from (the same ground truth
    // versus-catalog-rules.test.ts sweeps in full).
    //
    // EQUALITY IN ONE DIRECTION ONLY, by ruling. Offering a board that does not measure
    // suitable is a bug and stays impossible. Withholding one that does is CURATION --
    // issue #271's vs-duel-01 measures suitable at all three counts and is offered at
    // N=2, because a dedicated duel board playing four-way is playable, not designed.
    // A bare subset assertion would let any number of boards silently drop out of the
    // offer, so the withheld set is pinned by name too: a board leaving the menu for a
    // reason nobody wrote down still fails here.
    // Withheld is non-empty again, and by CURATION rather than by accident -- which is
    // the state this assertion was written to demonstrate.
    //
    // It had collapsed to empty at every count: the tank-egress gate (#423) removed
    // vs-tri-01, vs-quad-01 and vs-duel-01 (at N=3/N=4) from `measured` entirely, so
    // "offered exactly equals suitable" held trivially and there was nothing left being
    // curated. Issue #424's rebuild of vs-tri-01 restores the judgement: it now measures
    // suitable at all three counts and was offered at N=3 alone, so N=2 and N=4 held it
    // back the same way vs-duel-01's [2] held that board back -- playable, but not the
    // count it was designed for (until issue #1035, below).
    //
    // vs-duel-01 contributes nothing here despite the same curation, because it no longer
    // measures suitable at N=3 or N=4: its third and fourth maximin spawns land in pockets
    // too small to mine out of. vs-quad-01 likewise fails at every count.
    //
    // Measured, not assumed, and pinned by name so a board leaving the menu for a reason
    // nobody wrote down still fails here.
    // Both dedicated multi-player boards are now measured suitable everywhere and curated
    // to one count each, so each is withheld at the two counts it was not authored for.
    // vs-quad-02 (issue #1036) is measured suitable at N=2 and N=3 too, which #1036
    // required of it, and curated to N=4 alone, so it is withheld at both. Offering it at
    // those counts later is a curation edit.
    //
    // REVERSED ON PURPOSE for three pairs by issue #1035: vs-tri-01 at N=2 and vs-quad-01 at
    // N=2 and N=3 left this list for the offer, because a follow-up ruling on #229 offers a
    // dedicated board at the lower counts it measures suitable at, to meet the #355 floor.
    // What stays withheld is still curation, not measurement: vs-tri-01 at N=4 (the upward
    // direction, which that ruling does not cover) and vs-quad-02 at N=2 and N=3.
    const WITHHELD: Record<number, string[]> = {
      2: ['vs-quad-02'],
      3: ['vs-quad-02'],
      4: ['vs-tri-01'],
    };
    const rows = versusBoardCatalog();
    for (const n of [2, 3, 4] as const) {
      const measured = rows.filter((r) => r.playerCount === n && r.suitable).map((r) => r.arenaId);
      const offered = versusMapChoices(n, 'ffa');
      // Nothing is offered that is not measured suitable.
      for (const id of offered) expect(measured, `N=${n}: ${id} is offered but not suitable`).toContain(id);
      // ...and exactly the named boards are held back.
      expect(measured.filter((id) => !offered.includes(id)), `N=${n} withheld`).toEqual(WITHHELD[n]);
    }
  });

  it('filters by declared players AND mode -- one entry dropped per predicate, the fails-if-a-predicate-is-dropped cases', () => {
    const entries = [
      entryFixture({ id: 'vs-both', players: [2, 3], modes: ['ffa', 'teams'] }),
      entryFixture({ id: 'vs-ffa-duo', players: [2], modes: ['ffa'] }),
    ];
    expect(versusMapChoices(2, 'ffa', entries)).toEqual(['vs-both', 'vs-ffa-duo']);
    expect(versusMapChoices(2, 'teams', entries)).toEqual(['vs-both']); // mode predicate
    expect(versusMapChoices(3, 'ffa', entries)).toEqual(['vs-both']); // players predicate
    expect(versusMapChoices(4, 'ffa', entries)).toEqual([]); // both predicates
  });
});

describe('the versus board floor (issue #355): boards that are not campaign arenas, per option', () => {
  // The ruling on #355 sets a floor: each startable versus option offers at least two boards
  // that are not campaign arenas. Campaign membership is read from campaign.json's levels, not
  // from board ids, so a board is "not a campaign arena" because no level plays it, whatever
  // it is called.
  const campaignArenas = new Set(CAMPAIGN_LEVELS.map((level) => level.arenaId));
  const arenaOf = (entryId: string): string =>
    (VERSUS_CATALOG.find((e) => e.id === entryId) as VersusCatalogEntry).arenaId;
  const nonCampaignBoards = (players: 2 | 3 | 4, mode: VersusMode): string[] =>
    versusMapChoices(players, mode).filter((id) => !campaignArenas.has(arenaOf(id)));

  /**
   * The options this floor is asserted for. Issue #1036 adds the two four-player options;
   * #1035 adds 2-FFA, 3-FFA and 3-Teams, and whichever of the two lands second extends the
   * list it finds rather than writing a second test.
   */
  const FLOOR_OPTIONS: readonly { players: 2 | 3 | 4; mode: VersusMode }[] = [
    { players: 2, mode: 'ffa' },
    { players: 3, mode: 'ffa' },
    { players: 3, mode: 'teams' },
    { players: 4, mode: 'ffa' },
    { players: 4, mode: 'teams' },
  ];

  it('offers each covered option at least two boards that are not campaign arenas', () => {
    expect(campaignArenas.size, 'the campaign plays some arenas').toBeGreaterThan(0);
    for (const { players, mode } of FLOOR_OPTIONS) {
      const boards = nonCampaignBoards(players, mode);
      expect(boards.length, `${players}-${mode} offers ${boards.join(', ') || 'none'}`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('retainArenaChoice (issue #274)', () => {
  // SYNTHETIC ENTRIES, not the shipped catalog, and the reason is the whole point of the
  // function. Two of the three `ArenaDropReason` values cannot be produced by the shipped
  // data at all right now -- `mode` needs an entry narrowed by mode, and issue #627 just
  // widened the last one; `gone` needs an id naming no entry. A suite that could only
  // reach `players` would leave two branches unexecuted while reading as covered, and
  // would additionally re-break the day a curation ruling moves. Fixtures own their data.
  const entries = [
    entryFixture({ id: 'vs-both', players: [2, 3], modes: ['ffa', 'teams'] }),
    entryFixture({ id: 'vs-ffa-duo', players: [2], modes: ['ffa'] }),
    entryFixture({ id: 'vs-teamless-trio', players: [3], modes: ['ffa'] }),
  ];

  it('keeps a choice the new combination still offers, and reports no drop', () => {
    // The negative control. Every assertion below is about a REPLACEMENT, and all of them
    // pass on a function that replaces unconditionally.
    expect(retainArenaChoice('vs-both', 3, 'teams', entries)).toEqual({
      arenaId: 'vs-both',
      dropped: null,
    });
  });

  it("keeps 'random', which is the one value that cannot go stale", () => {
    // Not an optimisation: `pickVersusArena` resolves 'random' against the CURRENT catalog
    // for the CURRENT combination, so it is valid at every combination by construction.
    // Were this to fall through to the offer-list check it would be replaced by itself --
    // harmless, and it would report a `dropped` that never happened, which is not.
    expect(retainArenaChoice('random', 4, 'teams', entries)).toEqual({
      arenaId: 'random',
      dropped: null,
    });
  });

  it('replaces a choice the new PLAYER COUNT drops, and blames the count', () => {
    expect(retainArenaChoice('vs-ffa-duo', 3, 'ffa', entries)).toEqual({
      arenaId: 'random',
      dropped: { id: 'vs-ffa-duo', reason: 'players' },
    });
  });

  it('replaces a choice the new MODE drops, and blames the mode', () => {
    // The distinction the pane's notice is built on: this entry DOES declare three
    // players, so telling the player it is unavailable "with 3 players" would be a lie
    // about a control they may not have touched.
    expect(retainArenaChoice('vs-teamless-trio', 3, 'teams', entries)).toEqual({
      arenaId: 'random',
      dropped: { id: 'vs-teamless-trio', reason: 'mode' },
    });
  });

  it("reports 'gone' for an id that names no entry at all", () => {
    // Reachable from a stored setup written by a build that shipped a board since
    // retired. `sanitizeSetup` screens that on the way in, so this is defence in depth --
    // but the branch decides a user-visible sentence, and an unexercised branch that
    // writes UI text is how "undefined is not available" reaches a screen.
    expect(retainArenaChoice('vs-retired', 2, 'ffa', entries)).toEqual({
      arenaId: 'random',
      dropped: { id: 'vs-retired', reason: 'gone' },
    });
  });

  it('blames the count when BOTH predicates drop the entry', () => {
    // Ordering, pinned deliberately rather than left to fall out of the implementation.
    // The count is the coarser axis and the one the player is likelier to have just
    // changed; naming the mode here would send them to a control that is not the reason.
    expect(retainArenaChoice('vs-ffa-duo', 4, 'teams', entries)).toEqual({
      arenaId: 'random',
      dropped: { id: 'vs-ffa-duo', reason: 'players' },
    });
  });
});

describe('pickVersusArena', () => {
  const base: VersusConfig = { mode: 'ffa', players: 3, arenaId: 'random', stock: 3, friendlyFire: false, slots: defaultSlots(3) };

  it('passes a concrete id through unchanged, regardless of seed', () => {
    const concrete: VersusConfig = { ...base, arenaId: 'arena-03' };
    expect(pickVersusArena(concrete, 1)).toBe('arena-03');
    expect(pickVersusArena(concrete, 999)).toBe('arena-03');
  });

  it('is deterministic: the same seed always resolves to the same pick', () => {
    // Measured (vite-node, this module, players:3): seed 7 -> 'arena-01' both times.
    expect(pickVersusArena(base, 7)).toBe('arena-01');
    expect(pickVersusArena(base, 7)).toBe('arena-01');
  });

  it('distributes: two measured seeds pick different arenas -- the negative control for a constant/broken resolver', () => {
    // RE-MEASURED again: issue #1035 adds vs-quad-01 to the N=3 offer, taking it to SEVEN
    // boards, which moves every pick that reads the draw against `choices.length`.
    //
    // Both seeds are checked against the measured distribution rather than assumed to have
    // survived. Over seeds 1..20 at N=3 on this tree the picks land arena-04 x5
    // (6,10,11,13,14), arena-05 x4 (1,5,16,17), vs-tri-01 x3 (2,3,20), arena-02 x3
    // (8,9,15), arena-01 x2 (7,19), arena-03 x2 (12,18), vs-quad-01 x1 (seed 4 alone).
    //
    // Seed 1 moved, from 'arena-04' on the six-board offer to 'arena-05'; seed 7 still lands
    // on 'arena-01', which is luck rather than design and is worth saying so nobody reads an
    // unmoved literal as evidence the offer did not move. Both sit in multi-seed buckets
    // (four and two), so neither is on a knife edge; vs-quad-01's seed 4 is a SINGLETON and
    // is deliberately not pinned here.
    // Pinned literals, not swept at runtime -- fails if pickVersusArena collapses to a
    // constant pick (e.g. always choices[0]) or stops reading `seed`.
    expect(pickVersusArena(base, 1)).toBe('arena-05');
    expect(pickVersusArena(base, 7)).toBe('arena-01');
  });
});

describe('resolveVersusConfig (issue #278: the Start-boundary resolver)', () => {
  const random3: VersusConfig = { mode: 'ffa', players: 3, arenaId: 'random', stock: 3, friendlyFire: false, slots: defaultSlots(3) };

  it('a concrete config passes through BY IDENTITY, not a copy', () => {
    // `toBe`, not `toEqual`: `applyVersusToDeps` (loop.ts) relies on this exact
    // identity to keep a concrete-arena session's `levels` built from the SAME config
    // object the pane produced. Fails if this always spreads (`{ ...config }`)
    // instead of returning `config` unchanged for a non-'random' id.
    const concrete: VersusConfig = { ...random3, arenaId: 'arena-02' };
    expect(resolveVersusConfig(concrete, 1)).toBe(concrete);
  });

  it("'random' resolves to pickVersusArena's own pick for that seed, and honors its OWN seed argument", () => {
    // Measured (pickVersusArena's own suite, above): seed 1 -> 'arena-05', seed 7 ->
    // 'arena-01' at players:3, re-derived against the SEVEN-board N=3 offer that issue
    // #1035 made by adding vs-quad-01 -- seed 1's literal moved and seed 7's did not. Two seeds, not
    // one: a single-seed assertion here would not catch a mutation that hardcodes the
    // seed it forwards to `pickVersusArena` (e.g. always `pickVersusArena(config, 1)`) --
    // this negative control was found empirically while mutating this function for issue
    // #278's PR (a seed-1-only version of this test stayed green under exactly that
    // mutation). The two seeds must keep resolving to DIFFERENT boards for that to hold,
    // which is why the pair is rechosen from the measured distribution rather than
    // renumbered.
    expect(resolveVersusConfig(random3, 1).arenaId).toBe('arena-05');
    expect(resolveVersusConfig(random3, 7).arenaId).toBe('arena-01');
  });

  it("'random' resolution preserves every other field unchanged", () => {
    // Fails if resolution drops or mutates mode/players/stock/friendlyFire while
    // replacing arenaId (e.g. spreads from a fresh default object instead of `config`).
    const cfg: VersusConfig = { mode: 'teams', players: 4, arenaId: 'random', stock: 5, friendlyFire: true, slots: defaultSlots(4) };
    const resolved = resolveVersusConfig(cfg, 1);
    expect(resolved.mode).toBe('teams');
    expect(resolved.players).toBe(4);
    expect(resolved.stock).toBe(5);
    expect(resolved.friendlyFire).toBe(true);
  });

  it('rejects a concrete map that does not support the (mode, players) combination -- issue #270\'s launch gate', () => {
    // Unreachable from the shipped pane today (every shipped entry declares all Ns
    // and both modes, and the pane filters its offer), so this throw is the loud
    // backstop for a future narrower entry (#271-#273) meeting a stale retained
    // selection -- fail at Start, never launch an unsupported combination.
    const entries = [entryFixture({ id: 'vs-duo', players: [2], modes: ['ffa'] })];
    const duo: VersusConfig = { mode: 'teams', players: 2, arenaId: 'vs-duo', stock: 3, friendlyFire: false, slots: defaultSlots(2) };
    expect(() => resolveVersusConfig(duo, 1, entries))
      .toThrow("versus-config: map 'vs-duo' does not support N=2 mode=teams");
    expect(() => resolveVersusConfig({ ...duo, mode: 'ffa', players: 3 }, 1, entries))
      .toThrow("versus-config: map 'vs-duo' does not support N=3 mode=ffa");
    // And the supported combination sails through the same entries list.
    expect(resolveVersusConfig({ ...duo, mode: 'ffa' }, 1, entries).arenaId).toBe('arena-02');
  });

  it('rejects an id that names no catalog entry', () => {
    expect(() => resolveVersusConfig({ ...random3, arenaId: 'arena-99' }, 1))
      .toThrow("versus-config: 'arena-99' names no versus catalog entry");
  });

  it('translates a concrete entry id to its underlying arena id when they differ', () => {
    // The five migrated entries have id === arenaId, so the shipped tree never
    // exercises this branch -- this synthetic entry is what keeps the translation
    // real for the purpose-built maps (#271-#273) whose ids will not be arena ids.
    const entries = [entryFixture({ id: 'vs-duo', players: [2], modes: ['ffa'] })];
    const cfg: VersusConfig = { mode: 'ffa', players: 2, arenaId: 'vs-duo', stock: 3, friendlyFire: false, slots: defaultSlots(2) };
    const resolved = resolveVersusConfig(cfg, 1, entries);
    expect(resolved.arenaId).toBe('arena-02');
    expect(resolved).not.toBe(cfg); // translated => a new object, original untouched
    expect(cfg.arenaId).toBe('vs-duo');
  });

  it('does not mutate the original config object', () => {
    // Fails if resolution writes `config.arenaId = ...` in place instead of
    // returning a new object -- which would corrupt the pane's own retained
    // selection (hud.ts's versusConfigState) if it were ever handed the same
    // reference resolveVersusConfig reads from.
    const original: VersusConfig = { ...random3 };
    resolveVersusConfig(random3, 1);
    expect(random3).toEqual(original);
  });
});
