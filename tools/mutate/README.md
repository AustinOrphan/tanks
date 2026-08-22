# mutation-harness

Hand-picked mutation testing: for each entry in a manifest (an exact find/replace
against a source file, a declared `killed`/`survives` outcome, an optional
`expectFailures` count, a `why`, and a scoped list of `tests`) this tool verifies the
find/replace actually changed the file's bytes, runs a baseline check on the unmutated
file first, refuses to start if the declared `tests` cannot reach the mutated file
(checked via `vitest related`), applies the mutation, runs the scoped tests, and
restores the original bytes -- verified by reading them back, not by a zero exit code.
See the doc comment at the top of `run.mjs` for the full contract, exit codes, and the
false-positive failure mode this exists to catch.

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
path, every `file`/`tests` path an entry names, and the `vitest`/`git` binaries it
shells out to are all resolved under it. It defaults to `process.cwd()`, which is
already correct for the common case -- an `npm run` script's cwd is the directory
holding the `package.json` that defines the script -- and exists as a flag for every
other caller (a bin invoked from a subdirectory, a script that `cd`s first).

## Runner: vitest only, on purpose

This tool shells out to a real `vitest` binary (`<root>/node_modules/.bin/vitest`) for
both the reachability preflight (`vitest related`) and the scoped test runs
(`vitest run --reporter=json`), and reads vitest's own JSON reporter output rather than
parsing text. That is a deliberate, stated scope, not an oversight: a Jest (or other
runner) adapter is a real possible extension, but nothing here abstracts over "a test
runner" today, and adding that abstraction before a second runner actually needs it
would be speculative. If this tool ever needs to run under something other than
vitest, that is a new adapter alongside `runTestsReal`/`relatedFilesFor`, not a rewrite
of `orchestrate.mjs` (which only depends on the `{ failed, total, failedSuites }` shape
those two functions produce, injected through `deps`).

vitest is required at runtime but deliberately NOT declared as a `peerDependencies`
entry in `package.json`: it is resolved as a binary path
(`<root>/node_modules/.bin/vitest`), never imported as JS, so a formal dependency
declaration buys no resolution correctness here -- and it has a real, measured cost.
Declaring it created a non-dev edge from this (non-dev) workspace package to vitest,
which pulled vitest's own dev-only transitive dependencies (postcss, nanoid) out of
their `"dev": true` classification in `package-lock.json`. `npm run audit:prod`
audits by that classification, not by resolved version, so those packages' advisories
started failing a gate that is specifically designed to stay green on dev-only CVEs
(see `ci.yml`'s "Audit production dependencies" step). Confirmed by reverting the
field and re-locking: the audit returns to 0 vulnerabilities. If a future change adds a
real dependency edge from this package to anything in the app's own devDependency
subtree, re-run `npm run audit:prod` before landing it.

## Distribution

Not published to npm. This is a local npm workspace package (see the root
`package.json`'s `workspaces` field) -- that gets the same import/dependency boundary a
published package would have (an empty `dependencies` block means nothing here can
accidentally reach into the app it mutates) without the release overhead a package
nobody outside this repo currently needs would cost. Publishing is a separate,
outward-facing decision for later.

## Typechecking

`orchestrate.test.ts` is a `.ts` file and is included in the project root's
`tsconfig.json`, so it is typechecked by `npm run typecheck`, which is included in
`npm test`, `npm run verify:quick`, and `npm run verify:full`. `npm run build` is
deliberately build-only. `allowJs`/`checkJs` also pull `run.mjs`, `lib.mjs` and
`orchestrate.mjs` into that same typecheck, all three as `orchestrate.test.ts`'s own
direct value-level imports -- see the root `tsconfig.json` and `CLAUDE.md` for what
that surfaced and what is still deferred.
