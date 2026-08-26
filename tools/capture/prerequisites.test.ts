import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import {
  CI_PLAYWRIGHT_VERSION,
  loadPlaywright,
  playwrightVersionFromCi,
  toolVersion,
} from './prerequisites.mjs';

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
