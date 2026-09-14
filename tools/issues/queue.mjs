/**
 * The Now queue's refill policy, as pure functions over the same REST-shaped issues the
 * audit reads (see metadata.mjs for the typedefs).
 *
 * `priority:now` is a bounded queue of executable work; `priority:next` is the pool triage
 * has approved for automation to refill it from. This module decides, from one snapshot of
 * open-issue state, which Now items keep their slot, which leave it, how many slots are
 * vacant, which Next issues may enter, in what order, and exactly which label writes make
 * that so. It never invents priority: ranking only chooses what ENTERS a vacancy, and a
 * valid Now item is never moved because something else now outranks it.
 *
 * Everything here is state-based and idempotent. Applying a plan's changes and planning
 * again yields no changes, which is what keeps the workflow's own label events (which
 * GitHub does not re-trigger from anyway) from ever mattering.
 *
 * @typedef {import('./metadata.mjs').GhIssue} GhIssue
 * @typedef {import('./metadata.mjs').AuditProblem} AuditProblem
 * @typedef {import('./metadata.mjs').QueueProblem} QueueProblem
 * @typedef {import('./metadata.mjs').LinkedPullRequest} LinkedPullRequest
 *
 * One label mutation. `labels` is the label set the plan was computed from, so the writer
 * can refuse to act on an issue that changed underneath it.
 * @typedef {{ issueNumber: number, kind: 'promote' | 'demote' | 'repair', add: string[], remove: string[], labels: string[] }} QueueChange
 *
 * The per-candidate ranking keys. `undefined` means "could not be determined"; the ranker
 * then skips that criterion for every candidate rather than guessing a value.
 * @typedef {{ release?: number, impact?: number, leverage?: number, risk?: number, size?: number, number: number }} RankingKeys
 * @typedef {'release' | 'impact' | 'leverage' | 'risk' | 'size'} RankingCriterion
 */

import {
  LABEL_DIMENSIONS,
  MAX_NOW_ISSUES,
  issueLabelNames,
  nowIneligibilityReasons,
  openLinkedPullRequests,
} from './metadata.mjs';

export const NOW_LABEL = 'priority:now';
export const NEXT_LABEL = 'priority:next';

// Public Prototype 1.0 relevance is read as membership in the milestone of this exact
// title. That is an interpretation (the release boundary is also described in prose under
// docs/superpowers/specs/), recorded here and in docs/agent/task-sizing.md; when no open
// issue carries the milestone the criterion is reported as undetermined rather than
// silently ranking everything as irrelevant.
export const RELEASE_MILESTONE = 'Public Prototype 1.0';

// The only Now-ineligibility reason automation acts on by itself. The others (lost
// agent-ready, wrong size, human-required, needs-split, a new native blocker) stay audit
// errors that hold their slot until a human resolves them: reconciliation runs on every
// label event, and a human who adds priority:now and then agent-ready in two clicks must
// not have the first event bounce the issue back to Next.
export const AUTOMATIC_DEMOTION_REASONS = Object.freeze(['in-flight']);

/** The order the ranking criteria apply in. Issue number is the always-present final key. */
const CRITERIA = /** @type {const} */ (['release', 'impact', 'leverage', 'risk', 'size']);

/** @param {GhIssue} issue @returns {number | null} */
const numberOf = (issue) => issue?.number ?? issue?.issue_number ?? null;

/** @param {unknown} value @returns {number} */
const nonNegativeCount = (value) =>
  Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;

/** @param {GhIssue} issue @returns {boolean} */
const carriesReleaseMilestone = (issue) => issue?.milestone?.title === RELEASE_MILESTONE;

/** @param {string[]} labels @returns {string[]} */
const priorityLabels = (labels) => labels.filter((label) => label.startsWith('priority:'));

/** @param {AuditProblem} problem @param {number} number @returns {boolean} */
const problemNames = (problem, number) => {
  if (problem.code === 'now-limit') return false;
  if (problem.issueNumber !== undefined && problem.issueNumber !== null) {
    return problem.issueNumber === number;
  }
  return Array.isArray(problem.issueNumbers) && problem.issueNumbers.includes(number);
};

