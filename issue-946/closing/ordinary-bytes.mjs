// Every resource the ordinary arm requested (probe-<label>.json), by type, raw and gzip -9 per
// file (the bundle budget's gzipSize), mapped to the tree's dist. Before and after.
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const A = '/Users/austinorphan/.claude/jobs/e6e7bb6c/tmp/closing/946-251';
for (const label of ['before', 'after']) {
  const probe = JSON.parse(readFileSync(join(A, 'scripts', `probe-${label}.json`), 'utf8'));
  const dist = join(A, 'trees', label, 'dist');
  const reqs = probe.arms.ordinary.requests;
  const byType = {};
  const seen = new Set();
  for (const r of reqs) {
    let p = new URL(r.url).pathname;
    if (p === '/') p = '/index.html';
    if (seen.has(p)) continue;
    seen.add(p);
    const file = join(dist, p);
    if (!existsSync(file)) { console.log(`${label}: ${p} not in dist (${r.type})`); continue; }
    const b = readFileSync(file);
    const t = (byType[r.type] ??= { files: [], raw: 0, gzip: 0 });
    t.files.push(p);
    t.raw += b.length;
    t.gzip += gzipSync(b, { level: 9 }).length;
  }
  let raw = 0;
  let gzip = 0;
  console.log(`== ${label}: ${seen.size} distinct requests in the ordinary arm (load, menu, round)`);
  for (const [type, t] of Object.entries(byType)) {
    raw += t.raw; gzip += t.gzip;
    console.log(`  ${type}: ${t.files.length} file(s), ${t.raw.toLocaleString('en-US')} raw / ${t.gzip.toLocaleString('en-US')} gzip  ${t.files.join(' ')}`);
  }
  console.log(`  all types: ${raw.toLocaleString('en-US')} raw / ${gzip.toLocaleString('en-US')} gzip`);
}
