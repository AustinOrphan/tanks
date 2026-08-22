import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from './check.mjs';
import {
  DOCUMENT_STATUSES,
  FRONTMATTER_BYTE_LIMIT,
  formatDiagnostics,
  parseDocumentMetadata,
  validateDocumentMetadata,
  validateRepositoryDocuments,
} from './metadata.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PLAN = 'docs/superpowers/plans/example.md';
const SPEC = 'docs/superpowers/specs/current.md';
const temporaryRoots: string[] = [];

function header(lines: string[], body = '# Example\n'): string {
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

function validHeader(extra: string[] = []): string {
  return header([
    'status: active',
    'date: 2026-08-22',
    'scope: Focused metadata fixture',
    'implementation-issues: []',
    'implementation-prs: []',
    'supersedes: []',
    'superseded-by: []',
    ...extra,
  ]);
}

function messages(diagnostics: { message: string }[]): string {
  return diagnostics.map((entry) => entry.message).join('\n');
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tanks-document-metadata-'));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, 'docs/superpowers/plans'), { recursive: true });
  mkdirSync(path.join(root, 'docs/superpowers/specs'), { recursive: true });
  mkdirSync(path.join(root, 'tools/docs'), { recursive: true });
  return root;
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function baseline(root: string, documents: Record<string, string>): void {
  write(
    root,
    'tools/docs/legacy-document-baseline.json',
    `${JSON.stringify({ version: 1, algorithm: 'sha256', documents }, null, 2)}\n`,
  );
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('plan and specification metadata contract', () => {
  it('accepts every documented status through the strict frontmatter parser', () => {
    const known = new Set([PLAN, SPEC]);
    for (const status of DOCUMENT_STATUSES) {
      const supersededBy = status === 'superseded' ? `["${SPEC}"]` : '[]';
      const parsed = parseDocumentMetadata(
        header([
          `status: ${status}`,
          'date: 2026-08-21',
          'last-reviewed: 2026-08-22',
          'scope: Status fixture',
          'implementation-issues: [215, 263]',
          'implementation-prs: [293]',
          'supersedes: []',
          `superseded-by: ${supersededBy}`,
        ]),
        PLAN,
      );
      expect(parsed.diagnostics, status).toEqual([]);
      expect(parsed.metadata, status).not.toBeNull();
      expect(validateDocumentMetadata(parsed.metadata!, PLAN, known), status).toEqual([]);
    }

    // Negative control: accepting an unlisted status would make the five-value contract decorative.
    const invalid = parseDocumentMetadata(
      header(['status: abandoned', 'date: 2026-08-22', 'scope: Invalid status fixture']),
      PLAN,
    );
    expect(messages(validateDocumentMetadata(invalid.metadata!, PLAN, known))).toContain(
      '`status` must be one of',
    );
  });

  it('rejects unknown, duplicate, nested, malformed, and oversized syntax', () => {
    const unknown = parseDocumentMetadata(
      header(['status: active', 'date: 2026-08-22', 'scope: x', 'owner: nobody']),
      PLAN,
    );
    expect(messages(unknown.diagnostics)).toContain('unknown metadata field `owner`');

    const duplicate = parseDocumentMetadata(
      header(['status: active', 'status: completed', 'date: 2026-08-22', 'scope: x']),
      PLAN,
    );
    expect(messages(duplicate.diagnostics)).toContain('duplicate metadata field `status`');

    const nested = parseDocumentMetadata(
      header(['status: active', 'date: 2026-08-22', 'scope: x', 'implementation-issues:', '  - 263']),
      PLAN,
    );
    expect(messages(nested.diagnostics)).toContain('top-level keys and inline arrays only');
    expect(messages(nested.diagnostics)).toContain('inline JSON-compatible YAML array');

    const malformed = parseDocumentMetadata(
      header(['status: active', 'date: 2026-08-22', 'scope: x', 'implementation-prs: [not-json]']),
      PLAN,
    );
    expect(messages(malformed.diagnostics)).toContain('inline JSON-compatible YAML array');

    const oversized = parseDocumentMetadata(
      header(['status: active', 'date: 2026-08-22', `scope: ${'x'.repeat(FRONTMATTER_BYTE_LIMIT)}`]),
      PLAN,
    );
    expect(messages(oversized.diagnostics)).toContain(`exceeds ${FRONTMATTER_BYTE_LIMIT} bytes`);

    const unterminated = parseDocumentMetadata(`---\n${'x'.repeat(FRONTMATTER_BYTE_LIMIT)}`, PLAN);
    expect(messages(unterminated.diagnostics)).toContain(`close within ${FRONTMATTER_BYTE_LIMIT} bytes`);
  });

  it('rejects missing, invalid, contradictory, and excessively broad scalar fields', () => {
    const cases = [
      {
        metadata: { status: 'active', scope: 'x' },
        expected: 'requires `date` or `last-reviewed`',
      },
      {
        metadata: { status: 'active', date: '2026-02-30', scope: 'x' },
        expected: '`date` must be YYYY-MM-DD',
      },
      {
        metadata: {
          status: 'active',
          date: '2026-08-22',
          'last-reviewed': '2026-08-21',
          scope: 'x',
        },
        expected: '`last-reviewed` must not be earlier than `date`',
      },
      {
        metadata: { status: 'active', date: '2026-08-22' },
        expected: 'requires a non-empty `scope`',
      },
      {
        metadata: { status: 'active', date: '2026-08-22', scope: 'x'.repeat(201) },
        expected: '`scope` must be 200 characters or fewer',
      },
    ];
    for (const testCase of cases) {
      expect(messages(validateDocumentMetadata(testCase.metadata, PLAN))).toContain(
        testCase.expected,
      );
    }

    // Negative control: exactly 200 characters remains a valid compact index summary.
    expect(
      validateDocumentMetadata({ status: 'active', date: '2026-08-22', scope: 'x'.repeat(200) }, PLAN),
    ).toEqual([]);
  });

  it('validates implementation references and both sides of supersession relationships', () => {
    const missing = 'docs/superpowers/specs/missing.md';
    const known = new Set([PLAN, SPEC]);
    const diagnostics = validateDocumentMetadata(
      {
        status: 'active',
        date: '2026-08-22',
        scope: 'Relationship failures',
        'implementation-issues': [0, 263, 263],
        'implementation-prs': [-1],
        supersedes: [PLAN, SPEC, SPEC, missing, '../outside.md'],
        'superseded-by': [SPEC],
      },
      PLAN,
      known,
    );
    const output = messages(diagnostics);
    expect(output).toContain('`implementation-issues` values must be positive integers');
    expect(output).toContain('`implementation-issues` contains duplicate value 263');
    expect(output).toContain('`implementation-prs` values must be positive integers');
    expect(output).toContain('`supersedes` must not reference the document itself');
    expect(output).toContain('`supersedes` contains duplicate path');
    expect(output).toContain('`supersedes` target does not exist');
    expect(output).toContain('repository-relative plan or specification paths');
    expect(output).toContain('same document cannot appear in both supersession fields');
    expect(output).toContain('must have `status: superseded`');

    const noReplacement = validateDocumentMetadata(
      { status: 'superseded', date: '2026-08-22', scope: 'Old direction' },
      PLAN,
      known,
    );
    expect(messages(noReplacement)).toContain('require a `superseded-by` target');

    // Negative control: a real, distinct replacement is accepted.
    expect(
      validateDocumentMetadata(
        {
          status: 'superseded',
          date: '2026-08-22',
          scope: 'Old direction',
          'superseded-by': [SPEC],
        },
        PLAN,
        known,
      ),
    ).toEqual([]);
  });
});

describe('incremental repository guard', () => {
  it('grandfathers only the exact immutable bytes of a legacy document', () => {
    const root = tempRoot();
    const original = '# Legacy plan\n';
    write(root, PLAN, original);
    baseline(root, { [PLAN]: hash(original) });

    const unchanged = validateRepositoryDocuments(root);
    expect(unchanged.diagnostics).toEqual([]);
    expect(unchanged).toMatchObject({ files: 1, metadataFiles: 0, legacyFiles: 1 });

    // Negative control: one body-byte change cannot hide behind the grandfathered path.
    write(root, PLAN, '# Changed legacy plan\n');
    const changed = validateRepositoryDocuments(root);
    expect(formatDiagnostics(changed.diagnostics)).toContain(
      'legacy document changed; add metadata rather than updating its baseline hash',
    );

    write(root, PLAN, validHeader());
    const migrated = validateRepositoryDocuments(root);
    expect(migrated.diagnostics).toEqual([]);
    expect(migrated).toMatchObject({ files: 1, metadataFiles: 1, legacyFiles: 0 });
  });

  it('requires metadata for every new plan or specification', () => {
    const root = tempRoot();
    const legacy = '# Legacy spec\n';
    write(root, SPEC, legacy);
    baseline(root, { [SPEC]: hash(legacy) });
    write(root, PLAN, '# New plan\n');

    const missing = validateRepositoryDocuments(root);
    expect(formatDiagnostics(missing.diagnostics)).toContain(
      `${PLAN}:1: missing document metadata`,
    );

    // Negative control: adding valid metadata closes the same path-specific failure.
    write(root, PLAN, validHeader());
    expect(validateRepositoryDocuments(root).diagnostics).toEqual([]);
  });

  it('does not let deletion make an immutable legacy document disappear silently', () => {
    const root = tempRoot();
    baseline(root, { [PLAN]: hash('# Original plan\n') });

    const result = validateRepositoryDocuments(root);
    expect(formatDiagnostics(result.diagnostics)).toContain(
      `${PLAN}:1: document recorded by the immutable legacy baseline is missing`,
    );

    // Negative control: restoring the exact recorded document closes the deletion failure.
    write(root, PLAN, '# Original plan\n');
    expect(validateRepositoryDocuments(root).diagnostics).toEqual([]);
  });

  it('fails useful diagnostics for a missing or malformed legacy baseline', () => {
    const root = tempRoot();
    write(root, PLAN, '# New plan\n');
    let result = validateRepositoryDocuments(root);
    expect(formatDiagnostics(result.diagnostics)).toContain('legacy document baseline is missing');

    write(root, 'tools/docs/legacy-document-baseline.json', '{not json');
    result = validateRepositoryDocuments(root);
    expect(formatDiagnostics(result.diagnostics)).toContain('legacy document baseline is invalid JSON');

    write(
      root,
      'tools/docs/legacy-document-baseline.json',
      JSON.stringify({ version: 2, algorithm: 'md5', documents: { 'outside.md': 'nope' } }),
    );
    result = validateRepositoryDocuments(root);
    const output = formatDiagnostics(result.diagnostics);
    expect(output).toContain('`version` must equal 1');
    expect(output).toContain('`algorithm` must equal `sha256`');
    expect(output).toContain('invalid legacy document path');
    expect(output).toContain('invalid SHA-256');
  });

  it('returns actionable CLI output and a nonzero status on failure', () => {
    const root = tempRoot();
    baseline(root, { [PLAN]: hash('# expected\n') });
    write(root, PLAN, '# changed\n');
    const errors: string[] = [];
    const logs: string[] = [];
    expect(run(root, { error: (value: string) => errors.push(value), log: (value: string) => logs.push(value) })).toBe(1);
    expect(errors.join('\n')).toContain(`${PLAN}:1: legacy document changed`);
    expect(logs).toEqual([]);

    write(root, PLAN, validHeader());
    expect(run(root, { error: (value: string) => errors.push(value), log: (value: string) => logs.push(value) })).toBe(0);
    expect(logs.at(-1)).toContain('1 classified, 0 unchanged legacy, 1 total');
  });

  it('guards the real repository through the canonical unit-test path', () => {
    const result = validateRepositoryDocuments(ROOT);
    expect(result.diagnostics).toEqual([]);
    expect(result.files).toBe(result.metadataFiles + result.legacyFiles);
    expect(result.metadataFiles).toBeGreaterThanOrEqual(2);

    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['docs:check']).toBe('node tools/docs/check.mjs');
    expect(pkg.scripts['verify:quick']).toContain('test:unit');
  });

  it('keeps the one-time legacy baseline immutable', () => {
    const baselineFile = JSON.parse(
      readFileSync(path.join(ROOT, 'tools/docs/legacy-document-baseline.json'), 'utf8'),
    );
    expect(Object.keys(baselineFile.documents)).toHaveLength(46);
    // Negative control: adding a path, deleting one, or refreshing any hash changes this digest.
    expect(
      createHash('sha256').update(JSON.stringify(baselineFile.documents)).digest('hex'),
    ).toBe('b9185e15d3b9cb88c0bdc72adac7b0ceb36fbb20cd5b74ef1ea20cce25fb29e4');
  });
});
