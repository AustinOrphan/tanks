import { readdirSync, readFileSync } from 'node:fs';
import { RULESETS } from './rulesets.mjs';
import { ARENA_DEFS } from '../../src/sim/arena';
import { MIN_WALL_BLOCK_CELLS, interiorShare, thinShare, wallCellTest, wallComponentSizes } from './measure';
import { seedRange } from './lib.mjs';
import { spreadOf } from './expressive-range.mjs';
import { INTERIOR_SHARE_MAX, INTERIOR_SHARE_MIN, THIN_SHARE_CEILING } from './thickness-gate.mjs';

/**
 * MORPHOLOGY: what a board is made of, as distinct from how it plays.
 *
 * The quality tier in `measure.ts` answers questions about movement, sight and fire. None of
 * them describe a board's SHAPE, and shape is where hand-authored boards and generated ones
 * turned out to differ most. Every statistic here is a plain property of the character grid:
 * nothing depends on spawns, on the sim, or on a player count.
 *
 * The finding this file was written to test, and which it confirmed: a wall cell counts as
 * INTERIOR when all four orthogonal neighbours are walled, and a bar one or two cells thick
 * can never have one. All 8 shipped boards measure an interior share between 0.09 and 0.34 --
 * a two-decimal record of that measurement, not a limit: 0.34 would refuse vs-quad-01's 0.3405.
 * The limit is the thickness gate's band, `INTERIOR_SHARE_MIN` and `INTERIOR_SHARE_MAX` in
 * `thickness-gate.mjs` (0.09 to 0.35 over the 9 boards that ship now, issue #1065).
 * When this file was written (issue #832, 2026-09-18), four of the five generators measured
 * exactly 0.00 -- they were building lines where every authored board builds masses. `runs`
 * places masses before its lines since issue #1066 and no longer does. Three cells is the
 * thinnest run that can have an interior, and three cells is 2.0 world units: two tank widths, a
 * block to circle rather than a line to shoot past.
 *
 * WALL MEANS A LEGEND CELL, solid or destructible (issue #1028): `wallCellTest` in `measure.ts`.
 * This file used to count every cell that was not `.`, so each spawn and enemy letter was a
 * one-cell wall "shape" -- and every generated board carries one `P` the same way. The shape
 * counts below are walls only; the interior band quoted above held at two decimals under the
 * correction (0.0940 to 0.3405, re-measured for #1028). An authored board with no legend is read
 * with `DEFAULT_LEGEND`. The component and thickness logic lives in `measure.ts`, where it is
 * tested -- the interior share and, beside it, the thin share (issue #1065): wall cells in
 * 8-connected components with no interior cell -- and this file is a smoke run that prints it.
 *
 *   npx vite-node tools/mapgen/morphology.mjs [--seeds 20] [--seed-offset 0]
 *   npx vite-node tools/mapgen/morphology.mjs --authored /path/to/exported/boards
 */
const DEFAULT_LEGEND = Object.freeze({ '#': 'solid', x: 'destructible' });

function stats(grid, cols, rows, legend = DEFAULT_LEGEND) {
  const board = { grid, cols, rows, legend };
  const wall = wallCellTest(board);
  const kind = (c, r) => grid[r][c];

  let wallCells = 0, softCells = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (wall(c, r)) wallCells++;
    if (kind(c, r) === 'x') softCells++;
  }

  // Connected wall components, 8-connected: "how many separate shapes is the board made of".
  const comps = wallComponentSizes(board, 8);
  const small = comps.filter((size) => size < MIN_WALL_BLOCK_CELLS).length;

  // Destructible components, 8-connected too -- massed in a block, or sprinkled?
  const N8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  const dseen = Array.from({ length: rows }, () => Array(cols).fill(false));
  let dcomps = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (kind(c, r) !== 'x' || dseen[r][c]) continue;
    dcomps++;
    const st = [[c, r]];
    dseen[r][c] = true;
    while (st.length) {
      const [cc, rr] = st.pop();
      for (const [dc, dr] of N8) {
        const nc = cc + dc, nr = rr + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        if (kind(nc, nr) !== 'x' || dseen[nr][nc]) continue;
        dseen[nr][nc] = true;
        st.push([nc, nr]);
      }
    }
  }

  // DIAGONALITY: a wall cell diagonally joined to another with neither shared orthogonal
  // neighbour walled is a staircase step -- the signature of a diagonal or curved run.
  let steps = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!wall(c, r)) continue;
    for (const [dc, dr] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
      if (!wall(c + dc, r + dr)) continue;
      if (!wall(c + dc, r) && !wall(c, r + dr)) { steps++; break; }
    }
  }

  return {
    wallCells,
    comps: comps.length,
    smallest: comps.length ? comps[comps.length - 1] : 0,
    small,
    smallShare: comps.length ? small / comps.length : 0,
    biggest: wallCells ? comps[0] / wallCells : 0,
    meanComp: comps.length ? wallCells / comps.length : 0,
    dcomps,
    softShare: wallCells ? softCells / wallCells : 0,
    // THICKNESS (issue #1065): `measure.ts`'s, so this prints the figures the gate reads.
    interior: interiorShare(board),
    thin: thinShare(board, 8),
    steps: wallCells ? steps / wallCells : 0,
  };
}

const f = (v, d = 2) => v.toFixed(d);
const rows = [];

