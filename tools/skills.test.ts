// Project skills are always discoverable by name and description, while their full bodies
// load only when invoked. Keep that metadata precise and the bodies small enough that an
// on-demand workflow does not become another global context budget.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILLS_DIR = fileURLToPath(new URL('../.claude/skills/', import.meta.url));
const CLAUDE = fileURLToPath(new URL('../CLAUDE.md', import.meta.url));

const MAX_SKILL_LINES = 70;
const MAX_SKILL_BYTES = 6_000;
const MAX_DESCRIPTION_CHARS = 300;

type SkillSpec = {
  description: RegExp;
  commands: string[];
  references: string[];
};

const SKILLS: Record<string, SkillSpec> = {
  'mutation-check': {
    description: /mutation.*(?:test|survivor|coverage)/i,
    commands: ['npm run mutate -- --only <id>', 'npm run mutate', 'npm run verify:full'],
    references: ['commands-and-operations.md', 'testing-and-review.md'],
  },
  'verify-change': {
    description: /(?:risk|diff).*verification.*(?:merge|pull request)/i,
    commands: [
      'npm run verify:quick',
      'npm run verify:build',
      'npm run verify:visual',
      'npm run verify:full',
    ],
    references: ['commands-and-operations.md', 'testing-and-review.md'],
  },
  'visual-check': {
    description: /(?:gallery|WebGL).*browser.*(?:screenshot|visual)/i,
    commands: [
      'npm run gallery',
      'npm run test:gl',
      'npm run trace:browser',
      'npm run verify:visual',
      'npm run verify:full',
    ],
    references: ['commands-and-operations.md', 'testing-and-review.md'],
  },
};

type ParsedSkill = {
  fields: Map<string, string>;
  body: string;
  problems: string[];
};

function parseSkill(text: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) return { fields: new Map(), body: '', problems: ['missing YAML frontmatter'] };

  const fields = new Map<string, string>();
  const problems: string[] = [];
  for (const [index, line] of match[1].split(/\r?\n/).entries()) {
    const field = /^([a-z][a-z-]*):\s*(\S(?:.*\S)?)\s*$/.exec(line);
    if (!field) {
      problems.push(`frontmatter line ${index + 1} is not a simple scalar`);
      continue;
    }
    if (fields.has(field[1])) problems.push(`duplicate frontmatter field ${field[1]}`);
    fields.set(field[1], field[2]);
  }
  return { fields, body: match[2], problems };
}

function validateSkill(name: string, text: string): string[] {
  const spec = SKILLS[name];
  const parsed = parseSkill(text);
  const problems = [...parsed.problems];
  const allowedFields = new Set(['name', 'description', 'context', 'background']);

  for (const field of parsed.fields.keys()) {
    if (!allowedFields.has(field)) problems.push(`unexpected frontmatter field ${field}`);
  }
  if (parsed.fields.get('name') !== name) problems.push('name must match its directory');

  const description = parsed.fields.get('description') ?? '';
  if (!description) problems.push('description is required');
  if (description.length > MAX_DESCRIPTION_CHARS) problems.push('description exceeds its budget');
  if (spec && !spec.description.test(description)) problems.push('description is not specific enough for discovery');
  if (parsed.fields.get('context') !== 'fork') problems.push('workflow must run in an isolated fork');
  if (parsed.fields.get('background') !== 'false') problems.push('fork must return synchronously');

  const lines = text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);
  if (lines > MAX_SKILL_LINES) problems.push('skill exceeds its line budget');
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES) problems.push('skill exceeds its byte budget');

  for (const heading of ['## Workflow', '## Stop conditions', '## Evidence']) {
    if (!parsed.body.includes(heading)) problems.push(`missing ${heading}`);
  }
  for (const command of spec?.commands ?? []) {
    if (!parsed.body.includes(command)) problems.push(`missing canonical command ${command}`);
  }
  for (const reference of spec?.references ?? []) {
    if (!parsed.body.includes(reference)) problems.push(`missing reference ${reference}`);
  }

  if (/^\s*!`/m.test(parsed.body) || /^\s*```!/m.test(parsed.body)) {
    problems.push('skill must not inject shell output into its prompt');
  }
  if (/^\s*(?:node|npx|vite|vitest)\s+[^`\n]*tools\//m.test(parsed.body)) {
    problems.push('skill must call repository scripts instead of tool implementations');
  }

  return problems;
}

function validateDirectoryNames(names: string[]): string[] {
  const expected = Object.keys(SKILLS).sort();
  return names.slice().sort().join('\n') === expected.join('\n')
    ? []
    : [`expected exactly ${expected.join(', ')}`];
}

function globalInstructionLeaks(text: string): string[] {
  return Object.keys(SKILLS).filter((name) => text.includes(name));
}

describe('the Claude Code project skills', () => {
  it('exposes exactly the three bounded workflows from issue #214', () => {
    const names = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(validateDirectoryNames(names)).toEqual([]);
    expect(validateDirectoryNames([...names, 'catch-all-workflow'])).not.toEqual([]);
    expect(validateDirectoryNames(names.filter((name) => name !== 'visual-check'))).not.toEqual([]);
  });

  it('keeps every skill discoverable, concise, isolated, and routed through repository commands', () => {
    for (const name of Object.keys(SKILLS)) {
      const text = readFileSync(`${SKILLS_DIR}/${name}/SKILL.md`, 'utf8');
      expect(validateSkill(name, text), name).toEqual([]);
    }
  });

  it('makes malformed metadata, permission grants, missing procedures, and command drift fail the guard', () => {
    const name = 'verify-change';
    const text = readFileSync(`${SKILLS_DIR}/${name}/SKILL.md`, 'utf8');
    const knownBad = [
      text.replace('name: verify-change', 'name: generic-helper'),
      text.replace('description:', 'description: vague\ndescription:'),
      text.replace('background: false', 'background: false\nallowed-tools: Bash'),
      text.replace('## Stop conditions', '## Keep going'),
      text.replace('npm run verify:full', 'npm run verify:everything'),
      `${text}${'padding\n'.repeat(MAX_SKILL_LINES)}`,
    ];

    for (const sample of knownBad) expect(validateSkill(name, sample)).not.toEqual([]);
  });

  it('keeps full skill procedures out of globally loaded project instructions', () => {
    const root = readFileSync(CLAUDE, 'utf8');
    expect(globalInstructionLeaks(root)).toEqual([]);
    expect(globalInstructionLeaks(`${root}\nRun verify-change before every response.`)).toEqual([
      'verify-change',
    ]);
  });
});
