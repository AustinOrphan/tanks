import { rng, BOARD, blankCells, rotate180, toArena, cellsConnected } from './lib.mjs';

/**
 * The candidate rulesets, each a pure `(seed) -> Arena`.
 *
 * A ruleset is a NAMED SET OF RULES for building a board, and the point of having several is
 * that they disagree: the comparison in `sweep.mjs` is only worth reading if the rulesets
 * produce measurably different boards, so each one below states the measure it expects to
 * move and in which direction. A ruleset whose boards cannot be told from another's is a
 * finding about the rules, not a failure of the harness.
 *
 * `scatter` is the NULL RULESET and is here to be beaten. It encodes the least design
 * anyone could call a rule -- put blocks down at random, keep the floor connected -- and it
 * is the same shape as the one generator this repository already has, `sandboxArena`'s wall
 * scatter, so it is also the honest "what we have today" baseline. Any designed ruleset that
 * cannot separate itself from this one has not earned its complexity.
 */

/**
 * NULL RULESET: scatter blocks, keep the floor connected, impose rotational symmetry.
 *
 * Rules, in full, so there is no doubt what the baseline includes:
 *   1. Work in 2x2-cell blocks, never single cells. A single cell is 0.667 wide against a
 *      1.0 tank -- a pillar, not cover -- and `sandboxArena` learned the same lesson when
 *      the arena resolution changed under it.
 *   2. Place blocks only in the first half of the board in row-major order, then rotate the
 *      half onto its antipode, so the board is exactly 180-degree symmetric by construction.
 *   3. A block may not touch a placed block, so `loadArena`'s solid merge cannot fuse two
 *      into one long wall and quietly turn a cover field into a maze.
 *   4. A block that disconnects the open floor is rejected and the next candidate tried.
 *   5. A fixed share of blocks is destructible rather than solid.
 * Nothing about lanes, sightlines, spawn distance, or carom. That is the point.
 */
function scatter(seed, opts = {}) {
  const { blocks = 26, destructibleShare = 0.25, board = BOARD } = opts;
  const r = rng(seed);
  const cells = blankCells(board);
  const anchor = [1, 1];

  const candidates = [];
  for (let br = 1; br + 1 < board.rows; br += 2) {
    for (let bc = 1; bc + 1 < board.cols; bc += 2) {
      // Only the first half: the rotation supplies the rest.
      if (br * board.cols + bc >= (board.rows * board.cols) / 2) continue;
      candidates.push([bc, br]);
    }
  }
  r.shuffle(candidates);

  // Checked at the block AND at its antipode, because the rotation places a second copy
  // there and a block near the centre line can end up adjacent to its own image. Testing
  // only the block let two halves of the same piece merge into one wide wall -- visible as
  // short horizontal runs across the middle of the first boards this drew, and a violation
  // of rule 3 by the ruleset's own statement of itself.
  const touchesAt = (bc, br) => {
    for (let rr = br - 1; rr <= br + 2; rr++) {
      for (let cc = bc - 1; cc <= bc + 2; cc++) {
        if (rr < 0 || cc < 0 || rr >= board.rows || cc >= board.cols) continue;
        if (cells[rr][cc] !== '.') return true;
      }
    }
    return false;
  };
  /**
   * Would this block sit next to its OWN rotated image? Answered by arithmetic, not by
   * reading `cells`: at the moment of the check the image has not been painted yet, and
   * reading the grid at the antipode only re-asks the question the grid is already
   * symmetric about -- which is why a first attempt at this check changed not one figure in
   * the sweep. Overlap of the block's expanded neighbourhood with the rectangle its image
   * will occupy is the thing that actually decides it.
   */
  const meetsOwnImage = (bc, br) => {
    const ic = board.cols - 2 - bc;
    const ir = board.rows - 2 - br;
    return ic <= bc + 2 && ic + 1 >= bc - 1 && ir <= br + 2 && ir + 1 >= br - 1;
  };
  const touches = (bc, br) => touchesAt(bc, br) || meetsOwnImage(bc, br);
  const paint = (bc, br, ch) => {
    for (let rr = br; rr < br + 2; rr++) for (let cc = bc; cc < bc + 2; cc++) cells[rr][cc] = ch;
  };

  let placed = 0;
  for (const [bc, br] of candidates) {
    if (placed >= blocks) break;
    // Keep the spawn anchor and its neighbourhood clear -- a block on P1's own cell would
    // make the board unloadable rather than merely bad.
    if (Math.abs(bc - anchor[0]) <= 3 && Math.abs(br - anchor[1]) <= 3) continue;
    if (touches(bc, br)) continue;
    const ch = r.next() < destructibleShare ? 'x' : '#';
    paint(bc, br, ch);
    rotate180(cells);
    if (cellsConnected(cells)) placed++;
    else {
      paint(bc, br, '.');
      rotate180(cells);
    }
  }
  return toArena(rotate180(cells), anchor, board);
}


