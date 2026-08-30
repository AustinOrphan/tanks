// VersusConfig's pure helpers: the map filter and the deterministic 'random' resolver.
import { defaultSlots } from './versus-setup';
// Both are consumed by createVersusLevelSystem (levels.test.ts), but are pure and
// node-testable on their own -- no World, no RunStore.
import { describe, it, expect } from 'vitest';
import { versusMapChoices, pickVersusArena, resolveVersusConfig, type VersusConfig } from './versus-config';
import { versusBoardCatalog } from '../sim/versus-board';
import type { VersusCatalogEntry } from '../sim/config/versus-catalog-types';

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
  /** N=3 ffa additionally offers the dedicated tri board (issue #272, rebuilt by #424). */
  const TRI = 'vs-tri-01';

  it('parity pin: offers the 5 migrated boards at every (N, mode), plus each dedicated board at exactly its own count', () => {
    // The pre-#270 implementation offered the same 5 ids at every N (measured 15/15
    // suitable, versus-board-rules plan), and the declared catalog must not move that
    // offer. Each dedicated board adds to it at exactly one count rather than moving it:
    // 6 (N, mode) combinations swept, the duel board appears in 2 of them (N=2, both
    // modes), the tri board in 1 (N=3, ffa only -- issue #272 declares no `teams`,
    // because three players have no fair team split, so the mode predicate drops it)
    // and issue #273's quad board in 2 (N=4, both modes: its four corner spawns split
    // into a top pair and a bottom pair holding mirrored territory, so `teams` is
    // declared alongside `ffa` and the mode predicate keeps it at both).
    for (const n of [2, 3, 4] as const) {
      for (const mode of ['ffa', 'teams'] as const) {
        // vs-tri-01 is BACK (issue #424 rebuilt its geometry; it clears the tank-egress
        // gate in versus-board.test.ts at N=2, 3 and 4). It returns at N=3 AND `ffa`
        // alone: three players have no fair team split, so the catalog declares one mode
        // and the mode predicate drops it from N=3 `teams`. That asymmetry between the
        // two `extra` arms is the whole reason this pin is written per (N, mode) rather
        // than per N.
        //
        // vs-quad-01 stays WITHDRAWN pending #425 -- players cannot leave their spawns on
        // it (#423) -- so it has no constant here. Only the OFFER is withdrawn; its arena
        // definition remains in arenas.json for the redesign to edit, and restoring it
        // means a catalog entry plus a row here AND passing the egress gate.
        const extra = n === 2 ? [DUEL] : n === 3 && mode === 'ffa' ? [TRI] : [];
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
    // suitable at all three counts and is offered at N=3 alone, so N=2 and N=4 hold it
    // back the same way vs-duel-01's [2] holds that board back -- playable, but not the
    // count it was designed for.
    //
    // vs-duel-01 contributes nothing here despite the same curation, because it no longer
    // measures suitable at N=3 or N=4: its third and fourth maximin spawns land in pockets
    // too small to mine out of. vs-quad-01 likewise fails at every count.
    //
    // Measured, not assumed, and pinned by name so a board leaving the menu for a reason
    // nobody wrote down still fails here.
    const WITHHELD: Record<number, string[]> = { 2: ['vs-tri-01'], 3: [], 4: ['vs-tri-01'] };
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
    // RE-MEASURED again: issue #424's rebuild returns vs-tri-01 to the N=3 offer, taking it
    // to SIX boards, which moves every pick that reads `seed % choices.length`.
    //
    // Both seeds are checked against the measured distribution rather than assumed to have
    // survived. Over seeds 1..20 at N=3 on this tree the picks land arena-04 x6
    // (1,6,10,11,13,16), arena-05 x5 (2,3,5,17,20), arena-01 x3 (7,8,19), arena-02 x3
    // (9,12,15), arena-03 x2 (14,18), vs-tri-01 x1 (seed 4 alone).
    //
    // The pinned pair is unchanged -- seed 1 -> 'arena-04' and seed 7 -> 'arena-01' both
    // still hold, which is luck rather than design and is worth saying so nobody reads an
    // unmoved literal as evidence the offer did not move. Both sit in multi-seed buckets
    // (six and three), so neither is on a knife edge; vs-tri-01's seed 4 is a SINGLETON and
    // is deliberately not pinned here.
    // Pinned literals, not swept at runtime -- fails if pickVersusArena collapses to a
    // constant pick (e.g. always choices[0]) or stops reading `seed`.
    expect(pickVersusArena(base, 1)).toBe('arena-04');
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
    // Measured (pickVersusArena's own suite, above): seed 1 -> 'arena-04', seed 7 ->
    // 'arena-01' at players:3, re-derived against the SIX-board N=3 offer that issue
    // #424's rebuild restored -- both literals happen to be unchanged. Two seeds, not
    // one: a single-seed assertion here would not catch a mutation that hardcodes the
    // seed it forwards to `pickVersusArena` (e.g. always `pickVersusArena(config, 1)`) --
    // this negative control was found empirically while mutating this function for issue
    // #278's PR (a seed-1-only version of this test stayed green under exactly that
    // mutation). The two seeds must keep resolving to DIFFERENT boards for that to hold,
    // which is why the pair is rechosen from the measured distribution rather than
    // renumbered.
    expect(resolveVersusConfig(random3, 1).arenaId).toBe('arena-04');
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
