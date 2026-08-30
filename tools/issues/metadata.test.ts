import { describe, expect, it } from 'vitest';
import {
  LABEL_DIMENSIONS,
  auditOpenIssues,
  declaredSingularParent,
  explicitFormLabels,
  planIssueEventLabelChanges,
  renderAuditReport,
} from './metadata.mjs';

const completeLabels = [
  'size:s',
  'risk:low',
  'area:repository',
  'impact:medium',
  'priority:next',
];

const issue = (
  number: number,
  labels: string[] = completeLabels,
  body = '## Dependencies\n\nNone',
  extra: Record<string, unknown> = {},
) => ({ number, state: 'open', title: `Issue ${number}`, body, labels, ...extra });

const codes = (problems: Array<{ code: string }>) => problems.map((problem) => problem.code);

describe('issue metadata contract', () => {
  it('accepts one supported label from every required dimension', () => {
    const result = auditOpenIssues([issue(1)]);
    expect(result.issueCount).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('reports missing, conflicting, and unsupported dimension labels separately', () => {
    const missing = issue(2, completeLabels.filter((label) => label !== 'risk:low'));
    const conflicting = issue(3, [...completeLabels, 'impact:high']);
    const unsupported = issue(4, completeLabels.map((label) =>
      label === 'area:repository' ? 'area:campaign' : label));

    const result = auditOpenIssues([missing, conflicting, unsupported]);
    expect(codes(result.errors)).toEqual([
      'missing-risk',
      'duplicate-impact',
      'missing-area',
      'invalid-area',
    ]);
    expect(result.errors[0].remediation).toContain('risk:low');
    expect(result.errors[1].message).toContain('impact:high');
    expect(result.errors[3].message).toContain('area:campaign');
  });

  it('requires large work to be split and keeps L/XL work out of agent-ready', () => {
    const large = issue(5, [
      'size:l', 'risk:medium', 'area:ui', 'impact:medium', 'priority:next', 'agent-ready',
    ]);
    const epic = issue(6, [
      'size:xl', 'risk:medium', 'area:versus', 'impact:high', 'priority:later', 'agent-ready',
    ]);
    const splitLarge = issue(7, [
      'size:l', 'risk:medium', 'area:ui', 'impact:medium', 'priority:next', 'needs-split',
    ]);

    const result = auditOpenIssues([large, epic, splitLarge]);
    expect(codes(result.errors)).toEqual([
      'large-needs-split',
      'agent-ready-size',
      'agent-ready-size',
    ]);
    expect(result.errors.some((error) => error.issueNumber === 7)).toBe(false);
  });

  it('admits only agent-ready XS-M leaves to Now', () => {
    const notReady = issue(8, [
      'size:s', 'risk:low', 'area:gameplay', 'impact:high', 'priority:now',
    ]);
    const ready = issue(9, [
      'size:m', 'risk:medium', 'area:ai', 'impact:high', 'priority:now', 'agent-ready',
    ]);

    const result = auditOpenIssues([notReady, ready]);
    expect(codes(result.errors)).toEqual(['invalid-now-item']);
    expect(result.errors[0].issueNumber).toBe(8);
    expect(result.nowCount).toBe(2);
  });

  it('accepts exactly eight Now issues and rejects the ninth', () => {
    const readyNow = Array.from({ length: 9 }, (_, index) => issue(20 + index, [
      'size:xs',
      'risk:low',
      'area:repository',
      'impact:high',
      'priority:now',
      'agent-ready',
    ]));

    expect(auditOpenIssues(readyNow.slice(0, 8)).errors).toEqual([]);
    const ninth = auditOpenIssues(readyNow);
    expect(codes(ninth.errors)).toEqual(['now-limit']);
    expect(ninth.errors[0].issueNumbers).toHaveLength(9);
    expect(ninth.errors[0].remediation).toContain('at least 1');
  });

  it('excludes closed issues and pull requests from the open-issue population', () => {
    const result = auditOpenIssues([
      issue(30),
      issue(31, [], '', { state: 'closed' }),
      issue(32, [], '', { pull_request: { url: 'https://example.test/pr/32' } }),
    ]);
    expect(result.issueCount).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('warns on explicit unresolved readiness markers without treating arbitrary prose as proof', () => {
    const blocked = issue(40, [...completeLabels, 'agent-ready'], [
      '## Dependencies',
      '',
      'Blocked by #39.',
    ].join('\n'));
    const incidental = issue(41, [...completeLabels, 'agent-ready'], [
      '## Desired outcome',
      '',
      'Do not leave the player blocked by a wall.',
      '',
      '## Dependencies',
      '',
      'All dependencies are complete.',
    ].join('\n'));

    const result = auditOpenIssues([blocked, incidental]);
    expect(result.errors).toEqual([]);
    expect(codes(result.warnings)).toEqual(['readiness-marker']);
    expect(result.warnings[0].issueNumber).toBe(40);
    expect(result.warnings[0].message).toContain('Dependencies');
  });
});

describe('native relationship contract', () => {
  const relationships = (
    blockedBy: Array<Record<string, unknown>> = [],
    extra: Record<string, unknown> = {},
  ) => ({
    loaded: true,
    parentLoaded: false,
    parent: null,
    blockersLoaded: true,
    blockedBy,
    subIssues: [],
    ...extra,
  });

  it('parses only unambiguous singular parent mirrors', () => {
    expect(declaredSingularParent('Parent: #315')).toBe(315);
    expect(declaredSingularParent('Part of #229.')).toBe(229);
    expect(declaredSingularParent('## Parent\n\n- #238')).toBe(238);
    expect(declaredSingularParent('Parents: #228, #315')).toBeNull();
    expect(declaredSingularParent('## Parents\n\n- #228\n- #315')).toBeNull();
  });

  it('ignores parent forms that only appear inside code fences or code spans', () => {
    expect(declaredSingularParent('```\nParent: #999\n```')).toBeNull();
    expect(declaredSingularParent('```md\nPart of #999\n```')).toBeNull();
    expect(declaredSingularParent('## Parent\n\nUse the form `Parent: #999` verbatim.')).toBeNull();
    expect(declaredSingularParent('~~~\n## Parent\n\n- #999\n~~~')).toBeNull();
    expect(declaredSingularParent('Parent: #315\n\n```\nParent: #999\n```')).toBe(315);
  });

  it('scopes the native-blocked count to the issues actually inspected for blockers', () => {
    const inspected = issue(92, [
      'size:m', 'risk:medium', 'area:ui', 'impact:high', 'priority:next',
    ], '## Dependencies\n\nNone', {
      nativeRelationships: relationships([{ number: 70, state: 'open' }]),
    });
    const skipped = issue(93, [
      'size:s', 'risk:low', 'area:repository', 'impact:medium', 'priority:next',
    ], '## Dependencies\n\nNone', {
      nativeRelationships: relationships([], { blockersLoaded: false }),
    });

    const result = auditOpenIssues([inspected, skipped]);
    expect(result.blockedCount).toBe(1);
    expect(result.blockerInspectedCount).toBe(1);
    expect(renderAuditReport(result).split('\n')).toContain(
      'Native-blocked open issues: 1 of 1 inspected for native blockers (2 audited).',
    );
  });

  it('keeps open native blockers out of agent-ready and Now', () => {
    const blocked = issue(80, [
      'size:m', 'risk:medium', 'area:ui', 'impact:high', 'priority:now', 'agent-ready',
    ], '## Dependencies\n\nNone', {
      nativeRelationships: relationships([
        { number: 70, state: 'open' },
        { number: 71, state: 'closed' },
      ]),
    });
    const result = auditOpenIssues([blocked]);
    expect(codes(result.errors)).toEqual([
      'agent-ready-native-blocked',
      'now-native-blocked',
    ]);
    expect(result.blockedCount).toBe(1);
    expect(result.errors.every((error) => error.message.includes('#70'))).toBe(true);
    expect(result.errors.some((error) => error.message.includes('#71'))).toBe(false);
  });

  it('treats completed native prerequisites as history, not current blockage', () => {
    const ready = issue(81, [
      'size:s', 'risk:low', 'area:repository', 'impact:high', 'priority:now', 'agent-ready',
    ], '## Dependencies\n\nAll dependencies are complete.', {
      nativeRelationships: relationships([{ number: 70, state: 'closed' }]),
    });
    const result = auditOpenIssues([ready]);
    expect(result.errors).toEqual([]);
    expect(result.blockedCount).toBe(0);
  });

  it('rejects missing or contradictory singular parent mirrors', () => {
    const missing = issue(82, completeLabels, 'Parent: #10', {
      nativeRelationships: relationships([], { parentLoaded: true }),
    });
    const mismatch = issue(83, completeLabels, '## Parent\n\n- #11', {
      nativeRelationships: relationships([], {
        parentLoaded: true,
        parent: { number: 12, state: 'open' },
      }),
    });
    const result = auditOpenIssues([missing, mismatch]);
    expect(codes(result.errors)).toEqual([
      'declared-parent-missing-native',
      'declared-parent-mismatch',
    ]);
  });

  it('flags decomposed XL roll-ups with no native children', () => {
    const body = '## Implementation breakdown\n\n- [ ] #91 — First leaf';
    const rollup = issue(90, [
      'size:xl', 'risk:medium', 'area:repository', 'impact:medium', 'priority:next',
    ], body, { nativeRelationships: relationships() });
    const linked = issue(92, [
      'size:xl', 'risk:medium', 'area:repository', 'impact:medium', 'priority:next',
    ], body, {
      nativeRelationships: relationships([], { subIssues: [{ number: 91, state: 'open' }] }),
    });
    const result = auditOpenIssues([rollup, linked]);
    expect(codes(result.errors)).toEqual(['rollup-missing-native-subissues']);
    expect(result.errors[0].issueNumber).toBe(90);
  });

  it('warns when an open child remains under a closed native parent', () => {
    const child = issue(93, completeLabels, 'Part of #90.', {
      nativeRelationships: relationships([], {
        parentLoaded: true,
        parent: { number: 90, state: 'closed' },
      }),
    });
    const result = auditOpenIssues([child]);
    expect(result.errors).toEqual([]);
    expect(codes(result.warnings)).toEqual(['open-child-closed-parent']);
  });

  it('rejects cycles in the open native dependency graph', () => {
    const first = issue(94, completeLabels, undefined, {
      nativeRelationships: relationships([{ number: 95, state: 'open' }]),
    });
    const second = issue(95, completeLabels, undefined, {
      nativeRelationships: relationships([{ number: 94, state: 'open' }]),
    });
    const result = auditOpenIssues([first, second]);
    expect(codes(result.errors)).toEqual(['native-dependency-cycle']);
    expect(result.errors[0].issueNumbers).toEqual([94, 95]);
  });
});

describe('deterministic issue-form labels', () => {
  const formBody = [
    '### Primary area',
    '',
    'area:ai — AI perception, decisions, aiming, or movement',
    '',
    '### Expected impact',
    '',
    'impact:high — Blocks a primary flow, protects user data, or unlocks a major dependency chain',
  ].join('\n');

  it('extracts exact allowlisted selections only from their stable form headings', () => {
    expect(explicitFormLabels(formBody)).toEqual({ area: 'area:ai', impact: 'impact:high' });

    const prose = [
      '### Desired outcome',
      '',
      'Maybe area:ai and impact:high apply, but this is free-form prose.',
    ].join('\n');
    expect(explicitFormLabels(prose)).toEqual({});

    const ambiguous = `${formBody}\n\n### Primary area\n\narea:ui — Menus and HUD`;
    expect(explicitFormLabels(ambiguous)).toEqual({ impact: 'impact:high' });
  });

  it('reconciles only explicitly selected area and impact labels', () => {
    const changes = planIssueEventLabelChanges('edited', issue(50, [
      'size:s',
      'risk:low',
      'area:ui',
      'impact:low',
      'priority:next',
      'agent-ready',
    ], formBody));

    expect(changes).toEqual({
      add: ['area:ai', 'impact:high'],
      remove: ['area:ui', 'impact:low'],
    });
    expect(changes.add).not.toContain('agent-ready');
    expect(changes.add.some((label) => label.startsWith('priority:'))).toBe(false);
    expect(changes.add.some((label) => label.startsWith('risk:'))).toBe(false);
  });
});

describe('closed-issue cleanup', () => {
  it('removes transient readiness and every priority label while preserving durable metadata', () => {
    const closed = issue(60, [
      'size:m',
      'risk:medium',
      'area:repository',
      'impact:high',
      'priority:now',
      'priority:legacy',
      'agent-ready',
      'needs-split',
    ]);
    const changes = planIssueEventLabelChanges('closed', closed);

    expect(changes).toEqual({
      add: [],
      remove: ['priority:now', 'priority:legacy', 'agent-ready'],
    });
    for (const durable of ['size:m', 'risk:medium', 'area:repository', 'impact:high']) {
      expect(changes.remove).not.toContain(durable);
    }
  });

  it('does not treat a PR merge-like action as issue closure or restore transient labels', () => {
    expect(planIssueEventLabelChanges('merged', issue(61))).toEqual({ add: [], remove: [] });
    const reopened = planIssueEventLabelChanges('reopened', issue(62, completeLabels, ''));
    expect(reopened.add).toEqual([]);
    expect(reopened.remove).toEqual([]);
  });
});

describe('audit report', () => {
  it('prints issue-specific remediation and the bounded queue population', () => {
    const missingRisk = issue(70, completeLabels.filter((label) => label !== 'risk:low'));
    const report = renderAuditReport(auditOpenIssues([missingRisk]));
    expect(report).toContain('Audited 1 open issues. Now queue: 0/8.');
    expect(report).toContain('#70 `missing-risk`');
    expect(report).toContain('Fix: Add exactly one of:');
    for (const risk of LABEL_DIMENSIONS.risk) expect(report).toContain(risk);
  });
});
