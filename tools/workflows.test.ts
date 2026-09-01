// The deploy workflow is a file no test read, which this repo already records as where
// defects live forever (`hud.css` lost a closing brace and nothing noticed for as long as
// the feature existed). `pages.yml` is worse than most, because its two failure modes are
// SILENT: drop the conclusion check and a red `main` publishes exactly as it used to;
// drop the `head_sha` and the deploy publishes a different commit than the one CI passed.
// Neither shows up as a red run. Both look like a successful deploy.
//
// WHAT THIS FILE DOES NOT DO: it reads the workflow as TEXT, not as YAML. The repo has no
// YAML parser and adding one for four assertions is not worth the dependency, so these
// check that the right words are present in the right block -- they cannot tell a
// correctly-parsed trigger from one that happens to contain the same substring. Treat a
// pass as "the wiring was not deleted", which is the regression actually being guarded,
// and not as "the workflow is valid". GitHub is the only thing that validates the YAML.
//
// EACH ASSERTION WAS RUN AGAINST THE MUTATION IT CLAIMS TO CATCH, and each kills exactly
// one test -- so none of these is riding on another's failure. Population: one mutation
// per assertion, plus the vacuity control.
//
//   re-add `on: push:` alongside workflow_run   -> triggers on CI completing
//   ... as `push:  # deploy on merge to main`   -> triggers on CI completing
//   ... as a quoted key, `"push":`              -> triggers on CI completing
//   delete `branches: [main]`                   -> triggers on CI completing
//   rename ci.yml's `name: CI`                  -> names the CI workflow exactly
//   delete `event == 'push'`                    -> refuses a CI run that came from a fork
//   delete the `head_repository` test           -> refuses a CI run that came from a fork
//   delete the `conclusion == 'success'` clause -> refuses a CI run that did not succeed
//   delete checkout's `ref:`                    -> checks out the commit CI ran on
//   truncate pages.yml to 0 bytes               -> all 6, via the load check
//   delete the Ubuntu mirror step                -> both mirror-configuration tests
//   priority mirror archive -> azure             -> prefers the non-Azure Ubuntu archive
//   delete either direct-source replacement      -> prefers the non-Azure Ubuntu archive
//   retries 3 -> 0                               -> bounds APT retries and network waits
//   delete either 20-second timeout              -> bounds APT retries and network waits
//   gate install-deps on cache-hit               -> installs Linux system dependencies unconditionally
//   delete the annotated failure                 -> reports an actionable dependency-install failure
//   timeout 60 -> 30                             -> gives the matrix a final 60-minute safety net
//   delete simulator identity / Safari warmup    -> identifies and settles the iOS Simulator
//   replace the openurl retry loop with one call -> retries transient Simulator URL failures
//   delete the EXIT trap or child-process kill   -> cleans up the beacon process tree
//   restore either old timeout                   -> gives beacon startup and reporting real headroom
//   restore the pre-#213 raw CI/Pages commands   -> canonical verification command assertions
//   point the floor smoke at `current`            -> normal-CI mutation split assertion
//   point the full manifest at `floor`            -> normal-CI mutation split assertion
//   restore the old node/push mutation condition  -> normal-CI mutation split assertion
//   add push/pull_request to mutation-floor.yml   -> scheduled-floor trigger assertion
//   widen 22.13.0 or replace full mutate command  -> scheduled-floor job assertion
//   parse a comment as an executable run line    -> executable-line extractor negative fixture
//   delete an issue-metadata trigger              -> issue-metadata trigger assertion
//   grant write access to the audit job           -> issue-metadata permission assertion
//   invoke the issue tool directly in workflow    -> canonical command assertion
//
// The three `push:` spellings are there because review DEFEATED the first version of that
// assertion, which required `push:` to be followed immediately by a newline. A trailing
// comment, a trailing space and a quoted key all restored a working push trigger with the
// guard green -- and in a file where every key carries a comment, the commented form is
// the likely way it comes back.
//
// This file also treats package.json's verification scripts as the workflow command API.
// It expands their npm-run graph so duplicate work, cycles, missing leaves, or drift
// between agents and CI fail at the same boundary.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const PAGES = read('.github/workflows/pages.yml');
const CI = read('.github/workflows/ci.yml');
const MUTATION_FLOOR = read('.github/workflows/mutation-floor.yml');
const ENGINES = read('.github/workflows/engines.yml');
const ISSUE_METADATA = read('.github/workflows/issue-metadata.yml');
const ISSUE_RELATIONSHIPS = read('.github/workflows/issue-relationship-migration.yml');
const CAPTURE = read('.github/workflows/capture.yml');
const BASELINE_RUN = read('tools/baseline/run.mjs');
const COMMAND_REFERENCE = read('docs/agent/commands-and-operations.md');

type ScriptTable = Record<string, string>;

const PACKAGE = JSON.parse(read('package.json')) as { scripts?: ScriptTable };
const SCRIPTS = PACKAGE.scripts ?? {};

