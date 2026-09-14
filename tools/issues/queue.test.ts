import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_DEMOTION_REASONS,
  NEXT_LABEL,
  NOW_LABEL,
  RELEASE_MILESTONE,
  isPromotionCandidate,
  planQueueReconciliation,
  promotionIneligibilityReasons,
  rankPromotionCandidates,
  renderQueuePlan,
} from './queue.mjs';
import { auditOpenIssues } from './metadata.mjs';

// Every fixture here is a hand-built REST-shaped issue: the same loose shape the audit
// reads, with the two summaries the list payload carries (`issue_dependencies_summary`,
// `sub_issues_summary`) and the two enrichment fields the runner attaches
// (`nativeRelationships`, `linkedPullRequests`).
type Ref = { number: number; state: string };
type PullRef = { number: number; isDraft?: boolean };
type Options = {
  milestone?: string | null;
  blocking?: number;
  blockedBy?: Ref[];
  blockersLoaded?: boolean;
  subIssues?: number;
  pullRequests?: PullRef[] | null; // null = linkage not inspected
  summary?: boolean; // false = the payload carries no dependency summary at all
  state?: string;
  pull_request?: unknown;
};

const labelsFor = (priority: string, overrides: Record<string, string | null> = {}) => {
  const base: Record<string, string | null> = {
    size: 'size:s',
    risk: 'risk:low',
    area: 'area:repository',
    impact: 'impact:medium',
    priority,
    ready: 'agent-ready',
  };
  const merged = { ...base, ...overrides };
  return Object.values(merged).filter((label): label is string => label !== null);
};

const issue = (number: number, labels: string[], options: Options = {}) => {
  const blockedBy = options.blockedBy ?? [];
  const blocking = options.blocking ?? 0;
  // Uninspected linkage carries a STALE entry on purpose: the contract is that nothing
  // behind `loaded: false` is ever read, and an empty list could not prove that.
  const linkage = options.pullRequests === null
    ? { loaded: false, open: [{ number: 999, isDraft: false }] }
    : { loaded: true, open: options.pullRequests ?? [] };
  return {
    number,
    state: options.state ?? 'open',
    title: `Issue ${number}`,
    body: '## Dependencies\n\nNone',
    labels,
    milestone: options.milestone ? { number: 1, title: options.milestone } : null,
    ...(options.summary === false ? {} : {
      issue_dependencies_summary: {
        blocked_by: blockedBy.filter((ref) => ref.state !== 'closed').length,
        total_blocked_by: blockedBy.length,
        blocking,
        total_blocking: blocking,
      },
    }),
    sub_issues_summary: { total: options.subIssues ?? 0, completed: 0 },
    nativeRelationships: {
      loaded: true,
      parentLoaded: false,
      parent: null,
      blockersLoaded: options.blockersLoaded ?? true,
      blockedBy,
      subIssues: [],
    },
    linkedPullRequests: linkage,
    ...(options.pull_request === undefined ? {} : { pull_request: options.pull_request }),
  };
};

type Fixture = ReturnType<typeof issue>;
type Plan = ReturnType<typeof planQueueReconciliation>;

const nowIssue = (number: number, overrides: Record<string, string | null> = {}, options?: Options) =>
  issue(number, labelsFor(NOW_LABEL, overrides), options);
const nextIssue = (number: number, overrides: Record<string, string | null> = {}, options?: Options) =>
  issue(number, labelsFor(NEXT_LABEL, overrides), options);

const numbers = (plan: Plan) => ({
  retained: plan.retained,
  demoted: plan.demoted.map((entry) => entry.number),
  promoted: plan.promoted,
});

// Apply a plan's label changes to the fixtures the way GitHub would, so the next plan can
// be computed from the resulting state. This is the idempotence oracle.
const applyPlan = (issues: Fixture[], plan: Plan): Fixture[] =>
  issues.map((entry) => {
    const change = plan.changes.find((candidate) => candidate.issueNumber === entry.number);
    if (change === undefined) return entry;
    const labels = entry.labels.filter((label) => !change.remove.includes(label));
    for (const label of change.add) if (!labels.includes(label)) labels.push(label);
    return { ...entry, labels };
  });

