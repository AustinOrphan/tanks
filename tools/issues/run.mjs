#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  auditOpenIssues,
  declaredSingularParent,
  issueLabelNames,
  planIssueEventLabelChanges,
  renderAuditReport,
} from './metadata.mjs';
import { planQueueReconciliation, renderQueuePlan } from './queue.mjs';

const API_VERSION = '2022-11-28';

/**
 * Shapes for this module (issue #417). Same posture as metadata.mjs's: every field is
 * optional, because each of these option bags is destructured with defaults and every
 * caller -- CLI, workflow and test -- supplies a different subset.
 *
 * @typedef {import('./metadata.mjs').GhIssue} GhIssue
 * @typedef {import('./metadata.mjs').LinkedPullRequest} LinkedPullRequest
 * @typedef {import('./queue.mjs').QueuePlan} QueuePlan
 * @typedef {(path: string, options?: RequestOptions) => Promise<any>} GitHubRequest
 * @typedef {{ method?: string, body?: unknown, allowStatuses?: number[] }} RequestOptions
 */

/** @param {unknown} remote @returns {string | null} */
export function parseRepositoryRemote(remote) {
  const normalized = String(remote ?? '').trim().replace(/\.git$/, '');
  const match = /(?:github\.com[/:])([^/]+)\/([^/]+)$/.exec(normalized);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/** @param {{
 *   explicit?: string,
 *   env?: Record<string, string | undefined>,
 *   git?: (...args: any[]) => any,
 * }} [options]
 * @returns {string}
 */
export function resolveRepository({ explicit, env = process.env, git = execFileSync } = {}) {
  const candidate = explicit || env.GITHUB_REPOSITORY;
  if (candidate) return candidate;

  try {
    const remote = git('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' });
    const parsed = parseRepositoryRemote(remote);
    if (parsed !== null) return parsed;
  } catch {
    // The actionable error below covers a missing Git checkout and an unsupported remote.
  }

  throw new Error('repository is unknown; pass --repo owner/name or run inside a GitHub checkout');
}

/** @param {string} repository @returns {string} */
const repositoryPath = (repository) => {
  const parts = String(repository).split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error(`invalid repository '${repository}'; expected owner/name`);
  }
  return parts.map(encodeURIComponent).join('/');
};

/**
 * @param {{ apiUrl?: string, token?: string, fetchImpl?: typeof globalThis.fetch }} [options]
 * @returns {GitHubRequest}
 */
export function createGitHubRequest({
  apiUrl = 'https://api.github.com',
  token,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable');
  const root = apiUrl.replace(/\/$/, '');

  return async (path, { method = 'GET', body, allowStatuses = [] } = {}) => {
    /** @type {Record<string, string>} */
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'tanks-issue-metadata-audit',
      'X-GitHub-Api-Version': API_VERSION,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (allowStatuses.includes(response.status)) return null;
    const text = await response.text();
    if (!response.ok) {
      const detail = text.trim().slice(0, 500);
      throw new Error(
        `GitHub API ${method} ${path} failed (${response.status})${detail ? `: ${detail}` : ''}`,
      );
    }
    if (response.status === 204 || text === '') return null;

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GitHub API ${method} ${path} returned invalid JSON`);
    }
  };
}

/** @param {string} repository @param {GitHubRequest} request */
export async function listOpenIssues(repository, request) {
  const repo = repositoryPath(repository);
  const issues = [];

  for (let page = 1; ; page += 1) {
    const batch = await request(
      `/repos/${repo}/issues?state=open&per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch)) throw new Error(`GitHub issues page ${page} was not an array`);

    issues.push(...batch.filter((issue) => issue?.pull_request === undefined));
    if (batch.length < 100) break;
  }

  return issues;
}

/** @template T, R @param {T[]} values @param {number} limit @param {(value: T) => Promise<R>} action @returns {Promise<R[]>} */
async function mapWithConcurrency(values, limit, action) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await action(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

/** @param {string} repo @param {number} issueNumber @param {string} relationship @param {GitHubRequest} request */
async function listRelationshipIssues(repo, issueNumber, relationship, request) {
  const related = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(
      `/repos/${repo}/issues/${issueNumber}/${relationship}?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch)) {
      throw new Error(`${relationship} page for #${issueNumber} was not an array`);
    }
    related.push(...batch);
    if (batch.length < 100) return related;
  }
}

