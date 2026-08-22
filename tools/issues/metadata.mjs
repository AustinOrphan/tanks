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

export function auditOpenIssues(inputIssues, { maxNow = MAX_NOW_ISSUES } = {}) {
  const issues = (Array.isArray(inputIssues) ? inputIssues : [])
    .filter((issue) => issue?.state !== 'closed' && issue?.pull_request === undefined)
    .sort((a, b) => (issueNumber(a) ?? 0) - (issueNumber(b) ?? 0));
  const errors = [];
  const warnings = [];
  const nowIssues = [];

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

  return {
    issueCount: issues.length,
    nowCount: nowIssues.length,
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
    return `Now queue (${problem.issueNumbers.map((number) => `#${number}`).join(', ')})`;
  }
  return 'Repository';
};

export function renderAuditReport(result) {
  const lines = [
    '# Issue metadata audit',
    '',
    `Audited ${result.issueCount} open issues. Now queue: ${result.nowCount}/${result.maxNow}.`,
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