// --- optional: a directory of hand-authored boards, one JSON per board ---
// Pass `--authored DIR` to include boards exported from the authoring tool. Each file holds
// `{name, cols, rows, grid, savedAt}` (or that under a `data` key). Absent, this section is
// skipped: the shipped boards alone are enough to read the table.
const authoredArg = process.argv.indexOf('--authored');
if (authoredArg > 0 && process.argv[authoredArg + 1]) {
  const DIR = process.argv[authoredArg + 1];
  const newest = new Map();
  for (const n of readdirSync(DIR)) {
    const raw = JSON.parse(readFileSync(`${DIR}/${n}`, 'utf8'));
    const d = raw.data ?? raw;
    if (!newest.has(d.name) || newest.get(d.name) < d.savedAt) newest.set(d.name, d.savedAt);
  }
  for (const n of readdirSync(DIR)) {
    const raw = JSON.parse(readFileSync(`${DIR}/${n}`, 'utf8'));
    const d = raw.data ?? raw;
    if (newest.get(d.name) !== d.savedAt) continue;
    rows.push({ who: 'authored', name: d.name, ...stats(String(d.grid).split('\n'), d.cols, d.rows) });
  }
}

// --- the shipped boards, the independent control ---
for (const def of ARENA_DEFS) {
  rows.push({ who: 'shipped', name: def.id, ...stats(def.grid, def.cols, def.rows, def.legend) });
}

// --- the generators, averaged over the seed range ---
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SEEDS = seedRange(Number(arg('--seed-offset', '0')), Number(arg('--seeds', '20')));
const jobs = [];
for (const key of Object.keys(RULESETS)) {
  jobs.push({ label: key, gen: (sd) => RULESETS[key].generate(sd) });
  if (key === 'spines') {
    for (const v of RULESETS[key].variants ?? []) {
      if (!String(v.label).startsWith('thick')) continue;
      jobs.push({ label: `spines ${v.label}`, gen: (sd) => RULESETS[key].generate(sd, v.opts) });
    }
  }
}
for (const job of jobs) {
  const key = job.label;
  const acc = [];
  for (const seed of SEEDS) {
    const a = job.gen(seed);
    acc.push(stats(a.grid, a.cols, a.rows, a.legend));
  }
  const mean = (k) => acc.reduce((s, x) => s + x[k], 0) / acc.length;
  const shares = acc.map((x) => x.smallShare).sort((a, b) => a - b);
  rows.push({
    who: 'generated', name: key,
    wallCells: mean('wallCells'), comps: mean('comps'), smallest: mean('smallest'), small: mean('small'),
    biggest: mean('biggest'),
    meanComp: mean('meanComp'), dcomps: mean('dcomps'), softShare: mean('softShare'),
    interior: mean('interior'), thin: mean('thin'), steps: mean('steps'),
    // Block sizes per board (issue #1028): the share of a board's components below the
    // threshold, as a median and range over the seeds, and the share of boards with none.
    blocks: {
      median: shares[Math.floor((shares.length - 1) / 2)],
      min: shares[0],
      max: shares[shares.length - 1],
      none: acc.filter((x) => x.small === 0).length / acc.length,
    },
    // Thickness per board (issue #1065): min / median / max over the seeds, both shares.
    thickness: {
      interior: spreadOf(acc.map((x) => x.interior)),
      thin: spreadOf(acc.map((x) => x.thin)),
    },
  });
}

console.log(`seeds ${SEEDS[0]}-${SEEDS[SEEDS.length - 1]} for every generated row (${SEEDS.length} boards each)`);
console.log(`who        name             wall  shapes  min  <${MIN_WALL_BLOCK_CELLS}  biggest  mean  soft%  softblobs  interior    thin  diag`);
for (const r of rows) {
  console.log([
    r.who.padEnd(9), String(r.name).padEnd(16),
    String(Math.round(r.wallCells)).padStart(4),
    f(r.comps, 1).padStart(6), f(r.smallest, 0).padStart(3), f(r.small, 1).padStart(4),
    f(r.biggest).padStart(7), f(r.meanComp, 1).padStart(5),
    f(r.softShare).padStart(5), f(r.dcomps, 1).padStart(9),
    f(r.interior, 4).padStart(8), f(r.thin, 4).padStart(6), f(r.steps).padStart(5),
  ].join('  '));
}
console.log();
console.log(`BLOCK SIZES per generated board: the share of its wall components below ${MIN_WALL_BLOCK_CELLS} cells`);
for (const r of rows.filter((x) => x.blocks)) {
  const b = r.blocks;
  console.log(`  ${String(r.name).padEnd(16)} median ${f(b.median)}  range ${f(b.min)}-${f(b.max)}  boards with none ${f(b.none)}`);
}
console.log();
console.log(`THICKNESS per generated row, over its ${SEEDS.length} seeds: min / median / max of each board's share`);
console.log(`(the gate's band is ${INTERIOR_SHARE_MIN}-${INTERIOR_SHARE_MAX} on the interior share; the thin share is reported against ${THIN_SHARE_CEILING})`);
for (const r of rows.filter((x) => x.thickness)) {
  const mmm = (s) => `${f(s.min, 3)} / ${f(s.median, 3)} / ${f(s.max, 3)}`;
  console.log(`  ${String(r.name).padEnd(18)} interior ${mmm(r.thickness.interior)}   thin ${mmm(r.thickness.thin)}`);
}
console.log();
console.log('shapes   = connected wall components, 8-connected, over wall (legend) cells only');
console.log(`min      = the smallest component, in cells; <${MIN_WALL_BLOCK_CELLS} = components below ${MIN_WALL_BLOCK_CELLS} cells`);
console.log('biggest  = largest component as a share of all wall cells');
console.log('mean     = mean cells per component');
console.log('softblobs= connected destructible components');
console.log('interior = share of wall cells with all 4 orthogonal neighbours walled (thickness)');
console.log('thin     = share of wall cells in 8-connected components with no interior cell');
console.log('diag     = share of wall cells forming a staircase step (diagonal or curved runs)');