const plan = (issues: Fixture[], options: { maxNow?: number } = {}) =>
  planQueueReconciliation(issues, {
    ...options,
    metadataErrors: auditOpenIssues(issues, options).errors,
  });

describe('promotion candidacy', () => {
  it('admits an agent-ready XS-M Next leaf with no blockers, no linked PR, and clean metadata', () => {
    expect(promotionIneligibilityReasons(nextIssue(1))).toEqual([]);
    expect(isPromotionCandidate(nextIssue(1))).toBe(true);
  });

  it('requires priority:next and refuses an issue that is already in Now', () => {
    expect(promotionIneligibilityReasons(issue(2, labelsFor('priority:later')))).toContain('not-next');
    expect(promotionIneligibilityReasons(issue(3, [...labelsFor(NEXT_LABEL), NOW_LABEL]))).toContain('already-now');
  });

  it('excludes a human-required candidate', () => {
    const reasons = promotionIneligibilityReasons(nextIssue(4, { human: 'human-required' }));
    expect(reasons).toEqual(['human-required']);
    // Negative control: the same labels without the marker are eligible.
    expect(promotionIneligibilityReasons(nextIssue(4))).toEqual([]);
  });

  it('excludes a needs-split candidate', () => {
    expect(promotionIneligibilityReasons(nextIssue(5, { split: 'needs-split' }))).toEqual(['needs-split']);
  });

  it('excludes a candidate that is not agent-ready', () => {
    expect(promotionIneligibilityReasons(nextIssue(6, { ready: null }))).toEqual(['not-agent-ready']);
  });

  it('excludes L and XL candidates and admits every XS-M size', () => {
    expect(promotionIneligibilityReasons(nextIssue(7, { size: 'size:l', split: 'needs-split' })))
      .toEqual(expect.arrayContaining(['size']));
    expect(promotionIneligibilityReasons(nextIssue(8, { size: 'size:xl' }))).toContain('size');
    for (const size of ['size:xs', 'size:s', 'size:m']) {
      expect(promotionIneligibilityReasons(nextIssue(9, { size })), size).toEqual([]);
    }
  });

  it('excludes a candidate with an open native blocker but not one whose blockers are all closed', () => {
    const blocked = nextIssue(10, {}, { blockedBy: [{ number: 1, state: 'open' }] });
    const cleared = nextIssue(11, {}, { blockedBy: [{ number: 1, state: 'closed' }] });
    expect(promotionIneligibilityReasons(blocked)).toEqual(['native-blocked']);
    expect(promotionIneligibilityReasons(cleared)).toEqual([]);
  });

  it('excludes a candidate that an open or draft pull request already implements', () => {
    const open = nextIssue(12, {}, { pullRequests: [{ number: 100, isDraft: false }] });
    const draft = nextIssue(13, {}, { pullRequests: [{ number: 101, isDraft: true }] });
    expect(promotionIneligibilityReasons(open)).toEqual(['in-flight']);
    expect(promotionIneligibilityReasons(draft)).toEqual(['in-flight']);
  });

  it('cannot call a candidate in flight when pull-request linkage was not inspected', () => {
    // Anonymous audits never load linkage; the reason must not fire from absence of data.
    expect(promotionIneligibilityReasons(nextIssue(14, {}, { pullRequests: null }))).toEqual([]);
  });

  it('holds back a candidate that has native sub-issues (leaf policy pending an owner decision)', () => {
    expect(promotionIneligibilityReasons(nextIssue(15, {}, { subIssues: 1 }))).toEqual(['native-sub-issues']);
    expect(promotionIneligibilityReasons(nextIssue(16, {}, { subIssues: 0 }))).toEqual([]);
  });

  it('excludes a candidate named by any metadata error except the queue-wide now-limit', () => {
    const candidate = nextIssue(17);
    const named = [{ issueNumber: 17, code: 'missing-risk', message: '', remediation: '' }];
    const grouped = [{ issueNumbers: [3, 17], code: 'native-dependency-cycle', message: '', remediation: '' }];
    const limit = [{ issueNumbers: [17], code: 'now-limit', message: '', remediation: '' }];
    const other = [{ issueNumber: 18, code: 'missing-risk', message: '', remediation: '' }];
    expect(promotionIneligibilityReasons(candidate, { metadataErrors: named })).toEqual(['metadata-errors']);
    expect(promotionIneligibilityReasons(candidate, { metadataErrors: grouped })).toEqual(['metadata-errors']);
    expect(promotionIneligibilityReasons(candidate, { metadataErrors: limit })).toEqual([]);
    expect(promotionIneligibilityReasons(candidate, { metadataErrors: other })).toEqual([]);
  });

  it('reports every failing rule at once so a triager sees the whole distance to eligibility', () => {
    const reasons = promotionIneligibilityReasons(nextIssue(19, {
      ready: null, human: 'human-required', split: 'needs-split', size: 'size:l',
    }, { blockedBy: [{ number: 1, state: 'open' }], pullRequests: [{ number: 5 }], subIssues: 2 }));
    expect(reasons).toEqual([
      'not-agent-ready', 'size', 'human-required', 'needs-split', 'native-blocked', 'in-flight',
      'native-sub-issues',
    ]);
  });
});

