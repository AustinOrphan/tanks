import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { CAPTURE_USAGE, parseCaptureArgs } from './args.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { prepareTemporaryRoot, relativeInside, resolveOutputPath } from './paths.mjs';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('capture command arguments', () => {
  it('pins the obvious npm command entry point and documents both modes', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(packageJson.scripts.capture).toBe('node tools/capture/run.mjs');
    expect(CAPTURE_USAGE).toContain('npm run capture -- --list');
    expect(CAPTURE_USAGE).toContain('npm run capture -- --recipe <id>');
  });

  it('parses the documented list and recipe command surfaces', () => {
    expect(parseCaptureArgs(['--list'])).toMatchObject({ list: true, recipe: null });
    expect(parseCaptureArgs([
      '--recipe', 'gallery.ai-tracking.normal',
      '--out', 'artifacts/capture',
      '--retain-frames',
      '--source-ref', 'main',
    ])).toEqual({
      help: false,
      list: false,
      recipe: 'gallery.ai-tracking.normal',
      out: 'artifacts/capture',
      retainFrames: true,
      sourceRef: 'main',
    });
  });

  it('rejects ambiguous, duplicate, and command-like options', () => {
    expect(() => parseCaptureArgs([])).toThrow(/choose --list or --recipe/);
    expect(() => parseCaptureArgs(['--list', '--recipe', 'gallery.fire.still'])).toThrow(/cannot be combined/);
    expect(() => parseCaptureArgs(['--list', '--out', 'artifacts/capture'])).toThrow(/require --recipe/);
    expect(() => parseCaptureArgs(['--list', '--list'])).toThrow(/duplicate option/);
    expect(() => parseCaptureArgs(['--recipe', 'gallery.fire.still;touch-owned'])).toThrow(/invalid recipe ID/);
    expect(() => parseCaptureArgs(['--recipe', 'gallery.fire.still', '--source-ref', '--upload-pack=x']))
      .toThrow(/needs a value/);
    expect(() => parseCaptureArgs(['--recipe', 'gallery.fire.still', '--source-ref', 'refs/../HEAD']))
      .toThrow(/invalid --source-ref/);
    expect(() => parseCaptureArgs(['--shell', 'rm'])).toThrow(/unknown option/);
  });
});

describe('capture output paths', () => {
  it('resolves a safe relative path inside the checkout', async () => {
    // realpath pins this to a plain checkout: macOS's tmpdir sits behind the /var ->
    // /private/var symlink, and the symlinked-root case has its own test below.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'capture-paths-')));
    cleanup.push(root);
    await mkdir(join(root, 'artifacts'));
    expect(resolveOutputPath(root, 'artifacts/capture')).toEqual({
      absolute: join(root, 'artifacts', 'capture'),
      relative: 'artifacts/capture',
    });
  });

  it('rejects traversal, absolute paths, alternate separators, and unsafe segments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capture-paths-'));
    cleanup.push(root);
    for (const output of [
      '../outside',
      'artifacts/../outside',
      '/tmp/outside',
      'C:\\outside',
      'artifacts\\capture',
      'artifacts//capture',
      'artifacts/$(touch-owned)',
      'artifacts/CON',
      'artifacts/trailing.',
    ]) {
      expect(() => resolveOutputPath(root, output), output).toThrow(/output path|unsafe/);
    }
  });

  it.skipIf(process.platform === 'win32')('rejects an existing parent symlink that escapes the checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capture-paths-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'capture-paths-outside-'));
    cleanup.push(root, outside);
    await symlink(outside, join(root, 'artifacts'));
    expect(() => resolveOutputPath(root, 'artifacts/capture')).toThrow(/symbolic link/);
  });

  it.skipIf(process.platform === 'win32')('rejects a pre-existing tmp symlink before workspace creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capture-tmp-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'capture-tmp-outside-'));
    cleanup.push(root, outside);
    await symlink(outside, join(root, 'tmp'));
    await expect(prepareTemporaryRoot(root)).rejects.toThrow(/tmp root must not be a symbolic link/);
  });
});

describe('capture workspace containment', () => {
  it.skipIf(process.platform === 'win32')('keeps a workspace under a symlinked root inside the checkout', async () => {
    const real = await realpath(await mkdtemp(join(tmpdir(), 'capture-contain-real-')));
    const outer = await realpath(await mkdtemp(join(tmpdir(), 'capture-contain-link-')));
    cleanup.push(real, outer);
    const link = join(outer, 'checkout');
    await symlink(real, link);
    const producer = join(real, 'tmp', 'capture-abc', 'producer');
    await mkdir(producer, { recursive: true });
    // The runner hands createTemporaryWorkspace's canonical path back against the root it
    // was given; a lexical comparison sees `../../<real>/tmp/...` and calls it an escape.
    expect(relativeInside(link, producer)).toBe('tmp/capture-abc/producer');
  });

  it.skipIf(process.platform === 'win32')('rejects a workspace that only looks inside the checkout', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'capture-contain-root-')));
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'capture-contain-outside-')));
    cleanup.push(root, outside);
    await symlink(outside, join(root, 'tmp'));
    await mkdir(join(outside, 'capture-abc'));
    // Lexically `tmp/capture-abc`; really a directory outside the checkout.
    expect(() => relativeInside(root, join(root, 'tmp', 'capture-abc'))).toThrow(/escaped the repository/);
  });

  it('rejects a workspace outside the checkout', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'capture-contain-root-')));
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'capture-contain-outside-')));
    cleanup.push(root, outside);
    expect(() => relativeInside(root, outside)).toThrow(/escaped the repository/);
  });
});
