// Analysis for #946's closing measurement (issue #1016).
// usage: node analyze.mjs <after tree> <before tree> <out.json>
// Reads each tree's dist/ (as shipped), dist-map/ (the same build with source maps) and the
// probe-<label>.json beside this script, and reports:
//   1. bytes: every JS file, raw and gzip (zlib level 9, the bundle budget's own gzipSize),
//      grouped into what the ordinary URL fetched and everything shipped;
//   2. attribution: bytes of each chunk attributed to each developer module by its source map;
//   3. probe strings: per developer module, a string literal from its source that occurs in no
//      other shipped source file, then where it lands in the built chunks.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';

const [afterTree, beforeTree, out] = process.argv.slice(2);
const HERE = dirname(new URL(import.meta.url).pathname);
const require = createRequire(join(afterTree, 'package.json'));
const { SourceMapConsumer } = require('source-map-js');

const DEV = [
  'src/game/devtools-menu.ts', 'src/game/dev-config.ts', 'src/game/dev-config-menu.ts',
  'src/game/dev-actions.ts', 'src/game/dev-exports.ts', 'src/game/dev-diagnostics.ts',
  'src/game/controller-selftest.ts', 'src/game/gallery-workbench.ts', 'src/game/gallery-selection.ts',
  'src/game/gallery-command.ts', 'src/render/gallery/moments.ts', 'src/render/gallery/moment-scene.ts',
  'src/render/gallery/subjects.ts', 'src/render/gallery/workbench-scene.ts',
];

const gz = (b) => gzipSync(b, { level: 9 }).length;

function walk(dir) {
  const outFiles = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) outFiles.push(...walk(full));
    else outFiles.push(full);
  }
  return outFiles;
}

function chunks(tree) {
  const dist = join(tree, 'dist');
  const map = join(tree, 'dist-map');
  const js = walk(dist).filter((f) => f.endsWith('.js')).map((f) => relative(dist, f)).sort();
  return js.map((name) => {
    const bytes = readFileSync(join(dist, name));
    const mapPath = join(map, `${name}.map`);
    const mapped = readFileSync(join(map, name), 'utf8');
    const raw = JSON.parse(readFileSync(mapPath, 'utf8'));
    const consumer = new SourceMapConsumer(raw);
    const lines = mapped.split('\n');
    const segs = new Map(); // line -> [{col, source}]
    consumer.eachMapping((m) => {
      const list = segs.get(m.generatedLine) ?? [];
      list.push({ col: m.generatedColumn, source: m.source });
      segs.set(m.generatedLine, list);
    });
    const bySource = {};
    let attributed = 0;
    for (const [line, list] of segs) {
      list.sort((a, b) => a.col - b.col);
      const text = lines[line - 1] ?? '';
      for (let i = 0; i < list.length; i++) {
        const end = i + 1 < list.length ? list[i + 1].col : text.length;
        const n = Buffer.byteLength(text.slice(list[i].col, end));
        const src = list[i].source ? normalize(list[i].source) : '(unmapped)';
        bySource[src] = (bySource[src] ?? 0) + n;
        attributed += n;
      }
    }
    return {
      name, raw: bytes.length, gzip: gz(bytes), text: bytes.toString('utf8'),
      sources: (raw.sources ?? []).map(normalize), bySource, attributed,
    };
  });
}

function normalize(s) {
  const i = s.indexOf('src/');
  if (i >= 0 && !s.includes('node_modules')) return s.slice(i);
  const n = s.indexOf('node_modules/');
  return n >= 0 ? s.slice(n) : s;
}

