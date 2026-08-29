#!/usr/bin/env node
/**
 * `npm run capture:compare` -- capture one reviewed recipe at two refs and assemble
 * labelled before/after evidence.
 *
 * Wiring only, and deliberately the same shape as tools/capture/run.mjs: an exported
 * function with injectable seams, the same cooperative signal handling, the same exit-code
 * vocabulary. Two commands that behave differently under Ctrl-C are two commands a user has
 * to learn separately.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMPARE_USAGE, defaultCompareOut, parseCompareArgs } from './args.mjs';
import { CaptureCancelledError, findCancellation } from '../capture/cancellation.mjs';
import { forceTerminateActiveProcesses } from '../capture/process.mjs';
import { compareRefs } from './orchestrate.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export async function runCompareCli(configuration = {}) {
  const {
    argv = process.argv.slice(2),
    root = ROOT,
    compare = compareRefs,
    compareDeps = {},
    log = console.log,
    error = console.error,
    processObject = process,
  } = configuration;
  const controller = new AbortController();
  let firstSignal = null;
  let hardExitTimer = null;

  const handleSignal = (signalName) => {
    if (firstSignal === null) {
      firstSignal = signalName;
      error(`compare received ${signalName}; cancelling and cleaning up`);
      controller.abort(new CaptureCancelledError(signalName));
      return;
    }
    error(`compare received ${signalName} again; forcing subprocess termination`);
    forceTerminateActiveProcesses();
    if (hardExitTimer === null) {
      hardExitTimer = setTimeout(() => processObject.exit(128 + (signalName === 'SIGINT' ? 2 : 15)), 2_000);
    }
  };
  const onSigint = () => handleSignal('SIGINT');
  const onSigterm = () => handleSignal('SIGTERM');
  processObject.on('SIGINT', onSigint);
  processObject.on('SIGTERM', onSigterm);

  try {
    let options;
    try {
      options = parseCompareArgs(argv);
    } catch (parseError) {
      error(parseError.message);
      error('');
      error(COMPARE_USAGE);
      return 2;
    }
    if (options.help) {
      log(COMPARE_USAGE);
      return 0;
    }

    const { report, output, cleanupFailures } = await compare(
      { ...options, root, out: options.out ?? defaultCompareOut(options.recipe) },
      { signal: controller.signal, log, ...compareDeps },
    );

    // A ZERO-DIFFERENCE RESULT IS EVIDENCE, NOT A FAILURE. Reported plainly and with the
    // same exit status as any other successful run, so that neither a reader nor a script
    // learns to treat "nothing changed" as something going wrong. A change that was
    // expected to move pixels and did not is a finding.
    log(
      report.identical
        ? `IDENTICAL: all ${report.analysis.frameCount} frame(s) match exactly between the two refs.`
        : `CHANGED: ${report.analysis.changedFrameCount} of ${report.analysis.frameCount} frame(s) differ; `
          + `at most ${report.analysis.maxChangedPixels} pixel(s) in a frame, peak channel delta `
          + `${report.analysis.maxChannelDelta}.`,
    );
    if (!report.environment.equal) {
      error(
        `WARNING: the two captures were produced by different tooling (${report.environment.differing.join(', ')}); `
          + 'some of the difference may be the environment rather than the code.',
      );
    }
    if (report.refs.callerTreeDirty) {
      error(
        'NOTE: your working tree has uncommitted changes. Both sides were captured from COMMITS, '
          + 'so this evidence does not include them.',
      );
    }
    for (const file of [...report.outputs.files, 'compare.json']) log(`  ${output.relative}/${file}`);

    if (firstSignal !== null) return new CaptureCancelledError(firstSignal).exitCode;
    // A leaked worktree is not a successful run: it needs a human, and a zero exit would
    // hide that from any script wrapping this command.
    return cleanupFailures.length > 0 ? 1 : 0;
  } catch (caught) {
    const cancelled = findCancellation(caught)
      ?? (firstSignal === null ? null : new CaptureCancelledError(firstSignal));
    if (cancelled) {
      error(`${cancelled.message}; cleanup complete`);
      return cancelled.exitCode;
    }
    error(`compare failed: ${caught.message ?? caught}`);
    return 1;
  } finally {
    processObject.removeListener('SIGINT', onSigint);
    processObject.removeListener('SIGTERM', onSigterm);
    if (hardExitTimer !== null) clearTimeout(hardExitTimer);
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) process.exitCode = await runCompareCli();
