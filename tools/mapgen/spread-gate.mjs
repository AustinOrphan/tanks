/**
 * THE ONE GATE THE QUALITY TIER FEEDS (issue #820): a generated 3-player board's spawn-path
 * spread.
 *
 * Exact fairness for three seats needs 3-fold symmetry, which a rectangle cannot have. The
 * rulings on #820 chose approximate symmetry with a stated tolerance, and put the tolerance on
 * FAIRNESS rather than on cell symmetry: `pathSpread` = `(pathMax - pathMin) / pathMean` over a
 * board's spawn-pair path lengths (`measure.ts`; 0 means every pair starts equally far apart).
 * The 3-fold cell-symmetry figure `asymmetryC3` stays reported and is never gated.
 *
 * WHY THIS IS AN EXCEPTION AND NOT A PRECEDENT. Everything else the quality tier computes is a
 * number that gates nothing, and stays so. This one was RULED a gate, because the ruling asks for
 * a guarantee of comparable opportunity at three players, which a number that gates nothing
 * cannot give. It runs in `sweep.mjs` after generation and after the shipped acceptance tier; no
 * ruleset reads the ceiling or the player count (rulesets take none), so none can redraw against
 * it; and the ceiling is a literal derived from the shipped boards. No other quality measure
 * becomes a gate without its own ruling.
 *
 * Kept out of `measure.ts` (which stays numbers only) and out of `src/sim/` (the generator is
 * tooling), in an importable module so the count dispatch and the comparison are under test --
 * `sweep.mjs` is a CLI the mutation harness cannot import, so it only calls `passesSpreadGate`.
 */

/** Float tolerance for the ceiling: path lengths are floating-point sums. */
export const SPREAD_TOLERANCE = 1e-9;

/**
 * The ceiling on a generated 3-player board's `pathSpread`.
 *
 * DERIVED, by the ruled rule: the maximum `pathSpread` at N=3 over the boards the catalog offers
 * at three players, rounded UP at two decimals (`ceilingFor`). Measured when this landed: the 6
 * offered boards span 0 (arena-01, arena-03) to 0.75 (arena-04, unrounded 0.75 exactly), so the
 * ceiling is 0.75 and refuses no board that ships. `spread-gate.test.ts` recomputes it by the
 * rule, so a board that raises the maximum fails that test instead of moving the bound silently.
 *
 * Six authored boards are not a sample of fair boards: this bounds a generated board by what
 * ships, nothing more. And `pathSpread` is the distance half only -- two spawns can be equally
 * far apart while one stands in the open; the exposure half is not built.
 */
export const THREE_PLAYER_SPREAD_CEILING = 0.75;

/** A maximum rounded up at two decimals, under the float tolerance. */
export function ceilingFor(maximum) {
  return Math.ceil((maximum - SPREAD_TOLERANCE) * 100) / 100;
}

/**
 * Whether a measured board passes the spread gate at `playerCount`.
 *
 * At three players: only with all three spawn pairs measured (`spawnPairs` 3, `unreachablePairs`
 * 0) and `pathSpread` at or below the ceiling, within the float tolerance. At any other count it
 * passes without reading `pathSpread`: at two there is one pair, so spread is 0 by construction,
 * and at four the shipped boards span 0.45-1.20 and no ruling gates them.
 *
 * @param {{ spawnPairs: number, unreachablePairs: number, pathSpread: number }} measures
 * @param {number} playerCount
 * @returns {boolean}
 */
export function passesSpreadGate(measures, playerCount) {
  if (playerCount !== 3) return true;
  if (measures.spawnPairs !== 3 || measures.unreachablePairs !== 0) return false;
  return measures.pathSpread <= THREE_PLAYER_SPREAD_CEILING + SPREAD_TOLERANCE;
}
