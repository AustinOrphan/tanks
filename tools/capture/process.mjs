import { spawn } from 'node:child_process';

function signalTree(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
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
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    let settled = false;

    const append = (chunks, chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        signalTree(child, 'SIGKILL');
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', (chunk) => append(stdout, chunk));
    child.stderr.on('data', (chunk) => append(stderr, chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      signalTree(child, 'SIGTERM');
      setTimeout(() => signalTree(child, 'SIGKILL'), 2_000).unref();
    }, timeoutMs);
    timer.unref();

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const wrapped = new Error(`could not start ${command}: ${error.message}`, { cause: error });
      wrapped.code = error.code;
      reject(wrapped);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signalTree(child, 'SIGTERM');
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (bytes > maxOutputBytes) {
        reject(new Error(`${command} exceeded its ${maxOutputBytes}-byte output limit`));
      } else if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      } else if (code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${code}`;
        const error = new Error(`${command} failed: ${detail}`);
        Object.assign(error, result);
        reject(error);
      } else resolve(result);
    });
  });
}
