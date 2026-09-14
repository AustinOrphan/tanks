import { describe, expect, it } from 'vitest';
import {
  applyIssueEvent,
  applyQueuePlan,
  attachLinkedPullRequests,
  createGitHubRequest,
  enrichOpenIssueRelationships,
  enrichQueueRelevantIssues,
  listOpenIssues,
  loadOpenPullRequestLinks,
  main,
  parseRepositoryRemote,
  resolveRepository,
} from './run.mjs';

describe('repository resolution', () => {
  it('supports HTTPS and SSH GitHub remotes without guessing non-GitHub URLs', () => {
    expect(parseRepositoryRemote('https://github.com/AustinOrphan/tanks.git')).toBe(
      'AustinOrphan/tanks',
    );
    expect(parseRepositoryRemote('git@github.com:AustinOrphan/tanks.git')).toBe(
      'AustinOrphan/tanks',
    );
    expect(parseRepositoryRemote('https://example.com/AustinOrphan/tanks.git')).toBeNull();
  });

  it('prefers an explicit repository, then the workflow environment, then Git', () => {
    const git = () => 'git@github.com:wrong/fallback.git\n';
    expect(resolveRepository({ explicit: 'AustinOrphan/tanks', env: {}, git })).toBe(
      'AustinOrphan/tanks',
    );
    expect(resolveRepository({ env: { GITHUB_REPOSITORY: 'owner/from-env' }, git })).toBe(
      'owner/from-env',
    );
    expect(resolveRepository({ env: {}, git: () => 'git@github.com:owner/from-git.git\n' })).toBe(
      'owner/from-git',
    );
  });
});

describe('GitHub issue retrieval', () => {
  it('paginates through all open results and excludes pull requests', async () => {
    // Annotated because the 100th entry below carries `pull_request`, which the inferred
    // element type from these 99 does not have -- the fixture is deliberately mixed, since
    // excluding PRs is the thing under test.
    const first: Array<{ number: number; pull_request?: { url: string } }> =
      Array.from({ length: 99 }, (_, index) => ({ number: index + 1 }));
    first.push({ number: 100, pull_request: { url: 'https://example.test/pr/100' } });
    const paths: string[] = [];
    const request = async (path: string) => {
      paths.push(path);
      return paths.length === 1 ? first : [{ number: 101 }];
    };

    const issues = await listOpenIssues('AustinOrphan/tanks', request);
    expect(paths).toEqual([
      '/repos/AustinOrphan/tanks/issues?state=open&per_page=100&page=1',
      '/repos/AustinOrphan/tanks/issues?state=open&per_page=100&page=2',
    ]);
    expect(issues).toHaveLength(100);
    expect(issues.some((entry) => entry.number === 100)).toBe(false);
    expect(issues.at(-1)?.number).toBe(101);
  });

  it('rejects malformed API pages instead of treating them as an empty clean backlog', async () => {
    await expect(listOpenIssues('AustinOrphan/tanks', async () => ({ message: 'bad' })))
      .rejects.toThrow('was not an array');
  });
});

