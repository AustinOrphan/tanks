// Dependency update hygiene (issue #762): the rules in .github/dependabot.yml that a later edit
// could quietly undo. Read as TEXT, like tools/workflows.test.ts, because the repository has
// no YAML parser; GitHub validates the file's schema itself once it is on the default branch.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const CONFIG = read('.github/dependabot.yml');
const PACKAGE = JSON.parse(read('package.json')) as {
  engines: { node: string };
  workspaces: string[];
  dependencies: Record<string, string>;
};
const WORKFLOWS = readdirSync(new URL('../.github/workflows/', import.meta.url))
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: read(`.github/workflows/${name}`) }));

/** The text of one `updates:` entry, from its `- package-ecosystem:` line to the next. */
function ecosystem(name: string): string {
  const blocks = CONFIG.split(/^ {2}- package-ecosystem: /m).slice(1);
  const block = blocks.find((b) => b.startsWith(`${name}\n`));
  return block ?? '';
}

describe('dependency updates: coverage', () => {
  it('updates npm (the root and its workspaces) and GitHub Actions, each weekly', () => {
    const npm = ecosystem('npm');
    const actions = ecosystem('github-actions');
    expect(npm, 'no npm entry').not.toBe('');
    expect(actions, 'no github-actions entry').not.toBe('');
    for (const block of [npm, actions]) {
      expect(block).toMatch(/^ {4}directory: \/$/m);
      expect(block).toMatch(/^ {6}interval: weekly$/m);
      expect(block).toMatch(/^ {4}open-pull-requests-limit: \d$/m);
      expect(block).toMatch(/^ {6}default-days: [1-9]\d*$/m);
    }
    // tools/mutate is reached through the root's `workspaces`, which Dependabot's npm fetcher
    // reads; a second `directory` for it would be a second, lockfile-less update run.
    expect(PACKAGE.workspaces).toEqual(['tools/mutate']);
    expect(CONFIG.match(/^ {2}- package-ecosystem: npm$/gm)).toHaveLength(1);
  });
});

describe('dependency updates: grouping keeps different risks apart', () => {
  it('groups tooling minor and patch updates, and each runtime dependency only with its own types', () => {
    const npm = ecosystem('npm');
    const text = npm.slice(npm.indexOf('\n    groups:\n'), npm.indexOf('\n    ignore:\n'));
    // Each group's own lines, keyed by name.
    const groups = Object.fromEntries(
      text.split(/^ {6}(?=[\w-]+:$)/m).slice(1).map((g) => [g.slice(0, g.indexOf(':')), g]));
    const runtime = Object.keys(PACKAGE.dependencies).sort();
    expect(runtime).toEqual(['howler', 'three']);
    expect(Object.keys(groups).sort()).toEqual(['tooling-minor-and-patch', ...runtime].sort());

    // Tooling: devDependencies, never a major, and never a runtime dependency's type package,
    // which a devDependency group would otherwise move ahead of its library.
    const tooling = groups['tooling-minor-and-patch'];
    expect(tooling).toContain('  dependency-type: development\n');
    expect(tooling).toContain('  update-types:\n          - minor\n          - patch\n');
    expect(tooling).not.toMatch(/- major|^ {8}patterns:/m);
    for (const dep of runtime) expect(tooling).toContain(`          - '@types/${dep}'`);

    // Runtime: exactly the library and its types, nothing else in the pull request.
    for (const dep of runtime) {
      const patterns = [...groups[dep].matchAll(/^ {10}- '?([^'\n]+)'?$/gm)].map((m) => m[1]);
      expect(patterns, dep).toEqual([dep, `@types/${dep}`]);
    }
  });
});

describe('dependency updates: the Node floor', () => {
  it('never proposes @types/node beyond the supported floor major', () => {
    // engines is `^22.13.0 || ^24.0.0`: the FLOOR is the first alternative. Derived, so a
    // deliberate floor change fails here until the ignore bound moves with it.
    const floorMajor = Number(/^\^(\d+)\./.exec(PACKAGE.engines.node)?.[1]);
    expect(floorMajor).toBeGreaterThan(0);
    expect(ecosystem('npm')).toContain(`      - dependency-name: '@types/node'\n        versions:\n          - '>=${floorMajor + 1}'\n`);
  });
});

describe('dependency updates: review, not automation', () => {
  it('no workflow merges or auto-merges a pull request', () => {
    expect(WORKFLOWS.length, 'no workflows read; this test would pass vacuously').toBeGreaterThan(5);
    for (const { name, text } of WORKFLOWS) {
      expect(text, `${name} fetches Dependabot metadata, the usual auto-merge first step`).not.toContain('dependabot/fetch-metadata');
      expect(text, `${name} merges a pull request`).not.toMatch(/gh pr merge|enablePullRequestAutoMerge|merge_method/);
    }
  });

  it('runs required CI on update pull requests exactly as on any other', () => {
    const ci = read('.github/workflows/ci.yml');
    const triggers = ci.slice(ci.indexOf('\non:'), ci.indexOf('\npermissions:') > 0 ? ci.indexOf('\npermissions:') : ci.indexOf('\njobs:'));
    expect(triggers).toMatch(/^ {2}pull_request:/m);
    for (const { name, text } of WORKFLOWS) {
      expect(text, `${name} special-cases the Dependabot actor`).not.toMatch(/dependabot\[bot\]|github\.actor/);
    }
  });

  it('references GitHub Actions by one policy: first-party actions/* by major tag, anything else by full commit SHA', () => {
    const refs = WORKFLOWS.flatMap(({ name, text }) =>
      [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => ({ name, ref: m[1] })));
    expect(refs.length, 'no uses: found; this test would pass vacuously').toBeGreaterThan(10);
    const offPolicy = refs.filter(({ ref }) =>
      !/^actions\/[\w.-]+@v\d+$/.test(ref) && !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref));
    expect(offPolicy).toEqual([]);
  });
});
