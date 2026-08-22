// VersusConfig's pure helpers: the map filter and the deterministic 'random' resolver.
// Both are consumed by createVersusLevelSystem (levels.test.ts), but are pure and
// node-testable on their own -- no World, no RunStore.
import { describe, it, expect } from 'vitest';
import { versusMapChoices, pickVersusArena, resolveVersusConfig, type VersusConfig } from './versus-config';
import { versusBoardCatalog } from '../sim/versus-board';
import type { Arena } from '../sim/arena';
import type { WallKind } from '../sim/types';

describe('versusMapChoices', () => {
  it('equals the catalog\'s own suitable ids at 2/3/4 players -- non-empty, the negative control for a broken filter', () => {
    // Derived from versusBoardCatalog() directly, not re-typed by hand: this fails if
    // versusMapChoices and versusBoardCatalog's own `suitable` field ever disagree.
    const rows = versusBoardCatalog();
    for (const n of [2, 3, 4] as const) {
      const expected = rows.filter((r) => r.playerCount === n && r.suitable).map((r) => r.arenaId);
      expect(expected.length).toBeGreaterThan(0); // non-empty: today 5/5 at every N
      expect(versusMapChoices(n)).toEqual(expected);
    }
  });

  // Today's shipped catalog is 15/15 suitable (5 arenas x {2,3,4}), so the assertion
  // above alone cannot tell "filters on `suitable`" apart from "returns every id" --
  // both read identically against that data. This synthetic fixture (the same shape
  // versus-board.test.ts's own "accepts an explicit arena/count list" case uses)
  // mixes one suitable and one unsuitable row at the SAME arena, different N, so a
  // `rows.map(r => r.arenaId)` mutation that drops the `suitable` filter fails this
  // test while passing the one above.
  it('excludes an unsuitable row from a synthetic fixture -- the fails-if-the-filter-is-dropped case', () => {
    const arena: Arena & { id: string } = {
      id: 'fixture', cols: 7, rows: 7, cellSize: 1,
      legend: { x: 'solid' as WallKind },
      grid: [
        'P......',
        '.x.x.x.',
        '.......',
        '.x.x.x.',
        '.......',
        '.x.x.x.',
        '.......',
      ],
    };
    const rows = versusBoardCatalog([arena], [2, 4]);
    expect(rows[0].suitable).toBe(true); // N=2 passes room (measured 19.5, versus-board.test.ts)
    expect(rows[1].suitable).toBe(false); // N=4 fails room (measured 9.75)
    expect(versusMapChoices(2, rows)).toEqual(['fixture']);
    expect(versusMapChoices(4, rows)).toEqual([]);
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
