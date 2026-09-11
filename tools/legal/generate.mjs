#!/usr/bin/env node
/**
 * Regenerates src/game/legal-content.ts from the repository's legal documents (issue #117).
 *
 *   npm run legal
 *
 * tools/legal/generate.test.ts regenerates the identical string under vitest and fails
 * `npm test` if it disagrees with what's committed. This script is how you fix that
 * failure; editing the test or the generated module by hand is not -- see render.mjs's
 * header for why the content cannot simply be imported.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderLegalModule } from './render.mjs';

const OUT = fileURLToPath(new URL('../../src/game/legal-content.ts', import.meta.url));

const next = renderLegalModule();
const before = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
writeFileSync(OUT, next, 'utf8');

// Read back what was actually written -- a zero exit code is not verification.
const after = readFileSync(OUT, 'utf8');
if (after !== next) {
  console.error('wrote src/game/legal-content.ts but the read-back does not match what was generated');
  process.exit(1);
}

console.log(
  before === next
    ? `src/game/legal-content.ts already up to date (${next.length} bytes)`
    : `wrote src/game/legal-content.ts (${next.length} bytes, was ${before === null ? 'missing' : `${before.length} bytes`})`,
);
