/**
 * The third-party notices generator, and the checker that keeps its output honest.
 *
 * Both of the packages the game ships are MIT, and MIT's one obligation is that "the
 * above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software". `dist/assets/index-*.js` is a substantial
 * portion of both, minified: the copyright notices do NOT survive the build. Measured on
 * the built bundle -- `mrdoob` appears 0 times, `goldfire` 0 times, `@license` 0 times,
 * while `HowlerGlobal` appears 7 times, `THREE` 125 and `WebGLRenderer` 35. So the
 * notice has to travel in a separate file, and this writes it. (An earlier draft said
 * "three's `REVISION` string is present" -- the TOKEN `REVISION` appears 0 times; what
 * survives is the value, as `three.js r169`. The point held, the probe named did not.)
 *
 * Two decisions are worth stating, because both were measured rather than assumed.
 *
 * SCOPE IS PRODUCTION-ONLY, and that is verified against the artifact rather than
 * inherited from npm's classification. `vite build --sourcemap` emits a `sources` array
 * naming every module that contributed code to the bundle: 75 sources, of which exactly
 * 2 distinct packages live under `node_modules/` -- `howler` and `three` -- and the rest
 * are this repo's own `src/`. That is the same set the lockfile's non-`dev` entries give,
 * so `--omit=dev` is a description of what ships here, not a convention borrowed from
 * elsewhere. The one thing a sourcemap cannot see is a helper the bundler INJECTS (it has
 * no source module), so `__vitePreload` -- the only such helper this config can emit --
 * was grepped for separately: 0 occurrences, because nothing here dynamically imports.
 *
 * THE SOURCE OF TRUTH IS THE LOCKFILE, not `npm ls`, so that generating is a pure
 * function of two files in the tree plus the licence texts on disk. `npm ls --omit=dev`
 * is used anyway -- but as an independent CROSS-CHECK in `notices.test.ts`, which is
 * worth more than using it directly would be: if npm's own classification ever disagrees
 * with the reading of `dev:` markers here, the test says so instead of both being wrong
 * in the same direction.
 *
 * A package with no licence file on disk is a hard FAILURE, not an omission. That is the
 * `hud.css` lesson applied to a legal artifact: a notices file that quietly lists a
 * package with no text under it is worse than no notices file, because it reads as having
 * been checked.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Where the generated file lives, relative to the repo root. */
export const NOTICES_PATH = 'THIRD-PARTY-NOTICES.md';

/**
 * The banner. Its job is to stop a human editing the file by hand -- the whole point of
 * generating it is that a dependency bump cannot leave it stale, and a hand edit is
 * silently reverted by the next `npm run notices`.
 */
export const GENERATED_BANNER =
  '<!-- GENERATED FILE -- do not edit by hand. Run `npm run notices`. -->';

/**
 * Filenames a package may put its licence in, in the order they are preferred.
 *
 * Case is not fixed by any standard (`LICENSE`, `LICENCE`, `license.md`), so the match is
 * case-insensitive over the package's real directory listing rather than a stat of each
 * candidate -- `three` ships `LICENSE`, `howler` ships `LICENSE.md`, and a future
 * dependency may ship `COPYING`.
 */
export const LICENCE_FILENAMES = [
  'license',
  'license.md',
  'license.txt',
  'licence',
  'licence.md',
  'licence.txt',
  'copying',
  'copying.md',
  'license-mit',
  'license-mit.txt',
];

/**
 * Every package that ships, read out of a parsed `package-lock.json`.
 *
 * npm's lockfile v3 marks each entry with the trees it is reachable from. `dev: true`
 * means dev-only; `devOptional: true` means reachable from BOTH the dev tree and as an
 * optional dependency of something that ships, which is why it is kept rather than
 * dropped -- it can end up in the bundle. Neither case exists in this tree today: of 191
 * entries, 189 are `dev` and 2 are production, and `devOptional`, `link` and `extraneous`
 * are all 0. `optional` is NOT 0 -- it is 87 -- but every one of those is also `dev`, so
 * none reaches the ship set. An earlier draft of this comment said `optional` was 0 too,
 * which was simply wrong; the true split is 102 plain-dev + 87 dev-and-optional. The
 * branches are here because the classification is npm's to change, not because they fire.
 *
 * @param {unknown} lock parsed package-lock.json
 * @returns {{path: string, name: string, version: string, declaredLicense: string|null}[]}
 *   sorted by name, then version
 */
