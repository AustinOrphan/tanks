import { describe, it, expect } from 'vitest';
import {
  evaluateVersusBoard,
  versusBoardCatalog,
  MIN_OPEN_FLOOR_PER_PLAYER,
  type VersusBoardVerdict,
} from './versus-board';
import { ARENA_DEFS, loadArena } from './arena';
import { lineOfSight } from './ai/targeting';
import type { Arena } from './arena';
import type { WallKind } from './types';
import { VERSUS_CATALOG } from './config/versus-catalog';

// ---------------------------------------------------------------------------
// SHIPPED-ARENA SWEEP. Denominator for every claim in this block: 7 shipped arenas x
// 3 versus player counts (2, 3, 4) = 21 (arena, N) verdicts, 10 spawn pairs per arena
// (C(2,2) + C(3,2) + C(4,2) = 1 + 3 + 6), 50 pairs total. Pinned as its own assertion
// so a 6th arena moves this test rather than silently shrinking the sweep --
// versus-spawns.test.ts's own `ARENAS.length` pin is the precedent.
// ---------------------------------------------------------------------------

describe('evaluateVersusBoard: the shipped-arena sweep', () => {
  it('ARENA_DEFS holds exactly 8 shipped arenas -- the population every sweep below claims', () => {
    expect(ARENA_DEFS.length).toBe(8);
  });

  // Every board is MEASURED at every N here; what a board is OFFERED at is a separate,
  // curated question the catalog answers (vs-duel-01 declares [2] only). Suitability is
  // the floor, not the offer.
  it('every arena still offered is suitable at every N in {2, 3, 4}: 18 of 24 (arena, N) combinations', () => {
    // Re-derived live, not snapshotted: this recomputes open-floor counts and
    // reruns the real loadArena placement/LOS checks on every shipped grid.
    //
    // 18 of 24, not 24 of 24, and the shrinkage is in two deliberate steps.
    //
    // vs-quad-01 remains in ARENA_DEFS -- its grid is what #425 will edit -- but is
    // WITHDRAWN from the catalog and fails the tank-egress gate at all three counts. That
    // is asserted directly below rather than skipped: the sweep would be dishonest if it
    // quietly dropped the board this suite failed to catch.
    //
    // vs-tri-01 was in that same exclusion and has REJOINED the sweep, which is the whole
    // evidence that issue #424 fixed it: it is held to `suitable === true` at all three
    // counts here, not merely at the one it is offered at. 15 -> 18.
    //
    // vs-duel-01 is also excluded here, at N=3 and N=4 ONLY. The egress gate finds it
    // unsuitable at those counts -- a third and fourth maximin spawn land in pockets too
    // small to mine out of -- and it is offered at neither, so this is the gate reporting
    // something true about counts the board never promised. The offered-combination sweep
    // further down is the one that covers what actually ships.
    const WITHDRAWN = new Set(['vs-quad-01', 'vs-duel-01']);
    let checked = 0;
    for (const arena of ARENA_DEFS) {
      if (WITHDRAWN.has(arena.id)) continue;
      for (const n of [2, 3, 4] as const) {
        checked++;
        const verdict = evaluateVersusBoard(arena, n);
        expect(verdict.suitable, `${arena.id} @ N=${n}`).toBe(true);
        expect(verdict.distinctSpawns, `${arena.id} @ N=${n} distinctSpawns`).toBe(true);
        expect(verdict.spawnCount, `${arena.id} @ N=${n} spawnCount`).toBe(n);
        expect(verdict.allPairsConcealed, `${arena.id} @ N=${n} allPairsConcealed`).toBe(true);
        expect(verdict.concealedPairs, `${arena.id} @ N=${n} concealedPairs`).toBe(verdict.totalPairs);
        expect(verdict.roomOk, `${arena.id} @ N=${n} roomOk`).toBe(true);
      }
    }
    expect(checked).toBe(18);

    // ...and the withdrawn board fails, on egress specifically. This is the assertion
    // that would have blocked it (#423), stated as a fact about the shipped grid rather
    // than left implicit in its absence above.
    for (const id of ['vs-quad-01']) {
      const arena = ARENA_DEFS.find((a) => a.id === id) as Arena;
      for (const n of [2, 3, 4] as const) {
        const verdict = evaluateVersusBoard(arena, n);
        expect(verdict.egressOk, `${id} @ N=${n} must still fail egress`).toBe(false);
        expect(verdict.suitable, `${id} @ N=${n}`).toBe(false);
      }
    }
    // ...and vs-duel-01 passes at the ONE count it is offered at.
    const duel = ARENA_DEFS.find((a) => a.id === 'vs-duel-01') as Arena;
    expect(evaluateVersusBoard(duel, 2).suitable, 'vs-duel-01 @ N=2 is offered and must hold').toBe(true);
  });

  // NONE OF THE THREE CRITERIA CURRENTLY DISCRIMINATES ON SHIPPED DATA -- stated
  // plainly rather than left to be inferred from the all-true sweep above. Five of the
  // six shipped arenas are 33x27 or 45x33, authored for a single campaign player plus
  // arranged enemies, not for tightness at 2-4 versus starts; none of them was ever
  // close to failing any of these bounds. Issue #271's vs-duel-01 is the first board
  // authored FOR versus and the first to move this margin -- at 27x21 it is the
  // smallest shipped, and it more than halves the headroom (10x MIN down to 6x) while
  // still not coming close to failing. The criterion remains non-discriminating on
  // shipped data; it is just no longer non-discriminating by an order of magnitude. The three synthetic-fixture describe blocks
  // below prove each criterion CAN fail (and, for concealment and room, that it is
  // wired into `suitable` -- see the mutation table in
  // docs/superpowers/plans/2026-08-17-versus-board-rules.md), which is what makes this
  // sweep evidence that shipped boards are roomy rather than evidence the rule is
  // decorative.
  it('the room ratio clears MIN_OPEN_FLOOR_PER_PLAYER by a wide, stated margin on every shipped combination -- the tightest is vs-tri-01 at N=4', () => {
    let tightest = Infinity;
    let tightestLabel = '';
    for (const arena of ARENA_DEFS) {
      for (const n of [2, 3, 4] as const) {
        const verdict = evaluateVersusBoard(arena, n);
        if (verdict.openFloorPerPlayer < tightest) {
          tightest = verdict.openFloorPerPlayer;
          tightestLabel = `${arena.id} @ N=${n}`;
        }
      }
    }
    // vs-tri-01 takes this BACK from vs-quad-01 (74.0), which took it from vs-tri-01's
    // first version, which took it from vs-duel-01, which took it from arena-02 (185.5).
    // The progression is the point: each board authored FOR versus is smaller and more
    // furnished than the campaign boards it joins, so the tightest ratio keeps falling.
    // 27x17 with 149 solid cells, 19 destructible and the two authored spawn letters
    // leaves 289 open floor; at N=4 that is 72.25.
    //
    // AND THAT IS THE HEADLINE, not the label change. The previous revision of this
    // comment said 74.0 "clears the 4x bound (72) by 2 cells of open floor ... and is
    // also the last one that multiplier will absorb", and asked the next dedicated board
    // to check the figure BEFORE it was authored. Issue #424's rework of vs-tri-01 checked
    // it, and the answer is that the warning was right: at 72.25 the bound below has
    // 0.25 cells of open floor left. The board is not cramped -- it is four times the
    // stated minimum -- but this constant can no longer absorb another furnished 27x17
    // board, and #418's re-derivation is now a prerequisite for the next one rather than
    // an improvement someone might get to.
    expect(tightestLabel).toBe('vs-tri-01 @ N=4');
    expect(tightest).toBeCloseTo(72.25, 5);
    // 4x, down from 6x, itself down from the 10x that held when every board was
    // campaign-sized. LOWERED ON MEASUREMENT each time, and stated here rather than left
    // implicit: at 85.5 the previous 6x bound (108) would fail. The gate still discriminates
    // -- versus-board.test.ts's small-pillar-room fixture fails roomOk outright -- but the
    // headroom is now 0.25 cells of open floor (72.25 against a bound of 72), so this
    // assertion is one furnished board away from failing and #418 is where that is settled.
    expect(tightest).toBeGreaterThan(MIN_OPEN_FLOOR_PER_PLAYER * 4);
  });

  it('0 of 80 spawn pairs share mutual line of sight, across the full sweep', () => {
    let totalPairs = 0;
    let concealedPairs = 0;
    for (const arena of ARENA_DEFS) {
      for (const n of [2, 3, 4] as const) {
        const verdict = evaluateVersusBoard(arena, n);
        totalPairs += verdict.totalPairs;
        concealedPairs += verdict.concealedPairs;
      }
    }
    expect(totalPairs).toBe(80);
    expect(concealedPairs).toBe(80);
  });
});

