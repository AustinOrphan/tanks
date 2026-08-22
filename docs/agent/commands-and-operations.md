# Commands and operations reference

On-demand detail for repository tools, CI, deployment, and branch protection. For the short command entry points, start in `CLAUDE.md`.

## Commands

```
npm test     # tsc --noEmit && vitest run
npm run build # tsc --noEmit && vite build
npm run dev   # vite
npm run gallery -- --elements mine,tank,shell --view low   # look at any element
npm run mutate                                              # run the hand-picked mutation manifest
npm run trace:browser -- --all                              # the golden trace, in three real engines
```

`npm run gallery` renders game elements as stills, animations or labelled sweep grids,
through the REAL render modules against a REAL world. `--skin`/`--hull`/`--accent` dress
the player tank through the game's own `setPlayerStyle`, and `--frames N` gives an
animated skin a timeline (one age step is one sim tick — `subjects.ts`'s `timelineDt`);
without those the gallery drew the roster default, unmapped, and could not show a skin at
all. Views are directions and each
element declares its own span, so any view frames any scene. `--sweep A,B --values
"1|2; 3|4"` patches constants in `src/` between passes and restores them in a `finally`;
it refuses to start if the target file is already dirty. `--scene game --slowmo 0.05
--burst 150` records a slow-motion timeline of REAL gameplay, one frame per rAF — the way
to catch a sub-second moment (a shell leaving the muzzle) that a still would miss.
`--spawn-anim <warp|rise|beacon>` dresses the entrance variant a spawn/respawn plays,
through the same `setPlayerStyle` call `--skin`/`--hull`/`--accent` use. `--scene
<moment>` swaps the posed gallery for one of `tools/gallery/moments.ts`'s scripted
timelines (`fire`, `destroyed`, `respawn`, `ricochet`, `wall-break`, `mine-cycle`,
`drive`, `pivot`, `traverse`) — a moment is deterministic and scripted end to end, so its
frame count comes from the moment itself; `--frames` is rejected outright for it.
`--elements`/`--reach`/`--timer`/`--fill` are gallery-composition flags a moment scene
does not consume either, but they are dropped silently rather than rejected. See
`tools/gallery/`.

`npm run mutate` (`tools/mutate/`) is the "prove the gap before writing the test" rule,
made checkable: for each hand-picked entry in `tools/mutate/manifest.json` (an exact
find/replace against a `src/` file, a declared `killed`/`survives`, an optional
`expectFailures` count, a `why`, and scoped `tests`) it verifies the find/replace
actually changed the file's bytes (refusing an ambiguous find rather than guessing),
runs a BASELINE check on the unmutated file first (a pre-existing red test in scope
must not be misattributed to the mutation), refuses to start if any entry's `tests`
cannot reach its `file` (checked once via `vitest related`, so a wrong-scope mutation
can never silently read as SURVIVES), applies the mutation, runs the scoped tests, and
restores from the bytes it read -- verified by reading them back, not by a zero exit.
The exit code is non-zero if any entry's real outcome (including a suite that fails to
COLLECT under the mutation, which counts as killed even at 0 failed tests) does not
match what it declared, which is what turns a manifest entry from a transcript into
something CI can check. **SURVIVES means the scoped vitest run does not catch it, not
that the full gate (`tsc --noEmit && vitest run`) doesn't** -- this tool does not run
`tsc` as part of the verdict, so a type-only mutation can still be caught by the build
even when every entry here reports SURVIVES. `--only <id>` runs a single entry.

CI (`.github/workflows/ci.yml`) runs typecheck, tests, build and a bundle-portability
assertion on Node 22.13.0 — the declared floor — and the Node 24 LTS line. `engines.node`
is `^22.13.0 || ^24.0.0`, matching those two tested LTS lines exactly. Node 20 was
removed from the support claim after reaching EOL.

**The game deploys from `main` to GitHub Pages** (`.github/workflows/pages.yml`), live at
`https://austinorphan.com/tanks/` — a **custom apex domain inherited from the user page**,
so `austinorphan.github.io/tanks/` 301-redirects there. It is still a `/tanks/` subpath,
which is what makes `base: './'` in `vite.config.ts` load-bearing: with the default base
the bundle asks for `/assets/…` and the page is blank. `npm run portability`
(`tools/portability/check.mjs`) asserts that against the BUILT output, and both workflows
call it — it cannot live in `npm test`, because under Vitest `import.meta.env.BASE_URL` is
`/` even though vitest reads the same config that sets `base: './'`.

**The deploy waits for CI.** `pages.yml` triggers on `workflow_run` for the `CI` workflow
and its `build` job requires `conclusion == 'success'`, so on the automatic path all 9 of
`ci.yml`'s checking steps have passed for that exact commit before a deploy starts. It
checks out `github.event.workflow_run.head_sha` rather than the branch head — under
`workflow_run` checkout defaults to the DEFAULT BRANCH'S head, which is a different commit
whenever a second merge lands while the first is still in CI.

