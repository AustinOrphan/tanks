import { describe, it, expect } from 'vitest';
import type { Arena } from './arena';
import type { WallKind } from './types';
import type { VersusCatalogEntry } from './config/versus-catalog-types';
import { VERSUS_CATALOG } from './config/versus-catalog';
import { versusCatalogEntryFailures, versusCatalogFailures } from './versus-catalog-rules';

// ---------------------------------------------------------------------------
// Shipped sweep: every declaration in versus-catalog.json proven against the real
// geometry machinery. Denominator: 5 entries x N in {2,3,4} x 2 modes = 30 declared
// (entry, N, mode) combinations on the authored grids (variant coverage adds its own
// sweep -- see the seeded blocks below). The versus-board-rules plan measured all 15
// (arena, N) combinations suitable; this sweep is the catalog-shaped restatement of
// that ground truth, and it moves visibly if a 6th entry or a narrowed declaration
// lands.
// ---------------------------------------------------------------------------

describe('versus catalog sweep: shipped declarations hold', () => {
  it('all 5 shipped entries validate clean: 0 failures over 30 declared (entry, N, mode) combinations', () => {
    expect(VERSUS_CATALOG.length).toBe(5);
    for (const entry of VERSUS_CATALOG) {
      expect(versusCatalogEntryFailures(entry), entry.id).toEqual([]);
    }
  });

  it('versusCatalogFailures sweeps the whole shipped catalog to the same answer', () => {
    expect(versusCatalogFailures()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Synthetic negative controls -- one rule isolated per fixture, in the
// versus-board.test.ts idiom (plain Arena literals, measured against real loadArena
// output). Entries here are plain literals too: the schema validator is exercised in
// config/validate.test.ts; these prove the GEOMETRY rules fire and their diagnostics
// carry the exact (entry, N, mode, variant, rule) identification issue #270 requires.
// ---------------------------------------------------------------------------

function fixtureEntry(overrides: Partial<VersusCatalogEntry>): VersusCatalogEntry {
  return {
    id: 'vs-fixture',
    arenaId: 'fixture-arena',
    displayName: 'Fixture',
    intent: 'test fixture',
    preview: 'fixture-arena',
    players: [2, 3, 4],
    modes: ['ffa', 'teams'],
    spawnPolicy: 'maximin',
    variants: [],
    ...overrides,
  };
}

function arenaFor(arena: Arena): (arenaId: string) => Arena {
  return () => arena;
}

describe('opening-sightlines rule: an open room fails with the exact diagnostic shape', () => {
  // The 10x10 open room from versus-board.test.ts: nothing to hide behind, so every
  // spawn pair keeps mutual LOS; separation and room hold (99 open cells), isolating
  // the sightline rule.
  const grid: string[] = [];
  for (let r = 0; r < 10; r++) grid.push(r === 0 ? 'P.........' : '..........');
  const arena: Arena = { cols: 10, rows: 10, cellSize: 1, legend: {}, grid };

  it('declaring N=4 in both modes yields one opening-sightlines failure per mode and nothing else', () => {
    const entry = fixtureEntry({ players: [4] });
    const failures = versusCatalogEntryFailures(entry, { arenaFor: arenaFor(arena) });
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(
      /^vs-fixture \(fixture-arena\) N=4 mode=ffa variant=authored: opening-sightlines: 0 of 6 spawn pairs concealed$/,
    );
    expect(failures[1]).toMatch(/mode=teams variant=authored: opening-sightlines:/);
  });
});

describe('room rule: the pillar room fails at N=3, passes at N=2', () => {
  // The 7x7 pillar room from versus-board.test.ts: 39 open-floor cells, so the
  // per-player ratio crosses MIN_OPEN_FLOOR_PER_PLAYER (18) between N=2 and N=3,
  // while separation and concealment hold throughout.
  const arena: Arena = {
    cols: 7, rows: 7, cellSize: 1,
    legend: { x: 'solid' as WallKind },
    grid: ['P......', '.x.x.x.', '.......', '.x.x.x.', '.......', '.x.x.x.', '.......'],
  };

  it('declaring N=[2,3] in ffa yields exactly one room failure, at N=3', () => {
    const entry = fixtureEntry({ players: [2, 3], modes: ['ffa'] });
    const failures = versusCatalogEntryFailures(entry, { arenaFor: arenaFor(arena) });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^vs-fixture \(fixture-arena\) N=3 mode=ffa variant=authored: room: 13\.00 open-floor cells per player < 18$/);
  });
});

describe('connectivity rule: a spawn placed across a solid divider is named', () => {
  // Two chambers split by a full-height SOLID column: the maximin picker happily
  // places the co-player in the far chamber (it maximises distance and the divider
  // even grants concealment), so declared support PASSES at N=2 while no path
  // through non-solid cells exists -- exactly the case the connectivity rule exists
  // for, and one evaluateVersusBoard alone cannot see.
  const arena: Arena = {
    cols: 11, rows: 5, cellSize: 1,
    legend: { x: 'solid' as WallKind },
    grid: ['P....x.....', '.....x.....', '.....x.....', '.....x.....', '.....x.....'],
  };

  it('declaring N=2 in ffa yields connectivity failures and no others', () => {
    const entry = fixtureEntry({ players: [2], modes: ['ffa'] });
    const failures = versusCatalogEntryFailures(entry, { arenaFor: arenaFor(arena) });
    expect(failures.length).toBeGreaterThanOrEqual(1);
    for (const f of failures) {
      expect(f).toMatch(/^vs-fixture \(fixture-arena\) N=2 mode=ffa variant=authored: connectivity: spawn cell \(\d+, \d+\) is not reachable from the P cell/);
    }
  });

  it('negative control: the same board with the divider breached validates clean at N=2', () => {
    const open = { ...arena, grid: arena.grid.map((row, r) => (r === 2 ? row.replace('x', '.') : row)) };
    const entry = fixtureEntry({ players: [2], modes: ['ffa'] });
    expect(versusCatalogEntryFailures(entry, { arenaFor: arenaFor(open) })).toEqual([]);
  });
});

describe('variant-coverage rule: a vacuous seeded declaration is named', () => {
  // No destructible cell anywhere: advertising seeded-destructible promises a
  // variant generator with nothing to draw from. The pillar room's geometry keeps
  // every other rule quiet at N=2.
  const arena: Arena = {
    cols: 7, rows: 7, cellSize: 1,
    legend: { x: 'solid' as WallKind },
    grid: ['P......', '.x.x.x.', '.......', '.x.x.x.', '.......', '.x.x.x.', '.......'],
  };

  it('declaring seeded-destructible with 0 destructible cells fails at entry level', () => {
    const entry = fixtureEntry({ players: [2], modes: ['ffa'], variants: ['seeded-destructible'] });
    const failures = versusCatalogEntryFailures(entry, { arenaFor: arenaFor(arena) });
    expect(failures).toEqual([
      'vs-fixture (fixture-arena) N=any mode=any variant=seeded-destructible: variant-coverage: arena has 0 destructible cells; the declaration is vacuous',
    ]);
  });

  it('negative control: the same declaration with destructible pillars draws real variants and validates clean', () => {
    const withDestructibles: Arena = { ...arena, legend: { x: 'destructible' as WallKind } };
    const entry = fixtureEntry({ players: [2], modes: ['ffa'], variants: ['seeded-destructible'] });
    expect(versusCatalogEntryFailures(entry, { arenaFor: arenaFor(withDestructibles) })).toEqual([]);
  });
});

describe('seeded variant sweep: a draw that regresses a criterion names its seed', () => {
  // A corridor where the ONLY concealment between the two spawn ends is a single
  // destructible block: the authored board conceals, and any seeded draw at
  // fraction 1.0-equivalent... instead we pin the real fraction: with exactly one
  // destructible cell, round(1 * 0.4) = 0 removals -- so to make a draw actually
  // remove the block, the fixture carries three destructible cells in the sight
  // column (round(3 * 0.4) = 1 removed). Which of the three goes varies by seed;
  // seeds where the removed cell reopens no spawn pair line stay clean, so the
  // assertion sweeps ALL five pinned seeds and requires at least one named
  // failure rather than pinning a specific seed's draw order.
  const arena: Arena = {
    cols: 9, rows: 3, cellSize: 1,
    legend: { x: 'solid' as WallKind, d: 'destructible' as WallKind },
    grid: ['xxxxxxxxx', 'P...d...x', 'xxxxxxxxx'].map((r) => r),
  };

  it('the authored corridor conceals its two spawns behind the destructible block', () => {
    const entry = fixtureEntry({ players: [2], modes: ['ffa'], variants: [] });
    const failures = versusCatalogEntryFailures(entry, { arenaFor: arenaFor(arena) })
      .filter((f) => !f.includes(': room:'));
    expect(failures).toEqual([]);
  });

  it('with seeded-destructible declared, the sight-blocker removal surfaces as variant-coverage naming a seed', () => {
    // One destructible cell alone never draws (round(1 * 0.4) = 0 removals), so the
    // fixture carries TWO: the corridor's sight blocker at (4, 1) plus a decoy
    // embedded in the bottom wall at (3, 2) that no corridor sightline crosses.
    // round(2 * 0.4) = 1: every seed removes exactly one of the two; a draw taking
    // the corridor blocker opens the P-to-spawn line (0 of 1 pairs concealed), a
    // draw taking the decoy leaves the corridor concealed. MEASURED on the pinned
    // sample (probe, this tree): all 5 of the 5 default seeds happen to draw the
    // corridor blocker, so today every pinned seed fails -- the assertion still
    // requires only >= 1 named failure, so a future seed-list change that lets
    // decoy draws through stays green without weakening the rule under test.
    const twoDraws: Arena = { ...arena, grid: ['xxxxxxxxx', 'P...d...x', 'xxxdxxxxx'] };
    const entry = fixtureEntry({ players: [2], modes: ['ffa'], variants: ['seeded-destructible'] });
    const failures = versusCatalogEntryFailures(entry, { arenaFor: arenaFor(twoDraws) })
      .filter((f) => f.includes('variant-coverage'));
    expect(failures.length).toBeGreaterThanOrEqual(1);
    for (const f of failures) {
      expect(f).toMatch(/variant=seeded-destructible seed=\d+: variant-coverage: 0 of 1 spawn pairs concealed$/);
    }
  });
});

describe('spawn-clearance seam: an injected rule surfaces with full identification', () => {
  const grid: string[] = [];
  for (let r = 0; r < 10; r++) grid.push(r === 0 ? 'P.........' : '..........');
  const openRoom: Arena = { cols: 10, rows: 10, cellSize: 1, legend: {}, grid };

  it('absent by default: no spawn-clearance line without an injected rule', () => {
    const entry = fixtureEntry({ players: [4] });
    const failures = versusCatalogEntryFailures(entry, { arenaFor: arenaFor(openRoom) });
    expect(failures.some((f) => f.includes('spawn-clearance'))).toBe(false);
  });

  it('an injected rule sees the real positions and its findings carry (entry, N, mode)', () => {
    const entry = fixtureEntry({ players: [2], modes: ['teams'] });
    const failures = versusCatalogEntryFailures(entry, {
      arenaFor: arenaFor(openRoom),
      clearanceRule: (ctx) => [`probe saw ${ctx.positions.length} positions at N=${ctx.playerCount}`],
    });
    const clearance = failures.filter((f) => f.includes('spawn-clearance'));
    expect(clearance).toEqual([
      'vs-fixture (fixture-arena) N=2 mode=teams variant=authored: spawn-clearance: probe saw 2 positions at N=2',
    ]);
  });
});

describe('determinism: two runs on the same entry are deep-equal', () => {
  it('the shipped arena-02 entry (most destructibles) yields identical failure lists twice', () => {
    const entry = VERSUS_CATALOG[1];
    expect(versusCatalogEntryFailures(entry)).toEqual(versusCatalogEntryFailures(entry));
  });
});
