import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { importPlaywright, loadChromium, playwrightCandidates } from './playwright.mjs';

/**
 * Issue #692: twelve tool files each resolved Playwright their own way. These cases pin the
 * one shared order and error, without depending on whether THIS machine has Playwright
 * installed: a case that lets the bare `playwright` specifier reach the real resolver would
 * pass or fail on the install, not the code (issue #353 was exactly that). So a case either
 * resolves through a real module on disk that it wrote itself, or supplies `importModule`
 * and decides what the bare specifier does.
 */

const scratch = mkdtempSync(join(tmpdir(), 'shared-playwright-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A package directory holding one `index.mjs` with the given source. */
function packageDirectory(name: string, source: string): string {
  const directory = join(scratch, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'index.mjs'), source);
  return directory;
}

const notFound = (specifier: string) =>
  Object.assign(new Error(`Cannot find package '${specifier}'`), { code: 'ERR_MODULE_NOT_FOUND' });

/** An importer that knows only `modules`, and records what it was asked for. */
function importerOf(modules: Record<string, object>) {
  const asked: string[] = [];
  const importModule = async (specifier: string) => {
    asked.push(specifier);
    if (specifier in modules) return modules[specifier];
    throw notFound(specifier);
  };
  return { importModule, asked };
}

const LOADER = pathToFileURL(fileURLToPath(new URL('./playwright.mjs', import.meta.url))).href;

/**
 * Run `body` as an ES module in a plain `node` process and parse the JSON it prints.
 *
 * A directory import is the one resolution these cases need a REAL answer for, and vitest
 * cannot give it: its module runner resolves `import('/some/dir')` to the directory's
 * `index.mjs` on its own, so under vitest a loader that never tried `<dir>/index.mjs` still
 * loaded the directory -- measured, the first draft of the case below passed that way. Node
 * refuses the same import with ERR_UNSUPPORTED_DIR_IMPORT, and Node is what runs the tools.
 *
 * `importModule` inside `body` is the real `import()` except that the bare `playwright`
 * specifier never resolves, so the outcome does not depend on this machine's install.
 */
function inNode(body: string): unknown {
  const source = `
    import { importPlaywright, loadChromium } from ${JSON.stringify(LOADER)};
    const importModule = (specifier) => specifier === 'playwright'
      ? Promise.reject(Object.assign(new Error('not found'), { code: 'ERR_MODULE_NOT_FOUND' }))
      : import(specifier);
    ${body}
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
  return JSON.parse(out);
}

describe('shared playwright loader', () => {
  it('tries PLAYWRIGHT_MODULE first and the bare specifier second, each once', () => {
    // Negative controls, one per line: making PLAYWRIGHT_MODULE an override drops
    // 'playwright' from the first; dropping the Set repeats it in the second; dropping
    // filter(Boolean) keeps '' in the third.
    expect(playwrightCandidates({ PLAYWRIGHT_MODULE: '/opt/pw' })).toEqual(['/opt/pw', 'playwright']);
    expect(playwrightCandidates({ PLAYWRIGHT_MODULE: 'playwright' })).toEqual(['playwright']);
    expect(playwrightCandidates({ PLAYWRIGHT_MODULE: '' })).toEqual(['playwright']);
    expect(playwrightCandidates({})).toEqual(['playwright']);
  });

  it('prefers a PLAYWRIGHT_MODULE that loads over an ambient install', async () => {
    // Negative control: reversing the candidate order returns 'ambient'.
    const explicit = pathToFileURL('/opt/pw/playwright.mjs').href;
    const { importModule } = importerOf({
      [explicit]: { chromium: 'explicit' },
      playwright: { chromium: 'ambient' },
    });
    expect(await loadChromium({ PLAYWRIGHT_MODULE: '/opt/pw/playwright.mjs' }, { importModule })).toBe('explicit');
  });

  it('falls through a PLAYWRIGHT_MODULE that does not load to the bare specifier', async () => {
    // Negative control: `env.PLAYWRIGHT_MODULE ? [env.PLAYWRIGHT_MODULE] : ['playwright']`
    // never asks for 'playwright', and the load rejects.
    const { importModule, asked } = importerOf({ playwright: { chromium: 'ambient' } });
    expect(await loadChromium({ PLAYWRIGHT_MODULE: '/missing/playwright' }, { importModule })).toBe('ambient');
    expect(asked).toEqual([
      pathToFileURL('/missing/playwright').href,
      pathToFileURL('/missing/playwright/index.mjs').href,
      'playwright',
    ]);
  });

  it('loads an absolute package directory through its index.mjs', () => {
    // Plain Node refuses a directory import (ERR_UNSUPPORTED_DIR_IMPORT), which is why
    // roundtrip.mjs imported `<dir>/index.mjs`. Negative control: trying only the candidate
    // itself fails the directory import and falls through to the bare specifier, which
    // `inNode` denies, so the load rejects and this prints nothing parseable.
    const directory = packageDirectory('installed', 'export const chromium = { name: "from-directory" };');
    expect(inNode(`
      const chromium = await loadChromium({ PLAYWRIGHT_MODULE: ${JSON.stringify(directory)} }, { importModule });
      console.log(JSON.stringify(chromium));
    `)).toEqual({ name: 'from-directory' });
  });

  it('skips a module with no chromium export and names every attempt in the error', () => {
    // Negative control: `return module` without checking `module.chromium` resolves with
    // the firefox-only module at the second attempt, and the message below is never built.
    const directory = packageDirectory('no-chromium', 'export const firefox = {};');
    expect(inNode(`
      await importPlaywright({ PLAYWRIGHT_MODULE: ${JSON.stringify(directory)} }, { importModule })
        .then(() => console.log('"resolved"'), (error) => console.log(JSON.stringify(error.message)));
    `)).toContain(
      `Tried:\n  ${directory}: ERR_UNSUPPORTED_DIR_IMPORT\n`
        + `  ${directory}/index.mjs: no chromium export\n`
        + '  playwright: ERR_MODULE_NOT_FOUND',
    );
  });

  it('returns the whole module to a tool that launches more than chromium', async () => {
    // tools/baseline/run.mjs launches `playwright[name]` for each requested engine.
    // Negative control: returning `module.chromium` here loses `webkit`.
    const { importModule } = importerOf({ playwright: { chromium: 'c', webkit: 'w' } });
    expect(await importPlaywright({}, { importModule })).toEqual({ chromium: 'c', webkit: 'w' });
  });
});
