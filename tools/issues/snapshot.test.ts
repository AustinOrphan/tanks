import { describe, expect, it } from 'vitest';
import { SNAPSHOT_VERSION, buildSnapshot, normaliseCycles, snapshotIssue } from './snapshot.mjs';
import { issueLabelNames } from './metadata.mjs';

// Hand-built REST-shaped issues, the same loose shape `queue.test.ts` uses: the list
// payload's two summaries plus the `nativeRelationships` the runner attaches. The fields
// here are exactly the ones `enrichOpenIssueRelationships` really sets -- `loaded`,
// `parentLoaded`, `parent`, `blockersLoaded`, `blockedBy`, `subIssues` -- so a fixture
// cannot promise the snapshot an input production never produces.
type Ref = { number: number; state?: string };
type Options = {
  title?: string;
  url?: string;
  state?: string;
  labels?: string[];
  milestone?: string | null;
  assignees?: number;
  parent?: number | null;
  parentLoaded?: boolean;
  children?: Ref[];
  loaded?: boolean;
  blockedBy?: Ref[];
  blockersLoaded?: boolean;
  declaredBlockedBy?: number;
  declaredBlocking?: number;
  subIssues?: { total: number; completed: number };
  noSubIssueSummary?: boolean; // the payload carries no sub-issue summary at all
  blocking?: Ref[];
  pull_request?: unknown;
};

const issue = (number: number, options: Options = {}) => ({
  number,
  title: options.title ?? `issue ${number}`,
  html_url: options.url ?? `https://github.com/owner/name/issues/${number}`,
  state: options.state ?? 'open',
  labels: (options.labels ?? ['size:s']).map((name) => ({ name })),
  milestone: options.milestone ? { title: options.milestone } : null,
  assignees: Array.from({ length: options.assignees ?? 0 }, () => ({})),
  ...(options.pull_request === undefined ? {} : { pull_request: options.pull_request }),
  issue_dependencies_summary: {
    blocked_by: options.declaredBlockedBy ?? (options.blockedBy ?? []).length,
    total_blocked_by: options.declaredBlockedBy ?? (options.blockedBy ?? []).length,
    blocking: options.declaredBlocking ?? 0,
    total_blocking: options.declaredBlocking ?? 0,
  },
  ...(options.noSubIssueSummary === true ? {} : {
    sub_issues_summary: options.subIssues ?? { total: (options.children ?? []).length, completed: 0 },
  }),
  nativeRelationships: {
    loaded: options.loaded ?? true,
    parentLoaded: options.parentLoaded ?? options.parent !== undefined,
    parent: options.parent === undefined || options.parent === null ? null : { number: options.parent },
    blockersLoaded: options.blockersLoaded ?? options.blockedBy !== undefined,
    blockedBy: options.blockedBy ?? [],
    subIssues: options.children ?? [],
    ...(options.blocking === undefined ? {} : { blocking: options.blocking }),
  },
});

const build = (issues: ReturnType<typeof issue>[]) => buildSnapshot(issues, {
  repo: 'owner/name',
  ref: 'abc123',
  generatedAt: '2026-09-19T12:00:00.000Z',
  labelsOf: issueLabelNames,
});

const find = (snapshot: ReturnType<typeof build>, number: number) => {
  const found = snapshot.issues.find((candidate) => candidate.number === number);
  if (found === undefined) throw new Error(`#${number} is not in the snapshot`);
  return found;
};

