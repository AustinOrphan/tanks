export const MAX_NOW_ISSUES = 8;

export const LABEL_DIMENSIONS = Object.freeze({
  size: Object.freeze(['size:xs', 'size:s', 'size:m', 'size:l', 'size:xl']),
  risk: Object.freeze(['risk:low', 'risk:medium', 'risk:high']),
  area: Object.freeze([
    'area:repository',
    'area:ui',
    'area:ai',
    'area:versus',
    'area:rendering',
    'area:gameplay',
    'area:developer-tools',
  ]),
  impact: Object.freeze(['impact:high', 'impact:medium', 'impact:low']),
  priority: Object.freeze(['priority:now', 'priority:next', 'priority:later']),
});

const DIMENSION_PREFIXES = Object.freeze({
  size: 'size:',
  risk: 'risk:',
  area: 'area:',
  impact: 'impact:',
  priority: 'priority:',
});

const READY_SIZES = new Set(['size:xs', 'size:s', 'size:m']);
const FORM_SELECTIONS = Object.freeze([
  { dimension: 'area', heading: 'Primary area' },
  { dimension: 'impact', heading: 'Expected impact' },
]);

const labelName = (label) =>
  (typeof label === 'string' ? label : label?.name ?? '').trim().toLowerCase();

export const issueLabelNames = (issue) =>
  (Array.isArray(issue?.labels) ? issue.labels : []).map(labelName).filter(Boolean);

const issueNumber = (issue) => issue?.number ?? issue?.issue_number ?? null;

const issueProblem = (issue, code, message, remediation) => ({
  issueNumber: issueNumber(issue),
  code,
  message,
  remediation,
});

const queueProblem = (issueNumbers, code, message, remediation) => ({
  issueNumbers,
  code,
  message,
  remediation,
});

const normalizedLines = (body) => String(body ?? '').replaceAll('\r\n', '\n').split('\n');

export function markdownSections(body, heading) {
  const lines = normalizedLines(body);
  const wanted = heading.trim().toLowerCase();
  const sections = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^#{2,6}\s+(.+?)\s*$/.exec(lines[index]);
    if (match?.[1].trim().toLowerCase() !== wanted) continue;

    const content = [];
    for (index += 1; index < lines.length; index += 1) {
      if (/^#{2,6}\s+/.test(lines[index])) {
        index -= 1;
        break;
      }
      content.push(lines[index]);
    }
    sections.push(content.join('\n').trim());
  }

  return sections;
}

