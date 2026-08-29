import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
// @ts-expect-error -- plain-node ESM module, no types
import { compareRefs } from './orchestrate.mjs';
// @ts-expect-error -- plain-node ESM module, no types
import { createRegistry } from '../capture/registry.mjs';
// @ts-expect-error -- plain-node ESM module, no types
import { RECIPES_PATH } from './refs.mjs';
// @ts-expect-error -- plain-node ESM module, no types
import { inspectPrerequisites, CI_PLAYWRIGHT_VERSION } from '../capture/prerequisites.mjs';
// @ts-expect-error -- plain-node ESM module, no types
import {
  failsWith, playwrightThatResolves, respondsToVersion, toolDirectory, writesOutputOfBytes,
} from '../capture/test-fixtures/toolchain.mjs';

const SHIPPED = JSON.parse(readFileSync(new URL(`../../${RECIPES_PATH}`, import.meta.url), 'utf8'));

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

function manifest({ width = 640, height = 480, dpr = 1, kind = 'still', frameCount = 1, tools = { node: 'v24' } } = {}) {
  return {
    status: 'success',
    capture: { viewport: { width, height, devicePixelRatio: dpr }, frameSchedule: { kind, frameCount } },
    tools,
  };
}

/** A complete dependency set whose every expensive step is a fake. */
function harness(overrides: Record<string, unknown> = {}) {
  const events: string[] = [];
  const owned = new Set<string>();
  const registry = createRegistry(SHIPPED);
  const worktrees = {
    owned,
    add: async (side: { label: string }) => {
      events.push(`add:${side.label}`);
      owned.add(`/ws/${side.label}`);
      return `/ws/${side.label}`;
    },
    removeAll: async () => { events.push('cleanup'); owned.clear(); return []; },
  };
  const deps: Record<string, unknown> = {
    log: () => {},
    inspectPrerequisites: async () => ({ playwright: { version: '1.62.0' }, ffmpeg: 'n7.1', ffprobe: 'n7.1' }),
    resolveRef: async (_root: string, label: string, ref: string) => ({
      label, requestedRef: ref, commitSha: label === 'base' ? BASE_SHA : HEAD_SHA,
    }),
    inspectCallerTree: async () => ({ dirty: false }),
    readRegistryAtSha: async () => registry,
    createCompareWorkspace: async () => '/ws',
    createWorktreeManager: () => worktrees,
    runCaptureAtRef: async ({ worktree }: { worktree: string }) => {
      events.push(`capture:${worktree}`);
      return { manifest: manifest(), directory: `${worktree}/out` };
    },
    analyseFrames: async () => ({
      frameCount: 1, changedFrameCount: 0, firstChangedFrame: null,
      maxChangedPixels: 0, maxChannelDelta: 0, identical: true, frames: [],
    }),
    retainSourceCaptures: async (_sides: unknown, _out: string, retainFrames: boolean) => {
      events.push(`retain:${retainFrames ? 'with-frames' : 'no-frames'}`);
    },
    composeStill: async () => { events.push('composeStill'); return ['base.png', 'head.png', 'side-by-side.png', 'difference.png']; },
    composeTemporal: async () => { events.push('composeTemporal'); return ['comparison.mp4', 'comparison.gif']; },
    ...overrides,
  };
  return { deps, events, worktrees, owned };
}

async function freshRoot() {
  const root = await mkdtemp(resolve(tmpdir(), 'compare-root-'));
  await mkdir(resolve(root, 'tmp'), { recursive: true });
  return root;
}

const options = (root: string, out = 'artifacts/compare/x') => ({
  root, recipe: 'gallery.fire.still', base: 'main', head: 'topic', out,
});

