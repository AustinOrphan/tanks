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

const API_VERSION = '2022-11-28';

export function parseRepositoryRemote(remote) {
  const normalized = String(remote ?? '').trim().replace(/\.git$/, '');
  const match = /(?:github\.com[/:])([^/]+)\/([^/]+)$/.exec(normalized);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

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

const repositoryPath = (repository) => {
  const parts = String(repository).split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error(`invalid repository '${repository}'; expected owner/name`);
  }
  return parts.map(encodeURIComponent).join('/');
};

export function createGitHubRequest({
  apiUrl = 'https://api.github.com',
  token,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable');
  const root = apiUrl.replace(/\/$/, '');

  return async (path, { method = 'GET', body, allowStatuses = [] } = {}) => {
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

const nonNegativeCount = (value) => Number.isInteger(value) && value >= 0 ? value : 0;

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
        ? listRelationshipIssues(repo, issue.number, 'dependencies/blocked_by', request)
        : [],
      inspectSubIssues
        ? listRelationshipIssues(repo, issue.number, 'sub_issues', request)
        : [],
    ]);

    return {
      ...issue,
      nativeRelationships: {
        loaded: true,
        parentLoaded: declaredParent !== null,
        parent,
        blockedBy,
        subIssues,
      },
    };
  });
}

export async function applyIssueEvent(repository, payload, request) {
  const issue = payload?.issue;
  const number = issue?.number;
  if (!Number.isInteger(number)) throw new Error('issue event payload has no numeric issue.number');

  const changes = planIssueEventLabelChanges(payload?.action, issue);
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

export function appendStepSummary(path, report) {
  if (!path) return;
  appendFileSync(path, report, 'utf8');
  const after = readFileSync(path, 'utf8');
  if (!after.endsWith(report)) throw new Error('GitHub step summary read-back did not match');
}

function parseArguments(argv) {
  const args = [...argv];
  const mode = args.shift();
  let repository;

  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--repo') {
      repository = args.shift();
      if (!repository) throw new Error('--repo requires owner/name');
      continue;
    }
    throw new Error(`unknown argument: ${flag}`);
  }

  return { mode, repository };
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const args = parseArguments(argv);
  if (!['audit', 'event'].includes(args.mode)) {
    throw new Error('usage: node tools/issues/run.mjs <audit|event> [--repo owner/name]');
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

  const listedIssues = await listOpenIssues(repository, request);
  const issues = await enrichOpenIssueRelationships(repository, listedIssues, request);
  const result = auditOpenIssues(issues);
  const report = renderAuditReport(result);
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
