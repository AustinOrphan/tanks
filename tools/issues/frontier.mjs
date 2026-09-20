/**
 * The executable frontier, read off a snapshot (issue #437).
 *
 * #437's default view has to answer one question -- "what can move Public Prototype 1.0
 * forward?" -- and three of its acceptance criteria are that question's parts: highlight the
 * frontier of open, unblocked, ready leaves; show WHY a node is blocked; show what closing it
 * would unlock. All three are logic over the snapshot, not drawing, so they live here and are
 * testable without a browser, a token or a layout engine.
 *
 * `snapshot.mjs` shapes; this decides. Nothing here talks to GitHub and nothing here re-reads
 * a relationship -- #437 forbids a second parser, and a second FRONTIER definition would be
 * the same mistake one level up, since the view and any queue tooling must agree about what
 * "ready" means.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE:
 *
 * 1. UNKNOWN IS NEVER READY. A snapshot carries `blockedByLoaded` and `declaredBlockedBy`
 *    precisely because an unread blocker list is not an empty one. An issue GitHub says has
 *    blockers, whose blocker list was never fetched, is `unknown` here -- never `ready`. That
 *    is the one error this whole view could make that would actively waste a maintainer's
 *    day, and `frontierOf` returns it as its own bucket rather than folding it either way.
 * 2. NOT "CRITICAL PATH". #437 is explicit: with no duration estimates, calling the longest
 *    dependency chain a critical path implies scheduling that does not exist. The function
 *    below is `longestDependencyChain` and says so in its own name.
 */

/**
 * @typedef {import('./snapshot.mjs').SnapshotIssue} SnapshotIssue
 * @typedef {{ version: number, generatedAt: string, source: { repo: string, ref: string | null },
 *   counts: Record<string, number>, cycles: number[][], issues: SnapshotIssue[] }} Snapshot
 * @typedef {'ready' | 'blocked' | 'unknown' | 'closed'} Readiness
 */

/** @param {readonly SnapshotIssue[]} issues @returns {Map<number, SnapshotIssue>} */
const indexOf = (issues) => new Map(issues.map((issue) => [issue.number, issue]));

/**
 * Blockers that still stand, and the ones the snapshot cannot speak for.
 *
 * A blocker is only cleared by being CLOSED. A blocker absent from the snapshot is not
 * cleared by its absence -- the producer lists open issues, so a missing target is usually a
 * closed issue, but "usually" is not a basis for telling someone their work is ready. The
 * ref's own `state` is what decides, and a ref with no state at all lands in `unknown`.
 *
 * @param {SnapshotIssue} issue @param {Map<number, SnapshotIssue>} index
 * @returns {{ open: number[], unknown: number[] }}
 */
export function standingBlockers(issue, index) {
  /** @type {number[]} */
  const open = [];
  /** @type {number[]} */
  const unknown = [];
  for (const ref of issue?.blockedBy ?? []) {
    const known = index.get(ref.number);
    const state = known?.state ?? ref.state;
    if (state === 'closed') continue;
    if (state === 'open') open.push(ref.number);
    else unknown.push(ref.number);
  }
  // GitHub's own count outranks a short list. `blockedByIncomplete` in the snapshot counts
  // exactly this case, and here it has to change the VERDICT, not just a statistic: an issue
  // whose read list is shorter than the count has blockers nobody has seen.
  const declared = issue?.declaredBlockedBy ?? 0;
  const seen = (issue?.blockedBy ?? []).length;
  const unread = issue?.blockedByLoaded === false ? declared : Math.max(0, declared - seen);
  for (let i = 0; i < unread; i++) unknown.push(-1);
  return { open: open.sort((a, b) => a - b), unknown };
}

/**
 * One issue's readiness, and why.
 *
 * `reason` is written for a human reading the view, which is the acceptance criterion
 * ("show why a node is blocked"), so it names the blockers rather than counting them.
 *
 * @param {SnapshotIssue} issue @param {Map<number, SnapshotIssue>} index
 * @returns {{ readiness: Readiness, openBlockers: number[], unknownBlockers: number, reason: string }}
 */