describe('candidate ranking', () => {
  // Every fixture below is supplied in the REVERSE of the expected order (or interleaved),
  // because Array.prototype.sort is stable: a fixture already in expected order would come
  // back unchanged even if the criterion under test were deleted.
  const ranked = (candidates: Fixture[]) => rankPromotionCandidates(candidates).ranked.map((c) => c.number);

  it('ranks Public Prototype 1.0 milestone work above everything else', () => {
    const plain = nextIssue(20, { impact: 'impact:high' });
    const release = nextIssue(21, { impact: 'impact:low' }, { milestone: RELEASE_MILESTONE });
    expect(ranked([plain, release])).toEqual([21, 20]);
  });

  it('does not treat any other milestone as release relevance', () => {
    const other = nextIssue(22, {}, { milestone: 'Full Game Development' });
    const release = nextIssue(23, {}, { milestone: RELEASE_MILESTONE });
    expect(ranked([other, release])).toEqual([23, 22]);
  });

  it('orders impact high, medium, low', () => {
    const low = nextIssue(24, { impact: 'impact:low' });
    const medium = nextIssue(25, { impact: 'impact:medium' });
    const high = nextIssue(26, { impact: 'impact:high' });
    expect(ranked([low, medium, high])).toEqual([26, 25, 24]);
  });

  it('prefers the candidate whose completion unblocks more open work', () => {
    const none = nextIssue(27, {}, { blocking: 0 });
    const some = nextIssue(28, {}, { blocking: 2 });
    const most = nextIssue(29, {}, { blocking: 5 });
    expect(ranked([none, some, most])).toEqual([29, 28, 27]);
  });

  it('breaks remaining ties with risk high, medium, low', () => {
    const low = nextIssue(30, { risk: 'risk:low' });
    const medium = nextIssue(31, { risk: 'risk:medium' });
    const high = nextIssue(32, { risk: 'risk:high' });
    expect(ranked([low, medium, high])).toEqual([32, 31, 30]);
  });

  it('then prefers smaller work: XS, S, M', () => {
    const m = nextIssue(33, { size: 'size:m' });
    const s = nextIssue(34, { size: 'size:s' });
    const xs = nextIssue(35, { size: 'size:xs' });
    expect(ranked([m, s, xs])).toEqual([35, 34, 33]);
  });

  it('falls back to the lowest issue number, independent of input order', () => {
    const [a, b, c] = [nextIssue(40), nextIssue(41), nextIssue(42)];
    expect(ranked([c, a, b])).toEqual([40, 41, 42]);
    expect(ranked([b, c, a])).toEqual([40, 41, 42]);
    expect(ranked([a, b, c])).toEqual([40, 41, 42]);
  });

  it('applies the criteria strictly in order: each one only separates candidates the earlier ones tied', () => {
    // 50 vs 51: release beats impact. 51 vs 52: impact beats leverage. 52 vs 53: leverage
    // beats risk. 53 vs 54: risk beats size. 54 vs 55: size beats number. Supplied reversed.
    const chain = [
      nextIssue(55, { size: 'size:m', risk: 'risk:low', impact: 'impact:low' }),
      nextIssue(54, { size: 'size:xs', risk: 'risk:low', impact: 'impact:low' }),
      nextIssue(53, { size: 'size:m', risk: 'risk:high', impact: 'impact:low' }),
      nextIssue(52, { size: 'size:m', risk: 'risk:low', impact: 'impact:low' }, { blocking: 3 }),
      nextIssue(51, { size: 'size:m', risk: 'risk:low', impact: 'impact:high' }),
      nextIssue(50, { size: 'size:m', risk: 'risk:low', impact: 'impact:low' }, { milestone: RELEASE_MILESTONE }),
    ];
    expect(ranked(chain)).toEqual([50, 51, 52, 53, 54, 55]);
  });

  it('skips a criterion for the whole ranking when it cannot be determined for every candidate', () => {
    // Leverage is read from the list payload's dependency summary; a payload without one
    // (hand-built fixtures, `gh issue list` output) makes leverage undeterminable. The owner
    // rule is to fall through, not guess, and the fall-through has to be global so the sort
    // stays a total order: 60 out-levers 61 but is supplied second, and with leverage
    // skipped the risk tie-break puts 61 first.
    const known = nextIssue(60, { risk: 'risk:low' }, { blocking: 4 });
    const unknown = nextIssue(61, { risk: 'risk:high' }, { summary: false });
    const result = rankPromotionCandidates([known, unknown]);
    expect(result.skippedCriteria).toEqual(['leverage']);
    expect(result.ranked.map((c) => c.number)).toEqual([61, 60]);
    // Negative control: with the summary present the leverage criterion decides.
    const determined = rankPromotionCandidates([known, nextIssue(61, { risk: 'risk:high' }, { blocking: 0 })]);
    expect(determined.skippedCriteria).toEqual([]);
    expect(determined.ranked.map((c) => c.number)).toEqual([60, 61]);
  });

  it('records the release criterion as undetermined when asked to skip it', () => {
    const result = rankPromotionCandidates([nextIssue(62), nextIssue(63)], { skip: ['release'] });
    expect(result.skippedCriteria).toEqual(['release']);
    expect(result.ranked.map((c) => c.number)).toEqual([62, 63]);
  });
});