describe('native relationship retrieval', () => {
  it('loads only relationship details needed to enforce the live contract', async () => {
    const issues = [
      {
        number: 1,
        body: 'Parent: #10',
        labels: ['priority:next'],
        issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 0 },
        sub_issues_summary: { total: 0 },
      },
      {
        number: 2,
        body: '',
        labels: ['priority:now', 'agent-ready'],
        issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 0 },
        sub_issues_summary: { total: 0 },
      },
      {
        number: 3,
        body: '',
        labels: ['priority:next'],
        issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 1 },
        sub_issues_summary: { total: 1 },
      },
      {
        number: 4,
        body: '',
        labels: ['priority:next'],
        issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 0 },
        sub_issues_summary: { total: 0 },
      },
    ];
    const paths: string[] = [];
    const request = async (path: string) => {
      paths.push(path);
      if (path.endsWith('/issues/1/parent')) return { number: 10, state: 'open' };
      if (path.includes('/issues/2/dependencies/blocked_by?')) {
        return [{ number: 20, state: 'closed' }];
      }
      if (path.includes('/issues/3/dependencies/blocked_by?')) {
        return [{ number: 30, state: 'open' }];
      }
      if (path.includes('/issues/3/sub_issues?')) return [{ number: 31, state: 'open' }];
      throw new Error(`unexpected path ${path}`);
    };

    const enriched = await enrichOpenIssueRelationships('AustinOrphan/tanks', issues, request);
    expect(paths.sort()).toEqual([
      '/repos/AustinOrphan/tanks/issues/1/parent',
      '/repos/AustinOrphan/tanks/issues/2/dependencies/blocked_by?per_page=100&page=1',
      '/repos/AustinOrphan/tanks/issues/3/dependencies/blocked_by?per_page=100&page=1',
      '/repos/AustinOrphan/tanks/issues/3/sub_issues?per_page=100&page=1',
    ]);
    expect(enriched[0].nativeRelationships).toMatchObject({
      loaded: true,
      parentLoaded: true,
      parent: { number: 10 },
      blockedBy: [],
      subIssues: [],
    });
    expect(enriched[1].nativeRelationships.blockedBy).toEqual([
      { number: 20, state: 'closed' },
    ]);
    expect(enriched[2].nativeRelationships).toMatchObject({
      parentLoaded: false,
      blockedBy: [{ number: 30, state: 'open' }],
      subIssues: [{ number: 31, state: 'open' }],
    });
    expect(enriched[3].nativeRelationships).toMatchObject({
      parentLoaded: false,
      blockedBy: [],
      subIssues: [],
    });
  });

  it('paginates native dependency collections instead of silently truncating them', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 100,
      state: 'closed',
    }));
    const paths: string[] = [];
    const request = async (path: string) => {
      paths.push(path);
      return paths.length === 1 ? firstPage : [{ number: 200, state: 'open' }];
    };
    const [enriched] = await enrichOpenIssueRelationships('AustinOrphan/tanks', [{
      number: 5,
      body: '',
      labels: ['agent-ready'],
      issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 101 },
      sub_issues_summary: { total: 0 },
    }], request);

    expect(paths).toEqual([
      '/repos/AustinOrphan/tanks/issues/5/dependencies/blocked_by?per_page=100&page=1',
      '/repos/AustinOrphan/tanks/issues/5/dependencies/blocked_by?per_page=100&page=2',
    ]);
    expect(enriched.nativeRelationships.blockedBy).toHaveLength(101);
  });

  it('rejects malformed relationship pages instead of treating them as empty', async () => {
    await expect(enrichOpenIssueRelationships('AustinOrphan/tanks', [{
      number: 6,
      body: '',
      labels: ['agent-ready'],
      issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 1 },
      sub_issues_summary: { total: 0 },
    }], async () => ({ message: 'bad' }))).rejects.toThrow('was not an array');
  });
});

describe('issue-event API changes', () => {
  it('replaces only area and impact labels selected explicitly in a form', async () => {
    const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
    const request = async (path: string, options: Record<string, unknown> = {}) => {
      calls.push({ path, options });
      return null;
    };
    const payload = {
      action: 'edited',
      issue: {
        number: 215,
        body: [
          '### Primary area',
          '',
          'area:ai — AI perception, decisions, aiming, or movement',
          '',
          '### Expected impact',
          '',
          'impact:high — Blocks a primary flow, protects user data, or unlocks a major dependency chain',
        ].join('\n'),
        labels: [
          { name: 'size:s' },
          { name: 'risk:low' },
          { name: 'area:ui' },
          { name: 'impact:low' },
          { name: 'priority:next' },
          { name: 'agent-ready' },
        ],
      },
    };

    const changes = await applyIssueEvent('AustinOrphan/tanks', payload, request);
    expect(changes).toEqual({
      add: ['area:ai', 'impact:high'],
      remove: ['area:ui', 'impact:low'],
    });
    expect(calls.map((call) => [call.options.method, call.path])).toEqual([
      ['DELETE', '/repos/AustinOrphan/tanks/issues/215/labels/area%3Aui'],
      ['DELETE', '/repos/AustinOrphan/tanks/issues/215/labels/impact%3Alow'],
      ['POST', '/repos/AustinOrphan/tanks/issues/215/labels'],
    ]);
    expect(calls[2].options.body).toEqual({ labels: ['area:ai', 'impact:high'] });
  });

  it('uses per-label removal for close cleanup without replacing durable labels', async () => {
    const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
    const request = async (path: string, options: Record<string, unknown> = {}) => {
      calls.push({ path, options });
      return null;
    };
    const payload = {
      action: 'closed',
      issue: {
        number: 216,
        labels: [
          { name: 'size:m' },
          { name: 'risk:medium' },
          { name: 'area:repository' },
          { name: 'impact:high' },
          { name: 'priority:now' },
          { name: 'agent-ready' },
        ],
      },
    };

    const changes = await applyIssueEvent('AustinOrphan/tanks', payload, request);
    expect(changes.remove).toEqual(['priority:now', 'agent-ready']);
    expect(calls.map((call) => call.path)).toEqual([
      '/repos/AustinOrphan/tanks/issues/216/labels/priority%3Anow',
      '/repos/AustinOrphan/tanks/issues/216/labels/agent-ready',
    ]);
    expect(calls.every((call) => call.options.method === 'DELETE')).toBe(true);
    expect(calls.every((call) => (call.options.allowStatuses as number[]).includes(404))).toBe(true);
  });
});