/** @param {unknown} value @returns {number} */
const nonNegativeCount = (value) => Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;

/** @param {string} repository @param {GhIssue[]} issues @param {GitHubRequest} request */
export async function enrichOpenIssueRelationships(repository, issues, request) {
  const repo = repositoryPath(repository);
  return mapWithConcurrency(issues, 6, async (issue) => {
    const labels = issueLabelNames(issue);
    const declaredParent = declaredSingularParent(issue?.body);
    const dependencySummary = issue?.issue_dependencies_summary ?? {};
    const subIssueSummary = issue?.sub_issues_summary ?? {};
    const blockerCount = Math.max(
      nonNegativeCount(dependencySummary.blocked_by),
      nonNegativeCount(dependencySummary.total_blocked_by),
    );
    const inspectBlockers = blockerCount > 0
      || labels.includes('agent-ready')
      || labels.includes('priority:now');
    const inspectSubIssues = nonNegativeCount(subIssueSummary.total) > 0;

    const [parent, blockedBy, subIssues] = await Promise.all([
      declaredParent === null
        ? null
        : request(`/repos/${repo}/issues/${issue.number}/parent`, { allowStatuses: [404] }),
      inspectBlockers
        ? listRelationshipIssues(repo, /** @type {number} */ (issue.number), 'dependencies/blocked_by', request)
        : [],
      inspectSubIssues
        ? listRelationshipIssues(repo, /** @type {number} */ (issue.number), 'sub_issues', request)
        : [],
    ]);

    return {
      ...issue,
      nativeRelationships: {
        loaded: true,
        parentLoaded: declaredParent !== null,
        parent,
        blockersLoaded: inspectBlockers,
        blockedBy,
        subIssues,
      },
    };
  });
}

// The reconciliation only needs relationships for the issues that can hold or enter a Now
// slot: Now items and label-shaped candidates (Next with agent-ready). Everything else is
// passed through marked uninspected, which the audit already treats as "not checked" rather
// than "clean". This keeps a reconcile run to a handful of reads on a token budget the
// per-event audit already exhausts under bursts.
/** @param {string} repository @param {GhIssue[]} issues @param {GitHubRequest} request */
export async function enrichQueueRelevantIssues(repository, issues, request) {
  const relevant = issues.filter((issue) => {
    const labels = issueLabelNames(issue);
    return labels.includes('priority:now')
      || (labels.includes('priority:next') && labels.includes('agent-ready'));
  });
  const enriched = await enrichOpenIssueRelationships(repository, relevant, request);
  const byNumber = new Map(enriched.map((issue) => [issue.number, issue]));
  return issues.map((issue) => byNumber.get(issue.number) ?? {
    ...issue,
    nativeRelationships: {
      loaded: false,
      parentLoaded: false,
      parent: null,
      blockersLoaded: false,
      blockedBy: [],
      subIssues: [],
    },
  });
}

const OPEN_PULL_REQUESTS_QUERY = `
query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [OPEN], first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        isDraft
        closingIssuesReferences(first: 100) {
          totalCount
          nodes { number repository { nameWithOwner } }
        }
      }
    }
  }
}`;

