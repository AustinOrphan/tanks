import { describe, expect, it } from 'vitest';
import {
  frontierOf,
  renderFrontier,
  longestDependencyChain,
  readinessOf,
  standingBlockers,
  unlockedByClosing,
} from './frontier.mjs';

// Snapshot-shaped fixtures, matching what `buildSnapshot` emits. Only the fields the
// frontier reads are filled: everything else is irrelevant to it by construction, and
// including it would suggest otherwise.
type Ref = { number: number; state: string | null };
type Options = {
  state?: string;
  title?: string;
  labels?: string[];
  milestone?: string | null;
  blockedBy?: Ref[];
  blockedByLoaded?: boolean;
  declaredBlockedBy?: number;
};

const issue = (number: number, options: Options = {}) => ({
  number,
  title: options.title ?? `issue ${number}`,
  url: `https://github.com/owner/name/issues/${number}`,
  state: options.state ?? 'open',
  labels: options.labels ?? [],
  milestone: options.milestone === undefined ? null : options.milestone,
  assignees: 0,
  parent: null,
  parentSource: 'unknown' as const,
  children: [],
  childrenLoaded: true,
  subIssueProgress: { total: 0, completed: 0 },
  blockedBy: options.blockedBy ?? [],
  blockedByLoaded: options.blockedByLoaded ?? true,
  declaredBlockedBy: options.declaredBlockedBy ?? (options.blockedBy ?? []).length,
  declaredBlocking: 0,
});

const snap = (issues: ReturnType<typeof issue>[], cycles: number[][] = []) => ({
  version: 1,
  generatedAt: '2026-09-20T00:00:00.000Z',
  source: { repo: 'owner/name', ref: null },
  counts: {},
  cycles,
  issues,
});

const index = (issues: ReturnType<typeof issue>[]) => new Map(issues.map((i) => [i.number, i]));

describe('frontier: unknown is never ready', () => {
  it('refuses to call an issue ready when GitHub says it has blockers nobody read', () => {
    // THE RULE THIS FILE EXISTS FOR. The `reconcile` path marks issues it did not inspect
    // `blockedByLoaded: false` while the list payload still reports a blocker count. Reading
    // that as "no blockers" would put blocked work on the executable frontier, which is the
    // one error this view could make that actively wastes a maintainer's day.
    const unread = issue(1, { blockedByLoaded: false, declaredBlockedBy: 2 });
    const verdict = readinessOf(unread, index([unread]));
    expect(verdict.readiness).toBe('unknown');
    expect(verdict.unknownBlockers).toBe(2);
    expect(verdict.reason).toContain('did not read');

    // The control: the SAME issue with the list actually read and genuinely empty. If
    // `readiness` ignored the loaded flag, both of these would say the same thing.
    const read = issue(1, { blockedByLoaded: true, declaredBlockedBy: 0 });
    expect(readinessOf(read, index([read])).readiness).toBe('ready');
  });

  it('treats a read list shorter than GitHub s own count as unknown, not as complete', () => {
    // Two declared, one read and closed. The closed one clears; the unread one does not
    // vanish because nobody fetched it.
    const short = issue(2, { blockedBy: [{ number: 9, state: 'closed' }], declaredBlockedBy: 2 });
    expect(readinessOf(short, index([short])).readiness).toBe('unknown');

    // The control: the same closed blocker with the count agreeing that it is the only one.
    const complete = issue(2, { blockedBy: [{ number: 9, state: 'closed' }], declaredBlockedBy: 1 });
    expect(readinessOf(complete, index([complete])).readiness).toBe('ready');
  });

  it('does not clear a blocker just because it is missing from the snapshot', () => {
    // The producer lists OPEN issues, so a blocker absent from the file is usually closed --
    // and "usually" is not a basis for telling someone their work is ready. A ref carrying
    // no state at all is unknown.
    const stateless = issue(3, { blockedBy: [{ number: 99, state: null }] });
    expect(readinessOf(stateless, index([stateless])).readiness).toBe('unknown');

    // The two controls, one either side: the same ref marked closed clears, marked open blocks.
    const closed = issue(3, { blockedBy: [{ number: 99, state: 'closed' }] });
    expect(readinessOf(closed, index([closed])).readiness).toBe('ready');
    const open = issue(3, { blockedBy: [{ number: 99, state: 'open' }] });
    expect(readinessOf(open, index([open])).readiness).toBe('blocked');
  });

  it('prefers the snapshot s own record of a blocker over the edge s stale state', () => {
    // An edge carries the state GitHub reported when the edge was read; the blocker's own
    // entry is the fresher fact. When they disagree, the entry wins.
    const blocker = issue(10, { state: 'closed' });
    const blocked = issue(11, { blockedBy: [{ number: 10, state: 'open' }] });
    expect(readinessOf(blocked, index([blocker, blocked])).readiness).toBe('ready');
  });

  it('names the blockers rather than counting them, which is the acceptance criterion', () => {
    const a = issue(20);
    const b = issue(21);
    const blocked = issue(22, { blockedBy: [{ number: 21, state: 'open' }, { number: 20, state: 'open' }] });
    const verdict = readinessOf(blocked, index([a, b, blocked]));
    expect(verdict.readiness).toBe('blocked');
    expect(verdict.openBlockers).toEqual([20, 21]);
    expect(verdict.reason).toBe('blocked by #20, #21');
  });
});

