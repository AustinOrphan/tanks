import { runProcess } from './process.mjs';

async function git(root, args, run, signal) {
  try {
    return (await run('git', args, { cwd: root, timeoutMs: 15_000, signal })).stdout.trim();
  } catch (error) {
    throw new Error(`could not inspect capture source state: ${error.message}`, { cause: error });
  }
}

export async function inspectSourceState(root, requestedSourceRef = null, deps = {}) {
  const run = deps.runProcess ?? runProcess;
  const [head, status] = await Promise.all([
    git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], run, deps.signal),
    git(root, ['status', '--porcelain', '--untracked-files=normal'], run, deps.signal),
  ]);
  if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error(`git returned an invalid commit SHA '${head}'`);
  if (requestedSourceRef !== null) {
    const requested = await git(
      root,
      ['rev-parse', '--verify', `${requestedSourceRef}^{commit}`],
      run,
      deps.signal,
    );
    if (requested !== head) {
      throw new Error(
        `--source-ref '${requestedSourceRef}' resolves to ${requested}, but this checkout is ${head}; `
          + 'this command captures the current checkout only',
      );
    }
  }
  return {
    requestedRef: requestedSourceRef,
    commitSha: head,
    dirty: status.length > 0,
  };
}
