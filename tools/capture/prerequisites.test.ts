import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import {
  CI_PLAYWRIGHT_VERSION,
  inspectPrerequisites,
  loadPlaywright,
  playwrightVersionFromCi,
  toolVersion,
} from './prerequisites.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import {
  playwrightThatResolves,
  respondsToVersion,
  toolDirectory,
} from './test-fixtures/toolchain.mjs';

describe('capture prerequisites', () => {
  it('reports a missing command as an actionable prerequisite error', async () => {
    await expect(toolVersion('tanks-capture-tool-that-does-not-exist'))
      .rejects.toThrow(/required for capture but was not found on PATH/);
  });

  it('reports a missing Chromium executable before capture starts', async () => {
    const fakePlaywright = 'data:text/javascript,'
      + encodeURIComponent('export const chromium = { executablePath: () => "/missing/chromium" };');
    await expect(loadPlaywright({
      PLAYWRIGHT_MODULE: fakePlaywright,
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/missing/chromium',
    }))
      .rejects.toThrow(/Playwright with Chromium is required[\s\S]*Chromium executable is missing/);
  });

  it('ties capture documentation and errors to the canonical CI Playwright pin', async () => {
    const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const documentation = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
    expect(CI_PLAYWRIGHT_VERSION).toBe(playwrightVersionFromCi(workflow));
    expect(workflow).toContain(`playwright-chromium-${CI_PLAYWRIGHT_VERSION}-`);
    expect(documentation).toContain(`playwright@${CI_PLAYWRIGHT_VERSION}`);

    // Both candidates must fail for this to be a measurement rather than an environment
    // reading. `PLAYWRIGHT_MODULE` is the FIRST candidate, not the only one: `loadPlaywright`
    // falls through to the bare `'playwright'` specifier, so on a worktree that has Playwright
    // resolvable -- which is exactly how the documented `npm i --no-save playwright@x.y.z`
    // capture setup leaves it -- the call SUCCEEDED and this case failed with
    // `promise resolved ... instead of rejecting` (issue #353). Denying Chromium to whichever
    // candidate does resolve is what makes the aggregate error the only outcome, and it is the
    // same technique the missing-Chromium case above already uses.
    await expect(loadPlaywright({
      PLAYWRIGHT_MODULE: '/missing/playwright',
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/missing/chromium',
    }))
      .rejects.toThrow(new RegExp(`playwright@${CI_PLAYWRIGHT_VERSION.replaceAll('.', '\\.')}`));

    expect(() => playwrightVersionFromCi(
      'npm i --no-save playwright@1.2.3\nnpm i --no-save playwright@4.5.6',
    )).toThrow(/exactly one Playwright install version/);
  });

  // The behaviour that made the case above read its environment instead of the code, pinned
  // so the next reader meets it as a stated fact: `PLAYWRIGHT_MODULE` is a PREFERENCE, and a
  // failure to load it falls through to the bare specifier rather than ending the search.
  //
  // Negative control: narrowing `candidates` to `env.PLAYWRIGHT_MODULE ? [env.PLAYWRIGHT_MODULE]
  // : ['playwright']` -- the obvious "make PLAYWRIGHT_MODULE an override" edit -- drops the
  // second line from `Tried:` and fails this. Denying Chromium keeps it from depending on
  // whether `'playwright'` happens to resolve here: the entry's TEXT differs between a worktree
  // with Playwright installed and one without, but the entry is present either way.
  it('treats PLAYWRIGHT_MODULE as the first candidate and still tries the bare specifier', async () => {
    await expect(loadPlaywright({
      PLAYWRIGHT_MODULE: '/missing/playwright',
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/missing/chromium',
    }))
      .rejects.toThrow(/Tried:\n {2}\/missing\/playwright: [^\n]*\n {2}playwright: /);
  });
});

/**
 * The same refusals, produced by an external toolchain that is really broken.
 *
 * The cases above establish the refusal text from a missing command name and a data-URI
 * module. These run `inspectPrerequisites` -- the function compare and capture actually
 * call -- against a private PATH holding real executables, so the ENOENT comes out of a
 * real `spawn` and travels the real mapping in `runProcess` and `toolVersion`.
 *
 * Which command is missing is chosen by which shim EXISTS: the three probes run under
 * `Promise.all`, so leaving both encoders off PATH would make the rejection a race between
 * two identically shaped messages. Playwright is held resolvable throughout for the same
 * reason -- it is the variable these cases are not testing.
 */
describe.skipIf(process.platform === 'win32')('capture prerequisites against a really broken toolchain', () => {
  async function environment(commands: Record<string, string>) {
    return {
      PATH: await toolDirectory(commands),
      PLAYWRIGHT_MODULE: await playwrightThatResolves(CI_PLAYWRIGHT_VERSION),
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.execPath,
    };
  }

  it.each([
    ['ffmpeg', { ffprobe: respondsToVersion('ffprobe') }],
    ['ffprobe', { ffmpeg: respondsToVersion('ffmpeg') }],
  ])('names %s specifically when that one is genuinely absent from PATH', async (missing, present) => {
    await expect(inspectPrerequisites(await environment(present)))
      .rejects.toThrow(`${missing} is required for capture but was not found on PATH`);
  });

  it('accepts the same toolchain once both encoders are on PATH, and reports what it found', async () => {
    // The control for the two cases above. Without it they would still pass if
    // `inspectPrerequisites` rejected unconditionally, or if the PATH were being ignored
    // and some ambient failure were producing the message.
    const result = await inspectPrerequisites(await environment({
      ffmpeg: respondsToVersion('ffmpeg'),
      ffprobe: respondsToVersion('ffprobe'),
    }));
    expect(result.ffmpeg).toBe('ffmpeg version 0.0-fixture');
    expect(result.ffprobe).toBe('ffprobe version 0.0-fixture');
    expect(result.playwright.version).toBe(CI_PLAYWRIGHT_VERSION);
  });

  it('refuses a tool that is installed and broken, rather than reading its failure as a version', async () => {
    // A present-but-failing encoder is not the same defect as a missing one, and it is the
    // one an exit code alone would wave through: `toolVersion` returns the first line of
    // STDOUT, so a shim that prints a plausible banner and then exits nonzero would be
    // accepted if the exit status were not checked.
    await expect(inspectPrerequisites(await environment({
      ffmpeg: 'echo "ffmpeg version 7.1.5"\nexit 1',
      ffprobe: respondsToVersion('ffprobe'),
    })))
      .rejects.toThrow(/could not inspect ffmpeg: ffmpeg failed: ffmpeg version 7\.1\.5/);
  });
});
