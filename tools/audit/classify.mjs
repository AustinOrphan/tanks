/**
 * Tell a supply-chain finding apart from a registry outage (issue #538).
 *
 * `npm audit --omit=dev --audit-level=high` exits 1 for two unrelated reasons: a
 * production dependency carries a high or critical advisory, or npmjs.org did not
 * answer. CI ran the bare command, so the two were indistinguishable -- and because
 * `verify (floor)` and `verify (current)` are required checks, an npm outage turned
 * every open pull request red and blocked merges repository-wide. That happened on
 * `main` at 2d326a5: a 503 from the audit endpoint, seven minutes of npm's own internal
 * retrying, and then an exit code that reads exactly like a real advisory.
 *
 * The gate is right and stays. What it needed was the ability to say WHICH failure it
 * hit. This module is the classification alone -- pure, so it can be tested against
 * fixture payloads instead of against a live network -- and `prod.mjs` is the runner
 * that retries around it.
 */

/**
 * Severities that fail the build. `npm audit`'s own `--audit-level=high` includes
 * `critical`, which is easy to lose when the threshold is re-expressed by hand: a list
 * that stopped at `high` would let the single worst class of advisory through while
 * still looking like a stricter setting than `moderate`.
 */
export const BLOCKING_SEVERITIES = ['high', 'critical'];

/**
 * @typedef {{ kind: 'clean' }
 *   | { kind: 'vulnerable', counts: Record<string, number>, packages: string[] }
 *   | { kind: 'unreachable', detail: string }} AuditVerdict
 */

/**
 * What `npm audit --json` said, as one of three verdicts.
 *
 * The exit code is deliberately NOT an input. npm exits non-zero for both failure kinds
 * and, with `--audit-level` set, its code carries no more information than the payload
 * already does -- reading it would reintroduce the conflation this exists to remove.
 *
 * @param {string} stdout raw stdout from the audit process
 * @returns {AuditVerdict}
 */
export function classifyAudit(stdout) {
  const text = (stdout ?? '').trim();
  if (!text) {
    // No payload at all. npm prints its endpoint errors to stderr and writes nothing to
    // stdout when the request never completed, so silence here is the network, not a
    // clean tree -- treating it as clean is precisely the false negative that would make
    // this gate stop protecting anything during an outage.
    return { kind: 'unreachable', detail: 'npm audit produced no output' };
  }

  let report;
  try {
    report = JSON.parse(text);
  } catch {
    // Unparseable output is npm failing in a way it did not model as JSON. It is not a
    // report, so it cannot be read as one.
    return { kind: 'unreachable', detail: `npm audit output was not JSON: ${firstLine(text)}` };
  }

  // The endpoint's own error shape. `npm audit --json` still emits JSON when the registry
  // refuses -- an object with `error` and no `metadata` -- which is why the presence of a
  // parsed object is not by itself evidence that an audit happened.
  if (report && typeof report === 'object' && report.error) {
    const e = report.error;
    const detail =
      typeof e === 'string' ? e : [e.code, e.summary, e.detail].filter(Boolean).join(' — ');
    return { kind: 'unreachable', detail: detail || 'the audit endpoint returned an error' };
  }

  const counts = report?.metadata?.vulnerabilities;
  if (!counts || typeof counts !== 'object') {
    // Parsed, no error key, and no counts either: a shape this code does not understand.
    // Reporting it clean would be a guess in the direction that hides problems.
    return {
      kind: 'unreachable',
      detail: 'npm audit returned JSON with no metadata.vulnerabilities to read',
    };
  }

  const blocking = BLOCKING_SEVERITIES.filter((s) => Number(counts[s]) > 0);
  if (blocking.length === 0) return { kind: 'clean' };

  // Name the packages, so the failure line is actionable without opening the report.
  // `vulnerabilities` is keyed by package name; a report that omits it still fails, just
  // less helpfully.
  const packages = Object.entries(report.vulnerabilities ?? {})
    .filter(([, v]) => BLOCKING_SEVERITIES.includes(v?.severity))
    .map(([name]) => name)
    .sort();

  return { kind: 'vulnerable', counts, packages };
}

/** `['a']` -> "a"; `['a','b']` -> "a or b"; `['a','b','c']` -> "a, b or c". */
function humanList(items) {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** One line, trimmed, for embedding in an error message. */
function firstLine(text) {
  const line = text.split('\n', 1)[0].trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** The human-facing summary line for a verdict, as CI should print it. */
export function describeVerdict(verdict) {
  switch (verdict.kind) {
    case 'clean':
      // DERIVED from the same list the verdict was decided by, not spelled out again.
      // A hardcoded "high or critical" here would keep claiming both after the threshold
      // moved, which is the quietest way for a summary line to start lying -- it reports
      // a check that was not the one performed.
      return `audit: no ${humanList(BLOCKING_SEVERITIES)} advisories in production dependencies`;
    case 'vulnerable': {
      const counts = BLOCKING_SEVERITIES.map((s) => `${verdict.counts[s] ?? 0} ${s}`).join(', ');
      const named = verdict.packages.length ? `: ${verdict.packages.join(', ')}` : '';
      return `audit: VULNERABLE -- ${counts}${named}`;
    }
    case 'unreachable':
      // Says "the registry", not "the tree". The whole point of the classification is
      // that whoever reads this line does not go looking through package-lock.json.
      return `audit: REGISTRY UNREACHABLE (not a vulnerability) -- ${verdict.detail}`;
  }
}