const ATOMIC = {
  typecheck: 'tsc --noEmit',
  'test:unit': 'vitest run',
  build: 'vite build',
  portability: 'node tools/portability/check.mjs dist',
  'test:gl': 'node tools/gl/run.mjs',
  'trace:browser': 'node tools/baseline/run.mjs',
  visual: 'node tools/visual/verify.mjs dist --check',
  roundtrip: 'node tools/visual/roundtrip.mjs dist',
  mutate: 'node tools/mutate/run.mjs',
  'audit:prod': 'npm audit --omit=dev --audit-level=high',
  'issues:audit': 'node tools/issues/run.mjs audit',
  'issues:maintain': 'node tools/issues/run.mjs event',
  'issues:relationships': 'node tools/issues/migrate-relationships.mjs',
} as const;

const COMPOSITES = {
  test: 'npm run verify:quick --',
  'mutate:smoke': 'npm run mutate -- --only capture-prerequisite-error-drops-the-ci-pin',
  'verify:quick': 'npm run typecheck && npm run test:unit --',
  'verify:build': 'npm run build && npm run portability',
  'verify:visual':
    'npm run verify:build && npm run test:gl && npm run trace:browser && npm run visual && npm run roundtrip',
  'verify:full': 'npm run verify:quick && npm run mutate && npm run verify:build && npm run audit:prod',
} as const;

const BROWSER_LEAVES = ['test:gl', 'trace:browser', 'visual', 'roundtrip'] as const;
const DIRECT_BEACON_COMMAND = 'node tools/baseline/run.mjs --beacon --timeout 300000';

const referencedScripts = (command: string): string[] =>
  [...command.matchAll(/\bnpm run ([a-zA-Z0-9:_-]+)/g)].map((match) => match[1]);

function expandScript(name: string, scripts: ScriptTable, stack: string[] = []): string[] {
  const command = scripts[name];
  if (command === undefined) {
    throw new Error(`script '${stack.at(-1) ?? '<entry>'}' references missing script '${name}'`);
  }
  if (stack.includes(name)) {
    throw new Error(`script cycle: ${[...stack, name].join(' -> ')}`);
  }

  const references = referencedScripts(command);
  if (references.length === 0) return [name];
  return references.flatMap((reference) => expandScript(reference, scripts, [...stack, name]));
}

const duplicates = (names: string[]): string[] =>
  [...new Set(names.filter((name, index) => names.indexOf(name) !== index))].sort();

const browserLeaks = (names: string[]): string[] =>
  names.filter((name) => BROWSER_LEAVES.some((browserLeaf) => browserLeaf === name));

const namedStep = (workflow: string, name: string): string => {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) return '';
  const next = workflow.indexOf('\n      - name: ', start + marker.length);
  return workflow.slice(start, next < 0 ? workflow.length : next);
};

const jobBlock = (workflow: string, name: string): string => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marker = new RegExp(`^  ${escapedName}:[ \\t]*(?:#.*)?$`, 'm');
  const current = marker.exec(workflow);
  if (current === null) return '';
  const start = current.index;
  const next = /^  [a-zA-Z0-9_-]+:[ \t]*(?:#.*)?$/gm;
  next.lastIndex = start + current[0].length;
  const match = next.exec(workflow);
  return workflow.slice(start, match?.index ?? workflow.length);
};

const executableRunCommands = (workflow: string): string[] => {
  const lines = workflow.split('\n');
  const commands: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:-\s*)?run:\s*(.*?)\s*$/.exec(lines[index]);
    if (match === null) continue;

    const [, indentation, value] = match;
    if (!value.startsWith('|') && !value.startsWith('>')) {
      commands.push(value);
      continue;
    }

    const body: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === '') {
        body.push('');
        continue;
      }
      const bodyIndent = /^\s*/.exec(line)?.[0].length ?? 0;
      if (bodyIndent <= indentation.length) {
        index -= 1;
        break;
      }
      const commandLine = line.trimStart();
      if (!commandLine.trimStart().startsWith('#')) body.push(commandLine);
    }
    commands.push(body.join('\n').trim());
  }

  return commands;
};

