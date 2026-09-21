/**
 * `npm run lint:workflows` (issue #761): statically validate every GitHub Actions workflow.
 *
 * 1. Resolve the pinned actionlint and shellcheck archives for this machine (lint.mjs).
 * 2. Use the cached binaries under node_modules/.cache/tanks-workflow-lint, or download the
 *    archive, refuse it unless its SHA-256 matches the pin, and extract the one binary.
 * 3. Lint the known-bad fixtures in ./fixtures and require each to report its rule, so a
 *    validator that has silently stopped validating fails here instead of passing the repo.
 * 4. Lint every .yml/.yaml file in .github/workflows with shellcheck enabled, printing
 *    actionlint's own file:line:column report. Exit 1 on any finding.
 *
 * pyflakes is disabled explicitly: no workflow runs a Python step, and leaving it to PATH
 * would make the result depend on what happens to be installed.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ACTIONLINT_VERSION,
  DOWNLOAD_ATTEMPTS,
  FIXTURES,
  SHELLCHECK_VERSION,
  backoffMs,
  pinsFor,
  retryableStatus,
  unreportedFixtures,
  verifyDigest,
  workflowFiles,
} from './lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CACHE = join(ROOT, 'node_modules', '.cache', 'tanks-workflow-lint');

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The binary for one pin, downloading and verifying it on first use. */
async function binary(name, version, pin) {
  const dir = join(CACHE, `${name}-${version}-${process.platform}-${process.arch}`);
  const exe = join(dir, pin.member);
  if (existsSync(exe)) return exe;

  // Retried, not because the network is unreliable in general but because this one is a
  // required check: see DOWNLOAD_ATTEMPTS in lint.mjs for the failure it is here to absorb.
  // The digest check below is unchanged, so a retry can only change whether the archive
  // arrives, never which archive is accepted.
  let bytes = null;
  let lastFailure = '';
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(backoffMs(attempt - 1));
    let response;
    try {
      response = await fetch(pin.url);
    } catch (error) {
      lastFailure = `${error.message ?? error}`;
      continue; // A thrown fetch is a transport failure, which is exactly the retryable kind.
    }
    if (response.ok) {
      bytes = Buffer.from(await response.arrayBuffer());
      break;
    }
    lastFailure = `HTTP ${response.status}`;
    if (!retryableStatus(response.status)) break;
  }
  if (bytes === null) {
    fail(`workflow lint: downloading ${pin.url} failed with ${lastFailure}`
      + ` after ${DOWNLOAD_ATTEMPTS} attempt(s)`);
  }
  verifyDigest(bytes, pin.sha256, `${name} ${version} archive`);

  // Extract into a sibling directory and rename into place, so an interrupted run never
  // leaves a half-written binary where the next run would trust it.
  const staging = `${dir}.partial-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = join(staging, 'archive.tar.gz');
  writeFileSync(archive, bytes);
  const tar = spawnSync('tar', ['-xzf', archive, '-C', staging, pin.member], { encoding: 'utf8' });
  if (tar.status !== 0) fail(`workflow lint: extracting ${pin.member} failed: ${tar.stderr || tar.error?.message}`);
  rmSync(archive);
  chmodSync(join(staging, pin.member), 0o755);
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  return exe;
}

function actionlint(exe, shellcheck, args) {
  return spawnSync(exe, ['-no-color', '-shellcheck', shellcheck, '-pyflakes=', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

let pins;
try {
  pins = pinsFor(process.platform, process.arch);
} catch (error) {
  fail(error.message);
}
const lint = await binary('actionlint', ACTIONLINT_VERSION, pins.actionlint).catch((e) => fail(e.message));
const shellcheck = await binary('shellcheck', SHELLCHECK_VERSION, pins.shellcheck).catch((e) => fail(e.message));

// Known-bad fixtures first. actionlint exits 1 when it finds anything, which is the point
// here; only an exit above 1 (a crash, a bad flag) or a missing rule is a failure.
const fixturePaths = FIXTURES.map((f) => relative(ROOT, join(HERE, 'fixtures', f.file)));
const probe = actionlint(lint, shellcheck, ['-format', '{{json .}}', ...fixturePaths]);
if (probe.status !== 1) {
  fail(`workflow lint: the fixture run exited ${probe.status}, expected 1\n${probe.stderr}${probe.stdout}`);
}
let errors;
try {
  errors = JSON.parse(probe.stdout);
} catch {
  fail(`workflow lint: the fixture run did not print JSON\n${probe.stdout}`);
}
const missed = unreportedFixtures(errors);
if (missed.length > 0) {
  fail(
    'workflow lint: the validator did not report every known-bad fixture, so a clean result would mean nothing:\n'
      + missed
        .map(({ fixture, reported }) => `  ${fixture.file} (${fixture.why}): expected [${fixture.rule}], reported [${reported.join(', ') || 'nothing'}]`)
        .join('\n'),
  );
}

const workflowsDir = join(ROOT, '.github', 'workflows');
const files = workflowFiles(readdirSync(workflowsDir)).map((name) => relative(ROOT, join(workflowsDir, name)));
if (files.length === 0) fail('workflow lint: no workflow files found under .github/workflows');
const result = actionlint(lint, shellcheck, files);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) {
  fail(`workflow lint: actionlint ${ACTIONLINT_VERSION} (shellcheck ${SHELLCHECK_VERSION}) exited ${result.status} over ${files.length} workflow file(s)`);
}
console.log(
  `workflow lint: ${files.length} workflow file(s) clean under actionlint ${ACTIONLINT_VERSION} with shellcheck ${SHELLCHECK_VERSION}; `
    + `${FIXTURES.length} of ${FIXTURES.length} known-bad fixtures reported their rule`,
);
