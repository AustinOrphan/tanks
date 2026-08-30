import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  RelationshipMigrationError,
  expandRelationshipPlan,
  main,
  mapWithConcurrency,
  migrateRelationships,
  renderMigrationReport,
  withRequestTimeout,
} from './migrate-relationships.mjs';
import { RELATIONSHIP_MIGRATION } from './relationship-migration-plan.mjs';

const plan = {
  repository: 'AustinOrphan/tanks',
  parents: [{ parent: 10, children: [11, 12] }],
  blockedBy: [{ issue: 12, blockers: [20, 21] }],
};

const issue = (number: number) => ({ id: number * 100, number, state: 'open' });

function createApi({ parent = null as number | null, blockers = [] as number[] } = {}) {
  const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
  const parents = new Map<number, number | null>([[11, parent], [12, parent]]);
  const blockedBy = new Map<number, number[]>([[12, [...blockers]]]);
  const request = async (path: string, options: Record<string, unknown> = {}) => {
    calls.push({ path, options });
    const method = options.method ?? 'GET';
    const issueMatch = /\/issues\/(\d+)$/.exec(path);
    if (method === 'GET' && issueMatch) return issue(Number(issueMatch[1]));
    const parentMatch = /\/issues\/(\d+)\/parent$/.exec(path);
    if (method === 'GET' && parentMatch) {
      const value = parents.get(Number(parentMatch[1]));
      return value === null ? null : issue(value!);
    }
    const blockerList = /\/issues\/(\d+)\/dependencies\/blocked_by\?/.exec(path);
    if (method === 'GET' && blockerList) {
      return (blockedBy.get(Number(blockerList[1])) ?? []).map(issue);
    }
    const addChild = /\/issues\/(\d+)\/sub_issues$/.exec(path);
    if (method === 'POST' && addChild) {
      const childId = (options.body as { sub_issue_id: number }).sub_issue_id;
      parents.set(childId / 100, Number(addChild[1]));
      return issue(childId / 100);
    }
    const addBlocker = /\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(path);
    if (method === 'POST' && addBlocker) {
      const target = Number(addBlocker[1]);
      const blockerId = (options.body as { issue_id: number }).issue_id;
      blockedBy.set(target, [...(blockedBy.get(target) ?? []), blockerId / 100]);
      return issue(blockerId / 100);
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { calls, request };
}

function createFetch(
  request: (path: string, options?: Record<string, unknown>) => Promise<unknown>,
  { failWrite }: { failWrite?: number } = {},
) {
  let writes = 0;
  return vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    const method = init.method ?? 'GET';
    if (method === 'POST') {
      writes += 1;
      if (writes === failWrite) {
        return new Response('{"message":"injected write failure"}', { status: 500 });
      }
    }
    const options: Record<string, unknown> = { method };
    if (init.body !== undefined) options.body = JSON.parse(String(init.body));
    const value = await request(path, options);
    if (value === null && path.endsWith('/parent')) {
      return new Response('{"message":"Not Found"}', { status: 404 });
    }
    if (value === null) return new Response('', { status: 204 });
    return new Response(JSON.stringify(value), { status: 200 });
  });
}