describe('GitHub request boundary', () => {
  it('sends the token only as an authorization header and serializes JSON bodies', async () => {
    let seen: { url?: string; init?: RequestInit } = {};
    const request = createGitHubRequest({
      token: 'secret-token',
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        seen = { url: String(url), init };
        return new Response('{"ok":true}', { status: 200 });
      },
    });

    await expect(request('/repos/owner/repo/issues/1/labels', {
      method: 'POST',
      body: { labels: ['area:ai'] },
    })).resolves.toEqual({ ok: true });
    expect(seen.url).toBe('https://api.github.com/repos/owner/repo/issues/1/labels');
    expect(seen.url).not.toContain('secret-token');
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer secret-token',
    );
    expect(seen.init?.body).toBe('{"labels":["area:ai"]}');
  });

  it('surfaces API failures and permits an explicitly tolerated missing label', async () => {
    const missing = createGitHubRequest({
      fetchImpl: async () => new Response('{"message":"Not Found"}', { status: 404 }),
    });
    await expect(missing('/missing')).rejects.toThrow('failed (404)');
    await expect(missing('/missing', { allowStatuses: [404] })).resolves.toBeNull();
  });
});

describe('audit command exit contract', () => {
  it('returns non-zero for contract errors and zero for a clean backlog', async () => {
    const response = (issues: unknown[]) => async () =>
      new Response(JSON.stringify(issues), { status: 200 });
    const log = () => undefined;

    await expect(main({
      argv: ['audit', '--repo', 'AustinOrphan/tanks'],
      env: {},
      fetchImpl: response([{ number: 1, state: 'open', labels: [] }]),
      log,
    })).resolves.toBe(1);

    await expect(main({
      argv: ['audit', '--repo', 'AustinOrphan/tanks'],
      env: {},
      fetchImpl: response([{
        number: 1,
        state: 'open',
        labels: ['size:s', 'risk:low', 'area:repository', 'impact:medium', 'priority:next'],
      }]),
      log,
    })).resolves.toBe(0);
  });

  it('returns non-zero when a live native blocker contradicts readiness', async () => {
    const reports: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/dependencies/blocked_by?')) {
        return new Response(JSON.stringify([{ number: 9, state: 'open' }]), { status: 200 });
      }
      return new Response(JSON.stringify([{
        number: 10,
        state: 'open',
        body: '## Dependencies\n\nNone',
        labels: [
          'size:s',
          'risk:low',
          'area:repository',
          'impact:high',
          'priority:now',
          'agent-ready',
        ],
        issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 1 },
        sub_issues_summary: { total: 0 },
      }]), { status: 200 });
    };

    await expect(main({
      argv: ['audit', '--repo', 'AustinOrphan/tanks'],
      env: {},
      fetchImpl,
      log: (report) => reports.push(report),
    })).resolves.toBe(1);
    expect(reports.join('\n')).toContain('agent-ready-native-blocked');
    expect(reports.join('\n')).toContain('now-native-blocked');
  });
});

