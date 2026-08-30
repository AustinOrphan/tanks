#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendStepSummary, createGitHubRequest, resolveRepository } from './run.mjs';
import { RELATIONSHIP_MIGRATION } from './relationship-migration-plan.mjs';

const positiveInteger = (value) => Number.isInteger(value) && value > 0;

const unique = (values) => [...new Set(values)];

export function expandRelationshipPlan(plan) {
  if (typeof plan?.repository !== 'string' || !plan.repository.includes('/')) {
    throw new Error('relationship migration plan has no valid repository');
  }

  const parentEdges = [];
  const childOwners = new Map();
  for (const group of plan.parents ?? []) {
    if (!positiveInteger(group?.parent) || !Array.isArray(group?.children)) {
      throw new Error('relationship migration plan contains an invalid parent group');
    }
    for (const child of group.children) {
      if (!positiveInteger(child) || child === group.parent) {
        throw new Error(`invalid parent edge #${group.parent} -> #${child}`);
      }
      const prior = childOwners.get(child);
      if (prior !== undefined) {
        throw new Error(`child #${child} is assigned to both #${prior} and #${group.parent}`);
      }
      childOwners.set(child, group.parent);
      parentEdges.push({ parent: group.parent, child });
    }
  }

  const dependencyEdges = [];
  const dependencyKeys = new Set();
  for (const group of plan.blockedBy ?? []) {
    if (!positiveInteger(group?.issue) || !Array.isArray(group?.blockers)) {
      throw new Error('relationship migration plan contains an invalid blocked-by group');
    }
    for (const blocker of group.blockers) {
      if (!positiveInteger(blocker) || blocker === group.issue) {
        throw new Error(`invalid blocked-by edge #${group.issue} <- #${blocker}`);
      }
      const key = `${group.issue}:${blocker}`;
      if (dependencyKeys.has(key)) throw new Error(`duplicate blocked-by edge ${key}`);
      dependencyKeys.add(key);
      dependencyEdges.push({ issue: group.issue, blocker });
    }
  }

  assertAcyclic(parentEdges.map(({ parent, child }) => [parent, child]), 'parent');
  assertAcyclic(dependencyEdges.map(({ issue, blocker }) => [blocker, issue]), 'dependency');

  return { parentEdges, dependencyEdges };
}

function assertAcyclic(edges, kind) {
  const outgoing = new Map();
  for (const [from, to] of edges) {
    if (!outgoing.has(from)) outgoing.set(from, []);
    outgoing.get(from).push(to);
  }
  const visiting = new Set();
  const visited = new Set();

  const visit = (number) => {
    if (visiting.has(number)) {
      throw new Error(`${kind} relationship plan contains a cycle at #${number}`);
    }
    if (visited.has(number)) return;
    visiting.add(number);
    for (const next of outgoing.get(number) ?? []) visit(next);
    visiting.delete(number);
    visited.add(number);
  };

  for (const number of outgoing.keys()) visit(number);
}

const repositoryPath = (repository) => repository.split('/').map(encodeURIComponent).join('/');

