import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from './check.mjs';
import { INDEX_PATH, renderDocumentIndex } from './index.mjs';
import {
  RESEARCH_CLASSIFICATIONS,
  RESEARCH_INVENTORY_PATH,
  collectResearchPaths,
  validateResearchInventory,
} from './research.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOC = 'docs/research/example.md';
const temporaryRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tanks-research-inventory-'));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, 'docs/research'), { recursive: true });
  mkdirSync(path.join(root, 'tools/docs'), { recursive: true });
  return root;
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: DOC,
    date: '2026-08-09',
    'last-reviewed': '2026-08-23',
    scope: 'Focused research fixture',
    tags: ['testing'],
    classification: 'public-prototype',
    relevance: 'Current fixture relevance',
    'related-issues': [],
    'related-prs': [],
    'related-docs': [],
    ...overrides,
  };
}

function inventory(root: string, entries: Record<string, unknown>[], version = 1): void {
  write(root, RESEARCH_INVENTORY_PATH, JSON.stringify({ version, documents: entries }));
}

function messages(root: string): string {
  return validateResearchInventory(root)
    .diagnostics.map((value: { message: string }) => value.message)
    .join('\n');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('research inventory contract', () => {
  it('accepts a complete valid inventory', () => {
    const root = tempRoot();
    write(root, DOC, '# Example\n');
    inventory(root, [entry()]);
    const result = validateResearchInventory(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.documents).toBe(1);
    expect(result.entries).toBe(1);
  });

  it('accepts an absent inventory only while no research documents exist', () => {
    const empty = tempRoot();
    rmSync(path.join(empty, 'docs/research'), { recursive: true, force: true });
    expect(validateResearchInventory(empty).diagnostics).toEqual([]);

    const withDoc = tempRoot();
    write(withDoc, DOC, '# Example\n');
    expect(messages(withDoc)).toContain('research inventory is missing');
  });

  it('detects added, removed, and duplicated documents as drift', () => {
    const root = tempRoot();
    write(root, DOC, '# Example\n');
    write(root, 'docs/research/added.md', '# Added\n');
    inventory(root, [entry(), entry({ path: 'docs/research/removed.md' }), entry()]);
    const output = messages(root);
    expect(output).toContain('research document missing from the inventory: `docs/research/added.md`');
    expect(output).toContain('inventory entry has no research document: `docs/research/removed.md`');
    expect(output).toContain(`duplicate inventory entry for \`${DOC}\``);
  });

  it('collects research documents recursively and sorted', () => {
    const root = tempRoot();
    write(root, 'docs/research/nested/deep.md', '# Deep\n');
    write(root, DOC, '# Example\n');
    write(root, 'docs/research/notes.txt', 'not markdown\n');
    expect(collectResearchPaths(root)).toEqual([DOC, 'docs/research/nested/deep.md']);
  });

  it('rejects invalid JSON, versions, and entry shapes', () => {
    const root = tempRoot();
    write(root, DOC, '# Example\n');
    write(root, RESEARCH_INVENTORY_PATH, '{not json');
    expect(messages(root)).toContain('research inventory is invalid JSON');

    write(root, RESEARCH_INVENTORY_PATH, JSON.stringify({ version: 2, documents: {} }));
    const output = messages(root);
    expect(output).toContain('`version` must equal 1');
    expect(output).toContain('`documents` must be an array');
  });

  it('validates entry fields with named negative controls', () => {
    const root = tempRoot();
    write(root, DOC, '# Example\n');
    inventory(root, [
      entry({
        scope: '',
        relevance: 'x'.repeat(201),
        tags: ['Upper', 'ok-tag', 'ok-tag'],
        classification: 'private',
        date: '2026-13-01',
        'related-issues': [0, 5, 5],
        'related-prs': [1.5],
        'related-docs': ['src/main.ts', 'docs/research/ghost.md', 'docs/research/ghost.md'],
      }),
    ]);
    const output = messages(root);
    expect(output).toContain('non-empty `scope`');
    expect(output).toContain('`relevance` must be 200 characters or fewer');
    expect(output).toContain('`tags` values must be lowercase kebab-case');
    expect(output).toContain('`tags` contains duplicate value `ok-tag`');
    expect(output).toContain(`\`classification\` must be one of: ${RESEARCH_CLASSIFICATIONS.join(', ')}`);
    expect(output).toContain('`date` must be YYYY-MM-DD');
    expect(output).toContain('`related-issues` values must be positive integers');
    expect(output).toContain('`related-issues` contains duplicate value 5');
    expect(output).toContain('`related-prs` values must be positive integers');
    expect(output).toContain('`related-docs` values must be repository-relative `docs/` paths');
    expect(output).toContain('`related-docs` target does not exist: `docs/research/ghost.md`');
    expect(output).toContain('`related-docs` contains duplicate path `docs/research/ghost.md`');
  });

  it('rejects a review date before the original date and unsorted entries', () => {
    const root = tempRoot();
    write(root, DOC, '# Example\n');
    write(root, 'docs/research/alpha.md', '# Alpha\n');
    inventory(root, [
      entry({ 'last-reviewed': '2026-08-01' }),
      entry({ path: 'docs/research/alpha.md' }),
    ]);
    const output = messages(root);
    expect(output).toContain('`last-reviewed` must not be earlier than `date`');
    expect(output).toContain('inventory entries must be sorted by `path`');
  });

  it('fails the shared CLI runner on research drift and logs counts on success', () => {
    const root = tempRoot();
    write(root, DOC, '# Example\n');
    write(
      root,
      'docs/superpowers/plans/example.md',
      '---\nstatus: active\ndate: 2026-08-22\nscope: Runner fixture\n---\n# Plan\n',
    );
    write(
      root,
      'tools/docs/legacy-document-baseline.json',
      JSON.stringify({
        version: 1,
        algorithm: 'sha256',
        documents: { 'docs/superpowers/plans/example.md': '0'.repeat(64) },
      }),
    );
    const errors: string[] = [];
    const logs: string[] = [];
    const io = {
      error: (value: string) => errors.push(value),
      log: (value: string) => logs.push(value),
    };
    expect(run(root, io)).toBe(1);
    expect(errors.join('\n')).toContain('research inventory is missing');

    inventory(root, [entry()]);
    // The canonical check also gates docs/README.md against its generator, so a fixture
    // that passes it has to carry a current index.
    write(root, INDEX_PATH, renderDocumentIndex(root));
    expect(run(root, io)).toBe(0);
    expect(logs.join('\n')).toContain('Research inventory valid: 1 documents.');
  });

  it('guards the real repository inventory through the canonical unit-test path', () => {
    const result = validateResearchInventory(ROOT);
    expect(result.diagnostics).toEqual([]);
    expect(result.documents).toBeGreaterThanOrEqual(4);
    expect(result.entries).toBe(result.documents);
  });
});
