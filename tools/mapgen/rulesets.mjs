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


/**
 * RUNS RULESET: carve the pathways first, then build the cover out of long straight bars and
 * L-bends rather than blocks.
 *
 * This is an owner design ruling, taken as a directive rather than derived: deliberate
 * pathways should be created rather than left to emerge, and longer straights and L shapes
 * should be encouraged. Both halves are implemented literally, and both have independent
 * support in the genre survey, which is why they are worth testing rather than merely
 * recording:
 *
 *   PATHWAYS FIRST is `loop-skeleton-first` (arena-fps-flow, graded measured) and
 *   `carve-the-spawn-circuit-first` (pcg-techniques): lay a closed circulation loop on the
 *   tank layer BEFORE placing any wall, mark those cells protected, and let the wall placer
 *   work around them. A route that exists because it was drawn is a different object from one
 *   that exists because the clutter happened to leave a gap -- which is exactly what
 *   `scatter` produces and why it reads as confetti.
 *
 *   LONG STRAIGHTS AND Ls is `cover-as-offset-bars-with-long-flat-faces` (tank-lineage),
 *   which reports Wii Tanks and Battle City cover as axis-aligned runs of 3-8 tank widths,
 *   one cell thick, OFFSET between adjacent rows rather than aligned. It is also
 *   `reflector-faces-for-bank-shots`: a bank shot needs a flat unbroken face of meaningful
 *   length to come off, and a board made of 2x2 blocks offers almost none.
 *
 * WHAT THIS PREDICTS, to be checked rather than assumed: against `rooms`, longer faces and a
 * carved loop should raise wall fraction toward the shipped floor of 0.08 and lengthen the
 * longest sightline, while the protected loop holds bottleneck width at the carved lane width
 * and keeps route count at or above 2. If the bars behave like `scatter`'s blocks instead --
 * same measures, different shapes -- then piece SHAPE does not matter and only density does,
 * which would itself be worth knowing.
 */
function runs(seed, opts = {}) {
  const {
    board = BOARD,
    pieces = 16,
    destructibleShare = 0.22,
    laneHalfWidth = 1,   // 1 -> a 3-cell lane, the comfortable corridor
    minRun = 4,
    maxRun = 8,
  } = opts;
  const r = rng(seed);
  const cells = blankCells(board);
  const anchor = [2, 2];

  // ---- step 1: the deliberate pathway ----
  // A closed rectangular circuit inset from the frame, plus one cross spur, carved to
  // `laneHalfWidth * 2 + 1` cells and marked PROTECTED so no piece may land on it. The circuit
  // is what makes every route on the board one somebody drew.
  const protectedCells = cells.map((row) => row.map(() => false));
  const inset = 3;
  const top = inset;
  const bottom = board.rows - 1 - inset;
  const left = inset;
  const right = board.cols - 1 - inset;
  const protect = (c0, r0, c1, r1) => {
    for (let rr = Math.max(0, r0 - laneHalfWidth); rr <= Math.min(board.rows - 1, r1 + laneHalfWidth); rr++) {
      for (let cc = Math.max(0, c0 - laneHalfWidth); cc <= Math.min(board.cols - 1, c1 + laneHalfWidth); cc++) {
        protectedCells[rr][cc] = true;
      }
    }
  };
  protect(left, top, right, top);        // the circuit's four sides
  protect(left, bottom, right, bottom);
  protect(left, top, left, bottom);
  protect(right, top, right, bottom);
  const midRow = (top + bottom) >> 1;
  const midCol = (left + right) >> 1;
  // One spur across the middle, so the circuit is not a single ring with a dead interior.
  if (r.next() < 0.5) protect(left, midRow, right, midRow);
  else protect(midCol, top, midCol, bottom);

  // ---- step 2: cover as long runs and L-bends ----
  // Every piece is ONE CELL THICK. That is deliberate and is what makes it a bar rather than a
  // block: a 1-cell wall is 0.667 wide, so it stops a tank, presents a long flat face to bank
  // off, and costs far less floor than a 2-cell-thick wall of the same length.
  const candidates = [];
  for (let rr = 1; rr < board.rows - 1; rr++) {
    for (let cc = 1; cc < board.cols - 1; cc++) {
      if (rr * board.cols + cc >= (board.rows * board.cols) / 2) continue;
      candidates.push([cc, rr]);
    }
  }
  r.shuffle(candidates);

  /** The cells a piece would occupy: a straight run, or an L with two arms. */
  const shapeOf = (cc, rr) => {
    const len = minRun + r.int(maxRun - minRun + 1);
    const horizontal = r.next() < 0.5;
    const out = [];
    for (let i = 0; i < len; i++) out.push(horizontal ? [cc + i, rr] : [cc, rr + i]);
    if (r.next() < 0.45) {
      // An L: a second arm off the far end, turning either way.
      const arm = Math.max(2, Math.floor(len / 2)) + r.int(2);
      const [ec, er] = out[out.length - 1];
      const sign = r.next() < 0.5 ? 1 : -1;
      for (let i = 1; i <= arm; i++) out.push(horizontal ? [ec, er + sign * i] : [ec + sign * i, er]);
    }
    return out;
  };

  const fits = (shape) => {
    for (const [cc, rr] of shape) {
      if (cc < 1 || rr < 1 || cc >= board.cols - 1 || rr >= board.rows - 1) return false;
      if (protectedCells[rr][cc]) return false;
      // Keep the spawn anchor's neighbourhood clear, and keep a one-cell gap from anything
      // already placed -- including from this piece's own rotated image, which `rotate180`
      // will put at the antipode.
      if (Math.abs(cc - anchor[0]) <= 3 && Math.abs(rr - anchor[1]) <= 3) return false;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = rr + dr;
          const nc = cc + dc;
          if (nr < 0 || nc < 0 || nr >= board.rows || nc >= board.cols) continue;
          if (cells[nr][nc] !== '.') return false;
          const ir = board.rows - 1 - nr;
          const ic = board.cols - 1 - nc;
          if (shape.some(([sc, sr]) => sc === ic && sr === ir)) return false;
        }
      }
    }
    return true;
  };

  let placed = 0;
  for (const [cc, rr] of candidates) {
    if (placed >= pieces) break;
    const shape = shapeOf(cc, rr);
    if (!fits(shape)) continue;
    const ch = r.next() < destructibleShare ? 'x' : '#';
    for (const [sc, sr] of shape) cells[sr][sc] = ch;
    rotate180(cells);
    if (cellsConnected(cells)) {
      placed++;
    } else {
      for (const [sc, sr] of shape) cells[sr][sc] = '.';
      rotate180(cells);
    }
  }
  return toArena(rotate180(cells), anchor, board);
}