// A stateful fake of the GitHub surface the queue reconciliation touches. It applies label
// writes to its own state so a second run sees the first run's effects -- the only way to
// prove the composed command converges, which a unit test on the planner cannot.
type FakeIssue = {
  number: number;
  state?: string;
  labels: string[];
  milestone?: { number: number; title: string } | null;
  issue_dependencies_summary?: Record<string, number>;
  sub_issues_summary?: Record<string, number>;
  blockedBy?: Array<{ number: number; state: string }>;
  pull_request?: { url: string };
};
type FakePull = { number: number; isDraft?: boolean; closes: number[]; repo?: string };

function createFakeGitHub(options: {
  issues: FakeIssue[];
  pulls?: FakePull[];
  repo?: string;
  failDelete?: (label: string, count: number) => boolean;
  graphql?: (body: Record<string, unknown>) => unknown;
}) {
  const repo = options.repo ?? 'AustinOrphan/tanks';
  const state = options.issues.map((issue) => ({ ...issue, labels: [...issue.labels] }));
  const writes: string[] = [];
  const reads: string[] = [];
  let deletes = 0;
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const restIssue = (issue: (typeof state)[number]) => ({
    number: issue.number,
    state: issue.state ?? 'open',
    title: `Issue ${issue.number}`,
    body: '## Dependencies\n\nNone',
    labels: issue.labels.map((name) => ({ name })),
    milestone: issue.milestone ?? null,
    issue_dependencies_summary: issue.issue_dependencies_summary
      ?? { blocked_by: 0, total_blocked_by: 0, blocking: 0, total_blocking: 0 },
    sub_issues_summary: issue.sub_issues_summary ?? { total: 0, completed: 0 },
    ...(issue.pull_request === undefined ? {} : { pull_request: issue.pull_request }),
  });

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname + url.search;
    if (method === 'GET') reads.push(path);
    else writes.push(`${method} ${path}`);

    if (path === '/graphql' && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      if (options.graphql !== undefined) return json(options.graphql(body));
      return json({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: (options.pulls ?? []).map((pull) => ({
                number: pull.number,
                isDraft: pull.isDraft ?? false,
                closingIssuesReferences: {
                  totalCount: pull.closes.length,
                  nodes: pull.closes.map((number) => ({
                    number,
                    state: 'OPEN',
                    repository: { nameWithOwner: pull.repo ?? repo },
                  })),
                },
              })),
            },
          },
        },
      });
    }

    const list = new RegExp(`^/repos/${repo}/issues\\?state=open`);
    if (list.test(path)) return json(state.filter((issue) => (issue.state ?? 'open') === 'open').map(restIssue));

    const single = new RegExp(`^/repos/${repo}/issues/(\\d+)$`).exec(path);
    if (single !== null && method === 'GET') {
      const issue = state.find((entry) => entry.number === Number(single[1]));
      return issue === undefined ? json({ message: 'Not Found' }, 404) : json(restIssue(issue));
    }

    const blockedBy = new RegExp(`^/repos/${repo}/issues/(\\d+)/dependencies/blocked_by\\?`).exec(path);
    if (blockedBy !== null) {
      const issue = state.find((entry) => entry.number === Number(blockedBy[1]));
      return json(issue?.blockedBy ?? []);
    }
    if (/\/sub_issues\?/.test(path)) return json([]);
    if (/\/parent$/.test(path)) return json({ message: 'Not Found' }, 404);

    const addLabels = new RegExp(`^/repos/${repo}/issues/(\\d+)/labels$`).exec(path);
    if (addLabels !== null && method === 'POST') {
      const issue = state.find((entry) => entry.number === Number(addLabels[1]));
      if (issue === undefined) return json({ message: 'Not Found' }, 404);
      for (const label of JSON.parse(String(init?.body)).labels as string[]) {
        if (!issue.labels.includes(label)) issue.labels.push(label);
      }
      return json(issue.labels.map((name) => ({ name })));
    }

    const removeLabel = new RegExp(`^/repos/${repo}/issues/(\\d+)/labels/([^/]+)$`).exec(path);
    if (removeLabel !== null && method === 'DELETE') {
      deletes += 1;
      const label = decodeURIComponent(removeLabel[2]);
      if (options.failDelete?.(label, deletes)) return json({ message: 'rate limited' }, 403);
      const issue = state.find((entry) => entry.number === Number(removeLabel[1]));
      if (issue === undefined || !issue.labels.includes(label)) return json({ message: 'Not Found' }, 404);
      issue.labels = issue.labels.filter((entry) => entry !== label);
      return json(issue.labels.map((name) => ({ name })));
    }

    throw new Error(`unexpected ${method} ${path}`);
  };

  return { fetchImpl, writes, reads, state, labelsOf: (number: number) => state.find((i) => i.number === number)?.labels };
}

