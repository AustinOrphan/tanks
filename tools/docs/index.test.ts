// docs/README.md is generated from document metadata -- see tools/docs/index.mjs. This is
// the devflags/doc.test.ts convention applied to the documentation index: regenerate in
// memory, compare against what is committed, and fail if they differ. The fix for a red run
// here is `npm run docs:index`, never editing the doc or relaxing an assertion.
//
// Every assertion below names the change that would make it fail; the negative-control
// tests apply those changes to a temporary corpus and prove the guard goes red.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INDEX_PATH,
  collectIndexModel,
  renderDocumentIndex,
  validateDocumentIndex,
} from './index.mjs';
import { DOCUMENT_STATUSES } from './metadata.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INDEX = path.join(ROOT, INDEX_PATH);
const SPEC = 'docs/superpowers/specs/fixture.md';
const temporaryRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tanks-document-index-'));
  temporaryRoots.push(root);
  for (const dir of ['docs/superpowers/plans', 'docs/superpowers/specs', 'docs/superpowers/backlog']) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  return root;
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function doc(
  options: { status?: string; scope?: string; title?: string; supersededBy?: string[] } = {},
): string {
  const {
    status = 'active',
    scope = 'Focused index fixture',
    title = 'Fixture document',
    supersededBy = [],
  } = options;
  return [
    '---',
    `status: ${status}`,
    'date: 2026-08-25',
    `scope: ${scope}`,
    'implementation-issues: [1]',
    'implementation-prs: [2]',
    'supersedes: []',
    `superseded-by: [${supersededBy.map((value) => `"${value}"`).join(', ')}]`,
    '---',
    '',
    `# ${title}`,
    '',
    'Body.',
  ].join('\n');
}

