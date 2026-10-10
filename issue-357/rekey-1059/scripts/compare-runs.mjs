// Compare two role-cue-overlap JSONs row by row, per (kind, lever) pair, and map one pair onto
// another (e.g. the published brown riser onto this run's grey riser).
// Usage: node compare-runs.mjs <old.json> <new.json> [oldKind:newKind ...]
import { readFileSync } from 'node:fs';

const [oldPath, newPath, ...maps] = process.argv.slice(2);
const oldT = JSON.parse(readFileSync(oldPath, 'utf8'));
const newT = JSON.parse(readFileSync(newPath, 'utf8'));
const axes = (r) => [r.lever, r.event, r.preset, r.motion, r.pose, r.effect, r.tick].join('|');

function compare(oldKind, newKind, lever) {
  const o = oldT.rows.filter((r) => r.kind === oldKind && r.lever === lever);
  const n = new Map(newT.rows.filter((r) => r.kind === newKind && r.lever === lever).map((r) => [axes(r), r]));
  let same = 0; let diff = 0; let missing = 0; let maxFp = 0; let maxRet = 0; let maxDim = 0;
  for (const r of o) {
    const m = n.get(axes(r));
    if (!m) { missing++; continue; }
    if (m.footprint === r.footprint && m.retained === r.retained && m.dimRatio === r.dimRatio) same++;
    else {
      diff++;
      maxFp = Math.max(maxFp, Math.abs(m.footprint - r.footprint));
      if (r.retainedFraction !== null && m.retainedFraction !== null) maxRet = Math.max(maxRet, Math.abs(m.retainedFraction - r.retainedFraction) * 100);
      if (r.dimRatio !== null && m.dimRatio !== null) maxDim = Math.max(maxDim, Math.abs(m.dimRatio - r.dimRatio));
    }
  }
  console.log(`${oldKind} ${lever} (old) vs ${newKind} ${lever} (new): ${o.length} old rows, ${same} identical, ${diff} differ (max |footprint| ${maxFp} px, max |retained| ${maxRet.toFixed(2)} pts, max |dim| ${maxDim.toFixed(4)}), ${missing} missing`);
}

for (const [k, l] of [['olive', 'flare'], ['teal', 'flare'], ['teal', 'riser'], ['brown', 'flare']]) compare(k, k, l);
for (const m of maps) {
  const [a, b, lever] = m.split(':');
  compare(a, b, lever);
}
// Exact minimum dim ratio and retained per riser pair in the new table.
for (const kind of ['grey', 'teal']) {
  const g = newT.rows.filter((r) => r.kind === kind && r.lever === 'riser');
  const minDim = Math.min(...g.map((r) => r.dimRatio));
  const maxDim = Math.max(...g.map((r) => r.dimRatio));
  const lost = g.filter((r) => r.retained < r.footprint).length;
  console.log(`new ${kind} riser: ${g.length} cells, dim ratio ${minDim}..${maxDim}, cells losing any footprint pixel: ${lost}, cells with dim < 1: ${g.filter((r) => r.dimRatio < 1).length}`);
}
