// `npm run showcase:check` (issue #1062). The first test IS the required-CI gate: it runs the
// check over this repository inside `npm run test:unit`. The temporary-repository tests each
// prove one input `run` gathers (git's tracked list, the GIF bytes, the real capture registry,
// the manifest), which validate.test.ts cannot see because it passes those inputs in. The last
// block holds `.gitignore` to the one exception it makes for showcase GIFs.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from './check.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHECK = join(ROOT, 'tools/showcase/check.mjs');

function capture() {
  const lines = { log: [] as string[], error: [] as string[] };
  const io = {
    log: (message: string) => lines.log.push(message),
    error: (message: string) => lines.error.push(message),
  };
  return { io, lines };
}

describe('showcase:check over this repository', () => {
  it('passes, over the clips the manifest holds', () => {
    const { io, lines } = capture();
    expect(run(ROOT, io)).toBe(0);
    expect(lines.error).toEqual([]);
    // Non-vacuity: the population is the manifest's, read here independently.
    const manifest = JSON.parse(readFileSync(join(ROOT, 'tools/showcase/manifest.json'), 'utf8'));
    expect(lines.log).toHaveLength(1);
    expect(lines.log[0]).toMatch(new RegExp(
      `^showcase:check passed over ${manifest.clips.length} clip\\(s\\), \\d+ tracked file\\(s\\) `
        + 'under docs/media/showcase/ and \\d+ byte\\(s\\)\\.$',
    ));
  });

  it('is the showcase:check package script, and passes as a process', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['showcase:check']).toBe('node tools/showcase/check.mjs');
    const result = spawnSync(process.execPath, ['tools/showcase/check.mjs'], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^showcase:check passed over \d+ clip\(s\)/);
  });

  it('runs nothing when imported', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      vi.resetModules();
      const module = await import('./check.mjs');
      expect(typeof module.run).toBe('function');
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(exitCode);
    } finally {
      log.mockRestore();
      error.mockRestore();
      process.exitCode = exitCode;
    }
  });
});

// 640 x 400 (the documentation profile), a two-colour table, loop forever, one 7 cs frame.
// 6 signature + 7 logical screen + 6 colour table + 19 loop extension + 23 frame + 1 trailer.
const GIF = Buffer.from([
  ...Buffer.from('GIF89a', 'ascii'), 0x80, 0x02, 0x90, 0x01, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
  0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, 0x00, 0x00, 0x00,
  0x21, 0xf9, 0x04, 0x00, 0x07, 0x00, 0x00, 0x00,
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0x02, 0x02, 0x4c, 0x01, 0x00,
  0x3b,
]);

