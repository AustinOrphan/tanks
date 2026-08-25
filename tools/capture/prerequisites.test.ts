import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { loadPlaywright, toolVersion } from './prerequisites.mjs';

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
});
