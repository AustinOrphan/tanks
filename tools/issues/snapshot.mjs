/**
 * The versioned issue-graph snapshot (issue #437, first leaf).
 *
 * #437 wants a tokenless dependency map: a token'd job exports a sanitized static snapshot,
 * and the published client reads only that. This is the shaping half. Nothing here talks to
 * GitHub -- it is a pure function over the SAME `GhIssue` records `listOpenIssues` +
 * `enrichOpenIssueRelationships` already produce, which is what keeps #437's "do not add a
 * second relationship parser" true: native parents, sub-issues and blocked-by arrive in
 * `issue.nativeRelationships`, and this only reshapes them. The CLI and workflow that write
 * the file are deliberately a separate change; this one is testable without a network.
 *
 * FOUR PROPERTIES THE VIEWER DEPENDS ON, and why each is decided here rather than in the
 * client:
 *
 * 1. UNKNOWN IS NOT NONE. `metadata.mjs` states the rule for `linkedPullRequests`, and the
 *    same applies to relationships: an edge that was never read is unknown, never absent. A
 *    snapshot that emitted `blockedBy: []` for an unread issue would tell a maintainer the
 *    work is unblocked and ready, which is the most damaging thing this view could get
 *    wrong.
 *
 *    The flag alone does not say that, though, and the distinction cost a rewrite of these
 *    counts: `enrichOpenIssueRelationships` only reads blockers when GitHub's count is above
 *    zero or the issue is `agent-ready`/`priority:now`, so `blockedByLoaded: false` is the
 *    ORDINARY state of an unblocked issue, not a hole. What separates the two is the count
 *    GitHub ships in every list payload. `declaredBlockedBy` is authoritative for WHETHER an
 *    issue is blocked; the edge list only says BY WHAT. Unknown is the pair
 *    `declaredBlockedBy > 0 && !blockedByLoaded`, and that -- not the bare flag -- is what
 *    `counts.blockedByUnknown` reports.
 * 2. DETERMINISTIC TO THE BYTE. Every collection is sorted and every object is built in a
 *    fixed key order, so re-exporting an unchanged graph produces an identical file. Without
 *    that, a scheduled job's diff is noise and nobody can tell a real change from a
 *    reordering.
 * 3. CYCLES ARE REPORTED, NOT LAID OUT. #437 is explicit: detect and report rather than
 *    silently drawing an invalid DAG. `cycles` is part of the snapshot, so a client cannot
 *    skip the check by forgetting to run one. The detector is `metadata.mjs`'s own
 *    `findDependencyCycles` -- the one the audit reports `native-dependency-cycle` from --
 *    because two cycle notions in one directory is the same failure as two relationship
 *    parsers, and a map that disagreed with the audit would be worse than one that never
 *    looked. Only the node order is this file's business; see `normaliseCycles`.
 * 4. NO `blocking` SIDE. The typedef declares `nativeRelationships.blocking`, but NOTHING in
 *    this repository populates it -- `enrichOpenIssueRelationships` sets `parent`,
 *    `blockedBy` and `subIssues` only. Emitting it would ship a field that is permanently
 *    empty and a test that can only pass against a hand-built fixture. The reverse direction
 *    is derived from `blockedBy` instead, and `declaredBlocking` reports GitHub's count of
 *    what this issue blocks, which is real data present in every list payload.
 */

import { findDependencyCycles } from './metadata.mjs';

/**
 * @typedef {import('./metadata.mjs').GhIssue} GhIssue
 * @typedef {[number, number]} CycleEdge
 * @typedef {{ number: number, state: string | null }} SnapshotRef
 * @typedef {'native' | 'derived' | 'unknown'} ParentSource
 * @typedef {{
 *   number: number, title: string, url: string, state: string,
 *   labels: string[], milestone: string | null, assignees: number,
 *   parent: number | null, parentSource: ParentSource,
 *   children: SnapshotRef[], childrenLoaded: boolean,
 *   subIssueProgress: { total: number, completed: number },
 *   blockedBy: SnapshotRef[], blockedByLoaded: boolean,
 *   declaredBlockedBy: number, declaredBlocking: number,
 * }} SnapshotIssue
 */

