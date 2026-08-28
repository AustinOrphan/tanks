# mutation-harness

Hand-picked mutation testing: for each entry in a manifest (an exact find/replace
against a source file, a declared `killed`/`survives` outcome, an optional
`expectFailures` count, a `why`, and a scoped list of `tests`) this tool verifies the
find/replace actually changed the file's bytes, runs a baseline check on the unmutated
file first (reused within that invocation for later entries with the exact same ordered
`tests` scope), refuses to start if the declared `tests` cannot reach the mutated file,
applies the mutation, runs the scoped tests, and restores the original bytes -- verified
by reading them back, not by a zero exit code. See the doc comment at the top of
`run.mjs` for the full contract, exit codes, and the false-positive failure mode this
exists to catch.

This package carries no manifest of its own: `manifest.json` is project data, not part
of the tool, and lives in the project that uses it (in this repo, at
`tools/mutate/manifest.json`, wired up by the root `mutate` npm script).

## Usage

```
mutate                                    # tools/mutate/manifest.json under --root, all entries
mutate --manifest path/to/manifest.json   # a different manifest (absolute or --root-relative)
mutate --only some-manifest-entry-id      # a single entry
mutate --root /path/to/checkout           # explicit project root (default: process.cwd())
```

`--root` is how this tool locates the project it is mutating: the manifest's default
path and every `file`/`tests` path an entry names are resolved under it, the scoped
Vitest binary comes from `<root>/node_modules`, and Git runs with that root as its
working directory. The reachability worker itself belongs to this package and imports
this workspace's declared Vitest dev dependency. `--root` defaults to `process.cwd()`,
which is already correct for the common case -- an `npm run` script's cwd is the
directory holding the `package.json` that defines the script -- and exists as a flag
for every other caller (a bin invoked from a subdirectory, a script that `cd`s first).

## Repository CI use

The root `npm run mutate:smoke` script selects
`capture-prerequisite-error-drops-the-ci-pin` for the normal Node 22.13.0 floor lane.
That entry has a four-test, browser-free scope and drives the real CLI through
manifest validation, `--only` selection, git cleanliness, Vitest reachability, a green
baseline, mutation application, real test failure, declared-count matching, and
byte-verified restoration. The normal unit suite separately runs the harness's own
fake-dependency and real-subprocess tests in `orchestrate.test.ts`.

This is representative compatibility coverage, not a claim that normal floor CI ran
every manifest entry. `verify (current)` runs the complete manifest under Node 24 on
pull requests and pushes to `main`. `.github/workflows/mutation-floor.yml` runs the
complete manifest under exact Node 22.13.0 daily against `main` and on manual dispatch;
that complementary workflow is not a required pull-request check. A red scheduled run
is a floor-runtime or manifest-contract failure that requires investigation in GitHub
Actions.

## Runner: Vitest only, on purpose

Reachability and test execution use Vitest in two different ways:

- `reachability.mjs` runs once in a timeout-bounded Node subprocess, creates one Vitest
  context, and asks Vitest's public `getRelevantTestSpecifications` API a separate
  question for every distinct mutation source. The shared context keeps Vite's
  transformed dependency graph warm; the separate results preserve the proof that an
  entry's declared tests reach that specific source. A multi-source union would not.
- `runTestsReal` shells out to `<root>/node_modules/.bin/vitest` for each scoped test run
  and reads `vitest run --reporter=json` output rather than parsing terminal text.

That is a deliberate, stated scope, not an oversight: a Jest (or other runner) adapter
would be a real extension, but nothing here abstracts over "a test runner" today. Vitest
is now an explicit `devDependency` of this private workspace package because the
reachability worker imports `vitest/node` as JavaScript. It must remain a dev-only edge:
moving it to `dependencies` or `peerDependencies` can reclassify Vitest's transitive
packages as production dependencies and make `npm run audit:prod` audit the wrong
surface. Re-run that audit whenever this dependency boundary changes.

For a manifest with `N` entries, `F` distinct mutation sources, and `S` exact ordered
test scopes, the steady-state process model is one reachability worker with `F`
per-source graph queries, then at most `S` baseline subprocesses and `N` mutated-test
subprocesses. A baseline is cached only after it completes and only within the current
manifest invocation. Before `runManifest` can move to an entry that reuses it, `runOne`
either left the source bytes untouched or byte-verified restoration after the mutation;
a restore failure stops the manifest immediately.

## Distribution

Not published to npm. This is a local npm workspace package (see the root
`package.json`'s `workspaces` field) -- that gets the same production dependency
boundary a published package would have (there is still no `dependencies` block; the
Vitest import is explicitly dev-only) without the release overhead a package nobody
outside this repo currently needs would cost. Publishing is a separate, outward-facing
decision for later.

## Typechecking

`orchestrate.test.ts` is a `.ts` file and is included in the project root's
`tsconfig.json`, so it is typechecked by `npm run typecheck`, which is included in
`npm test`, `npm run verify:quick`, and `npm run verify:full`. `npm run build` is
deliberately build-only. `allowJs`/`checkJs` also pull `run.mjs`, `lib.mjs`,
`orchestrate.mjs`, and `reachability.mjs` into that same typecheck through
`orchestrate.test.ts`'s direct value-level imports -- see the root `tsconfig.json` and
`CLAUDE.md` for what that surfaced and what is still deferred.