export function readinessOf(issue, index) {
  if (issue?.state === 'closed') {
    return { readiness: 'closed', openBlockers: [], unknownBlockers: 0, reason: 'closed' };
  }
  const { open, unknown } = standingBlockers(issue, index);
  if (open.length > 0) {
    return {
      readiness: 'blocked',
      openBlockers: open,
      unknownBlockers: unknown.length,
      reason: `blocked by ${open.map((n) => `#${n}`).join(', ')}`,
    };
  }
  if (unknown.length > 0) {
    return {
      readiness: 'unknown',
      openBlockers: [],
      unknownBlockers: unknown.length,
      // Deliberately not "ready". See rule 1 in the module comment.
      reason: `${unknown.length} blocker(s) this snapshot did not read`,
    };
  }
  return { readiness: 'ready', openBlockers: [], unknownBlockers: 0, reason: 'no standing blockers' };
}

/**
 * What closing `number` would unlock: every open issue whose ONLY standing blocker is this
 * one, plus the wider set it blocks at any depth.
 *
 * `immediate` is the honest headline. "Closing this unblocks 12 issues" is the claim a view
 * makes and a maintainer acts on, and it is false if those 12 are each blocked by three other
 * things too -- so `immediate` counts only the ones that become ready, and `downstream` is
 * reported separately as reach rather than as release.
 *
 * @param {Snapshot} snapshot @param {number} number
 * @returns {{ immediate: number[], downstream: number[] }}
 */
export function unlockedByClosing(snapshot, number) {
  const index = indexOf(snapshot?.issues ?? []);
  /** @type {Map<number, number[]>} */
  const blocks = new Map();
  for (const issue of snapshot?.issues ?? []) {
    for (const blocker of issue.blockedBy ?? []) {
      if (!blocks.has(blocker.number)) blocks.set(blocker.number, []);
      /** @type {number[]} */ (blocks.get(blocker.number)).push(issue.number);
    }
  }

  const immediate = (blocks.get(number) ?? []).filter((n) => {
    const issue = index.get(n);
    if (issue === undefined || issue.state === 'closed') return false;
    const { open, unknown } = standingBlockers(issue, index);
    return unknown.length === 0 && open.length === 1 && open[0] === number;
  }).sort((a, b) => a - b);

  // Reach, not release: everything downstream at any depth. Iterative, and guarded against
  // the cycles the snapshot reports rather than assuming a DAG.
  const downstream = new Set();
  const stack = [number];
  while (stack.length > 0) {
    const at = /** @type {number} */ (stack.pop());
    for (const next of blocks.get(at) ?? []) {
      if (downstream.has(next)) continue;
      downstream.add(next);
      stack.push(next);
    }
  }
  downstream.delete(number);
  return { immediate, downstream: [...downstream].sort((a, b) => a - b) };
}

/**
 * The longest chain of blocked-by edges in the snapshot, as issue numbers from the deepest
 * prerequisite to the thing it ultimately blocks.
 *
 * NOT a critical path, and the name is the point (#437: "'Critical path' must not imply
 * duration-based scheduling when no estimates exist"). With no estimates this measures how
 * many sequential decisions deep the graph goes, nothing about time.
 *
 * Returns `[]` when the snapshot reports any cycle: a longest path is undefined on a cyclic
 * graph, and answering anyway would be the "silently laying out an invalid DAG" this issue
 * forbids.
 *
 * @param {Snapshot} snapshot @returns {number[]}
 */
