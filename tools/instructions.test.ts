// Claude Code loads the root project instructions into every session. Keep that global
// surface small, route conditional guidance through path-scoped rules, and retain long
// rationale as on-demand documentation. AGENTS.md is a symlink because other harnesses
// discover that filename instead.
import { describe, it, expect } from 'vitest';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLAUDE = fileURLToPath(new URL('../CLAUDE.md', import.meta.url));
const AGENTS = fileURLToPath(new URL('../AGENTS.md', import.meta.url));
const BACKLOG = fileURLToPath(new URL('../docs/superpowers/backlog.md', import.meta.url));
const RULES_DIR = fileURLToPath(new URL('../.claude/rules/', import.meta.url));
const CONTEXT_BUDGET = fileURLToPath(new URL('../docs/agent/context-budget.md', import.meta.url));
const TESTING_AND_REVIEW = fileURLToPath(new URL('../docs/agent/testing-and-review.md', import.meta.url));

const MAX_ROOT_LINES = 200;
const MAX_ROOT_BYTES = 12_000;

const REQUIRED_RULES = [
  'audio.md',
  'documentation.md',
  'game.md',
  'rendering.md',
  'simulation.md',
  'testing.md',
  'workflows.md',
];

const REQUIRED_REFERENCES = [
  'docs/agent/README.md',
  'docs/agent/architecture.md',
  'docs/agent/commands-and-operations.md',
  'docs/agent/context-budget.md',
  'docs/agent/development.md',
  'docs/agent/known-holes.md',
  'docs/agent/task-sizing.md',
  'docs/agent/testing-and-review.md',
];

const REQUIRED_RISK_TIERS = ['Low risk', 'Standard risk', 'High risk'];

