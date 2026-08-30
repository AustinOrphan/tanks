import { describe, expect, it, vi } from 'vitest';
import {
  expandRelationshipPlan,
  main,
  migrateRelationships,
  renderMigrationReport,
} from './migrate-relationships.mjs';
import { RELATIONSHIP_MIGRATION } from './relationship-migration-plan.mjs';

const plan = {
  repository: 'AustinOrphan/tanks',
  parents: [{ parent: 10, children: [11, 12] }],
  blockedBy: [{ issue: 12, blockers: [20, 21] }],
};

const issue = (number: number) => ({ id: number * 100, number, state: 'open' });

function createApi({ parent = null, blockers = [] as number[] } = {}) {
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

describe('relationship migration plan', () => {
  it('keeps the reviewed repository ledger unambiguous and acyclic', () => {
    const expanded = expandRelationshipPlan(RELATIONSHIP_MIGRATION);
    expect(expanded.parentEdges).toHaveLength(81);
    expect(expanded.dependencyEdges).toHaveLength(145);
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
  it('is a read-only dry run and reports the exact additive work', async () => {
    const api = createApi();
    const result = await migrateRelationships({
      repository: plan.repository,
      request: api.request,
      plan,
      pause: async () => undefined,
    });
    expect(result.missingParents).toEqual([{ parent: 10, child: 11 }, { parent: 10, child: 12 }]);
    expect(result.missingDependencies).toEqual([
      { issue: 12, blocker: 20 },
      { issue: 12, blocker: 21 },
    ]);
    expect(api.calls.every(({ options }) => (options.method ?? 'GET') === 'GET')).toBe(true);
    const report = renderMigrationReport(result);
    expect(report).toContain('### Parent edges to add');
    expect(report).toContain('- #10 → #11');
    expect(report).toContain('### Blocked-by edges to add');
    expect(report).toContain('- #12 blocked by #20');
    expect(report).toContain('No relationships were changed');
  });

  it('uses database IDs for writes, verifies the result, and is idempotent', async () => {
    const api = createApi();
    const first = await migrateRelationships({
      repository: plan.repository,
      request: api.request,
      apply: true,
      plan,
      pause: async () => undefined,
    });
    expect(first.missingParents).toHaveLength(2);
    expect(first.missingDependencies).toHaveLength(2);
    const writes = api.calls.filter(({ options }) => options.method === 'POST');
    expect(writes.map(({ path, options }) => [path, options.body])).toEqual([
      ['/repos/AustinOrphan/tanks/issues/10/sub_issues', { sub_issue_id: 1100 }],
      ['/repos/AustinOrphan/tanks/issues/10/sub_issues', { sub_issue_id: 1200 }],
      ['/repos/AustinOrphan/tanks/issues/12/dependencies/blocked_by', { issue_id: 2000 }],
      ['/repos/AustinOrphan/tanks/issues/12/dependencies/blocked_by', { issue_id: 2100 }],
    ]);

    api.calls.length = 0;
    const second = await migrateRelationships({
      repository: plan.repository,
      request: api.request,
      apply: true,
      plan,
      pause: async () => undefined,
    });
    expect(second.existingParents).toBe(2);
    expect(second.existingDependencies).toBe(2);
    expect(api.calls.some(({ options }) => options.method === 'POST')).toBe(false);
  });

  it('refuses to reparent an issue or run against another repository', async () => {
    const conflicting = createApi({ parent: 99 });
    await expect(migrateRelationships({
      repository: plan.repository,
      request: conflicting.request,
      plan,
    })).rejects.toThrow('#11 already belongs to #99');
    await expect(migrateRelationships({
      repository: 'someone/fork',
      request: conflicting.request,
      plan,
    })).rejects.toThrow('pinned to AustinOrphan/tanks');
  });
});

describe('apply guard', () => {
  it('requires a token and exact repository confirmation before any request', async () => {
    const fetchImpl = vi.fn();
    await expect(main({
      argv: ['apply', '--repo', 'AustinOrphan/tanks'],
      env: {},
      fetchImpl,
      log: () => undefined,
    })).rejects.toThrow('requires GH_TOKEN or GITHUB_TOKEN');
    await expect(main({
      argv: ['apply', '--repo', 'AustinOrphan/tanks', '--confirm', 'wrong/repo'],
      env: { GITHUB_TOKEN: 'token' },
      fetchImpl,
      log: () => undefined,
    })).rejects.toThrow('requires --confirm AustinOrphan/tanks');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
