// The manifest's reproduction section (issue #815): the commands that make a capture again,
// with the checkout's commit in the build line and an honest note for a dirty tree.
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { buildManifest, reproduction } from './manifest.mjs';
import { CAPTURE_RECIPES } from './registry.mjs';

const SHA = 'c'.repeat(40);
const prerequisites = { playwright: { version: '1.62.0' }, ffmpeg: 'ffmpeg version 7', ffprobe: 'ffprobe version 7' };

describe('reproduction (issue #815)', () => {
  it('names the pinned Playwright, the build with the commit, and the capture with its source ref', () => {
    const recipe = CAPTURE_RECIPES[0].recipe;
    expect(reproduction(recipe, { commitSha: SHA, dirty: false }, prerequisites)).toEqual({
      install: ['npm i --no-save playwright@1.62.0', 'npx playwright install chromium'],
      build: `VITE_BUILD_SHA=${SHA} npm run build`,
      capture: `npm run capture -- --recipe ${recipe.id} --source-ref ${SHA}`,
      note: null,
    });
  });

  it('says so when the checkout was dirty, and when no Playwright version was resolved', () => {
    const recipe = CAPTURE_RECIPES[0].recipe;
    expect(reproduction(recipe, { commitSha: SHA, dirty: true }, prerequisites).note).toMatch(/dirty.*reproduce the commit/);
    expect(reproduction(recipe, { commitSha: SHA, dirty: false }, { playwright: null }).install[0]).toMatch(/playwright@<the version/);
  });

  it('is carried into capture.json beside playback', () => {
    const entry = CAPTURE_RECIPES[0];
    const manifest = buildManifest({
      entry,
      source: { requestedRef: null, commitSha: SHA, dirty: false },
      producerResult: {
        capture: { viewport: entry.recipe.viewport, frameSchedule: { kind: 'still', frameCount: 1 } },
        assertions: [], metadata: null, toolVersions: {}, diagnostics: [],
      },
      prerequisites,
      artifacts: [{ filename: 'capture.png', format: 'png', byteSize: 10 }],
      rawFrames: null,
      startedAt: 't0',
      completedAt: 't1',
    });
    expect(manifest.reproduce.capture).toBe(`npm run capture -- --recipe ${entry.recipe.id} --source-ref ${SHA}`);
    expect(Object.keys(manifest)).toContain('reproduce');
  });
});