describe('compareRefs: what it records', () => {
  it('records the exact resolved SHAs and the reproduction command', async () => {
    const root = await freshRoot();
    const { deps } = harness();
    const { report } = await compareRefs(options(root), deps);
    expect(report.refs.base).toMatchObject({ requested: 'main', commitSha: BASE_SHA });
    expect(report.refs.head).toMatchObject({ requested: 'topic', commitSha: HEAD_SHA });
    expect(report.reproduce).toBe(
      'npm run capture:compare -- --recipe gallery.fire.still --base main --head topic --out artifacts/compare/x',
    );
    expect(report.schemaVersion).toBe(1);
  });

  it('records a dirty caller tree without acting on it', async () => {
    // `--head HEAD` resolves to the COMMIT. Doing that on a dirty tree is legitimate and
    // very easy to do by accident, so compare.json says which it was rather than the
    // command guessing -- and it certainly never stashes to "help".
    const root = await freshRoot();
    const { deps } = harness({ inspectCallerTree: async () => ({ dirty: true }) });
    const { report } = await compareRefs(options(root), deps);
    expect(report.refs.callerTreeDirty).toBe(true);
    expect(report.status).toBe('success');
  });

  it('retains both source captures, and only carries the bulky frames when asked', async () => {
    // The comparison is derived; the two captures are the primary evidence, and a reader
    // who doubts the composite has to be able to open the originals. The frames are
    // several megabytes a side on a clip, so they are opt-in.
    const root = await freshRoot();
    const lean = harness();
    const { report } = await compareRefs(options(root), lean.deps);
    expect(lean.events).toContain('retain:no-frames');
    expect(report.outputs.sourceCaptures).toEqual({ base: 'base/', head: 'head/' });
    expect(report.outputs.retainedFrames).toBe(false);

    const root2 = await freshRoot();
    const full = harness();
    const withFrames = await compareRefs({ ...options(root2), retainFrames: true }, full.deps);
    expect(full.events).toContain('retain:with-frames');
    expect(withFrames.report.outputs.retainedFrames).toBe(true);
  });

  it('points refs.*.manifest at the retained source manifests it actually wrote', async () => {
    // These were `base/capture.json` before the captures were retained, i.e. a path to a
    // file that did not exist -- a manifest field that reads as a link and is not one.
    const root = await freshRoot();
    const { deps } = harness();
    const { report } = await compareRefs(options(root), deps);
    expect(report.refs.base.manifest).toBe('base/capture.json');
    expect(report.outputs.sourceCaptures.base).toBe('base/');
  });

  it('writes compare.json alongside the media', async () => {
    const root = await freshRoot();
    const { deps } = harness();
    await compareRefs(options(root), deps);
    const written = JSON.parse(await readFile(resolve(root, 'artifacts/compare/x/compare.json'), 'utf8'));
    expect(written.recipe.id).toBe('gallery.fire.still');
    expect(written.outputs.files).toContain('side-by-side.png');
  });
});

describe('compareRefs: refusing before it spends anything', () => {
  it('refuses two refs that resolve to the same commit, before any worktree', async () => {
    const root = await freshRoot();
    const { deps, events } = harness({
      resolveRef: async (_r: string, label: string, ref: string) => ({ label, requestedRef: ref, commitSha: BASE_SHA }),
    });
    await expect(compareRefs(options(root), deps)).rejects.toThrow(/same commit; there is nothing to compare/);
    expect(events).toEqual([]); // nothing created, nothing to clean up
  });

  it('refuses a recipe missing on one side, before any worktree', async () => {
    const root = await freshRoot();
    const empty = createRegistry([]);
    const { deps, events } = harness({
      readRegistryAtSha: async (_r: string, side: { label: string }) => (side.label === 'base' ? empty : createRegistry(SHIPPED)),
    });
    await expect(compareRefs(options(root), deps)).rejects.toThrow(/does not exist at base/);
    expect(events).toEqual([]);
  });

  it('refuses an incompatible recipe with an actionable message, before any worktree', async () => {
    const root = await freshRoot();
    const altered = JSON.parse(JSON.stringify(SHIPPED));
    altered.find((r: { id: string }) => r.id === 'gallery.fire.still').viewport.width = 800;
    const { deps, events } = harness({
      readRegistryAtSha: async (_r: string, side: { label: string }) => createRegistry(side.label === 'base' ? SHIPPED : altered),
    });
    await expect(compareRefs(options(root), deps)).rejects.toThrow(/not the same instrument at both refs/);
    expect(events).toEqual([]);
  });

  it('checks prerequisites BEFORE resolving anything or creating a worktree', async () => {
    // Compare owns this check rather than inheriting capture's, which fires inside a
    // worktree -- i.e. after two checkouts already exist. Learning that ffmpeg is missing
    // must not cost two checkouts and two browser runs. Compare also shells out to FFmpeg
    // itself for the composition step, which capture's check knows nothing about.
    const root = await freshRoot();
    const { deps, events } = harness({
      inspectPrerequisites: async () => { throw new Error('ffmpeg is required for capture but was not found on PATH'); },
    });
    let resolved = false;
    (deps.resolveRef as unknown) = async () => { resolved = true; return {}; };
    await expect(compareRefs(options(root), deps)).rejects.toThrow(/ffmpeg is required/);
    expect(resolved).toBe(false);
    expect(events).toEqual([]);
  });

  it('records the tool versions it verified', async () => {
    const root = await freshRoot();
    const { deps } = harness();
    const { report } = await compareRefs(options(root), deps);
    expect(report.prerequisites).toEqual({ playwright: '1.62.0', ffmpeg: 'n7.1', ffprobe: 'n7.1' });
  });

  it('refuses to overwrite an existing output directory', async () => {
    const root = await freshRoot();
    await mkdir(resolve(root, 'artifacts/compare/x'), { recursive: true });
    const { deps, events } = harness();
    await expect(compareRefs(options(root), deps)).rejects.toThrow(/already exists; choose a new --out/);
    expect(events).toEqual([]);
  });
});