// Open pull requests keyed by the issues their closing references name. This is GitHub's own
// linkage (the field behind the Development sidebar), so a `Closes #N` keyword and a manual
// link look the same and nothing is inferred from titles. A read that fails in any way is an
// error, never "no pull requests": treating it as none would promote in-flight work.
/** @param {string} repository @param {GitHubRequest} request @returns {Promise<Map<number, LinkedPullRequest[]>>} */
export async function loadOpenPullRequestLinks(repository, request) {
  repositoryPath(repository);
  const [owner, name] = repository.split('/');
  /** @type {Map<number, LinkedPullRequest[]>} */
  const links = new Map();

  for (let after = null; ;) {
    const response = await request('/graphql', {
      method: 'POST',
      body: { query: OPEN_PULL_REQUESTS_QUERY, variables: { owner, name, after } },
    });
    if (Array.isArray(response?.errors) && response.errors.length > 0) {
      const messages = response.errors.map((/** @type {{ message?: string }} */ error) => error?.message ?? 'unknown error');
      throw new Error(`GitHub GraphQL pull-request query failed: ${messages.join('; ')}`);
    }
    const page = response?.data?.repository?.pullRequests;
    if (!Array.isArray(page?.nodes)) {
      throw new Error('GitHub GraphQL pull-request query returned no pull requests payload');
    }

    for (const pull of page.nodes) {
      const references = pull?.closingIssuesReferences;
      const nodes = Array.isArray(references?.nodes) ? references.nodes : [];
      if (Number(references?.totalCount ?? 0) > nodes.length) {
        throw new Error(
          `pull request #${pull?.number} has more closing references than one page holds; refusing to guess`,
        );
      }
      for (const reference of nodes) {
        if (String(reference?.repository?.nameWithOwner ?? '').toLowerCase() !== repository.toLowerCase()) continue;
        if (!Number.isInteger(reference?.number)) continue;
        const entry = links.get(reference.number) ?? [];
        entry.push({ number: pull.number, isDraft: pull?.isDraft === true });
        links.set(reference.number, entry);
      }
    }

    if (page.pageInfo?.hasNextPage !== true) return links;
    after = page.pageInfo.endCursor;
  }
}

/** @template {GhIssue} T @param {T[]} issues @param {Map<number, LinkedPullRequest[]>} links */
export const attachLinkedPullRequests = (issues, links) =>
  issues.map((issue) => ({
    ...issue,
    linkedPullRequests: { loaded: true, open: links.get(/** @type {number} */ (issue.number)) ?? [] },
  }));

/** @param {GhIssue | null} live @param {string[]} plannedLabels @returns {string | null} */
const staleReason = (live, plannedLabels) => {
  if (live === null || live?.state !== 'open') return 'the issue is no longer open';
  if (live.pull_request !== undefined) return 'the number now belongs to a pull request';
  const current = [...issueLabelNames(live)].sort();
  const planned = [...plannedLabels].map((label) => label.toLowerCase()).sort();
  if (current.length !== planned.length || current.some((label, index) => label !== planned[index])) {
    return 'labels changed since the plan was computed';
  }
  return null;
};

// Applies a plan's label writes. Each issue is re-read first and skipped if it closed or its
// labels moved since the plan was computed, so a concurrent close (a merge, a human) cannot
// leave priority:now on a closed issue that no audit will ever see again. Additions go
// before removals: an interrupted write then leaves a duplicate horizon the next
// reconciliation repairs, never an issue with no horizon at all.
/**
 * @param {string} repository
 * @param {QueuePlan} plan
 * @param {GitHubRequest} request
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<{ applied: number[], skipped: { issueNumber: number, reason: string }[] }>}
 */
export async function applyQueuePlan(repository, plan, request, { dryRun = false } = {}) {
  const repo = repositoryPath(repository);
  /** @type {number[]} */
  const applied = [];
  /** @type {{ issueNumber: number, reason: string }[]} */
  const skipped = [];
  if (dryRun) return { applied, skipped };

  for (const change of plan.changes) {
    const live = await request(`/repos/${repo}/issues/${change.issueNumber}`, { allowStatuses: [404] });
    const reason = staleReason(live, change.labels);
    if (reason !== null) {
      skipped.push({ issueNumber: change.issueNumber, reason });
      continue;
    }
    if (change.add.length > 0) {
      await request(`/repos/${repo}/issues/${change.issueNumber}/labels`, {
        method: 'POST',
        body: { labels: change.add },
      });
    }
    for (const label of change.remove) {
      await request(`/repos/${repo}/issues/${change.issueNumber}/labels/${encodeURIComponent(label)}`, {
        method: 'DELETE',
        allowStatuses: [404],
      });
    }
    applied.push(change.issueNumber);
  }

  return { applied, skipped };
}