describe('queue reconciliation planning', () => {
  it('fills an empty Now queue from eligible Next issues, in rank order', () => {
    const issues = [
      nextIssue(70, { impact: 'impact:low' }),
      nextIssue(71, { impact: 'impact:high' }),
      nextIssue(72, {}, { milestone: RELEASE_MILESTONE }),
    ];
    const result = plan(issues);
    expect(numbers(result)).toEqual({ retained: [], demoted: [], promoted: [72, 71, 70] });
    expect(result.vacancies).toBe(8);
    expect(result.changes).toEqual([
      { issueNumber: 72, kind: 'promote', add: [NOW_LABEL], remove: [NEXT_LABEL], labels: issues[2].labels },
      { issueNumber: 71, kind: 'promote', add: [NOW_LABEL], remove: [NEXT_LABEL], labels: issues[1].labels },
      { issueNumber: 70, kind: 'promote', add: [NOW_LABEL], remove: [NEXT_LABEL], labels: issues[0].labels },
    ]);
  });

  it('fills only the vacancies of a partially full queue, taking the best-ranked candidates', () => {
    const now = [80, 81, 82, 83, 84].map((number) => nowIssue(number));
    const next = [
      nextIssue(90, { impact: 'impact:low' }),
      nextIssue(91, { impact: 'impact:medium' }),
      nextIssue(92, { impact: 'impact:high' }),
      nextIssue(93, { impact: 'impact:high' }),
    ];
    const result = plan([...next, ...now]);
    expect(result.vacancies).toBe(3);
    expect(numbers(result)).toEqual({ retained: [80, 81, 82, 83, 84], demoted: [], promoted: [92, 93, 91] });
    expect(result.candidates.map((c) => c.number)).toEqual([92, 93, 91, 90]);
  });

  it('changes nothing when the queue is full, even if a candidate outranks every Now item', () => {
    const now = Array.from({ length: 8 }, (_, index) => nowIssue(100 + index, { impact: 'impact:low' }));
    const star = nextIssue(99, { impact: 'impact:high' }, { milestone: RELEASE_MILESTONE });
    const result = plan([star, ...now]);
    expect(result.vacancies).toBe(0);
    expect(result.changes).toEqual([]);
    expect(result.promoted).toEqual([]);
    expect(result.retained).toHaveLength(8);
  });

  it('never exceeds the Now maximum, whatever the candidate supply', () => {
    const now = [110, 111, 112, 113, 114, 115].map((number) => nowIssue(number));
    const next = Array.from({ length: 12 }, (_, index) => nextIssue(120 + index));
    const result = plan([...next, ...now]);
    expect(result.promoted).toHaveLength(2);
    expect(result.retained.length + result.promoted.length).toBe(8);
    // A smaller configured maximum is honoured the same way.
    const small = plan([...next, ...now], { maxNow: 6 });
    expect(small.promoted).toEqual([]);
    expect(small.vacancies).toBe(0);
  });

  it('leaves the queue below capacity when there are fewer valid candidates than vacancies', () => {
    const result = plan([nowIssue(130), nextIssue(131), nextIssue(132, { human: 'human-required' })]);
    expect(numbers(result)).toEqual({ retained: [130], demoted: [], promoted: [131] });
    expect(result.vacancies).toBe(7);
    expect(result.excluded).toEqual([{ number: 132, reasons: ['human-required'] }]);
  });

  it('promotes nothing into an over-full queue and never demotes a valid item to make room', () => {
    const now = Array.from({ length: 9 }, (_, index) => nowIssue(140 + index));
    const result = plan([nextIssue(139), ...now]);
    expect(result.retained).toHaveLength(9);
    expect(result.vacancies).toBe(0);
    expect(result.changes).toEqual([]);
  });

  it('demotes an in-flight Now issue to Next and refills its slot', () => {
    const inFlight = nowIssue(150, {}, { pullRequests: [{ number: 900, isDraft: true }] });
    const others = [151, 152, 153, 154, 155, 156, 157].map((number) => nowIssue(number));
    const candidate = nextIssue(158);
    const result = plan([candidate, inFlight, ...others]);
    expect(result.demoted).toEqual([{ number: 150, reasons: ['in-flight'], pullRequests: [{ number: 900, isDraft: true }] }]);
    expect(result.retained).toEqual([151, 152, 153, 154, 155, 156, 157]);
    expect(result.vacancies).toBe(1);
    expect(result.promoted).toEqual([158]);
    expect(result.changes).toEqual([
      { issueNumber: 150, kind: 'demote', add: [NEXT_LABEL], remove: [NOW_LABEL], labels: inFlight.labels },
      { issueNumber: 158, kind: 'promote', add: [NOW_LABEL], remove: [NEXT_LABEL], labels: candidate.labels },
    ]);
  });

  it('does not add priority:next to a demoted issue that already carries another priority label', () => {
    const doubled = issue(160, [...labelsFor(NOW_LABEL), 'priority:later'], { pullRequests: [{ number: 901 }] });
    const result = plan([doubled]);
    expect(result.changes).toEqual([
      { issueNumber: 160, kind: 'demote', add: [], remove: [NOW_LABEL], labels: doubled.labels },
    ]);
  });

  it('only demotes for the reasons automation owns; other invalid Now items hold their slot for a human', () => {
    // A human who adds priority:now and then agent-ready in two clicks must not have the
    // first event's reconciliation bounce the issue back to Next. Those states stay audit
    // errors (the audit still rejects them) and consume capacity until the human resolves them.
    expect(AUTOMATIC_DEMOTION_REASONS).toEqual(['in-flight']);
    const notReady = nowIssue(170, { ready: null });
    const blocked = nowIssue(171, {}, { blockedBy: [{ number: 1, state: 'open' }] });
    const human = nowIssue(172, { human: 'human-required' });
    const split = nowIssue(173, { split: 'needs-split' });
    const large = nowIssue(174, { size: 'size:l', split: 'needs-split' });
    const valid = [175, 176, 177].map((number) => nowIssue(number));
    const result = plan([nextIssue(178), notReady, blocked, human, split, large, ...valid]);
    expect(result.demoted).toEqual([]);
    expect(result.retained).toEqual([170, 171, 172, 173, 174, 175, 176, 177]);
    expect(result.invalid).toEqual([
      { number: 170, reasons: ['not-agent-ready'] },
      { number: 171, reasons: ['native-blocked'] },
      { number: 172, reasons: ['human-required'] },
      { number: 173, reasons: ['needs-split'] },
      { number: 174, reasons: ['size', 'needs-split'] },
    ]);
    expect(result.vacancies).toBe(0);
    expect(result.changes).toEqual([]);
  });

  it('finishes its own half-applied writes: a retained Now item sheds a stray priority label', () => {
    // Promotion writes priority:now before it removes priority:next; if the removal fails the
    // issue carries both. The next reconciliation must converge rather than report the
    // duplicate forever.
    const halfPromoted = issue(180, [...labelsFor(NOW_LABEL), NEXT_LABEL]);
    const result = plan([halfPromoted]);
    expect(result.retained).toEqual([180]);
    expect(result.changes).toEqual([
      { issueNumber: 180, kind: 'repair', add: [], remove: [NEXT_LABEL], labels: halfPromoted.labels },
    ]);
    // Negative control: a single-label Now item gets no repair.
    expect(plan([nowIssue(181)]).changes).toEqual([]);
  });

  it('ignores closed issues and pull requests in the input', () => {
    const result = plan([
      nowIssue(190, {}, { state: 'closed' }),
      nextIssue(191, {}, { pull_request: { url: 'https://example.test/pull/191' } }),
      nextIssue(192),
    ]);
    expect(numbers(result)).toEqual({ retained: [], demoted: [], promoted: [192] });
  });

  it('keeps a candidate out when the audit reports a metadata error on it', () => {
    const missingRisk = nextIssue(200, { risk: null });
    const result = plan([missingRisk, nextIssue(201)]);
    expect(result.promoted).toEqual([201]);
    expect(result.excluded).toEqual([{ number: 200, reasons: ['metadata-errors'] }]);
  });

  it('is idempotent: applying its changes and planning again yields no further changes', () => {
    const issues = [
      nowIssue(210, {}, { pullRequests: [{ number: 910 }] }),
      issue(211, [...labelsFor(NOW_LABEL), NEXT_LABEL]),
      nowIssue(212),
      nextIssue(213, {}, { milestone: RELEASE_MILESTONE }),
      nextIssue(214),
      nextIssue(215, { human: 'human-required' }),
    ];
    const first = plan(issues);
    expect(first.changes.map((change) => change.kind)).toEqual(['demote', 'repair', 'promote', 'promote']);
    const settled = applyPlan(issues, first);
    const second = plan(settled);
    expect(second.changes).toEqual([]);
    expect(numbers(second)).toEqual({ retained: [211, 212, 213, 214], demoted: [], promoted: [] });
  });

  it('reaches its fixed point in one step, so its own label events cannot drive a further round', () => {
    // GitHub never starts a workflow from an event the workflow token caused; this is the
    // planner-side half of that guarantee. Any state the planner produces is a state it
    // leaves alone, across several rounds.
    let issues = [
      nowIssue(220, {}, { pullRequests: [{ number: 920 }] }),
      ...Array.from({ length: 9 }, (_, index) => nextIssue(221 + index)),
    ];
    const rounds: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      const result = plan(issues);
      rounds.push(result.changes.length);
      issues = applyPlan(issues, result);
    }
    expect(rounds).toEqual([9, 0, 0, 0]);
  });

  it('does not reorder or demote valid Now items merely because a newer candidate ranks higher', () => {
    const now = [230, 231, 232, 233, 234, 235, 236].map((number) => nowIssue(number, { impact: 'impact:low' }));
    const newcomer = nextIssue(229, { impact: 'impact:high' }, { milestone: RELEASE_MILESTONE });
    const result = plan([newcomer, ...now]);
    expect(result.retained).toEqual([230, 231, 232, 233, 234, 235, 236]);
    expect(result.demoted).toEqual([]);
    expect(result.promoted).toEqual([229]);
    expect(result.changes).toHaveLength(1);
  });

  it('warns when Now is below capacity while valid candidates exist, naming them', () => {
    const result = plan([nowIssue(240), nextIssue(241), nextIssue(242)]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: 'now-below-capacity', issueNumbers: [241, 242] });
    expect(result.warnings[0].message).toContain('1/8');
    expect(result.warnings[0].message).toContain('#241, #242');
    expect(result.warnings[0].message).not.toContain('not inspected');
  });

  it('emits no capacity warning when the queue is full or no valid candidate exists', () => {
    const full = plan(Array.from({ length: 8 }, (_, index) => nowIssue(250 + index)));
    expect(full.warnings).toEqual([]);
    const empty = plan([nowIssue(260), nextIssue(261, { human: 'human-required' })]);
    expect(empty.warnings).toEqual([]);
  });

  it('says so when the capacity warning could not exclude in-flight candidates', () => {
    const result = plan([nowIssue(270, {}, { pullRequests: null }), nextIssue(271, {}, { pullRequests: null })]);
    expect(result.pullRequestsInspected).toBe(false);
    expect(result.warnings[0].message).toContain('linked pull requests not inspected');
  });

  it('marks the release criterion undetermined when no open issue carries the milestone', () => {
    const result = plan([nextIssue(280), nextIssue(281)]);
    expect(result.skippedCriteria).toEqual(['release']);
    const known = plan([nextIssue(280), nextIssue(281, {}, { milestone: RELEASE_MILESTONE })]);
    expect(known.skippedCriteria).toEqual([]);
  });
});