const readyNext = ['size:s', 'risk:low', 'area:repository', 'impact:medium', 'priority:next', 'agent-ready'];
const readyNow = ['size:s', 'risk:low', 'area:repository', 'impact:medium', 'priority:now', 'agent-ready'];

describe('linked pull-request retrieval', () => {
  it('maps every open pull request onto the issues its closing references name, drafts included', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const pages = [
      {
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
              nodes: [
                {
                  number: 900,
                  isDraft: true,
                  closingIssuesReferences: {
                    totalCount: 2,
                    nodes: [
                      { number: 10, state: 'OPEN', repository: { nameWithOwner: 'AustinOrphan/tanks' } },
                      { number: 11, state: 'OPEN', repository: { nameWithOwner: 'AustinOrphan/tanks' } },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
      {
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 901,
                  isDraft: false,
                  closingIssuesReferences: {
                    totalCount: 2,
                    nodes: [
                      { number: 11, state: 'OPEN', repository: { nameWithOwner: 'AustinOrphan/tanks' } },
                      // A closing reference into another repository never links an issue here.
                      { number: 12, state: 'OPEN', repository: { nameWithOwner: 'someone/else' } },
                    ],
                  },
                },
                { number: 902, isDraft: false, closingIssuesReferences: { totalCount: 0, nodes: [] } },
              ],
            },
          },
        },
      },
    ];
    const request = async (path: string, options: Record<string, unknown> = {}) => {
      expect(path).toBe('/graphql');
      expect(options.method).toBe('POST');
      bodies.push(options.body as Record<string, unknown>);
      return pages[bodies.length - 1];
    };

    const links = await loadOpenPullRequestLinks('AustinOrphan/tanks', request);
    expect([...links.entries()]).toEqual([
      [10, [{ number: 900, isDraft: true }]],
      [11, [{ number: 900, isDraft: true }, { number: 901, isDraft: false }]],
    ]);
    expect(bodies).toHaveLength(2);
    expect((bodies[0].variables as Record<string, unknown>)).toEqual({ owner: 'AustinOrphan', name: 'tanks', after: null });
    expect((bodies[1].variables as Record<string, unknown>).after).toBe('cursor-1');
    expect(String(bodies[0].query)).toContain('states: [OPEN]');
    expect(String(bodies[0].query)).toContain('closingIssuesReferences');
  });

  it('refuses GraphQL errors, a missing payload, or more closing references than one page holds', async () => {
    const withErrors = async () => ({ errors: [{ message: 'Resource not accessible by integration' }] });
    await expect(loadOpenPullRequestLinks('AustinOrphan/tanks', withErrors))
      .rejects.toThrow('Resource not accessible by integration');

    const empty = async () => ({ data: { repository: null } });
    await expect(loadOpenPullRequestLinks('AustinOrphan/tanks', empty)).rejects.toThrow('pull requests');

    const overflow = async () => ({
      data: {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ number: 903, isDraft: false, closingIssuesReferences: { totalCount: 101, nodes: [] } }],
          },
        },
      },
    });
    await expect(loadOpenPullRequestLinks('AustinOrphan/tanks', overflow)).rejects.toThrow('#903');
  });

  it('attaches inspected linkage to every issue, with an empty list for unlinked ones', () => {
    const links = new Map([[5, [{ number: 950, isDraft: false }]]]);
    const attached = attachLinkedPullRequests([{ number: 5 }, { number: 6 }], links);
    expect(attached.map((issue) => issue.linkedPullRequests)).toEqual([
      { loaded: true, open: [{ number: 950, isDraft: false }] },
      { loaded: true, open: [] },
    ]);
  });
});