const CLIP = {
  id: 'campaign-round',
  recipe: 'flow.campaign-round.docs',
  output: 'docs/media/showcase/campaign-round.gif',
  placement: 'readme',
  caption: 'A campaign round on level 1',
  alt: 'A tan player tank banks a shell off a wall into a brown enemy tank.',
  maxBytes: 2_000_000,
  order: 1,
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A scratch git repository holding `files`, of which only `track` is added to the index. */
function repository(files: Record<string, string | Buffer>, track: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'showcase-check-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  // -f: the developer's own global excludes must not decide what this fixture tracks.
  if (track.length > 0) execFileSync('git', ['add', '-f', '--', ...track], { cwd: root, stdio: 'ignore' });
  return root;
}

const DOCUMENTS = ['tools/showcase/manifest.json', 'README.md', 'docs/showcase.md'];

function showcase(clips: object[], gif: Buffer | null = GIF): Record<string, string | Buffer> {
  return {
    'tools/showcase/manifest.json': JSON.stringify({ version: 1, clips }),
    'README.md': `# Tanks!\n\n![${CLIP.alt}](${CLIP.output})\n`,
    'docs/showcase.md': '# Showcase\n',
    ...(gif === null ? {} : { [CLIP.output]: gif }),
  };
}

describe('showcase:check in a scratch repository', () => {
  it('passes a tracked, conforming clip and counts it', () => {
    const root = repository(showcase([CLIP]), [...DOCUMENTS, CLIP.output]);
    const { io, lines } = capture();
    expect(run(root, io)).toBe(0);
    expect(lines.error).toEqual([]);
    expect(lines.log).toEqual([
      'showcase:check passed over 1 clip(s), 1 tracked file(s) under docs/media/showcase/ and 62 byte(s).',
    ]);
  });

  it('reads the tracked list from git, so a GIF on disk but never added fails', () => {
    const root = repository(showcase([CLIP]), DOCUMENTS);
    const { io, lines } = capture();
    expect(run(root, io)).toBe(1);
    expect(lines.error).toEqual([
      "clip 'campaign-round': docs/media/showcase/campaign-round.gif is not a tracked file",
    ]);
    expect(lines.log).toEqual([
      'showcase:check 1 problem(s) over 1 clip(s), 0 tracked file(s) under docs/media/showcase/ and '
        + '0 byte(s).',
    ]);
  });

  it('measures the GIF bytes, so a truncated file fails instead of measuring as zeros', () => {
    const root = repository(showcase([CLIP], GIF.subarray(0, GIF.length - 1)), [...DOCUMENTS, CLIP.output]);
    const { io, lines } = capture();
    expect(run(root, io)).toBe(1);
    expect(lines.error).toEqual([
      "clip 'campaign-round': docs/media/showcase/campaign-round.gif cannot be measured: GIF has no "
        + 'trailer',
    ]);
  });

  it('asks the real capture registry for each recipe and its artifact formats', () => {
    const still = repository(showcase([{ ...CLIP, recipe: 'screen.levels' }]), [...DOCUMENTS, CLIP.output]);
    const stillLines = capture();
    expect(run(still, stillLines.io)).toBe(1);
    expect(stillLines.lines.error).toEqual([
      "clip 'campaign-round': recipe 'screen.levels' declares no gif artifact (it declares png)",
    ]);

    const typo = repository(showcase([{ ...CLIP, recipe: 'flow.campaign-round.doc' }]), [...DOCUMENTS, CLIP.output]);
    const typoLines = capture();
    expect(run(typo, typoLines.io)).toBe(1);
    expect(typoLines.lines.error).toEqual([
      "clip 'campaign-round': recipe 'flow.campaign-round.doc' is not in the capture registry",
    ]);
  });

  it('fails a stray tracked file with no clips, and exits 1 as a process', () => {
    const files = { ...showcase([], null), 'README.md': '# Tanks!\n',
      'docs/media/showcase/stray.mp4': 'not a clip' };
    const root = repository(files, [...DOCUMENTS, 'docs/media/showcase/stray.mp4']);
    const { io, lines } = capture();
    expect(run(root, io)).toBe(1);
    const stray = 'docs/media/showcase/stray.mp4 is tracked under docs/media/showcase/ but is not a '
      + 'manifest output';
    expect(lines.error).toEqual([stray]);
    expect(lines.log).toEqual([
      'showcase:check 1 problem(s) over 0 clip(s), 1 tracked file(s) under docs/media/showcase/ and '
        + '0 byte(s).',
    ]);
    const result = spawnSync(process.execPath, [CHECK], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(stray);
  });

  it('refuses a manifest that is not JSON', () => {
    const root = repository({ ...showcase([]), 'tools/showcase/manifest.json': '{ "version": 1,' }, DOCUMENTS);
    const { io, lines } = capture();
    expect(run(root, io)).toBe(1);
    expect(lines.error).toHaveLength(1);
    expect(lines.error[0]).toMatch(/^tools\/showcase\/manifest\.json: /);
    expect(lines.log).toEqual([]);
  });
});

/** An ignore file's rule lines: not blank and not a comment. */
function ruleLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
}

/**
 * Whether one ignore pattern (its `!` stripped) matches a path or a parent directory of it: the
 * subset of gitignore syntax this repository's file uses (`*`, `**`, `?`, a leading `/` or an
 * inner `/` anchoring the pattern, a trailing `/` matching directories only).
 */
function matches(rule: string, file: string): boolean {
  let pattern = (rule.startsWith('!') ? rule.slice(1) : rule).trimEnd();
  const directoryOnly = pattern.endsWith('/');
  if (directoryOnly) pattern = pattern.slice(0, -1);
  const anchored = pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  const body = pattern.split(/(\*\*\/|\/\*\*|\*|\?)/).map((part) => {
    if (part === '**/') return '(?:.*/)?';
    if (part === '/**') return '/.*';
    if (part === '*') return '[^/]*';
    if (part === '?') return '[^/]';
    return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }).join('');
  const regex = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}$`);
  const parts = file.split('/');
  for (let length = 1; length <= parts.length; length += 1) {
    const isDirectory = length < parts.length;
    if ((isDirectory || !directoryOnly) && regex.test(parts.slice(0, length).join('/'))) return true;
  }
  return false;
}

/** Last matching rule wins, as in git. */
function ignored(rules: string[], file: string): boolean {
  let state = false;
  for (const rule of rules) if (matches(rule, file)) state = !rule.startsWith('!');
  return state;
}

const NEGATION = '!docs/media/showcase/*.gif';
const SHOWCASE_GIF = 'docs/media/showcase/clip.gif';
const NEIGHBOUR_GIF = 'docs/media/other/x.gif';
const ROOT_GIF = 'x.gif';

/** What is wrong with an ignore file's showcase exception; empty when it is right. */
function ignoreProblems(text: string): string[] {
  const rules = ruleLines(text);
  const problems: string[] = [];
  const gif = rules.indexOf('*.gif');
  const negation = rules.indexOf(NEGATION);
  if (gif === -1) problems.push('the *.gif rule is missing');
  if (negation === -1) problems.push('the showcase negation is missing');
  if (gif !== -1 && negation !== -1 && negation < gif) problems.push('the negation precedes *.gif');
  // A line singles out the showcase directory when it matches a GIF there but not the same
  // GIF everywhere; *.gif matches all three probes, so it is the blanket rule, not one of these.
  const singling = rules.filter((rule) => matches(rule, SHOWCASE_GIF)
    && !(matches(rule, NEIGHBOUR_GIF) && matches(rule, ROOT_GIF)));
  if (singling.length !== 1 || singling[0] !== NEGATION) {
    problems.push(`lines that single out docs/media/showcase/: ${JSON.stringify(singling)}`);
  }
  return problems;
}

describe('showcase .gitignore exception', () => {
  const real = readFileSync(join(ROOT, '.gitignore'), 'utf8');

  it('keeps *.gif, and re-admits only GIFs directly in docs/media/showcase/', () => {
    expect(ignoreProblems(real)).toEqual([]);
    const rules = ruleLines(real);
    // The three paths the pull request records with `git check-ignore -v`.
    expect(ignored(rules, SHOWCASE_GIF)).toBe(false);
    expect(ignored(rules, NEIGHBOUR_GIF)).toBe(true);
    expect(ignored(rules, ROOT_GIF)).toBe(true);
    expect(ignored(rules, 'docs/media/showcase/frames/0001.gif')).toBe(true);
  });

  // Synthetic known-bad files, each one edit away from the real one.
  it.each([
    ['*.gif removed', real.replace(/^\*\.gif\n/m, ''), ['the *.gif rule is missing']],
    ['the negation commented out', real.replace(NEGATION, `# ${NEGATION}`), [
      'the showcase negation is missing',
      'lines that single out docs/media/showcase/: []',
    ]],
    ['the negation moved above *.gif', real.replace(`${NEGATION}\n`, '').replace('*.gif\n', `${NEGATION}\n*.gif\n`), [
      'the negation precedes *.gif',
    ]],
    ['a rule ignoring docs/media/ added', `${real}docs/media/\n`, [
      'lines that single out docs/media/showcase/: ["!docs/media/showcase/*.gif","docs/media/"]',
    ]],
    ['a rule re-ignoring the showcase added', `${real}/docs/media/showcase/*\n`, [
      'lines that single out docs/media/showcase/: ["!docs/media/showcase/*.gif","/docs/media/showcase/*"]',
    ]],
  ])('fails with %s', (_name, text, expected) => {
    expect(text).not.toBe(real);
    expect(ignoreProblems(text)).toEqual(expected);
  });
});