export function longestDependencyChain(snapshot) {
  if ((snapshot?.cycles ?? []).length > 0) return [];
  const issues = snapshot?.issues ?? [];
  const index = indexOf(issues);
  /** @type {Map<number, number[]>} */
  const prerequisites = new Map();
  for (const issue of issues) {
    prerequisites.set(
      issue.number,
      (issue.blockedBy ?? []).map((r) => r.number).filter((n) => index.has(n)),
    );
  }

  /** @type {Map<number, number[]>} */
  const best = new Map();
  /** @param {number} n @returns {number[]} */
  const chainTo = (n) => {
    const cached = best.get(n);
    if (cached !== undefined) return cached;
    // Marked before recursing: a cycle the snapshot failed to report still cannot hang this.
    best.set(n, [n]);
    let longest = /** @type {number[]} */ ([]);
    for (const p of prerequisites.get(n) ?? []) {
      const chain = chainTo(p);
      if (chain.length > longest.length) longest = chain;
    }
    const result = [...longest, n];
    best.set(n, result);
    return result;
  };

  let winner = /** @type {number[]} */ ([]);
  for (const number of [...prerequisites.keys()].sort((a, b) => a - b)) {
    const chain = chainTo(number);
    if (chain.length > winner.length) winner = chain;
  }
  return winner;
}

/**
 * The frontier: every open issue with no standing blocker, bucketed by readiness.
 *
 * `labels` filters conjunctively and `milestone` exactly, because #437's default view is
 * scoped to Public Prototype 1.0 and to `agent-ready` leaves -- but both are arguments rather
 * than constants here, since the same function has to serve "the full public graph" view the
 * issue also asks for.
 *
 * @param {Snapshot} snapshot
 * @param {{ milestone?: string | null, labels?: readonly string[], excludeLabels?: readonly string[] }} [filter]
 */
export function frontierOf(snapshot, filter = {}) {
  const { milestone = null, labels = [], excludeLabels = [] } = filter;
  const index = indexOf(snapshot?.issues ?? []);
  /** @param {SnapshotIssue} issue @returns {boolean} */
  const matches = (issue) => {
    if (milestone !== null && issue.milestone !== milestone) return false;
    if (!labels.every((l) => issue.labels.includes(l))) return false;
    if (excludeLabels.some((l) => issue.labels.includes(l))) return false;
    return true;
  };

  /** @typedef {{ number: number, title: string, labels: readonly string[], readiness: Readiness,
   *   openBlockers: number[], unknownBlockers: number, reason: string }} FrontierRow */
  /** @type {FrontierRow[]} */
  const ready = [];
  /** @type {FrontierRow[]} */
  const blocked = [];
  /** @type {FrontierRow[]} */
  const unknown = [];
  for (const issue of snapshot?.issues ?? []) {
    if (issue.state === 'closed' || !matches(issue)) continue;
    const verdict = readinessOf(issue, index);
    const row = { number: issue.number, title: issue.title, labels: issue.labels, ...verdict };
    if (verdict.readiness === 'ready') ready.push(row);
    else if (verdict.readiness === 'blocked') blocked.push(row);
    else if (verdict.readiness === 'unknown') unknown.push(row);
  }
  /** @param {FrontierRow} a @param {FrontierRow} b */
  const byNumber = (a, b) => a.number - b.number;
  return {
    ready: ready.sort(byNumber),
    blocked: blocked.sort(byNumber),
    unknown: unknown.sort(byNumber),
    // The denominator for all three, after filtering. Without it "7 ready" is unreadable.
    considered: ready.length + blocked.length + unknown.length,
  };
}

/**
 * The frontier as a maintainer reads it.
 *
 * Kept here rather than in `run.mjs` for the reason the rest of this module exists: it is
 * pure, so it is testable without a token, and the CLI stays a thin caller. Every count
 * carries the population it came from -- "7 ready" is unreadable without knowing whether
 * that is of 9 or of 90.
 *
 * TWO SENTENCES IN THE OUTPUT ARE LOAD-BEARING, not decoration:
 *
 * - "Ready means no blocker in the graph, not startable." Measured on this repository, the
 *   native graph called 24 of 28 issues ready while roughly 8 of those were waiting on a
 *   maintainer ruling. A decision carries no blocked-by edge, so no amount of relationship
 *   data can see it, and a reader who takes this list as a work queue will pick one up and
 *   stall.
 * - "`ready` counts only issues this was the LAST blocker for." Closing an issue does not
 *   release everything downstream of it, and "closing this unblocks 12" is exactly the claim
 *   that gets repeated from a number printed without that qualifier.
 *
 * @param {Snapshot} snapshot
 * @param {{ milestone?: string | null, labels?: readonly string[], excludeLabels?: readonly string[] }} [filter]
 * @returns {string}
 */