describe('relationship migration plan', () => {
  it('keeps the reviewed repository ledger unambiguous, acyclic, and evidence-complete', () => {
    const expanded = expandRelationshipPlan(RELATIONSHIP_MIGRATION);
    expect(expanded.parentEdges).toHaveLength(81);
    expect(expanded.dependencyEdges).toHaveLength(147);
    expect(expanded.dependencyEdges).toEqual(expect.arrayContaining([
      { issue: 250, blocker: 245 },
      { issue: 260, blocker: 316 },
      { issue: 276, blocker: 275 },
      { issue: 335, blocker: 342 },
    ]));
    expect(expanded.dependencyEdges.filter(({ issue: number }) => number === 327)).toEqual([
      { issue: 327, blocker: 318 },
      { issue: 327, blocker: 319 },
      { issue: 327, blocker: 320 },
      { issue: 327, blocker: 321 },
    ]);

    const issueNumbers = new Set([
      ...expanded.parentEdges.flatMap(({ parent, child }) => [parent, child]),
      ...expanded.dependencyEdges.flatMap(({ issue: number, blocker }) => [number, blocker]),
    ]);
    const blockedIssues = new Set(expanded.dependencyEdges.map(({ issue: number }) => number));
    const inspectionReads = expanded.parentEdges.length + blockedIssues.size;
    const initialApply = (
      inspectionReads
      + issueNumbers.size
      + expanded.parentEdges.length
      + expanded.dependencyEdges.length
      + inspectionReads
    );
    expect({ inspectionReads, initialApply, planThenApply: inspectionReads + initialApply })
      .toEqual({ inspectionReads: 136, initialApply: 591, planThenApply: 727 });
  });

  it('expands a reviewed plan and rejects ambiguous parents, duplicates, and cycles', () => {
    expect(expandRelationshipPlan(plan)).toEqual({
      parentEdges: [{ parent: 10, child: 11 }, { parent: 10, child: 12 }],
      dependencyEdges: [{ issue: 12, blocker: 20 }, { issue: 12, blocker: 21 }],
    });
    expect(() => expandRelationshipPlan({
      ...plan,
      parents: [{ parent: 10, children: [12] }, { parent: 13, children: [12] }],
    })).toThrow('assigned to both');
    expect(() => expandRelationshipPlan({
      ...plan,
      blockedBy: [{ issue: 12, blockers: [20, 20] }],
    })).toThrow('duplicate blocked-by');
    expect(() => expandRelationshipPlan({
      ...plan,
      blockedBy: [{ issue: 12, blockers: [20] }, { issue: 20, blockers: [12] }],
    })).toThrow('dependency relationship plan contains a cycle');
  });
});

