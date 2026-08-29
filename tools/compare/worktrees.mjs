/**
 * Isolated source trees for the two sides of a comparison.
 *
 * THE CALLER'S CHECKOUT IS NEVER TOUCHED. No branch switch, no `git checkout`, no patching,
 * no `git clean`. Two prohibitions are worth stating outright because both are the obvious
 * convenience and both are destructive here:
 *
 *   - NEVER `git stash`. The stash stack is shared by every worktree on the machine, so a
 *     stash/pop pair can swallow another session's uncommitted work. This tool has no
 *     reason to stash at all -- it reads history, it does not need the caller's tree clean.
 *   - NEVER `git worktree prune`. Prune removes stale administrative entries for EVERY
 *     worktree, not just this run's. A crashed unrelated session's entry is not ours to
 *     collect.
 *
 * What this does own, it tracks by absolute path, and it refuses to remove anything it did
 * not create -- which is what makes "never delete or reuse an existing user worktree" hold
 * even across a crash and a re-run.
 */
import { mkdtemp, realpath, rm, symlink, access } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { runProcess } from '../capture/process.mjs';
import { prepareTemporaryRoot } from '../capture/paths.mjs';

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * One `tmp/compare-*` directory per run, holding both sides.
 *
 * Inside the checkout rather than the OS temp dir, for the same reason capture puts its
 * workspace there: `tmp/` is gitignored, `prepareTemporaryRoot` refuses a pre-existing
 * symlink, and everything this command creates stays under a path the repository already
 * treats as disposable. Verified that a worktree nested here leaves `git status` clean.
 */
export async function createCompareWorkspace(root, deps = {}) {
  const temporaryRoot = await (deps.prepareTemporaryRoot ?? prepareTemporaryRoot)(root);
  const workspace = await mkdtemp(resolve(temporaryRoot, 'compare-'));
  const real = await realpath(workspace);
  if (!inside(temporaryRoot, real)) {
    await rm(workspace, { recursive: true, force: true });
    throw new Error('internal compare workspace escaped the validated tmp root');
  }
  return real;
}

/**
 * Both sides run against the CALLER's `node_modules`, by symlink.
 *
 * This is the contract requirement, not a shortcut: "both sides use the same external
 * capture environment" means one Playwright, one Chromium, one FFmpeg. Installing
 * separately per ref would let base and head render through different browser builds and
 * quietly attribute the difference to the code. It also happens to be what makes a
 * comparison affordable -- an install per side would dominate a run that otherwise takes
 * seconds.
 *
 * The consequence to state out loud: the captures are produced by each ref's SOURCE against
 * the caller's DEPENDENCIES. For a change to a dependency version rather than to this
 * repository's code, that is the wrong tool.
 */
async function linkSharedModules(worktree, root) {
  const shared = resolve(root, 'node_modules');
  try {
    await access(shared);
  } catch (error) {
    throw new Error(
      `no node_modules in ${root}; compare runs both refs against the caller's installed `
        + 'dependencies so that a single browser and encoder produce both sides. Install first.',
      { cause: error },
    );
  }
  await symlink(shared, resolve(worktree, 'node_modules'), 'dir');
}

export function createWorktreeManager(root, workspace, deps = {}) {
  const run = deps.runProcess ?? runProcess;
  const link = deps.linkSharedModules ?? linkSharedModules;
  /** Absolute paths this manager created, and nothing else. */
  const owned = new Set();

  return {
    owned,

    /** Check out one side, detached, at its exact resolved SHA. */
    async add(side) {
      const path = resolve(workspace, side.label);
      if (!inside(workspace, path)) throw new Error(`refusing to create a worktree outside the run workspace: ${path}`);
      try {
        await run(
          'git',
          ['worktree', 'add', '--detach', path, side.commitSha],
          { cwd: root, timeoutMs: 120_000, signal: deps.signal },
        );
      } catch (error) {
        throw new Error(`could not create the ${side.label} worktree at ${side.commitSha.slice(0, 7)}: ${error.message}`, { cause: error });
      }
      // Recorded only once `add` has actually succeeded. Recording earlier would make
      // cleanup try to remove a worktree git never registered, and that error would mask
      // the real one; recording later would leak the worktree if linking throws.
      owned.add(path);
      try {
        await link(path, root);
      } catch (error) {
        throw new Error(`could not populate the ${side.label} worktree: ${error.message}`, { cause: error });
      }
      return path;
    },

    /**
     * Remove every worktree this manager created, then the workspace.
     *
     * Runs on the failure path as well as the success path, so it never throws: a cleanup
     * error must not replace the error that caused the cleanup. Failures come back as data
     * for the caller to report.
     */
    async removeAll() {
      const failures = [];
      for (const path of owned) {
        if (!inside(workspace, path)) {
          failures.push({ path, reason: 'outside the run workspace; refusing to remove' });
          continue;
        }
        try {
          await run('git', ['worktree', 'remove', '--force', path], { cwd: root, timeoutMs: 60_000 });
        } catch (error) {
          // Deliberately NOT falling back to `git worktree prune`, which would collect
          // every other session's stale entries too. A leaked administrative entry is
          // reported so a human can remove that one path.
          failures.push({ path, reason: error.message });
        }
      }
      owned.clear();
      try {
        await rm(workspace, { recursive: true, force: true });
      } catch (error) {
        failures.push({ path: workspace, reason: error.message });
      }
      return failures;
    },
  };
}
