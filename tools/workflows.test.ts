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
//
// The three `push:` spellings are there because review DEFEATED the first version of that
// assertion, which required `push:` to be followed immediately by a newline. A trailing
// comment, a trailing space and a quoted key all restored a working push trigger with the
// guard green -- and in a file where every key carries a comment, the commented form is
// the likely way it comes back.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const PAGES = read('.github/workflows/pages.yml');
const CI = read('.github/workflows/ci.yml');

describe('the deploy workflow', () => {
  it('loads at all -- every assertion below is vacuous on an empty read', () => {
    // The `hud.css.test.ts` lesson: a guard that reads a file must first prove it read
    // one. `?raw` returning '' there made every assertion pass on nothing.
    expect(PAGES.length).toBeGreaterThan(1000);
    expect(CI.length).toBeGreaterThan(1000);
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