**Three landmines that come with that**, all recorded at the point of decision in
`pages.yml` and repeated here because this is the deployment reference. **A fork PR can
match the trigger**: `branches: [main]` filters on the CI RUN's head branch, and a PR from
a fork's own `main` produces a run here with `event: pull_request`, `head_branch: main`,
`name: CI`. The `github-pages` environment is NOT a backstop — under `workflow_run` the ref
is the default branch, so its `main`-only policy admits it. The `if` requires the
triggering run to be a **push from this repository**; do not relax that. **Re-running an
OLD CI run republishes that commit** — deliberate rollback and accidental rollback are the
same mechanism. **A flaky `visual` now stops the site updating**, and the symptom is a
pages run with every job SKIPPED, not a red run: if the site looks stale, check whether CI
went red before assuming the deploy is broken.

**`workflow_dispatch` is the ungated path, and it stays that way** — it exists to
re-deploy without a commit, so it cannot have a CI run behind it. It re-runs **5 of
`ci.yml`'s 9 checking steps** (`verify`: 6, `visual`: 3), **not the `visual` job and not
`Mutation manifest`**, so a manual deploy can still publish a render regression that only
`tools/gl/` and `tools/visual/` catch, and a stale `tools/mutate/manifest.json`. Those
five steps are duplicated work on the automatic path; they are kept because deleting them
would leave the manual path checking nothing. (Denominator: the named steps of both
`ci.yml` jobs that check something — that can fail because of the tree — rather than set
up the runner, so `checkout`, `setup-node`, `npm ci`, BOTH Playwright steps (`Install
Playwright` and `Install chromium` are separate named steps), the browser cache and
`upload-artifact` are all excluded. `verify` contributes 6: Typecheck, Test, Mutation
manifest, Build, portability, audit. `visual` contributes 4 — Build, GL tests, Baseline
trace, Visual check — but its `Build` is the same `npx vite build` already counted, so it
adds 3, for 9 distinct. The deploy runs 5 of them, all from `verify`: Typecheck, Test,
Build, portability, audit.) The construction is written out because the bare number went
stale twice unnoticed: `5 of 7` was **correct when #80 wrote it** — the same rule over
that `ci.yml` gives `verify` 5 and `visual` 2 — then #104 added `Mutation manifest` (→ 8)
and #128 added `Baseline trace (chromium)` (→ 9), and neither recounted. **`main` IS
protected now, by a REPOSITORY RULESET rather than classic branch protection** — which is
why `GET /repos/:owner/:repo/branches/main/protection` still answers 404, and why the
sentence this replaces ("no branch protection and no ruleset — nothing forces work through
a PR, and nothing stops a direct push") read as true to anyone who checked only that
endpoint. It was false on every clause. Read the rulesets API instead:
`gh api repos/AustinOrphan/tanks/rulesets`.

The ruleset is named `Protect main`, targets `~DEFAULT_BRANCH`, is `active`, and has **an
empty `bypass_actors` list — nobody can bypass it, including the repository owner.** It
carries five rules: `deletion`, `non_fast_forward`, `required_linear_history`,
`pull_request` (squash the ONLY allowed merge method, `required_approving_review_count` 0,
but `required_review_thread_resolution` true) and `required_status_checks` on exactly three
contexts — **`verify (floor)`, `verify (current)` and `visual`**, the same three jobs
`ci.yml` defines. The semantic verify names stay stable when their Node versions advance.

Three consequences that invert what earlier repository guidance said. Work **is** forced through a PR
and a direct push to `main` is refused. A red commit **cannot** land on `main` any more —
the CI gate is now on the BRANCH as well as on the deploy, so the "a red commit can still
land, it just will not publish" reading is retired. And an unresolved review thread blocks
a merge even though zero approvals are required, which is the one rule here that is easy
to trip over, because it fails with the same generic "base branch policy prohibits the
merge" message that a red check does — `gh pr checks` will look green while the merge
stays blocked. **`gh pr merge` reports that message for any ruleset violation**, so
diagnose with `gh pr checks` AND the thread state before assuming CI is the cause. Two consequences of the shared
origin, neither fixable from this repo: every project page under `austinorphan.com` shares
one localStorage namespace (the game's **six** keys are all `tanks.*`-prefixed —
`progress`, `touch`, `stats`, `custom`, `achievements`, `run`; five stay `.v1`, and
`run` is `.v2` since issue #154 gave `currentLevelId` real campaign-level ids instead
of a stringified `ARENAS` index — this sentence said "four" until the mobile-release
investigation counted them, and "five" until the campaign-run model added a sixth), and the
portfolio's root-scoped `/sw.js` service worker controls `/tanks/` and deletes every
CacheStorage entry it does not own — so an offline feature here needs coordination first.