/**
 * Why a Next issue may not enter Now automatically. Empty means it may. Every failing rule
 * is listed, in a stable order, so the report shows the whole distance to eligibility.
 *
 * "Leaf" is the one rule with a pending owner decision: an XS-M issue that has native
 * sub-issues is held back (`native-sub-issues`) because the repository's own ledger models
 * a parent as a decomposition, and promoting a parent that the owner regards as a tracker is
 * the costlier mistake. The hold is reported, never silent.
 *
 * @param {GhIssue} issue
 * @param {{ metadataErrors?: AuditProblem[] }} [context]
 * @returns {string[]}
 */
export function promotionIneligibilityReasons(issue, { metadataErrors = [] } = {}) {
  const labels = issueLabelNames(issue);
  const number = numberOf(issue);
  const reasons = [];
  if (!labels.includes(NEXT_LABEL)) reasons.push('not-next');
  if (labels.includes(NOW_LABEL)) reasons.push('already-now');
  reasons.push(...nowIneligibilityReasons(issue));
  if (nonNegativeCount(issue?.sub_issues_summary?.total) > 0) reasons.push('native-sub-issues');
  if (number !== null && metadataErrors.some((problem) => problemNames(problem, number))) {
    reasons.push('metadata-errors');
  }
  return reasons;
}

/** @param {GhIssue} issue @param {{ metadataErrors?: AuditProblem[] }} [context] @returns {boolean} */
export const isPromotionCandidate = (issue, context) =>
  promotionIneligibilityReasons(issue, context).length === 0;

/** @param {readonly string[]} allowed @param {string[]} labels @returns {number | undefined} */
const singleLabelIndex = (allowed, labels) => {
  const matches = allowed.filter((label) => labels.includes(label));
  return matches.length === 1 ? allowed.indexOf(matches[0]) : undefined;
};

