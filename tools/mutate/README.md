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

This package carries no manifest of its own: the manifest is project data, not part of
the tool, and lives in the project that uses it (in this repo, one file per area under
`tools/mutate/manifests/` -- `sim.json`, `game.json`, `render.json`, `input.json`,
`presentation.json`, `audio.json`, `app.json` for `src/` root files, `tools.json` -- read
as one set in filename order, wired up by the root `mutate` npm script; issue #505). An
entry lives in the file of the area its mutated `file` belongs to, so a PR appends to
its own area's file and two PRs in different areas never conflict; an id present in two
files is refused with both paths named.

## Usage

```
mutate                                    # tools/mutate/manifests/*.json under --root, all entries
mutate --manifest path/to/manifest.json   # a different manifest: one file, or a directory of *.json files
mutate --only some-manifest-entry-id      # a single entry
mutate --jobs auto                        # the worktree pool: N serial harnesses, one per detached worktree
mutate --report out.json                  # per-entry outcomes and failed test names, for tooling
mutate --changed origin/main [--list]     # only the entries the diff since that ref can affect (--list: show, do not run)
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

## Naming the killer (`killedBy`)

A `killed` entry pins its contract one of two ways (issue #504). `killedBy` lists the
vitest full names (`describe` titles and the `it` title joined by spaces, exactly as the
JSON reporter's `fullName`) of the tests that must fail under the mutation; other failures
are allowed, so adding tests to the scoped file never invalidates the pin, and a named
test that passes under the mutation is reported by name. `expectFailures` pins the exact
failure count instead, for entries whose rationale states a population ("N of M across
..."). An entry carries one or the other, never both; the harness also accepts neither
(outcome-only) for fixtures, but the repository's own test refuses that form in the
shipped manifest.

`--report path.json` writes one record per entry (outcome, counts, the failed test
names) after a run; `tools/mutate/migrate-killed-by.mjs` turns such a report into
`killedBy` lists for every counted entry without a population claim.

## Selecting by change (`--changed`)

`--changed <ref>` narrows a run to the entries the diff between `ref`'s merge base and
HEAD can affect (issue #506), printing each with its reasons: the entry's mutated file
or a scoped test is in the diff; the entry's own text changed or it is new (compared
against the manifest at the merge base, through git); a scoped test imports a changed
module (the reachability worker's graph, asked for every changed source that still
exists); or a file the entry declares in `reads` changed -- the one input the graph
cannot see, a test reading a file through `fs`. A change under `tools/mutate/` (other
than the manifests), to `vite.config.*`, `package.json`, `package-lock.json`,
`tsconfig*.json` or `.github/workflows/` runs everything. `--list` prints the selection
without running it. Pull-request CI uses this; pushes to `main` run the complete set.

## The worktree pool (`--jobs`)

`--jobs N` (or `auto`, one fewer than the machine's cores) runs the manifest over N
workers at once (issue #502). Entries cannot share a checkout while mutated, so each
worker is this same serial harness in its own detached `git worktree` of HEAD with
`node_modules` linked from the checkout; the parent partitions entries by exact test
scope (a scope is never split, so it is still baselined once), relays each worker's
output under a `[wN]` prefix, folds the exit codes worst-first (restore failure,
interruption, mid-run error, refusal, mismatch) and removes the worktrees. A worker whose
restore failed keeps its worktree and names it. Scopes are dealt costliest-first by
`scope-costs.json`, the median seconds per entry of each scope from a previous
`--report` run (`node tools/mutate/scope-costs.mjs <report.json>` regenerates it; a
scope it does not know costs the median), so the workers finish together instead of one
carrying the hud scope alone (issue #507).

Because a worktree of HEAD cannot see uncommitted edits, the pool tests the COMMITTED tree
and refuses to start with any tracked file dirty -- stricter than the serial path, which
checks only the files it mutates. Interrupting the pool is safe: the worktrees are
throwaways, and the checkout itself is never mutated.

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
