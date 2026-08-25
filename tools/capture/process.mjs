import { spawn } from 'node:child_process';
import { cancellationError, throwIfAborted } from './cancellation.mjs';

const activeChildren = new Set();

export function signalTree(child, signal) {
  const pid = typeof child === 'number' ? child : child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      if (typeof child !== 'number') child.kill(signal);
      else process.kill(pid, signal);
    } else process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function processTreeExists(child) {
  const pid = typeof child === 'number' ? child : child.pid;
  if (pid === undefined) return false;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForTreeExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processTreeExists(child)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

async function reapTree(child, graceMs = 250) {
  signalTree(child, 'SIGTERM');
  if (await waitForTreeExit(child, graceMs)) return;
  signalTree(child, 'SIGKILL');
  await waitForTreeExit(child, 1_000);
}

/** Used only by the CLI's repeated-signal escape hatch. Normal cancellation is cooperative. */
export function forceTerminateActiveProcesses() {
  for (const child of activeChildren) {
    try {
      signalTree(child, 'SIGKILL');
    } catch {
      // The bounded hard-exit fallback still guarantees that a repeated signal cannot hang.
    }
  }
}

/**
 * Execute argv without a shell. On POSIX the command gets a private process group so a
 * timeout or completed wrapper can also reap a leaked Vite/Chromium descendant.
 */
export function runProcess(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 60_000,
    maxOutputBytes = 16 * 1024 * 1024,
    signal,
  } = options;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    let terminationError = null;
    let forceTimer = null;

    const requestTermination = (error, { force = false } = {}) => {
      if (terminationError === null) terminationError = error;
      signalTree(child, force ? 'SIGKILL' : 'SIGTERM');
      if (!force && forceTimer === null) {
        forceTimer = setTimeout(() => signalTree(child, 'SIGKILL'), 2_000);
        forceTimer.unref();
      }
    };

    const append = (chunks, chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        requestTermination(
          new Error(`${command} exceeded its ${maxOutputBytes}-byte output limit`),
          { force: true },
        );
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', (chunk) => append(stdout, chunk));
    child.stderr.on('data', (chunk) => append(stderr, chunk));

    const timer = setTimeout(() => {
      requestTermination(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    const onAbort = () => requestTermination(cancellationError(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer !== null) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', onAbort);
      activeChildren.delete(child);
      const wrapped = new Error(`could not start ${command}: ${error.message}`, { cause: error });
      wrapped.code = error.code;
      reject(wrapped);
    });
    child.once('close', async (code, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer !== null) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', onAbort);
      await reapTree(child).catch(() => {});
      activeChildren.delete(child);
      const result = {
        code,
        signal: exitSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (terminationError !== null) reject(terminationError);
      else if (code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${code}`;
        const error = new Error(`${command} failed: ${detail}`);
        Object.assign(error, result);
        reject(error);
      } else resolve(result);
    });
  });
}