/** @param {string} repository @param {{ action?: string, issue?: GhIssue }} payload @param {GitHubRequest} request */
export async function applyIssueEvent(repository, payload, request) {
  const issue = payload?.issue;
  const number = issue?.number;
  if (!Number.isInteger(number)) throw new Error('issue event payload has no numeric issue.number');

  const changes = planIssueEventLabelChanges(payload?.action ?? '', issue ?? {});
  const repo = repositoryPath(repository);

  for (const label of changes.remove) {
    await request(`/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, {
      method: 'DELETE',
      allowStatuses: [404],
    });
  }

  if (changes.add.length > 0) {
    await request(`/repos/${repo}/issues/${number}/labels`, {
      method: 'POST',
      body: { labels: changes.add },
    });
  }

  return changes;
}

/** @param {string | undefined} path @param {string} report */
export function appendStepSummary(path, report) {
  if (!path) return;
  appendFileSync(path, report, 'utf8');
  const after = readFileSync(path, 'utf8');
  if (!after.endsWith(report)) throw new Error('GitHub step summary read-back did not match');
}

/** @param {string[]} argv */
function parseArguments(argv) {
  const args = [...argv];
  const mode = args.shift();
  let repository;
  let dryRun = false;

  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--repo') {
      repository = args.shift();
      if (!repository) throw new Error('--repo requires owner/name');
      continue;
    }
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    throw new Error(`unknown argument: ${flag}`);
  }

  return { mode, repository, dryRun };
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const args = parseArguments(argv);
  if (!['audit', 'event', 'reconcile'].includes(args.mode ?? '')) {
    throw new Error('usage: node tools/issues/run.mjs <audit|event|reconcile> [--repo owner/name] [--dry-run]');
  }

  const repository = resolveRepository({ explicit: args.repository, env });
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  const request = createGitHubRequest({
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    token,
    fetchImpl,
  });

  if (args.mode === 'event') {
    if (!env.GITHUB_EVENT_PATH) throw new Error('event mode requires GITHUB_EVENT_PATH');
    if (!token) throw new Error('event mode requires GH_TOKEN or GITHUB_TOKEN');
    const payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    const changes = await applyIssueEvent(repository, payload, request);
    log(
      `#${payload.issue.number}: add [${changes.add.join(', ')}], remove [${changes.remove.join(', ')}]`,
    );
    return 0;
  }

  if (args.mode === 'reconcile') {
    if (!token) throw new Error('reconcile mode requires GH_TOKEN or GITHUB_TOKEN');
    const listedIssues = await listOpenIssues(repository, request);
    const enriched = await enrichQueueRelevantIssues(repository, listedIssues, request);
    const issues = attachLinkedPullRequests(enriched, await loadOpenPullRequestLinks(repository, request));
    const audit = auditOpenIssues(issues);
    const plan = planQueueReconciliation(issues, { maxNow: audit.maxNow, metadataErrors: audit.errors });
    const outcome = await applyQueuePlan(repository, plan, request, { dryRun: args.dryRun });
    const report = renderQueuePlan(plan, { dryRun: args.dryRun, ...outcome });
    log(report.trimEnd());
    appendStepSummary(env.GITHUB_STEP_SUMMARY, report);
    return 0;
  }

  const listedIssues = await listOpenIssues(repository, request);
  const enriched = await enrichOpenIssueRelationships(repository, listedIssues, request);
  // Linkage is a GraphQL read and GraphQL needs a token, so the anonymous audit stays
  // label-and-relationship only and says so in its header.
  const issues = token
    ? attachLinkedPullRequests(enriched, await loadOpenPullRequestLinks(repository, request))
    : enriched;
  const result = auditOpenIssues(issues);
  const plan = planQueueReconciliation(issues, { maxNow: result.maxNow, metadataErrors: result.errors });
  result.warnings.push(...plan.warnings);
  const report = `${renderAuditReport(result)}\n${renderQueuePlan(plan, { dryRun: true })}`;
  log(report.trimEnd());
  appendStepSummary(env.GITHUB_STEP_SUMMARY, report);
  return result.errors.length === 0 ? 0 : 1;
}

const directInvocation =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (directInvocation) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
