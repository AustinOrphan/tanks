import { describe, it, expect } from 'vitest';
import type { Arena } from '../../src/sim/arena';
import { ARENA_DEFS, loadArena } from '../../src/sim/arena';
import { evaluateVersusBoard } from '../../src/sim/versus-board';
import { lineOfSight as losImpl } from '../../src/sim/ai/targeting';
import {
  measureBoard, tankLattice, geodesic, nearestLegal, openingShots, wallAABBs,
  rotationalAsymmetry,
} from './measure';

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
  // question, though `egressOk`'s own doc comment in `versus-board.ts` once said it was
  // "`spawnsInLargestRegion === playerCount`": `evaluateSpawnEgress` computes
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

describe('mapgen quality measures: the gap taxonomy (issue #822)', () => {
  /** The same rectangle split by a solid wall, with a hole of `holeCells` in the middle. */
  const splitBoard = (holeCells: number): Arena => {
    const grid = openBoard(22, 18).grid.map((row) => [...row]);
    const mid = 9;
    for (let c = 0; c < 22; c++) grid[mid][c] = '#';
    for (let k = 0; k < holeCells; k++) grid[mid][10 + k] = '.';
    return board(grid.map((row) => row.join('')));
  };

  it('keeps the three rungs nested on every shipped board', () => {
    // A body of 4 cells fitting implies one of 3 fits at the same centre, and so on down, so
    // these are strictly nested fractions of one denominator. Asserted rather than assumed:
    // if any rung were ever built against a different wall set or a different denominator,
    // the nesting is the first thing that breaks and the only thing that shows it.
    //
    // STRICTLY ordered, not `<=`, and the difference is the whole pin. A first draft used
    // `toBeLessThanOrEqual`, under which collapsing rung 3 onto rung 2 -- measuring the
    // "comfortable corridor" with the minimum corridor's body -- SURVIVES, because equal
    // satisfies it. Every shipped board separates the three rungs by a wide margin
    // (arena-01: 0.945 / 0.718 / 0.522), so strict costs nothing and pins which rung each
    // field is built from.
    //
    // Population: all 8 shipped boards at N=2.
    for (const def of ARENA_DEFS) {
      const m = measureBoard(def, 2, def.id);
      expect(m.roomFraction, `${def.id} room < wide`).toBeLessThan(m.wideCorridorFraction);
      expect(m.wideCorridorFraction, `${def.id} wide < min`).toBeLessThan(m.minCorridorFraction);
      expect(m.minCorridorFraction, `${def.id} min <= 1`).toBeLessThanOrEqual(1);
      expect(m.roomFraction, `${def.id} room > 0`).toBeGreaterThan(0);
    }
  });

  it('calls a one-cell hole a slit and a three-cell door not, changing nothing else', () => {
    // THE ISOLATING CONTROL. Both boards are the same 22x18 rectangle split by the same
    // solid wall; only the hole's width differs. A shell crosses a one-cell gap and no tank
    // can enter it, which is exactly what a slit is.
    const slit = measureBoard(splitBoard(1), 2, 'one-cell');
    const door = measureBoard(splitBoard(3), 2, 'three-cell');

    expect(slit.slitCellFraction).toBeGreaterThan(0);
    expect(door.slitCellFraction).toBe(0);

    // ...and the rest of the taxonomy barely moves, which is what makes the line above a
    // measurement of the GAP rather than of the two boards being different. If
    // `slitCellFraction` were counting something else -- cells the wall covers, say, or open
    // floor generally -- these three would have to move with it.
    expect(slit.minCorridorFraction).toBeCloseTo(door.minCorridorFraction, 2);
    expect(slit.wideCorridorFraction).toBeCloseTo(door.wideCorridorFraction, 2);
    expect(slit.roomFraction).toBeCloseTo(door.roomFraction, 2);
    expect(Math.abs(slit.openFloorCells - door.openFloorCells)).toBeLessThanOrEqual(2);
  });

  it('finds no slits on an open rectangle, where there is no gap to be one', () => {
    // The construction control for the other direction: a board with no walls has no gap a
    // tank cannot enter, so a non-zero reading here would mean the cell-to-lattice mapping
    // is wrong rather than that a slit was found.
    for (const [cols, rows] of [[22, 18], [33, 27]] as const) {
      const m = measureBoard(openBoard(cols, rows), 2, `empty-${cols}x${rows}`);
      expect(m.slitCellFraction, `${cols}x${rows}`).toBe(0);
      // ...and most of an empty board is room-width by construction.
      expect(m.roomFraction, `${cols}x${rows}`).toBeGreaterThan(0.7);
    }
  });

  it('reports where the shipped boards sit against the imported 60% budget, without gating on it', () => {
    // CALIBRATION. #822 states its budget as "at least 60% of tank-navigable positions in a
    // corridor 3 cells or wider". Measured at N=2 over all 8 shipped boards:
    //
    //   arena-01 0.718  arena-02 0.767  arena-03 0.712  arena-04 0.832
    //   arena-05 0.848  vs-duel-01 0.473  vs-tri-01 0.198  vs-quad-01 0.626
    //
    // SIX of the eight clear it. The two that do not are the two smallest boards authored
    // for versus, and that is reported rather than read as a defect -- a budget imported
    // from another game's scale does not transfer to a 27x17 board without being re-derived
    // against boards people have actually played here.
    //
    // Slits, the same 8 boards: every campaign arena reads exactly 0.0000, and only
    // vs-duel-01 (0.0268) and vs-tri-01 (0.0554) have any shell-only geometry at all. #822
    // wants slits "bounded but NON-ZERO", so on that half of the rule six of the eight
    // shipped boards are the ones outside it.
    const rows = ARENA_DEFS.map((d) => ({ id: d.id, m: measureBoard(d, 2, d.id) }));
    const campaign = rows.filter((r) => r.id.startsWith('arena-'));
    const versus = rows.filter((r) => r.id.startsWith('vs-'));

    // Asserted as an ORDERING and a population, not as the budget itself.
    expect(campaign).toHaveLength(5);
    expect(versus).toHaveLength(3);
    for (const r of campaign) {
      expect(r.m.wideCorridorFraction, `${r.id} clears 0.60`).toBeGreaterThan(0.6);
      expect(r.m.slitCellFraction, `${r.id} has no slits`).toBe(0);
    }
    const narrowestCampaign = Math.min(...campaign.map((r) => r.m.wideCorridorFraction));
    const narrowestVersus = Math.min(...versus.map((r) => r.m.wideCorridorFraction));
    expect(narrowestVersus).toBeLessThan(narrowestCampaign);
    // At least one board has the shell-only geometry #822 asks for, so "non-zero" is
    // reachable on a real board rather than a property nothing here exhibits.
    expect(Math.max(...versus.map((r) => r.m.slitCellFraction))).toBeGreaterThan(0.01);
  });
});

