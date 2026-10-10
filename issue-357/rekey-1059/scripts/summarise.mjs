// Summarise a role-cue-overlap JSON (software GL) and cross-check it against a host-GPU JSON.
// Usage: node summarise.mjs <software.json> [<host.json>]
import { readFileSync } from 'node:fs';

const [swPath, hostPath] = process.argv.slice(2);
const sw = JSON.parse(readFileSync(swPath, 'utf8'));

const key = (r) => [r.kind, r.lever, r.event, r.preset, r.motion, r.pose, r.effect, r.tick].join('|');
const where = (r) => `${r.preset}, ${r.motion}, ${r.pose}, tick ${r.tick}`;

function summarise(t, label) {
  const rows = t.rows;
  console.log(`== ${label}: ${t.visual}, three ${t.installed}, ${t.width}x${t.height}, ticks ${t.ticks.join(',')}`);
  console.log(`rows: ${rows.length}`);
  const byPair = new Map();
  for (const r of rows) {
    const k = `${r.kind} ${r.lever}`;
    byPair.set(k, (byPair.get(k) ?? 0) + 1);
  }
  for (const [k, n] of byPair) {
    const cells = rows.filter((r) => `${r.kind} ${r.lever}` === k);
    const nonzero = cells.filter((r) => r.footprint > 0).length;
    console.log(`  ${k}: ${n} rows, ${nonzero} with nonzero footprint, ${n - nonzero} with zero footprint`);
  }
  const measured = rows.filter((r) => r.footprint > 0);
  const zero = rows.filter((r) => r.footprint === 0);
  console.log(`measured (footprint > 0): ${measured.length}; zero footprint: ${zero.length}`);
  const occluded = measured.filter((r) => r.retained === 0);
  console.log(`complete occlusion cells (footprint > 0, retained 0): ${occluded.length}`);
  for (const r of occluded) console.log(`  OCCLUDED ${key(r)}`);
  // Axes actually present.
  for (const axis of ['kind', 'lever', 'event', 'preset', 'motion', 'pose', 'effect', 'tick']) {
    console.log(`  axis ${axis}: ${[...new Set(rows.map((r) => r[axis]))].join(', ')}`);
  }
  // Worst cells per pair, event, effect.
  console.log('worst per pair/event/effect (measured cells only):');
  const groups = new Map();
  for (const r of measured) {
    const k = `${r.kind} ${r.lever} | ${r.event} | ${r.effect}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [k, g] of groups) {
    const fps = g.map((r) => r.footprint);
    const minRet = g.reduce((a, b) => (b.retainedFraction < a.retainedFraction ? b : a));
    const minDim = g.reduce((a, b) => (b.dimRatio < a.dimRatio ? b : a));
    console.log(`  ${k} | n=${g.length} | footprint ${Math.min(...fps)}-${Math.max(...fps)} | worst retained ${(minRet.retainedFraction * 100).toFixed(1)}% (${minRet.retained}/${minRet.footprint}, ${where(minRet)}) | worst dim ${minDim.dimRatio.toFixed(3)} (${where(minDim)})`);
  }
  // Per pair ranges of footprint.
  console.log('footprint range per pair:');
  for (const k of byPair.keys()) {
    const g = measured.filter((r) => `${r.kind} ${r.lever}` === k);
    if (g.length) console.log(`  ${k}: ${Math.min(...g.map((r) => r.footprint))}-${Math.max(...g.map((r) => r.footprint))}`);
  }
  const overallRet = measured.reduce((a, b) => (b.retainedFraction < a.retainedFraction ? b : a));
  const overallDim = measured.reduce((a, b) => (b.dimRatio < a.dimRatio ? b : a));
  console.log(`overall worst retained: ${key(overallRet)} ${overallRet.retained}/${overallRet.footprint} = ${(overallRet.retainedFraction * 100).toFixed(2)}% dim ${overallRet.dimRatio.toFixed(3)}`);
  console.log(`overall worst dim: ${key(overallDim)} ${overallDim.retained}/${overallDim.footprint} dim ${overallDim.dimRatio.toFixed(3)}`);
  const below100 = measured.filter((r) => r.retained < r.footprint).length;
  const dimBelow1 = measured.filter((r) => r.dimRatio < 1).length;
  console.log(`measured cells with any footprint pixel lost: ${below100} of ${measured.length}; with dim ratio < 1: ${dimBelow1}`);
  // Controls.
  const c = t.controls;
  const failed = c.filter((x) => !x.pass);
  console.log(`controls: ${c.length}, failed ${failed.length}`);
  const kinds = new Map();
  for (const x of c) {
    const fam = x.name.startsWith('unarmed vs unarmed') ? 'determinism'
      : x.name.startsWith('opaque patch') ? 'opaque patch'
        : x.name.startsWith('smoke drawn') ? 'smoke ignores pos'
          : x.name.startsWith('staging guard') ? 'staging guard'
            : x.name.startsWith('check:') ? 'zero-by-construction check' : `other: ${x.name}`;
    kinds.set(fam, (kinds.get(fam) ?? 0) + 1);
  }
  for (const [k, n] of kinds) console.log(`  ${k}: ${n}`);
  for (const x of c.filter((y) => y.name.startsWith('staging') || y.name.startsWith('check:'))) console.log(`  ${x.name}: ${x.pass ? 'pass' : 'FAIL'} (${x.detail})`);
  for (const x of failed) console.log(`  FAILED ${x.name} ${x.preset} ${x.motion} ${x.pose}: ${x.detail}`);
  const patchWorst = c.filter((x) => x.name.startsWith('opaque patch')).map((x) => x.detail);
  console.log(`  opaque patch details (distinct): ${[...new Set(patchWorst.map((d) => d.replace(/of \d+/, 'of N')))].join('; ')}`);
  return { rows, measured };
}

const a = summarise(sw, 'A');
if (hostPath) {
  const host = JSON.parse(readFileSync(hostPath, 'utf8'));
  const b = summarise(host, 'B');
  const map = new Map(b.rows.map((r) => [key(r), r]));
  let maxRet = 0; let maxDim = 0; let maxFp = 0; let compared = 0; let missing = 0;
  let maxRetAt = ''; let maxDimAt = ''; let maxFpAt = '';
  for (const r of a.measured) {
    const h = map.get(key(r));
    if (!h) { missing++; continue; }
    if (h.footprint === 0) { console.log(`host footprint 0 where software nonzero: ${key(r)}`); continue; }
    compared++;
    const dr = Math.abs(r.retainedFraction - h.retainedFraction) * 100;
    const dd = Math.abs(r.dimRatio - h.dimRatio);
    const df = Math.abs(r.footprint - h.footprint) / Math.min(r.footprint, h.footprint) * 100;
    if (dr > maxRet) { maxRet = dr; maxRetAt = key(r); }
    if (dd > maxDim) { maxDim = dd; maxDimAt = key(r); }
    if (df > maxFp) { maxFp = df; maxFpAt = key(r); }
  }
  console.log(`== cross-check over ${compared} cells (missing in host: ${missing})`);
  console.log(`max |retained| diff: ${maxRet.toFixed(2)} points at ${maxRetAt}`);
  console.log(`max |dim ratio| diff: ${maxDim.toFixed(3)} at ${maxDimAt}`);
  console.log(`max footprint size diff: ${maxFp.toFixed(1)}% (of the smaller of the two footprints) at ${maxFpAt}`);
}
