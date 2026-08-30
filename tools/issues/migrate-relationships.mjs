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

export async function mapWithConcurrency(values, limit, action) {
  const results = new Array(values.length);
  let next = 0;
  let failed = false;
  let failure;
  const worker = async () => {
    while (!failed) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      try {
        results[index] = await action(values[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  if (failed) throw failure;
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

const edgeKey = (edge) => JSON.stringify(edge);

const remainingEdges = (missing, added) => {
  const completed = new Set(added.map(edgeKey));
  return missing.filter((edge) => !completed.has(edgeKey(edge)));
};

const errorMessage = (error) => error instanceof Error ? error.message : String(error);

const parentConflictMessage = (conflicts) => conflicts.map(
  ({ child, currentParent }) => `parent conflict: #${child} already belongs to #${currentParent}`,
).join('\n');

export class RelationshipMigrationError extends Error {
  constructor(message, result, options) {
    super(message, options);
    this.name = 'RelationshipMigrationError';
    this.result = result;
    result.status = 'failed';
    result.error = message;
  }
}

export function withRequestTimeout(fetchImpl, timeoutMs = 30_000) {
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable');
  if (!positiveInteger(timeoutMs)) throw new Error('request timeout must be a positive integer');
  return (input, init = {}) => fetchImpl(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
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
  const result = {
    apply,
    status: 'inspecting',
    stage: 'inspect parent edges',
    parentEdges: parentEdges.length,
    dependencyEdges: dependencyEdges.length,
    existingParents: 0,
    existingDependencies: 0,
    missingParents: [],
    missingDependencies: [],
    parentConflicts: [],
    addedParents: [],
    addedDependencies: [],
    inspectedParents: false,
    inspectedDependencies: false,
    requests: 0,
    verified: false,
  };

  const call = async (...args) => {
    result.requests += 1;
    return request(...args);
  };

  try {
    const currentParents = new Map(await mapWithConcurrency(
      parentEdges,
      8,
      async ({ child }) => [
        child,
        await call(`/repos/${repo}/issues/${child}/parent`, { allowStatuses: [404] }),
      ],
    ));

    for (const edge of parentEdges) {
      const current = currentParents.get(edge.child);
      if (current === null) result.missingParents.push(edge);
      else if (current?.number === edge.parent) result.existingParents += 1;
      else if (positiveInteger(current?.number)) {
        result.parentConflicts.push({ ...edge, currentParent: current.number });
      } else {
        throw new Error(`GitHub returned an invalid parent record for #${edge.child}`);
      }
    }
    result.inspectedParents = true;

    result.stage = 'inspect blocked-by edges';
    const blockedIssueNumbers = unique(dependencyEdges.map(({ issue }) => issue));
    const currentBlockedBy = new Map(await mapWithConcurrency(
      blockedIssueNumbers,
      8,
      async (issue) => [issue, await listBlockedBy(repo, issue, call)],
    ));
    result.missingDependencies = dependencyEdges.filter(({ issue, blocker }) =>
      !(currentBlockedBy.get(issue) ?? []).some((entry) => entry.number === blocker));
    result.existingDependencies = dependencyEdges.length - result.missingDependencies.length;
    result.inspectedDependencies = true;

    if (!apply) {
      result.status = 'planned';
      if (result.parentConflicts.length > 0) {
        result.stage = 'resolve parent conflicts';
        throw new RelationshipMigrationError(
          parentConflictMessage(result.parentConflicts),
          result,
        );
      }
      result.stage = 'complete';
      return result;
    }

    result.stage = 'load issue records';
    const loaded = await mapWithConcurrency(issueNumbers, 8, async (number) => {
      const issue = await call(`/repos/${repo}/issues/${number}`);
      if (
        !positiveInteger(issue?.id)
        || issue.number !== number
        || issue.pull_request !== undefined
      ) {
        throw new Error(`GitHub returned an invalid issue record for #${number}`);
      }
      return issue;
    });
    const issues = new Map(loaded.map((issue) => [issue.number, issue]));

    result.stage = 'add parent edges';
    for (const edge of result.missingParents) {
      await call(`/repos/${repo}/issues/${edge.parent}/sub_issues`, {
        method: 'POST',
        body: { sub_issue_id: issues.get(edge.child).id },
      });
      result.addedParents.push(edge);
      await pause();
    }

    result.stage = 'add blocked-by edges';
    for (const edge of result.missingDependencies) {
      await call(`/repos/${repo}/issues/${edge.issue}/dependencies/blocked_by`, {
        method: 'POST',
        body: { issue_id: issues.get(edge.blocker).id },
      });
      result.addedDependencies.push(edge);
      await pause();
    }

    result.stage = 'verify relationships';
    const conflictedChildren = new Set(result.parentConflicts.map(({ child }) => child));
    const verifiableParents = parentEdges.filter(({ child }) => !conflictedChildren.has(child));
    const verifiedParents = await mapWithConcurrency(
      verifiableParents,
      8,
      async ({ parent, child }) => {
        const current = await call(`/repos/${repo}/issues/${child}/parent`, {
          allowStatuses: [404],
        });
        return current?.number === parent ? null : `#${child} does not verify under #${parent}`;
      },
    );
    const verifiedDependencies = new Map(await mapWithConcurrency(
      blockedIssueNumbers,
      8,
      async (issue) => [issue, await listBlockedBy(repo, issue, call)],
    ));
    const verificationFailures = [
      ...verifiedParents.filter(Boolean),
      ...dependencyEdges.flatMap(({ issue, blocker }) =>
        (verifiedDependencies.get(issue) ?? []).some((entry) => entry.number === blocker)
          ? []
          : [`#${issue} does not verify as blocked by #${blocker}`]),
    ];
    result.verified = (
      result.parentConflicts.length === 0
      && verificationFailures.length === 0
    );

    if (result.parentConflicts.length > 0 || verificationFailures.length > 0) {
      const failures = [];
      if (result.parentConflicts.length > 0) {
        failures.push(parentConflictMessage(result.parentConflicts));
      }
      if (verificationFailures.length > 0) {
        failures.push(`relationship verification failed:\n${verificationFailures.join('\n')}`);
      }
      throw new RelationshipMigrationError(failures.join('\n'), result);
    }

    result.stage = 'complete';
    result.status = 'succeeded';
    return result;
  } catch (error) {
    if (error instanceof RelationshipMigrationError) throw error;
    throw new RelationshipMigrationError(errorMessage(error), result, { cause: error });
  }
}

export function renderMigrationReport(result) {
  const mode = result.apply ? 'apply' : 'plan';
  const remainingParents = remainingEdges(result.missingParents, result.addedParents);
  const remainingDependencies = remainingEdges(
    result.missingDependencies,
    result.addedDependencies,
  );
  const lines = [
    `## Native issue relationship migration (${mode})`,
    '',
    `- Status: ${result.status}${result.status === 'failed' ? ` during ${result.stage}` : ''}`,
    `- API requests attempted: ${result.requests}`,
    result.inspectedParents
      ? `- Parent edges: ${result.parentEdges} (${result.existingParents} already present, ${result.addedParents.length} added, ${remainingParents.length} remaining, ${result.parentConflicts.length} conflicts)`
      : `- Parent edges: ${result.parentEdges} (inspection incomplete)`,
    result.inspectedDependencies
      ? `- Blocked-by edges: ${result.dependencyEdges} (${result.existingDependencies} already present, ${result.addedDependencies.length} added, ${remainingDependencies.length} remaining)`
      : `- Blocked-by edges: ${result.dependencyEdges} (inspection incomplete)`,
  ];
  if (result.error) {
    lines.push('', '### Failure', '', `- ${result.error.replaceAll('\n', '; ')}`);
  }
  if (result.addedParents.length > 0) {
    lines.push(
      '',
      '### Parent edges added',
      '',
      ...result.addedParents.map(({ parent, child }) => `- #${parent} → #${child}`),
    );
  }
  if (result.addedDependencies.length > 0) {
    lines.push(
      '',
      '### Blocked-by edges added',
      '',
      ...result.addedDependencies.map(
        ({ issue, blocker }) => `- #${issue} blocked by #${blocker}`,
      ),
    );
  }
  if (remainingParents.length > 0) {
    lines.push(
      '',
      `### Parent edges ${result.apply ? 'remaining' : 'to add'}`,
      '',
      ...remainingParents.map(({ parent, child }) => `- #${parent} → #${child}`),
    );
  }
  if (remainingDependencies.length > 0) {
    lines.push(
      '',
      `### Blocked-by edges ${result.apply ? 'remaining' : 'to add'}`,
      '',
      ...remainingDependencies.map(
        ({ issue, blocker }) => `- #${issue} blocked by #${blocker}`,
      ),
    );
  }
  if (result.parentConflicts.length > 0) {
    lines.push(
      '',
      '### Parent conflicts',
      '',
      ...result.parentConflicts.map(
        ({ parent, child, currentParent }) =>
          `- #${child} belongs to #${currentParent}; reviewed parent is #${parent}`,
      ),
    );
  }
  if (!result.apply && (remainingParents.length > 0 || remainingDependencies.length > 0)) {
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
  plan = RELATIONSHIP_MIGRATION,
  pause,
  requestTimeoutMs = 30_000,
} = {}) {
  const args = parseArguments(argv);
  const repository = resolveRepository({ explicit: args.repository, env });
  const apply = args.mode === 'apply';
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) throw new Error('plan and apply modes require GH_TOKEN or GITHUB_TOKEN');
  if (apply && args.confirmation !== plan.repository) {
    throw new Error(`apply mode requires --confirm ${plan.repository}`);
  }
  const request = createGitHubRequest({
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    token,
    fetchImpl: withRequestTimeout(fetchImpl, requestTimeoutMs),
  });
  try {
    const result = await migrateRelationships({ repository, request, apply, plan, pause });
    const report = renderMigrationReport(result);
    log(report.trimEnd());
    appendStepSummary(env.GITHUB_STEP_SUMMARY, report);
    return 0;
  } catch (error) {
    if (error instanceof RelationshipMigrationError) {
      const report = renderMigrationReport(error.result);
      log(report.trimEnd());
      appendStepSummary(env.GITHUB_STEP_SUMMARY, report);
    }
    throw error;
  }
}

const directInvocation =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (directInvocation) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
