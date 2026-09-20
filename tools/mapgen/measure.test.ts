import { describe, it, expect } from 'vitest';
import type { Arena } from '../../src/sim/arena';
import { ARENA_DEFS, loadArena } from '../../src/sim/arena';
import { evaluateVersusBoard } from '../../src/sim/versus-board';
import { lineOfSight as losImpl } from '../../src/sim/ai/targeting';
import { measureBoard, tankLattice, geodesic, nearestLegal, openingShots, wallAABBs } from './measure';

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

/** Direct line of sight between two world points on a board, through its real walls. */
function lineOfSightBetween(a: { x: number; y: number }, b: { x: number; y: number }, arena: Arena): boolean {
  const { walls } = loadArena(arena, 2, 'ffa');
  return losImpl(a, b, walls);
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

  it('a 6-cell room registers as neither corridor nor open ground -- the blind band', () => {
    // The two fractions do not partition the board. The probe's diagonal rays need 1.5 world
    // units to each side, so open ground cannot register below 3.0 units of legal band, while
    // corridor stops registering above about 2.2. A 6-cell band sits in the gap and scores
    // 0.00 on both, which is worth a control because the pair reads like a split of the legal
    // area and is not one.
    const band = (w: number): Arena => {
      const rows: string[] = [];
      const top = Math.floor((27 - w) / 2);
      for (let r = 0; r < 27; r++) {
        const inBand = r >= top && r < top + w;
        let row = '';
        for (let c = 0; c < 33; c++) row += inBand ? (r === top && c === 1 ? 'P' : '.') : '#';
        rows.push(row);
      }
      return board(rows);
    };

    const three = measureBoard(band(3), 2, 'band-3');
    expect(three.corridorAreaFraction).toBeGreaterThan(0.9);
    expect(three.openGroundFraction).toBe(0);

    const six = measureBoard(band(6), 2, 'band-6');
    expect(six.corridorAreaFraction).toBe(0);
    expect(six.openGroundFraction).toBe(0);
    // It is not that the band is empty -- there is plenty of legal ground in it.
    expect(six.legalAreaFraction).toBeGreaterThan(0.1);

    const seven = measureBoard(band(7), 2, 'band-7');
    expect(seven.openGroundFraction).toBeGreaterThan(0);
  });

  it('detourRatio rises when the walls send you the long way round', () => {
    // Two boards, same size and same spawns. The first is open, so the nearest pair walks
    // roughly the straight line. The second has a full-width wall across the middle with its
    // only gap at one end, so the same pair must walk out to that end and back.
    const open = measureBoard(openBoard(33, 27), 2, 'control-open-detour');

    const rows: string[] = [];
    for (let r = 0; r < 27; r++) {
      if (r === 13) rows.push([...Array(33)].map((_, c) => (c >= 31 ? '.' : '#')).join(''));
      else rows.push([...Array(33)].map((_, c) => (r === 1 && c === 1 ? 'P' : r === 25 && c === 1 ? 'B' : '.')).join(''));
    }
    const detoured = measureBoard(board(rows), 2, 'control-detour');

    expect(detoured.detourRatio).toBeGreaterThan(open.detourRatio);

    // NOT a ratio of 1 on the open board, and the reason is the measure's own: `geodesic` is a
    // 4-NEIGHBOUR BFS, so it walks Manhattan distance and over-reads a diagonal journey by up
    // to sqrt(2). These two spawns are corner to corner, so the open board reads about
    // (20 + 16) / hypot(22, 18) = 1.27 rather than 1.00. That inflation is in every figure the
    // measure reports, including the shipped band, so only the CONTRAST between boards is
    // meaningful -- which is what this control pins.
    expect(open.detourRatio).toBeGreaterThan(1.15);
    expect(open.detourRatio).toBeLessThan(1.35);
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

  it('openingShots sees a bank shot the direct line does not -- the positive control', () => {
    // A short vertical stub between two points, with open floor above it and the board's own
    // top wall behind. The stub blocks the straight line between them; a shell fired up over
    // the stub, off the top wall and back down reaches the far point inside the 9-unit trace.
    //
    // The positions are HANDED to `openingShots` rather than taken from a board, because
    // versus spawn placement is geometric and a caller cannot steer where the second spawn
    // lands. Without this control the spawn-level count is zero everywhere and there is no
    // way to tell a real result from a measure that never fires.
    const rows: string[] = [];
    for (let r = 0; r < 27; r++) {
      let row = '';
      for (let c = 0; c < 33; c++) row += c === 6 && r >= 2 && r <= 6 ? '#' : r === 1 && c === 1 ? 'P' : '.';
      rows.push(row);
    }
    const stub = board(rows);
    const { walls } = loadArena(stub, 2, 'ffa');
    const boxes = wallAABBs(walls);
    const left = { x: 1.667, y: 2.667 };
    const right = { x: 7.0, y: 2.667 };

    // The straight line really is blocked: no direct shot either way.
    expect(lineOfSightBetween(left, right, stub)).toBe(false);

    const shots = openingShots([left, right], boxes);
    expect(shots.ordered).toBe(2);
    expect(shots.direct).toBe(0);
    expect(shots.bankOnly).toBeGreaterThan(0);

    // And with the stub gone, the same pair is a plain direct shot -- so the fan is finding
    // the target rather than reporting a bounce for anything it cannot see.
    const open = board(rows.map((row) => row.replace('#', '.').replace(/#/g, '.')));
    const openBoxes = wallAABBs(loadArena(open, 2, 'ffa').walls);
    const openShots = openingShots([left, right], openBoxes);
    expect(openShots.direct).toBe(2);
    expect(openShots.bankOnly).toBe(0);
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

describe('mapgen quality measures: the dead-end budget (issue #822)', () => {
  /**
   * `deadEndAreaFraction` is "<= 1 of 8 directions clear" off the same probe
   * `corridorAreaFraction` uses at "<= 2". A threshold one bucket narrower is exactly the
   * kind of change that can be wrong in a way every summary number hides, so the controls
   * below are a board where the answer is known by construction and a PAIR that differs
   * only in arrangement.
   */

  /** The same 18 wall cells, twice: as a blind alley, and as bars that enclose nothing. */
  const pocketBoard = (depth: number): Arena => {
    const grid = openBoard(22, 18).grid.map((row) => [...row]);
    for (let r = 3; r <= 3 + depth; r++) { grid[r][9] = '#'; grid[r][12] = '#'; }
    for (let c = 9; c <= 12; c++) grid[3 + depth + 1][c] = '#';
    return board(grid.map((row) => row.join('')));
  };
  const barsBoard = (depth: number): Arena => {
    const grid = openBoard(22, 18).grid.map((row) => [...row]);
    for (let r = 3; r <= 3 + depth; r++) { grid[r][5] = '#'; grid[r][16] = '#'; }
    for (let c = 9; c <= 12; c++) grid[14][c] = '#';
    return board(grid.map((row) => row.join('')));
  };
  const wallCells = (a: Arena) => a.grid.join('').split('').filter((ch) => ch === '#').length;

  it('reads exactly zero on empty rectangles, so the board rim contributes nothing', () => {
    // The rim DOES cost rays -- `openGroundFraction`'s own comment says an empty 22x18
    // measures 0.68 rather than 1.0 for that reason -- and the first draft of this measure's
    // doc comment assumed it would inflate the dead-end count too. It does not: a board
    // corner keeps three clear directions, so it cannot reach "<= 1". Pinned at three sizes
    // because a rim effect would shrink with board area rather than vanish.
    for (const [cols, rows] of [[22, 18], [33, 27], [45, 33]] as const) {
      const m = measureBoard(openBoard(cols, rows), 2, `empty-${cols}x${rows}`);
      expect(m.deadEndAreaFraction, `${cols}x${rows}`).toBe(0);
      expect(m.corridorAreaFraction, `${cols}x${rows}`).toBe(0);
      // ...and this is where the rim actually lands, shrinking with size as a rim must.
      expect(m.degreeProfile[3], `${cols}x${rows} rim`).toBeGreaterThan(0);
    }
    const small = measureBoard(openBoard(22, 18), 2, 'small');
    const large = measureBoard(openBoard(45, 33), 2, 'large');
    expect(large.degreeProfile[3]).toBeLessThan(small.degreeProfile[3]);
  });

  it('separates a pocket from bars of identical wall area, where corridorAreaFraction does not', () => {
    // THE CONTROL THAT MATTERS. Both boards carry the same wall cells on the same 22x18
    // rectangle; only the arrangement differs, so wall area cannot explain any gap.
    const pocket = measureBoard(pocketBoard(6), 2, 'pocket');
    const bars = measureBoard(barsBoard(6), 2, 'bars');
    expect(wallCells(pocketBoard(6))).toBe(wallCells(barsBoard(6)));
    expect(pocket.wallFraction).toBeCloseTo(bars.wallFraction, 10);

    // The enclosing arrangement scores substantially higher.
    expect(pocket.deadEndAreaFraction).toBeGreaterThan(bars.deadEndAreaFraction * 1.5);

    // And the negative control for the whole measure: `corridorAreaFraction` does NOT make
    // this distinction -- it moves the OTHER way and rates the harmless arrangement as more
    // corridor-like. If `deadEndAreaFraction` were ever reduced to a copy of it, or to any
    // monotone function of it, this assertion is what fails.
    expect(bars.corridorAreaFraction).toBeGreaterThan(pocket.corridorAreaFraction);
  });

  it('counts pockets rather than their depth, which is a limit and not a defect', () => {
    // Stated as an assertion so the limitation cannot quietly stop being true: the points
    // ALONG an alley have two clear directions, in and out, so only its end scores. A rule
    // that wants to bound alley length needs the articulation-point filter #822 describes,
    // which this change does not implement.
    const shallow = measureBoard(pocketBoard(2), 2, 'depth-2');
    const deep = measureBoard(pocketBoard(10), 2, 'depth-10');
    const shallowPoints = shallow.deadEndAreaFraction * shallow.probedPoints;
    const deepPoints = deep.deadEndAreaFraction * deep.probedPoints;
    // Five times the alley, within one probed point of the same absolute count.
    expect(Math.abs(deepPoints - shallowPoints)).toBeLessThanOrEqual(1);
    // ...while `corridorAreaFraction`, which DOES see the alley's length, nearly triples.
    expect(deep.corridorAreaFraction).toBeGreaterThan(shallow.corridorAreaFraction * 2);
  });

  it('degreeProfile is a distribution whose thresholds reproduce all three fractions', () => {
    // The three fractions are thresholds on this one histogram. Asserting the identity is
    // what stops a future edit moving one threshold and leaving the others describing a
    // different cut of the same probe. Swept over every shipped board at N=2.
    for (const def of ARENA_DEFS) {
      const m = measureBoard(def, 2, def.id);
      const sum = m.degreeProfile.reduce((s, v) => s + v, 0);
      expect(sum, `${def.id} sums to 1`).toBeCloseTo(1, 10);
      expect(m.degreeProfile.length, `${def.id} has 9 buckets`).toBe(9);

      const at = (lo: number, hi: number) =>
        m.degreeProfile.slice(lo, hi + 1).reduce((s, v) => s + v, 0);
      expect(at(0, 1), `${def.id} deadEnd`).toBeCloseTo(m.deadEndAreaFraction, 10);
      expect(at(0, 2), `${def.id} corridor`).toBeCloseTo(m.corridorAreaFraction, 10);
      expect(at(6, 8), `${def.id} open`).toBeCloseTo(m.openGroundFraction, 10);
    }
  });

  it('ranks the versus-authored boards far above the campaign ones, which needs reading before it is used', () => {
    // CALIBRATION, not a gate -- #822 is explicit that a quality measure which gates stops
    // describing the board. Measured at N=2 over all 8 shipped boards:
    //
    //   arena-01 0.0000   arena-02 0.0000   arena-03 0.0042   arena-04 0.0009
    //   arena-05 0.0000   vs-duel-01 0.0735 vs-tri-01 0.4020  vs-quad-01 0.0487
    //
    // The three boards authored FOR versus are the only ones above 0.005, and vs-tri-01 is
    // two orders of magnitude above the genre budget (2.5%) this measure came from. That is
    // reported, not interpreted: vs-tri-01 is the smallest shipped board at 27x17 and the
    // probe reach is 1.5 tank diameters, so "densely furnished" and "full of pockets" are
    // not yet distinguished at that size. What is asserted here is only the ORDERING, which
    // is what a calibration band needs and what a wired measure must produce.
    const at2 = Object.fromEntries(ARENA_DEFS.map((d) => [d.id, measureBoard(d, 2, d.id).deadEndAreaFraction]));
    const campaign = ['arena-01', 'arena-02', 'arena-03', 'arena-04', 'arena-05'];
    const versus = ['vs-duel-01', 'vs-tri-01', 'vs-quad-01'];
    const worstCampaign = Math.max(...campaign.map((id) => at2[id]));
    const bestVersus = Math.min(...versus.map((id) => at2[id]));
    expect(worstCampaign).toBeLessThan(0.01);
    expect(bestVersus).toBeGreaterThan(worstCampaign * 5);
  });
});