export function renderFrontier(snapshot, filter = {}) {
  const f = frontierOf(snapshot, filter);
  /** @type {string[]} */
  const lines = [];
  const scope = [
    filter.milestone ? `milestone ${filter.milestone}` : null,
    (filter.labels ?? []).length ? `with ${(filter.labels ?? []).join('+')}` : null,
    (filter.excludeLabels ?? []).length ? `without ${(filter.excludeLabels ?? []).join('/')}` : null,
  ].filter(Boolean).join(', ');

  lines.push(`# Executable frontier${scope ? ` (${scope})` : ''}`);
  lines.push('');
  lines.push(`Snapshot of \`${snapshot?.source?.repo ?? 'unknown'}\`, generated ${snapshot?.generatedAt ?? 'unknown'}.`);
  lines.push('');
  lines.push(`**${f.ready.length} ready / ${f.blocked.length} blocked / ${f.unknown.length} unknown**, of ${f.considered} open issues in scope.`);

  /** @param {{ labels: readonly string[] }} row @param {string} prefix */
  const tag = (row, prefix) =>
    row.labels.find((label) => label.startsWith(prefix))?.slice(prefix.length) ?? '-';

  if (f.ready.length > 0) {
    lines.push('');
    lines.push('## Ready -- no standing blocker');
    for (const row of f.ready) {
      lines.push(`- #${row.number} [${tag(row, 'priority:')}/${tag(row, 'size:')}] ${row.title}`);
    }
    lines.push('');
    lines.push('READY MEANS "NO BLOCKER IN THE GRAPH", not "startable". An issue waiting on a');
    lines.push('decision carries no blocked-by edge, so it appears here.');
  }

  if (f.unknown.length > 0) {
    lines.push('');
    lines.push('## Unknown -- GitHub reports blockers this snapshot did not read');
    for (const row of f.unknown) lines.push(`- #${row.number} ${row.reason} -- ${row.title}`);
  }

  if (f.blocked.length > 0) {
    lines.push('');
    lines.push('## Blocked');
    for (const row of f.blocked) lines.push(`- #${row.number} ${row.reason} -- ${row.title}`);
  }

  const chain = longestDependencyChain(snapshot);
  const cycles = snapshot?.cycles ?? [];
  lines.push('');
  lines.push('## Longest dependency chain');
  lines.push('');
  if (chain.length === 0) {
    lines.push(cycles.length > 0
      ? `Not computed: the snapshot reports ${cycles.length} cycle(s), and a longest path is undefined on a cyclic graph.`
      : 'No blocked-by edges in scope.');
  } else {
    lines.push(`Depth ${chain.length}: ${chain.map((n) => `#${n}`).join(' -> ')}`);
    lines.push('');
    lines.push('NOT a critical path. With no duration estimates this counts sequential');
    lines.push('prerequisites and says nothing about time.');
  }

  const unlocks = (snapshot?.issues ?? [])
    .filter((issue) => issue.state !== 'closed')
    .map((issue) => ({ number: issue.number, ...unlockedByClosing(snapshot, issue.number) }))
    .filter((row) => row.downstream.length > 0)
    .sort((a, b) => b.immediate.length - a.immediate.length
      || b.downstream.length - a.downstream.length
      || a.number - b.number);
  if (unlocks.length > 0) {
    lines.push('');
    lines.push('## What closing an issue would unlock');
    lines.push('');
    lines.push('`ready` counts only issues this is the LAST standing blocker for; `reaches` is');
    lines.push('everything downstream at any depth. They are different claims.');
    lines.push('');
    for (const row of unlocks) {
      const names = row.immediate.length ? row.immediate.map((n) => `#${n}`).join(', ') : '-';
      lines.push(`- #${row.number}: makes ${row.immediate.length} ready (${names}), reaches ${row.downstream.length}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
