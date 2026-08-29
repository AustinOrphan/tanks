import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain-node ESM module, no types
import { runCaptureAtRef, CAPTURE_OUT } from './capture-runner.mjs';

/**
 * This module is the seam every orchestrator test replaces with a fake, so nothing else in
 * the suite reaches it. That is exactly how `--retain-frames` came to be droppable without
 * a single test noticing: the frame analysis depends entirely on those PNGs existing, and
 * removing the flag left all 100 other tests green.
 */
function harness({ manifest = { status: 'success' }, runFails = null as Error | null, readFails = null as Error | null } = {}) {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      runProcess: async (command: string, args: string[], options: { cwd: string }) => {
        calls.push([command, ...args, `cwd=${options.cwd}`]);
        if (runFails) throw runFails;
        return { stdout: '' };
      },
      readFile: async () => {
        if (readFails) throw readFails;
        return JSON.stringify(manifest);
      },
    },
  };
}

describe('runCaptureAtRef', () => {
  it('ALWAYS asks capture to retain its frames', async () => {
    // Load-bearing, and the reason this file exists. Raw frames are what the comparison is
    // computed from; without them `analyseFrames` has nothing to read. Dropping this flag
    // survived the entire rest of the suite.
    const { deps, calls } = harness();
    await runCaptureAtRef({ worktree: '/ws/base', recipeId: 'gallery.fire.still' }, deps);
    expect(calls[0]).toContain('--retain-frames');
  });

  it('invokes the repository entry point inside the side\'s own worktree', async () => {
    // `npm run capture` in the WORKTREE, so base is captured by BASE's capture tooling.
    // Importing the modules instead would run head's pipeline against base's source and
    // attribute any change in the tooling itself to the code under review.
    const { deps, calls } = harness();
    await runCaptureAtRef({ worktree: '/ws/base', recipeId: 'gallery.fire.still' }, deps);
    expect(calls[0].slice(0, 4)).toEqual(['npm', 'run', 'capture', '--']);
    expect(calls[0]).toContain('gallery.fire.still');
    expect(calls[0]).toContain(CAPTURE_OUT);
    expect(calls[0][calls[0].length - 1]).toBe('cwd=/ws/base');
  });

  it('returns the parsed manifest and the directory it was published to', async () => {
    const { deps } = harness({ manifest: { status: 'success', capture: { viewport: { width: 640 } } } });
    const result = await runCaptureAtRef({ worktree: '/ws/head', recipeId: 'r' }, deps);
    expect(result.manifest.capture.viewport.width).toBe(640);
    expect(result.directory).toBe(`/ws/head/${CAPTURE_OUT}`);
  });

  it('names the worktree when the capture subprocess fails', async () => {
    const { deps } = harness({ runFails: new Error('npm exited 1') });
    await expect(runCaptureAtRef({ worktree: '/ws/base', recipeId: 'r' }, deps))
      .rejects.toThrow(/capture failed in \/ws\/base: npm exited 1/);
  });

  it('reports an unreadable manifest against its full path', async () => {
    const { deps } = harness({ readFails: new Error('ENOENT') });
    await expect(runCaptureAtRef({ worktree: '/ws/base', recipeId: 'r' }, deps))
      .rejects.toThrow(/produced no readable manifest at \/ws\/base\/artifacts\/capture\/compare-side\/capture\.json/);
  });

  it('refuses a manifest that exists but does not say success', async () => {
    // capture removes a partial publication on failure, so a manifest that exists and says
    // anything else means the artifact contract was broken rather than merely unmet --
    // and comparing against it would be comparing against something capture disowned.
    const { deps } = harness({ manifest: { status: 'failed' } });
    await expect(runCaptureAtRef({ worktree: '/ws/base', recipeId: 'r' }, deps))
      .rejects.toThrow(/reported status 'failed'/);
  });
});