describe('native relationship migration', () => {
  it('is a low-request read-only plan and preserves the missing-parent 404 contract', async () => {
    const api = createApi();
    const result = await migrateRelationships({
      repository: plan.repository,
      request: api.request,
      plan,
      pause: async () => undefined,
    });
    expect(result.status).toBe('planned');
    expect(result.requests).toBe(3);
    expect(result.missingParents).toEqual([{ parent: 10, child: 11 }, { parent: 10, child: 12 }]);
    expect(result.missingDependencies).toEqual([
      { issue: 12, blocker: 20 },
      { issue: 12, blocker: 21 },
    ]);
    expect(api.calls.every(({ options }) => (options.method ?? 'GET') === 'GET')).toBe(true);
    expect(api.calls.filter(({ path }) => path.endsWith('/parent'))).toHaveLength(2);
    for (const { options } of api.calls.filter(({ path }) => path.endsWith('/parent'))) {
      expect(options.allowStatuses).toEqual([404]);
    }
    expect(api.calls.some(({ path }) => /\/issues\/\d+$/.test(path))).toBe(false);

    const report = renderMigrationReport(result);
    expect(report).toContain('### Parent edges to add');
    expect(report).toContain('- #10 → #11');
    expect(report).toContain('### Blocked-by edges to add');
    expect(report).toContain('- #12 blocked by #20');
    expect(report).toContain('No relationships were changed');
  });

  it('uses database IDs, rate-limits every write, verifies, reports, and stays idempotent', async () => {
    const api = createApi();
    const pause = vi.fn(async () => undefined);
    const first = await migrateRelationships({
      repository: plan.repository,
      request: api.request,
      apply: true,
      plan,
      pause,
    });
    expect(first.status).toBe('succeeded');
    expect(first.verified).toBe(true);
    expect(first.addedParents).toHaveLength(2);
    expect(first.addedDependencies).toHaveLength(2);
    expect(pause).toHaveBeenCalledTimes(4);
    const writes = api.calls.filter(({ options }) => options.method === 'POST');
    expect(writes.map(({ path, options }) => [path, options.body])).toEqual([
      ['/repos/AustinOrphan/tanks/issues/10/sub_issues', { sub_issue_id: 1100 }],
      ['/repos/AustinOrphan/tanks/issues/10/sub_issues', { sub_issue_id: 1200 }],
      ['/repos/AustinOrphan/tanks/issues/12/dependencies/blocked_by', { issue_id: 2000 }],
      ['/repos/AustinOrphan/tanks/issues/12/dependencies/blocked_by', { issue_id: 2100 }],
    ]);
    const report = renderMigrationReport(first);
    expect(report).toContain('2 added, 0 remaining');
    expect(report).toContain('### Parent edges added');
    expect(report).not.toContain('No relationships were changed');

    api.calls.length = 0;
    pause.mockClear();
    const second = await migrateRelationships({
      repository: plan.repository,
      request: api.request,
      apply: true,
      plan,
      pause,
    });
    expect(second.existingParents).toBe(2);
    expect(second.existingDependencies).toBe(2);
    expect(api.calls.some(({ options }) => options.method === 'POST')).toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });

  it('paginates blocked-by relationships beyond the first 100 entries', async () => {
    const pagedPlan = {
      repository: plan.repository,
      parents: [],
      blockedBy: [{ issue: 12, blockers: [150] }],
    };
    const paths: string[] = [];
    const request = async (path: string) => {
      paths.push(path);
      return path.endsWith('page=1')
        ? Array.from({ length: 100 }, (_, index) => issue(index + 1))
        : [issue(150)];
    };
    const result = await migrateRelationships({
      repository: plan.repository,
      request,
      plan: pagedPlan,
    });
    expect(result.existingDependencies).toBe(1);
    expect(result.missingDependencies).toEqual([]);
    expect(paths).toEqual([
      '/repos/AustinOrphan/tanks/issues/12/dependencies/blocked_by?per_page=100&page=1',
      '/repos/AustinOrphan/tanks/issues/12/dependencies/blocked_by?per_page=100&page=2',
    ]);
  });

  it('marks preflight state as incomplete when an inspection request fails', async () => {
    let failure: RelationshipMigrationError | undefined;
    try {
      await migrateRelationships({
        repository: plan.repository,
        request: async () => { throw new Error('inspection failed'); },
        plan,
      });
    } catch (error) {
      failure = error as RelationshipMigrationError;
    }
    expect(failure).toBeInstanceOf(RelationshipMigrationError);
    const report = renderMigrationReport(failure!.result);
    expect(report).toContain('Status: failed during inspect parent edges');
    expect(report).toContain('Parent edges: 2 (inspection incomplete)');
    expect(report).toContain('Blocked-by edges: 2 (inspection incomplete)');
  });

  it('repairs dependencies despite parent conflicts and reports the unresolved parents', async () => {
    const api = createApi({ parent: 99 });
    const pause = vi.fn(async () => undefined);
    let failure: RelationshipMigrationError | undefined;
    try {
      await migrateRelationships({
        repository: plan.repository,
        request: api.request,
        apply: true,
        plan,
        pause,
      });
    } catch (error) {
      failure = error as RelationshipMigrationError;
    }
    expect(failure).toBeInstanceOf(RelationshipMigrationError);
    expect(failure?.message).toContain('#11 already belongs to #99');
    expect(failure?.result.parentConflicts).toHaveLength(2);
    expect(failure?.result.addedDependencies).toHaveLength(2);
    expect(api.calls.filter(({ options }) => options.method === 'POST').map(({ path }) => path))
      .toEqual([
        '/repos/AustinOrphan/tanks/issues/12/dependencies/blocked_by',
        '/repos/AustinOrphan/tanks/issues/12/dependencies/blocked_by',
      ]);
    expect(renderMigrationReport(failure!.result)).toContain('### Parent conflicts');
  });

  it('rejects mismatched issue records, pull requests, and another repository', async () => {
    const oneParent = {
      repository: plan.repository,
      parents: [{ parent: 10, children: [11] }],
      blockedBy: [],
    };
    const invalidRecord = async (path: string) => {
      if (path.endsWith('/parent')) return null;
      const number = Number(/\/issues\/(\d+)$/.exec(path)?.[1]);
      return number === 11 ? issue(99) : issue(number);
    };
    await expect(migrateRelationships({
      repository: plan.repository,
      request: invalidRecord,
      apply: true,
      plan: oneParent,
      pause: async () => undefined,
    })).rejects.toThrow('invalid issue record for #11');

    const pullRequestRecord = async (path: string) => {
      if (path.endsWith('/parent')) return null;
      const number = Number(/\/issues\/(\d+)$/.exec(path)?.[1]);
      return number === 11 ? { ...issue(number), pull_request: {} } : issue(number);
    };
    await expect(migrateRelationships({
      repository: plan.repository,
      request: pullRequestRecord,
      apply: true,
      plan: oneParent,
      pause: async () => undefined,
    })).rejects.toThrow('invalid issue record for #11');

    await expect(migrateRelationships({
      repository: 'someone/fork',
      request: invalidRecord,
      plan: oneParent,
    })).rejects.toThrow('pinned to AustinOrphan/tanks');
  });

  it('stops concurrency workers from scheduling new requests after the first failure', async () => {
    const seen: number[] = [];
    await expect(mapWithConcurrency(
      Array.from({ length: 20 }, (_, index) => index),
      4,
      async (number) => {
        seen.push(number);
        if (number === 0) throw new Error('stop');
        await new Promise((done) => setTimeout(done, 5));
      },
    )).rejects.toThrow('stop');
    await new Promise((done) => setTimeout(done, 25));
    expect(seen.length).toBeLessThanOrEqual(4);
  });
});

