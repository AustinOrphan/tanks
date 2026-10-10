// #1013 chunk contents: read every .js.map's `sources` from a sourcemap build, and check that
// the sourcemap build is the same build as the shipped dist (same file names, and the same bytes
// once the trailing sourceMappingURL comment is removed).
//   node chunk-sources-1013.mjs <worktree> <smapDir> <out.json>
// Each map's sources are relative to the map's own directory, so they are resolved there and
// reported relative to the worktree.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const [root, smap, out] = process.argv.slice(2);
const dist = join(root, 'dist');
const distAssets = join(dist, 'assets');
const smapAssets = join(smap, 'assets');
const distJs = readdirSync(distAssets).filter((f) => f.endsWith('.js')).sort();
const smapJs = readdirSync(smapAssets).filter((f) => f.endsWith('.js')).sort();
const sameNames = JSON.stringify(distJs) === JSON.stringify(smapJs);

const chunks = smapJs.map((file) => {
  const map = JSON.parse(readFileSync(join(smapAssets, `${file}.map`), 'utf8'));
  const sources = map.sources.map((s) => relative(root, resolve(smapAssets, map.sourceRoot ?? '', s)));
  const smapText = readFileSync(join(smapAssets, file), 'utf8');
  const stripped = smapText.replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/, '');
  let distText = null;
  try { distText = readFileSync(join(distAssets, file), 'utf8'); } catch { /* reported */ }
  return {
    file,
    distBytes: distText === null ? null : statSync(join(distAssets, file)).size,
    identicalToDistAfterMapComment: distText !== null && (stripped === distText || stripped === distText.replace(/\n$/, '')),
    sourceCount: sources.length,
    srcSources: sources.filter((s) => s.startsWith('src/')),
    nonSrcSources: sources.filter((s) => !s.startsWith('src/')),
    containsControllerSelftest: sources.some((s) => /(^|\/)controller-selftest\.ts$/.test(s)),
  };
});

// The shipped entry chunk keeps only a reference to the lazy chunk's file name (the target of
// the dynamic import), not its body.
const entry = distJs.find((f) => f.startsWith('index-'));
const entryText = readFileSync(join(distAssets, entry), 'utf8');
const selftestChunk = distJs.find((f) => f.startsWith('controller-selftest-'));
const refs = entryText.split(selftestChunk).length - 1;

const result = { sameNames, distJs, smapJs, entry, selftestChunk, entryReferencesSelftestChunkByName: refs, chunks };
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(`same file names in dist and sourcemap build: ${sameNames}`);
console.log(`entry ${entry} names ${selftestChunk} ${refs} time(s)`);
for (const c of chunks) {
  console.log(`${c.file}: dist ${c.distBytes} B, identical-after-map-comment=${c.identicalToDistAfterMapComment}, ` +
    `${c.sourceCount} sources (${c.srcSources.length} under src/, ${c.nonSrcSources.length} elsewhere), ` +
    `controller-selftest.ts=${c.containsControllerSelftest}`);
  if (c.srcSources.length <= 12) for (const s of c.srcSources) console.log(`   ${s}`);
  for (const s of c.nonSrcSources) console.log(`   (outside src/) ${s}`);
}
