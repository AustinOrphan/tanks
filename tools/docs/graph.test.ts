import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDocumentGraph } from './graph.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OLD = 'docs/superpowers/specs/old.md';
const NEW = 'docs/superpowers/specs/new.md';
const temporaryRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tanks-document-graph-'));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, 'docs/superpowers/plans'), { recursive: true });
  mkdirSync(path.join(root, 'docs/superpowers/specs'), { recursive: true });
  return root;
}

function doc(
  root: string,
  relative: string,
  fields: { status?: string; supersedes?: string[]; supersededBy?: string[] },
): void {
  const lines = [
    '---',
    `status: ${fields.status ?? 'active'}`,
    'date: 2026-08-23',
    'scope: Graph fixture',
    `supersedes: ${JSON.stringify(fields.supersedes ?? [])}`,
    `superseded-by: ${JSON.stringify(fields.supersededBy ?? [])}`,
    '---',
    '# Fixture',
    '',
  ];
  writeFileSync(path.join(root, relative), lines.join('\n'));
}

function legacy(root: string, relative: string): void {
  writeFileSync(path.join(root, relative), '# Legacy fixture without metadata\n');
}

function messages(root: string): string {
  return validateDocumentGraph(root)
    .diagnostics.map((value: { file: string; message: string }) => `${value.file}: ${value.message}`)
    .join('\n');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('document supersession graph', () => {
  it('accepts a reciprocal supersession pair', () => {
    const root = tempRoot();
    doc(root, NEW, { supersedes: [OLD] });
    doc(root, OLD, { status: 'superseded', supersededBy: [NEW] });
    const result = validateDocumentGraph(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.documents).toBe(2);
    expect(result.links).toBe(1);
  });

  it('rejects a supersedes link the target does not reciprocate', () => {
    const root = tempRoot();
    doc(root, NEW, { supersedes: [OLD] });
    doc(root, OLD, { status: 'superseded', supersededBy: ['docs/superpowers/specs/other.md'] });
    doc(root, 'docs/superpowers/specs/other.md', { supersedes: [OLD] });
    expect(messages(root)).toContain(
      `${NEW}: \`supersedes\` \`${OLD}\`, which does not record \`superseded-by\` \`${NEW}\``,
    );
  });

  it('rejects a superseded-by link the replacement does not reciprocate', () => {
    const root = tempRoot();
    doc(root, OLD, { status: 'superseded', supersededBy: [NEW] });
    doc(root, NEW, {});
    expect(messages(root)).toContain(
      `${OLD}: \`superseded-by\` \`${NEW}\`, which does not record \`supersedes\` \`${OLD}\``,
    );
  });

  it('rejects supersession links whose target is still unclassified', () => {
    const root = tempRoot();
    doc(root, NEW, { supersedes: [OLD] });
    legacy(root, OLD);
    expect(messages(root)).toContain(
      `${NEW}: \`supersedes\` target \`${OLD}\` has no metadata; classify it first`,
    );
  });

  it('rejects supersession cycles', () => {
    const root = tempRoot();
    const third = 'docs/superpowers/specs/third.md';
    doc(root, NEW, { supersedes: [OLD], supersededBy: [third] });
    doc(root, OLD, { status: 'superseded', supersedes: [third], supersededBy: [NEW] });
    doc(root, third, { status: 'superseded', supersedes: [NEW], supersededBy: [OLD] });
    expect(messages(root)).toContain('supersession cycle:');
  });

  it('guards the real repository graph through the canonical unit-test path', () => {
    const result = validateDocumentGraph(ROOT);
    expect(result.diagnostics).toEqual([]);
    expect(result.links).toBeGreaterThanOrEqual(2);
    expect(result.documents).toBeGreaterThanOrEqual(33);
  });
});