describe('queue plan rendering', () => {
  const state = [
    nowIssue(300, {}, { pullRequests: [{ number: 930, isDraft: true }] }),
    nowIssue(301, { ready: null }),
    nextIssue(302, {}, { milestone: RELEASE_MILESTONE, blocking: 2 }),
    nextIssue(303, { human: 'human-required' }),
  ];

  it('renders the planned demotions, promotions, holds, and exclusions with their reasons', () => {
    const report = renderQueuePlan(plan(state), { dryRun: true });
    expect(report).toContain('# Now queue reconciliation (dry run)');
    expect(report).toContain('Now queue: 1/8 valid before, 2/8 after');
    expect(report).toContain('- #300: demote to priority:next — in flight through PR #930 (draft)');
    expect(report).toContain('- #302: promote (release, impact:medium, unblocks 2, risk:low, size:s)');
    expect(report).toContain('- #301: not-agent-ready');
    expect(report).toContain('- #303: human-required');
    expect(report).toContain('Linked pull requests: inspected');
  });

  it('distinguishes applied from skipped writes when the plan was executed', () => {
    const report = renderQueuePlan(plan(state), {
      dryRun: false,
      applied: [302],
      skipped: [{ issueNumber: 300, reason: 'labels changed since the plan was computed' }],
    });
    expect(report).toContain('# Now queue reconciliation');
    expect(report).not.toContain('(dry run)');
    expect(report).toContain('Applied 1 of 2 planned label change(s); 1 skipped.');
    expect(report).toContain('- #300: skipped — labels changed since the plan was computed');
  });

  it('reports a settled queue as no changes', () => {
    const report = renderQueuePlan(plan([nowIssue(310)]), { dryRun: false, applied: [], skipped: [] });
    expect(report).toContain('No label changes planned.');
  });
});