describe('the canonical verification scripts', () => {
  it('loads a substantive script table', () => {
    expect(Object.keys(SCRIPTS).length).toBeGreaterThan(10);
  });

  it('keeps typecheck, unit test, build, and specialized operations atomic', () => {
    for (const [name, command] of Object.entries(ATOMIC)) {
      expect(SCRIPTS[name], name).toBe(command);
      expect(referencedScripts(command), `${name} must not hide another package script`).toEqual([]);
    }
  });

  it('keeps the compatibility alias and composites explicit and ordered', () => {
    for (const [name, command] of Object.entries(COMPOSITES)) {
      expect(SCRIPTS[name], name).toBe(command);
    }
  });

  it('preserves dash-prefixed Vitest arguments across both npm alias boundaries', () => {
    expect(SCRIPTS.test).toMatch(/npm run verify:quick --$/);
    expect(SCRIPTS['verify:quick']).toMatch(/npm run test:unit --$/);

    // These are the pre-fix forms: npm consumes appended flags at the nested boundary.
    expect('npm run verify:quick').not.toMatch(/ --$/);
    expect('npm run typecheck && npm run test:unit').not.toMatch(/ --$/);
  });

  it('resolves every package-script graph without missing references or cycles', () => {
    for (const name of Object.keys(SCRIPTS)) {
      expect(() => expandScript(name, SCRIPTS), name).not.toThrow();
    }
  });

  it('performs each atomic operation at most once in every canonical composite', () => {
    for (const name of Object.keys(COMPOSITES)) {
      const leaves = expandScript(name, SCRIPTS);
      expect(duplicates(leaves), `${name}: ${leaves.join(' -> ')}`).toEqual([]);
    }

    expect(expandScript('verify:quick', SCRIPTS)).toEqual(['typecheck', 'test:unit']);
    expect(expandScript('verify:build', SCRIPTS)).toEqual(['build', 'portability']);
    expect(expandScript('mutate:smoke', SCRIPTS)).toEqual(['mutate']);
    expect(expandScript('verify:full', SCRIPTS)).toEqual([
      'typecheck',
      'test:unit',
      'mutate',
      'build',
      'portability',
      'audit:prod',
    ]);
  });

  it('keeps browser verification explicit instead of hiding it in the core full gate', () => {
    expect(expandScript('verify:visual', SCRIPTS)).toEqual([
      'build',
      'portability',
      'test:gl',
      'trace:browser',
      'visual',
      // The session-lifecycle census (issue #480). A BROWSER leaf like the three above it,
      // so `browserLeaks` below has to know about it or `verify:full` could quietly acquire
      // a chromium dependency the "complete core, non-browser composite" promises it has not.
      'roundtrip',
    ]);
    expect(browserLeaks(expandScript('verify:full', SCRIPTS))).toEqual([]);
    expect(browserLeaks(['typecheck', 'visual'])).toEqual(['visual']);
    expect(browserLeaks(['test:gl', 'audit:prod'])).toEqual(['test:gl']);
    expect(COMMAND_REFERENCE).toMatch(/`verify:full` is the complete core, non-browser composite/);
  });

  it('documents every stable entry point with scope and approximate runtime', () => {
    for (const name of [
      'typecheck',
      'test:unit',
      'build',
      'mutate:smoke',
      'verify:quick',
      'verify:build',
      'verify:visual',
      'verify:full',
      'issues:audit',
    ]) {
      expect(COMMAND_REFERENCE, name).toContain(`npm run ${name}`);
    }
    expect(COMMAND_REFERENCE).toContain('Typical warm local runtime');
    expect(COMMAND_REFERENCE).toContain('Local full-manifest execution is exceptional');
    expect(COMMAND_REFERENCE).toMatch(/`verify \(current\)`\s+runs the complete mutation manifest/);
    expect(COMMAND_REFERENCE).toContain('not the routine local candidate gate');
  });

  it('proves the graph guard detects its duplicate, missing-reference, and cycle failures', () => {
    // Known-bad fixtures exercise the same helpers as the real-table assertions above.
    // Without them, a parser that returned [] for every command would make the guard green.
    const duplicate = {
      typecheck: 'tsc --noEmit',
      entry: 'npm run typecheck && npm run typecheck',
    };
    expect(duplicates(expandScript('entry', duplicate))).toEqual(['typecheck']);

    expect(() => expandScript('entry', { entry: 'npm run absent' })).toThrow(
      "references missing script 'absent'",
    );
    expect(() => expandScript('entry', {
      entry: 'npm run second',
      second: 'npm run entry',
    })).toThrow('script cycle: entry -> second -> entry');
  });
});