describe('queue-relevant relationship retrieval', () => {
  it('reads relationships only for Now items and label-shaped candidates, marking the rest uninspected', async () => {
    const issues = [
      { number: 1, body: '', labels: ['priority:now', 'agent-ready'], issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 0 }, sub_issues_summary: { total: 0 } },
      { number: 2, body: '', labels: ['priority:next', 'agent-ready'], issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 0 }, sub_issues_summary: { total: 0 } },
      { number: 3, body: 'Parent: #9', labels: ['priority:next'], issue_dependencies_summary: { blocked_by: 3, total_blocked_by: 3 }, sub_issues_summary: { total: 2 } },
      { number: 4, body: '', labels: ['priority:later', 'agent-ready'], issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 0 }, sub_issues_summary: { total: 0 } },
    ];
    const paths: string[] = [];
    const request = async (path: string) => {
      paths.push(path);
      return [];
    };
    const enriched = await enrichQueueRelevantIssues('AustinOrphan/tanks', issues, request);
    expect(paths.sort()).toEqual([
      '/repos/AustinOrphan/tanks/issues/1/dependencies/blocked_by?per_page=100&page=1',
      '/repos/AustinOrphan/tanks/issues/2/dependencies/blocked_by?per_page=100&page=1',
    ]);
    expect(enriched.map((issue) => issue.number)).toEqual([1, 2, 3, 4]);
    expect(enriched[0].nativeRelationships.loaded).toBe(true);
    expect(enriched[1].nativeRelationships.loaded).toBe(true);
    expect(enriched[2].nativeRelationships).toEqual({
      loaded: false, parentLoaded: false, parent: null, blockersLoaded: false, blockedBy: [], subIssues: [],
    });
    expect(enriched[3].nativeRelationships.loaded).toBe(false);
  });
});

describe('queue plan application', () => {
  const plan = (changes: Array<{ issueNumber: number; kind: 'promote' | 'demote' | 'repair'; add: string[]; remove: string[]; labels: string[] }>) =>
    ({ changes } as unknown as Parameters<typeof applyQueuePlan>[1]);

  it('writes additions before removals so an interrupted write never leaves an issue without a horizon', async () => {
    const github = createFakeGitHub({ issues: [{ number: 20, labels: readyNext }] });
    const request = createGitHubRequest({ fetchImpl: github.fetchImpl, token: 't' });
    const outcome = await applyQueuePlan('AustinOrphan/tanks', plan([
      { issueNumber: 20, kind: 'promote', add: ['priority:now'], remove: ['priority:next'], labels: readyNext },
    ]), request, {});
    expect(outcome).toEqual({ applied: [20], skipped: [] });
    expect(github.writes).toEqual([
      'POST /repos/AustinOrphan/tanks/issues/20/labels',
      'DELETE /repos/AustinOrphan/tanks/issues/20/labels/priority%3Anext',
    ]);
    expect(github.labelsOf(20)).toEqual([...readyNext.filter((l) => l !== 'priority:next'), 'priority:now']);
  });

  it('re-reads each issue and skips one that closed or changed since the plan was computed', async () => {
    const github = createFakeGitHub({ issues: [
      { number: 21, labels: readyNext, state: 'closed' },
      { number: 22, labels: [...readyNext, 'human-required'] },
      { number: 23, labels: readyNext },
    ] });
    const request = createGitHubRequest({ fetchImpl: github.fetchImpl, token: 't' });
    const outcome = await applyQueuePlan('AustinOrphan/tanks', plan([
      { issueNumber: 21, kind: 'promote', add: ['priority:now'], remove: ['priority:next'], labels: readyNext },
      { issueNumber: 22, kind: 'promote', add: ['priority:now'], remove: ['priority:next'], labels: readyNext },
      { issueNumber: 23, kind: 'promote', add: ['priority:now'], remove: ['priority:next'], labels: readyNext },
    ]), request, {});
    expect(outcome.applied).toEqual([23]);
    expect(outcome.skipped).toEqual([
      { issueNumber: 21, reason: 'the issue is no longer open' },
      { issueNumber: 22, reason: 'labels changed since the plan was computed' },
    ]);
    expect(github.writes.every((write) => write.includes('/issues/23/'))).toBe(true);
    expect(github.labelsOf(21)).toEqual(readyNext);
    expect(github.labelsOf(22)).toEqual([...readyNext, 'human-required']);
  });

  it('performs no reads or writes in dry-run mode', async () => {
    const github = createFakeGitHub({ issues: [{ number: 24, labels: readyNext }] });
    const request = createGitHubRequest({ fetchImpl: github.fetchImpl, token: 't' });
    const outcome = await applyQueuePlan('AustinOrphan/tanks', plan([
      { issueNumber: 24, kind: 'promote', add: ['priority:now'], remove: ['priority:next'], labels: readyNext },
    ]), request, { dryRun: true });
    expect(outcome).toEqual({ applied: [], skipped: [] });
    expect(github.writes).toEqual([]);
    expect(github.reads).toEqual([]);
  });
});