describe('compareRefs: comparability of the two captures', () => {
  it.each([
    ['dimensions', { width: 640 }, { width: 800 }, /different dimensions/],
    ['device pixel ratio', { dpr: 1 }, { dpr: 2 }, /different dimensions/],
    ['schedule kind', { kind: 'still' }, { kind: 'frames', frameCount: 1 }, /captured a 'still' schedule and head captured a 'frames' schedule/],
    // Same KIND on both sides, so this reaches the frame-count check instead of being
    // short-circuited by the kind check. The first version of this case set head to
    // `{kind:'frames', frameCount:30}` against a `still` base and matched a loose regex:
    // the kind check fired first, the count check was never reached, and a mutation
    // deleting it outright SURVIVED the whole suite.
    ['frame count', { kind: 'frames', frameCount: 47 }, { kind: 'frames', frameCount: 30 }, /different frame counts -- base 47, head 30/],
  ])('refuses two captures that differ in %s, rather than scaling or padding', async (_label, baseShape, headShape, message) => {
    const root = await freshRoot();
    const { deps, events } = harness({
      runCaptureAtRef: async ({ worktree }: { worktree: string }) => ({
        manifest: manifest((worktree.endsWith('head') ? headShape : baseShape) as object),
        directory: `${worktree}/out`,
      }),
    });
    await expect(compareRefs(options(root), deps)).rejects.toThrow(message as RegExp);
    // It got as far as two captures, so cleanup MUST have run.
    expect(events).toContain('cleanup');
  });

  it('reports differing tool versions as a caveat rather than discarding the evidence', async () => {
    // Both captures already exist and are honest recordings; a loud caveat serves a reader
    // better than throwing them away.
    const root = await freshRoot();
    const { deps } = harness({
      runCaptureAtRef: async ({ worktree }: { worktree: string }) => ({
        manifest: manifest({ tools: worktree.endsWith('head') ? { node: 'v24', chromium: '152' } : { node: 'v24', chromium: '151' } }),
        directory: `${worktree}/out`,
      }),
    });
    const { report } = await compareRefs(options(root), deps);
    expect(report.status).toBe('success');
    expect(report.environment.equal).toBe(false);
    expect(report.environment.differing).toEqual(['chromium']);
  });
});

describe('compareRefs: the result', () => {
  it('reports identical captures as identical, and as a SUCCESS', async () => {
    const root = await freshRoot();
    const { deps } = harness();
    const { report } = await compareRefs(options(root), deps);
    expect(report.identical).toBe(true);
    expect(report.status).toBe('success');
    expect(report.analysis.changedFrameCount).toBe(0);
  });

  it('reports a change with where it starts, not merely that there was one', async () => {
    const root = await freshRoot();
    const { deps } = harness({
      analyseFrames: async () => ({
        frameCount: 47, changedFrameCount: 12, firstChangedFrame: 8,
        maxChangedPixels: 900, maxChannelDelta: 255, identical: false, frames: [],
      }),
    });
    const { report } = await compareRefs(options(root), deps);
    expect(report.identical).toBe(false);
    expect(report.analysis).toMatchObject({ firstChangedFrame: 8, changedFrameCount: 12, maxChangedPixels: 900 });
  });

  it('routes a still recipe to the still compositor and a temporal one to the temporal compositor', async () => {
    const root = await freshRoot();
    const still = harness();
    await compareRefs(options(root), still.deps);
    expect(still.events).toContain('composeStill');
    expect(still.events).not.toContain('composeTemporal');

    const root2 = await freshRoot();
    const temporal = harness({
      recipeKind: 'frames',
      runCaptureAtRef: async ({ worktree }: { worktree: string }) => ({
        manifest: manifest({ kind: 'frames', frameCount: 47 }), directory: `${worktree}/out`,
      }),
    });
    await compareRefs({ ...options(root2), recipe: 'gallery.ai-tracking.normal' }, temporal.deps);
    expect(temporal.events).toContain('composeTemporal');
    expect(temporal.events).not.toContain('composeStill');
  });
});

