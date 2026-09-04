import { describe, it, expect } from 'vitest';
import { classifyAudit, describeVerdict, BLOCKING_SEVERITIES } from './classify.mjs';

/**
 * Issue #538: the audit gate could not tell a supply-chain finding from an npm outage,
 * so a 503 from npmjs.org failed `verify (floor)` on main exactly the way a real advisory
 * would -- and, because floor and current are required checks, blocked every merge.
 *
 * These run against FIXTURE payloads rather than the live registry, which is the only way
 * the unreachable branch is testable at all: it exists precisely for the moments the
 * network is not there.
 */

const counts = (over: Partial<Record<string, number>> = {}) => ({
  info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...over,
});

/** A clean report, in the shape npm actually emits. */
const cleanReport = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: counts() },
});

describe('audit classification (issue #538)', () => {
  it('reads a clean report as clean', () => {
    expect(classifyAudit(cleanReport)).toEqual({ kind: 'clean' });
  });

  it('passes advisories BELOW the threshold', () => {
    // The threshold is the point of the gate: moderate and low findings are reported by
    // npm on most trees most of the time, and failing on them would make the check noise
    // that people learn to ignore -- which is how a real high-severity finding gets
    // waved through.
    const report = JSON.stringify({
      vulnerabilities: { lodash: { severity: 'moderate' } },
      metadata: { vulnerabilities: counts({ moderate: 3, low: 1, total: 4 }) },
    });
    expect(classifyAudit(report)).toEqual({ kind: 'clean' });
  });

  it.each(BLOCKING_SEVERITIES)('fails on a %s advisory, and names the package', (severity) => {
    const report = JSON.stringify({
      vulnerabilities: { 'some-dep': { severity }, ignorable: { severity: 'low' } },
      metadata: { vulnerabilities: counts({ [severity]: 1, low: 1, total: 2 }) },
    });
    const v = classifyAudit(report);
    expect(v.kind).toBe('vulnerable');
    // The low-severity package must NOT be named: the line is for acting on, and listing
    // packages that did not fail the build makes it unreadable.
    expect(v.kind === 'vulnerable' && v.packages).toEqual(['some-dep']);
  });

  it('includes CRITICAL, not just high', () => {
    // The regression this guards: re-expressing `--audit-level=high` as a hand-written
    // list is where `critical` gets dropped, and the result looks stricter than
    // `moderate` while letting the worst class of advisory straight through.
    expect(BLOCKING_SEVERITIES).toContain('critical');
    const report = JSON.stringify({
      vulnerabilities: { bad: { severity: 'critical' } },
      metadata: { vulnerabilities: counts({ critical: 1, total: 1 }) },
    });
    expect(classifyAudit(report).kind).toBe('vulnerable');
  });

  describe('an unreachable registry is NOT a vulnerability, and not a pass either', () => {
    it("reads npm's own error payload as unreachable", () => {
      // The exact shape from the failure on main at 2d326a5.
      const report = JSON.stringify({
        error: { code: 'E503', summary: 'Service Unavailable', detail: 'audit endpoint' },
      });
      const v = classifyAudit(report);
      expect(v.kind).toBe('unreachable');
      expect(v.kind === 'unreachable' && v.detail).toContain('Service Unavailable');
    });

    it('reads EMPTY output as unreachable rather than clean', () => {
      // The dangerous direction. npm writes its endpoint errors to stderr and leaves
      // stdout empty when the request never completed, so "no findings printed" and "no
      // audit happened" look identical from stdout alone. Reading silence as clean is a
      // gate that stops protecting during exactly the outage it cannot see.
      for (const empty of ['', '   ', '\n']) {
        expect(classifyAudit(empty).kind, JSON.stringify(empty)).toBe('unreachable');
      }
    });

    it('reads unparseable output as unreachable', () => {
      expect(classifyAudit('npm error code E503\nnpm error audit endpoint').kind).toBe(
        'unreachable',
      );
    });

    it('reads a report with no vulnerability counts as unreachable, not clean', () => {
      // Parsed, no `error` key, but nothing to read either. A shape this code does not
      // understand must not resolve in the direction that hides problems.
      expect(classifyAudit(JSON.stringify({ auditReportVersion: 2 })).kind).toBe('unreachable');
    });
  });

  describe('the summary line is what a reader sees first', () => {
    it('says REGISTRY UNREACHABLE and disclaims a vulnerability', () => {
      // The failure on main read "Process completed with exit code 1", which is
      // indistinguishable from a real advisory. Whoever sees this line must not go
      // looking through package-lock.json.
      const line = describeVerdict(classifyAudit(JSON.stringify({ error: 'Service Unavailable' })));
      expect(line).toContain('REGISTRY UNREACHABLE');
      expect(line).toContain('not a vulnerability');
    });

    it('says VULNERABLE with the counts and the packages', () => {
      const report = JSON.stringify({
        vulnerabilities: { 'some-dep': { severity: 'high' } },
        metadata: { vulnerabilities: counts({ high: 2, critical: 1, total: 3 }) },
      });
      const line = describeVerdict(classifyAudit(report));
      expect(line).toContain('VULNERABLE');
      expect(line).toContain('2 high');
      expect(line).toContain('1 critical');
      expect(line).toContain('some-dep');
      expect(line).not.toContain('UNREACHABLE');
    });

    it('a clean line names exactly the severities that were checked', () => {
      // DERIVED from BLOCKING_SEVERITIES rather than spelled out. A hardcoded phrase here
      // would keep claiming "high or critical" after the threshold moved -- the quietest
      // way for a summary to lie, because it reports a check that was not the one run.
      const line = describeVerdict(classifyAudit(cleanReport));
      for (const severity of BLOCKING_SEVERITIES) expect(line).toContain(severity);
      expect(line).toContain('no high or critical');
      expect(line).not.toContain('VULNERABLE');
    });
  });
});