export function productionEntries(lock) {
  const packages = lock && typeof lock === 'object' ? lock.packages : null;
  if (!packages || typeof packages !== 'object') {
    throw new Error(
      'package-lock.json has no `packages` map -- lockfileVersion 2 or 3 is required. ' +
        'A v1 lockfile carries no dev/prod markers, so nothing here can tell what ships.',
    );
  }
  const entries = [];
  for (const [path, meta] of Object.entries(packages)) {
    if (path === '') continue; // the root project itself
    if (!meta || typeof meta !== 'object') continue;
    // `dev` and `devOptional` are mutually exclusive in npm's output (measured: 0 of the
    // 191 entries in this lockfile carry both), so dropping `dev` keeps `devOptional`.
    if (meta.dev) continue;
    if (meta.extraneous) continue;
    if (meta.link) continue; // a workspace symlink, not third-party code
    entries.push({
      path,
      name: meta.name ?? nameFromPath(path),
      version: meta.version ?? '',
      declaredLicense: typeof meta.license === 'string' ? meta.license : null,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return entries;
}

/** `node_modules/a/node_modules/@scope/b` -> `@scope/b`. */
function nameFromPath(path) {
  const i = path.lastIndexOf('node_modules/');
  return i < 0 ? path : path.slice(i + 'node_modules/'.length);
}

/**
 * The licence text a package ships, read from its own directory.
 *
 * @param {string} dir absolute path to the package
 * @returns {{file: string, text: string} | null} null when the package ships none
 */
export function readLicenceFile(dir) {
  let listing;
  try {
    listing = readdirSync(dir);
  } catch {
    return null;
  }
  const byLower = new Map(listing.map((f) => [f.toLowerCase(), f]));
  for (const candidate of LICENCE_FILENAMES) {
    const real = byLower.get(candidate);
    if (!real) continue;
    const text = readFileSync(join(dir, real), 'utf8').replace(/\r\n/g, '\n').trim();
    if (text.length === 0) continue; // an empty LICENSE is the same as none
    return { file: real, text };
  }
  return null;
}

/**
 * Pair each shipped package with its licence text and the metadata worth reproducing.
 *
 * @param {string} root repo root
 * @returns {{entries: object[], failures: string[]}}
 */
export function collect(root) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const failures = [];
  const entries = [];
  for (const entry of productionEntries(lock)) {
    const dir = join(root, entry.path);
    if (!existsSync(dir)) {
      failures.push(
        `${entry.name}@${entry.version} is in the lockfile as a shipped dependency but ` +
          `${entry.path} is not installed -- run \`npm ci\` before regenerating.`,
      );
      continue;
    }
    let pkg = {};
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      /* fall through to the declaredLicense from the lockfile */
    }
    const licence = readLicenceFile(dir);
    if (!licence) {
      failures.push(
        `${entry.name}@${entry.version} ships no licence file (looked for ` +
          `${LICENCE_FILENAMES.join(', ')} in ${entry.path}). A notices file that lists a ` +
          `package with no text under it reads as checked when it is not -- find the text, ` +
          `or drop the dependency.`,
      );
      continue;
    }
    entries.push({
      name: entry.name,
      version: entry.version,
      // Type-guarded for the same reason `declaredLicense` is, which an earlier version
      // of this line was not: npm's legacy form is an OBJECT (`{type, url}`), and older
      // packages still ship it. Unguarded, `??` accepts it happily and the rendered line
      // reads `- Licence: [object Object]` -- in a legal artifact, generated, committed
      // and then agreed with forever by the round-trip test.
      licence:
        (typeof pkg.license === 'string' ? pkg.license : null) ??
        (pkg.license && typeof pkg.license === 'object' && typeof pkg.license.type === 'string'
          ? pkg.license.type
          : null) ??
        entry.declaredLicense ??
        'see text below',
      homepage: typeof pkg.homepage === 'string' ? pkg.homepage : null,
      repository: repoUrl(pkg.repository),
      licenceFile: `${entry.path}/${licence.file}`,
      text: licence.text,
    });
  }
  return { entries, failures };
}

/** npm allows a string, or `{url}` with any of git://, git+https://, or a bare shorthand. */
function repoUrl(repository) {
  const raw =
    typeof repository === 'string'
      ? repository
      : repository && typeof repository.url === 'string'
        ? repository.url
        : null;
  if (!raw) return null;
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');
}

/**
 * A fence long enough that the licence text cannot close it early.
 *
 * Not hypothetical: a licence that quotes a code sample (Apache-2.0's appendix does) can
 * carry a triple backtick, and the notices file would then render the rest of that
 * package's terms as prose and the next package's heading as code.
 */
function fenceFor(text) {
  const longest = (text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * Render the notices file.
 *
 * Deterministic by construction: no timestamp, no generator version, entries in the order
 * `productionEntries` sorted them. A file that changed on every run could not be diffed,
 * and `--check` would be permanently red.
 *
 * @param {object[]} entries from `collect`
 * @returns {string}
 */
export function renderNotices(entries) {
  const out = [];
  out.push('# Third-party notices');
  out.push('');
  out.push(GENERATED_BANNER);
  out.push('');
  out.push(
    'Tanks! bundles the software listed below. Every one of these licences requires its',
    'copyright notice and permission notice to travel with any copy of the software, and',
    'the build strips both: the minified bundle in `dist/` keeps the code and drops the',
    'notices. This file is where they travel -- for anyone receiving this repository.',
    'It is NOT copied into `dist/`, so a deployed build still carries neither.',
    '',
    'Scope: the packages whose code actually reaches `dist/`, which is the lockfile\'s',
    'non-development closure. That set was checked against the artifact rather than',
    'assumed -- a `--sourcemap` build names every module that contributed code, and the',
    'only `node_modules/` packages among them are the ones below. Build-time tooling',
    '(vite, vitest, typescript, jsdom and their trees) is deliberately absent: none of it',
    'ships, so none of it is distributed, so none of its notices are owed here.',
    '',
    'The terms of Tanks! itself are in [LICENSE](LICENSE), and are not affected by',
    'anything in this file.',
    '',
  );
  for (const e of entries) {
    out.push(`## ${e.name} ${e.version}`);
    out.push('');
    out.push(`- Licence: ${e.licence}`);
    if (e.homepage) out.push(`- Homepage: ${e.homepage}`);
    if (e.repository) out.push(`- Source: ${e.repository}`);
    out.push(`- Reproduced from: \`${e.licenceFile}\``);
    out.push('');
    const fence = fenceFor(e.text);
    out.push(fence);
    out.push(e.text);
    out.push(fence);
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

/**
 * Generate, and say what went wrong rather than writing a half-file.
 *
 * @param {string} root
 * @returns {{text: string|null, failures: string[]}}
 */
export function buildNotices(root) {
  const { entries, failures } = collect(root);
  if (entries.length === 0) {
    failures.push(
      'no shipped dependencies were found at all -- either node_modules is missing or the ' +
        'lockfile has no production entries. Refusing to write an empty notices file, ' +
        'which would read as "nothing is owed" rather than as "nothing was checked".',
    );
  }
  if (failures.length) return { text: null, failures };
  return { text: renderNotices(entries), failures };
}

/** The repo root, from this file's location. */
export function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

// CLI only when invoked directly, so the test can import the pure functions.
//
// INVOKE THE CHECK AS `npm run notices -- --check`. The `--` is not optional and its
// absence is SILENT: npm parses a bare `--check` as its own config flag and never passes
// it on, so `npm run notices --check` takes the WRITE path and exits 0. Measured:
//
//   $ npm run notices --check        -> "THIRD-PARTY-NOTICES.md: 2 package(s) unchanged"
//   $ npm run notices -- --check     -> "THIRD-PARTY-NOTICES.md matches the dependency tree"
//
// The first line is the write path reporting that it rewrote identical bytes. Anyone
// promoting this to a CI step with the bare form would add a check that cannot fail --
// which is a failure mode this repo has hit before and now has a rule about. Running
// `node tools/notices/notices.mjs --check` directly has no such trap.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { writeFileSync } = await import('node:fs');
  const root = repoRoot();
  const check = process.argv.includes('--check');
  const { text, failures } = buildNotices(root);
  if (failures.length || text === null) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  const target = join(root, NOTICES_PATH);
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (check) {
    if (current !== text) {
      console.error(
        `${NOTICES_PATH} is out of date with the dependency tree. Run \`npm run notices\`.`,
      );
      process.exit(1);
    }
    console.log(`${NOTICES_PATH} matches the dependency tree`);
  } else {
    writeFileSync(target, text);
    // Read back what was written: a zero exit from writeFileSync is not verification.
    if (readFileSync(target, 'utf8') !== text) {
      console.error(`${NOTICES_PATH} was written but does not read back as generated`);
      process.exit(1);
    }
    const n = (text.match(/^## /gm) ?? []).length;
    console.log(`${NOTICES_PATH}: ${n} package(s) ${current === text ? 'unchanged' : 'written'}`);
  }
}
