import { existsSync, realpathSync } from 'node:fs';
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

export function relativeInside(root, target) {
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('internal capture workspace escaped the repository');
  }
  return rel.split(sep).join('/');
}