/**
 * SPINES RULESET: a few very long CONTINUOUS walls, the corridors they leave between them, and
 * reserved open spaces.
 *
 * The second owner ruling, verbatim: "Open spaces and corridors are good. Long continuous
 * walls are good." `runs` implemented the first ruling (deliberate pathways, longer straights
 * and Ls) and measured inside every shipped band, but it failed this one in two specific ways
 * this ruleset exists to fix.
 *
 * FAULT 1 -- `runs` FORBIDS ALL JOINS, so its walls are isolated bars that never become long
 * continuous runs. The same rule also saturated the board: asking for 16, 24 or 32 pieces gave
 * byte-identical measurements because the one-cell gap filled the half-board at about 16 and
 * the surplus request was silently dropped.
 *
 * THE JOIN RULE is the crux, because the two obvious rules are both wrong. Forbid every join
 * and walls can never be continuous, which is fault 1. Permit every join and the walls fuse
 * into a maze with no corridors left between them. So joins are permitted ONLY AT AN ENDPOINT:
 * a new spine may meet an existing one at its own first or last cell -- making an L, a T or a
 * Z -- and everywhere else must keep `minClear` cells of separation. Continuity is bought at
 * the ends; corridors are protected along the length.
 *
 * FAULT 2 -- `runs` CARVED A PATHWAY AND IT WAS NOT LEGIBLE, because the rest of the interior
 * was open too, so a drawn route read as more open floor. This ruleset does not carve a route
 * at all. A corridor here is legible because it is BOUNDED: `minClear` is the distance between
 * two spines, so the space between them is a lane with wall on both sides, which is what makes
 * it read as a lane rather than as floor. Open space is legible for the opposite reason -- a
 * reserved plaza has no wall in it at all.
 *
 * `minClear` is 4 cells of Chebyshev separation between wall cells, which leaves 3 free cells
 * between two spines: 2.0 world units, the comfortable corridor the arena-geometry spec calls
 * today's standard. At 3 it would leave 2 free cells -- 1.333, the tight minimum -- which that
 * spec names as its own biggest playtest risk and which is where a reactive no-pathfinding bot
 * jams. The number is the taxonomy's, not a tuning choice.
 */