describe('snapshotIssue', () => {
  it('carries the fields the map draws and counts assignees instead of naming them', () => {
    const shaped = snapshotIssue(
      issue(42, {
        title: 'Publish the map',
        labels: ['size:m', 'area:repository'],
        milestone: 'PP1',
        assignees: 2,
        state: 'closed',
      }),
      issueLabelNames,
    );

    expect(shaped.number).toBe(42);
    expect(shaped.title).toBe('Publish the map');
    expect(shaped.url).toBe('https://github.com/owner/name/issues/42');
    expect(shaped.state).toBe('closed');
    expect(shaped.milestone).toBe('PP1');
    // Sorted, not insertion-ordered: the fixture lists size before area.
    expect(shaped.labels).toEqual(['area:repository', 'size:m']);
    // A count, never logins. Anything that put a login here would put a person's name in a
    // public static file, so the assertion is on the absence as much as the number.
    expect(shaped.assignees).toBe(2);
    expect(JSON.stringify(shaped)).not.toContain('login');
  });

  it('reports an unread relationship as unknown rather than as empty', () => {
    // The `reconcile` path marks every issue it did not inspect `loaded: false`, and GitHub
    // still tells us the issue is blocked by two things. Reading that as "no blockers" would
    // present blocked work as ready, which is the failure this snapshot exists to avoid. It
    // is the PAIR that says so -- the flag alone is also how an unblocked issue looks.
    const unread = snapshotIssue(
      issue(7, { loaded: false, blockersLoaded: false, declaredBlockedBy: 2 }),
      issueLabelNames,
    );
    expect(unread.blockedBy).toEqual([]);
    expect(unread.blockedByLoaded).toBe(false);
    expect(unread.declaredBlockedBy).toBe(2);
    expect(unread.childrenLoaded).toBe(false);

    // The control for both flags: the SAME fixture with the relationship actually read. If
    // either flag were a constant rather than a reading of `nativeRelationships`, one of
    // these two assertions would hold in both directions.
    const read = snapshotIssue(
      issue(7, { loaded: true, blockersLoaded: true, blockedBy: [{ number: 5, state: 'open' }], declaredBlockedBy: 1 }),
      issueLabelNames,
    );
    expect(read.blockedByLoaded).toBe(true);
    expect(read.childrenLoaded).toBe(true);
    expect(read.blockedBy).toEqual([{ number: 5, state: 'open' }]);
  });

  it('reports sub-issue progress as zeroes when the payload carries no summary', () => {
    // One shape for the field in every record, so a client never has to branch on its
    // absence. The control below is the same call against a payload that does carry one.
    expect(snapshotIssue(issue(3, { noSubIssueSummary: true }), issueLabelNames).subIssueProgress)
      .toEqual({ total: 0, completed: 0 });
    expect(snapshotIssue(issue(3, { subIssues: { total: 4, completed: 1 } }), issueLabelNames).subIssueProgress)
      .toEqual({ total: 4, completed: 1 });
  });

  it('ignores the nativeRelationships.blocking field that nothing populates', () => {
    // `NativeRelationships` declares `blocking`, but no producer in this repository sets it:
    // `enrichOpenIssueRelationships` writes parent, blockedBy and subIssues only. Reading it
    // would ship a permanently empty field and edges that only a fixture can create. This
    // fails the moment someone wires `blocking` in without also wiring a producer.
    const shaped = snapshotIssue(
      issue(9, { blocking: [{ number: 11, state: 'open' }], declaredBlocking: 3 }),
      issueLabelNames,
    );
    expect(Object.keys(shaped)).not.toContain('blocking');
    // The real substitute: GitHub's own count, which every list payload carries.
    expect(shaped.declaredBlocking).toBe(3);
  });
});

describe('normaliseCycles', () => {
  it('rotates every cycle to its lowest member and orders the list', () => {
    expect(normaliseCycles([[12, 10, 11], [2, 1]])).toEqual([[1, 2], [10, 11, 12]]);
  });

  it('leaves an already-normalised list alone', () => {
    // The control for the rotation above: normalising twice must not keep moving members,
    // or the committed file would differ from itself.
    const once = normaliseCycles([[2, 1], [3, 9, 4]]);
    expect(normaliseCycles(once)).toEqual(once);
    expect(once).toEqual([[1, 2], [3, 9, 4]]);
  });
});

