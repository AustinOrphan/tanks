import { describe, it, expect } from 'vitest';
import type { Arena } from './arena';
import type { WallKind } from './types';
import type { VersusCatalogEntry } from './config/versus-catalog-types';
import { VERSUS_CATALOG } from './config/versus-catalog';
import { arenaById } from './config/arenas';
import { loadArena } from './arena';
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
  it('all 7 shipped entries validate clean: 0 failures over 33 declared (entry, N, mode) combinations', () => {
    // 33, not 42: five entries declare 3 player counts x 2 modes (30), issue #271's
    // vs-duel-01 declares 1 x 2, and issue #272's vs-tri-01 declares 1 x 1 -- three
    // players have no fair team split, so it promises `ffa` alone. The sweep covers what
    // each entry PROMISES, so a narrowed declaration shrinks this denominator rather than
    // leaving combinations silently unchecked.
    expect(VERSUS_CATALOG.length).toBe(7);
    expect(
      VERSUS_CATALOG.reduce((n, e) => n + e.players.length * e.modes.length, 0),
      'the declared (entry, N, mode) population this title states',
    ).toBe(33);
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
  // while separation and concealment hold throughout. cellSize 2, not 1: room
  // ratios count CELLS (cellSize-independent), and at cellSize 1 the #225
  // hull-clearance filter leaves only mutually-visible room-centre cells eligible,
  // which would break this fixture's room-only isolation once both changes land.
  const arena: Arena = {
    cols: 7, rows: 7, cellSize: 2,
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
  // every other rule quiet at N=2. cellSize 2 for the same #225-proofing reason as
  // the room fixture above: at cellSize 1 the hull-clearance filter would push the
  // destructible-pillar negative control's variant draws into visible cells.
  const arena: Arena = {
    cols: 7, rows: 7, cellSize: 2,
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
  // cellSize 2 (issue #312): at cellSize 1 every corridor cell is wall-adjacent, the
  // clearance filter's pool empties, and the DEFAULT spawn-clearance rule (real since
  // #312) reports the fallback spawns -- noise this fixture's concealment subject does
  // not want. Concealment and variant semantics are scale-invariant.
  const arena: Arena = {
    cols: 9, rows: 3, cellSize: 2,
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

  it('the DEFAULT rule is the real versusSpawnClearanceFailures: clean on a roomy fixture (issue #312)', () => {
    // Spawn positions are already clearance-filtered since #225, so the default rule
    // re-verifies rather than newly constrains: the open room's picked spawns are
    // hull-clear and no spawn-clearance line appears -- while the cramped fixture
    // below proves the default is genuinely wired, not absent.
    const entry = fixtureEntry({ players: [4] });
    const failures = versusCatalogEntryFailures(entry, { arenaFor: arenaFor(openRoom) });
    expect(failures.some((f) => f.includes('spawn-clearance'))).toBe(false);
  });

  it('a cramped board fails the DEFAULT rule with full identification (issue #312)', () => {
    // A 1-cell corridor at cellSize 2/3: every open centre is 0.333 from the walls,
    // the picker's eligible pool empties, and the fallback spawns really are
    // hull-clipped -- exactly what the default rule must surface in the sweep.
    const cramped: Arena = {
      cols: 7, rows: 3, cellSize: 2 / 3,
      legend: { x: 'solid' as WallKind },
      grid: ['xxxxxxx', 'P.....x', 'xxxxxxx'],
    };
    const entry = fixtureEntry({ players: [2], modes: ['ffa'] });
    const failures = versusCatalogEntryFailures(entry, { arenaFor: arenaFor(cramped) })
      .filter((f) => f.includes('spawn-clearance'));
    expect(failures.length).toBeGreaterThanOrEqual(1);
    for (const f of failures) {
      expect(f).toMatch(/^vs-fixture \(fixture-arena\) N=2 mode=ffa variant=authored: spawn-clearance: /);
    }
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

// ---------------------------------------------------------------------------
// vs-duel-01's own design claims (issue #271). The geometry sweep above proves the
// board is LEGAL; these prove it is the board its notes say it is. Acceptance
// criterion 4 -- "rotational, mirrored, or deliberately documented asymmetric balance
// is evident" -- is otherwise carried by prose in `arenas.json` and by nothing that can
// fail.
// ---------------------------------------------------------------------------

describe('vs-duel-01: the duel board is its own 180-degree rotation', () => {
  const arena = arenaById('vs-duel-01');
  /**
   * Wall kind alone: `undefined` for open floor AND for a spawn letter.
   *
   * Spawn letters are deliberately outside the comparison. The board carries `P` at
   * (1,1) and `B` at (25,19) -- each other's rotational partner by POSITION, but
   * different characters, because arenas.json requires exactly one player spawn and at
   * least one enemy. Comparing raw characters would fail on that pair and prove nothing
   * about the geometry; comparing wall kind is the claim the notes actually make.
   */
  const kindAt = (c: number, r: number): string | undefined => arena.legend[arena.grid[r][c]];

  it('every cell has the same wall kind as its partner through the centre', () => {
    const asymmetric: string[] = [];
    let compared = 0;
    for (let r = 0; r < arena.rows; r++) {
      for (let c = 0; c < arena.cols; c++) {
        compared++;
        const partner = kindAt(arena.cols - 1 - c, arena.rows - 1 - r);
        if (kindAt(c, r) !== partner) {
          asymmetric.push(`(${c},${r})=${kindAt(c, r) ?? 'floor'} vs (${arena.cols - 1 - c},${arena.rows - 1 - r})=${partner ?? 'floor'}`);
        }
      }
    }
    expect(compared, 'the whole board, not a sample').toBe(27 * 21);
    expect(asymmetric, 'vs-duel-01 is not its own 180-degree rotation').toEqual([]);
  });

  it('the two spawn letters are each other\'s partner through the centre', () => {
    const find = (ch: string): [number, number] => {
      for (let r = 0; r < arena.rows; r++) {
        const c = arena.grid[r].indexOf(ch);
        if (c !== -1) return [c, r];
      }
      throw new Error(`no ${ch} in vs-duel-01`);
    };
    const [pc, pr] = find('P');
    const [bc, br] = find('B');
    expect([bc, br], 'the enemy letter is not the player letter rotated').toEqual([
      arena.cols - 1 - pc,
      arena.rows - 1 - pr,
    ]);
    // ...and both sit on the old cellSize-2 lattice resolution.test.ts pins, which is
    // what forced 27x21 rather than a 25-column board: at 25 columns the partner of
    // column 1 is column 23, and 23 is not 1 (mod 3).
    for (const v of [pc, pr, bc, br]) expect(v % 3, `${v} is off the spawn lattice`).toBe(1);
  });

  it('is NOT symmetric under a plain mirror, which is a different board', () => {
    // A negative control for the test above: 180-degree rotation is the claim, and a
    // left-right mirror is the nearby shape that would also read as "symmetric" in a
    // screenshot while playing differently -- under a mirror both players approach the
    // centre pinwheel from the same side, and the pinwheel stops being a pinwheel.
    let mirrored = true;
    for (let r = 0; r < arena.rows && mirrored; r++) {
      for (let c = 0; c < arena.cols; c++) {
        if (kindAt(c, r) !== kindAt(arena.cols - 1 - c, r)) {
          mirrored = false;
          break;
        }
      }
    }
    expect(mirrored, 'the board is left-right mirrored, so the rotation test proves less than it claims').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// vs-tri-01's own design claims (issue #272). Same division as vs-duel-01 above: the
// geometry sweep proves the board is LEGAL, and these prove it is the board its notes
// say it is.
//
// The shape of the claim differs, and that difference is the point. A rectangular grid
// has no three-fold rotation -- its symmetry group is {identity, 180 degrees, two
// mirrors}, order 4, with no element of order 3 -- so #271's "the board is its own
// rotation" is unavailable at N=3. Criterion 4's "another explicitly justified
// three-way balance" is therefore discharged in two halves: a MIRROR the two base
// players hold by construction, and a MEASURED equivalence for the third, which sits on
// the mirror axis and so has no partner to be equal to.
//
// Versus spawns are not the authored letters -- `loadArena`'s versus branch derives them
// from geometry via `pickVersusSpawnCell` -- so every claim below is about where that
// policy actually lands, not about where a letter was typed.
// ---------------------------------------------------------------------------

describe('vs-tri-01: mirrored for two players, measured for the third', () => {
  const arena = arenaById('vs-tri-01');
  const AXIS = 13; // column c mirrors to (cols - 1 - c) = 26 - c; 13 is its own partner
  /** Wall kind alone: `undefined` for open floor AND for a spawn letter -- same reason
   * the duel board's comparison gives, since `P` and `B` are not mirror partners here. */
  const kindAt = (c: number, r: number): WallKind | undefined => arena.legend[arena.grid[r][c]];

  const blocked = (c: number, r: number): boolean =>
    c < 0 || r < 0 || c >= arena.cols || r >= arena.rows || kindAt(c, r) !== undefined;

  /** Shortest walkable path in cells, treating solid AND destructible as blocking --
   * the AUTHORED variant, before anything is breached. Euclid is deliberately not used:
   * two spawns can be close in a straight line and far apart to drive between, which is
   * the same distinction `versus-spawns-drop-euclid-tiebreak` exists to protect. */
  const pathLen = (from: [number, number], to: [number, number]): number => {
    const key = (c: number, r: number): number => r * arena.cols + c;
    const dist = new Map<number, number>([[key(from[0], from[1]), 0]]);
    const queue: [number, number][] = [from];
    for (let head = 0; head < queue.length; head++) {
      const [c, r] = queue[head];
      const d = dist.get(key(c, r)) as number;
      if (c === to[0] && r === to[1]) return d;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr;
        if (blocked(nc, nr) || dist.has(key(nc, nr))) continue;
        dist.set(key(nc, nr), d + 1);
        queue.push([nc, nr]);
      }
    }
    return -1;
  };

  /** The real N=3 versus placement, as grid cells. `cellCentre` is (c + 0.5) * cellSize. */
  const spawnCells = (): [number, number][] =>
    loadArena(arena, 3, 'ffa').tanks
      .filter((t) => t.kind === 'player')
      .map((t) => [Math.round(t.pos.x / arena.cellSize - 0.5), Math.round(t.pos.y / arena.cellSize - 0.5)] as [number, number]);

  it('every cell has the same wall kind as its mirror partner about the axis', () => {
    const asymmetric: string[] = [];
    let compared = 0;
    for (let r = 0; r < arena.rows; r++) {
      for (let c = 0; c < arena.cols; c++) {
        compared++;
        const partner = kindAt(arena.cols - 1 - c, r);
        if (kindAt(c, r) !== partner) {
          asymmetric.push(`(${c},${r})=${kindAt(c, r) ?? 'floor'} vs (${arena.cols - 1 - c},${r})=${partner ?? 'floor'}`);
        }
      }
    }
    expect(compared, 'the whole board, not a sample').toBe(27 * 17);
    expect(asymmetric, 'vs-tri-01 is not its own mirror about the axis').toEqual([]);
  });

  it('the maximin policy lands on the authored triangle: two mirrored corners and one on the axis', () => {
    const cells = spawnCells();
    expect(cells).toHaveLength(3);
    // Sorted, because the policy's output ORDER is not part of the claim -- only the set.
    const sorted = [...cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(sorted).toEqual([[1, 15], [13, 1], [25, 15]]);
    // The two base spawns really are mirror partners, which is what makes their
    // equivalence structural rather than coincidental; the third really is on the axis,
    // which is what leaves it needing the measurement below.
    const base = sorted.filter(([c]) => c !== AXIS);
    expect(base.map(([c]) => c)).toEqual([1, 25]);
    expect(base[0][0]).toBe(arena.cols - 1 - base[1][0]);
    expect(base[0][1]).toBe(base[1][1]);
    expect(sorted.filter(([c]) => c === AXIS)).toEqual([[13, 1]]);
  });

  it('the three spawns are pairwise EQUIDISTANT along the real walkable path', () => {
    const cells = spawnCells();
    const pairs: number[] = [];
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) pairs.push(pathLen(cells[i], cells[j]));
    }
    expect(pairs, 'C(3,2) pairs, every one of them').toHaveLength(3);
    // 26 is not a tuning target that happened to come out even -- it is why the board is
    // 27x17. Breaking the base lane so the two lower spawns cannot see each other costs a
    // two-cell detour, taking base-to-base from 24 to 26, and row 15 is the row at which
    // top-to-base is also 26. At 27x15 the same construction gives 26/24/24 and no wall
    // can close it: the two distances have opposite parity there.
    expect(pairs).toEqual([26, 26, 26]);
  });

  it('the axis spawn, which has no mirror partner, is no better placed than the two that do', () => {
    // The half of criterion 4 that a mirror cannot discharge, and it caught a real
    // asymmetry: before the keystone alcove was added the axis spawn sat in an open lane
    // with 60 reachable cells within 8 steps and clear runs of 13 either side, against 38
    // and 1-2 for each base spawn. Both figures are bounded rather than pinned exactly,
    // so ordinary furniture edits do not churn this test, but the BAND is narrow enough
    // that reopening that lane fails it.
    const reach = (cell: [number, number], radius: number): number => {
      const key = (c: number, r: number): number => r * arena.cols + c;
      const dist = new Map<number, number>([[key(cell[0], cell[1]), 0]]);
      const queue: [number, number][] = [cell];
      let seen = 0;
      for (let head = 0; head < queue.length; head++) {
        const [c, r] = queue[head];
        const d = dist.get(key(c, r)) as number;
        if (d > 0) seen++;
        if (d >= radius) continue;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nc = c + dc, nr = r + dr;
          if (blocked(nc, nr) || dist.has(key(nc, nr))) continue;
          dist.set(key(nc, nr), d + 1);
          queue.push([nc, nr]);
        }
      }
      return seen;
    };
    /** Total open cells in the four cardinal lines of sight -- how far you can be shot from. */
    const openRun = (cell: [number, number]): number => {
      let total = 0;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let c = cell[0] + dc, r = cell[1] + dr;
        while (!blocked(c, r)) { total++; c += dc; r += dr; }
      }
      return total;
    };
    const cells = spawnCells();
    const axis = cells.find(([c]) => c === AXIS) as [number, number];
    const base = cells.filter(([c]) => c !== AXIS);
    expect(base).toHaveLength(2);
    // The two mirrored spawns must measure IDENTICALLY -- if they ever differ, the mirror
    // above is not doing the work this test credits it with.
    expect(reach(base[0], 8)).toBe(reach(base[1], 8));
    expect(openRun(base[0])).toBe(openRun(base[1]));
    // ...and the axis spawn sits within a small, stated distance of them.
    expect(Math.abs(reach(axis, 8) - reach(base[0], 8)), 'reachable area within 8 steps').toBeLessThanOrEqual(4);
    expect(Math.abs(reach(axis, 4) - reach(base[0], 4)), 'reachable area within 4 steps').toBeLessThanOrEqual(3);
    expect(Math.abs(openRun(axis) - openRun(base[0])), 'total open sightline run').toBeLessThanOrEqual(2);
    // Measured values behind the bounds, so a reader can see what the slack really is:
    // axis 14/40/4 and each base 15/38/5 for (r4, r8, openRun).
    expect(openRun(axis)).toBeLessThan(13); // the open-lane regression this replaced
  });
});
