# Commands and operations reference

On-demand detail for repository tools, CI, deployment, and branch protection. For the short command entry points, start in `CLAUDE.md`.

## Verification command surface

The package scripts separate atomic operations from stable composites. CI uses the atomic
scripts in separate named steps for clear diagnostics and matrix conditions; people and
agents should normally start with the composites.

| Command | Scope | Typical warm local runtime |
| --- | --- | ---: |
| `npm run typecheck` | TypeScript validation only; emits nothing | about 5 seconds |
| `npm run test:unit` | Complete Vitest suite only | about 55 seconds |
| `npm run build` | Vite production bundle only | about 1 second |
| `npm run docs:check` | Plan/spec metadata and unchanged-legacy validation | under 1 second |
| `npm run verify:quick` | Typecheck, then unit tests | about 1 minute |
| `npm run verify:build` | Production build, then built-output portability | under 10 seconds |
| `npm run verify:visual` | Build/portability, GL tests, Chromium trace, and screenshot checks | roughly 30–90 seconds after browser setup |
| `npm run verify:full` | Quick gate, mutation manifest, build/portability, and production audit | several minutes; mutation dominates |

The figures are approximate measurements/bands from a warm Node 24 Linux checkout on
2026-08-21; hardware, cache state, mutation selection, audit networking, and browser
startup move them substantially. The command contract matters more than the exact timing.

`npm test` remains a compatibility alias for `npm run verify:quick`; both package scripts
retain a trailing `--` boundary so `npm test -- <Vitest arguments>` reaches Vitest. For a
focused test without an implicit typecheck, use `npm run test:unit -- <Vitest arguments>`.

`verify:full` is the complete core, non-browser merge gate. It deliberately does not
silently skip or install browser prerequisites. Run `verify:visual` in addition when a
change affects user-visible rendering or renderer/WebGL infrastructure. Playwright is not
a repository dependency: install the version pinned in `.github/workflows/ci.yml` and its
Chromium browser before running the visual composite locally. Safari and the cross-OS/
architecture engine matrix remain separate because Linux cannot reproduce them.

### Constrained-machine escape hatches

Two optional environment variables relax Vitest for a machine that cannot keep up. Both are
unset by default and the repository ships Vitest's own behaviour; setting neither changes
anything, locally or in CI.

| Variable | Effect when set | Behaviour when unset |
| --- | --- | --- |
| `TANKS_TEST_MAX_FORKS` | Caps concurrent fork-pool workers | one worker per available core, uncapped |
| `TANKS_TEST_TIMEOUT` | Per-test timeout in milliseconds | Vitest's 5000ms default |

```sh
TANKS_TEST_MAX_FORKS=2 TANKS_TEST_TIMEOUT=20000 npm test
```

Set them per machine — a shell profile, `direnv`, or the command itself — rather than
committing either as a repository default. An unbounded fork pool on a 4-core/4GB box
starves itself under this repository's heavier tests and reports "Test timed out in 5000ms"
in files the change under test never touched, all of which pass in isolation. That is
contention rather than a thin budget: measured with no contention on that same box, the
heaviest individual tests finish in roughly 2.3–2.6 seconds against the 5000ms default.
Raising the repository default would ship one machine's constraint to every contributor and
to CI, where a hung test would take proportionally longer to fail and a genuine performance
regression could stop tripping the timeout.

The mutation phase also refuses to run when a file named by its manifest has uncommitted
changes. Run `verify:full` against the clean candidate commit in a clean worktree. While
editing, run the applicable quick, build, and subsystem checks first; do not discard or
stash unrelated work merely to satisfy the mutation preflight.

Risk tiers map to the minimum command set as follows:

| Risk | Minimum command set |
| --- | --- |
| Low | Directly relevant documentation, formatting, link, or generator checks; no universal composite |
| Standard | `npm run verify:quick`; add `npm run verify:build` when production output can change and `npm run verify:visual` for user-visible rendering |
| High | `npm run verify:full`, plus every affected subsystem check; renderer/WebGL work adds `npm run verify:visual` |

The tier is a floor rather than a substitute for targeted evidence. Simulation changes
still need the applicable browser/Safari trace; persistence changes still need focused
compatibility coverage; Pages and artifact-path changes still need built-output review.

Specialized commands remain directly available:

```sh
npm run gallery -- --elements mine,tank,shell --view low   # inspect a rendered element
npm run mutate -- --only <id>                              # run one mutation entry
npm run test:gl                                            # renderer construction checks
npm run trace:browser -- --all                              # golden trace in three Playwright engines
npm run trace:safari                                       # real Safari on supported macOS
npm run portability                                        # inspect an existing dist/
npm run visual                                             # inspect an existing dist/ in Chromium
```

`npm run issues:audit` checks every open issue for the repository's required size, risk,
area, impact, horizon, readiness, and active-queue invariants. It infers the repository from
`GITHUB_REPOSITORY` or the current Git remote, uses `GH_TOKEN`/`GITHUB_TOKEN` when available,
and can audit this public repository anonymously within GitHub's lower unauthenticated rate
limit. Contract violations exit non-zero with issue-specific remediation; explicitly uncertain
dependency or decision wording is reported as a warning. `npm run issues:maintain` is the
workflow-only event handler that applies allowlisted area/impact choices from issue forms and
cleans transient labels from closed issues.

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
`drive`, `pivot`, `traverse`, `trail-stop`, `trail-cross`, `trail-skins`) — a moment is
deterministic and scripted end to end, so its frame count comes from the moment itself;
`--frames` is rejected outright for it. A moment composes with `--skin`/`--hull`/
`--accent`, which dress `world.tanks[0]` only — every other slot renders the roster
default, so a two-tank moment (`trail-cross`, `trail-skins`) already contrasts by
construction. `--elements`/`--reach`/`--timer`/`--fill` are gallery-composition flags a
moment scene does not consume either, but they are dropped silently rather than rejected.
See `tools/gallery/`.

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
that `npm run verify:full` doesn't** -- this tool does not run the `typecheck` script as
part of the verdict, so a type-only mutation can still be caught by the full gate even
when every entry here reports SURVIVES. `--only <id>` runs a single entry.

CI (`.github/workflows/ci.yml`) invokes the same atomic package scripts in named steps:
typecheck, unit tests, the conditionally selected mutation manifest, build, bundle
portability, and production audit on Node 22.13.0 — the declared floor — and the Node 24
LTS line. Its separate visual job uses the direct build, GL, browser-trace, and visual
scripts so setup failures and rendering failures retain distinct diagnostics.
`engines.node` is `^22.13.0 || ^24.0.0`, matching those two tested LTS lines exactly.
Node 20 was removed from the support claim after reaching EOL.

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
trace, Visual check — but its `Build` is the same `npm run build` already counted, so it
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