async function mapWithConcurrency(values, limit, action) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await action(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

async function listBlockedBy(repo, issue, request) {
  const blockers = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(
      `/repos/${repo}/issues/${issue}/dependencies/blocked_by?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch)) throw new Error(`blocked-by page for #${issue} was not an array`);
    blockers.push(...batch);
    if (batch.length < 100) return blockers;
  }
}

export async function migrateRelationships({
  repository,
  request,
  apply = false,
  plan = RELATIONSHIP_MIGRATION,
  // GitHub permits at most 80 content-generating REST requests per minute.
  pause = () => new Promise((done) => setTimeout(done, 1_000)),
} = {}) {
  if (repository !== plan.repository) {
    throw new Error(`migration is pinned to ${plan.repository}, not ${repository}`);
  }
  const { parentEdges, dependencyEdges } = expandRelationshipPlan(plan);
  const repo = repositoryPath(repository);
  const issueNumbers = unique([
    ...parentEdges.flatMap(({ parent, child }) => [parent, child]),
    ...dependencyEdges.flatMap(({ issue, blocker }) => [issue, blocker]),
  ]).sort((a, b) => a - b);

  const loaded = await mapWithConcurrency(issueNumbers, 8, async (number) => {
    const issue = await request(`/repos/${repo}/issues/${number}`);
    if (!positiveInteger(issue?.id) || issue.number !== number) {
      throw new Error(`GitHub returned an invalid issue record for #${number}`);
    }
    return issue;
  });
  const issues = new Map(loaded.map((issue) => [issue.number, issue]));

  const currentParents = new Map(await mapWithConcurrency(
    parentEdges,
    8,
    async ({ child }) => [
      child,
      await request(`/repos/${repo}/issues/${child}/parent`, { allowStatuses: [404] }),
    ],
  ));

  const conflicts = [];
  const missingParents = [];
  for (const edge of parentEdges) {
    const current = currentParents.get(edge.child);
    if (current === null) missingParents.push(edge);
    else if (current.number !== edge.parent) {
      conflicts.push(`parent conflict: #${edge.child} already belongs to #${current.number}`);
    }
  }
  if (conflicts.length > 0) throw new Error(conflicts.join('\n'));

  const blockedIssueNumbers = unique(dependencyEdges.map(({ issue }) => issue));
  const currentBlockedBy = new Map(await mapWithConcurrency(
    blockedIssueNumbers,
    8,
    async (issue) => [issue, await listBlockedBy(repo, issue, request)],
  ));
  const missingDependencies = dependencyEdges.filter(({ issue, blocker }) =>
    !(currentBlockedBy.get(issue) ?? []).some((entry) => entry.number === blocker));

  if (apply) {
    for (const { parent, child } of missingParents) {
      await request(`/repos/${repo}/issues/${parent}/sub_issues`, {
        method: 'POST',
        body: { sub_issue_id: issues.get(child).id },
      });
      await pause();
    }
    for (const { issue, blocker } of missingDependencies) {
      await request(`/repos/${repo}/issues/${issue}/dependencies/blocked_by`, {
        method: 'POST',
        body: { issue_id: issues.get(blocker).id },
      });
      await pause();
    }

    const verifiedParents = await mapWithConcurrency(parentEdges, 8, async ({ parent, child }) => {
      const current = await request(`/repos/${repo}/issues/${child}/parent`, {
        allowStatuses: [404],
      });
      return current?.number === parent ? null : `#${child} does not verify under #${parent}`;
    });
    const verifiedDependencies = new Map(await mapWithConcurrency(
      blockedIssueNumbers,
      8,
      async (issue) => [issue, await listBlockedBy(repo, issue, request)],
    ));
    const verificationFailures = [
      ...verifiedParents.filter(Boolean),
      ...dependencyEdges.flatMap(({ issue, blocker }) =>
        (verifiedDependencies.get(issue) ?? []).some((entry) => entry.number === blocker)
          ? []
          : [`#${issue} does not verify as blocked by #${blocker}`]),
    ];
    if (verificationFailures.length > 0) {
      throw new Error(`relationship verification failed:\n${verificationFailures.join('\n')}`);
    }
  }

  return {
    apply,
    parentEdges: parentEdges.length,
    dependencyEdges: dependencyEdges.length,
    existingParents: parentEdges.length - missingParents.length,
    existingDependencies: dependencyEdges.length - missingDependencies.length,
    missingParents,
    missingDependencies,
  };
}

export function renderMigrationReport(result) {
  const mode = result.apply ? 'apply' : 'plan';
  const lines = [
    `## Native issue relationship migration (${mode})`,
    '',
    `- Parent edges: ${result.parentEdges} (${result.existingParents} already present, ${result.missingParents.length} ${result.apply ? 'added' : 'to add'})`,
    `- Blocked-by edges: ${result.dependencyEdges} (${result.existingDependencies} already present, ${result.missingDependencies.length} ${result.apply ? 'added' : 'to add'})`,
  ];
  if (result.missingParents.length > 0) {
    lines.push(
      '',
      `### Parent edges ${result.apply ? 'added' : 'to add'}`,
      '',
      ...result.missingParents.map(({ parent, child }) => `- #${parent} → #${child}`),
    );
  }
  if (result.missingDependencies.length > 0) {
    lines.push(
      '',
      `### Blocked-by edges ${result.apply ? 'added' : 'to add'}`,
      '',
      ...result.missingDependencies.map(
        ({ issue, blocker }) => `- #${issue} blocked by #${blocker}`,
      ),
    );
  }
  if (!result.apply && (result.missingParents.length > 0 || result.missingDependencies.length > 0)) {
    lines.push(
      '',
      'No relationships were changed. Re-run in apply mode after reviewing this plan.',
    );
  }
  return `${lines.join('\n')}\n`;
}

function parseArguments(argv) {
  const args = [...argv];
  const mode = args.shift() ?? 'plan';
  let repository;
  let confirmation;
  while (args.length > 0) {
    const flag = args.shift();
    if (!['--repo', '--confirm'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = args.shift();
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === '--repo') repository = value;
    else confirmation = value;
  }
  if (!['plan', 'apply'].includes(mode)) {
    throw new Error(
      'usage: node tools/issues/migrate-relationships.mjs <plan|apply> [--repo owner/name] [--confirm owner/name]',
    );
  }
  return { mode, repository, confirmation };
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const args = parseArguments(argv);
  const repository = resolveRepository({ explicit: args.repository, env });
  const apply = args.mode === 'apply';
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (apply && !token) throw new Error('apply mode requires GH_TOKEN or GITHUB_TOKEN');
  if (apply && args.confirmation !== RELATIONSHIP_MIGRATION.repository) {
    throw new Error(`apply mode requires --confirm ${RELATIONSHIP_MIGRATION.repository}`);
  }
  const request = createGitHubRequest({
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    token,
    fetchImpl,
  });
  const result = await migrateRelationships({ repository, request, apply });
  const report = renderMigrationReport(result);
  log(report.trimEnd());
  appendStepSummary(env.GITHUB_STEP_SUMMARY, report);
  return 0;
}

const directInvocation =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (directInvocation) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