/** Bumped when the shape changes in a way a client has to notice. */
export const SNAPSHOT_VERSION = 1;

/** @param {unknown} value @returns {number | null} */
const num = (value) => (Number.isInteger(value) ? Number(value) : null);

/** @param {unknown} value @returns {number} */
const count = (value) => (Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0);

/** @param {unknown} refs @returns {SnapshotRef[]} */
function refsOf(refs) {
  if (!Array.isArray(refs)) return [];
  /** @type {SnapshotRef[]} */
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    const number = num(ref?.number);
    if (number === null || seen.has(number)) continue;
    seen.add(number);
    out.push({ number, state: typeof ref?.state === 'string' ? ref.state : null });
  }
  return out.sort((a, b) => a.number - b.number);
}

/**
 * One issue, reduced to the fields the map draws. Deliberately NOT the whole REST record:
 * the snapshot is published publicly, so it carries what the view needs and nothing else.
 * `assignees` is a COUNT rather than logins -- the view only distinguishes "someone is on
 * this" from "nobody is", and names would put people in a static public file for no gain.
 *
 * `childrenLoaded` is `loaded`, not a flag of its own, and that needs saying: the enrichment
 * inspects sub-issues only when `sub_issues_summary.total > 0`, so within an enriched issue
 * an empty `subIssues` means genuinely childless rather than unread. An issue the enrichment
 * skipped entirely (the `reconcile` path marks those `loaded: false`) is the unread case,
 * and there too the summary says whether anything was missed.
 *
 * @param {GhIssue} issue @param {(issue: GhIssue) => string[]} labelsOf @returns {SnapshotIssue}
 */
export function snapshotIssue(issue, labelsOf) {
  const relationships = issue?.nativeRelationships ?? {};
  const dependencies = issue?.issue_dependencies_summary ?? {};
  const subIssues = issue?.sub_issues_summary;
  const nativeParent = num(relationships.parent?.number);
  return {
    number: num(issue?.number) ?? num(issue?.issue_number) ?? 0,
    title: typeof issue?.title === 'string' ? issue.title : '',
    url: typeof issue?.html_url === 'string' ? issue.html_url : '',
    state: typeof issue?.state === 'string' ? issue.state : 'open',
    labels: [...labelsOf(issue)].sort(),
    milestone: typeof issue?.milestone?.title === 'string' ? issue.milestone.title : null,
    assignees: Array.isArray(issue?.assignees) ? issue.assignees.length : 0,
    // `parentLoaded` is gated on the issue BODY declaring a parent, so a native parent set
    // through the sidebar alone reads as unknown here. `buildSnapshot` recovers those from
    // the other side of the edge; see `deriveParents`.
    parent: relationships.parentLoaded === true ? nativeParent : null,
    parentSource: relationships.parentLoaded === true && nativeParent !== null ? 'native' : 'unknown',
    children: refsOf(relationships.subIssues),
    childrenLoaded: relationships.loaded === true,
    // Always an object, never null: "the payload had no summary" and "the summary said
    // zero" mean the same thing to every reader, and `childrenLoaded` already carries the
    // read-versus-unread axis. A second way to say nothing would only invite a client to
    // branch on it.
    subIssueProgress: { total: count(subIssues?.total), completed: count(subIssues?.completed) },
    blockedBy: refsOf(relationships.blockedBy),
    blockedByLoaded: relationships.blockersLoaded === true,
    // GitHub's own counts, present in every list payload even when no edge was read. They
    // are what makes "unread" legible rather than merely blank: `declaredBlockedBy > 0` with
    // `blockedByLoaded: false` is "blocked by something we did not look up", and a read list
    // shorter than the count means edges went missing. `queue.mjs` reads the same fields.
    declaredBlockedBy: Math.max(count(dependencies.blocked_by), count(dependencies.total_blocked_by)),
    declaredBlocking: Math.max(count(dependencies.blocking), count(dependencies.total_blocking)),
  };
}

