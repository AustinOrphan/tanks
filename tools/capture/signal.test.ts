import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { signalExitCode } from './cancellation.mjs';

const roots: string[] = [];
const processGroups = new Set<number>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: any) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch {
      // The fixture has not reached the requested state yet.
    }
    if (Date.now() >= deadline) throw new Error(`condition did not become true within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function childExit(child: ReturnType<typeof spawn>, timeoutMs = 15_000) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>(
    (resolve, reject) => {
      const stderr: Buffer[] = [];
      child.stderr?.on('data', (chunk) => stderr.push(chunk));
      const timer = setTimeout(
        () => reject(new Error(`capture CLI did not exit within ${timeoutMs}ms`)),
        timeoutMs,
      );
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stderr: Buffer.concat(stderr).toString('utf8') });
      });
    },
  );
}

afterEach(async () => {
  for (const pid of processGroups) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  processGroups.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('capture CLI signal cancellation', () => {
  it('maps conventional signal exit statuses', () => {
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode('SIGTERM')).toBe(143);
  });

  it.skipIf(process.platform === 'win32').each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'handles %s cooperatively and removes descendants, workspace, partial output, and lock',
    async (signalName, expectedCode) => {
      // Deliberately not realpath'd: on macOS this drives the real CLI through the
      // /var -> /private/var symlink (#482's reproduction), on Linux through a plain root.
      const root = await mkdtemp(join(tmpdir(), 'capture-signal-'));
      roots.push(root);
      const pidFile = join(root, 'pids.json');
      const fixture = new URL('./test-fixtures/signal-cli.mjs', import.meta.url);
      const child = spawn(process.execPath, [fixture.pathname, root, pidFile], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      const pids = await waitFor(
        async () => JSON.parse(await readFile(pidFile, 'utf8')),
        (value) => Number.isInteger(value.groupLeaderPid) && Number.isInteger(value.descendantPid),
      );
      processGroups.add(pids.groupLeaderPid);
      const lock = join(root, 'artifacts/capture/signal-test.capture.lock');
      await waitFor(async () => access(lock).then(() => true), Boolean);
      const workspace = await waitFor(
        async () => readdir(join(root, 'tmp')),
        (names) => names.some((name) => name.startsWith('capture-')),
      );
      expect(workspace.some((name) => name.startsWith('capture-'))).toBe(true);
      expect(alive(pids.descendantPid)).toBe(true);

      child.kill(signalName);
      const exited = await childExit(child);
      expect(exited, exited.stderr).toMatchObject({ code: expectedCode, signal: null });
      await waitFor(async () => groupAlive(pids.groupLeaderPid), (value) => value === false);
      await waitFor(async () => alive(pids.descendantPid), (value) => value === false);
      processGroups.delete(pids.groupLeaderPid);

      await expect(access(join(root, 'artifacts/capture/signal-test'))).rejects.toThrow();
      await expect(access(lock)).rejects.toThrow();
      expect(await readdir(join(root, 'tmp'))).toEqual([]);
    },
    25_000,
  );
});