describe('compareRefs: cleanup', () => {
  it('cleans up the worktrees on the success path', async () => {
    const root = await freshRoot();
    const { deps, events, owned } = harness();
    await compareRefs(options(root), deps);
    expect(events[events.length - 1]).toBe('cleanup');
    expect(owned.size).toBe(0);
  });

  it.each([
    ['the capture', { runCaptureAtRef: async () => { throw new Error('browser crashed'); } }],
    ['frame analysis', { analyseFrames: async () => { throw new Error('decode failed'); } }],
    ['the encoder', { composeStill: async () => { throw new Error('ffmpeg failed: libx264 not found'); } }],
  ])('cleans up, and removes the partial output, when %s fails', async (_label, override) => {
    // Injected failure at each stage, not just the happy path. The partial directory
    // matters as much as the worktree: a half-written output that survives is
    // indistinguishable from a finished one to the next reader.
    const root = await freshRoot();
    const { deps, events } = harness(override);
    await expect(compareRefs(options(root), deps)).rejects.toThrow();
    expect(events).toContain('cleanup');
    await expect(stat(resolve(root, 'artifacts/compare/x'))).rejects.toThrow(/ENOENT/);
  });

  it('surfaces a cleanup failure to the caller instead of reporting a clean run', async () => {
    // The bug this closes: returning from inside `try` fixes the value before `finally`
    // runs, so the caller is always told cleanup succeeded -- the one thing it must not
    // get wrong, since a leaked worktree needs a human.
    const root = await freshRoot();
    const { deps } = harness();
    (deps.createWorktreeManager as () => unknown) = () => ({
      owned: new Set(),
      add: async (side: { label: string }) => `/ws/${side.label}`,
      removeAll: async () => [{ path: '/ws/base', reason: 'is locked' }],
    });
    const { cleanupFailures } = await compareRefs(options(root), deps);
    expect(cleanupFailures).toEqual([{ path: '/ws/base', reason: 'is locked' }]);
  });
});

/**
 * The same cleanup contract, driven by an external toolchain that is really broken.
 *
 * The injected-failure cases above prove the orchestrator reacts to a rejected stage. They
 * cannot prove that a real `spawn` failure becomes that rejection, because every one of
 * them replaces the code that would do the spawning. These run the REAL prerequisite check,
 * the REAL frame decode and the REAL still compositor against shell shims on a private
 * PATH -- so FFmpeg is genuinely absent, or genuinely present and failing, and the error
 * that reaches the cleanup path is the one `runProcess` built from a real exit status.
 *
 * A real crashed BROWSER is deliberately not attempted: launching one needs Playwright,
 * which is not a repository dependency, so such a test could not run in `verify:quick` at
 * all. That half of the capture stage remains covered by injection only.
 */