describe('the deploy workflow', () => {
  it('loads at all -- every assertion below is vacuous on an empty read', () => {
    // The `hud.css.test.ts` lesson: a guard that reads a file must first prove it read
    // one. `?raw` returning '' there made every assertion pass on nothing.
    expect(PAGES.length).toBeGreaterThan(1000);
    expect(CI.length).toBeGreaterThan(1000);
    expect(MUTATION_FLOOR.length).toBeGreaterThan(500);
  });

  it('triggers on CI completing, not on the push', () => {
    // The whole point of #132. `on: push` deploys whatever lands, green or red.
    expect(PAGES).toMatch(/^on:\n(?:.*\n)*?\s*workflow_run:\n/m);
    expect(PAGES).toMatch(/workflow_run:\n(?:\s*#.*\n)*\s*workflows: \[CI\]/);
    expect(PAGES).toMatch(/workflow_run:\n(?:.*\n)*?\s*types: \[completed\]/);
    // The one filter that separates the push-to-main CI run from every `pull_request`
    // run. Delete it and EVERY green CI run deploys, including a PR's -- the ref check
    // still passes, because under workflow_run the ref is the default branch.
    expect(PAGES).toMatch(/workflow_run:\n(?:.*\n)*?\s*branches: \[main\]/);
    // A `push:` trigger reintroduces the ungated path even with workflow_run present,
    // because the two would BOTH fire. Assert its absence, not just the new one's
    // presence -- adding a trigger is the easy mistake, removing one is deliberate.
    //
    // MATCHED LOOSELY ON PURPOSE. The first version of this required `push:` to be
    // followed immediately by a newline, and review defeated it three ways that are all
    // functioning triggers: a trailing comment (`push:  # deploy on merge`), a trailing
    // space, and a quoted key (`"push":`). In a file where every key carries a comment,
    // the commented form is the LIKELY way it comes back. Comment lines are safe from
    // this pattern because they start with `#`.
    expect(PAGES).not.toMatch(/^\s*["']?push["']?\s*:/m);
  });

  it('names the CI workflow exactly as ci.yml declares it', () => {
    // THE CROSS-FILE BREAK NOTHING ELSE CAN SEE. `workflows: [CI]` matches on the
    // workflow's `name:`, so renaming CI does not error anywhere -- the trigger simply
    // stops matching and the site silently stops updating. Derived from ci.yml rather
    // than hardcoded, so this fails on the rename instead of restating it.
    const declared = /^name: (.+)$/m.exec(CI)?.[1].trim();
    expect(declared, 'ci.yml has no top-level name:').toBeTruthy();
    expect(PAGES).toContain(`workflows: [${declared}]`);
  });

  it('refuses to deploy a CI run that came from a fork', () => {
    // THE ONE WITH A SECURITY CONSEQUENCE, and the one a `branches: [main]` filter does
    // NOT give you. A fork PR's CI run carries the FORK's branch name, so a PR opened
    // from a fork's own `main` matches every field the trigger filters on -- verified
    // against a repo that takes fork PRs, see the comment on the trigger. Without the
    // event test this workflow checks out `head_sha` (the fork's commit) and publishes
    // it to the live apex domain.
    expect(PAGES).toContain("github.event.workflow_run.event == 'push'");
    expect(PAGES).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
  });

  it('refuses to deploy a CI run that did not succeed', () => {
    // `workflow_run` fires on ANY completion. Without this the gate is decorative.
    expect(PAGES).toContain("github.event.workflow_run.conclusion == 'success'");
    // ...and the manual path must still be admitted, or workflow_dispatch becomes dead:
    // there is no workflow_run object on that path, so a bare conclusion test is false.
    expect(PAGES).toContain("github.event_name == 'workflow_dispatch'");
  });

  it('checks out the commit CI ran on, not the branch head', () => {
    // Under workflow_run, checkout's default ref is the DEFAULT BRANCH'S head. That is a
    // different commit whenever a second merge lands while the first is still in CI, and
    // deploying it publishes a commit whose CI has not finished.
    expect(PAGES).toMatch(/uses: actions\/checkout@v\d+\n\s*with:\n\s*ref: \$\{\{ github\.event\.workflow_run\.head_sha/);
  });
});

describe('canonical verification commands in workflows', () => {
  const ciVerify = jobBlock(CI, 'verify');
  const ciVisual = jobBlock(CI, 'visual');
  const fullFloor = jobBlock(MUTATION_FLOOR, 'full-floor');
  const pagesBuild = jobBlock(PAGES, 'build');

  it('keeps required jobs, scheduled floor verification, and the Pages build available to inspect', () => {
    expect(ciVerify).toContain('name: verify (${{ matrix.label }})');
    expect(ciVisual).not.toBe('');
    expect(fullFloor).toContain('name: mutation manifest (floor)');
    expect(pagesBuild).not.toBe('');
  });

  it('routes CI named steps through atomic package scripts without flattening conditions', () => {
    const expected = {
      Typecheck: 'npm run typecheck',
      Test: 'npm run test:unit',
      'Mutation harness smoke (floor)': 'npm run mutate:smoke',
      'Mutation manifest (full, current)': 'npm run mutate',
      Build: 'npm run build',
      'Assert the build is subpath-portable': 'npm run portability',
      'Audit production dependencies': 'npm run audit:prod',
    };
    for (const [name, command] of Object.entries(expected)) {
      expect(namedStep(ciVerify, name), name).toContain(`run: ${command}`);
    }
    expect(namedStep(ciVerify, 'Mutation harness smoke (floor)')).toContain("if: matrix.label == 'floor'");
    expect(namedStep(ciVerify, 'Mutation manifest (full, current)')).toContain("if: matrix.label == 'current'");
    expect(ciVerify).not.toContain("matrix.node == '24' || github.event_name == 'push'");
    expect(ciVerify).toContain("- label: floor\n            node: '22.13.0'");
    expect(ciVerify).toContain("- label: current\n            node: '24'");

    const visualExpected = {
      Build: 'npm run build',
      'GL tests (scene.ts)': 'npm run test:gl',
      'Baseline trace (chromium)': 'npm run trace:browser',
      'Visual check': 'npm run visual -- --out visual-out',
      'Session lifecycle round trip': 'npm run roundtrip',
    };
    for (const [name, command] of Object.entries(visualExpected)) {
      expect(namedStep(ciVisual, name), name).toContain(`run: ${command}`);
    }
  });

  it('runs the complete floor manifest only on a daily schedule or manual dispatch', () => {
    expect(MUTATION_FLOOR).toMatch(/^name: Mutation floor$/m);
    expect(MUTATION_FLOOR).toMatch(/^\s*schedule:\s*$/m);
    expect(MUTATION_FLOOR).toMatch(/^\s*workflow_dispatch:\s*$/m);
    expect(MUTATION_FLOOR).not.toMatch(/^\s*["']?(?:push|pull_request)["']?\s*:/m);

    const cron = /^\s*- cron: '([^']+)'$/m.exec(MUTATION_FLOOR)?.[1].split(/\s+/);
    expect(cron).toHaveLength(5);
    expect(cron?.slice(2)).toEqual(['*', '*', '*']);
    expect(cron?.[0]).toMatch(/^\d{1,2}$/);
    expect(cron?.[1]).toMatch(/^\d{1,2}$/);

    expect(fullFloor).toContain("node-version: '22.13.0'");
    expect(fullFloor).toContain('run: npm ci');
    expect(namedStep(fullFloor, 'Mutation manifest (full, floor)')).toContain('run: npm run mutate');
    expect(fullFloor).not.toContain('npm run mutate:smoke');
  });

  it('routes the ungated manual Pages checks through the same atomic scripts', () => {
    const expected = {
      Typecheck: 'npm run typecheck',
      Test: 'npm run test:unit',
      Build: 'npm run build',
      'Assert the build is subpath-portable': 'npm run portability',
      'Audit production dependencies': 'npm run audit:prod',
    };
    for (const [name, command] of Object.entries(expected)) {
      expect(namedStep(pagesBuild, name), name).toContain(`run: ${command}`);
    }
  });

  it('does not duplicate atomic tool commands in executable workflow run bodies', () => {
    expect(CI).not.toContain(DIRECT_BEACON_COMMAND);
    expect(PAGES).not.toContain(DIRECT_BEACON_COMMAND);
    expect(ENGINES.split(DIRECT_BEACON_COMMAND)).toHaveLength(2);

    const commands = [
      ...executableRunCommands(CI),
      ...executableRunCommands(MUTATION_FLOOR),
      ...executableRunCommands(PAGES),
      ...executableRunCommands(ENGINES),
      ...executableRunCommands(ISSUE_METADATA),
      ...executableRunCommands(ISSUE_RELATIONSHIPS),
    ].map((command) => command.replace(DIRECT_BEACON_COMMAND, ''));
    for (const forbidden of [
      'npx tsc --noEmit',
      'npx vitest run',
      'npx vite build',
      'node tools/gl/run.mjs',
      'node tools/baseline/run.mjs',
      'node tools/baseline/safari.mjs',
      'node tools/visual/verify.mjs',
      'node tools/mutate/run.mjs',
      'npm audit --omit=dev --audit-level=high',
      'node tools/issues/run.mjs',
      'node tools/issues/migrate-relationships.mjs',
    ]) {
      expect(commands.some((command) => command.includes(forbidden)), forbidden).toBe(false);
    }

    expect(namedStep(ENGINES, 'Run the golden trace + angle probe (Safari)')).toContain(
      'run: npm run trace:safari 2>&1 | tee trace-safari.log',
    );
  });

  it('proves the run extractor catches composite, flagged, and block-scalar raw commands', () => {
    const knownBad = [
      '# run: npm run typecheck',
      'steps:',
      '  - run: npx tsc --noEmit && npx vitest run --reporter=dot',
      '  - run: |',
      '      # npx vite build in a shell comment is not executable',
      '      npm ci',
      '      npx vite build --debug',
    ].join('\n');
    const commands = executableRunCommands(knownBad);
    expect(commands).toEqual([
      'npx tsc --noEmit && npx vitest run --reporter=dot',
      'npm ci\nnpx vite build --debug',
    ]);
    expect(commands.some((command) => command.includes('npx tsc --noEmit'))).toBe(true);
    expect(commands.some((command) => command.includes('npx vitest run'))).toBe(true);
    expect(commands.some((command) => command.includes('npx vite build'))).toBe(true);
  });

  it('keeps job blocks bounded when the following job key has a comment', () => {
    const knownBad = [
      'jobs:',
      '  verify:',
      '    steps:',
      '      - name: Verify only',
      '        run: npm run typecheck',
      '  visual: # independent required job',
      '    steps:',
      '      - name: Visual only',
      '        run: npm run visual',
    ].join('\n');
    expect(jobBlock(knownBad, 'verify')).toContain('Verify only');
    expect(jobBlock(knownBad, 'verify')).not.toContain('Visual only');
    expect(jobBlock(knownBad, 'visual')).toContain('Visual only');
  });
});

describe('issue backlog contract automation', () => {
  const maintain = jobBlock(ISSUE_METADATA, 'maintain');
  const audit = jobBlock(ISSUE_METADATA, 'audit');

  it('loads substantive workflow and package-command inputs', () => {
    expect(ISSUE_METADATA.length).toBeGreaterThan(1000);
    expect(maintain).not.toBe('');
    expect(audit).not.toBe('');
    expect(SCRIPTS['issues:audit']).toBe('node tools/issues/run.mjs audit');
    expect(SCRIPTS['issues:maintain']).toBe('node tools/issues/run.mjs event');
  });

  it('runs on relevant issue changes, manual dispatch, and a fallback schedule only', () => {
    expect(ISSUE_METADATA).toMatch(/^on:\n/m);
    expect(ISSUE_METADATA).toContain(
      'types: [opened, edited, reopened, labeled, unlabeled, closed]',
    );
    expect(ISSUE_METADATA).toContain("cron: '17 13 * * 1'");
    expect(ISSUE_METADATA).toMatch(/^\s*workflow_dispatch:\s*$/m);
    expect(ISSUE_METADATA).not.toMatch(/^\s*pull_request(?:_target)?:/m);
  });

  it('isolates write access to deterministic event maintenance', () => {
    expect(ISSUE_METADATA).toContain('permissions: {}');
    expect(maintain).toContain('contents: read');
    expect(maintain).toContain('issues: write');
    expect(audit).toContain('contents: read');
    expect(audit).toContain('issues: read');
    expect(audit).not.toContain('issues: write');
  });

  it('maintains only opened, edited, reopened, and closed issue events', () => {
    for (const action of ['opened', 'edited', 'reopened', 'closed']) {
      expect(maintain).toContain(`github.event.action == '${action}'`);
    }
    expect(maintain).not.toContain("github.event.action == 'labeled'");
    expect(maintain).not.toContain("github.event.action == 'unlabeled'");
    expect(namedStep(maintain, 'Maintain explicit issue metadata')).toContain(
      'run: npm run issues:maintain',
    );
  });

  it('always audits after the optional maintenance job through the package command', () => {
    expect(audit).toContain('needs: [maintain]');
    expect(audit).toContain('if: ${{ always() }}');
    expect(namedStep(audit, 'Audit open issue metadata and relationships')).toContain(
      'run: npm run issues:audit',
    );
    expect(ISSUE_METADATA).not.toContain('npm ci');
  });
});

describe('native issue relationship migration workflow', () => {
  const planJob = jobBlock(ISSUE_RELATIONSHIPS, 'plan');
  const rejectionJob = jobBlock(ISSUE_RELATIONSHIPS, 'reject-invalid-confirmation');
  const applyJob = jobBlock(ISSUE_RELATIONSHIPS, 'apply');

  it('loads a manual-only, serialized workflow through the atomic package command', () => {
    expect(ISSUE_RELATIONSHIPS.length).toBeGreaterThan(1_000);
    expect(SCRIPTS['issues:relationships']).toBe(
      'node tools/issues/migrate-relationships.mjs',
    );
    expect(ISSUE_RELATIONSHIPS).toMatch(/^on:\n\s+workflow_dispatch:\s*$/m);
    expect(ISSUE_RELATIONSHIPS).not.toMatch(/^\s*['"]?(?:push|pull_request|schedule)['"]?\s*:/m);
    expect(ISSUE_RELATIONSHIPS).toContain(
      'group: issue-relationship-migration-${{ github.repository }}',
    );
    expect(ISSUE_RELATIONSHIPS).toContain('cancel-in-progress: false');
  });

  it('keeps planning read-only and skips it on every apply dispatch', () => {
    expect(planJob).toContain('if: ${{ !inputs.apply }}');
    expect(planJob).toContain('timeout-minutes: 15');
    expect(planJob).toContain('issues: read');
    expect(planJob).not.toContain('issues: write');
    expect(namedStep(planJob, 'Inspect additive relationship plan')).toContain(
      'run: npm run issues:relationships',
    );
  });

  it('rejects bad confirmation without repository write permission or migration reads', () => {
    expect(rejectionJob).toContain(
      'if: ${{ inputs.apply && inputs.confirm_repository != github.repository }}',
    );
    expect(rejectionJob).toContain('timeout-minutes: 5');
    expect(rejectionJob).not.toContain('issues: write');
    expect(rejectionJob).not.toContain('issues:relationships');
  });

  it('bounds and isolates apply while passing the operator input to the strict tool guard', () => {
    expect(applyJob).toContain(
      'if: ${{ inputs.apply && inputs.confirm_repository == github.repository }}',
    );
    expect(applyJob).not.toContain('needs: [plan]');
    expect(applyJob).toContain('timeout-minutes: 30');
    expect(applyJob).toContain('issues: write');
    const step = namedStep(applyJob, 'Add missing relationships and verify all reviewed edges');
    expect(step).toContain(
      'run: npm run issues:relationships -- apply --confirm "$CONFIRM_REPOSITORY"',
    );
    expect(step).toContain('CONFIRM_REPOSITORY: ${{ inputs.confirm_repository }}');
    expect(step).not.toContain('--confirm "$GITHUB_REPOSITORY"');
  });
});

describe('the Engines Matrix Ubuntu dependency install', () => {
  it('loads at all -- the assertions below must not pass on an empty read', () => {
    expect(ENGINES.length).toBeGreaterThan(1000);
  });

  it('prefers the non-Azure Ubuntu archive', () => {
    const step = namedStep(ENGINES, 'Prefer the Ubuntu archive and bound APT network waits');
    expect(step).not.toBe('');
    expect(step).toContain("if: runner.os == 'Linux'");
    expect(step).toContain('/etc/apt/apt-mirrors.txt');
    expect(step).toContain("printf '%s\\tpriority:1\\n' 'https://archive.ubuntu.com/ubuntu/'");
    expect(step).toContain(
      "s|http://azure\\.archive\\.ubuntu\\.com/ubuntu/|https://archive.ubuntu.com/ubuntu/|g",
    );
    expect(step).toContain(
      "s|https://azure\\.archive\\.ubuntu\\.com/ubuntu/|https://archive.ubuntu.com/ubuntu/|g",
    );
    expect(step).toContain('APT mirror configuration failed');
  });

  it('bounds APT retries and network waits', () => {
    const step = namedStep(ENGINES, 'Prefer the Ubuntu archive and bound APT network waits');
    expect(step).toContain('Acquire::Retries "3";');
    expect(step).toContain('Acquire::http::Timeout "20";');
    expect(step).toContain('Acquire::https::Timeout "20";');
  });

  it('installs Linux system dependencies unconditionally and reports a useful failure', () => {
    const step = namedStep(ENGINES, 'Install system dependencies (Linux)');
    expect(step).not.toBe('');
    expect(step).toContain("if: runner.os == 'Linux'");
    expect(step).not.toContain('cache-hit');
    expect(step).toContain('npx playwright install-deps chromium firefox webkit');
    expect(step).toContain('::error title=Playwright system dependency installation failed::');
  });

  it('gives the matrix a final 60-minute safety net', () => {
    const start = ENGINES.indexOf('  engines:\n');
    const end = ENGINES.indexOf('    strategy:\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(ENGINES.slice(start, end)).toContain('timeout-minutes: 60');
  });
});

describe('the Engines Matrix iOS Simulator beacon', () => {
  it('identifies the selected Simulator and gives Mobile Safari time to settle', () => {
    const step = namedStep(ENGINES, 'Pick and boot a simulator');
    expect(step).toContain('node tools/baseline/find-simulator.mjs --details');
    expect(step).toContain('SIM_NAME');
    expect(step).toContain('SIM_RUNTIME');
    expect(step).toContain(
      'if ! WARM_OUTPUT=$(xcrun simctl launch "$UDID" com.apple.mobilesafari 2>&1); then',
    );
    expect(step).toContain('sleep 60');
  });

  it('retries a transient simctl openurl failure and diagnoses exhausted retries', () => {
    const step = namedStep(ENGINES, 'Open the beacon URL in the Simulator and wait for its report');
    expect(step).toContain('OPENURL_MAX_ATTEMPTS=3');
    expect(step).toContain('for ATTEMPT in $(seq 1 "$OPENURL_MAX_ATTEMPTS")');
    expect(step).toContain(
      'if OPENURL_OUTPUT=$(xcrun simctl openurl "$SIM_UDID" "$URL" 2>&1); then',
    );
    expect(step).toContain("ANNOTATION_ERROR=${FINAL_OPENURL_ERROR//'%'/'%25'}");
    expect(step).toContain(
      'iOS Simulator URL launch failed::$SIM_NAME ($SIM_RUNTIME, $SIM_UDID) exhausted $OPENURL_MAX_ATTEMPTS attempts; final simctl exit $FINAL_OPENURL_EXIT: $ANNOTATION_ERROR',
    );
  });

  it('cleans up the beacon runner and its Vite child on every exit path', () => {
    const step = namedStep(ENGINES, 'Open the beacon URL in the Simulator and wait for its report');
    expect(step).toContain('trap cleanup EXIT');
    expect(step).toContain('pkill -TERM -P "$RUNNER_PID"');
    expect(step).toContain('kill -TERM "$RUNNER_PID"');
    expect(step).toContain('cat beacon-ios.log');
  });

  it('gives beacon-mode Vite startup and the Mobile Safari report real headroom', () => {
    const step = namedStep(ENGINES, 'Open the beacon URL in the Simulator and wait for its report');
    // This stays direct: the cleanup trap must own run.mjs's PID and its Vite child,
    // rather than an npm wrapper process that can orphan the actual runner on failure.
    expect(step).toContain(DIRECT_BEACON_COMMAND);
    expect(BASELINE_RUN).toContain('waitForVite(BASE, vite, { timeoutMs: 90_000 })');
  });

  it('still gates on the beacon runner that checks the golden and vendored hashes', () => {
    const step = namedStep(ENGINES, 'Open the beacon URL in the Simulator and wait for its report');
    expect(step).toContain(
      'set +e\n          wait "$RUNNER_PID"\n          BEACON_EXIT=$?\n          set -e\n          RUNNER_PID=""\n          exit "$BEACON_EXIT"',
    );
  });
});

// ---------------------------------------------------------------------------
// capture.yml (issue #343): manually dispatched capture/compare runs.
//
// Same TEXT-not-YAML caveat as everything above. What makes this file worth guarding is
// that its two worst failure modes are silent in the same way pages.yml's are: a widened
// permission still captures perfectly, and a recipe list that has drifted from the registry
// still runs the recipes it does list. Neither shows up as a red run.
//
// EACH ASSERTION WAS RUN AGAINST THE MUTATION IT CLAIMS TO CATCH:
//   add a 5th id to recipes.json only          -> offers exactly the committed recipes
//   `contents: read` -> `contents: write`      -> grants no write permission
//   add `pull_request_target:`                 -> is dispatch-only, so required CI is untouched
//   add `push:`                                -> is dispatch-only, so required CI is untouched
//   interpolate ${{ inputs.ref }} into a script -> passes every input through env
//   retention-days 14 -> 90                    -> bounds artifact retention and job runtime
//   delete timeout-minutes                     -> bounds artifact retention and job runtime
//   playwright 1.62.0 -> 1.63.0 in capture.yml -> pins the same browser the visual job pins
// ---------------------------------------------------------------------------
describe('capture.yml: the on-demand capture workflow', () => {
  it('offers exactly the recipes committed to the registry, and no others', () => {
    // THE drift guard. A `choice` input is an allowlist expressed in YAML, so it is a second
    // copy of a list that already exists in tools/capture/recipes.json -- and a copy that
    // silently omits a recipe is invisible: every run still works, the missing one simply
    // cannot be dispatched. Compared as SETS, so ordering in either file is free to change.
    const registry = JSON.parse(read('tools/capture/recipes.json')) as { id: string }[];
    const ids = registry.map((r) => r.id);
    expect(ids.length, 'the registry is empty; this test would pass vacuously').toBeGreaterThan(0);
    const block = CAPTURE.slice(CAPTURE.indexOf('      recipe:'), CAPTURE.indexOf('      ref:'));
    const offered = [...block.matchAll(/^ {10}- (\S+)$/gm)].map((m) => m[1]);
    expect(new Set(offered)).toEqual(new Set(ids));
    expect(offered).toHaveLength(ids.length);
  });

  it('grants no write permission', () => {
    // `permissions:` at the top level, so no job can widen it. The workflow pushes nothing,
    // opens nothing and comments nowhere -- issue #343's security section.
    expect(CAPTURE).toContain('permissions:\n  contents: read\n');
    expect(CAPTURE, 'a write permission appeared').not.toMatch(/:\s*write\b/);
    expect(CAPTURE, 'a token was exposed to the run').not.toContain('secrets.');
  });

  it('is dispatch-only, so the required checks are untouched', () => {
    // `pull_request_target` runs untrusted code with a writable token, which is the one
    // combination this must never have. `push`/`pull_request` would put a capture on the
    // critical path of every change, which #343's last criterion forbids.
    const triggers = CAPTURE.slice(CAPTURE.indexOf('\non:'), CAPTURE.indexOf('\npermissions:'));
    expect(triggers).toContain('workflow_dispatch:');
    for (const forbidden of ['pull_request_target:', 'pull_request:', 'push:', 'schedule:']) {
      expect(triggers, `capture.yml triggers on ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('passes every input through env rather than into script text', () => {
    // A `choice` input cannot carry shell metacharacters, but `ref`, `base` and `head` are
    // `string` inputs. Interpolating any of them into a `run:` body puts attacker-controlled
    // text into the script itself, where quoting is the only thing between it and execution.
    // Asserted over the whole file rather than per step, because the mistake is adding a NEW
    // step that interpolates -- the existing ones are already correct.
    // Block-scalar bodies are the lines indented FURTHER than their own `run:` key, up to
    // the first line that is not. A single greedy regex swallows every later block into the
    // first one -- measured: it found 1 body where the file has 6 -- so the bodies are cut
    // by indentation instead, and the count is asserted against a grep of the same file.
    const lines = CAPTURE.split('\n');
    const runBodies: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const open = /^(\s*)run: \|\s*$/.exec(lines[i]);
      if (!open) continue;
      const indent = open[1].length;
      const body: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() !== '' && (l.length - l.trimStart().length) <= indent) break;
        body.push(l);
      }
      runBodies.push(body.join('\n'));
    }
    expect(runBodies.length, 'no run blocks found; this test would pass vacuously')
      .toBe((CAPTURE.match(/^\s*run: \|\s*$/gm) ?? []).length);
    expect(runBodies.length).toBeGreaterThan(3);
    for (const body of runBodies) {
      expect(body, 'an input is interpolated into a run: script').not.toMatch(/\$\{\{\s*inputs\./);
      expect(body, 'a github context value is interpolated into a run: script').not.toMatch(/\$\{\{\s*github\./);
    }
  });

  it('bounds artifact retention and job runtime', () => {
    // Both are explicit acceptance criteria. Retention is the one that costs storage
    // silently; the timeout is what turns a hung browser into a readable failure.
    expect(CAPTURE).toContain('retention-days: 14');
    expect(CAPTURE).toMatch(/timeout-minutes: \d+/);
    expect(CAPTURE).toContain('concurrency:');
    // NOT cancel-in-progress: a half-finished capture is the "partial capture reported as
    // successful" this issue forbids.
    expect(CAPTURE).toContain('cancel-in-progress: false');
  });

  it('pins the same browser the visual job pins', () => {
    // A capture that renders differently from the required `visual` check is evidence about
    // a browser nobody gates on. Read from CI rather than hardcoded here, so a deliberate
    // bump in one file is a red suite until the other follows.
    const pin = /playwright@(\d+\.\d+\.\d+)/;
    const ciPin = CI.match(pin)?.[1];
    expect(ciPin, 'ci.yml no longer pins playwright').toBeDefined();
    expect(CAPTURE.match(pin)?.[1], 'capture.yml and ci.yml pin different Playwright versions').toBe(ciPin);
    expect(CAPTURE).toContain(`playwright-chromium-${ciPin}-`);
  });

  it('reuses the committed runners instead of reimplementing capture in YAML', () => {
    // #343: "Reuse #342/#335 commands rather than reimplementing capture logic in workflow
    // YAML." A shell reimplementation would be a second definition of the artifact contract.
    expect(CAPTURE).toContain('npm run capture --');
    expect(CAPTURE).toContain('npm run capture:compare --');
    expect(CAPTURE, 'the workflow drives a browser directly').not.toContain('npx playwright test');
  });
});
