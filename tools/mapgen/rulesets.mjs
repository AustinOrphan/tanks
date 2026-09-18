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

export const RULESETS = {
  scatter: {
    name: 'scatter',
    summary: 'null ruleset: symmetric random 2x2 blocks, connected floor, nothing else',
    prediction: 'no rule targets sightlines or lanes, so bank offer and corridor share should sit near the open-board floor',
    generate: scatter,
  },
};
