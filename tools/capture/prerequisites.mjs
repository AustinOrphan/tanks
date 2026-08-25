import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process.mjs';

const require = createRequire(import.meta.url);

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

export async function loadPlaywright(env = process.env) {
  const candidates = [...new Set([env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean))];
  const tried = [];
  for (const specifier of candidates) {
    try {
      const module = await import(specifier);
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
      return { moduleSpecifier: specifier, version, executablePath };
    } catch (error) {
      tried.push(`${specifier}: ${error.code ?? error.message}`);
    }
  }
  throw new Error(
    'Playwright with Chromium is required for capture. Match CI with:\n'
      + '  npm i --no-save playwright@1.62.0\n'
      + '  npx playwright install chromium\n'
      + 'Or set PLAYWRIGHT_MODULE to that install.\n'
      + `Tried:\n  ${tried.join('\n  ')}`,
  );
}

export async function toolVersion(command, env = process.env) {
  let result;
  try {
    result = await runProcess(command, ['-version'], { env, timeoutMs: 10_000 });
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

export async function inspectPrerequisites(env = process.env) {
  const [playwright, ffmpeg, ffprobe] = await Promise.all([
    loadPlaywright(env),
    toolVersion('ffmpeg', env),
    toolVersion('ffprobe', env),
  ]);
  return { playwright, ffmpeg, ffprobe };
}