/**
 * Fill `parent` for issues whose parent was never read, from the children the OTHER side
 * declared, and mark them `derived` so a reader can tell the two apart.
 *
 * Mutating the two fields in place rather than rebuilding the record is deliberate: both
 * keys already exist, so insertion order -- and therefore the serialized byte order that
 * property 2 promises -- is unchanged.
 *
 * @param {SnapshotIssue[]} issues
 */
function deriveParents(issues) {
  /** @type {Map<number, number>} */
  const parentOf = new Map();
  for (const issue of issues) {
    for (const child of issue.children) {
      // A child claimed by two parents is a data error GitHub should prevent. Keep the
      // lowest-numbered claimant so the output stays deterministic, and let the parent-kind
      // cycle check report anything genuinely malformed.
      const existing = parentOf.get(child.number);
      if (existing === undefined || issue.number < existing) parentOf.set(child.number, issue.number);
    }
  }
  for (const issue of issues) {
    if (issue.parentSource !== 'unknown') continue;
    const derived = parentOf.get(issue.number);
    if (derived === undefined) continue;
    issue.parent = derived;
    issue.parentSource = 'derived';
  }
}

/**
 * The audit's cycles, made safe to commit.
 *
 * `findDependencyCycles` is `metadata.mjs`'s, not a second detector: #437 says not to add a
 * parallel relationship parser, and a published map that disagreed with the audit about
 * whether a cycle exists would be worse than one that never checked. What it does not
 * promise is a stable node ORDER -- it walks `graph.keys()`, which is the order the issues
 * arrived in, so the same cycle comes back as [1, 2] or [2, 1] depending on the page GitHub
 * returned first. Invisible in an audit line; a spurious diff in a committed file every time
 * it flips. Rotating each cycle to start at its lowest member, and sorting the list, is what
 * makes property 2 hold for this field too.
 *
 * @param {number[][]} cycles @returns {number[][]}
 */
export function normaliseCycles(cycles) {
  return cycles
    .map((cycle) => {
      const rotation = cycle.indexOf(Math.min(...cycle));
      return [...cycle.slice(rotation), ...cycle.slice(0, rotation)];
    })
    .sort((a, b) => a[0] - b[0] || a.length - b.length);
}

/**
 * The published snapshot.
 *
 * `generatedAt` and `source` are arguments rather than read here, so this stays pure and a
 * test can assert identical output for identical input. #437 requires both to be recorded
 * AND shown in the UI: a stale snapshot that looks live is worse than an obviously old one.
 *
 * @param {GhIssue[]} issues
 * @param {{
 *   repo: string,
 *   ref?: string | null,
 *   generatedAt: string,
 *   labelsOf: (issue: GhIssue) => string[],
 * }} context
 */
