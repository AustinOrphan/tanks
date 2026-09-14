/**
 * The one place the tools family resolves Playwright (issue #692).
 *
 * Playwright is NOT a dependency of this repo: the package downloads browsers on install,
 * which would slow every CI run for tools most runs never use. CI installs it with
 * `npm i --no-save` in the jobs that need it, and a local run either does the same or points
 * `PLAYWRIGHT_MODULE` at an install elsewhere.
 *
 * WHY ONE COPY. This routine used to be written out separately in twelve tool files, with
 * differing candidate lists, error formats and fallbacks. Four of them still carried a
 * third candidate after `tools/visual/verify.mjs` documented removing it from its own copy:
 * an absolute path into one agent session's scratch directory on one machine, long gone.
 * A fix to the order landed in one sibling and not the others, so it lives here now.
 *
 * `PLAYWRIGHT_MODULE` is a PREFERENCE, not an override. A stale or mistyped value falls
 * through to the bare `playwright` specifier rather than ending the search, and the
 * aggregate error lists every specifier tried, so a moved install still reports what was
 * attempted. `tools/capture/prerequisites.mjs` shares the candidate order through
 * `playwrightCandidates` but keeps its own probe: it also pins the CI version and checks
 * the Chromium executable, which the other tools deliberately do not demand.
 *
 * Nothing here launches a browser or touches a socket, so a unit test can import it.
 */
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The specifiers to try, in order: `PLAYWRIGHT_MODULE` if set, then the bare `playwright`.
 * An empty value counts as unset, and a value of `playwright` is tried once.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function playwrightCandidates(env = process.env) {
  return [...new Set([env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean))];
}

/**
 * What to import for one candidate.
 *
 * An absolute path naming a DIRECTORY (a package root such as
 * `/somewhere/node_modules/playwright`) cannot be imported as-is: ESM refuses directory
 * imports with `ERR_UNSUPPORTED_DIR_IMPORT`. `tools/visual/roundtrip.mjs` accepted that form
 * by importing `<dir>/index.mjs`, so it is kept, and every other tool now accepts it too.
 * An absolute path with a script extension is imported directly.
 *
 * @param {string} candidate
 * @returns {string[]}
 */
function attemptsFor(candidate) {
  if (!isAbsolute(candidate) || /\.[cm]?js$/.test(candidate)) return [candidate];
  return [candidate, `${candidate}/index.mjs`];
}

/**
 * The Playwright module, for the tools that launch more than Chromium.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ importModule?: (specifier: string) => Promise<any> }} [options]
 *   `importModule` exists for tests that need a bare `playwright` to resolve or not
 *   regardless of this machine's install.
 * @returns {Promise<any>} a module with a `chromium` export
 */
export async function importPlaywright(env = process.env, { importModule = (specifier) => import(specifier) } = {}) {
  const tried = [];
  for (const candidate of playwrightCandidates(env)) {
    for (const path of attemptsFor(candidate)) {
      try {
        const module = await importModule(isAbsolute(path) ? pathToFileURL(path).href : path);
        if (module.chromium) return module;
        tried.push(`${path}: no chromium export`);
      } catch (error) {
        tried.push(`${path}: ${error.code ?? error.message}`);
      }
    }
  }
  throw new Error(
    'playwright not found. Set PLAYWRIGHT_MODULE to an install, or run npm i --no-save playwright.\n'
      + `Tried:\n  ${tried.join('\n  ')}`,
  );
}

/**
 * Playwright's `chromium` browser type. Launch arguments stay with each tool.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ importModule?: (specifier: string) => Promise<any> }} [options]
 */
export async function loadChromium(env = process.env, options = {}) {
  return (await importPlaywright(env, options)).chromium;
}
