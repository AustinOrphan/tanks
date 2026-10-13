// #1014 byte populations, raw and gzip, from the probe outputs: each arm's requested files and
// every JS file shipped, for the branch and for origin/main. gzip is zlib level 9 per file, the
// same `gzipSize` tools/bundle-budget/check.mjs uses, summed over files.
//   node bytes-1014.mjs <requests-head.json> <requests-main.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const [headJson, mainJson, out] = process.argv.slice(2);
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const measure = (run, files) => {
  const rows = files.map((f) => {
    const buf = readFileSync(join(run.root, 'dist', 'assets', f));
    return { file: f, raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
  });
  return { files: rows.length, raw: rows.reduce((n, r) => n + r.raw, 0), gzip: rows.reduce((n, r) => n + r.gzip, 0), rows };
};
const populations = (run) => {
  const [ordinary, dev] = run.arms;
  return {
    ordinaryUrl: measure(run, ordinary.requested.files.map((f) => f.file)),
    devArmAll: measure(run, dev.requested.files.map((f) => f.file)),
    devArmOnOpen: measure(run, dev.snaps.find((s) => s.label.startsWith('Developer Tools open')).newSincePrevious),
    shipped: measure(run, run.dist.files.map((f) => f.file)),
  };
};
const head = populations(load(headJson));
const main = populations(load(mainJson));
const delta = Object.fromEntries(Object.keys(head).map((k) => [k, {
  files: head[k].files - main[k].files, raw: head[k].raw - main[k].raw, gzip: head[k].gzip - main[k].gzip,
}]));
writeFileSync(out, JSON.stringify({ head, main, delta }, null, 2) + '\n');
for (const k of Object.keys(head)) {
  console.log(`${k}: HEAD ${head[k].files} file(s) ${head[k].raw} B raw / ${head[k].gzip} B gzip; ` +
    `main ${main[k].files} file(s) ${main[k].raw} / ${main[k].gzip}; delta ${delta[k].files} file(s) ${delta[k].raw} raw / ${delta[k].gzip} gzip`);
  for (const r of head[k].rows) console.log(`   HEAD ${r.file} ${r.raw} / ${r.gzip}`);
  for (const r of main[k].rows) console.log(`   main ${r.file} ${r.raw} / ${r.gzip}`);
}