export function buildSnapshot(issues, { repo, ref = null, generatedAt, labelsOf }) {
  // `/issues` returns pull requests too. `listOpenIssues` already drops them, but the
  // detector below reads this same list, so the filter has to happen before either use.
  const usable = (Array.isArray(issues) ? issues : [])
    .filter((issue) => issue?.pull_request === undefined);
  const shaped = usable
    .map((issue) => snapshotIssue(issue, labelsOf))
    .filter((issue) => issue.number > 0)
    .sort((a, b) => a.number - b.number);
  deriveParents(shaped);

  // `[blocker, issue]` and `[parent, child]`, the direction `assertAcyclic` uses in
  // `migrate-relationships.mjs`. These are for the counts below and for the viewer's layout;
  // the cycle check runs on the raw issues, through the audit's own detector.
  /** @type {CycleEdge[]} */
  const dependencyEdges = [];
  /** @type {CycleEdge[]} */
  const parentEdges = [];
  for (const issue of shaped) {
    for (const blocker of issue.blockedBy) dependencyEdges.push([blocker.number, issue.number]);
    for (const child of issue.children) parentEdges.push([issue.number, child.number]);
  }

  const present = new Set(shaped.map((issue) => issue.number));
  return {
    version: SNAPSHOT_VERSION,
    generatedAt,
    source: { repo, ref },
    counts: {
      // Every other count's denominator. A reader who sees "3 unread" without this cannot
      // tell a nearly-complete snapshot from a nearly-empty one.
      issues: shaped.length,
      open: shaped.filter((issue) => issue.state === 'open').length,
      dependencyEdges: dependencyEdges.length,
      parentEdges: parentEdges.length,
      // The populations behind every "unblocked" or "root" claim the view can make. Both
      // relationship counts pair the loaded flag with GitHub's own summary, for the reason
      // property 1 gives: an unread flag on an issue GitHub says has nothing to read is not
      // a hole, and counting it as one would bury the real ones.
      blockedByUnknown: shaped.filter(
        (issue) => !issue.blockedByLoaded && issue.declaredBlockedBy > 0,
      ).length,
      childrenUnknown: shaped.filter(
        (issue) => !issue.childrenLoaded && issue.subIssueProgress.total > 0,
      ).length,
      parentUnknown: shaped.filter((issue) => issue.parentSource === 'unknown').length,
      // Read the list, and it was shorter than GitHub's own count: edges are missing, and a
      // map drawn from this one is incomplete in a way only this number shows.
      blockedByIncomplete: shaped.filter(
        (issue) => issue.blockedByLoaded && issue.blockedBy.length < issue.declaredBlockedBy,
      ).length,
      // Edges whose far end is not in this snapshot -- closed, transferred, or simply not
      // listed. The view has to draw these as stubs rather than dropping them.
      edgesOutsideSnapshot: [...dependencyEdges, ...parentEdges]
        .filter(([from, to]) => !present.has(from) || !present.has(to)).length,
    },
    cycles: normaliseCycles(findDependencyCycles(usable)),
    issues: shaped,
  };
}

/**
 * The line a maintainer reads instead of the file.
 *
 * Every figure carries its denominator, because the three "unknown" counts are the ones that
 * decide whether the map can be trusted at all, and "3 unknown" against 71 issues and against
 * 4 issues are different reports. The counts are printed even when they are zero: a missing
 * row reads as "not measured", which is the one thing this summary must never imply.
 *
 * @param {ReturnType<typeof buildSnapshot>} snapshot @param {string} path @returns {string}
 */
export function renderSnapshotSummary(snapshot, path) {
  const { counts } = snapshot;
  /** @param {number} value */
  const of = (value) => `${value} of ${counts.issues}`;
  return [
    `## Issue graph snapshot v${snapshot.version}`,
    '',
    `Wrote \`${path}\` for \`${snapshot.source.repo}\`${snapshot.source.ref === null ? '' : ` at \`${snapshot.source.ref}\``}, generated ${snapshot.generatedAt}.`,
    '',
    `- **${counts.issues} issues**, ${counts.open} open`,
    `- ${counts.dependencyEdges} blocked-by edge(s), ${counts.parentEdges} parent edge(s)`,
    `- ${of(counts.blockedByUnknown)} blocked by something the run did not read`,
    `- ${of(counts.childrenUnknown)} with sub-issues the run did not read`,
    `- ${of(counts.parentUnknown)} with no parent from either side`,
    `- ${of(counts.blockedByIncomplete)} read fewer blockers than GitHub counted`,
    `- ${counts.edgesOutsideSnapshot} edge(s) point outside the snapshot`,
    `- ${snapshot.cycles.length} cycle(s)${snapshot.cycles.length === 0 ? '' : `: ${snapshot.cycles.map((cycle) => cycle.map((number) => `#${number}`).join(' → ')).join('; ')}`}`,
    '',
  ].join('\n');
}