describe('frontier: what closing an issue would unlock', () => {
  const chain = [
    issue(1),
    issue(2, { blockedBy: [{ number: 1, state: 'open' }] }),
    issue(3, { blockedBy: [{ number: 2, state: 'open' }] }),
  ];

  it('separates what becomes READY from everything downstream', () => {
    // "Closing this unblocks 12 issues" is the claim a maintainer acts on, and it is false
    // if those 12 are each blocked by three other things. `immediate` counts only the ones
    // that actually become ready; `downstream` is reach and is reported as reach.
    const result = unlockedByClosing(snap(chain), 1);
    expect(result.immediate).toEqual([2]);
    expect(result.downstream).toEqual([2, 3]);
  });

  it('does not count an issue as immediately unlocked when another blocker stands', () => {
    // The control for the line above. #3 is blocked by BOTH #1 and #2, so closing #1 leaves
    // it blocked -- and a version of this that merely removed the edge would say otherwise.
    const two = [
      issue(1),
      issue(2),
      issue(3, { blockedBy: [{ number: 1, state: 'open' }, { number: 2, state: 'open' }] }),
    ];
    const result = unlockedByClosing(snap(two), 1);
    expect(result.immediate).toEqual([]);
    expect(result.downstream).toEqual([3]);
  });

  it('does not count an issue whose remaining blocker is merely unread', () => {
    const withUnread = [
      issue(1),
      issue(2, { blockedBy: [{ number: 1, state: 'open' }], declaredBlockedBy: 2 }),
    ];
    expect(unlockedByClosing(snap(withUnread), 1).immediate).toEqual([]);
  });
});

describe('frontier: the longest dependency chain, which is not a critical path', () => {
  it('finds the deepest prerequisite run', () => {
    const graph = [
      issue(1),
      issue(2, { blockedBy: [{ number: 1, state: 'open' }] }),
      issue(3, { blockedBy: [{ number: 2, state: 'open' }] }),
      issue(4),
    ];
    expect(longestDependencyChain(snap(graph))).toEqual([1, 2, 3]);
  });

  it('refuses to answer at all when the snapshot reports a cycle', () => {
    // #437: cycles must never masquerade as a valid DAG. A longest path is undefined on a
    // cyclic graph, so this returns nothing rather than a plausible-looking chain.
    const graph = [
      issue(1, { blockedBy: [{ number: 2, state: 'open' }] }),
      issue(2, { blockedBy: [{ number: 1, state: 'open' }] }),
    ];
    expect(longestDependencyChain(snap(graph, [[1, 2]]))).toEqual([]);

    // The control: the SAME two issues with the return edge gone and no cycle reported.
    const acyclic = [issue(1), issue(2, { blockedBy: [{ number: 1, state: 'open' }] })];
    expect(longestDependencyChain(snap(acyclic))).toEqual([1, 2]);
  });

  it('terminates on a cycle the snapshot failed to report', () => {
    // Belt and braces: `cycles` is the snapshot's claim, and a producer bug could leave it
    // empty on a cyclic graph. The walk must not hang in that case.
    const graph = [
      issue(1, { blockedBy: [{ number: 2, state: 'open' }] }),
      issue(2, { blockedBy: [{ number: 1, state: 'open' }] }),
    ];
    expect(() => longestDependencyChain(snap(graph, []))).not.toThrow();
  });
});

