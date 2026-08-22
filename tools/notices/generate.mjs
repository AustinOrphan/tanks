#!/usr/bin/env node
/**
 * Regenerates THIRD-PARTY-NOTICES.md from package.json's runtime "dependencies" and each
 * dependency's license file in node_modules.
 *
 *   npm run notices
 *
 * tools/notices/generate.test.ts regenerates the identical string under vitest and fails
 * `npm test` if it disagrees with what's committed here, or if a runtime dependency was
 * added without re-running this script. This script is how you fix that failure; editing
 * the test or THIRD-PARTY-NOTICES.md by hand is not -- see render.mjs's header and issue
 * #116 (the LICENSE-choice half of that issue is out of scope here; see the PR body).
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderNotices } from './render.mjs';

const OUT = fileURLToPath(new URL('../../THIRD-PARTY-NOTICES.md', import.meta.url));

const next = renderNotices();
const before = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
writeFileSync(OUT, next, 'utf8');

// Read back what was actually written -- a zero exit code is not verification.
const after = readFileSync(OUT, 'utf8');
if (after !== next) {
  console.error('wrote THIRD-PARTY-NOTICES.md but the read-back does not match what was generated');
  process.exit(1);
}

console.log(
  before === next
    ? `THIRD-PARTY-NOTICES.md already up to date (${next.length} bytes)`
    : `wrote THIRD-PARTY-NOTICES.md (${next.length} bytes, was ${before === null ? 'missing' : `${before.length} bytes`})`,
);