describe('evaluateVersusBoard: determinism', () => {
  it('is stable across repeated calls with the same inputs -- no hidden randomness', () => {
    const arena = ARENA_DEFS[0];
    const a = evaluateVersusBoard(arena, 4);
    const b = evaluateVersusBoard(arena, 4);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// SYNTHETIC NEGATIVE CONTROLS. Each fixture below is a hand-built `Arena` (not
// validated through config/validate.ts -- the same "plain object literal matching the
// Arena shape" idiom arena.test.ts's own fixtures already use), chosen and MEASURED
// (via a scratch probe against real loadArena output, not hand-derived) to isolate one
// criterion at a time: two of the three pass cleanly while the third fails, so a
// mutation dropping that criterion from `suitable` is caught by exactly this fixture
// and not accidentally caught by a different one co-firing.
// ---------------------------------------------------------------------------

describe('evaluateVersusBoard: separation can fail (and takes room down with it)', () => {
  // A single open (well, spawn-letter) cell and nothing else: no `.` candidate exists
  // anywhere, so pickVersusSpawnCell's own zero-candidate fallback (see its doc
  // comment) co-locates every requested co-player at P1's own cell.
  const arena: Arena = {
    cols: 5, rows: 1, cellSize: 1,
    legend: { x: 'solid' as WallKind },
    grid: ['Pxxxx'],
  };

  it('measured: all N requested players collapse onto 1 distinct cell, at every N in {2, 3, 4}', () => {
    for (const n of [2, 3, 4] as const) {
      const verdict = evaluateVersusBoard(arena, n);
      expect(verdict.spawnCount, `N=${n}`).toBe(1);
      expect(verdict.distinctSpawns, `N=${n}`).toBe(false);
      expect(verdict.suitable, `N=${n}`).toBe(false);
    }
  });

  // Disclosed, not hidden: on THIS fixture (and, per evaluateVersusBoard's own doc
  // comment, on any fixture these two formulas can construct) room fails right
  // alongside separation -- zero open-floor cells is nowhere near
  // MIN_OPEN_FLOOR_PER_PLAYER at any player count. This is why the manifest mutates
  // `distinctSpawns`'s own computation directly rather than claiming a "drop it from
  // suitable" mutation is killed: that one is equivalent, and asserting it as caught
  // would be exactly the tautology-that-cannot-fail CLAUDE.md's testing conventions
  // warn about.
  it('room also measures failing on this fixture -- open floor is 0', () => {
    const verdict = evaluateVersusBoard(arena, 2);
    expect(verdict.openFloorCells).toBe(0);
    expect(verdict.roomOk).toBe(false);
  });
});

describe('evaluateVersusBoard: mutual concealment can fail, isolated from the other two', () => {
  // A 10x10 open room, no interior walls at all: nothing to hide behind, so every
  // spawn pair keeps mutual line of sight regardless of how far apart the greedy
  // maximin manages to push them. 99 open-floor cells comfortably clears
  // MIN_OPEN_FLOOR_PER_PLAYER at every N in {2, 3, 4} (99/4 = 24.75), and the maximin
  // ranking still picks 4 distinct farthest-apart cells even with no LOS-clean option
  // (the same "falls through to plain maximin" degradation versus-spawns.test.ts's own
  // open-room negative control exercises) -- so this isolates concealment cleanly.
  const grid: string[] = [];
  for (let r = 0; r < 10; r++) grid.push(r === 0 ? 'P.........' : '..........');
  const arena: Arena = { cols: 10, rows: 10, cellSize: 1, legend: {}, grid };

  it('measured: separation and room hold, concealment does not, at every N in {2, 3, 4}', () => {
    for (const n of [2, 3, 4] as const) {
      const verdict = evaluateVersusBoard(arena, n);
      expect(verdict.distinctSpawns, `N=${n}`).toBe(true);
      expect(verdict.roomOk, `N=${n}`).toBe(true);
      expect(verdict.concealedPairs, `N=${n}`).toBe(0);
      expect(verdict.allPairsConcealed, `N=${n}`).toBe(false);
      expect(verdict.suitable, `N=${n}`).toBe(false);
    }
  });

  it('and the premise really holds: every pair really is mutually visible, not just unmeasured', () => {
    const { tanks, walls } = loadArena(arena, 4, 'ffa');
    const players = tanks.filter((t) => t.kind === 'player');
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        expect(lineOfSight(players[i].pos, players[j].pos, walls), `pair (${i}, ${j})`).toBe(true);
      }
    }
  });
});

describe('evaluateVersusBoard: room can fail, isolated from the other two', () => {
  // A 7x7 room split by a 3x3 grid of single-cell pillars (rows 1/3/5, cols 1/3/5):
  // every pillar breaks a straight line without sealing off any region, so separation
  // and concealment hold at every N while total open floor (39 cells: 49 minus 9
  // pillars minus the P1 letter cell) is small enough that the per-player ratio drops
  // below MIN_OPEN_FLOOR_PER_PLAYER once N reaches 3.
  // cellSize 2, not 1 (changed with issue #225): at cellSize 1 the hull-clearance
  // filter leaves only the four room-centre cells eligible, and those see each other
  // down the open lanes -- concealment stops holding and the fixture no longer
  // isolates room. At cellSize 2 every open centre clears walls by >= 1.0 and
  // distinct centres sit >= 2.0 apart, so the filter passes everything and the
  // original premise (room is the ONLY failing criterion) is restored; the room
  // ratios themselves count CELLS, so they are cellSize-independent.
  const arena: Arena = {
    cols: 7, rows: 7, cellSize: 2,
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

  it('measured: 39 open-floor cells; room passes at N=2 (19.5) and fails at N=3 (13) and N=4 (9.75), separation and concealment hold throughout', () => {
    const results: Record<number, VersusBoardVerdict> = {};
    for (const n of [2, 3, 4] as const) results[n] = evaluateVersusBoard(arena, n);

    expect(results[2].openFloorCells).toBe(39);
    expect(results[2].openFloorPerPlayer).toBeCloseTo(19.5, 5);
    expect(results[3].openFloorPerPlayer).toBeCloseTo(13, 5);
    expect(results[4].openFloorPerPlayer).toBeCloseTo(9.75, 5);

    for (const n of [2, 3, 4] as const) {
      expect(results[n].distinctSpawns, `N=${n}`).toBe(true);
      expect(results[n].allPairsConcealed, `N=${n}`).toBe(true);
    }
    expect(results[2].roomOk).toBe(true);
    expect(results[2].suitable).toBe(true);
    expect(results[3].roomOk).toBe(false);
    expect(results[3].suitable).toBe(false);
    expect(results[4].roomOk).toBe(false);
    expect(results[4].suitable).toBe(false);
  });
});

describe('versusBoardCatalog', () => {
  it('produces one row per (arena, N), labelled with the arena id, over the default 8 arenas x {2,3,4}', () => {
    const rows = versusBoardCatalog();
    expect(rows.length).toBe(24);
    const labels = rows.map((r) => `${r.arenaId}@${r.playerCount}`);
    expect(new Set(labels).size).toBe(24); // every row is a distinct (arena, N) pair
    // 19 of 24 suitable, not all: this function sweeps ARENA_DEFS at every N, not the
    // offer, so it still REPORTS the withdrawn board (3 failing combinations) and
    // vs-duel-01 at the two counts it is not offered at (2 more). Naming them here is
    // what keeps "report, don't gatekeep" honest. It was 16 while vs-tri-01 failed all
    // three counts too; issue #424's rebuild moved exactly those three rows and nothing
    // else, which is why the set below is the old one minus its three entries.
    expect(rows.filter((r) => r.suitable).length).toBe(19);
    const unsuitable = rows.filter((r) => !r.suitable).map((r) => `${r.arenaId}@${r.playerCount}`);
    expect(new Set(unsuitable)).toEqual(new Set([
      'vs-quad-01@2', 'vs-quad-01@3', 'vs-quad-01@4',
      'vs-duel-01@3', 'vs-duel-01@4',
    ]));
  });

  it('accepts an explicit arena/count list, for synthetic fixtures', () => {
    // cellSize 2, not 1, for the same reason the room fixture above already uses it: at
    // cellSize 1 a one-cell gap between the pillars is EXACTLY the tank's 1.0 diameter,
    // so the legal centre set is a zero-width line and the egress gate (issue #423)
    // rightly refuses it. The room ratios count CELLS and are cellSize-independent, so
    // the 19.5 / 9.75 arithmetic this test is actually about is unchanged.
    const arena: Arena & { id: string } = {
      id: 'fixture', cols: 7, rows: 7, cellSize: 2,
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
    expect(rows.map((r) => `${r.arenaId}@${r.playerCount}`)).toEqual(['fixture@2', 'fixture@4']);
    expect(rows[0].suitable).toBe(true); // N=2: room passes (19.5)
    expect(rows[1].suitable).toBe(false); // N=4: room fails (9.75)
  });
});

describe("versus-board: the 'ffa' hardcode rests on teams placing identically", () => {
  // evaluateVersusBoard calls loadArena(..., 'ffa') for BOTH versus modes, justified by
  // the claim that 'teams' differs only in stamping `tank.team` -- which this module
  // never reads. That claim was argued from reading the code; this measures it, because
  // it is load-bearing: if placement ever diverged, versusBoardCatalog would silently
  // report FFA's verdict for a teams match.
  //
  // Fails if PASS 1b ever branches on 'teams' for anything positional -- a co-player
  // placed by team, a team-aware avoid set, a different ring order. Deliberately compares
  // POSITIONS rather than whole tanks: `team` is expected to differ, and asserting whole
  // tanks equal would fail for the one reason that is not a defect.
  const COUNTS = [2, 3, 4] as const;

  it('places every player at identical positions in ffa and teams, on all 8 shipped arenas', () => {
    let compared = 0;
    for (const arena of ARENA_DEFS) {
      for (const n of COUNTS) {
        const ffa = loadArena(arena, n, 'ffa').tanks.filter((t) => t.kind === 'player');
        const teams = loadArena(arena, n, 'teams').tanks.filter((t) => t.kind === 'player');
        expect(teams.length, `${arena.id} N=${n} player count`).toBe(ffa.length);
        for (let i = 0; i < ffa.length; i++) {
          expect(
            { x: teams[i].pos.x, y: teams[i].pos.y },
            `${arena.id} N=${n} slot ${i}`,
          ).toEqual({ x: ffa[i].pos.x, y: ffa[i].pos.y });
          compared++;
        }
      }
    }
    // Denominator, so a change that stops loading players cannot read as a pass:
    // 8 arenas x (2 + 3 + 4) players = 72 position comparisons.
    expect(compared).toBe(72);
  });

  it('still stamps team ONLY in teams mode -- the one difference that is expected', () => {
    // The negative control. Without it, the test above would also pass if `teams` mode
    // stopped stamping teams altogether, which would make the modes identical in the
    // wrong direction and break friendly fire and the win rule.
    const ffa = loadArena(ARENA_DEFS[0], 4, 'ffa').tanks.filter((t) => t.kind === 'player');
    const teams = loadArena(ARENA_DEFS[0], 4, 'teams').tanks.filter((t) => t.kind === 'player');
    expect(ffa.every((t) => t.team === undefined)).toBe(true);
    expect(teams.every((t) => t.team !== undefined)).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// TANK-SIZED SPAWN EGRESS (issue #423).
//
// Every other criterion in this module counts CELLS. A cell is not a tank: with
// cellSize 0.6667 and TANK_RADIUS 0.5 a tank is 1.5 cells across, so a one-cell gap is
// "walkable" to a cell-based check and has no legal tank-centre position at all.
// Keystone and Quarters passed clearance, connectivity, symmetry, path distance and
// scripted playtests and were unplayable in human hands: players could not leave spawn.
// ---------------------------------------------------------------------------
describe('spawn egress: a tank, not a cell (issue #423)', () => {
  const cellSize = 2 / 3; // the dedicated boards' own cellSize

  /**
   * Two rooms separated by a solid divider with a doorway `gapCells` COLUMNS wide.
   * Only one authored letter: versus spawns are derived by `pickVersusSpawnCell`, not
   * read from the grid, and maximin puts the two picks in opposite rooms.
   */
  const twoRooms = (gapCells: number): Arena => {
    const width = 13;
    const doorStart = Math.floor((width - gapCells) / 2);
    const divider = Array.from({ length: width }, (_, c) =>
      (c >= doorStart && c < doorStart + gapCells ? '.' : 'x')).join('');
    const grid: string[] = [
      'P'.padEnd(width, '.'),
      '.'.repeat(width),
      '.'.repeat(width),
      divider,
      '.'.repeat(width),
      '.'.repeat(width),
      '.'.repeat(width),
    ];
    return { cols: width, rows: grid.length, cellSize, legend: { x: 'solid' as WallKind }, grid };
  };

  it('a ONE-cell passage is impassable and a TWO-cell passage is not -- the minimum width, measured', () => {
    // The load-bearing discrimination. A 1-cell gap is 0.667 wide against a 1.0-wide
    // tank, so no legal centre position exists; 2 cells is 1.333 and leaves a 0.333 band.
    // Cell connectivity cannot tell these apart -- both are "open" -- which is exactly
    // the class of failure that shipped.
    const narrow = evaluateVersusBoard(twoRooms(1), 2);
    const wide = evaluateVersusBoard(twoRooms(2), 2);
    expect(narrow.egressOk, 'a 1-cell passage must NOT count as egress').toBe(false);
    expect(narrow.spawnsInLargestRegion).toBe(1);
    expect(wide.egressOk, 'a 2-cell passage must count as egress').toBe(true);
    expect(wide.spawnsInLargestRegion).toBe(2);
  });

  it('names the blocked slots and the region sizes, so a failure is actionable', () => {
    // Acceptance criterion: failure output identifies the arena, count and spawn slot.
    const narrow = evaluateVersusBoard(twoRooms(1), 2);
    expect(narrow.egressDiagnosis).toContain('disjoint spawn region');
    expect(narrow.egressDiagnosis).toMatch(/P1/);
    expect(narrow.egressDiagnosis).toMatch(/P2/);
    // ...and says nothing when it holds, so the field is not noise.
    expect(evaluateVersusBoard(twoRooms(2), 2).egressDiagnosis).toBe('');
  });

  it('folds into `suitable`, which is what makes it a gate rather than a report', () => {
    // The negative control for the gate itself: the narrow board is otherwise fine --
    // distinct spawns, concealed, roomy -- and must still be refused.
    const narrow = evaluateVersusBoard(twoRooms(1), 2);
    expect(narrow.distinctSpawns, 'the fixture must fail ONLY on egress').toBe(true);
    expect(narrow.allPairsConcealed).toBe(true);
    expect(narrow.roomOk).toBe(true);
    expect(narrow.suitable).toBe(false);
  });

  it('every board the catalog OFFERS clears it, at every count it is offered at', () => {
    // The sweep that would have caught Keystone and Quarters before they shipped.
    let checked = 0;
    for (const entry of VERSUS_CATALOG) {
      const arena = ARENA_DEFS.find((a) => a.id === entry.arenaId);
      expect(arena, entry.arenaId).toBeDefined();
      for (const n of entry.players) {
        const verdict = evaluateVersusBoard(arena as Arena, n);
        expect(verdict.egressOk, `${entry.id} @ N=${n}: ${verdict.egressDiagnosis}`).toBe(true);
        checked += 1;
      }
    }
    // 17 = five campaign boards x 3 counts, plus vs-duel-01 and vs-tri-01 at their single
    // counts. Withdrawing vs-tri-01 and vs-quad-01 (#424/#425) took this from 18 to 16;
    // #424's rebuild returns vs-tri-01's one combination, so 17. vs-quad-01's is still
    // out, pending #425.
    expect(checked, 'the offered (entry, N) population this sweep covers').toBe(17);
  });

  it('a destructible seal is fine when the pocket is big enough to survive blowing it', () => {
    // arena-02 at N=2 IS split into two regions by destructibles -- both spawns are
    // sealed -- and it stays suitable, because each pocket is roughly 21.6 across against
    // a 2.5 mine kill radius. Blowing through to reach an opponent is the design on a
    // board carrying 72 destructible blocks.
    const a02 = evaluateVersusBoard(ARENA_DEFS.find((a) => a.id === 'arena-02') as Arena, 2);
    expect(a02.sealedSpawns, 'arena-02 at N=2 really is sealed at both spawns').toBe(2);
    expect(a02.fatalEscapes, 'but both pockets are far larger than the blast').toBe(0);
    expect(a02.egressOk).toBe(true);
  });

  it('a destructible seal is FATAL when the pocket is smaller than the mine blast', () => {
    // The failure mode the geometry checks could not see. Only a MINE clears a
    // destructible (`destructibleByBlast`, mines.ts -- shells treat every intact wall
    // alike), and a mine kills within MINE_BLAST_RADIUS + TANK_RADIUS = 2.5, so a spawn
    // sealed in a pocket narrower than that pays a LIFE to leave the start line.
    //
    // THE SUBJECT MOVED, and deliberately, because the old one was fixed. This test used
    // to run on vs-tri-01 at N=3, whose pockets measured 1.18 to 1.72 across -- but issue
    // #424 rebuilt that board and it now reports fatalEscapes 0. Deleting the test would
    // have retired the only coverage of the `fatalEscapes` branch; re-pointing it at
    // vs-duel-01 keeps that branch pinned against SHIPPED data rather than a fixture.
    //
    // vs-duel-01 is the STRICTER demonstration of the two, and that is why it was chosen
    // over a synthetic grid. Keystone used to fail BOTH halves of the gate at once
    // (spawnsInLargestRegion 2 of 3), so it could not distinguish them. Here
    // spawnsInLargestRegion EQUALS the player count -- the solid-connectivity half passes
    // completely -- and the board is still refused, by the fatal-escape half alone. That
    // is the only configuration in which this branch is the sole cause of a verdict.
    const duel3 = evaluateVersusBoard(ARENA_DEFS.find((a) => a.id === 'vs-duel-01') as Arena, 3);
    expect(duel3.spawnsInLargestRegion, 'solid connectivity is satisfied: every spawn is in one region').toBe(3);
    expect(duel3.sealedSpawns).toBe(1);
    expect(duel3.fatalEscapes, 'the third maximin spawn is sealed in a 2.24-wide pocket').toBe(1);
    expect(duel3.egressOk, 'so the board is refused on the fatal half ALONE').toBe(false);
    expect(duel3.egressDiagnosis).toContain('escaping costs a life');
    expect(duel3.egressDiagnosis).not.toContain('disjoint spawn region');

    // ...and a fourth player seals a second pocket, so the count tracks the spawns rather
    // than being a board-level boolean wearing a number.
    const duel4 = evaluateVersusBoard(ARENA_DEFS.find((a) => a.id === 'vs-duel-01') as Arena, 4);
    expect(duel4.spawnsInLargestRegion).toBe(4);
    expect(duel4.fatalEscapes).toBe(2);
    expect(duel4.egressOk).toBe(false);

    // The board this test used to run on now passes the same gate, at the count it is
    // offered at -- stated here, next to the branch it stopped exercising, so the move
    // above cannot read as coverage quietly going missing.
    const tri = evaluateVersusBoard(ARENA_DEFS.find((a) => a.id === 'vs-tri-01') as Arena, 3);
    expect(tri.fatalEscapes, 'issue #424: Keystone no longer seals any spawn').toBe(0);
    expect(tri.sealedSpawns).toBe(0);
    expect(tri.egressOk).toBe(true);

    // Quarters fails for the OTHER reason, and the two must not be conflated: its pockets
    // are 3.81 across -- big enough to mine safely -- but the seal is SOLID, so no mine
    // helps at all. fatalEscapes is 0 and it is still refused.
    const quad = evaluateVersusBoard(ARENA_DEFS.find((a) => a.id === 'vs-quad-01') as Arena, 4);
    expect(quad.fatalEscapes, 'Quarters pockets are roomy; the wall is just solid').toBe(0);
    expect(quad.egressOk).toBe(false);
    expect(quad.egressDiagnosis).toContain('disjoint spawn region');
  });
});
