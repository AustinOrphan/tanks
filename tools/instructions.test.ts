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
const DOCUMENT_INDEX = fileURLToPath(new URL('../docs/README.md', import.meta.url));
const AGENT_REFERENCE = fileURLToPath(new URL('../docs/agent/README.md', import.meta.url));
const TESTING_AND_REVIEW = fileURLToPath(new URL('../docs/agent/testing-and-review.md', import.meta.url));
const COMMANDS_AND_OPERATIONS = fileURLToPath(new URL('../docs/agent/commands-and-operations.md', import.meta.url));
const TASK_SIZING = fileURLToPath(new URL('../docs/agent/task-sizing.md', import.meta.url));
const VERIFY_CHANGE = fileURLToPath(new URL('../.claude/skills/verify-change/SKILL.md', import.meta.url));

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

function verificationPolicyProblems(root: string, policy: string): string[] {
  const high = markdownSection(policy, 'High risk');
  const exceptions = markdownSection(policy, 'Full local mutation-manifest exceptions');
  const ci = markdownSection(policy, 'CI and merge verification');
  const checks: Array<[string, boolean]> = [
    ['targeted local mutation command', `${root}\n${policy}`.includes('npm run mutate -- --only <id>')],
    ['root rejects routine full local manifest', /Do not run the complete mutation manifest locally by default/.test(root)],
    ['high risk keeps quick verification', high.includes('npm run verify:quick')],
    ['high risk keeps conditional build verification', high.includes('npm run verify:build')],
    ['high risk selects applicable mutations', /all mutation entries applicable/.test(high)],
    ['high risk does not require the full composite', !high.includes('npm run verify:full')],
    ['exceptions retain the full composite', exceptions.includes('npm run verify:full')],
    ['harness exception', /mutation harness itself/.test(exceptions)],
    ['broad-manifest exception', /mutation manifest changes broadly/.test(exceptions)],
    ['CI-failure exception', /CI mutation failure/.test(exceptions)],
    ['cross-cutting exception', /cross-cutting behavior changes/.test(exceptions)],
    ['named-risk exception', /specifically identified repository-wide risk/.test(exceptions)],
    ['current CI context', ci.includes('verify (current)')],
    ['floor CI context', ci.includes('verify (floor)')],
    ['visual CI context', ci.includes('visual')],
    ['current CI runs the complete manifest on every change',
      /`verify \(current\)` runs the complete mutation manifest under Node 24 on pull requests\s+and pushes to `main`/.test(ci)],
    ['floor CI runs the representative smoke path',
      /`verify \(floor\)` runs[\s\S]*exact Node 22\.13\.0 plus `npm run mutate:smoke`/.test(ci)],
    ['floor CI does not claim complete per-change coverage',
      /it does not run every manifest entry on each change/.test(ci)],
    ['scheduled CI runs the complete floor manifest',
      /`Mutation floor` workflow runs the complete manifest under exact Node\s+22\.13\.0 daily against `main` and on manual dispatch/.test(ci)],
    ['optimized floor CI does not require local compensation',
      /does not make routine local full-manifest execution necessary/.test(ci)],
    ['pending CI blocks a fully-verified claim', /Do not report the change as fully\s+verified or merge-ready/.test(ci)],
  ];

  return checks.filter(([, valid]) => !valid).map(([name]) => name);
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
    expect(standard).toContain('npm run verify:quick');
    expect(standard).toContain('npm run verify:build');
    expect(standard).toMatch(/focused self-review/);

    expect(high).toMatch(/deterministic simulation/);
    expect(high).toMatch(/save\/persistence compatibility/);
    expect(high).toMatch(/renderer\/WebGL infrastructure/);
    expect(high).toMatch(/CI, build, dependency\/engine, release, deployment/);
    expect(high).toMatch(/cross-cutting change/);
    expect(high).toContain('npm run verify:quick');
    expect(high).toContain('npm run verify:build');
    expect(high).toMatch(/all mutation entries applicable/);
    expect(high).not.toContain('npm run verify:full');
    expect(high).toMatch(/adversarially review invariants/);
  });

  it('separates targeted local candidate evidence from authoritative CI verification', () => {
    const root = readFileSync(CLAUDE, 'utf8');
    const policy = readFileSync(TESTING_AND_REVIEW, 'utf8');

    expect(verificationPolicyProblems(root, policy)).toEqual([]);
  });

  it('makes the previous blanket policy and weakened CI/local boundaries fail the guard', () => {
    const root = readFileSync(CLAUDE, 'utf8');
    const policy = readFileSync(TESTING_AND_REVIEW, 'utf8');
    const oldHighRisk = policy.replace(
      '- run `npm run verify:quick` and add `npm run verify:build` when production output can\n  change',
      '- from a clean candidate worktree, run `npm run verify:full`',
    );
    const noTargetedRoot = root.replaceAll('npm run mutate -- --only <id>', 'npm run mutate');
    const noTargetedPolicy = policy.replaceAll('npm run mutate -- --only <id>', 'npm run mutate');
    const noExceptions = policy.replace(
      '### Full local mutation-manifest exceptions',
      '### Routine full local mutation runs',
    );
    const weakenedCi = policy.replace(
      'runs the complete mutation manifest under Node 24 on pull requests',
      'runs selected mutation entries under Node 24 on pull requests',
    );
    const noFloorSmoke = policy.replace(
      'plus `npm run mutate:smoke`, one representative',
      'without a representative mutation path; one',
    );
    const noScheduledFloor = policy.replace(
      '22.13.0 daily against `main` and on manual dispatch',
      '22.13.0 only when a developer remembers to run it',
    );
    const localCompensation = policy.replace(
      'does not make routine local full-manifest execution necessary',
      'requires routine local full-manifest execution as compensation',
    );
    const prematureCompletion = policy.replace(
      'Do not report the change as fully\nverified or merge-ready',
      'Report the change as fully verified and merge-ready',
    );

    for (const [name, candidateRoot, candidatePolicy] of [
      ['blanket high-risk full gate', root, oldHighRisk],
      ['missing targeted mutations', noTargetedRoot, noTargetedPolicy],
      ['missing exception boundary', root, noExceptions],
      ['weakened current CI manifest', root, weakenedCi],
      ['missing floor smoke', root, noFloorSmoke],
      ['missing scheduled floor manifest', root, noScheduledFloor],
      ['local compensation required', root, localCompensation],
      ['premature completion claim', root, prematureCompletion],
    ] as const) {
      expect(verificationPolicyProblems(candidateRoot, candidatePolicy), name).not.toEqual([]);
    }
  });

  it('keeps escalation, conditional evidence, and bounded delegation explicit', () => {
    const policy = readFileSync(TESTING_AND_REVIEW, 'utf8');

    expect(policy).toMatch(/mixed change inherits the highest tier present/);
    expect(policy).toMatch(/Visual evidence.*mandatory for any user-visible/);
    expect(policy).toContain('npm run verify:visual');
    expect(policy).toMatch(/verify:build` when changing Vite base\/output behavior/);
    expect(policy).toMatch(/Delegate when the question is concrete, bounded, independent/);
    expect(policy).toMatch(/worker that mutates files must use its own worktree/);
    expect(policy).toMatch(/lead agent verifies returned claims/);
  });

  it('pipelines CI-pending work without weakening the merge bar', () => {
    const root = readFileSync(CLAUDE, 'utf8');
    const review = readFileSync(TESTING_AND_REVIEW, 'utf8');
    const operations = readFileSync(COMMANDS_AND_OPERATIONS, 'utf8');
    const sizing = readFileSync(TASK_SIZING, 'utf8');
    const verifySkill = readFileSync(VERIFY_CHANGE, 'utf8');
    const requirements: Array<[string, string, RegExp]> = [
      ['pending blocks merge, not unrelated work', root,
        /pending checks block merge and fully-verified claims, not independent\s+implementation work/],
      ['one implementation slot excludes pending PRs', root,
        /at most one task actively undergoing implementation[\s\S]*`CI pending` PRs do not\s+consume that slot/],
      ['independent work uses main or an explicit stack', root,
        /independent next task from current `main`[\s\S]*deliberately stack it and\s+record the dependency/],
      ['pending states stay bounded and tracked', review,
        /Candidate complete \/ CI pending[\s\S]*concurrency remains bounded[\s\S]*concise session ledger/],
      ['CI is checked at natural boundaries without polling', review,
        /Revisit outstanding checks at natural boundaries[\s\S]*tightly poll GitHub Actions while useful work is available/],
      ['attributable failures preempt lower-priority work', review,
        /normally suspend lower-priority work to fix an attributable failure/],
      ['task selection checks pending dependencies and overlap', sizing,
        /compare its dependencies and likely file surface[\s\S]*branches from current `main`[\s\S]*stack it on the\s+predecessor and record that dependency/],
      ['CI-pending branches stay isolated', review,
        /Never add an\s+independent issue to a CI-pending PR's branch\/worktree or combine independent issues on one\s+branch/],
      ['pending differs from failure and merge readiness', verifySkill,
        /Pending CI is not a failure[\s\S]*Never call a candidate fully verified while required CI is pending[\s\S]*never describe it as merge-ready/],
      ['CI is a merge gate rather than an implementation wait', operations,
        /Required CI is authoritative for merge, not a synchronous implementation barrier[\s\S]*Do not rerun a full CI-equivalent local gate merely because CI\s+is pending/],
      ['all required checks and threads still block merge', root,
        /Required checks are\s+`verify \(floor\)`, `verify \(current\)`, and `visual`; unresolved review threads also block\s+merge/],
    ];

    for (const [name, text, pattern] of requirements) {
      expect(text, name).toMatch(pattern);
      expect(text.replace(pattern, '[required policy removed]'), name).not.toMatch(pattern);
    }
  });

  it('makes missing or duplicate risk tiers fail the heading guard', () => {
    const policy = readFileSync(TESTING_AND_REVIEW, 'utf8');
    const missingHigh = policy.replace('### High risk', '#### High risk');
    const duplicateLow = `${policy}\n### Low risk\nKnown-bad duplicate.`;

    expect(riskTierHeadings(missingHigh)).not.toEqual(REQUIRED_RISK_TIERS);
    expect(riskTierHeadings(duplicateLow)).not.toEqual(REQUIRED_RISK_TIERS);
  });

  it('routes to the generated document index by link, never by import', () => {
    const root = readFileSync(CLAUDE, 'utf8');

    // Issue #266: the corpus is reachable from startup context without any of it being
    // loaded there. Deleting the routing sentence from CLAUDE.md fails this.
    expect(root).toContain('docs/README.md');
    expect(existsSync(DOCUMENT_INDEX)).toBe(true);
    expect(root).not.toMatch(/(^|[^`\w])@docs\/README\.md/);
    expect(readFileSync(AGENT_REFERENCE, 'utf8')).toContain('../README.md');

    // A hand-written index would satisfy the routing assertions above and still drift.
    const index = readFileSync(DOCUMENT_INDEX, 'utf8');
    expect(index).toContain('GENERATED');
    expect(index).toContain('npm run docs:index');
  });

  it('names the backlog as the home for deferred investigations, and it exists', () => {
    expect(readFileSync(CLAUDE, 'utf8')).toContain('docs/superpowers/backlog.md');
    expect(existsSync(BACKLOG)).toBe(true);
  });
});
