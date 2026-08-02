/**
 * ONE-TIME 3x upscale of every shipped arena: cellSize 2 -> 2/3.
 *
 * Committed as the record of exactly what was done to the data, not as a tool anyone
 * runs again. Re-running it on already-upscaled data would produce 9x, so it refuses
 * unless every arena is still at cellSize 2.
 *
 * Why 3 and not 2: an ODD factor keeps every old cell centre as a new cell centre, so
 * spawns do not move and no seeded outcome changes. An even factor puts the old centre
 * on a boundary between two new cells. Verified in src/sim/resolution.test.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const N = 3;
const PATH = 'src/sim/config/data/arenas.json';
const SPAWN = /[PBGTON]/;

const data = JSON.parse(readFileSync(PATH, 'utf8'));
for (const a of data.arenas) {
  if (a.cellSize !== 2) {
    console.error(`${a.id} is at cellSize ${a.cellSize}, not 2 — refusing to upscale twice.`);
    process.exit(1);
  }
}

const mid = (N - 1) / 2; // 1 for N=3: the centre sub-cell

for (const a of data.arenas) {
  const grid = [];
  for (const row of a.grid) {
    for (let sr = 0; sr < N; sr++) {
      let out = '';
      for (const ch of row) {
        if (!SPAWN.test(ch)) { out += ch.repeat(N); continue; }
        // A spawn letter must NOT be duplicated: one letter, one tank. It takes the
        // block's centre sub-cell; the other eight become plain floor.
        for (let sc = 0; sc < N; sc++) out += (sr === mid && sc === mid) ? ch : '.';
      }
      grid.push(out);
    }
  }
  a.grid = grid;
  a.cols *= N;
  a.rows *= N;
  a.cellSize = 2 / N;
  for (const c of a.claims) {
    for (const key of ['from', 'to', 'enemy']) {
      if (Array.isArray(c[key])) c[key] = [c[key][0] * N + mid, c[key][1] * N + mid];
    }
  }
}

writeFileSync(PATH, JSON.stringify(data, null, 2) + '\n');
console.log(data.arenas.map((a) => `${a.id} -> ${a.cols}x${a.rows} @ ${a.cellSize}`).join('\n'));
