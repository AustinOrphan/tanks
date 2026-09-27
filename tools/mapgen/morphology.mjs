import { readdirSync, readFileSync } from 'node:fs';
import { RULESETS } from './rulesets.mjs';
import { ARENA_DEFS } from '../../src/sim/arena';

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
 *   npx vite-node tools/mapgen/morphology.mjs
 *   npx vite-node tools/mapgen/morphology.mjs --authored /path/to/exported/boards
 */
function stats(grid, cols, rows) {
  const wall = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows && grid[r][c] !== '.';
  const kind = (c, r) => grid[r][c];

  let wallCells = 0, softCells = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (wall(c, r)) wallCells++;
    if (kind(c, r) === 'x') softCells++;
  }

  // Connected wall components, 8-connected: "how many separate shapes is the board made of".
  const seen = Array.from({ length: rows }, () => Array(cols).fill(false));
  const comps = [];
  const N8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!wall(c, r) || seen[r][c]) continue;
    let size = 0;
    const st = [[c, r]];
    seen[r][c] = true;
    while (st.length) {
      const [cc, rr] = st.pop();
      size++;
      for (const [dc, dr] of N8) {
        const nc = cc + dc, nr = rr + dr;
        if (!wall(nc, nr) || seen[nr][nc]) continue;
        seen[nr][nc] = true;
        st.push([nc, nr]);
      }
    }
    comps.push(size);
  }
  comps.sort((a, b) => b - a);

  // Destructible components, same rule -- massed in a block, or sprinkled?
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
  rows.push({ who: 'shipped', name: def.id, ...stats(def.grid, def.cols, def.rows) });
}

// --- the generators, averaged over 20 seeds each ---
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
  for (let seed = 1; seed <= 20; seed++) {
    const a = job.gen(seed);
    acc.push(stats(a.grid, a.cols, a.rows));
  }
  const mean = (k) => acc.reduce((s, x) => s + x[k], 0) / acc.length;
  rows.push({
    who: 'generated', name: key,
    wallCells: mean('wallCells'), comps: mean('comps'), biggest: mean('biggest'),
    meanComp: mean('meanComp'), dcomps: mean('dcomps'), softShare: mean('softShare'),
    interior: mean('interior'), steps: mean('steps'),
  });
}

console.log('who        name             wall  shapes  biggest  mean  soft%  softblobs  interior  diag');
for (const r of rows) {
  console.log([
    r.who.padEnd(9), String(r.name).padEnd(16),
    String(Math.round(r.wallCells)).padStart(4),
    f(r.comps, 1).padStart(6), f(r.biggest).padStart(7), f(r.meanComp, 1).padStart(5),
    f(r.softShare).padStart(5), f(r.dcomps, 1).padStart(9),
    f(r.interior).padStart(8), f(r.steps).padStart(5),
  ].join('  '));
}
console.log();
console.log('shapes   = connected wall components, 8-connected: how many separate pieces');
console.log('biggest  = largest component as a share of all wall cells');
console.log('mean     = mean cells per component');
console.log('softblobs= connected destructible components');
console.log('interior = share of wall cells with all 4 orthogonal neighbours walled (thickness)');
console.log('diag     = share of wall cells forming a staircase step (diagonal or curved runs)');