describe('mapgen quality measures: bot jam corridors (issue #822)', () => {
  /**
   * A jam corridor is narrow AND long AND the only way through, all three at once. Any two of
   * them are fine, so every control below holds two conditions still and varies the third.
   *
   * The measure was wrong twice before these fixtures were satisfied, and both failures are
   * worth keeping in mind when changing it:
   *   1. clearance alone made the band along the BOARD FRAME one run around the whole board,
   *      which reported a 19.00-unit corridor on a board 20 units wide, at every tunnel
   *      length;
   *   2. clearance alone also made the bands along interior WALL FACES join separate gaps
   *      into one run, so a board with two routes still reported its tunnel as unavoidable.
   * The fix for both is that a corridor is enclosed on BOTH sides, not merely short of
   * clearance.
   */

  /** Two rooms in a 30x15 board, joined by ONE tunnel `wide` cells across and `len` long. */
  const tunnel = (wide: number, len: number): Arena => {
    const cols = 30;
    const rows = 15;
    const mid = 7;
    const grid: string[] = [];
    for (let r = 0; r < rows; r++) {
      let row = '';
      for (let c = 0; c < cols; c++) {
        const inWall = c >= 12 && c < 12 + len;
        const inGap = r >= mid && r < mid + wide;
        row += inWall && !inGap ? '#' : '.';
      }
      grid.push(row);
    }
    grid[3] = `${grid[3].slice(0, 3)}P${grid[3].slice(4)}`;
    grid[rows - 4] = `${grid[rows - 4].slice(0, cols - 4)}B${grid[rows - 4].slice(cols - 3)}`;
    return board(grid);
  };

  /** The same board, with a second gap opened through the same wall. */
  const twoRoutes = (len: number): Arena => {
    const grid = tunnel(2, len).grid.map((row) => [...row]);
    for (let c = 12; c < 12 + len; c++) { grid[2][c] = '.'; grid[3][c] = '.'; }
    return board(grid.map((row) => row.join('')));
  };

  it('counts a one-body tunnel and ignores a two-body one, at identical length', () => {
    // Width is the whole distinction here: same board, same wall, same tunnel length, and the
    // only change is whether two tanks can pass. 2 cells is 1.333 units, a tank plus 0.333.
    for (const len of [2, 6, 12]) {
      expect(measureBoard(tunnel(2, len), 2, `narrow-${len}`).jamCorridors, `2-cell @ ${len}`)
        .toBeGreaterThan(0);
      expect(measureBoard(tunnel(3, len), 2, `wide-${len}`).jamCorridors, `3-cell @ ${len}`).toBe(0);
      expect(measureBoard(tunnel(4, len), 2, `wider-${len}`).jamCorridors, `4-cell @ ${len}`).toBe(0);
    }
  });

  it('stops counting the same tunnel once a second route exists', () => {
    // THE CONTROL THAT DROVE THE DESIGN. The corridor is exactly as narrow and as long as
    // before; it is simply no longer the only way through, so it is no longer a trap. A bot
    // with no pathfinding can still blunder into it, but it cannot deadlock the match.
    for (const len of [6, 12]) {
      expect(measureBoard(tunnel(2, len), 2, `one-${len}`).jamCorridors, `one route @ ${len}`)
        .toBeGreaterThan(0);
      expect(measureBoard(twoRoutes(len), 2, `two-${len}`).jamCorridors, `two routes @ ${len}`).toBe(0);
    }
    // ...and `routeCount`, which is an independent measure, agrees about the second route.
    expect(measureBoard(twoRoutes(12), 2, 'two').routeCount).toBeGreaterThan(1);
  });

  it('reports a length that grows with the tunnel, rather than with the board', () => {
    // The first version reported 19.00 on a 20-unit board at every length, because it was
    // measuring the board's rim. These three have to separate.
    const short = measureBoard(tunnel(2, 2), 2, 'short').longestJamCorridor;
    const mid = measureBoard(tunnel(2, 6), 2, 'mid').longestJamCorridor;
    const long = measureBoard(tunnel(2, 12), 2, 'long').longestJamCorridor;
    expect(short).toBeGreaterThan(0);
    expect(mid).toBeGreaterThan(short);
    expect(long).toBeGreaterThan(mid);
    // A 12-cell tunnel is 8 world units; the bounding-box measure over-estimates a little and
    // must not run away with it.
    expect(long).toBeLessThan(12);
  });

  it('finds nothing on an open board, where the frame is the only narrow thing', () => {
    // The frame band is what the first version mistook for a corridor. A board with no walls
    // at all has no corridor by construction.
    for (const [cols, rows] of [[22, 18], [33, 27]] as const) {
      const m = measureBoard(openBoard(cols, rows), 2, `empty-${cols}x${rows}`);
      expect(m.jamCorridors, `${cols}x${rows}`).toBe(0);
      expect(m.longestJamCorridor, `${cols}x${rows}`).toBe(0);
    }
  });

  it('flags exactly one shipped board, and three other measures agree about which', () => {
    // CALIBRATION, not a gate. Measured at N=2 over all 8 shipped boards: seven report zero,
    // and vs-tri-01 reports 3 corridors with the longest at 7.58 units.
    //
    // That is not this measure on its own: vs-tri-01 is also the only shipped board whose
    // `bottleneckWidth` is the 1.333 minimum and whose `routeCount` is 1.00, and it is the
    // smallest board shipped at 27x17. Four independent figures pointing at one board is
    // corroboration; one figure pointing at one board would be a coincidence.
    const rows = ARENA_DEFS.map((def) => ({ id: def.id, m: measureBoard(def, 2, def.id) }));
    const flagged = rows.filter((r) => r.m.jamCorridors > 0);
    expect(flagged.map((r) => r.id)).toEqual(['vs-tri-01']);
    expect(rows).toHaveLength(8);

    const tri = rows.find((r) => r.id === 'vs-tri-01');
    expect(tri?.m.jamCorridors).toBeGreaterThan(0);
    expect(tri?.m.longestJamCorridor).toBeGreaterThan(0);
    // The corroborating pair, asserted so a future board that trips this measure alone is
    // visibly different from vs-tri-01 rather than quietly lumped with it.
    expect(tri?.m.bottleneckWidth).toBeCloseTo(2 * (2 / 3), 5);
    expect(tri?.m.routeCount).toBeCloseTo(1, 5);

    // And every board reporting zero here has more than one route, which is the relationship
    // the measure claims.
    rows.filter((r) => r.m.jamCorridors === 0).forEach((r) => {
      expect(r.m.routeCount, `${r.id} has an alternative route`).toBeGreaterThan(1);
    });
  });
});