describe('frontier: bucketing and filters', () => {
  const graph = [
    issue(1, { labels: ['agent-ready'], milestone: 'PP1' }),
    issue(2, { labels: ['human-required'], milestone: 'PP1' }),
    issue(3, { blockedBy: [{ number: 1, state: 'open' }], milestone: 'PP1' }),
    issue(4, { blockedByLoaded: false, declaredBlockedBy: 1, milestone: 'PP1' }),
    issue(5, { state: 'closed', milestone: 'PP1' }),
    issue(6, { milestone: 'Later' }),
  ];

  it('buckets by readiness and reports the population it considered', () => {
    const f = frontierOf(snap(graph));
    expect(f.ready.map((r) => r.number)).toEqual([1, 2, 6]);
    expect(f.blocked.map((r) => r.number)).toEqual([3]);
    expect(f.unknown.map((r) => r.number)).toEqual([4]);
    // 6 issues, one closed and therefore not considered at all.
    expect(f.considered).toBe(5);
  });

  it('filters by milestone and by label, conjunctively', () => {
    expect(frontierOf(snap(graph), { milestone: 'PP1' }).considered).toBe(4);
    expect(frontierOf(snap(graph), { labels: ['agent-ready'] }).ready.map((r) => r.number)).toEqual([1]);
    const notHuman = frontierOf(snap(graph), { excludeLabels: ['human-required'] });
    expect(notHuman.ready.map((r) => r.number)).toEqual([1, 6]);
    // The control for the exclusion: without it, #2 is on the frontier.
    expect(frontierOf(snap(graph)).ready.map((r) => r.number)).toContain(2);
  });

  it('never puts an unknown issue in the ready bucket, whatever the filter', () => {
    // The rule from the first describe block, asserted at the level a caller actually uses.
    for (const filter of [{}, { milestone: 'PP1' }, { excludeLabels: ['human-required'] }]) {
      const f = frontierOf(snap(graph), filter);
      expect(f.ready.map((r) => r.number), JSON.stringify(filter)).not.toContain(4);
    }
  });
});

describe('frontier: standingBlockers', () => {
  it('sorts open blockers and keeps unknown ones separate', () => {
    const subject = issue(1, {
      blockedBy: [
        { number: 30, state: 'open' },
        { number: 10, state: 'closed' },
        { number: 20, state: 'open' },
        { number: 40, state: null },
      ],
      declaredBlockedBy: 4,
    });
    const { open, unknown } = standingBlockers(subject, index([subject]));
    expect(open).toEqual([20, 30]);
    expect(unknown).toHaveLength(1);
  });
});

describe('frontier: the rendered report', () => {
  const graph = [
    issue(1, { labels: ['priority:now', 'size:m'], title: 'a ready one' }),
    issue(2, { blockedBy: [{ number: 1, state: 'open' }], title: 'a blocked one' }),
    issue(3, { blockedByLoaded: false, declaredBlockedBy: 2, title: 'an unknown one' }),
  ];

  it('carries the denominator on the headline and the priority/size on each row', () => {
    const text = renderFrontier(snap(graph));
    expect(text).toContain('**1 ready / 1 blocked / 1 unknown**, of 3 open issues in scope');
    expect(text).toContain('- #1 [now/m] a ready one');
    expect(text).toContain('#2 blocked by #1');
    expect(text).toContain('#3 2 blocker(s) this snapshot did not read');
  });

  it('says in the output that ready does not mean startable', () => {
    // LOAD-BEARING, not decoration. Measured on this repository, the native graph called 24
    // of 28 issues ready while about 8 were waiting on a maintainer ruling -- a decision
    // carries no blocked-by edge, so no relationship data can see it. A reader who takes
    // this list as a work queue picks one up and stalls.
    const text = renderFrontier(snap(graph));
    expect(text).toContain('READY MEANS "NO BLOCKER IN THE GRAPH"');
    expect(text).toContain('decision carries no blocked-by edge');
  });

  it('separates "makes ready" from "reaches" wherever it prints both', () => {
    // The other load-bearing sentence: "closing this unblocks 12" is exactly the claim that
    // gets repeated from a number printed without the qualifier.
    const chain = [
      issue(1),
      issue(2, { blockedBy: [{ number: 1, state: 'open' }] }),
      issue(3, { blockedBy: [{ number: 2, state: 'open' }] }),
    ];
    const text = renderFrontier(snap(chain));
    expect(text).toContain('LAST standing blocker');
    expect(text).toContain('- #1: makes 1 ready (#2), reaches 2');
  });

  it('refuses the chain on a cyclic snapshot and says why, in the report itself', () => {
    const cyclic = [
      issue(1, { blockedBy: [{ number: 2, state: 'open' }] }),
      issue(2, { blockedBy: [{ number: 1, state: 'open' }] }),
    ];
    const text = renderFrontier(snap(cyclic, [[1, 2]]));
    expect(text).toContain('Not computed: the snapshot reports 1 cycle(s)');
    expect(text).not.toMatch(/^Depth \d/m);

    // The control: the same two issues without the return edge report a depth.
    const acyclic = [issue(1), issue(2, { blockedBy: [{ number: 1, state: 'open' }] })];
    expect(renderFrontier(snap(acyclic))).toContain('Depth 2: #1 -> #2');
  });

  it('names the scope it filtered to, so a short list cannot read as the whole graph', () => {
    const text = renderFrontier(snap(graph), { milestone: 'PP1', excludeLabels: ['human-required'] });
    expect(text).toContain('milestone PP1');
    expect(text).toContain('without human-required');
  });
});