function spines(seed, opts = {}) {
  const {
    board = BOARD,
    count = 7,
    minLen = 8,
    maxLen = 20,
    minClear = 4,
    plazaRadius = 3,
    destructibleShare = 0.2,
    /**
     * How many cells thick a spine is, across its run.
     *
     * 1 was the original and it is why this generator built nothing a shipped board is made of.
     * A wall cell counts as INTERIOR when all four of its orthogonal neighbours are walled, and
     * a 1-cell bar can never have one -- nor can a 2-cell bar, since every cell in it still
     * faces floor. Three cells across is the thinnest mass that can, and it is 2.0 world units:
     * two tank widths, a block to circle rather than a line to shoot past.
     *
     * Measured: every one of the 8 shipped boards has an interior share between 0.09 and 0.34,
     * and `scatter`, `rooms`, `runs` and `spines` at thickness 1 all measure exactly 0.00.
     * At 2 it is still 0.00 -- a two-cell bar has no enclosed cell either -- and at 3 it is
     * 0.25, inside the shipped band, with every gameplay measure also still in band.
     *
     * DEFAULT 1, DELIBERATELY, BECAUSE THE IMPLEMENTATION IS NOT GOOD ENOUGH YET. Thickening
     * here grows each cell of a shape sideways, and `fits` then has to clear the whole widened
     * shape at `minClear`, so long runs stop fitting and the board fills with short fat slabs
     * instead of the long continuous walls the ruleset exists to make. Pushing `minLen` up to
     * 16-28 does not recover them: the placement search simply rejects more, leaving 4 or 5
     * pieces on the board. The statistic improves while the board gets worse, which is the
     * failure mode the whole quality tier is supposed to catch and here does not.
     *
     * Doing it properly means changing the SEARCH, not the shape: measure clearance from a
     * spine's edge rather than its centre line, and place thick spines before thin ones. That
     * is issue #821's work, and the knob is left here as the evidence for it.
     */
    thickness = 1,
  } = opts;
  const r = rng(seed);
  const cells = blankCells(board);
  const anchor = [2, 2];

  // ---- reserved open space ----
  // One plaza in the first half; the rotation gives its partner. Kept clear of every spine, so
  // the board has somewhere that is deliberately open rather than merely unbuilt.
  const plaza = {
    c: 6 + r.int(Math.max(1, board.cols - 18)),
    r: 6 + r.int(Math.max(1, Math.floor(board.rows / 2) - 8)),
  };
  const inPlaza = (cc, rr) => {
    if (Math.abs(cc - plaza.c) <= plazaRadius && Math.abs(rr - plaza.r) <= plazaRadius) return true;
    const ic = board.cols - 1 - plaza.c;
    const ir = board.rows - 1 - plaza.r;
    return Math.abs(cc - ic) <= plazaRadius && Math.abs(rr - ir) <= plazaRadius;
  };

  const wallCells = [];
  const isWall = (cc, rr) => cc >= 0 && rr >= 0 && cc < board.cols && rr < board.rows && cells[rr][cc] !== '.';

  /** Chebyshev distance from (cc, rr) to the nearest placed wall cell, capped at `minClear`. */
  const clearance = (cc, rr) => {
    let best = minClear;
    for (const [wc, wr] of wallCells) {
      const d = Math.max(Math.abs(wc - cc), Math.abs(wr - rr));
      if (d < best) best = d;
      if (best === 0) break;
    }
    return best;
  };

  /** A straight run of `len` cells from (cc, rr), optionally turning once into an L or Z. */
  const spineShape = (cc, rr) => {
    const len = minLen + r.int(maxLen - minLen + 1);
    const horizontal = r.next() < 0.5;
    const out = [];
    for (let i = 0; i < len; i++) out.push(horizontal ? [cc + i, rr] : [cc, rr + i]);
    // Turn on roughly half, and turn TWICE on a third of those -- an L and a Z. A Z is what
    // makes a corridor bend, which is what stops a spine from also being a full-board sightline.
    if (r.next() < 0.55) {
      const arm = 3 + r.int(6);
      const [ec, er] = out[out.length - 1];
      const sign = r.next() < 0.5 ? 1 : -1;
      for (let i = 1; i <= arm; i++) out.push(horizontal ? [ec, er + sign * i] : [ec + sign * i, er]);
      if (r.next() < 0.35) {
        const arm2 = 3 + r.int(6);
        const [fc, fr] = out[out.length - 1];
        for (let i = 1; i <= arm2; i++) out.push(horizontal ? [fc + sign * i, fr] : [fc, fr + sign * i]);
      }
    }
    if (thickness > 1) {
      // Widen across the run: for each cell, add cells perpendicular to the direction it came
      // from, so a corner thickens into a corner rather than into a blot.
      const grown = out.slice();
      for (let i = 0; i < out.length; i++) {
        const [cc, rr] = out[i];
        const prev = out[i - 1] ?? out[i + 1] ?? [cc, rr];
        const alongC = cc !== prev[0];
        for (let t = 1; t < thickness; t++) {
          const nc = alongC ? cc : cc + t;
          const nr = alongC ? rr + t : rr;
          if (!grown.some(([a, b]) => a === nc && b === nr)) grown.push([nc, nr]);
        }
      }
      return grown;
    }
    return out;
  };

  /**
   * THE JOIN RULE. Every cell of the candidate must either keep `minClear` from every placed
   * wall cell, or be close to one ONLY at the candidate's own first or last cell -- an
   * end-join. A violation anywhere in the middle is a wall running alongside another with no
   * corridor left between them, which is the maze this rule exists to prevent.
   */
  const fits = (shape) => {
    const head = shape[0];
    const tail = shape[shape.length - 1];
    let joins = 0;
    for (const [cc, rr] of shape) {
      // Stay off the frame, out of the plazas, and away from the authored spawn.
      if (cc < 1 || rr < 1 || cc >= board.cols - 1 || rr >= board.rows - 1) return false;
      if (inPlaza(cc, rr)) return false;
      if (Math.abs(cc - anchor[0]) <= 3 && Math.abs(rr - anchor[1]) <= 3) return false;
      if (isWall(cc, rr)) return false;
      // The candidate's own rotated image counts as a placed wall: `rotate180` will put it
      // there, and a spine running alongside its own image leaves no corridor either.
      const ic = board.cols - 1 - cc;
      const ir = board.rows - 1 - rr;
      const nearOwnImage = shape.some(([sc, sr]) => Math.max(Math.abs(sc - ic), Math.abs(sr - ir)) < minClear);
      if (clearance(cc, rr) < minClear || nearOwnImage) {
        const atEnd = Math.max(Math.abs(cc - head[0]), Math.abs(rr - head[1])) <= 1
          || Math.max(Math.abs(cc - tail[0]), Math.abs(rr - tail[1])) <= 1;
        if (!atEnd) return false;
        joins++;
      }
    }
    // At most one end-join per spine, so a spine joins the structure rather than being absorbed
    // into it at both ends and sealing a pocket.
    return joins <= 3;
  };

  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < 4000) {
    attempts++;
    const cc = 1 + r.int(board.cols - 2);
    const rr = 1 + r.int(Math.max(1, Math.floor(board.rows / 2)));
    const shape = spineShape(cc, rr);
    if (!fits(shape)) continue;
    // A whole spine is solid or a whole spine is destructible -- never a mix. A destructible
    // cell is a destruction UNIT, and a spine speckled with them reads as damage rather than
    // as terrain a mine can open.
    const ch = r.next() < destructibleShare ? 'x' : '#';
    for (const [sc, sr] of shape) cells[sr][sc] = ch;
    rotate180(cells);
    if (cellsConnected(cells)) {
      for (const cell of shape) wallCells.push(cell);
      placed++;
    } else {
      for (const [sc, sr] of shape) cells[sr][sc] = '.';
      rotate180(cells);
    }
  }
  return toArena(rotate180(cells), anchor, board);
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
  runs: {
    name: 'runs',
    summary: 'carve a protected circulation circuit first, then cover as 1-cell-thick runs of 4-8 cells and L-bends',
    prediction: 'longer flat faces and a drawn loop: wall fraction toward the shipped floor, a longer longest-sightline than rooms, bottleneck held at the carved lane width, route count at or above 2',
    generate: runs,
    variants: [
      { label: 'pieces=10', opts: { pieces: 10 } },
      { label: 'pieces=16', opts: {} },
      { label: 'pieces=24', opts: { pieces: 24 } },
      { label: 'run=6-12', opts: { minRun: 6, maxRun: 12 } },
      { label: 'lane=5cell', opts: { laneHalfWidth: 2 } },
    ],
  },
  spines: {
    name: 'spines',
    summary: 'a few very long continuous walls joined only at their ends, 3-cell corridors between them, reserved plazas',
    prediction: 'long continuous walls and bounded lanes: corridor share up and open ground down against runs, bottleneck held near 2.0 by the clearance rule, and bank offer up because a long spine is a long flat face',
    generate: spines,
    variants: [
      { label: 'count=5', opts: { count: 5 } },
      { label: 'count=7', opts: {} },
      { label: 'count=10', opts: { count: 10 } },
      { label: 'len=12-24', opts: { minLen: 12, maxLen: 24 } },
      { label: 'clear=3cell', opts: { minClear: 3 } },
      { label: 'plaza=5', opts: { plazaRadius: 5 } },
      { label: 'thick=2', opts: { thickness: 2 } },
      { label: 'thick=3', opts: { thickness: 3 } },
      { label: 'thick=3 n=5', opts: { thickness: 3, count: 5 } },
    ],
  },
};
