// #1014 chunk contents: read every .js.map's `sources` from a sourcemap build of a tree, and check
// that the sourcemap build is the same build as that tree's shipped dist (same file names, and the
// same bytes once the trailing sourceMappingURL comment is removed).
//   node chunk-sources-1014.mjs <tree> <smapDir> <out.json>
// Each map's sources are relative to the map's own directory, so they are resolved there and
// reported relative to the tree.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const [root, smap, out] = process.argv.slice(2);
if (!root || !smap || !out) throw new Error('usage: node chunk-sources-1014.mjs <tree> <smapDir> <out.json>');
const distAssets = join(root, 'dist', 'assets');
const smapAssets = join(smap, 'assets');
const distJs = readdirSync(distAssets).filter((f) => f.endsWith('.js')).sort();
const smapJs = readdirSync(smapAssets).filter((f) => f.endsWith('.js')).sort();
const sameNames = JSON.stringify(distJs) === JSON.stringify(smapJs);
const MODULES = ['src/game/dev-actions.ts', 'src/game/dev-diagnostics.ts', 'src/game/dev-exports.ts'];

const chunks = smapJs.map((file) => {
  const map = JSON.parse(readFileSync(join(smapAssets, `${file}.map`), 'utf8'));
  const sources = map.sources.map((s) => relative(root, resolve(smapAssets, map.sourceRoot ?? '', s)));
  const smapText = readFileSync(join(smapAssets, file), 'utf8');
  const stripped = smapText.replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/, '');
  let distText = null;
  try { distText = readFileSync(join(distAssets, file), 'utf8'); } catch { /* reported as null */ }
  return {
    file,
    distBytes: distText === null ? null : statSync(join(distAssets, file)).size,
    identicalToDistAfterMapComment: distText !== null && (stripped === distText || stripped === distText.replace(/\n$/, '')),
    sourceCount: sources.length,
    srcSources: sources.filter((s) => s.startsWith('src/')),
    nonSrcSources: sources.filter((s) => !s.startsWith('src/')),
    devModules: MODULES.filter((m) => sources.includes(m)),
  };
});

// Which chunk holds each of the three modules, and how many chunks do (exactly one expected).
const holders = Object.fromEntries(MODULES.map((m) => [m, chunks.filter((c) => c.devModules.includes(m)).map((c) => c.file)]));
// Every file the shipped entry chunk names, which is what a dynamic import or a static import of a
// split chunk points at.
const entry = distJs.find((f) => f.startsWith('index-'));
const entryText = readFileSync(join(distAssets, entry), 'utf8');
const namedByEntry = distJs.filter((f) => f !== entry && entryText.includes(f)).map((f) => ({ file: f, times: entryText.split(f).length - 1 }));
const indexHtml = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
const namedByIndexHtml = distJs.filter((f) => indexHtml.includes(f));

const result = { root, smap, sameNames, distJs, smapJs, entry, namedByIndexHtml, namedByEntry, holders, chunks };
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(`tree ${root}`);
console.log(`same file names in dist and sourcemap build: ${sameNames}`);
console.log(`dist/index.html names: ${namedByIndexHtml.join(' ')}`);
console.log(`entry ${entry} names: ${namedByEntry.map((n) => `${n.file} x${n.times}`).join(', ') || '(none)'}`);
for (const [m, h] of Object.entries(holders)) console.log(`${m} is in: ${h.join(' ') || '(no chunk)'}`);
for (const c of chunks) {
  console.log(`${c.file}: dist ${c.distBytes} B, identical-after-map-comment=${c.identicalToDistAfterMapComment}, ` +
    `${c.sourceCount} sources (${c.srcSources.length} under src/, ${c.nonSrcSources.length} elsewhere), dev modules: ${c.devModules.join(' ') || 'none'}`);
  if (c.srcSources.length <= 40) for (const s of c.srcSources) console.log(`   ${s}`);
  for (const s of c.nonSrcSources) console.log(`   (outside src/) ${s}`);
}
