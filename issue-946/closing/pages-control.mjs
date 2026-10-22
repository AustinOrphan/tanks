// Negative control for the Pages-shaped serve: the same chunk resolves under /tanks/ and 404s
// at the origin root, so a developer chunk whose URL escaped the prefix would show as a 404.
import { pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';

const REPO = '/Users/austinorphan/src/tanks/.claude/worktrees/closing-946';
const { servePagesShape, PAGES_PREFIX } = await import(pathToFileURL(`${REPO}/tools/devtools-pages/check.mjs`).href);
const server = await servePagesShape(`${REPO}/dist`);
const port = server.address().port;
const chunks = readdirSync(`${REPO}/dist/assets`).filter((f) => /^(dev-|devtools-|controller-selftest|gallery-|workbench-scene)/.test(f) && f.endsWith('.js'));
try {
  for (const c of chunks) {
    const inPrefix = await fetch(`http://127.0.0.1:${port}${PAGES_PREFIX}assets/${c}`);
    const atRoot = await fetch(`http://127.0.0.1:${port}/assets/${c}`);
    console.log(`${c}: ${PAGES_PREFIX}assets -> ${inPrefix.status}; /assets -> ${atRoot.status}`);
  }
} finally {
  server.close();
}
console.log(`${chunks.length} on-demand chunks checked`);
