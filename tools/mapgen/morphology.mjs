import { readdirSync, readFileSync } from 'node:fs';
import { RULESETS } from './rulesets.mjs';
import { ARENA_DEFS } from '../../src/sim/arena';
import { MIN_WALL_BLOCK_CELLS, wallCellTest, wallComponentSizes } from './measure';
import { seedRange } from './lib.mjs';

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
 * can never have one. All 8 shipped boards measure an interior share between 0.09 and 0.34.
 * Four of the five generators measured exactly 0.00 -- they were building lines where every
 * authored board builds masses. Three cells is the thinnest run that can have an interior, and
 * three cells is 2.0 world units: two tank widths, a block to circle rather than a line to
 * shoot past.
 *
 * WALL MEANS A LEGEND CELL, solid or destructible (issue #1028): `wallCellTest` in `measure.ts`.
 * This file used to count every cell that was not `.`, so each spawn and enemy letter was a
 * one-cell wall "shape" -- and every generated board carries one `P` the same way. The shape
 * counts below are walls only; the interior band quoted above held at two decimals under the
 * correction (0.0940 to 0.3405, re-measured for #1028). An authored board with no legend is read
 * with `DEFAULT_LEGEND`. The component logic itself lives in `measure.ts`, where it is tested;
 * this file is a smoke run that prints it.
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

  // THICKNESS: a wall cell with all four orthogonal neighbours also wall is interior, which can
  // only happen in a mass at least 3 cells across one way. A one-cell-thick bar has none.
  let interior = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!wall(c, r)) continue;
    if (wall(c + 1, r) && wall(c - 1, r) && wall(c, r + 1) && wall(c, r - 1)) interior++;
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
    interior: wallCells ? interior / wallCells : 0,
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

// --- the eight shipped boards, the independent control ---
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
    interior: mean('interior'), steps: mean('steps'),
    // Block sizes per board (issue #1028): the share of a board's components below the
    // threshold, as a median and range over the seeds, and the share of boards with none.
    blocks: {
      median: shares[Math.floor((shares.length - 1) / 2)],
      min: shares[0],
      max: shares[shares.length - 1],
      none: acc.filter((x) => x.small === 0).length / acc.length,
    },
  });
}

console.log(`seeds ${SEEDS[0]}-${SEEDS[SEEDS.length - 1]} for every generated row (${SEEDS.length} boards each)`);
console.log(`who        name             wall  shapes  min  <${MIN_WALL_BLOCK_CELLS}  biggest  mean  soft%  softblobs  interior  diag`);
for (const r of rows) {
  console.log([
    r.who.padEnd(9), String(r.name).padEnd(16),
    String(Math.round(r.wallCells)).padStart(4),
    f(r.comps, 1).padStart(6), f(r.smallest, 0).padStart(3), f(r.small, 1).padStart(4),
    f(r.biggest).padStart(7), f(r.meanComp, 1).padStart(5),
    f(r.softShare).padStart(5), f(r.dcomps, 1).padStart(9),
    f(r.interior, 4).padStart(8), f(r.steps).padStart(5),
  ].join('  '));
}
console.log();
console.log(`BLOCK SIZES per generated board: the share of its wall components below ${MIN_WALL_BLOCK_CELLS} cells`);
for (const r of rows.filter((x) => x.blocks)) {
  const b = r.blocks;
  console.log(`  ${String(r.name).padEnd(16)} median ${f(b.median)}  range ${f(b.min)}-${f(b.max)}  boards with none ${f(b.none)}`);
}
console.log();
console.log('shapes   = connected wall components, 8-connected, over wall (legend) cells only');
console.log(`min      = the smallest component, in cells; <${MIN_WALL_BLOCK_CELLS} = components below ${MIN_WALL_BLOCK_CELLS} cells`);
console.log('biggest  = largest component as a share of all wall cells');
console.log('mean     = mean cells per component');
console.log('softblobs= connected destructible components');
console.log('interior = share of wall cells with all 4 orthogonal neighbours walled (thickness)');
console.log('diag     = share of wall cells forming a staircase step (diagonal or curved runs)');
