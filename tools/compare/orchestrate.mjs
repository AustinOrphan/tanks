/**
 * The compare run, start to finish.
 *
 * Every expensive or destructive step is an injected seam, so the whole control flow --
 * ref resolution, a dirty caller tree, worktree cleanup, a missing or incompatible recipe,
 * identical captures, changed captures, a mismatched schedule, an encoder failure -- is
 * exercised by tests that need neither Playwright nor FFmpeg. That is not only for speed:
 * Playwright is deliberately not a repository dependency, so a test that needed a real
 * capture could not run in `verify:quick` at all.
 *
 * ORDER IS THE DESIGN. Everything knowable from `git show` is checked before a worktree
 * exists, because a refusal that has already created two checkouts and run two browsers has
 * cost the user a minute to learn something the object database could have said instantly --
 * and because a refusal with no worktree has nothing to leak.
 */
import { mkdir, rm, writeFile, readdir, cp } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { resolveRef, inspectCallerTree, readRegistryAtSha, requireRecipe, short } from './refs.mjs';
import { checkRecipeCompatibility, describeIncompatibility, checkEnvironmentParity } from './compatibility.mjs';
import { createCompareWorkspace, createWorktreeManager } from './worktrees.mjs';
import { runCaptureAtRef } from './capture-runner.mjs';
import { decodeRgba, comparePixels, summariseFrames } from './pixels.mjs';
import { composeStill, composeTemporal, fitLabel } from './compose.mjs';
import { resolveOutputPath } from '../capture/paths.mjs';
import { inspectPrerequisites } from '../capture/prerequisites.mjs';

export const COMPARE_SCHEMA_VERSION = 1;

/**
 * Refuse two captures that are not measuring the same thing.
 *
 * Dimensions and frame count come from each side's OWN manifest, which records what was
 * actually produced rather than what the recipe asked for. A recipe can be byte-identical
 * on both refs and still yield different frame counts, because the scenario length is the
 * simulation's to decide -- and that is precisely a case where padding one side would
 * manufacture a clean-looking comparison out of two incomparable clips.
 */
function requireComparable(base, head) {
  const bv = base.manifest.capture.viewport;
  const hv = head.manifest.capture.viewport;
  if (bv.width !== hv.width || bv.height !== hv.height || bv.devicePixelRatio !== hv.devicePixelRatio) {
    throw new Error(
      `the two captures have different dimensions -- base ${bv.width}x${bv.height}@${bv.devicePixelRatio}, `
        + `head ${hv.width}x${hv.height}@${hv.devicePixelRatio}. They are not comparable, and scaling one to `
        + 'match would invent a difference image out of a resize.',
    );
  }
  const bs = base.manifest.capture.frameSchedule;
  const hs = head.manifest.capture.frameSchedule;
  if (bs.kind !== hs.kind) {
    throw new Error(`base captured a '${bs.kind}' schedule and head captured a '${hs.kind}' schedule`);
  }
  if (bs.frameCount !== hs.frameCount) {
    throw new Error(
      `the two captures have different frame counts -- base ${bs.frameCount}, head ${hs.frameCount}. `
        + 'Neither side will be frozen, padded, or retimed to conceal that.',
    );
  }
  return { kind: bs.kind, frameCount: bs.frameCount };
}

/**
 * Keep each side's complete capture beside the comparison.
 *
 * The comparison is a derived artifact; the two captures are the primary evidence, and a
 * reader who doubts the composite needs to be able to open the originals and each side's
 * own `capture.json` -- which records the seed, schedule, assertions and tool versions that
 * produced it. Without them, `compare.json` is asking to be taken on trust.
 *
 * The raw frames are the bulky part (a 47-frame clip is several megabytes a side), so they
 * follow only under `--retain-frames`. The manifest and the encoded artifacts always do.
 */
async function retainSourceCaptures(sides, outAbsolute, retainFrames, deps) {
  const copy = deps.cp ?? cp;
  for (const label of ['base', 'head']) {
    await copy(sides[label].directory, resolve(outAbsolute, label), {
      recursive: true,
      filter: (source) => retainFrames || !source.includes(`${sep}frames`),
    });
  }
}

async function framePaths(directory, deps) {
  const list = deps.readdir ?? readdir;
  const entries = (await list(resolve(directory, 'frames'))).filter((name) => name.endsWith('.png')).sort();
  return entries.map((name) => resolve(directory, 'frames', name));
}

