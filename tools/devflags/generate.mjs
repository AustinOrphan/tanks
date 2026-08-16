#!/usr/bin/env node
/**
 * Regenerates docs/dev-flags.md from the FLAG_REGISTRY in src/game/devflags.ts.
 *
 *   npm run devflags:doc
 *
 * Needs vite-node (not plain node) for the same reason tools/baseline/tick-cost.mjs does:
 * src/game/devflags.ts's own imports are extensionless (`from '../sim/types'`), which is
 * valid TypeScript module resolution but not valid Node ESM without a resolver -- vite-node
 * is already a transitive dependency of vitest (node_modules/.bin/vite-node), so this adds
 * nothing new to install.
 *
 * tools/devflags/doc.test.ts regenerates the identical string under vitest and fails
 * `npm test` if it disagrees with what's committed here. This script is how you fix that
 * failure; editing the test or the doc by hand is not -- see that file's header.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registryKeyMismatch, FLAG_REGISTRY, DEV_FLAGS_OFF } from '../../src/game/devflags';
import { renderDevFlagsDoc } from './render';

const OUT = fileURLToPath(new URL('../../docs/dev-flags.md', import.meta.url));

// Belt-and-braces: vite-node strips types without checking them, so a broken
// `Record<keyof DevFlags, FlagSpec>` annotation (the compile-time half of the guarantee)
// would not stop this script from running under `tsc`-free execution. Refuse to write a
// doc that would misrepresent the registry rather than silently succeeding.
const mismatch = registryKeyMismatch(FLAG_REGISTRY, DEV_FLAGS_OFF);
if (mismatch.missing.length > 0 || mismatch.extra.length > 0) {
  console.error('FLAG_REGISTRY does not match DevFlags:', mismatch);
  process.exit(1);
}

const next = renderDevFlagsDoc();
const before = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
writeFileSync(OUT, next, 'utf8');
const after = readFileSync(OUT, 'utf8');
if (after !== next) {
  // Read back what was actually written -- a zero exit code is not verification.
  console.error('wrote docs/dev-flags.md but the read-back does not match what was generated');
  process.exit(1);
}
console.log(
  before === next
    ? `docs/dev-flags.md already up to date (${next.length} bytes)`
    : `wrote docs/dev-flags.md (${next.length} bytes, was ${before === null ? 'missing' : `${before.length} bytes`})`,
);
