// VersusConfig's pure helpers: the map filter and the deterministic 'random' resolver.
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
  const SHIPPED = ['arena-01', 'arena-02', 'arena-03', 'arena-04', 'arena-05'];

  it('parity pin: offers exactly the 5 shipped entry ids, in catalog order, at every (N, mode)', () => {
    // The pre-#270 implementation offered these same 5 ids at every N (measured
    // 15/15 suitable, versus-board-rules plan); the declared catalog must not move
    // the shipped offer -- 6 (N, mode) combinations swept.
    for (const n of [2, 3, 4] as const) {
      for (const mode of ['ffa', 'teams'] as const) {
        expect(versusMapChoices(n, mode), `N=${n} mode=${mode}`).toEqual(SHIPPED);
      }
    }
  });

  it('cross-check: the declared offer equals versusBoardCatalog\'s measured suitable ids at every N', () => {
    // Declarations are promises; this ties the shipped offer back to the live
    // measurement the old implementation derived it from (the same ground truth
    // versus-catalog-rules.test.ts sweeps in full).
    const rows = versusBoardCatalog();
    for (const n of [2, 3, 4] as const) {
      const measured = rows.filter((r) => r.playerCount === n && r.suitable).map((r) => r.arenaId);
      expect(versusMapChoices(n, 'ffa'), `N=${n}`).toEqual(measured);
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
  const base: VersusConfig = { mode: 'ffa', players: 3, arenaId: 'random', stock: 3, friendlyFire: false };

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
    // Measured (vite-node, this module, players:3, choices = all 5 shipped arenas):
    // seed 1 -> 'arena-04', seed 6 -> 'arena-03'. Pinned literals, not swept at
    // runtime -- fails if pickVersusArena collapses to a constant pick (e.g. always
    // choices[0]) or stops reading `seed`.
    expect(pickVersusArena(base, 1)).toBe('arena-04');
    expect(pickVersusArena(base, 6)).toBe('arena-03');
  });
});

describe('resolveVersusConfig (issue #278: the Start-boundary resolver)', () => {
  const random3: VersusConfig = { mode: 'ffa', players: 3, arenaId: 'random', stock: 3, friendlyFire: false };

  it('a concrete config passes through BY IDENTITY, not a copy', () => {
    // `toBe`, not `toEqual`: `applyVersusToDeps` (loop.ts) relies on this exact
    // identity to keep a concrete-arena session's `levels` built from the SAME config
    // object the pane produced. Fails if this always spreads (`{ ...config }`)
    // instead of returning `config` unchanged for a non-'random' id.
    const concrete: VersusConfig = { ...random3, arenaId: 'arena-02' };
    expect(resolveVersusConfig(concrete, 1)).toBe(concrete);
  });

  it("'random' resolves to pickVersusArena's own pick for that seed, and honors its OWN seed argument", () => {
    // Measured (pickVersusArena's own suite, above): seed 1 -> 'arena-04', seed 6 ->
    // 'arena-03' at players:3. Two seeds, not one: a single-seed assertion here would
    // not catch a mutation that hardcodes the seed it forwards to `pickVersusArena`
    // (e.g. always `pickVersusArena(config, 1)`) -- this negative control was found
    // empirically while mutating this function for issue #278's PR (a seed-1-only
    // version of this test stayed green under exactly that mutation).
    expect(resolveVersusConfig(random3, 1).arenaId).toBe('arena-04');
    expect(resolveVersusConfig(random3, 6).arenaId).toBe('arena-03');
  });

  it("'random' resolution preserves every other field unchanged", () => {
    // Fails if resolution drops or mutates mode/players/stock/friendlyFire while
    // replacing arenaId (e.g. spreads from a fresh default object instead of `config`).
    const cfg: VersusConfig = { mode: 'teams', players: 4, arenaId: 'random', stock: 5, friendlyFire: true };
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
    const duo: VersusConfig = { mode: 'teams', players: 2, arenaId: 'vs-duo', stock: 3, friendlyFire: false };
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
    const cfg: VersusConfig = { mode: 'ffa', players: 2, arenaId: 'vs-duo', stock: 3, friendlyFire: false };
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