describe('buildSnapshot', () => {
  it('stamps the version and the provenance the viewer has to show', () => {
    const snapshot = build([issue(1)]);
    expect(snapshot.version).toBe(SNAPSHOT_VERSION);
    expect(snapshot.generatedAt).toBe('2026-09-19T12:00:00.000Z');
    expect(snapshot.source).toEqual({ repo: 'owner/name', ref: 'abc123' });
  });

  it('serialises identically whatever order the input arrives in', () => {
    // Determinism is asserted at the BYTE level, not as "is sorted": key insertion order is
    // part of the promise, and a sortedness check would not notice it changing. Every
    // collection in the fixture is shuffled between the two builds -- issues, labels and
    // blocked-by refs -- so dropping any one of the three sorts breaks this.
    const forward = build([
      issue(1, { labels: ['area:ui', 'size:s'], children: [{ number: 2, state: 'open' }] }),
      issue(2, { blockedBy: [{ number: 3, state: 'open' }, { number: 1, state: 'open' }] }),
      issue(3),
    ]);
    const shuffled = build([
      issue(3),
      issue(2, { blockedBy: [{ number: 1, state: 'open' }, { number: 3, state: 'open' }] }),
      issue(1, { labels: ['size:s', 'area:ui'], children: [{ number: 2, state: 'open' }] }),
    ]);

    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(forward));
    // The control that keeps the line above from passing on two empty objects.
    expect(forward.issues.map((entry) => entry.number)).toEqual([1, 2, 3]);
    expect(find(forward, 2).blockedBy.map((ref) => ref.number)).toEqual([1, 3]);
  });

  it('derives a parent from the other side of the edge and says which side it came from', () => {
    // `parentLoaded` is gated on the issue body declaring a parent, so a parent set only in
    // the sidebar reads as unknown on the child. #20 declares it, #21 does not, and #22 has
    // no claimant at all.
    const snapshot = build([
      issue(10, { children: [{ number: 20, state: 'open' }, { number: 21, state: 'open' }] }),
      issue(20, { parent: 10 }),
      issue(21),
      issue(22),
    ]);

    expect(find(snapshot, 20).parent).toBe(10);
    expect(find(snapshot, 20).parentSource).toBe('native');
    expect(find(snapshot, 21).parent).toBe(10);
    expect(find(snapshot, 21).parentSource).toBe('derived');
    expect(find(snapshot, 22).parent).toBe(null);
    expect(find(snapshot, 22).parentSource).toBe('unknown');
    // 4 issues in the snapshot; 2 of them -- #10, which is nobody's child, and #22, which
    // nothing claims -- have no parent from either side.
    expect(snapshot.counts.issues).toBe(4);
    expect(snapshot.counts.parentUnknown).toBe(2);
  });

  it('reports a blocked-by cycle the same way whichever issue GitHub returned first', () => {
    // `findDependencyCycles` walks its graph in input order, so this same cycle comes back
    // as [1, 2] or [2, 1] depending on the page order -- which would rewrite the committed
    // file for no reason. Both orders are asserted, so dropping the normalisation fails
    // here rather than in a diff nobody reads.
    const cyclic = [
      issue(1, { blockedBy: [{ number: 2, state: 'open' }] }),
      issue(2, { blockedBy: [{ number: 1, state: 'open' }] }),
    ];
    expect(build(cyclic).cycles).toEqual([[1, 2]]);
    expect(build([...cyclic].reverse()).cycles).toEqual([[1, 2]]);
  });

  it('leaves cycles empty for an ordinary chain', () => {
    // The control for the test above: the same edge without the return edge.
    const snapshot = build([
      issue(1, { blockedBy: [{ number: 2, state: 'open' }] }),
      issue(2),
      issue(30, { children: [{ number: 31, state: 'open' }] }),
      issue(31),
    ]);
    expect(snapshot.cycles).toEqual([]);
    expect(snapshot.counts.dependencyEdges).toBe(1);
    expect(snapshot.counts.parentEdges).toBe(1);
  });

  it('counts each way the graph is incomplete, against the issue population', () => {
    const snapshot = build([
      issue(1, { blockersLoaded: true, blockedBy: [{ number: 2, state: 'open' }], declaredBlockedBy: 3 }),
      issue(2, { loaded: false, blockersLoaded: false, declaredBlockedBy: 1, subIssues: { total: 2, completed: 0 } }),
      issue(3, { state: 'closed' }),
      issue(4, { blockedBy: [{ number: 99, state: 'closed' }] }),
    ]);

    // Population first: every fraction below is out of these four.
    expect(snapshot.counts.issues).toBe(4);
    expect(snapshot.counts.open).toBe(3);
    // #2 alone is genuinely unknown: GitHub says one blocker and two sub-issues, and neither
    // was read.
    expect(snapshot.counts.blockedByUnknown).toBe(1);
    expect(snapshot.counts.childrenUnknown).toBe(1);
    // The control that makes those two counts mean something. #3 carries the SAME
    // `blockedByLoaded: false` -- which is what an unblocked issue always looks like, since
    // the enrichment does not read blockers it has been told are absent -- and is excluded
    // because GitHub's count is zero. Counting the bare flag would report 2 here and bury
    // the one real hole.
    expect(find(snapshot, 3).blockedByLoaded).toBe(false);
    expect(find(snapshot, 3).declaredBlockedBy).toBe(0);
    // #1 read one blocker where GitHub counts three: the map drawn from it is missing edges,
    // and nothing else in the file would show that.
    expect(snapshot.counts.blockedByIncomplete).toBe(1);
    // #4's blocker #99 is not in the snapshot; the viewer has to draw it as a stub.
    expect(snapshot.counts.dependencyEdges).toBe(2);
    expect(snapshot.counts.edgesOutsideSnapshot).toBe(1);
  });

  it('drops pull requests from the issue list', () => {
    // `/issues` returns pull requests too, and `listOpenIssues` filters them; a snapshot
    // built from an unfiltered list would draw them as issues.
    const snapshot = build([issue(1), issue(2, { pull_request: { url: 'https://example.invalid' } })]);
    expect(snapshot.issues.map((entry) => entry.number)).toEqual([1]);
    expect(snapshot.counts.issues).toBe(1);
  });
});