/**
 * GRAMMAR RULESET: a lattice of rooms separated by lanes, each room stamped with one piece
 * from a small authored vocabulary.
 *
 * The thesis is that the generator never draws a free-form wall. It chooses WHICH authored
 * piece goes WHERE, so every wall on the board is a shape a person approved, and the only
 * randomness is arrangement. Bomberman's fixed hard-block lattice is the canonical example
 * of the family; Battle City's brick/steel tile vocabulary is the other.
 *
 * The lattice period is 7 cells: a 3-cell LANE and a 4-cell ROOM. Those two numbers are the
 * gap taxonomy, not a tuning choice -- a 3-cell lane is 2.0 world units, the comfortable
 * corridor the arena-geometry spec calls today's standard, and a 4-cell room is 2.667, wide
 * enough that two tanks can pass inside one. Rooms sit at `(x mod 7) in [3, 6]`.
 *
 * Expected to separate from `scatter` on OPEN GROUND and BOTTLENECK WIDTH, both upward: the
 * lanes are continuous and 3 cells wide by construction, where scatter's gaps are whatever
 * the confetti left.
 */
function rooms(seed, opts = {}) {
  const { board = BOARD, fillShare = 0.62, destructibleShare = 0.3 } = opts;
  const r = rng(seed);
  const cells = blankCells(board);
  const anchor = [1, 1];

  /** The vocabulary. Each piece is drawn into a 4x4 room, as [col, row] offsets. */
  const PIECES = [
    { name: 'empty', cells: [] },
    { name: 'core', cells: [[1, 1], [2, 1], [1, 2], [2, 2]] },
    { name: 'bar-h', cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
    { name: 'bar-v', cells: [[1, 0], [1, 1], [1, 2], [1, 3]] },
    { name: 'corner', cells: [[0, 0], [1, 0], [0, 1], [2, 3], [3, 3], [3, 2]] },
    { name: 'split', cells: [[0, 0], [1, 0], [0, 1], [1, 1], [2, 2], [3, 2], [2, 3], [3, 3]] },
  ];

  const roomOrigins = [];
  for (let rr = 3; rr + 3 < board.rows; rr += 7) {
    for (let cc = 3; cc + 3 < board.cols; cc += 7) {
      if (rr * board.cols + cc >= (board.rows * board.cols) / 2) continue;
      roomOrigins.push([cc, rr]);
    }
  }

  for (const [cc, rr] of roomOrigins) {
    // The room holding P1 stays empty: a piece stamped on the spawn would leave the board
    // unloadable rather than merely cramped.
    if (Math.abs(cc - anchor[0]) < 6 && Math.abs(rr - anchor[1]) < 6) continue;
    const piece = r.next() < fillShare ? r.pick(PIECES.slice(1)) : PIECES[0];
    const ch = r.next() < destructibleShare ? 'x' : '#';
    for (const [dc, dr] of piece.cells) cells[rr + dr][cc + dc] = ch;
  }
  rotate180(cells);
  return toArena(cells, anchor, board);
}

/**
 * TOPOLOGY RULESET: decide the route graph first, then carve it.
 *
 * The board starts SOLID. A 3x3 grid of plazas is connected by a chosen set of edges, and
 * only those plazas and edges are carved out. Fairness and flow are settled on the graph,
 * where "every plaza has degree at least 2" and "the graph carries at least `cycles`
 * independent loops" are one line each, rather than hoped for after the fact.
 *
 * Every edge is carved 3 cells wide -- the comfortable corridor -- so a corridor here is
 * never the 1.333 scrape a subtractive method can leave by accident.
 *
 * Expected to separate from both others on CORRIDOR SHARE (upward, since everything that is
 * not a plaza is a lane) and LEGAL AREA (downward, since the default state is wall rather
 * than floor).
 */
function topology(seed, opts = {}) {
  const { board = BOARD, extraEdges = 3, plazaRadius = 2 } = opts;
  const r = rng(seed);
  const cells = Array.from({ length: board.rows }, () => Array(board.cols).fill('#'));
  const anchor = [3, 3];

  // Plaza centres on a 3x3 grid, inset so a plaza never touches the frame.
  const nodes = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      nodes.push({
        id: gy * 3 + gx,
        c: Math.round(3 + gx * ((board.cols - 7) / 2)),
        r: Math.round(3 + gy * ((board.rows - 7) / 2)),
      });
    }
  }

  const carveBox = (c0, r0, c1, r1, ch = '.') => {
    for (let rr = Math.max(0, r0); rr <= Math.min(board.rows - 1, r1); rr++) {
      for (let cc = Math.max(0, c0); cc <= Math.min(board.cols - 1, c1); cc++) cells[rr][cc] = ch;
    }
  };

  for (const n of nodes) carveBox(n.c - plazaRadius, n.r - plazaRadius, n.c + plazaRadius, n.r + plazaRadius);

  // The spanning skeleton: every plaza joined to its right and lower neighbour forms a full
  // lattice, which is more than a tree. Start from a ring so no plaza has degree 1, then add
  // `extraEdges` chords for loops.
  const ring = [0, 1, 2, 5, 8, 7, 6, 3];
  const edges = ring.map((a, i) => [a, ring[(i + 1) % ring.length]]);
  const chords = [[1, 4], [3, 4], [4, 5], [4, 7], [0, 4], [2, 4], [6, 4], [8, 4]];
  r.shuffle(chords);
  edges.push(...chords.slice(0, extraEdges));

  // 3 cells wide: the comfortable corridor, carved as an L so the corridor is axis-aligned
  // and reads as a lane rather than a diagonal smear.
  const LANE = 1;
  for (const [a, b] of edges) {
    const na = nodes[a];
    const nb = nodes[b];
    carveBox(Math.min(na.c, nb.c) - LANE, na.r - LANE, Math.max(na.c, nb.c) + LANE, na.r + LANE);
    carveBox(nb.c - LANE, Math.min(na.r, nb.r) - LANE, nb.c + LANE, Math.max(na.r, nb.r) + LANE);
  }

  // Destructibles go back into plaza interiors as cover, never into a lane: a lane plugged
  // with a destructible is a route that only a mine opens, and the topology was the point.
  for (const n of nodes) {
    if (r.next() > 0.5) continue;
    if (Math.abs(n.c - anchor[0]) < 6 && Math.abs(n.r - anchor[1]) < 6) continue;
    carveBox(n.c - 1, n.r - 1, n.c, n.r, 'x');
  }

  rotate180(cells);
  return toArena(cells, anchor, board);
}