function rootPath(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

/**
 * Claude Code treats an unquoted `@path` anywhere in instruction prose as an import, but
 * ignores fenced code and inline code spans. Reserve prose `@` for imports so this guard
 * cannot miss a future inline form such as "See @README". Literal values that contain `@`
 * belong in a code span.
 */
function containsClaudeImport(text: string): boolean {
  const prose: string[] = [];
  let fence: { marker: string; length: number } | undefined;

  for (const line of text.split(/\r?\n/)) {
    const openingOrClosing = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];

    if (fence) {
      if (
        openingOrClosing?.[0] === fence.marker
        && openingOrClosing.length >= fence.length
      ) {
        fence = undefined;
      }
      prose.push('');
      continue;
    }

    if (openingOrClosing) {
      fence = { marker: openingOrClosing[0], length: openingOrClosing.length };
      prose.push('');
      continue;
    }

    prose.push(line.replace(/(`+)(.*?)\1/g, ''));
  }

  return prose.join('\n').includes('@');
}

function riskTierHeadings(text: string): string[] {
  return [...text.matchAll(/^### (Low risk|Standard risk|High risk)$/gm)]
    .map((match) => match[1]);
}

function markdownSection(text: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^### ${escaped}\\r?\\n([\\s\\S]*?)(?=^### |^## |$(?![\\s\\S]))`, 'm')
    .exec(text)?.[1] ?? '';
}

describe('the instruction files', () => {
  it('load as substantive text within the global context budget', () => {
    const text = readFileSync(CLAUDE, 'utf8');
    const lines = text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);

    expect(text.length).toBeGreaterThan(500);
    expect(lines).toBeLessThanOrEqual(MAX_ROOT_LINES);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_ROOT_BYTES);
    expect(readFileSync(AGENTS, 'utf8')).toBe(text);
  });

  it('does not pull on-demand references back into startup context', () => {
    const text = readFileSync(CLAUDE, 'utf8');
    expect(containsClaudeImport(text)).toBe(false);
  });

  it('detects imports anywhere in prose without mistaking code literals for imports', () => {
    for (const sample of ['@README', 'See @README', '- workflow @docs/review.md']) {
      expect(containsClaudeImport(sample), sample).toBe(true);
    }

    expect(containsClaudeImport('See `@README` for the literal path')).toBe(false);
    expect(containsClaudeImport('```md\nSee @README\n```')).toBe(false);
  });

  it('keeps the recorded after-measurement synchronized with the root file', () => {
    const text = readFileSync(CLAUDE, 'utf8');
    const lines = text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);
    const measurement = readFileSync(CONTEXT_BUDGET, 'utf8');

    expect(measurement).toContain(
      `| After | root \`CLAUDE.md\` on this branch | ${lines} | ${Buffer.byteLength(text, 'utf8')} |`,
    );
  });

  it('keeps AGENTS.md as the tracked symlink to CLAUDE.md', () => {
    expect(lstatSync(AGENTS).isSymbolicLink()).toBe(true);
    expect(readlinkSync(AGENTS).replace(/^\.\//, '')).toBe('CLAUDE.md');

    const entry = execFileSync('git', ['ls-files', '-s', 'AGENTS.md'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(entry.split(/\s+/)[0]).toBe('120000');
  });

  it('keeps every Claude rule path-scoped', () => {
    const files = readdirSync(RULES_DIR).filter((name) => name.endsWith('.md')).sort();
    expect(files).toEqual(REQUIRED_RULES);

    for (const name of files) {
      const text = readFileSync(fileURLToPath(new URL(name, new URL('../.claude/rules/', import.meta.url))), 'utf8');
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      expect(frontmatter, `${name} must have YAML frontmatter`).not.toBeNull();
      expect(frontmatter?.[1], `${name} must declare paths`).toMatch(/^paths:\s*$/m);
      expect(frontmatter?.[1], `${name} must declare at least one path`).toMatch(/^\s+-\s+.+$/m);
      expect(containsClaudeImport(text), `${name} must link rather than import references`).toBe(false);
    }
  });

  it('keeps every routed reference present', () => {
    const root = readFileSync(CLAUDE, 'utf8');
    expect(root).toContain('.claude/rules/');
    expect(root).toContain('docs/agent/README.md');
    for (const name of REQUIRED_RULES) {
      expect(root).toContain(`.claude/rules/${name}`);
    }

    for (const relative of REQUIRED_REFERENCES) {
      expect(existsSync(rootPath(relative)), relative).toBe(true);
    }
  });

  it('routes low, standard, and high risk verification without universal fanout', () => {
    const root = readFileSync(CLAUDE, 'utf8');
    const policy = readFileSync(TESTING_AND_REVIEW, 'utf8');

    expect(root).toContain('low, standard, or high risk');
    expect(root).toMatch(/Mixed\s+changes use the highest tier present/);
    expect(root).toContain('docs/agent/testing-and-review.md#merge-bar');
    expect(riskTierHeadings(policy)).toEqual(REQUIRED_RISK_TIERS);
    expect(`${root}\n${policy}`).not.toMatch(
      /Nothing reaches `main` without comprehensive adversarial review|reviewers fan out per subsystem/,
    );
  });

  it('keeps each risk tier mapped to its categories and minimum evidence', () => {
    const policy = readFileSync(TESTING_AND_REVIEW, 'utf8');
    const low = markdownSection(policy, 'Low risk');
    const standard = markdownSection(policy, 'Standard risk');
    const high = markdownSection(policy, 'High risk');

    expect(low).toMatch(/prose-only documentation/);
    expect(low).toMatch(/inspect the complete diff/);
    expect(low).toMatch(/directly relevant formatting, documentation, link, or generator-drift checks/);
    expect(low).toMatch(/concise self-review/);
    expect(low).toMatch(/Do not create reviewer or implementation\s+fanout/);

    expect(standard).toMatch(/game, input, audio, HUD, or UI behavior/);
    expect(standard).toMatch(/repository instructions and review policy/);
    expect(standard).toMatch(/typecheck and the directly relevant unit or integration tests/);
    expect(standard).toMatch(/build when production output can change/);
    expect(standard).toMatch(/focused self-review/);

    expect(high).toMatch(/deterministic simulation/);
    expect(high).toMatch(/save\/persistence compatibility/);
    expect(high).toMatch(/renderer\/WebGL infrastructure/);
    expect(high).toMatch(/CI, build, dependency\/engine, release, deployment/);
    expect(high).toMatch(/cross-cutting change/);
    expect(high).toMatch(/full applicable automated gate and production build/);
    expect(high).toMatch(/adversarially review invariants/);
  });

  it('keeps escalation, conditional evidence, and bounded delegation explicit', () => {
    const policy = readFileSync(TESTING_AND_REVIEW, 'utf8');

    expect(policy).toMatch(/mixed change inherits the highest tier present/);
    expect(policy).toMatch(/Visual evidence is mandatory for any user-visible/);
    expect(policy).toMatch(/run the portability check when changing Vite base\/output behavior/);
    expect(policy).toMatch(/Delegate when the question is concrete, bounded, independent/);
    expect(policy).toMatch(/worker that mutates files must use its own worktree/);
    expect(policy).toMatch(/lead agent verifies returned claims/);
  });

  it('makes missing or duplicate risk tiers fail the heading guard', () => {
    const policy = readFileSync(TESTING_AND_REVIEW, 'utf8');
    const missingHigh = policy.replace('### High risk', '#### High risk');
    const duplicateLow = `${policy}\n### Low risk\nKnown-bad duplicate.`;

    expect(riskTierHeadings(missingHigh)).not.toEqual(REQUIRED_RISK_TIERS);
    expect(riskTierHeadings(duplicateLow)).not.toEqual(REQUIRED_RISK_TIERS);
  });

  it('names the backlog as the home for deferred investigations, and it exists', () => {
    expect(readFileSync(CLAUDE, 'utf8')).toContain('docs/superpowers/backlog.md');
    expect(existsSync(BACKLOG)).toBe(true);
  });
});
