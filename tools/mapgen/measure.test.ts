import { describe, it, expect } from 'vitest';
import type { Arena } from '../../src/sim/arena';
import { ARENA_DEFS, loadArena } from '../../src/sim/arena';
import { evaluateVersusBoard } from '../../src/sim/versus-board';
import { measureBoard, tankLattice, geodesic, nearestLegal } from './measure';

/**
 * NEGATIVE CONTROLS for the quality measures.
 *
 * Every measure here is a number with no natural scale, and a number with no scale is
 * exactly the kind of thing that can be computed wrongly for a whole session without anyone
 * noticing -- this file exists because that already happened twice while it was being
 * written. The first draft plugged a disc at each route's midpoint and reported every
 * vs-tri-01 spawn pair as CUT on a board that is visibly an open lattice of lanes; the
 * second blocked the BFS source along with the route it had just walked, so `routeCount`
 * read exactly 1.00 on all 24 shipped (board, N) combinations -- a dead knob that looked
 * like a finding.
 *
 * So each test below builds a board where the answer is known by construction and asserts
 * the measure moves the way the construction forces. A measure with no test here is a
 * measure nobody has checked.
 */

const CELL = 2 / 3;

/** A board from a picture: rows of characters, `#` solid, `x` destructible, letters spawns. */
function board(rows: string[]): Arena {
  return {
    cols: rows[0].length,
    rows: rows.length,
    cellSize: CELL,
    legend: { '#': 'solid', x: 'destructible' },
    grid: rows,
  };
}

/** An open rectangle with two spawns in opposite corners and nothing else. */
function openBoard(cols: number, rows: number): Arena {
  const grid: string[] = [];
  for (let r = 0; r < rows; r++) {
    let row = '';
    for (let c = 0; c < cols; c++) {
      row += r === 1 && c === 1 ? 'P' : r === rows - 2 && c === cols - 2 ? 'B' : '.';
    }
    grid.push(row);
  }
  return board(grid);
}

/** The same rectangle cut in half by a solid wall with one 3-cell doorway. */
function oneDoorBoard(cols: number, rows: number): Arena {
  const mid = Math.floor(rows / 2);
  const door = Math.floor(cols / 2);
  const open = openBoard(cols, rows);
  const grid = open.grid.map((row, r) => {
    if (r !== mid) return row;
    return [...row].map((_, c) => (c >= door - 1 && c <= door + 1 ? '.' : '#')).join('');
  });
  return { ...open, grid };
}

describe('mapgen quality measures: the open board is the floor of every measure', () => {
  const open = measureBoard(openBoard(33, 27), 2, 'control-open');

  it('sees everything from everywhere when there is nothing in the way', () => {
    // Every sample point has direct line of sight to every other, so there is no pair a
    // bounce could add. This is the control that proves `bankGain` is measuring occlusion
    // and not counting rays: a fan of 720 shells is fired from every point here too.
    expect(open.openSightFraction).toBe(1);
    expect(open.bankGain).toBe(0);
    expect(open.bankOnlyFraction).toBe(0);
  });

  it('is all open ground and no corridor', () => {
    expect(open.corridorAreaFraction).toBe(0);
    // NOT 1.0, and the gap is the board's own rim: the probe reaches 1.5 tank diameters, so
    // every point within 1.5 units of the frame loses the directions pointing at it. On
    // 22x18 that rim is about a third of the legal area. The measured figure is 0.676; the
    // bound below is deliberately loose, because the exact value is a function of board size
    // and pinning it would turn a resize into a failure.
    expect(open.openGroundFraction).toBeGreaterThan(0.6);
  });

  it('offers several disjoint routes between its two spawns', () => {
    // Not pinned to ROUTE_CAP. Routes are taken shortest-first and each consumes a full tank
    // diameter of width, so the first, diagonal route across an open board can hem a corner
    // spawn in enough that the greedy stops at 2 where a smarter split would find more. That
    // is the documented weakness of the measure, and pinning the cap here would assert it
    // away. What must hold is the CONTRAST against a board with one doorway.
    expect(open.routeCount).toBeGreaterThanOrEqual(2);
    expect(open.singleRoutePairs).toBe(0);
  });

  it('has no walls to count and is exactly symmetric under rotation', () => {
    expect(open.wallFraction).toBe(0);
    expect(open.coverPieces).toBe(0);
    expect(open.asymmetryRotational).toBe(0);
  });
});