function fetched(probe, armName, phases) {
  const a = probe.arms[armName];
  return [...new Set(a.requests
    .filter((r) => r.url.endsWith('.js') && (phases === null || phases.includes(r.phase)))
    .map((r) => new URL(r.url).pathname.replace(/^\//, '')))];
}

// ---- probe strings, chosen from the after tree's source ----
function shippedSourceFiles(tree) {
  const files = walk(join(tree, 'src')).map((f) => relative(tree, f));
  files.push('index.html');
  for (const f of walk(join(tree, 'public'))) {
    const r = relative(tree, f);
    if (/\.(html|webmanifest|json|txt)$/.test(r)) files.push(r);
  }
  return files;
}

function candidates(src) {
  const outC = [];
  const re = /'([^'\\\n`$"]{12,})'|"([^"\\\n`$']{12,})"|`([^`\\\n$'"]{12,})`/g;
  for (const m of src.matchAll(re)) {
    const s = m[1] ?? m[2] ?? m[3];
    if (/[^\x20-\x7e]/.test(s)) continue;
    outC.push(s);
  }
  return outC;
}

/** Prose first: words with a capital or closing punctuation, then more words, then length. */
function score(s) {
  const words = s.trim().split(/\s+/).length;
  const prose = /[A-Z]/.test(s) && words >= 3 ? 1 : 0;
  const classy = /^[a-z0-9-]+( [a-z0-9-]+)*$/.test(s) && /(hud|ui)-/.test(s) ? 1 : 0;
  return [prose, -classy, words, s.length];
}
const better = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

const count = (hay, needle) => hay.split(needle).length - 1;

function chooseProbes(tree, afterChunks) {
  const files = shippedSourceFiles(tree);
  const contents = Object.fromEntries(files.map((f) => [f, readFileSync(join(tree, f), 'utf8')]));
  const probes = {};
  for (const mod of DEV) {
    let chosen = null;
    const tried = [];
    for (const s of candidates(contents[mod])) {
      const elsewhere = files.filter((f) => f !== mod && !/\.test\.ts$/.test(f) && contents[f].includes(s));
      const inTests = files.filter((f) => /\.test\.ts$/.test(f) && contents[f].includes(s));
      const inChunks = afterChunks.filter((c) => c.text.includes(s)).map((c) => c.name);
      tried.push(s);
      if (elsewhere.length !== 0 || inChunks.length !== 1) continue;
      const cand = { string: s, inTests, inChunks, sourceOccurrences: count(contents[mod], s),
        chunkOccurrences: count(afterChunks.find((c) => c.name === inChunks[0]).text, s) };
      if (chosen === null || better(score(s), score(chosen.string))) chosen = cand;
    }
    probes[mod] = chosen ?? { string: null, candidatesTried: tried.length };
  }
  return probes;
}

const after = chunks(afterTree);
const before = chunks(beforeTree);
const probeAfter = JSON.parse(readFileSync(join(HERE, 'probe-after.json'), 'utf8'));
const probeBefore = JSON.parse(readFileSync(join(HERE, 'probe-before.json'), 'utf8'));

function population(list, names) {
  const sel = list.filter((c) => names.includes(c.name));
  return {
    files: sel.map((c) => c.name),
    count: sel.length,
    raw: sel.reduce((n, c) => n + c.raw, 0),
    gzip: sel.reduce((n, c) => n + c.gzip, 0),
  };
}

function devAttribution(list, names) {
  const res = {};
  for (const mod of DEV) {
    res[mod] = list.filter((c) => names.includes(c.name))
      .reduce((n, c) => n + (c.bySource[mod] ?? 0), 0);
  }
  return res;
}

function chunkOf(list, mod) {
  return list.filter((c) => c.sources.includes(mod)).map((c) => c.name);
}

const report = {};
for (const [label, list, probe] of [['after', after, probeAfter], ['before', before, probeBefore]]) {
  const ordinary = fetched(probe, 'ordinary', null);
  const devLoads = {
    devtools: fetched(probe, 'devpanes', ['devtools-open']),
    config: fetched(probe, 'devpanes', ['config-open']),
    selftest: fetched(probe, 'devpanes', ['selftest-open']),
    gallery: fetched(probe, 'gallery', ['past-splash', 'gallery-open']),
  };
  const allNames = list.map((c) => c.name);
  report[label] = {
    chunks: list.map((c) => ({
      name: c.name, raw: c.raw, gzip: c.gzip,
      attributedShare: +(c.attributed / c.raw).toFixed(4),
      devSources: c.sources.filter((s) => DEV.includes(s)),
      firstParty: c.sources.filter((s) => s.startsWith('src/')).length,
    })),
    ordinary: population(list, ordinary),
    shipped: population(list, allNames),
    devLoads,
    ordinaryScripts: probe.arms.ordinary.requests.filter((r) => r.type === 'script').map((r) => `${r.phase} ${new URL(r.url).pathname}`),
    devAttributionInOrdinary: devAttribution(list, ordinary),
    devPlacement: Object.fromEntries(DEV.map((m) => [m, chunkOf(list, m)])),
  };
}

const probes = chooseProbes(afterTree, after);
for (const mod of DEV) {
  const p = probes[mod];
  if (!p.string) continue;
  for (const [label, list, probe] of [['after', after, probeAfter], ['before', before, probeBefore]]) {
    const ordinary = fetched(probe, 'ordinary', null);
    const anyDev = [...new Set([
      ...fetched(probe, 'devpanes', null), ...fetched(probe, 'gallery', null),
    ])].filter((n) => !ordinary.includes(n));
    p[label] = {
      inOrdinaryChunks: list.filter((c) => ordinary.includes(c.name) && c.text.includes(p.string)).map((c) => c.name),
      inOnDemandChunks: list.filter((c) => anyDev.includes(c.name) && c.text.includes(p.string)).map((c) => c.name),
      inAnyChunk: list.filter((c) => c.text.includes(p.string)).map((c) => c.name),
    };
  }
}
report.probes = probes;
writeFileSync(out, JSON.stringify(report, null, 2));

// ---- human summary ----
const f = (n) => n.toLocaleString('en-US');
for (const label of ['before', 'after']) {
  const r = report[label];
  console.log(`\n=== ${label}`);
  console.log(`ordinary URL fetched ${r.ordinary.count} of ${r.shipped.count} JS files: ${f(r.ordinary.raw)} raw / ${f(r.ordinary.gzip)} gzip`);
  console.log(`  ${r.ordinary.files.join(', ')}`);
  console.log(`all shipped JS: ${r.shipped.count} files, ${f(r.shipped.raw)} raw / ${f(r.shipped.gzip)} gzip`);
  console.log('scripts requested by the ordinary URL:', r.ordinaryScripts.join(' | '));
  for (const [k, v] of Object.entries(r.devLoads)) console.log(`  on demand, ${k}: ${v.join(', ') || '(none)'}`);
  const total = Object.values(r.devAttributionInOrdinary).reduce((a, b) => a + b, 0);
  console.log(`developer-module bytes attributed inside what the ordinary URL fetched: ${f(total)}`);
  for (const [m, n] of Object.entries(r.devAttributionInOrdinary)) console.log(`  ${m}: ${f(n)} B in ordinary chunks; placed in ${r.devPlacement[m].join(', ')}`);
  for (const c of r.chunks) console.log(`  chunk ${c.name}: ${f(c.raw)} / ${f(c.gzip)}; attributed ${c.attributedShare}; dev sources: ${c.devSources.join(', ') || '-'}`);
}
console.log('\n=== probes');
for (const [m, p] of Object.entries(probes)) {
  if (!p.string) { console.log(`${m}: NO unique probe string (${p.candidatesTried} candidates)`); continue; }
  console.log(`${m}: "${p.string}" tests:${p.inTests.length}`);
  console.log(`   after:  ordinary ${JSON.stringify(p.after.inOrdinaryChunks)} on-demand ${JSON.stringify(p.after.inOnDemandChunks)}`);
  console.log(`   before: ordinary ${JSON.stringify(p.before.inOrdinaryChunks)} on-demand ${JSON.stringify(p.before.inOnDemandChunks)} any ${JSON.stringify(p.before.inAnyChunk)}`);
}
