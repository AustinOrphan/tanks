import { describe, expect, it } from 'vitest';
import {
  applyIssueEvent,
  createGitHubRequest,
  listOpenIssues,
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
    const first = Array.from({ length: 99 }, (_, index) => ({ number: index + 1 }));
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
});
