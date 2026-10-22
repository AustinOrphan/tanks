// The deployed site (Pages, built by CI from 1c3a193e): fetch the scripts its index.html loads
// and every on-demand chunk the live journey fetched, and look for each developer module's
// probe string (chosen by analyze.mjs) in both groups.
import { readFileSync } from 'node:fs';

const A = '/Users/austinorphan/.claude/jobs/e6e7bb6c/tmp/closing/946-251';
const base = 'https://austinorphan.com/tanks/';
const analysis = JSON.parse(readFileSync(`${A}/scripts/analysis.json`, 'utf8'));
const journey = JSON.parse(readFileSync(`${A}/journey-live.json`, 'utf8'));
const html = await (await fetch(base, { headers: { accept: 'text/html' } })).text();
const ordinary = [...new Set([...html.matchAll(/assets\/[A-Za-z0-9_.-]+\.js/g)].map((m) => m[0]))];
const loadJs = journey.requests.filter((r) => r.phase === 'load' && r.url.startsWith(base) && r.url.endsWith('.js'))
  .map((r) => r.url.slice(base.length));
const onDemand = [...new Set(journey.requests.filter((r) => r.phase !== 'load' && r.phase !== 'exit'
  && r.url.startsWith(base) && r.url.endsWith('.js')).map((r) => r.url.slice(base.length)))];
const text = {};
for (const f of [...ordinary, ...onDemand]) text[f] = await (await fetch(base + f)).text();
console.log(`ordinary (index.html): ${ordinary.join(', ')}`);
console.log(`ordinary (journey load step): ${loadJs.join(', ')}`);
console.log(`on demand (journey): ${onDemand.length} files`);
let missing = 0;
let leaked = 0;
for (const [mod, p] of Object.entries(analysis.probes)) {
  if (!p.string) { console.log(`${mod}: no probe string (source map only; no map on the deployed site)`); continue; }
  const inOrd = ordinary.filter((f) => text[f].includes(p.string));
  const inDem = onDemand.filter((f) => text[f].includes(p.string));
  if (inOrd.length) leaked++;
  if (!inDem.length) missing++;
  console.log(`${mod}: ordinary ${JSON.stringify(inOrd)} on-demand ${JSON.stringify(inDem)}`);
}
console.log(`probe strings in ordinary chunks: ${leaked}; probe strings missing from every on-demand chunk: ${missing}`);
