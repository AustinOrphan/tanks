import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
// @ts-expect-error -- plain-node ESM module, no types
import { createWorktreeManager, createCompareWorkspace } from './worktrees.mjs';

const SHA = 'c'.repeat(40);

function recorder(behaviour: Record<string, Error> = {}) {
  const calls: string[][] = [];
  const runProcess = async (command: string, args: string[], options: Record<string, unknown>) => {
    calls.push([command, ...args]);
    const failure = behaviour[args.slice(0, 2).join(' ')];
    if (failure) throw failure;
    return { stdout: '', stderr: '', code: 0, options };
  };
  return { runProcess, calls, said: (needle: string) => calls.some((c) => c.join(' ').includes(needle)) };
}

const side = (label: string) => ({ label, requestedRef: label, commitSha: SHA });

describe('createWorktreeManager: creating a side', () => {
  it('checks out the exact SHA, detached, and links the shared node_modules', async () => {
    const run = recorder();
    const linked: string[][] = [];
    const manager = createWorktreeManager('/repo', '/repo/tmp/compare-x', {
      runProcess: run.runProcess, linkSharedModules: async (w: string, r: string) => { linked.push([w, r]); },
    });
    const path = await manager.add(side('base'));
    expect(path).toBe('/repo/tmp/compare-x/base');
    // The SHA, not the ref: a branch that moves mid-run must not make the two halves
    // disagree, and --detach is what keeps the run off any branch at all.
    expect(run.calls[0]).toEqual(['git', 'worktree', 'add', '--detach', '/repo/tmp/compare-x/base', SHA]);
    expect(linked).toEqual([['/repo/tmp/compare-x/base', '/repo']]);
    expect(manager.owned.has(path)).toBe(true);
  });

  it('never reaches for the shared stash or for prune', async () => {
    // Both are shared across every worktree on the machine: a stash/pop can swallow
    // another session's uncommitted work, and prune collects other sessions' stale
    // entries. Asserted on the recorded argv rather than trusted to code review.
    const run = recorder();
    const manager = createWorktreeManager('/repo', '/repo/tmp/compare-x', {
      runProcess: run.runProcess, linkSharedModules: async () => {},
    });
    await manager.add(side('base'));
    await manager.removeAll();
    expect(run.said('stash')).toBe(false);
    expect(run.said('prune')).toBe(false);
  });

  it('owns nothing when `git worktree add` itself fails', async () => {
    // Nothing was created, so cleanup must not try to remove it -- that error would mask
    // the real one. This is the half a happy-path test cannot see.
    const run = recorder({ 'worktree add': new Error('fatal: invalid reference') });
    const manager = createWorktreeManager('/repo', '/repo/tmp/compare-x', {
      runProcess: run.runProcess, linkSharedModules: async () => {},
    });
    await expect(manager.add(side('base'))).rejects.toThrow(/could not create the base worktree at ccccccc/);
    expect(manager.owned.size).toBe(0);
  });

  it('OWNS the worktree when linking fails after it was created', async () => {
    // The mirror image, and the one that leaks if `owned.add` sits in the wrong place:
    // git did create a worktree, so cleanup has to remove it even though `add` threw.
    const run = recorder();
    const manager = createWorktreeManager('/repo', '/repo/tmp/compare-x', {
      runProcess: run.runProcess,
      linkSharedModules: async () => { throw new Error('no node_modules'); },
    });
    await expect(manager.add(side('base'))).rejects.toThrow(/could not populate the base worktree/);
    expect([...manager.owned]).toEqual(['/repo/tmp/compare-x/base']);
  });
});

describe('createWorktreeManager: cleanup', () => {
  it('removes every side it created, then the workspace', async () => {
    const run = recorder();
    const manager = createWorktreeManager('/repo', '/repo/tmp/compare-x', {
      runProcess: run.runProcess, linkSharedModules: async () => {},
    });
    await manager.add(side('base'));
    await manager.add(side('head'));
    expect(await manager.removeAll()).toEqual([]);
    const removals = run.calls.filter((c) => c[1] === 'worktree' && c[2] === 'remove').map((c) => c[4]);
    expect(removals).toEqual(['/repo/tmp/compare-x/base', '/repo/tmp/compare-x/head']);
    expect(manager.owned.size).toBe(0);
  });

  it('reports a failed removal as data instead of throwing over the original error', async () => {
    // Cleanup runs on the failure path. If it threw, it would replace the error that
    // caused it and the user would be told the wrong thing went wrong.
    const run = recorder({ 'worktree remove': new Error('is dirty, use --force') });
    const manager = createWorktreeManager('/repo', '/repo/tmp/compare-x', {
      runProcess: run.runProcess, linkSharedModules: async () => {},
    });
    await manager.add(side('base'));
    const failures = await manager.removeAll();
    expect(failures).toHaveLength(1);
    expect(failures[0].path).toBe('/repo/tmp/compare-x/base');
    expect(failures[0].reason).toMatch(/is dirty/);
    // And it still does not fall back to prune to force the issue.
    expect(run.said('prune')).toBe(false);
  });

  it('refuses to remove a tracked path that is not inside the run workspace', async () => {
    // The backstop behind "never delete or reuse an existing user worktree": even if the
    // owned set were somehow poisoned, a path outside this run's workspace is reported,
    // not deleted.
    const run = recorder();
    const manager = createWorktreeManager('/repo', '/repo/tmp/compare-x', {
      runProcess: run.runProcess, linkSharedModules: async () => {},
    });
    manager.owned.add('/repo/.claude/worktrees/someone-elses-work');
    const failures = await manager.removeAll();
    expect(failures[0]).toMatchObject({ path: '/repo/.claude/worktrees/someone-elses-work' });
    expect(failures[0].reason).toMatch(/refusing to remove/);
    expect(run.said('worktree remove')).toBe(false);
  });

  it('is idempotent, so a second cleanup after a crash-and-retry removes nothing twice', async () => {
    const run = recorder();
    const manager = createWorktreeManager('/repo', '/repo/tmp/compare-x', {
      runProcess: run.runProcess, linkSharedModules: async () => {},
    });
    await manager.add(side('base'));
    await manager.removeAll();
    const before = run.calls.length;
    expect(await manager.removeAll()).toEqual([]);
    expect(run.calls.length).toBe(before); // no second `git worktree remove`
  });
});

describe('createCompareWorkspace', () => {
  it('creates a unique directory under the validated tmp root', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'compare-ws-'));
    await mkdir(resolve(root, 'tmp'), { recursive: true });
    const a = await createCompareWorkspace(root);
    const b = await createCompareWorkspace(root);
    expect(a).not.toBe(b); // two concurrent runs must not collide
    const entries = await readdir(resolve(root, 'tmp'));
    expect(entries.filter((e) => e.startsWith('compare-'))).toHaveLength(2);
  });

  it('refuses when the tmp root is a symlink', async () => {
    // Inherited from capture's prepareTemporaryRoot: a planted `tmp` symlink would put
    // every worktree this command creates somewhere it never validated.
    const root = await mkdtemp(resolve(tmpdir(), 'compare-ws-'));
    const elsewhere = await mkdtemp(resolve(tmpdir(), 'compare-elsewhere-'));
    await writeFile(resolve(elsewhere, 'marker'), 'x');
    const { symlink } = await import('node:fs/promises');
    await symlink(elsewhere, resolve(root, 'tmp'), 'dir');
    await expect(createCompareWorkspace(root)).rejects.toThrow(/must not be a symbolic link/);
  });
});