describe('reconcile command', () => {
  const env = { GH_TOKEN: 'token' };
  const quiet = () => undefined;

  it('requires a token, because pull-request linkage is a GraphQL read', async () => {
    await expect(main({ argv: ['reconcile', '--repo', 'AustinOrphan/tanks'], env: {}, fetchImpl: async () => new Response('[]'), log: quiet }))
      .rejects.toThrow('reconcile mode requires GH_TOKEN or GITHUB_TOKEN');
  });

  it('rejects an unknown flag and accepts --dry-run', async () => {
    await expect(main({ argv: ['reconcile', '--apply'], env, fetchImpl: async () => new Response('[]'), log: quiet }))
      .rejects.toThrow('unknown argument: --apply');
    const github = createFakeGitHub({ issues: [{ number: 30, labels: readyNext }] });
    const reports: string[] = [];
    await expect(main({ argv: ['reconcile', '--repo', 'AustinOrphan/tanks', '--dry-run'], env, fetchImpl: github.fetchImpl, log: (r) => reports.push(r) }))
      .resolves.toBe(0);
    expect(github.writes.filter((write) => !write.endsWith('/graphql'))).toEqual([]);
    expect(reports.join('\n')).toContain('# Now queue reconciliation (dry run)');
    expect(reports.join('\n')).toContain('- #30: promote');
  });

  it('demotes an in-flight Now issue, refills from Next, and writes nothing on a second run', async () => {
    const github = createFakeGitHub({
      issues: [
        { number: 40, labels: readyNow },
        { number: 41, labels: readyNow },
        { number: 42, labels: readyNext, milestone: { number: 1, title: 'Public Prototype 1.0' } },
        { number: 43, labels: readyNext },
        { number: 44, labels: [...readyNext, 'human-required'] },
      ],
      pulls: [{ number: 960, isDraft: true, closes: [40] }],
    });
    const summaries: string[] = [];
    const run = () => main({
      argv: ['reconcile', '--repo', 'AustinOrphan/tanks'],
      env,
      fetchImpl: github.fetchImpl,
      log: (report) => summaries.push(report),
    });

    await expect(run()).resolves.toBe(0);
    expect(github.labelsOf(40)).toEqual([...readyNow.filter((l) => l !== 'priority:now'), 'priority:next']);
    expect(github.labelsOf(42)).toEqual([...readyNext.filter((l) => l !== 'priority:next'), 'priority:now']);
    expect(github.labelsOf(43)).toEqual([...readyNext.filter((l) => l !== 'priority:next'), 'priority:now']);
    expect(github.labelsOf(44)).toEqual([...readyNext, 'human-required']);
    expect(github.writes.filter((write) => !write.endsWith('/graphql'))).toEqual([
      'POST /repos/AustinOrphan/tanks/issues/40/labels',
      'DELETE /repos/AustinOrphan/tanks/issues/40/labels/priority%3Anow',
      'POST /repos/AustinOrphan/tanks/issues/42/labels',
      'DELETE /repos/AustinOrphan/tanks/issues/42/labels/priority%3Anext',
      'POST /repos/AustinOrphan/tanks/issues/43/labels',
      'DELETE /repos/AustinOrphan/tanks/issues/43/labels/priority%3Anext',
    ]);
    expect(summaries[0]).toContain('Applied 3 of 3 planned label change(s); 0 skipped.');

    github.writes.length = 0;
    await expect(run()).resolves.toBe(0);
    expect(github.writes.filter((write) => !write.endsWith('/graphql'))).toEqual([]);
    expect(summaries[1]).toContain('No label changes planned.');
  });

  it('leaves an interrupted promotion with two horizons, never none, and hands it to the audit', async () => {
    const github = createFakeGitHub({
      issues: [{ number: 50, labels: readyNext }],
      // The first DELETE (priority:next, after priority:now was added) is rate limited.
      failDelete: (label, count) => label === 'priority:next' && count === 1,
    });
    const run = (mode: string) => main({ argv: [mode, '--repo', 'AustinOrphan/tanks'], env, fetchImpl: github.fetchImpl, log: quiet });

    await expect(run('reconcile')).rejects.toThrow('failed (403)');
    // Additions land first, so the failure leaves the issue in Now with a stale Next label
    // rather than with no horizon at all.
    expect(github.labelsOf(50)).toEqual([...readyNext, 'priority:now']);

    // The next reconciliation does not guess which label a person meant: a human demoting by
    // hand passes through the same two-label state. It writes nothing and the audit names it.
    github.writes.length = 0;
    await expect(run('reconcile')).resolves.toBe(0);
    expect(github.writes.filter((write) => !write.endsWith('/graphql'))).toEqual([]);
    expect(github.labelsOf(50)).toEqual([...readyNext, 'priority:now']);
    const reports: string[] = [];
    await expect(main({ argv: ['audit', '--repo', 'AustinOrphan/tanks'], env, fetchImpl: github.fetchImpl, log: (r) => reports.push(r) }))
      .resolves.toBe(1);
    expect(reports.join('\n')).toContain('#50 `duplicate-priority`');
  });

  it('writes nothing when the pull-request read fails, rather than treating the failure as no PRs', async () => {
    const github = createFakeGitHub({
      issues: [{ number: 60, labels: readyNow }, { number: 61, labels: readyNext }],
      graphql: () => ({ errors: [{ message: 'Resource not accessible by integration' }] }),
    });
    await expect(main({ argv: ['reconcile', '--repo', 'AustinOrphan/tanks'], env, fetchImpl: github.fetchImpl, log: quiet }))
      .rejects.toThrow('Resource not accessible by integration');
    expect(github.writes.filter((write) => !write.endsWith('/graphql'))).toEqual([]);
  });
});

