/**
 * `npm run lint:css` (issue #763): check that every shipped stylesheet parses as written.
 * The checks and the discovery rule are in check.mjs; check.test.ts runs the same check in
 * `npm run test:unit`, which is how required CI enforces it.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'lightningcss';
import { checkSources, discoverSources } from './check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = discoverSources(ROOT);
const { units, reports } = checkSources(ROOT, files, transform);
for (const line of reports) console.error(line);
if (reports.length > 0) {
  console.error(`css integrity: ${reports.length} problem(s) in ${units} stylesheet(s) across ${files.length} file(s)`);
  process.exit(1);
}
console.log(`css integrity: ${units} stylesheet(s) across ${files.length} file(s) parse as written`);
