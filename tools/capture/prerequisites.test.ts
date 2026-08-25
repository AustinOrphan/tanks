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

    await expect(loadPlaywright({ PLAYWRIGHT_MODULE: '/missing/playwright' }))
      .rejects.toThrow(new RegExp(`playwright@${CI_PLAYWRIGHT_VERSION.replaceAll('.', '\\.')}`));

    expect(() => playwrightVersionFromCi(
      'npm i --no-save playwright@1.2.3\nnpm i --no-save playwright@4.5.6',
    )).toThrow(/exactly one Playwright install version/);
  });
});
