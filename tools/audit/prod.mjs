/**
 * The production-dependency audit gate (issue #538).
 *
 * Runs `npm audit --omit=dev --json`, classifies the answer (see classify.mjs), and
 * retries only the one failure kind that retrying can fix. `--audit-level` is deliberately
 * absent: the threshold lives in `BLOCKING_SEVERITIES` where a test can read it, rather
 * than in a flag whose effect is only visible in an exit code.
 *
 * Retries exist because a 503 from npmjs.org is usually seconds long, while the failure
 * it caused was seven minutes of npm's own internal retrying followed by a red required
 * check on every open pull request. A vulnerability is never retried -- it will say the
 * same thing three times, and pretending otherwise would delay the report.
 */
import { spawnSync } from 'node:child_process';
import { classifyAudit, describeVerdict } from './classify.mjs';

/** Attempts, and the backoff between them. Short: this is a build step, not a daemon. */
const ATTEMPTS = 3;
const BACKOFF_MS = [2000, 6000];

function runAudit() {
  const res = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    encoding: 'utf8',
    // npm writes the report to stdout and its own diagnostics to stderr. Only stdout is
    // classified; stderr is surfaced verbatim when the verdict is unreachable, because
    // that is where the 503 actually appears.
    maxBuffer: 32 * 1024 * 1024,
  });
  // A spawn that never ran leaves BOTH streams empty and puts the reason in `res.error`
  // -- npm missing from PATH, a permissions failure. Classified from stdout alone that
  // reads as "npm audit produced no output", which is true and useless: it sends whoever
  // is debugging towards the registry when the process never started. Folding the spawn
  // error into stderr keeps one unreachable verdict while making it say which kind.
  const stderr = res.error ? `${res.error.message}\n${res.stderr ?? ''}` : (res.stderr ?? '');
  return { stdout: res.stdout ?? '', stderr };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let last = null;
for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
  const { stdout, stderr } = runAudit();
  const verdict = classifyAudit(stdout);
  last = { verdict, stderr };

  if (verdict.kind !== 'unreachable') {
    console.log(describeVerdict(verdict));
    process.exit(verdict.kind === 'vulnerable' ? 1 : 0);
  }

  if (attempt < ATTEMPTS - 1) {
    const wait = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
    console.log(
      `${describeVerdict(verdict)}\n  attempt ${attempt + 1} of ${ATTEMPTS}; retrying in ${wait}ms`,
    );
    sleep(wait);
  }
}

// Still unreachable after every attempt. This FAILS rather than passing: a gate that
// waves the build through whenever the registry is down is not a gate. What it must not
// do is look like a vulnerability while doing it.
console.error(describeVerdict(last.verdict));
if (last.stderr.trim()) console.error(last.stderr.trim());
console.error(
  `\nThe tree was not audited -- npmjs.org did not answer after ${ATTEMPTS} attempts.\n` +
    'This is an infrastructure failure, not a finding. Re-run the job; if npm is down, wait.',
);
process.exit(1);