describe('mapgen quality measures: 3-fold symmetry (issue #820)', () => {
  /**
   * THE CONTROL THAT MAKES THE C3 NUMBER MEAN ANYTHING.
   *
   * `rotationalAsymmetry` is generalised over the order of the rotation precisely so that it
   * can be checked against something already trusted. At two turns over the whole rectangle it
   * is computing the same thing as the shipped `asymmetryRotational` by a completely different
   * route -- centre coordinates, a rotation matrix and a floor, rather than an index flip --
   * and on a rectangle a 180-degree rotation maps cell centres exactly onto cell centres, so
   * the two must agree EXACTLY rather than approximately.
   *
   * Over all 8 shipped boards, which is the whole population `ARENA_DEFS` offers. If this ever
   * fails, the C3 figures reported beside it are wrong and nothing should be derived from them.
   */
  it('reproduces the shipped 180-degree measure at two turns, on every shipped board', () => {
    expect(ARENA_DEFS.length).toBeGreaterThan(0);
    for (const def of ARENA_DEFS) {
      const mine = rotationalAsymmetry(def, 2, 'whole');
      const shipped = measureBoard(def, 2, def.id).asymmetryRotational;
      expect(mine, `${def.id}: the generalised measure disagrees with asymmetryRotational`)
        .toBeCloseTo(shipped, 12);
    }
  });

  it('is zero on the disc for a board that cannot disagree with itself, at every order', () => {
    // A uniform board is symmetric under any rotation by construction, so on the disc every
    // order must score 0. This is the floor: a measure reporting anything here would be
    // counting something other than disagreement -- a rounding error in the centre
    // arithmetic, or an image being pushed out of the region it was sampled from.
    const uniform = board(Array.from({ length: 11 }, () => '#'.repeat(11)));
    for (const turns of [2, 3, 4, 6]) {
      expect(rotationalAsymmetry(uniform, turns, 'disc'), `order ${turns}`).toBe(0);
    }
  });

  it('shows why the rectangle is the wrong region: a UNIFORM board scores 0.13 at three turns', () => {
    // The whole-rectangle variant counts a cell whose image leaves the board as a
    // disagreement, deliberately -- skipping would let a board score well for having nothing
    // to compare against. The consequence is this: a completely uniform 11x11 board, which is
    // symmetric under every rotation, still scores 0.132 at three turns, purely because a
    // rectangle has no 120-degree rotation onto itself and its corners rotate into nothing.
    //
    // That is the confound `asymmetryC3` avoids by sampling the inscribed disc, and it is the
    // whole reason the board measure does not use the rectangle. Asserted rather than
    // explained, so the claim in `rotationalAsymmetry`'s own comment is checked.
    const uniform = board(Array.from({ length: 11 }, () => '#'.repeat(11)));
    expect(rotationalAsymmetry(uniform, 2, 'whole'), 'a rectangle IS 180-degree symmetric').toBe(0);
    expect(rotationalAsymmetry(uniform, 3, 'whole'), 'the rectangle confound is gone')
      .toBeCloseTo(0.1322, 3);
    expect(rotationalAsymmetry(uniform, 3, 'disc'), 'the disc should not inherit it').toBe(0);
  });

  it('moves the moment one cell breaks the symmetry', () => {
    // The open board has nothing to disagree about; one solid cell inside the disc gives it
    // something. Placed at (2,2) on an 11x11 board, whose inscribed radius is 5.5 and whose
    // centre is (5.5, 5.5): the cell centre sits 4.24 from the middle, comfortably inside.
    const open = openBoard(11, 11);
    expect(rotationalAsymmetry(open, 3, 'disc'), 'the open board already disagrees').toBe(0);

    const broken = { ...open, grid: open.grid.map((row, r) =>
      r === 2 ? `${row.slice(0, 2)}#${row.slice(3)}` : row) };
    expect(broken.grid[2][2], 'the fixture did not place the wall').toBe('#');
    expect(rotationalAsymmetry(broken, 3, 'disc'), 'one wall did not move the measure')
      .toBeGreaterThan(0);
  });

  it('reports the DISC on the board measures, which is a different number from the rectangle', () => {
    // `asymmetryC3` is the disc variant deliberately: over the whole rectangle the number is
    // dominated by corners rotating into empty space, which is a fact about rectangles rather
    // than about the board. Asserted on a shipped board so the two are known to differ -- a
    // field wired to the wrong variant would otherwise be invisible.
    const def = ARENA_DEFS.find((d) => d.id === 'vs-tri-01');
    expect(def, 'vs-tri-01 is gone from the catalogue').toBeDefined();
    const measured = measureBoard(def!, 3, def!.id).asymmetryC3;
    expect(measured).toBeCloseTo(rotationalAsymmetry(def!, 3, 'disc'), 12);
    expect(measured).not.toBeCloseTo(rotationalAsymmetry(def!, 3, 'whole'), 3);
  });

  it('finds no shipped board that is approximately 3-fold symmetric, over the whole catalogue', () => {
    // The finding that keeps this measure REPORTED rather than gating (issue #820). Stated as
    // a floor rather than as the exact figures, so it survives a board being retuned: if some
    // future board ever scores below 0.2 the premise "the shipped set cannot supply a
    // tolerance" has changed and this issue's reasoning deserves revisiting -- which is
    // exactly when a reader wants to be told.
    const scores = ARENA_DEFS.map((d) => ({ id: d.id, c3: rotationalAsymmetry(d, 3, 'disc') }));
    expect(scores.length, 'no boards to measure').toBe(8);
    const best = scores.reduce((a, b) => (a.c3 <= b.c3 ? a : b));
    expect(best.c3, `${best.id} is now nearly 3-fold symmetric; see issue #820`)
      .toBeGreaterThan(0.2);
  });
});