describe('command safety and reporting', () => {
  it('requires a token in both modes and exact apply confirmation before any request', async () => {
    const fetchImpl = vi.fn();
    await expect(main({
      argv: ['plan', '--repo', 'AustinOrphan/tanks'],
      env: {},
      fetchImpl,
      log: () => undefined,
    })).rejects.toThrow('plan and apply modes require GH_TOKEN or GITHUB_TOKEN');
    await expect(main({
      argv: ['apply', '--repo', 'AustinOrphan/tanks', '--confirm', 'wrong/repo'],
      env: { GITHUB_TOKEN: 'token' },
      fetchImpl,
      log: () => undefined,
    })).rejects.toThrow('requires --confirm AustinOrphan/tanks');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('writes a successful main report to the GitHub step summary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tanks-relationships-'));
    const summary = join(directory, 'summary.md');
    const api = createApi();
    const fetchImpl = createFetch(api.request);
    const logs: string[] = [];
    try {
      await expect(main({
        argv: ['plan', '--repo', plan.repository],
        env: { GITHUB_TOKEN: 'token', GITHUB_STEP_SUMMARY: summary },
        fetchImpl,
        log: (message: string) => logs.push(message),
        plan,
        requestTimeoutMs: 1_000,
      })).resolves.toBe(0);
      expect(readFileSync(summary, 'utf8')).toContain('Native issue relationship migration (plan)');
      expect(logs.join('\n')).toContain('Status: planned');
      expect(fetchImpl.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains completed writes and emits an actionable summary after a partial failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tanks-relationships-'));
    const summary = join(directory, 'summary.md');
    const api = createApi();
    const fetchImpl = createFetch(api.request, { failWrite: 2 });
    try {
      await expect(main({
        argv: ['apply', '--repo', plan.repository, '--confirm', plan.repository],
        env: { GITHUB_TOKEN: 'token', GITHUB_STEP_SUMMARY: summary },
        fetchImpl,
        log: () => undefined,
        plan,
        pause: async () => undefined,
        requestTimeoutMs: 1_000,
      })).rejects.toThrow('injected write failure');
      const report = readFileSync(summary, 'utf8');
      expect(report).toContain('Status: failed during add parent edges');
      expect(report).toContain('### Parent edges added');
      expect(report).toContain('- #10 → #11');
      expect(report).toContain('### Parent edges remaining');
      expect(report).toContain('- #10 → #12');
      expect(report).toContain('### Blocked-by edges remaining');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('adds a request timeout without replacing a caller-provided signal', async () => {
    // The implementation ignores its arguments, but the assertions below read
    // `mock.calls[n][1]`, so the mock has to DECLARE the two parameters `withRequestTimeout`
    // actually calls it with -- otherwise `calls` is typed as an array of empty tuples.
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{}'));
    const timed = withRequestTimeout(fetchImpl, 1_000);
    await timed('https://example.test/one');
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    const controller = new AbortController();
    await timed('https://example.test/two', { signal: controller.signal });
    expect(fetchImpl.mock.calls[1][1]?.signal).toBe(controller.signal);
  });
});