const issueReferences = (value) =>
  [...String(value ?? '').matchAll(/#(\d+)/g)].map((match) => Number(match[1]));

export function declaredSingularParent(body) {
  const lines = normalizedLines(body);
  const candidates = [];

  for (const line of lines) {
    const direct = /^\s*Parent:\s*#(\d+)\s*\.?\s*$/i.exec(line);
    const partOf = /^\s*Part of #([0-9]+)\s*\.?\s*$/i.exec(line);
    if (direct !== null) candidates.push(Number(direct[1]));
    if (partOf !== null) candidates.push(Number(partOf[1]));
  }

  for (const section of markdownSections(body, 'Parent')) {
    candidates.push(...issueReferences(section));
  }

  const distinct = [...new Set(candidates)];
  return distinct.length === 1 ? distinct[0] : null;
}

function explicitSelection(body, heading, allowed) {
  const sections = markdownSections(body, heading);
  if (sections.length !== 1) return null;

  const value = sections[0].split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  const matches = allowed.filter(
    (label) => value === label || value.startsWith(`${label} — `),
  );
  return matches.length === 1 ? matches[0] : null;
}

export function explicitFormLabels(body) {
  const selected = {};
  for (const { dimension, heading } of FORM_SELECTIONS) {
    const value = explicitSelection(body, heading, LABEL_DIMENSIONS[dimension]);
    if (value !== null) selected[dimension] = value;
  }
  return selected;
}

export function planIssueEventLabelChanges(action, issue) {
  const labels = issueLabelNames(issue);

  if (action === 'closed') {
    return {
      add: [],
      remove: labels.filter(
        (label) => label === 'agent-ready' || label.startsWith(DIMENSION_PREFIXES.priority),
      ),
    };
  }

  if (!['opened', 'edited', 'reopened'].includes(action)) {
    return { add: [], remove: [] };
  }

  const selected = explicitFormLabels(issue?.body);
  const add = [];
  const remove = [];

  for (const [dimension, wanted] of Object.entries(selected)) {
    const prefix = DIMENSION_PREFIXES[dimension];
    remove.push(...labels.filter((label) => label.startsWith(prefix) && label !== wanted));
    if (!labels.includes(wanted)) add.push(wanted);
  }

  return {
    add: [...new Set(add)].sort(),
    remove: [...new Set(remove)].sort(),
  };
}

function unresolvedReadinessMarkers(issue) {
  const headings = [
    'Dependencies',
    'Blocking dependencies',
    'Decisions',
    'Open questions',
    'Unresolved decisions',
  ];
  const markers = [
    { name: 'unchecked item', pattern: /^\s*-\s*\[\s\]/m },
    { name: 'TBD', pattern: /\btbd\b/i },
    { name: 'TODO', pattern: /\btodo\b/i },
    { name: 'blocked dependency', pattern: /\bblocked(?:\s+by)?\b/i },
    { name: 'waiting dependency', pattern: /\bwaiting\s+(?:on|for)\b/i },
    { name: 'pending decision', pattern: /\b(?:decision|answer)\s+(?:needed|required|pending)\b/i },
    { name: 'unresolved item', pattern: /\bunresolved\b/i },
  ];
  const warnings = [];

  for (const heading of headings) {
    for (const section of markdownSections(issue?.body, heading)) {
      const normalized = section.trim().toLowerCase().replace(/[.!]$/, '');
      if (['none', 'n/a', 'not applicable', 'all dependencies are complete'].includes(normalized)) {
        continue;
      }
      for (const marker of markers) {
        if (marker.pattern.test(section)) warnings.push({ heading, marker: marker.name });
      }
    }
  }

  return warnings;
}

const openNativeBlockers = (issue) => {
  const relationships = issue?.nativeRelationships;
  if (relationships?.loaded !== true) return [];
  return (Array.isArray(relationships.blockedBy) ? relationships.blockedBy : [])
    .filter((blocker) => blocker?.state !== 'closed');
};

const hasImplementationBreakdown = (issue) =>
  markdownSections(issue?.body, 'Implementation breakdown')
    .some((section) => /^\s*-\s*\[[ xX]\]\s+#\d+/m.test(section));

function findDependencyCycles(issues) {
  const issueNumbers = new Set(issues.map(issueNumber).filter((number) => number !== null));
  const graph = new Map(issues.map((issue) => [
    issueNumber(issue),
    openNativeBlockers(issue)
      .map(issueNumber)
      .filter((number) => number !== null && issueNumbers.has(number)),
  ]));
  const visiting = new Map();
  const visited = new Set();
  const stack = [];
  const cycles = [];
  const cycleKeys = new Set();

  const visit = (number) => {
    const stackIndex = visiting.get(number);
    if (stackIndex !== undefined) {
      const cycle = stack.slice(stackIndex);
      const key = [...cycle].sort((a, b) => a - b).join(':');
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (visited.has(number)) return;
    visiting.set(number, stack.length);
    stack.push(number);
    for (const blocker of graph.get(number) ?? []) visit(blocker);
    stack.pop();
    visiting.delete(number);
    visited.add(number);
  };

  for (const number of graph.keys()) visit(number);
  return cycles;
}

export function auditOpenIssues(inputIssues, { maxNow = MAX_NOW_ISSUES } = {}) {
  const issues = (Array.isArray(inputIssues) ? inputIssues : [])
    .filter((issue) => issue?.state !== 'closed' && issue?.pull_request === undefined)
    .sort((a, b) => (issueNumber(a) ?? 0) - (issueNumber(b) ?? 0));
  const errors = [];
  const warnings = [];
  const nowIssues = [];
  let blockedCount = 0;

  for (const issue of issues) {
    const labels = issueLabelNames(issue);

    for (const [dimension, allowed] of Object.entries(LABEL_DIMENSIONS)) {
      const matches = allowed.filter((label) => labels.includes(label));
      const unknown = labels.filter(
        (label) => label.startsWith(DIMENSION_PREFIXES[dimension]) && !allowed.includes(label),
      );

      if (matches.length === 0) {
        errors.push(issueProblem(
          issue,
          `missing-${dimension}`,
          `has no recognized ${dimension} label${unknown.length > 0 ? `; unrecognized: ${unknown.join(', ')}` : ''}`,
          `Add exactly one of: ${allowed.join(', ')}.`,
        ));
      } else if (matches.length > 1) {
        errors.push(issueProblem(
          issue,
          `duplicate-${dimension}`,
          `has conflicting ${dimension} labels: ${matches.join(', ')}`,
          `Keep exactly one ${dimension} label.`,
        ));
      }

      if (unknown.length > 0) {
        errors.push(issueProblem(
          issue,
          `invalid-${dimension}`,
          `has unsupported ${dimension} labels: ${unknown.join(', ')}`,
          `Remove unsupported labels and use one of: ${allowed.join(', ')}.`,
        ));
      }
    }

    const size = LABEL_DIMENSIONS.size.find((label) => labels.includes(label));
    const priority = LABEL_DIMENSIONS.priority.find((label) => labels.includes(label));
    const agentReady = labels.includes('agent-ready');
    const nativeBlockers = openNativeBlockers(issue);
    if (nativeBlockers.length > 0) blockedCount += 1;

    if (issue?.nativeRelationships?.loaded === true) {
      const declaredParent = declaredSingularParent(issue?.body);
      if (declaredParent !== null && issue.nativeRelationships.parentLoaded === true) {
        const nativeParent = issue.nativeRelationships.parent;
        if (nativeParent === null) {
          errors.push(issueProblem(
            issue,
            'declared-parent-missing-native',
            `declares parent #${declaredParent}, but has no native parent`,
            `Add #${issueNumber(issue)} as a native sub-issue of #${declaredParent}, or correct the stale body mirror.`,
          ));
        } else if (nativeParent.number !== declaredParent) {
          errors.push(issueProblem(
            issue,
            'declared-parent-mismatch',
            `declares parent #${declaredParent}, but its native parent is #${nativeParent.number}`,
            'Keep the native decomposition authoritative and correct the stale body mirror or reviewed parent edge.',
          ));
        }
        if (nativeParent?.state === 'closed') {
          warnings.push(issueProblem(
            issue,
            'open-child-closed-parent',
            `is open under closed native parent #${nativeParent.number}`,
            'Confirm the child belongs under that completed roll-up or reopen/correct the parent as appropriate.',
          ));
        }
      }

      if (size === 'size:xl' && hasImplementationBreakdown(issue)) {
        const subIssues = issue.nativeRelationships.subIssues;
        if (!Array.isArray(subIssues) || subIssues.length === 0) {
          errors.push(issueProblem(
            issue,
            'rollup-missing-native-subissues',
            'has an explicit implementation breakdown but no native sub-issues',
            'Represent the reviewed decomposition with native sub-issues; keep cross-cutting references in the body.',
          ));
        }
      }
    }

    if (size === 'size:l' && !labels.includes('needs-split')) {
      errors.push(issueProblem(
        issue,
        'large-needs-split',
        'is size:l without needs-split',
        'Add needs-split, then create bounded child issues before implementation.',
      ));
    }

    if (agentReady && !READY_SIZES.has(size)) {
      errors.push(issueProblem(
        issue,
        'agent-ready-size',
        `is agent-ready with ${size ?? 'no valid size'}`,
        'Remove agent-ready or split/re-size the work to an XS-M implementation leaf.',
      ));
    }

    if (agentReady && nativeBlockers.length > 0) {
      errors.push(issueProblem(
        issue,
        'agent-ready-native-blocked',
        `is agent-ready while blocked by open ${nativeBlockers.map((blocker) => `#${blocker.number}`).join(', ')}`,
        'Resolve/remove the native blockers or remove agent-ready until the issue is independently implementable.',
      ));
    }

    if (priority === 'priority:now') {
      nowIssues.push(issue);
      if (!agentReady || !READY_SIZES.has(size)) {
        errors.push(issueProblem(
          issue,
          'invalid-now-item',
          'is priority:now without being an agent-ready XS-M leaf',
          'Move it to priority:next/later, or finish triage and decomposition before returning it to Now.',
        ));
      }
      if (nativeBlockers.length > 0) {
        errors.push(issueProblem(
          issue,
          'now-native-blocked',
          `is in Now while blocked by open ${nativeBlockers.map((blocker) => `#${blocker.number}`).join(', ')}`,
          'Move the issue out of Now until its native blockers are complete, or correct stale blocker edges.',
        ));
      }
    }

    if (agentReady) {
      for (const marker of unresolvedReadinessMarkers(issue)) {
        warnings.push(issueProblem(
          issue,
          'readiness-marker',
          `is agent-ready but its ${marker.heading} section contains an apparent ${marker.marker}`,
          'Confirm the item is resolved or remove agent-ready; this warning is intentionally heuristic.',
        ));
      }
    }
  }

  if (nowIssues.length > maxNow) {
    const numbers = nowIssues.map(issueNumber).filter((number) => number !== null);
    errors.push(queueProblem(
      numbers,
      'now-limit',
      `the Now queue contains ${nowIssues.length} open issues; the limit is ${maxNow}`,
      `Move at least ${nowIssues.length - maxNow} issue(s) to priority:next or priority:later.`,
    ));
  }

  for (const cycle of findDependencyCycles(issues)) {
    errors.push({
      issueNumbers: cycle,
      code: 'native-dependency-cycle',
      message: `form a native blocked-by cycle: ${cycle.map((number) => `#${number}`).join(' → ')} → #${cycle[0]}`,
      remediation: 'Correct the prerequisite direction or remove the edge that makes the dependency graph cyclic.',
    });
  }

  return {
    issueCount: issues.length,
    nowCount: nowIssues.length,
    blockedCount,
    maxNow,
    errors,
    warnings,
  };
}

const problemReference = (problem) => {
  if (problem.issueNumber !== undefined && problem.issueNumber !== null) {
    return `#${problem.issueNumber}`;
  }
  if (Array.isArray(problem.issueNumbers) && problem.issueNumbers.length > 0) {
    const label = problem.code === 'now-limit' ? 'Now queue' : 'Issues';
    return `${label} (${problem.issueNumbers.map((number) => `#${number}`).join(', ')})`;
  }
  return 'Repository';
};

export function renderAuditReport(result) {
  const lines = [
    '# Issue metadata and relationship audit',
    '',
    `Audited ${result.issueCount} open issues. Now queue: ${result.nowCount}/${result.maxNow}.`,
    `Native-blocked open issues: ${result.blockedCount ?? 0}.`,
    '',
  ];

  if (result.errors.length === 0) {
    lines.push('No metadata contract violations found.', '');
  } else {
    lines.push(`## Errors (${result.errors.length})`, '');
    for (const error of result.errors) {
      lines.push(
        `- ${problemReference(error)} \`${error.code}\`: ${error.message}`,
        `  - Fix: ${error.remediation}`,
      );
    }
    lines.push('');
  }

  if (result.warnings.length > 0) {
    lines.push(`## Warnings (${result.warnings.length})`, '');
    for (const warning of result.warnings) {
      lines.push(
        `- ${problemReference(warning)} \`${warning.code}\`: ${warning.message}`,
        `  - Check: ${warning.remediation}`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