/** @param {GhIssue} issue @returns {RankingKeys} */
export function rankingKeys(issue) {
  const labels = issueLabelNames(issue);
  const summary = issue?.issue_dependencies_summary;
  const risk = singleLabelIndex(LABEL_DIMENSIONS.risk, labels);
  return {
    release: carriesReleaseMilestone(issue) ? 0 : 1,
    impact: singleLabelIndex(LABEL_DIMENSIONS.impact, labels),
    // The list payload's `blocking` is GitHub's count of the OPEN issues this one blocks,
    // which is the leverage the owner asked for, with no extra read. A payload without the
    // summary (hand-built fixtures, `gh issue list` output) leaves it undetermined.
    leverage: summary !== null && typeof summary === 'object'
      ? -nonNegativeCount(summary.blocking)
      : undefined,
    // LABEL_DIMENSIONS.risk runs low -> high; higher risk ranks first.
    risk: risk === undefined ? undefined : LABEL_DIMENSIONS.risk.length - 1 - risk,
    size: singleLabelIndex(LABEL_DIMENSIONS.size, labels),
    number: numberOf(issue) ?? Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Deterministic ranking. A criterion that is undetermined for ANY candidate is skipped for
 * ALL of them: a per-pair fall-through would not be transitive and the order would then
 * depend on input order. `skip` names criteria the caller already knows are undetermined.
 *
 * @template {GhIssue} T
 * @param {T[]} candidates
 * @param {{ skip?: RankingCriterion[] }} [options]
 * @returns {{ ranked: T[], skippedCriteria: RankingCriterion[] }}
 */
export function rankPromotionCandidates(candidates, { skip = [] } = {}) {
  const keyed = candidates.map((issue) => ({ issue, keys: rankingKeys(issue) }));
  const skipped = new Set(skip);
  for (const criterion of CRITERIA) {
    if (keyed.some(({ keys }) => keys[criterion] === undefined)) skipped.add(criterion);
  }
  const active = CRITERIA.filter((criterion) => !skipped.has(criterion));

  const ranked = [...keyed].sort((a, b) => {
    for (const criterion of active) {
      const delta = /** @type {number} */ (a.keys[criterion]) - /** @type {number} */ (b.keys[criterion]);
      if (delta !== 0) return delta;
    }
    return a.keys.number - b.keys.number;
  });

  return {
    ranked: ranked.map(({ issue }) => issue),
    skippedCriteria: CRITERIA.filter((criterion) => skipped.has(criterion)),
  };
}

/**
 * One reconciliation, from one snapshot. Only open issues (never pull requests) count.
 *
 * @param {GhIssue[]} inputIssues
 * @param {{ maxNow?: number, metadataErrors?: AuditProblem[] }} [options]
 */
export function planQueueReconciliation(inputIssues, { maxNow = MAX_NOW_ISSUES, metadataErrors = [] } = {}) {
  const issues = (Array.isArray(inputIssues) ? inputIssues : [])
    .filter((issue) => issue?.state !== 'closed' && issue?.pull_request === undefined)
    .filter((issue) => numberOf(issue) !== null)
    .sort((a, b) => /** @type {number} */ (numberOf(a)) - /** @type {number} */ (numberOf(b)));

  /** @type {QueueChange[]} */
  const changes = [];
  /** @type {number[]} */
  const retained = [];
  /** @type {{ number: number, reasons: string[], pullRequests: LinkedPullRequest[] }[]} */
  const demoted = [];
  /** @type {{ number: number, reasons: string[] }[]} */
  const invalid = [];

  for (const issue of issues) {
    const labels = issueLabelNames(issue);
    if (!labels.includes(NOW_LABEL)) continue;
    const number = /** @type {number} */ (numberOf(issue));
    const reasons = nowIneligibilityReasons(issue);
    const others = priorityLabels(labels).filter((label) => label !== NOW_LABEL);

    if (reasons.some((reason) => AUTOMATIC_DEMOTION_REASONS.includes(reason))) {
      demoted.push({ number, reasons, pullRequests: openLinkedPullRequests(issue) });
      changes.push({
        issueNumber: number,
        kind: 'demote',
        add: others.length === 0 ? [NEXT_LABEL] : [],
        remove: [NOW_LABEL],
        labels,
      });
      continue;
    }

    retained.push(number);
    if (reasons.length > 0) invalid.push({ number, reasons });
    if (others.length > 0) {
      // A promotion writes priority:now before it removes priority:next; if that removal
      // failed, this finishes it. A human never puts two horizons on one issue on purpose
      // (the audit rejects it), so this completes automation's own write, not a choice.
      changes.push({ issueNumber: number, kind: 'repair', add: [], remove: others, labels });
    }
  }

  const vacancies = Math.max(0, maxNow - retained.length);
  const shaped = issues.filter((issue) => {
    const labels = issueLabelNames(issue);
    return labels.includes(NEXT_LABEL) && labels.includes('agent-ready');
  });
  /** @type {{ number: number, reasons: string[] }[]} */
  const excluded = [];
  /** @type {GhIssue[]} */
  const eligible = [];
  for (const issue of shaped) {
    const reasons = promotionIneligibilityReasons(issue, { metadataErrors });
    if (reasons.length === 0) eligible.push(issue);
    else excluded.push({ number: /** @type {number} */ (numberOf(issue)), reasons });
  }

  const releaseKnown = issues.some(carriesReleaseMilestone);
  const { ranked, skippedCriteria } = rankPromotionCandidates(eligible, {
    skip: releaseKnown ? [] : ['release'],
  });
  const candidates = ranked.map((issue) => ({
    number: /** @type {number} */ (numberOf(issue)),
    keys: rankingKeys(issue),
  }));
  const promoted = ranked.slice(0, vacancies);
  for (const issue of promoted) {
    changes.push({
      issueNumber: /** @type {number} */ (numberOf(issue)),
      kind: 'promote',
      add: [NOW_LABEL],
      remove: [NEXT_LABEL],
      labels: issueLabelNames(issue),
    });
  }

  const pullRequestsInspected = issues.length > 0
    && issues.every((issue) => issue?.linkedPullRequests?.loaded === true);
  /** @type {QueueProblem[]} */
  const warnings = [];
  if (promoted.length > 0) {
    const named = candidates.map((candidate) => `#${candidate.number}`).join(', ');
    warnings.push({
      issueNumbers: candidates.map((candidate) => candidate.number),
      code: 'now-below-capacity',
      message: `the Now queue holds ${retained.length}/${maxNow} while ${candidates.length} `
        + `automatic promotion candidate(s) exist: ${named}`
        + (pullRequestsInspected ? '' : ' (linked pull requests not inspected, so in-flight candidates could not be excluded)'),
      remediation: 'Run `npm run issues:reconcile` with a token, or promote by hand; the workflow does this on its next event.',
    });
  }

  return {
    maxNow,
    nowCount: retained.length + demoted.length,
    retained,
    demoted,
    invalid,
    vacancies,
    candidates,
    excluded,
    promoted: promoted.map((issue) => /** @type {number} */ (numberOf(issue))),
    skippedCriteria,
    changes,
    warnings,
    pullRequestsInspected,
  };
}

/** @typedef {ReturnType<typeof planQueueReconciliation>} QueuePlan */

/** @param {RankingKeys} keys @returns {string} */
const describeKeys = (keys) => {
  const parts = [];
  if (keys.release === 0) parts.push('release');
  if (keys.impact !== undefined) parts.push(LABEL_DIMENSIONS.impact[keys.impact]);
  if (keys.leverage !== undefined) parts.push(`unblocks ${-keys.leverage}`);
  if (keys.risk !== undefined) parts.push(LABEL_DIMENSIONS.risk[LABEL_DIMENSIONS.risk.length - 1 - keys.risk]);
  if (keys.size !== undefined) parts.push(LABEL_DIMENSIONS.size[keys.size]);
  return parts.join(', ');
};

/**
 * @param {QueuePlan} plan
 * @param {{ dryRun: boolean, applied?: number[], skipped?: { issueNumber: number, reason: string }[] }} outcome
 * @returns {string}
 */
export function renderQueuePlan(plan, { dryRun, applied = [], skipped = [] }) {
  const after = plan.retained.length + plan.promoted.length;
  const lines = [
    `# Now queue reconciliation${dryRun ? ' (dry run)' : ''}`,
    '',
    `Now queue: ${plan.retained.length}/${plan.maxNow} valid before, ${after}/${plan.maxNow} after; `
      + `${plan.vacancies} vacanc${plan.vacancies === 1 ? 'y' : 'ies'}, `
      + `${plan.candidates.length} eligible candidate(s).`,
    plan.pullRequestsInspected
      ? 'Linked pull requests: inspected.'
      : 'Linked pull requests: not inspected; in-flight work could not be detected.',
  ];
  if (plan.skippedCriteria.length > 0) {
    lines.push(`Ranking criteria undetermined and skipped: ${plan.skippedCriteria.join(', ')}.`);
  }
  lines.push('');

  if (plan.changes.length === 0) {
    lines.push('No label changes planned.', '');
  } else {
    if (!dryRun) {
      lines.push(
        `Applied ${applied.length} of ${plan.changes.length} planned label change(s); ${skipped.length} skipped.`,
        '',
      );
    }
    lines.push(`## Planned changes (${plan.changes.length})`, '');
    for (const change of plan.changes) {
      const skip = skipped.find((entry) => entry.issueNumber === change.issueNumber);
      if (skip !== undefined) {
        lines.push(`- #${change.issueNumber}: skipped — ${skip.reason}`);
        continue;
      }
      if (change.kind === 'demote') {
        const entry = plan.demoted.find((candidate) => candidate.number === change.issueNumber);
        const pulls = (entry?.pullRequests ?? [])
          .map((pull) => `PR #${pull.number}${pull.isDraft ? ' (draft)' : ''}`)
          .join(', ');
        const target = change.add.length > 0 ? ` to ${change.add.join(', ')}` : '';
        lines.push(`- #${change.issueNumber}: demote${target} — in flight through ${pulls}`);
      } else if (change.kind === 'promote') {
        const candidate = plan.candidates.find((entry) => entry.number === change.issueNumber);
        lines.push(`- #${change.issueNumber}: promote (${candidate === undefined ? '' : describeKeys(candidate.keys)})`);
      } else {
        lines.push(`- #${change.issueNumber}: remove stray ${change.remove.join(', ')}`);
      }
    }
    lines.push('');
  }

  if (plan.invalid.length > 0) {
    lines.push(`## Now items holding a slot the audit rejects (${plan.invalid.length})`, '');
    for (const entry of plan.invalid) lines.push(`- #${entry.number}: ${entry.reasons.join(', ')}`);
    lines.push('');
  }

  const waiting = plan.candidates.slice(plan.promoted.length);
  if (waiting.length > 0) {
    lines.push(`## Eligible candidates waiting for a vacancy (${waiting.length})`, '');
    for (const candidate of waiting) lines.push(`- #${candidate.number} (${describeKeys(candidate.keys)})`);
    lines.push('');
  }

  if (plan.excluded.length > 0) {
    lines.push(`## Next issues with agent-ready that cannot enter Now (${plan.excluded.length})`, '');
    for (const entry of plan.excluded) lines.push(`- #${entry.number}: ${entry.reasons.join(', ')}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
