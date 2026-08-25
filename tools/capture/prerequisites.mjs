import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCancellation, throwIfAborted } from './cancellation.mjs';
import { runProcess } from './process.mjs';

const require = createRequire(import.meta.url);
const CI_WORKFLOW = new URL('../../.github/workflows/ci.yml', import.meta.url);

export function playwrightVersionFromCi(text) {
  const versions = [...text.matchAll(/npm i --no-save playwright@([0-9]+(?:\.[0-9]+){2})/g)]
    .map((match) => match[1]);
  const unique = [...new Set(versions)];
  if (unique.length !== 1) {
    throw new Error(`CI must declare exactly one Playwright install version; found ${unique.join(', ') || 'none'}`);
  }
  return unique[0];
}

export const CI_PLAYWRIGHT_VERSION = playwrightVersionFromCi(readFileSync(CI_WORKFLOW, 'utf8'));

async function packageVersionFor(specifier) {
  let resolved;
  try {
    if (specifier === 'playwright') resolved = require.resolve('playwright/package.json');
    else if (specifier.startsWith('file:')) resolved = fileURLToPath(specifier);
    else if (isAbsolute(specifier)) resolved = specifier;
    else resolved = require.resolve(specifier);
  } catch {
    return null;
  }
  let directory = dirname(resolved);
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (pkg.name === 'playwright' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // Walk to the package root.
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export async function loadPlaywright(env = process.env, options = {}) {
  throwIfAborted(options.signal);
  const candidates = [...new Set([env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean))];
  const tried = [];
  for (const specifier of candidates) {
    try {
      const module = await import(specifier);
      throwIfAborted(options.signal);
      if (!module.chromium) {
        tried.push(`${specifier}: no chromium export`);
        continue;
      }
      const executablePath = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        || module.chromium.executablePath();
      try {
        await access(executablePath, fsConstants.X_OK);
      } catch {
        throw new Error(`Chromium executable is missing at ${executablePath}`);
      }
      const version = await packageVersionFor(specifier);
      if (!version) throw new Error('could not determine the Playwright package version');
      if (version !== CI_PLAYWRIGHT_VERSION) {
        throw new Error(
          `Playwright ${version} is installed, but CI and capture require ${CI_PLAYWRIGHT_VERSION}`,
        );
      }
      return { moduleSpecifier: specifier, version, executablePath };
    } catch (error) {
      if (findCancellation(error)) throw error;
      tried.push(`${specifier}: ${error.code ?? error.message}`);
    }
  }
  throw new Error(
    'Playwright with Chromium is required for capture. Match CI with:\n'
      + `  npm i --no-save playwright@${CI_PLAYWRIGHT_VERSION}\n`
      + '  npx playwright install chromium\n'
      + 'Or set PLAYWRIGHT_MODULE to that install.\n'
      + `Tried:\n  ${tried.join('\n  ')}`,
  );
}

export async function toolVersion(command, env = process.env, options = {}) {
  let result;
  try {
    result = await runProcess(command, ['-version'], {
      env,
      timeoutMs: 10_000,
      signal: options.signal,
    });
  } catch (error) {
    if (error.code === 'ENOENT' || /could not start/.test(error.message)) {
      throw new Error(`${command} is required for capture but was not found on PATH`, { cause: error });
    }
    throw new Error(`could not inspect ${command}: ${error.message}`, { cause: error });
  }
  const firstLine = result.stdout.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) throw new Error(`${command} -version returned no version text`);
  return firstLine;
}

export async function inspectPrerequisites(env = process.env, options = {}) {
  const [playwright, ffmpeg, ffprobe] = await Promise.all([
    loadPlaywright(env, options),
    toolVersion('ffmpeg', env, options),
    toolVersion('ffprobe', env, options),
  ]);
  return { playwright, ffmpeg, ffprobe };
}
