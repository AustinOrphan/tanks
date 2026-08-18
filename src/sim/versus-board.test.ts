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

// ---------------------------------------------------------------------------
// SHIPPED-ARENA SWEEP. Denominator for every claim in this block: 5 shipped arenas x
// 3 versus player counts (2, 3, 4) = 15 (arena, N) verdicts, 10 spawn pairs per arena
// (C(2,2) + C(3,2) + C(4,2) = 1 + 3 + 6), 50 pairs total. Pinned as its own assertion
// so a 6th arena moves this test rather than silently shrinking the sweep --
// versus-spawns.test.ts's own `ARENAS.length` pin is the precedent.
// ---------------------------------------------------------------------------

describe('evaluateVersusBoard: the shipped-arena sweep', () => {
  it('ARENA_DEFS holds exactly 5 shipped arenas -- the population every sweep below claims', () => {
    expect(ARENA_DEFS.length).toBe(5);
  });

  it('every shipped arena is suitable at every N in {2, 3, 4}: 15 of 15 (arena, N) combinations', () => {
    // Re-derived live, not snapshotted: this recomputes open-floor counts and
    // reruns the real loadArena placement/LOS checks on every shipped grid.
    let checked = 0;
    for (const arena of ARENA_DEFS) {
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
    expect(checked).toBe(15);
  });

  // NONE OF THE THREE CRITERIA CURRENTLY DISCRIMINATES ON SHIPPED DATA -- stated
  // plainly rather than left to be inferred from the all-true sweep above. Every
  // shipped arena is 33x27 or 45x33, authored for a single campaign player plus
  // arranged enemies, not for tightness at 2-4 versus starts; none of them was ever
  // close to failing any of these bounds. The three synthetic-fixture describe blocks
  // below prove each criterion CAN fail (and, for concealment and room, that it is
  // wired into `suitable` -- see the mutation table in
  // docs/superpowers/plans/2026-08-17-versus-board-rules.md), which is what makes this
  // sweep evidence that shipped boards are roomy rather than evidence the rule is
  // decorative.
  it('the room ratio clears MIN_OPEN_FLOOR_PER_PLAYER by a wide, stated margin on every shipped combination -- the tightest is arena-02 at N=4', () => {
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
    expect(tightestLabel).toBe('arena-02 @ N=4');
    expect(tightest).toBeCloseTo(185.5, 5);
    expect(tightest).toBeGreaterThan(MIN_OPEN_FLOOR_PER_PLAYER * 10);
  });

  it('0 of 50 spawn pairs share mutual line of sight, across the full sweep', () => {
    let totalPairs = 0;
    let concealedPairs = 0;
    for (const arena of ARENA_DEFS) {
      for (const n of [2, 3, 4] as const) {
        const verdict = evaluateVersusBoard(arena, n);
        totalPairs += verdict.totalPairs;
        concealedPairs += verdict.concealedPairs;
      }
    }
    expect(totalPairs).toBe(50);
    expect(concealedPairs).toBe(50);
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
  const arena: Arena = {
    cols: 7, rows: 7, cellSize: 1,
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
  it('produces one row per (arena, N), labelled with the arena id, over the default 5 arenas x {2,3,4}', () => {
    const rows = versusBoardCatalog();
    expect(rows.length).toBe(15);
    const labels = rows.map((r) => `${r.arenaId}@${r.playerCount}`);
    expect(new Set(labels).size).toBe(15); // every row is a distinct (arena, N) pair
    expect(rows.every((r) => r.suitable)).toBe(true);
  });

  it('accepts an explicit arena/count list, for synthetic fixtures', () => {
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
    expect(rows.map((r) => `${r.arenaId}@${r.playerCount}`)).toEqual(['fixture@2', 'fixture@4']);
    expect(rows[0].suitable).toBe(true); // N=2: room passes (19.5)
    expect(rows[1].suitable).toBe(false); // N=4: room fails (9.75)
  });
});
