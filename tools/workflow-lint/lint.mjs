/**
 * Static validation of the GitHub Actions workflows (issue #761): the pure half.
 *
 * `run.mjs` fetches pinned actionlint and shellcheck release binaries, checks them against
 * the SHA-256 digests below, and runs actionlint over every committed workflow. This module
 * holds everything that decision depends on and nothing that touches the network, so the
 * pins, the platform mapping, the digest check and the known-bad fixture contract are all
 * testable offline.
 *
 * WHY RELEASE BINARIES AND NOT AN npm PACKAGE. actionlint is a Go program; the npm package
 * named `actionlint` is a third-party WebAssembly build last published in 2022. The official
 * release archives are pinned by version and digest here instead, and cached under
 * node_modules/.cache, so the repository gains no dependency and every run on every machine
 * validates with the same two binaries.
 *
 * `tools/workflows.test.ts` stays the authority for this repository's own workflow policies.
 * This catches what GitHub would otherwise be the first to parse: malformed YAML, invalid
 * `${{ }}` expressions, unknown keys, malformed `uses:` references, and shell mistakes in
 * `run:` scripts.
 */
import { createHash } from 'node:crypto';

export const ACTIONLINT_VERSION = '1.7.12';
export const SHELLCHECK_VERSION = '0.11.0';

/**
 * Every archive the tool will run, by `${process.platform}-${process.arch}`. actionlint's
 * digests are copied from the release's own actionlint_1.7.12_checksums.txt. shellcheck
 * publishes no checksum file, so its digests were computed from the v0.11.0 release assets
 * as downloaded on 2026-09-17. A platform missing here is refused by name, not guessed.
 */
export const PINS = {
  'linux-x64': {
    actionlint: {
      url: `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz`,
      sha256: '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
      member: 'actionlint',
    },
    shellcheck: {
      url: `https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.gz`,
      sha256: 'b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6',
      member: `shellcheck-v${SHELLCHECK_VERSION}/shellcheck`,
    },
  },
  'linux-arm64': {
    actionlint: {
      url: `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_arm64.tar.gz`,
      sha256: '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6',
      member: 'actionlint',
    },
    shellcheck: {
      url: `https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.aarch64.tar.gz`,
      sha256: '68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc',
      member: `shellcheck-v${SHELLCHECK_VERSION}/shellcheck`,
    },
  },
  'darwin-x64': {
    actionlint: {
      url: `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_darwin_amd64.tar.gz`,
      sha256: '5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644',
      member: 'actionlint',
    },
    shellcheck: {
      url: `https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.darwin.x86_64.tar.gz`,
      sha256: 'c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51',
      member: `shellcheck-v${SHELLCHECK_VERSION}/shellcheck`,
    },
  },
  'darwin-arm64': {
    actionlint: {
      url: `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_darwin_arm64.tar.gz`,
      sha256: 'aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f',
      member: 'actionlint',
    },
    shellcheck: {
      url: `https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.darwin.aarch64.tar.gz`,
      sha256: '339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f',
      member: `shellcheck-v${SHELLCHECK_VERSION}/shellcheck`,
    },
  },
};

/** The pins for this machine, or an error naming the platform and the supported ones. */
export function pinsFor(platform, arch) {
  const key = `${platform}-${arch}`;
  const pins = PINS[key];
  if (!pins) {
    throw new Error(
      `workflow lint: no pinned actionlint/shellcheck for ${key}; supported: ${Object.keys(PINS).join(', ')}`,
    );
  }
  return pins;
}

/** Refuse bytes whose SHA-256 is not the pinned one. Returns the digest it computed. */
export function verifyDigest(bytes, expected, label) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(`workflow lint: ${label} has SHA-256 ${actual}, pinned ${expected}; refusing to run it`);
  }
  return actual;
}

/** The workflow files GitHub reads: `.yml` and `.yaml` directly under .github/workflows. */
export function workflowFiles(names) {
  return names.filter((name) => /\.ya?ml$/.test(name)).sort();
}

/**
 * The known-bad fixtures every run lints first, each with the actionlint rule it must trip.
 * If the validator stops reporting one -- a broken download, a flag that disables a check,
 * a version that no longer knows the rule -- the run fails before it can call the real
 * workflows clean.
 */
export const FIXTURES = [
  { file: 'malformed-yaml.yml', rule: 'syntax-check', why: 'malformed YAML' },
  { file: 'invalid-expression.yml', rule: 'expression', why: 'an invalid ${{ }} expression' },
  { file: 'unknown-key.yml', rule: 'syntax-check', why: 'a key the workflow schema does not have' },
  { file: 'action-without-ref.yml', rule: 'action', why: 'a `uses:` reference with no ref' },
  { file: 'shell-mistake.yml', rule: 'shellcheck', why: 'a shellcheck finding in a run: script' },
];

/**
 * Judge the fixture run from actionlint's JSON output (`-format '{{json .}}'`): every fixture
 * must report its rule. Returns the fixtures that did not, each with what was reported.
 */
export function unreportedFixtures(errors, fixtures = FIXTURES) {
  return fixtures
    .map((fixture) => {
      const mine = errors.filter((e) => e.filepath.split(/[\\/]/).pop() === fixture.file);
      return { fixture, reported: mine.map((e) => e.kind) };
    })
    .filter(({ fixture, reported }) => !reported.includes(fixture.rule));
}
