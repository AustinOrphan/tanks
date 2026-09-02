import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** Resolve a user-facing output path without permitting traversal or symlink escape. */
export function resolveOutputPath(root, raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('output path must not be empty');
  if (isAbsolute(raw) || win32.isAbsolute(raw)) throw new Error('output path must be relative to the repository');
  if (raw.includes('\\')) throw new Error('output path must use forward slashes');
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('output path must not contain empty, dot, or parent-directory segments');
  }
  for (const segment of segments) {
    if (
      !SEGMENT.test(segment)
      || segment.includes('..')
      || segment.endsWith('.')
      || WINDOWS_DEVICE.test(segment)
    ) {
      throw new Error(`unsafe output path segment '${segment}'`);
    }
  }

  const realRoot = realpathSync(root);
  const absolute = resolve(realRoot, ...segments);
  if (!inside(realRoot, absolute)) throw new Error('output path escapes the repository');

  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realAncestor = realpathSync(ancestor);
  if (!inside(realRoot, realAncestor)) {
    throw new Error('output path escapes the repository through a symbolic link');
  }

  return { absolute, relative: segments.join('/') };
}

/**
 * Root-relative POSIX path of a directory inside the checkout, decided by real location.
 * The caller's root may reach the checkout through a symbolic link (macOS's tmpdir does)
 * while the workspace it is compared against is already canonical, and a `tmp` that is
 * itself a link out of the root must not pass on its spelling. `native` matches the
 * fs/promises realpath that produced the workspace: the JS realpath keeps the caller's
 * letter case, which a case-insensitive filesystem would otherwise read as an escape.
 */
export function relativeInside(root, target) {
  const rel = relative(realpathSync.native(root), realpathSync.native(target));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('internal capture workspace escaped the repository');
  }
  return rel.split(sep).join('/');
}

/** Refuse a pre-existing tmp symlink before creating the unique capture workspace. */
export async function prepareTemporaryRoot(root) {
  const realRoot = await realpath(root);
  const temporaryRoot = resolve(realRoot, 'tmp');
  try {
    await mkdir(temporaryRoot);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const info = await lstat(temporaryRoot);
  if (info.isSymbolicLink()) {
    throw new Error('internal capture tmp root must not be a symbolic link');
  }
  if (!info.isDirectory()) throw new Error('internal capture tmp root must be a directory');
  const resolvedRoot = await realpath(temporaryRoot);
  if (!inside(realRoot, resolvedRoot)) {
    throw new Error('internal capture tmp root escapes the repository');
  }
  return resolvedRoot;
}

export async function createTemporaryWorkspace(root) {
  const temporaryRoot = await prepareTemporaryRoot(root);
  const workspace = await mkdtemp(resolve(temporaryRoot, 'capture-'));
  const realWorkspace = await realpath(workspace);
  if (!inside(temporaryRoot, realWorkspace)) {
    await rm(workspace, { recursive: true, force: true });
    throw new Error('internal capture workspace escaped the validated tmp root');
  }
  return realWorkspace;
}
