import { ARENA_DEFS } from '../../src/sim/arena';
import { evaluateVersusBoard } from '../../src/sim/versus-board';
import { measureBoard } from './measure';

/**
 * Measure every SHIPPED board with the quality tier, at every versus player count, and
 * print the table.
 *
 * This is the calibration step, and it comes before any generator exists on purpose. The
 * quality measures in `measure.ts` are numbers without a scale: "openSightFraction 0.31" is
 * meaningless until it sits beside the figure a board people have actually played scores.
 * The shipped boards are the only ground truth available -- five campaign arenas that have
 * been played through a campaign and three VS arenas authored, reviewed and playtested for
 * versus -- so their spread IS the target band, and a generated board is judged by whether
 * it lands inside it.
 *
 * WHAT THIS CANNOT TELL US, stated plainly: the shipped boards are 8 boards, not a sample
 * of good boards drawn from some population of them. A band derived from 8 authored maps
 * describes those maps. It cannot prove a board outside the band is bad, only that it is
 * unlike everything shipped -- which is a reason to look at it, not to reject it.
 *
 *   npx vite-node tools/mapgen/calibrate.mjs            # table
 *   npx vite-node tools/mapgen/calibrate.mjs --json     # machine-readable
 */

const COUNTS = [2, 3, 4];
const json = process.argv.includes('--json');

const rows = [];
for (const def of ARENA_DEFS) {
  for (const n of COUNTS) {
    const m = measureBoard(def, n, def.id);
    const verdict = evaluateVersusBoard(def, n);
    rows.push({ ...m, suitable: verdict.suitable, concealedPairs: verdict.concealedPairs, totalPairs: verdict.totalPairs });
  }
}

if (json) {
  console.log(JSON.stringify(rows, null, 1));
} else {
  const f = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : String(v));
  const head = [
    'board'.padEnd(12), 'N', 'ok', 'wall', 'dstr', 'cov', 'spc', 'legal', 'corr', 'open',
    'prs', 'unr', 'mine', 'pMin', 'pMax', 'sprd', 'rout', '2nd', '1way', 'sight', 'long',
    'bank', 'bOnly', 'rot',
  ];
  console.log(head.join('  '));
  for (const r of rows) {
    console.log([
      r.arenaId.padEnd(12),
      String(r.playerCount),
      r.suitable ? ' y' : ' N',
      f(r.wallFraction), f(r.destructibleFraction),
      String(r.coverPieces).padStart(3), f(r.coverSpacing, 1).padStart(3),
      f(r.legalAreaFraction), f(r.corridorAreaFraction), f(r.openGroundFraction),
      String(r.spawnPairs).padStart(3), String(r.unreachablePairs).padStart(3),
      String(r.mineGatedPairs).padStart(4),
      f(r.pathMin, 1).padStart(4), f(r.pathMax, 1).padStart(4), f(r.pathSpread),
      f(r.routeCount), f(r.secondRouteDetour), String(r.singleRoutePairs).padStart(4),
      f(r.openSightFraction), f(r.longestSightlineRelative),
      f(r.bankGain), f(r.bankOnlyFraction), f(r.asymmetryRotational),
    ].join('  '));
  }
  console.log();
  console.log('wall/dstr = fraction of cells walled / destructible; cov = merged wall rects;');
  console.log('spc = mean nearest-neighbour cover spacing (world units); legal = fraction of');
  console.log('board where a tank centre fits; corr/open = fraction of that with <=2 / >=6 of 8');
  console.log('directions clear for 1.5 tank diameters; prs = spawn pairs measured, unr =');
  console.log('unreachable even with destructibles gone, mine = routable only by mining through;');
  console.log('pMin/pMax = shortest/longest spawn-pair path (solid-only space); sprd =');
  console.log('(max-min)/mean; rout = mean route-disjoint ways between a pair, capped at 3;');
  console.log('2nd = second route length over first; 1way = pairs with a single route;');
  console.log('sight = mean fraction of sample points in direct view; long = longest sightline');
  console.log('over board diagonal; bank = of pairs with no direct shot and within 9 units, the');
  console.log('fraction one bounce reaches; bOnly = that as a fraction of ALL pairs in reach;');
  console.log('rot = fraction of cells disagreeing under 180-degree rotation.');
}
