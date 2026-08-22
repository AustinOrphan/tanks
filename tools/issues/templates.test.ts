import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const FORMS = [
  '.github/ISSUE_TEMPLATE/bug.yml',
  '.github/ISSUE_TEMPLATE/feature.yml',
  '.github/ISSUE_TEMPLATE/maintenance.yml',
];

const AREAS = [
  'area:repository',
  'area:ui',
  'area:ai',
  'area:versus',
  'area:rendering',
  'area:gameplay',
  'area:developer-tools',
];

const IMPACTS = ['impact:high', 'impact:medium', 'impact:low'];

const formProblems = (text: string): string[] => {
  const problems = [];
  for (const heading of [
    'label: Primary area',
    'label: Expected impact',
    'label: Acceptance criteria',
    'label: Verification and evidence',
    'label: Dependencies',
  ]) {
    if (!text.includes(heading)) problems.push(`missing ${heading}`);
  }
  const ids = [...text.matchAll(/^\s+id:\s+([a-z0-9_]+)\s*$/gm)].map((match) => match[1]);
  if (new Set(ids).size !== ids.length) problems.push('duplicate id');
  if (ids.length < 7) problems.push('too few fields');
  return problems;
};

describe('agent-ready issue forms', () => {
  it('provides three substantive focused forms with stable triage headings', () => {
    for (const path of FORMS) {
      const form = read(path);
      expect(form.length, path).toBeGreaterThan(1500);
      expect(formProblems(form), path).toEqual([]);
      expect(form).toContain('docs/agent/task-sizing.md');
    }
  });

  it('offers every canonical area and impact option in every form', () => {
    for (const path of FORMS) {
      const form = read(path);
      for (const label of [...AREAS, ...IMPACTS]) expect(form, `${path}: ${label}`).toContain(label);
    }
  });

  it('proves the structural guard rejects missing headings, duplicate ids, and short forms', () => {
    const bad = [
      'name: Bad',
      'body:',
      '  - type: textarea',
      '    id: duplicate',
      '  - type: textarea',
      '    id: duplicate',
    ].join('\n');
    expect(formProblems(bad)).toEqual([
      'missing label: Primary area',
      'missing label: Expected impact',
      'missing label: Acceptance criteria',
      'missing label: Verification and evidence',
      'missing label: Dependencies',
      'duplicate id',
      'too few fields',
    ]);
  });
});

describe('pull-request template', () => {
  it('captures the linked leaf, risk, evidence, squash title, and scope growth concisely', () => {
    const template = read('.github/pull_request_template.md');
    expect(template.length).toBeGreaterThan(500);
    expect(template).toContain('Closes #');
    expect(template).toContain('## Risk');
    expect(template).toContain('## Verification');
    expect(template).toContain('Unexpected scope growth was re-sized or split');
    expect(template).toContain('PR title is the complete intended squash-commit message');
  });
});