describe.skipIf(process.platform === 'win32')('compareRefs against a really broken toolchain', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  /** A capture directory with the files the real decode and compositor stages read. */
  async function captureSide(root: string, label: string, frameCount: number) {
    const directory = resolve(root, 'sides', label);
    await mkdir(resolve(directory, 'frames'), { recursive: true });
    // 24 bytes is exactly what `readPngSize` reads: signature, length, IHDR, w, h. The
    // decode never gets far enough to need pixel data, and inventing valid ones would only
    // hide which stage failed.
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'latin1');
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    await writeFile(resolve(directory, 'capture.png'), png);
    for (let index = 0; index < frameCount; index++) {
      await writeFile(resolve(directory, 'frames', `frame-${String(index).padStart(4, '0')}.png`), png);
    }
    return directory;
  }

  /** Everything the fake harness stubs out with paths that do not exist, made real. */
  async function onDisk(root: string, overrides: Record<string, unknown> = {}) {
    const workspace = await mkdtemp(resolve(tmpdir(), 'compare-ws-'));
    return harness({
      createCompareWorkspace: async () => workspace,
      runCaptureAtRef: async ({ worktree }: { worktree: string }) => ({
        manifest: manifest(),
        directory: await captureSide(root, worktree.endsWith('head') ? 'head' : 'base', 1),
      }),
      ...overrides,
    });
  }

  const outputOf = (root: string) => resolve(root, 'artifacts/compare/x');

  it('spends nothing when a real prerequisite check meets a genuinely missing FFmpeg', async () => {
    // The refusal that has to come first. `resolveRef` is the very next thing the
    // orchestrator would do, so watching it stay uncalled is what distinguishes "checked
    // prerequisites before spending" from "checked them at some point": moving the check
    // below `worktrees.add` leaves the message identical and fails this.
    const root = await freshRoot();
    const { deps, events } = harness({
      inspectPrerequisites,
      env: {
        PATH: await toolDirectory({ ffprobe: respondsToVersion('ffprobe') }),
        PLAYWRIGHT_MODULE: await playwrightThatResolves(CI_PLAYWRIGHT_VERSION),
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.execPath,
      },
    });
    let resolved = false;
    (deps.resolveRef as unknown) = async () => { resolved = true; return {}; };
    await expect(compareRefs(options(root), deps))
      .rejects.toThrow('ffmpeg is required for capture but was not found on PATH');
    expect(resolved).toBe(false);
    expect(events).toEqual([]);
    await expect(stat(outputOf(root))).rejects.toThrow(/ENOENT/);
  });

  it('cleans up and removes the partial output when the real frame decode fails', async () => {
    // Reached through the real `analyseFrames` -> `decodeRgba` -> `runProcess('ffmpeg')`.
    // Unlike the prerequisite case this one happens AFTER the output directory exists, so
    // "removed" is a claim that can fail: deleting the `rm` from the orchestrator's catch
    // leaves the directory behind and fails this line rather than the rejection above it.
    const root = await freshRoot();
    vi.stubEnv('PATH', await toolDirectory({ ffmpeg: failsWith('Invalid data found when processing input') }));
    const { deps, events } = await onDisk(root, { analyseFrames: undefined });
    await expect(compareRefs(options(root), deps))
      .rejects.toThrow(/ffmpeg failed: Invalid data found when processing input/);
    expect(events).toContain('cleanup');
    await expect(stat(outputOf(root))).rejects.toThrow(/ENOENT/);
  });

  it('cleans up and removes the partial output when the real still compositor fails', async () => {
    // The encoder, not the decoder. A globally broken FFmpeg fails at decode first, so
    // frame analysis is held out to let the failure land in `composeStill` -- which by then
    // has already written label files into the workspace and is mid-way through four
    // separate FFmpeg invocations, i.e. exactly the partially-written state that must not
    // survive as something a reader could mistake for a finished comparison.
    const root = await freshRoot();
    vi.stubEnv('PATH', await toolDirectory({ ffmpeg: failsWith("Unknown encoder 'libx264'") }));
    const { deps, events } = await onDisk(root, { composeStill: undefined });
    await expect(compareRefs(options(root), deps))
      .rejects.toThrow(/ffmpeg failed: Unknown encoder 'libx264'/);
    expect(events).toContain('cleanup');
    await expect(stat(outputOf(root))).rejects.toThrow(/ENOENT/);
  });

  it('completes the same two real stages when FFmpeg works, so the failures above are the tool', async () => {
    // The control. Without it, all three cases above would still pass if the real decode
    // and compositor were unreachable for some unrelated reason -- a wrong path, an absent
    // frame, a stage the harness never enters. This runs the identical wiring with shims
    // that answer instead of failing, and requires a published comparison out of it.
    const root = await freshRoot();
    // Decode's byte-length check is not being tested here, so the shim must produce the
    // 640x480 RGBA it was asked for: 640 * 480 * 4.
    vi.stubEnv('PATH', await toolDirectory({ ffmpeg: writesOutputOfBytes(640 * 480 * 4) }));
    const { deps } = await onDisk(root, { analyseFrames: undefined, composeStill: undefined });
    const { report } = await compareRefs(options(root), deps);
    expect(report.status).toBe('success');
    expect(report.identical).toBe(true);
    expect(report.outputs.files).toContain('side-by-side.png');
    await expect(stat(resolve(outputOf(root), 'compare.json'))).resolves.toBeTruthy();
  });
});
