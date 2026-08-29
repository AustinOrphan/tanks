/**
 * A real, really-broken external toolchain, built out of shell scripts on a private PATH.
 *
 * Capture and compare shell out to FFmpeg and load Playwright, and every failure path they
 * own was originally covered by replacing the seam with a function that throws. That proves
 * the orchestrator reacts to a rejected promise; it does not prove the production code
 * turns a real `spawn` failure into that promise in the first place, and it cannot catch a
 * refusal that stops matching the error a real tool actually produces.
 *
 * These fixtures make the tool itself the thing that is wrong -- absent from PATH, or
 * present and failing -- so the assertion runs through the real `spawn`, the real exit-code
 * and ENOENT mapping in `runProcess`, and the real error text. Nothing here needs FFmpeg,
 * Playwright, or Chromium to be installed, so it runs in `verify:quick` on a bare checkout,
 * which is the constraint that put the injected seams there to begin with.
 */
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * A PATH directory holding exactly the named commands and nothing else.
 *
 * Naming the commands that EXIST rather than the ones that are missing is what makes each
 * refusal deterministic: `inspectPrerequisites` runs its three probes under `Promise.all`,
 * so with both encoders absent the rejection is whichever loses the race. Supplying a
 * working `ffprobe` leaves exactly one thing missing, and the test can name it.
 *
 * @param {Record<string, string>} commands command name -> `sh` body.
 */
export async function toolDirectory(commands) {
  const directory = await mkdtemp(resolve(tmpdir(), 'fake-bin-'));
  for (const [name, body] of Object.entries(commands)) {
    const path = resolve(directory, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8');
    await chmod(path, 0o755);
  }
  return directory;
}

/** A shim that answers `-version` the way the real tool does and succeeds. */
export const respondsToVersion = (name) => `echo "${name} version 0.0-fixture"`;

/** A shim that is present, runs, and fails -- an installed-but-broken tool. */
export const failsWith = (message) => `echo "${message}" >&2\nexit 1`;

/**
 * A shim that SUCCEEDS, writing exactly `bytes` bytes to FFmpeg's output path.
 *
 * Two uses, and the byte count is what separates them. At the true size it is the control
 * that proves a decode failure elsewhere was the tool rather than the wiring; short, it is
 * the tool that exits 0 having written a truncated file or substituted a pixel format --
 * the case the decode step's byte-length check exists for, and the one an exit code alone
 * would wave through.
 *
 * `printf` and the argument loop are shell builtins on purpose. The shim runs with the same
 * private PATH it was installed on, so `head`, `dd` and `truncate` are not there.
 */
export const writesOutputOfBytes = (bytes) => [
  'for last in "$@"; do :; done',
  `printf '%${bytes}s' '' > "$last"`,
].join('\n');

/**
 * A Playwright install that resolves, so a test can hold Playwright fixed and vary FFmpeg.
 *
 * `loadPlaywright` demands three separate things -- an importable module exporting
 * `chromium`, an executable Chromium binary, and a package.json whose name is `playwright`
 * at exactly the CI pin. The version is read from the caller rather than hardcoded here so
 * that bumping CI's pin cannot leave a fixture behind claiming the old one, and Chromium is
 * `process.execPath`, which is guaranteed to exist and be executable wherever this runs.
 *
 * @returns {Promise<string>} an absolute specifier for `PLAYWRIGHT_MODULE`.
 */
export async function playwrightThatResolves(version) {
  const directory = await mkdtemp(resolve(tmpdir(), 'fake-playwright-'));
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, 'package.json'),
    `${JSON.stringify({ name: 'playwright', version }, null, 2)}\n`,
    'utf8',
  );
  const entry = resolve(directory, 'index.mjs');
  await writeFile(
    entry,
    'export const chromium = { executablePath: () => process.execPath };\n',
    'utf8',
  );
  return entry;
}