describe('mapgen quality measures: each measure moves when its cause is introduced', () => {
  const open = measureBoard(openBoard(33, 27), 2, 'control-open');

  it('a single doorway drops routeCount to one -- the route measure is wired', () => {
    // THE control for the dead knob this file was written after. One doorway is one route
    // by construction: any second route would have to pass through the same 3-cell gap,
    // which the first route's hull sweep fills.
    const door = measureBoard(oneDoorBoard(33, 27), 2, 'control-one-door');
    expect(door.routeCount).toBe(1);
    expect(door.singleRoutePairs).toBe(1);
    expect(open.routeCount).toBeGreaterThan(door.routeCount);
  });

  it('bottleneckWidth reads the doorway it was given, in cells', () => {
    // The door is 3 cells, so its free width is exactly 3 * (2/3) = 2.0 and nothing wider
    // than that gets between the halves. An open board of the same size has no doorway at
    // all and must report something wider. Both are fixed by construction, which is what
    // makes this a control rather than a snapshot.
    const door = measureBoard(oneDoorBoard(33, 27), 2, 'control-one-door');
    expect(door.bottleneckWidth).toBeCloseTo(2, 6);
    expect(open.bottleneckWidth).toBeGreaterThan(door.bottleneckWidth);

    // Narrow the same door to 2 cells and the measure must step down one rung, to the
    // minimum legal corridor -- 2 * (2/3) = 1.333.
    const narrowed = oneDoorBoard(33, 27);
    const mid = Math.floor(27 / 2);
    const two = {
      ...narrowed,
      grid: narrowed.grid.map((row, r) => (r === mid ? row.slice(0, 15) + '#' + row.slice(16) : row)),
    };
    expect(measureBoard(two, 2, 'control-two-cell-door').bottleneckWidth).toBeCloseTo(4 / 3, 6);
  });

  it('a slit wall blocks tanks and sight but not shells -- the two spaces are distinct', () => {
    // A one-cell wall with a one-cell slit: 0.667 wide, so no tank passes, and `lineOfSight`
    // sees nothing through it either since the slit is a gap between two boxes on the same
    // row. What survives is the geometry of the two halves.
    const rows: string[] = [];
    for (let r = 0; r < 27; r++) {
      if (r === 13) {
        rows.push([...Array(33)].map((_, c) => (c === 16 ? '.' : '#')).join(''));
      } else {
        rows.push([...Array(33)].map((_, c) => (r === 1 && c === 1 ? 'P' : r === 25 && c === 31 ? 'B' : '.')).join(''));
      }
    }
    const slit = board(rows);
    const { walls } = loadArena(slit, 2, 'ffa');
    const lat = tankLattice(slit, walls);
    const top = nearestLegal(lat, { x: 1, y: 1 });
    const bottom = nearestLegal(lat, { x: 21, y: 17 });
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeGreaterThanOrEqual(0);
    // No tank crosses a 0.667 slit: the two halves are separate tank-legal components.
    expect(geodesic(lat, top)[bottom]).toBe(-1);
  });

  it('a pillar field raises the carom offer above the open board', () => {
    // Scattered single-cell pillars block direct fire between many pairs while leaving the
    // faces a shell can bank off. If `bankGain` is measuring anything, it must rise here.
    const rows: string[] = [];
    for (let r = 0; r < 27; r++) {
      let row = '';
      for (let c = 0; c < 33; c++) {
        if (r === 1 && c === 1) row += 'P';
        else if (r === 25 && c === 31) row += 'B';
        else if (r % 4 === 2 && c % 4 === 2) row += '#';
        else row += '.';
      }
      rows.push(row);
    }
    const pillars = measureBoard(board(rows), 2, 'control-pillars');
    expect(pillars.openSightFraction).toBeLessThan(open.openSightFraction);
    expect(pillars.bankGain).toBeGreaterThan(0);
    expect(pillars.coverPieces).toBeGreaterThan(20);
  });

  it('breaking one cell of a symmetric board moves only the symmetry measures', () => {
    const symmetric = openBoard(33, 27);
    const broken = { ...symmetric, grid: symmetric.grid.map((row, r) => (r === 5 ? '#' + row.slice(1) : row)) };
    const a = measureBoard(symmetric, 2, 'control-sym');
    const b = measureBoard(broken, 2, 'control-asym');
    expect(a.asymmetryRotational).toBe(0);
    expect(b.asymmetryRotational).toBeGreaterThan(0);
    expect(b.asymmetryMirrorH).toBeGreaterThan(0);
  });

  it('destructible-only separation reads as mine-gated, never as unreachable', () => {
    // arena-02's own design: the two halves are joined only through destructible walls, and
    // `versus-board.ts` records that this is deliberate rather than a fault. The measure must
    // say so with the right word -- an earlier draft measured mobility through the INTACT
    // board and reported this pair's path length as 0.00, which reads as two spawns on top
    // of each other rather than as a barrier to mine through.
    const m = measureBoard(ARENA_DEFS.find((a) => a.id === 'arena-02')!, 2, 'arena-02');
    expect(m.unreachablePairs).toBe(0);
    expect(m.mineGatedPairs).toBe(1);
    expect(m.pathMin).toBeGreaterThan(0);
  });
});

describe('mapgen quality measures: the duplicated lattice agrees with the shipped one', () => {
  // `measure.ts` carries its own copy of `versus-board.ts`'s private tank-legal lattice. The
  // copy is a liability, so it is pinned: on every shipped board at every versus count, this
  // lattice must reach the same CONNECTIVITY verdict the shipped one reaches.
  //
  // The pin is against `spawnsInLargestRegion`, NOT against `egressOk`. They are not the same
  // question, though `egressOk`'s own doc comment in `versus-board.ts` says it is
  // "`spawnsInLargestRegion === playerCount`": line 341 computes
  // `solidlyConnected && fatalEscapes === 0`, so a board whose spawns are all mutually
  // reachable still fails `egressOk` if one of them is sealed in a pocket too small to
  // survive its own mine. vs-duel-01 at 3 and 4 players is exactly that case
  // (`spawnsInLargestRegion` 3/3 and 4/4, `fatalEscapes` 1 and 2), and pinning the wrong one
  // of the two is what this comment exists to stop the next reader repeating.
  //
  // Population: all 8 shipped boards x counts 2, 3 and 4 = 24 combinations.
  const cases = ARENA_DEFS.flatMap((def) => [2, 3, 4].map((n) => ({ def, n })));

  it.each(cases)('agrees on $def.id at $n players', ({ def, n }) => {
    const mine = measureBoard(def, n, def.id);
    const theirs = evaluateVersusBoard(def, n);
    expect(mine.unreachablePairs).toBe(n * (n - 1) / 2 - mine.spawnPairs);
    expect(mine.unreachablePairs === 0).toBe(theirs.spawnsInLargestRegion === n);
  });
});