/** Regenerate and commit, so the fixture starts from a clean index like the repository. */
function settle(root: string): void {
  write(root, INDEX_PATH, renderDocumentIndex(root));
  expect(validateDocumentIndex(root).diagnostics).toEqual([]);
}

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  expect(start, `missing section: ${heading}`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  return next < 0 ? rest : rest.slice(0, next);
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('docs/README.md is generated, not hand-edited', () => {
  it('matches what the generator produces right now -- run `npm run docs:index` to fix', () => {
    const generated = renderDocumentIndex(ROOT);
    // Vacuity guard: an empty generated string would make the equality below pass
    // trivially against an accidentally-emptied file.
    expect(generated.length).toBeGreaterThan(2000);
    expect(readFileSync(INDEX, 'utf8')).toBe(generated);
    expect(validateDocumentIndex(ROOT).diagnostics).toEqual([]);
  });

  it('self-describes as generated and names its generator command', () => {
    const committed = readFileSync(INDEX, 'utf8');
    expect(committed).toContain('GENERATED');
    expect(committed).toContain('npm run docs:index');
  });

  it('reports a missing index instead of passing vacuously', () => {
    const root = tempRoot();
    write(root, SPEC, doc());
    expect(validateDocumentIndex(root).diagnostics).toHaveLength(1);
    expect(validateDocumentIndex(root).diagnostics[0].message).toContain('missing');
  });
});

describe('the index guard fails on the changes it exists to catch', () => {
  it('goes red when a document is added and the index is not regenerated', () => {
    const root = tempRoot();
    write(root, SPEC, doc());
    settle(root);

    write(root, 'docs/superpowers/specs/added.md', doc({ title: 'Added specification' }));
    const { diagnostics } = validateDocumentIndex(root);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('out of date');
    expect(renderDocumentIndex(root)).toContain('Added specification');
  });

  it('goes red, and moves the row, when a status changes from active to superseded', () => {
    const root = tempRoot();
    const replacement = 'docs/superpowers/specs/replacement.md';
    write(root, replacement, doc({ title: 'Replacement' }));
    write(root, SPEC, doc({ title: 'Older direction' }));
    settle(root);

    const before = readFileSync(path.join(root, INDEX_PATH), 'utf8');
    expect(section(before, 'Current direction')).toContain('Older direction');
    expect(section(before, 'Superseded and historical')).not.toContain('Older direction');

    write(root, SPEC, doc({ title: 'Older direction', status: 'superseded', supersededBy: [replacement] }));
    expect(validateDocumentIndex(root).diagnostics[0]?.message).toContain('out of date');

    const after = renderDocumentIndex(root);
    expect(section(after, 'Current direction')).not.toContain('Older direction');
    expect(section(after, 'Superseded and historical')).toContain('Older direction');
    expect(section(after, 'Superseded and historical')).toContain('replacement.md');
  });

  it('goes red when a document is deleted and the index is not regenerated', () => {
    const root = tempRoot();
    write(root, SPEC, doc());
    write(root, 'docs/superpowers/plans/extra.md', doc({ status: 'completed', title: 'Extra plan' }));
    settle(root);

    rmSync(path.join(root, 'docs/superpowers/plans/extra.md'));
    expect(validateDocumentIndex(root).diagnostics[0]?.message).toContain('out of date');
  });

  it('goes red when a scope line is edited without regenerating', () => {
    const root = tempRoot();
    write(root, SPEC, doc({ scope: 'Original scope' }));
    settle(root);

    write(root, SPEC, doc({ scope: 'Rewritten scope' }));
    expect(validateDocumentIndex(root).diagnostics[0]?.message).toContain('out of date');
    expect(renderDocumentIndex(root)).toContain('Rewritten scope');
  });
});

describe('the index places every document somewhere', () => {
  it.each(DOCUMENT_STATUSES)('gives a `%s` document a visible home', (status) => {
    const root = tempRoot();
    const replacement = 'docs/superpowers/specs/replacement.md';
    write(root, replacement, doc({ title: 'Replacement' }));
    write(
      root,
      SPEC,
      doc({
        status,
        title: `Document with status ${status}`,
        supersededBy: status === 'superseded' ? [replacement] : [],
      }),
    );

    // Fails if a future status is added to the contract without a section here, which is
    // the way a document silently disappears from the index.
    expect(renderDocumentIndex(root)).toContain(`Document with status ${status}`);
  });

  it('counts backlog topics rather than listing them a second time', () => {
    const root = tempRoot();
    write(root, SPEC, doc());
    write(root, 'docs/superpowers/backlog/topic.md', doc({ title: 'Spike: a backlog topic' }));
    const rendered = renderDocumentIndex(root);

    expect(collectIndexModel(root).backlog).toHaveLength(1);
    expect(section(rendered, 'Backlog topics')).toContain('1 document');
    // docs/superpowers/backlog.md is the enumeration, gated by tools/backlog.test.ts.
    // Listing topics here too would give one fact two guarded homes.
    expect(rendered).not.toContain('Spike: a backlog topic');
    expect(rendered).not.toContain('backlog/topic.md');
  });

  it('escapes a pipe in a scope line instead of breaking the table row', () => {
    const root = tempRoot();
    write(root, SPEC, doc({ scope: 'Covers a | b', title: 'Piped scope' }));
    const row = renderDocumentIndex(root)
      .split('\n')
      .find((line) => line.includes('Piped scope')) as string;

    expect(row).toContain('Covers a \\| b');
    // Four columns in the current-direction table: an unescaped pipe would make five.
    expect(row.split(/(?<!\\)\|/)).toHaveLength(6);
  });
});

describe('the real index agrees with the corpus it indexes', () => {
  it('separates current direction from the implementation record by status', () => {
    const model = collectIndexModel(ROOT);
    const committed = readFileSync(INDEX, 'utf8');

    expect(model.current.length).toBeGreaterThan(0);
    expect(model.completed.length).toBeGreaterThan(0);
    expect(model.unclassified).toEqual([]);

    for (const entry of model.current) {
      expect(section(committed, 'Current direction'), entry.path).toContain(entry.title);
      expect(['proposed', 'active']).toContain(entry.status);
    }
    for (const entry of model.historical) {
      expect(section(committed, 'Superseded and historical'), entry.path).toContain(entry.title);
    }
  });

  it('resolves every link it emits', () => {
    const index = renderDocumentIndex(ROOT);
    const targets = [...index.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);

    // Vacuity guard: a generator that emitted no links would pass the loop trivially.
    expect(targets.length).toBeGreaterThanOrEqual(collectIndexModel(ROOT).total - 16);
    for (const target of targets) {
      expect(target, `${target} must be a repository-relative link`).not.toMatch(/^[a-z]+:/);
      const resolved = path.resolve(path.dirname(INDEX), target);
      expect(existsSync(resolved), `${target} is linked from the index but does not exist`).toBe(
        true,
      );
    }
  });

  it('documents where durable decisions and temporary plans belong', () => {
    // Read the generated string, not the committed file: the equality test above already
    // binds the two, and asserting on the generator is what makes this fail when the
    // placement table loses a home rather than only when the file is hand-edited.
    const placement = section(renderDocumentIndex(ROOT), 'Where documentation belongs');

    expect(placement).toContain('docs/superpowers/specs/');
    expect(placement).toContain('docs/superpowers/plans/');
    expect(placement).toContain('docs/superpowers/backlog/');
    expect(placement).toContain('docs/research/');
    expect(placement).toContain('docs/agent/architecture.md');
    expect(placement).toMatch(/durable decision/i);
    expect(placement).toMatch(/temporary plan/i);
  });
});