export const RULESETS = {
  scatter: {
    name: 'scatter',
    summary: 'null ruleset: symmetric random 2x2 blocks, connected floor, nothing else',
    prediction: 'no rule targets sightlines or lanes, so bank offer and corridor share should sit near the open-board floor',
    generate: scatter,
    variants: [
      { label: 'blocks=14', opts: { blocks: 14 } },
      { label: 'blocks=26', opts: {} },
      { label: 'blocks=40', opts: { blocks: 40 } },
    ],
  },
  rooms: {
    name: 'rooms',
    summary: 'a 7-cell lattice of 4-cell rooms and 3-cell lanes, each room stamped from a 6-piece vocabulary',
    prediction: 'open ground and bottleneck width both above scatter: the lanes are continuous and 3 cells wide by construction',
    generate: rooms,
    variants: [
      { label: 'fill=0.35', opts: { fillShare: 0.35 } },
      { label: 'fill=0.62', opts: {} },
      { label: 'fill=0.90', opts: { fillShare: 0.9 } },
    ],
  },
  topology: {
    name: 'topology',
    summary: 'route graph first -- a ring of 9 plazas plus chords -- then carved 3 cells wide out of solid rock',
    prediction: 'corridor share well above the others and legal area well below: everything that is not a plaza is a lane',
    generate: topology,
    variants: [
      { label: 'chords=0', opts: { extraEdges: 0 } },
      { label: 'chords=3', opts: {} },
      { label: 'chords=6', opts: { extraEdges: 6 } },
      { label: 'plaza=4', opts: { plazaRadius: 4 } },
    ],
  },
};