describe('audit command with pull-request linkage', () => {
  it('loads linkage when a token is present and reports an in-flight Now issue', async () => {
    const github = createFakeGitHub({
      issues: [{ number: 70, labels: readyNow }, { number: 71, labels: readyNext }],
      pulls: [{ number: 970, closes: [70] }],
    });
    const reports: string[] = [];
    await expect(main({ argv: ['audit', '--repo', 'AustinOrphan/tanks'], env: { GITHUB_TOKEN: 't' }, fetchImpl: github.fetchImpl, log: (r) => reports.push(r) }))
      .resolves.toBe(1);
    const report = reports.join('\n');
    expect(report).toContain('now-in-flight');
    expect(report).toContain('Linked pull requests: inspected for 2 of 2 audited issues.');
    expect(report).toContain('now-below-capacity');
    expect(report).toContain('# Now queue reconciliation (dry run)');
    expect(github.writes.filter((write) => !write.endsWith('/graphql'))).toEqual([]);
  });

  it('skips linkage without a token and says so, keeping the anonymous audit label-only', async () => {
    const github = createFakeGitHub({
      issues: [{ number: 72, labels: readyNow }],
      pulls: [{ number: 971, closes: [72] }],
    });
    const reports: string[] = [];
    await expect(main({ argv: ['audit', '--repo', 'AustinOrphan/tanks'], env: {}, fetchImpl: github.fetchImpl, log: (r) => reports.push(r) }))
      .resolves.toBe(0);
    expect(reports.join('\n')).toContain('Linked pull requests: not inspected (no token)');
    expect(github.writes).toEqual([]);
  });
});