/**
 * Compare every paired raw frame.
 *
 * Pairing is positional over the sorted frame list, which is meaningful only because both
 * sides passed `requireComparable` and capture renumbers its frames contiguously from zero.
 */
async function analyseFrames(base, head, workspace, deps) {
  const decode = deps.decodeRgba ?? decodeRgba;
  const baseFrames = await framePaths(base.directory, deps);
  const headFrames = await framePaths(head.directory, deps);
  if (baseFrames.length !== headFrames.length) {
    throw new Error(`retained frame counts differ -- base ${baseFrames.length}, head ${headFrames.length}`);
  }
  const results = [];
  for (let index = 0; index < baseFrames.length; index++) {
    const b = await decode(baseFrames[index], resolve(workspace, `base-${index}.raw`), deps);
    const h = await decode(headFrames[index], resolve(workspace, `head-${index}.raw`), deps);
    results.push(comparePixels(b, h));
  }
  return summariseFrames(results);
}

export async function compareRefs(options, deps = {}) {
  const root = options.root;
  const log = deps.log ?? (() => {});
  const io = {
    resolveRef: deps.resolveRef ?? resolveRef,
    inspectCallerTree: deps.inspectCallerTree ?? inspectCallerTree,
    readRegistryAtSha: deps.readRegistryAtSha ?? readRegistryAtSha,
    createCompareWorkspace: deps.createCompareWorkspace ?? createCompareWorkspace,
    createWorktreeManager: deps.createWorktreeManager ?? createWorktreeManager,
    runCaptureAtRef: deps.runCaptureAtRef ?? runCaptureAtRef,
    composeStill: deps.composeStill ?? composeStill,
    composeTemporal: deps.composeTemporal ?? composeTemporal,
    analyseFrames: deps.analyseFrames ?? analyseFrames,
    inspectPrerequisites: deps.inspectPrerequisites ?? inspectPrerequisites,
    mkdir: deps.mkdir ?? mkdir,
    rm: deps.rm ?? rm,
    writeFile: deps.writeFile ?? writeFile,
  };

  // ---- Phase 1: everything the object database can answer, before any worktree ----
  //
  // Prerequisites come FIRST, and compare checks them itself rather than inheriting
  // capture's check. Capture's fires inside a worktree, which for this command means after
  // two checkouts already exist -- and compare additionally shells out to FFmpeg for the
  // composition step, a dependency it owns rather than borrows. Learning that ffmpeg is
  // missing should not cost two checkouts and two browser runs.
  const prerequisites = await io.inspectPrerequisites(deps.env ?? process.env, { signal: deps.signal });

  const [base, head] = await Promise.all([
    io.resolveRef(root, 'base', options.base, deps),
    io.resolveRef(root, 'head', options.head, deps),
  ]);
  if (base.commitSha === head.commitSha) {
    throw new Error(
      `--base ${short(base)} and --head ${short(head)} are the same commit; there is nothing to compare`,
    );
  }
  const caller = await io.inspectCallerTree(root, deps);
  const [baseRegistry, headRegistry] = await Promise.all([
    io.readRegistryAtSha(root, base, deps),
    io.readRegistryAtSha(root, head, deps),
  ]);
  const baseEntry = requireRecipe(baseRegistry, base, options.recipe);
  const headEntry = requireRecipe(headRegistry, head, options.recipe);
  const compatibility = checkRecipeCompatibility(baseEntry, headEntry);
  if (!compatibility.compatible) {
    throw new Error(describeIncompatibility(options.recipe, base, head, compatibility));
  }

  const output = resolveOutputPath(root, options.out);
  // Parents are created freely; the LEAF is created non-recursively so that an existing
  // one is an EEXIST rather than a silent success. Same rule as capture: never overwrite.
  // Evidence a reader might already have shared is not this command's to replace.
  await io.mkdir(dirname(output.absolute), { recursive: true });
  await io.mkdir(output.absolute, { recursive: false }).catch((error) => {
    if (error.code === 'EEXIST') {
      throw new Error(`${output.relative} already exists; choose a new --out or remove the obsolete directory`);
    }
    throw error;
  });

  // ---- Phase 2: the expensive half, with cleanup guaranteed on every exit ----
  const workspace = await io.createCompareWorkspace(root, deps);
  const worktrees = io.createWorktreeManager(root, workspace, deps);
  let cleanupFailures = [];
  let result = null;
  try {
    const sides = {};
    for (const side of [base, head]) {
      log(`preparing ${side.label} at ${short(side)}`);
      const worktree = await worktrees.add(side);
      log(`capturing ${options.recipe} at ${side.label}`);
      sides[side.label] = await io.runCaptureAtRef({ worktree, recipeId: options.recipe }, deps);
    }
    const shape = requireComparable(sides.base, sides.head);
    const environment = checkEnvironmentParity(sides.base.manifest, sides.head.manifest);

    log('comparing raw frames');
    const analysis = await io.analyseFrames(sides.base, sides.head, workspace, deps);
    const { width } = sides.base.manifest.capture.viewport;
    const labels = {
      base: fitLabel('base', base.commitSha, base.requestedRef, width),
      head: fitLabel('head', head.commitSha, head.requestedRef, width),
    };

    log('retaining both source captures');
    await (deps.retainSourceCaptures ?? retainSourceCaptures)(sides, output.absolute, options.retainFrames === true, deps);

    log(`composing ${shape.kind === 'still' ? 'still' : 'temporal'} evidence`);
    const files = shape.kind === 'still'
      ? await io.composeStill({
        basePng: resolve(sides.base.directory, headEntry.recipe.artifacts[0].filename),
        headPng: resolve(sides.head.directory, headEntry.recipe.artifacts[0].filename),
        baseLabel: labels.base, headLabel: labels.head,
        outDir: output.absolute, workspace,
      }, deps)
      : await io.composeTemporal({
        baseFrames: resolve(sides.base.directory, 'frames', 'frame-%04d.png'),
        headFrames: resolve(sides.head.directory, 'frames', 'frame-%04d.png'),
        frameCount: shape.frameCount,
        fps: headEntry.recipe.playback.intendedFps ?? headEntry.recipe.schedule.tickRate,
        baseLabel: labels.base, headLabel: labels.head,
        outDir: output.absolute, workspace,
      }, deps);

    const report = {
      schemaVersion: COMPARE_SCHEMA_VERSION,
      status: 'success',
      identical: analysis.identical,
      recipe: {
        id: options.recipe,
        version: headEntry.recipe.recipeVersion,
        contentHash: headEntry.hash,
        compatibility: {
          compatible: true, baseHash: compatibility.baseHash, headHash: compatibility.headHash,
        },
      },
      refs: {
        base: { requested: base.requestedRef, commitSha: base.commitSha, manifest: `${base.label}/capture.json` },
        head: { requested: head.requestedRef, commitSha: head.commitSha, manifest: `${head.label}/capture.json` },
        callerTreeDirty: caller.dirty,
      },
      capture: {
        viewport: sides.base.manifest.capture.viewport,
        frameSchedule: shape,
        sourceManifests: { base: sides.base.manifest, head: sides.head.manifest },
      },
      environment,
      prerequisites: {
        playwright: prerequisites.playwright?.version ?? null,
        ffmpeg: prerequisites.ffmpeg,
        ffprobe: prerequisites.ffprobe,
      },
      analysis: {
        pairing: 'positional over each side\'s sorted retained frames',
        frameCount: analysis.frameCount,
        changedFrameCount: analysis.changedFrameCount,
        firstChangedFrame: analysis.firstChangedFrame,
        maxChangedPixels: analysis.maxChangedPixels,
        maxChannelDelta: analysis.maxChannelDelta,
        frames: analysis.frames,
      },
      outputs: { files, sourceCaptures: { base: 'base/', head: 'head/' }, retainedFrames: options.retainFrames === true },
      reproduce:
        `npm run capture:compare -- --recipe ${options.recipe} --base ${base.requestedRef} `
          + `--head ${head.requestedRef} --out ${output.relative}`,
    };
    await io.writeFile(resolve(output.absolute, 'compare.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    result = { report, output };
  } catch (error) {
    // A partially written output directory must never be left looking like a result. Same
    // rule capture applies to its own publication, for the same reason: the next reader
    // cannot tell a half-finished directory from a finished one.
    await io.rm(output.absolute, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    cleanupFailures = await worktrees.removeAll();
    for (const failure of cleanupFailures) {
      log(`WARNING: could not clean up ${failure.path}: ${failure.reason}`);
    }
  }
  // Deliberately assembled AFTER the finally block. Returning from inside `try` would fix
  // the value of `cleanupFailures` before cleanup had run, so the caller would always be
  // told cleanup was clean -- which is exactly the thing it must not get wrong.
  return { ...result, cleanupFailures };
}
