# Commands and operations reference

On-demand detail for repository tools, CI, deployment, and branch protection. For the short command entry points, start in `CLAUDE.md`.

## Verification command surface

The package scripts separate atomic operations from stable composites. CI uses the atomic
scripts in separate named steps for clear diagnostics and matrix conditions; people and
agents should normally start with the risk-appropriate composites and targeted commands.

| Command | Scope | Typical warm local runtime |
| --- | --- | ---: |
| `npm run typecheck` | TypeScript validation only; emits nothing | about 5 seconds |
| `npm run test:unit` | Complete Vitest suite only | about 55 seconds |
| `npm run build` | Vite production bundle only | about 1 second |
| `npm run docs:check` | Plan/spec metadata and unchanged-legacy validation | under 1 second |
| `npm run lint:workflows` | actionlint with shellcheck over every `.github/workflows` file, after its known-bad fixtures | under 1 second warm; about 1 second on the first run, which downloads |
| `npm run mutate:smoke` | One representative real mutation-harness path used by floor CI | under 5 seconds |
| `npm run verify:quick` | Typecheck, then unit tests | about 1 minute |
| `npm run verify:build` | Production build, then built-output portability | under 10 seconds |
| `npm run lint:css` | Parse integrity of every shipped stylesheet; also enforced inside `npm run test:unit` | under 1 second |
| `npm run verify:visual` | Build/portability, GL tests, Chromium trace, screenshot checks, and the session-lifecycle round trip | roughly 55–130 seconds after browser setup |
| `npm run verify:full` | Complete core composite: quick gate, mutation manifest, build/portability, and production audit | several minutes; mutation dominates |

The figures are approximate measurements/bands from a warm Node 24 Linux checkout on
2026-08-21; hardware, cache state, mutation selection, audit networking, and browser
startup move them substantially. The command contract matters more than the exact timing.

`npm test` remains a compatibility alias for `npm run verify:quick`; both package scripts
retain a trailing `--` boundary so `npm test -- <Vitest arguments>` reaches Vitest. For a
focused test without an implicit typecheck, use `npm run test:unit -- <Vitest arguments>`.

`npm run lint:css` (`tools/css-integrity/`, issue #763) checks that every shipped stylesheet
parses as written: each `.css` file under `src/` and `public/`, and each `<style>` block in
an `.html` file there or at the repository root. Files are found by walking the tree, so a
new stylesheet is covered without a list to update. Problems print as
`file:line:column: message` and the command exits 1.

It runs two checks, and both are needed:

1. A token scan that reports a block still open at the end, a `}` that closes nothing, and
   an unterminated comment or string. A conforming parser repairs these silently. The end of
   the file closes an open block, and CSS nesting turns the rules after a missing brace into
   children of the unclosed rule.
2. A strict parse with lightningcss, which Vite 8 depends on and by default minifies
   production CSS with. Error recovery is off, so every parse error is reported.

`tools/css-integrity/check.test.ts` runs the same check over the same files in
`npm run test:unit`, and that is the required-CI enforcement. It is parse validity only;
`src/game/hud.css.test.ts` and the visual checks stay authoritative for structure and
behavior. CSS assigned from TypeScript (`style.cssText` in `src/boot.ts`) is not a
stylesheet and is not scanned.

`verify:full` is the complete core, non-browser composite. It is available for exceptional
local reproduction of the core CI scope, but it is not the routine local candidate gate or
proof that a change is merge-ready. It deliberately does not silently skip or install
browser prerequisites. Run `verify:visual` when a change affects user-visible rendering or
renderer/WebGL infrastructure. Playwright is not a repository dependency: install the
version pinned in `.github/workflows/ci.yml` and its Chromium browser before running the
visual composite locally. Safari and the cross-OS/architecture engine matrix remain
separate because Linux cannot reproduce them.

`npm run roundtrip` (`tools/visual/roundtrip.mjs`) is the session-lifecycle half of the
visual composite and the only check that can see it. It drives all four of #428's match-start
gestures -- Continue, New Game, a Practice level pick and Versus Start -- through the built
app in Chromium, quits each back to an application route, and reads the canvas and live
WebGL-context census off the document at every step. `renderer.forceContextLoss()` means a
leaked gameplay canvas is indistinguishable from a live one in the unit fakes, so a
disposal regression is invisible to Vitest and to every screenshot. It prints each census
and then returns a verdict; the required `visual` CI job runs it after the screenshot check.
Measured at **23.1 s on the CI runner** (ubuntu-latest, 2026-09-01) and 40.0/40.3/40.8 s
over three consecutive local runs (Linux, swiftshader, n=3) -- the software renderer
locally is the slower of the two.

### Workflow static validation

`npm run lint:workflows` (`tools/workflow-lint/`, issue #761) runs
[actionlint](https://github.com/rhysd/actionlint) 1.7.12 with shellcheck 0.11.0 over every
`.yml` and `.yaml` file in `.github/workflows`. It catches:

- malformed YAML
- invalid `${{ }}` expressions
- keys the workflow schema does not have
- malformed `uses:` references
- shellcheck findings in `run:` scripts

Findings print as `file:line:column` with a snippet, and the command exits 1.

Both tools are official release binaries, not npm packages. Each is pinned by version and
SHA-256 for linux and darwin on x64 and arm64, downloaded on first use, refused unless its
digest matches, and cached under `node_modules/.cache/tanks-workflow-lint`. Any other
platform is refused by name. pyflakes is disabled explicitly rather than left to whatever is
on `PATH`.

Before linting the real workflows, each run lints `tools/workflow-lint/fixtures/`, five
known-bad files. Each must report its own rule, or the run fails. A validator that has
quietly stopped validating therefore cannot report the repository clean.

Required CI runs the command as the first checking step of both `verify` lanes. It
complements `tools/workflows.test.ts`, which remains the authority for this repository's own
workflow policies.

A finding GitHub would accept is suppressed at that exact site with a comment saying why. The
one current case is `# shellcheck disable=SC2329` on the trap-invoked `cleanup` function in
`engines.yml`. No rule is ignored globally.

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

### Generated-scenario invariants

`src/sim/scenarios.ts` (issue #760) resolves a seed to a legal scenario: a campaign arena
at one to four players, or a versus catalog entry at a mode and player count that entry
lists, with seeded rule values and one driver per player (the player-profile bot, a
scripted walk through the input space, or idle). It steps the scenario through
`stepInputs` and checks structural invariants after every tick:

- every number in the world is finite
- ids are unique and issued, and every owner exists
- nothing revives without a respawn event or round restart
- each step advances the clock one tick, and an ending stays latched
- shell, mine, and bounce bounds hold
- only a live tank off cooldown fires, and only once a tick

A run continues 30 ticks past its ending, then stops.

| Command | Scope | Measured warm runtime |
| --- | --- | ---: |
| `npx vitest run src/sim/generated-scenarios.test.ts` | The required corpus inside `npm run test:unit`: seeds 1–10 at 1,200 ticks each; three repeated, both in the same module graph and on freshly loaded modules; a known-bad control per invariant | about 5 seconds |
| `VITE_RUN_MEASURE=1 npx vitest run tools/scenarios/generated-scenarios.measure.test.ts` | The on-demand sweep: seeds 1–200 at 3,600 ticks by default, every seed run twice; `VITE_SCENARIO_SEEDS` (`1-200`, `3,7,40-42`) and `VITE_SCENARIO_TICKS` override | about 3.3 minutes |

A failure prints the seed, the resolved scenario as JSON, the tick and invariant, and a
`rerun:` command that reproduces that one seed with no CI state. A repeat failure names the
first tick the two runs disagree on. The sweep closes with a `corpus digest` line, which two
sweeps of the same seeds and ticks on the same code must print identically. On GitHub,
dispatch **Generated-scenario sweep** (`scenario-sweep.yml`) with seed and tick inputs; it
uploads the console log for 14 days and is on no automatic trigger.

Budget. The required corpus measured 4.9 s of test time run alone (27 tests, Node 24, the
4-core/4GB Linux box, 2026-09-17). Keep it near that: add breadth to the sweep, not the
corpus. Its enforced ceiling is a 20-second timeout per seed test, and 60 seconds for the
repeat test, so a slowdown fails with a timeout instead of quietly stretching CI. The default
sweep measured 195 s wall on the same box with one fork: 443,556 simulated ticks checked in
the first runs, 129 of 200 scenarios reaching an ending. The workflow allows 60 minutes.

The sweep is in `tools/`, not beside the corpus, because each seed awaits a zero-delay timer
first. Without that turn of the event loop, Vitest's worker RPC times out
("Timeout calling onTaskUpdate") and the run exits 1 after every seed passed. That was
measured on a single 197-second test and again on 200 synchronous per-seed tests.
`src/sim/purity.test.ts` bans timers anywhere under `src/sim/`, test files included.
The comparison on freshly loaded modules (`vi.resetModules`) is what catches a module-level
cache: a second run in the same module graph reads the same cached values and agrees.

What the invariants do not cover: balance or feel, render and audio, malformed worlds that
`createWorldFor` cannot produce, geometry (a tank inside a wall), and event payloads other
than `fire` and `respawn`. There is no shrinking; a reported seed and tick budget are the
reproduction.

### Local candidate verification

Run directly relevant tests during implementation, then choose the candidate floor from the
complete diff. The risk tier remains a floor rather than a substitute for targeted evidence:

| Risk | Minimum local candidate command set |
| --- | --- |
| Low | Directly relevant documentation, formatting, link, or generator checks; no universal composite |
| Standard | `npm run verify:quick`; add `npm run verify:build` when production output can change, selected applicable mutation entries when behavior/code/tests change, and `npm run verify:visual` for user-visible rendering |
| High | `npm run verify:quick`; add `npm run verify:build` when production output can change, every affected subsystem check, and all applicable mutation entries selected for the touched behavior/code/tests; renderer/WebGL work adds `npm run verify:visual` |

Use `npm run mutate -- --only <id>` for each applicable existing or new mutation entry.
Continue proving a claimed test gap with a real production mutation that passes before the
test and fails after it. Add, update, and remeasure manifest entries when a change alters the
coverage contract. Simulation may also need the golden/browser/Safari trace; persistence may
need focused compatibility coverage; GL, visuals, portability, generators, and documentation
checks remain required when their subsystem is affected.

### Full local mutation-manifest exceptions

Local full-manifest execution is exceptional and risk-driven, not a routine pre-PR step or
an automatic consequence of the high-risk tier. Run `npm run mutate`, or `npm run
verify:full` when the entire core composite is justified, for a concrete reason such as:

- modifying the mutation harness itself
- making broad changes to the mutation manifest
- diagnosing or confirming the repair of a CI mutation failure
- changing cross-cutting behavior for which targeted mutation selection cannot provide
  reasonable candidate confidence
- another specifically identified repository-wide risk

The complete mutation phase refuses to run when a file named by its manifest has
uncommitted changes. When an exception requires it, use a clean candidate commit in a clean
worktree. Do not discard or stash unrelated work merely to satisfy the preflight.

### CI and merge verification

CI is authoritative for repository-wide verification. On pull requests and pushes to
`main`, `verify (current)` runs the mutation manifest under Node 24 through four
`mutation (shard i/4)` jobs it waits for (issue #724):
on a pull request only the entries the diff can affect (`--changed origin/main`,
issue #506), on `main` the complete set. Each job runs `--shard i/4` of that one
selection — scope-atomic, cost-balanced slices that between them run every selected
entry exactly once (`tools/mutate/README.md`) — through the worktree pool
(`--jobs auto`, issue #502). The Node 24 typecheck, unit, build, portability and audit
steps run as `checks (current)`.

The required `verify (current)` context is the `verify-current` fan-in job. It needs the
`verify` job and all four shards, runs under `if: ${{ !cancelled() }}`, and passes only
when both results are `success`. The condition is what keeps the gate closed: under the
default `if`, a job whose needs failed is skipped, and GitHub documents that a skipped job
reports success to a required check, so a failed shard would otherwise leave the context
green. `needs.verify.result` covers both matrix lanes, so a floor failure turns it red
too. The exact Node 22.13.0 `verify (floor)` lane runs typecheck, unit tests, build,
portability, production audit, and `npm run mutate:smoke`: one representative real
manifest entry, not the complete manifest. `visual` remains a required independent
browser/rendering gate, so the required context names remain `verify (floor)`,
`verify (current)`, and `visual`, and the ruleset needed no change.

Before sharding, the one-job affected-entries step took 14 s on a tools-only pull request
(#739), 3 s on a simulation-leaf one (#726) and 43 min 51 s on a HUD-touching one (#716),
read from `gh run view --json jobs`. The same three shapes are to be re-measured on pull
requests opened after this change (issue #724).

The separate `Mutation floor` workflow runs the complete manifest under exact Node
22.13.0 daily at 07:23 UTC against the latest `main`, and `workflow_dispatch` can run it
for a manually selected ref. Its `mutation manifest (floor)` job is intentionally outside
the required `CI` workflow: it is complementary floor-runtime monitoring, not a required
pull-request check and not a Pages deployment gate. A red scheduled run remains visible in
GitHub Actions and requires investigation. This daily full-floor coverage does not make
routine local full-manifest runs necessary; use the concrete exception list above.

Inspect and resolve every CI failure rather than treating local candidate evidence as a
substitute. Until all three required contexts pass on the candidate commit, report local
checks as candidate verification only; do not describe the change as fully verified or
merge-ready.

Specialized commands remain directly available:

```sh
npm run gallery -- --elements mine,tank,shell --view low   # inspect a rendered element
npm run capture -- --list                                  # list reproducible media recipes
npm run hud:closure                                        # who owns what inside createHud (issue #767)
npm run screens:sweep -- --dist dist --out tmp/sweep/base   # every screen state at every layout (issue #766)
npm run screens:compare -- --base <dir> --head <dir>         # byte-compare two sweeps
npm run mutate -- --only <id>                              # run one mutation entry
npm run mutate -- --only <id> --only <id>                  # repeatable; --only a,b is the same
npm run mutate -- --jobs auto                              # the whole manifest over a worktree pool (committed tree only)
npm run mutate -- --changed origin/main --list             # which entries this branch's diff can affect, and why
npm run mutate:smoke                                      # floor CI's representative entry
npm run test:gl                                            # renderer construction checks
npm run trace:browser -- --all                              # golden trace in three Playwright engines
npm run trace:safari                                       # real Safari on supported macOS
npm run portability                                        # inspect an existing dist/
npm run visual                                             # inspect an existing dist/ in Chromium
npm run roundtrip                                          # session lifecycle census in Chromium
```

`npm run capture` (`tools/capture/`) wraps the gallery's deterministic moment path in a
versioned, reviewed recipe contract. `npm run capture -- --recipe gallery.fire.still`
publishes `capture.png` plus `capture.json`; `npm run capture -- --recipe
gallery.ai-tracking.normal` publishes a timing-faithful H.264 MP4, a convenience GIF, and
the manifest. Output defaults under ignored `artifacts/capture/`, refuses collisions, and
can be redirected with a safe relative `--out` path. Temporary numbered PNGs are removed
unless `--retain-frames` is explicit. The MP4 is timing truth; GIF delay precision cannot
express exact 60 fps. See [`tools/capture/README.md`](../../tools/capture/README.md) for
the normalized producer/registration contract, shared format assembly, probed media
validation, cooperative signal cleanup, prerequisites, registry/manifest fields, safety,
and the cross-environment determinism boundary.

`npm run issues:audit` checks every open issue for the repository's required size, risk,
area, impact, horizon, readiness, and active-queue invariants, and holds GitHub's native
parent, sub-issue, and blocked-by fields to the same contract: a singular body parent must
mirror a native parent, `agent-ready` and `priority:now` work must carry no open native
blocker, native dependencies must stay acyclic, and a decomposed `size:xl` roll-up must keep
native children. An open child under a closed parent is a warning rather than an error. The
audit assumes the one-time native relationship migration has already been applied; run
against an unpopulated graph it correctly reports every mirrored parent as missing. It infers
the repository from `GITHUB_REPOSITORY` or the current Git remote and uses
`GH_TOKEN`/`GITHUB_TOKEN` when available; the anonymous path still covers the label-only
checks, but relationship reads make GitHub's lower unauthenticated hourly budget the binding
limit, so pass a token for a complete audit. Relationship reads are skipped for issues whose
GitHub summaries report none, except `agent-ready` and `priority:now` issues, which are
always inspected — so the report states the inspected population beside its native-blocked
count instead of presenting it as a backlog-wide census. Contract violations exit non-zero
with issue-specific remediation; explicitly uncertain
dependency or decision wording is reported as a warning. With a token the audit also reads
every open pull request's closing references once through GraphQL, so a `priority:now` issue
an open or draft pull request already implements is a `now-in-flight` error, a Now issue
carrying `human-required` or `needs-split` is an error, and a queue below capacity while
eligible `priority:next` candidates exist is a warning; the report's header states whether
that linkage was inspected, because the anonymous path cannot read it. `npm run
issues:maintain` is the workflow-only event handler that applies allowlisted area/impact
choices from issue forms and cleans transient labels from closed issues.

`npm run issues:reconcile [--dry-run]` refills the Now queue from `priority:next` under the
policy in [task sizing](task-sizing.md#now-queue-automation): one state-based, idempotent
pass that demotes in-flight Now issues, ranks eligible candidates deterministically, and
promotes only into vacancies below `MAX_NOW_ISSUES`. It needs `GH_TOKEN`/`GITHUB_TOKEN`
(linkage is a GraphQL read). It reads relationships only for Now items and label-shaped
candidates, so a run costs roughly a dozen reads plus two writes per change instead of the
audit's ninety-odd; every write is preceded by a re-read of that issue and skipped if the
issue closed or its labels moved since the plan was computed, and additions land before
removals so an interrupted run leaves a duplicate horizon (an audit `duplicate-priority`
error for a person to clear; automation never strips a second horizon because that state is
indistinguishable from a hand demotion in progress), never an issue with no horizon.
`--dry-run` prints the plan without writing; the plan is also appended to the Actions step
summary. A `reconcile` run that dies on the token budget shows as a failed check on any
pull request whose event started it; the check is informational, not required, and the next
run reconciles the same state. In the `Issue backlog contract` workflow the
`reconcile` job runs after `maintain` on every issue event, on `pull_request_target` opened,
reopened, edited, and unmerged closed events (never checking out or executing pull-request
content), on manual dispatch, and on the daily schedule; it and the `audit` job each carry a
`cancel-in-progress: false` concurrency group, so a burst of label events collapses to one
running plus one pending run instead of a run per event, which is the pattern that
exhausted the token's 1,000-request hourly budget and failed most of a day's audits. A
sustained trickle of events spaced wider than a job still costs a full audit each, and the
per-event cost is higher than before by the reconcile job's reads.

`npm run issues:relationships` is the reviewed, additive migration from issue-body hierarchy
and hard-prerequisite statements to GitHub's native parent/sub-issue and blocked-by fields. It is
operator-only: both plan and apply modes require `GH_TOKEN` or `GITHUB_TOKEN`, the ledger is
pinned to `AustinOrphan/tanks`, and apply additionally requires the exact
`--confirm AustinOrphan/tanks` argument. Plan mode performs no writes and reports every missing
edge or parent conflict. Apply mode never reparents a conflicting child, continues with the
independent dependency edges, rate-limits every successful write, verifies the resulting graph,
and records completed and remaining edges in the Actions step summary even after a partial
failure.

Use the manual `Migrate native issue relationships` workflow for the repository migration. A
plan dispatch performs 143 inspection reads for the reviewed 85 parent and 154 blocked-by edges.
An initial apply dispatch skips the separate plan job and is bounded at 620 requests: 143
inspection reads, 95 issue-record validations, 239 writes, and 143 verification reads. Reviewing
a plan and then dispatching apply therefore uses at most 763 requests while every blocked-by list
fits on one 100-item page, below the published 1,000-request/hour Actions-token budget. The
workflow serializes dispatches, gives write access only to the guarded apply job, and passes the
operator-entered confirmation through to the command's exact-string check.

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
<moment>` swaps the posed gallery for one of `src/render/gallery/moments.ts`'s scripted
timelines (`fire`, `destroyed`, `respawn`, `ricochet`, `wall-break`, `mine-cycle`,
`drive`, `pivot`, `traverse`, `trail-stop`, `trail-cross`, `trail-skins`, `ai-tracking`) — a moment is
deterministic and scripted end to end, so its frame count comes from the moment itself;
`--frames` is rejected outright for it. A moment composes with `--skin`/`--hull`/
`--accent`, which dress controlled slot 0, while `--spawn-anim` is applied to every
controlled slot so a respawning tank does not depend on which slot the moment uses.
`--elements`/`--reach`/`--timer`/`--fill` are gallery-composition flags a
moment scene does not consume either, but they are dropped silently rather than rejected.

`--blocked-fire <ring|muzzle|pips>` renders one of issue #356's candidate
shell-cap refusal cues, the same set the game's `?dev=1&blockedFire=` flag selects. It
requires `--scene blocked-fire`, the moment that stages repeated refusals, and is
rejected with any other scene rather than producing a clip with no cue in it. Those three
visual arms are the whole accepted set: the audio and haptic arms have nothing to draw,
and `hud` draws into the DOM HUD, which no gallery page builds. `turret` and `smoke` are
gone from the set because issues #526 and #536 retired both as cues -- gun recoil and
muzzle smoke are unconditional shipped behaviour now, so the `blocked-fire` moment shows
the kick and the burnt puff with no flag at all. This is the supported way
to review a refusal cue — the cues live between 0.07s and 0.75s, so a close view and a
slowed clip (`--anim`, plus `--subdiv`/`--fps`) show one where an arena-framed capture
of real play cannot.
See `tools/gallery/`.

`npm run mutate` (`tools/mutate/`) is the "prove the gap before writing the test" rule,
made checkable: for each hand-picked entry in `tools/mutate/manifests/<area>/<id>.json` (one
file per entry since issue #653, read as one set; an exact
find/replace against a `src/` or `tools/` file, a declared `killed`/`survives`, the
`killedBy` test names or an `expectFailures` count, a `why`, and scoped `tests`) it verifies the find/replace
actually changed the file's bytes (refusing an ambiguous find rather than guessing),
runs a BASELINE check on the unmutated file first (a pre-existing red test in scope
must not be misattributed to the mutation), refuses to start if any entry's `tests`
cannot reach its `file`, applies the mutation, runs the scoped tests, and restores from
the bytes it read -- verified by reading them back, not by a zero exit. Reachability is
still proved separately for every mutation source, but those queries share one
timeout-bounded Vitest context and its warmed Vite graph instead of starting one cold
`vitest related` process per source. Within one manifest invocation, entries with the
exact same ordered `tests` array share a completed baseline; after any earlier mutation,
restoration is byte-verified before a later entry can reuse it, and a failed restoration
stops the run immediately.
The exit code is non-zero if any entry's real outcome (including a suite that fails to
COLLECT under the mutation, which counts as killed even at 0 failed tests) does not
match what it declared, which is what turns a manifest entry from a transcript into
something CI can check. **SURVIVES means the scoped vitest run does not catch it, not
that `npm run verify:full` doesn't** -- this tool does not run the `typecheck` script as
part of the verdict, so a type-only mutation can still be caught by the full gate even
when every entry here reports SURVIVES. `--only <id>` narrows the run to named entries;
it is repeatable and also accepts a comma list, so `--only a --only b` and `--only a,b`
both run both. Any id matching no manifest entry refuses the whole run and names every
such id, and the closing tally prints how many entries were requested beside how many
ran, so an under-run is legible rather than reading as a clean sweep.

`npm run mutate:smoke` selects `capture-prerequisite-error-drops-the-ci-pin`. Its
browser-free four-test scope keeps floor feedback cheap while the real CLI still parses
and validates the shipped manifest, honors `--only`, checks git cleanliness and Vitest
reachability, establishes a green baseline, applies a real mutation, runs real tests,
matches the declared failure count, and restores the target bytes. The normal unit suite
already runs `tools/mutate/orchestrate.test.ts`, including real Vitest-subprocess and
real-file mutation/restoration cases; the selected entry adds the actual CLI and shipped-
manifest path those tests do not enter. The full-run process count is one reachability
worker, at most one baseline process per exact ordered test scope, and one mutated-test
process per entry; per-source reachability sets and per-entry mutation verdicts remain
independent.

CI (`.github/workflows/ci.yml`) invokes the same atomic package scripts in named steps:
typecheck, unit tests, build, bundle portability, and production audit on Node 22.13.0 —
the declared floor — and the Node 24 LTS line. The current lane adds the complete mutation
manifest; the floor lane adds only the representative smoke entry. Its separate visual job
uses the direct build, GL, browser-trace, and visual scripts so setup failures and rendering
failures retain distinct diagnostics. `.github/workflows/mutation-floor.yml` supplies the
daily/manual complete-manifest run under exact Node 22.13.0 without joining the merge gate.
`engines.node` is `^22.13.0 || ^24.0.0`, matching those two tested LTS lines exactly.
Node 20 was removed from the support claim after reaching EOL.

Required CI is authoritative for merge, not a synchronous implementation barrier. After a
candidate is locally verified, pushed, and submitted to required CI, record it as CI-pending
and return the single active implementation slot to independent ready work. Inspect pending
PRs once at the natural boundaries defined in
[CI-pending execution](testing-and-review.md#ci-pending-execution); do not use a watch or
tight polling loop while useful work exists. A required failure receives prompt attention
and remains a merge blocker. Do not rerun a full CI-equivalent local gate merely because CI
is pending; do so only for a concrete diagnosis or a named full-manifest exception.

**The game deploys from `main` to GitHub Pages** (`.github/workflows/pages.yml`), live at
`https://austinorphan.com/tanks/` — a **custom apex domain inherited from the user page**,
so `austinorphan.github.io/tanks/` 301-redirects there. It is still a `/tanks/` subpath,
which is what makes `base: './'` in `vite.config.ts` load-bearing: with the default base
the bundle asks for `/assets/…` and the page is blank. `npm run portability`
(`tools/portability/check.mjs`) asserts that against the BUILT output, and both workflows
call it — it cannot live in `npm test`, because under Vitest `import.meta.env.BASE_URL` is
`/` even though vitest reads the same config that sets `base: './'`.

**The deploy waits for CI; an agent need not.** `pages.yml` triggers on `workflow_run` for
the `CI` workflow and its `build` job requires `conclusion == 'success'`, so on the
automatic path all 10 of
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
`ci.yml`'s 13 checking steps** (`verify`: 7, `mutation`: 2, `visual`: 4), **not the
`visual` job and not any mutation step**, so a manual deploy can still publish a render
regression that only `tools/gl/` and `tools/visual/` catch, and a stale
`tools/mutate/manifests/`. Those five steps are duplicated work on the automatic path;
they are kept because deleting them would leave the manual path checking nothing.
(Denominator: the named steps of `ci.yml`'s three checking jobs that check something —
that can fail because of the tree — rather than set up the runner, so `checkout`,
`setup-node`, `npm ci`, BOTH Playwright steps (`Install Playwright` and `Install
chromium` are separate named steps), the browser cache and `Upload screenshots` are all
excluded. `verify` contributes 7: Lint workflows, Typecheck, Test, Mutation harness smoke, Build,
portability, audit. `mutation` contributes 2: the affected-entries and the full Mutation
manifest (a pull request runs the first and a push the second, but each is its own named
check; the job runs four times, as shards, and each step is still one check). `visual`
contributes 5 — Build, GL tests, Baseline trace, Visual check, Session lifecycle round
trip — but its `Build` runs the same `npm run build` already counted, so it adds 4, for 12
distinct. The `verify-current` fan-in's one step reads the other jobs' results and checks
nothing in the tree, so it is not counted. The deploy runs 5 of them, all from `verify`:
Typecheck, Test, Build, portability, audit.) The construction is written out, and since issue #693
recomputed from the workflow files by `tools/workflows.test.ts`, because the bare number
kept going stale unnoticed: `5 of 7` was **correct when #80 wrote it** — the same rule
over that `ci.yml` gives `verify` 5 and `visual` 2 — then #104 added `Mutation manifest`
(→ 8) and #128 added `Baseline trace (chromium)` (→ 9); splitting floor smoke from current
full added the tenth; the affected-entries manifest step (issue #506) and #481's
`Session lifecycle round trip` made twelve while this sentence still said ten. **`main` IS
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
contexts — **`verify (floor)`, `verify (current)` and `visual`**, the three contexts
`ci.yml` reports (`verify (current)` from the `verify-current` fan-in job since issue #724). The semantic verify names stay stable when their Node versions advance.

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
one localStorage namespace (every key the game writes is `tanks.*`-prefixed: the seven on
`SAVE_KEYS` — `progress`, `stats`, `stats.run`, `custom`, `settings`, `achievements` and
`run`, which is `.v2` since issue #154 gave `currentLevelId` real campaign-level ids
instead of a stringified `ARENAS` index while the rest stay `.v1` — plus the versus
setup's `tanks.versus.v1`, which saves do not carry, and the legacy `tanks.touch.v1`, which
is only migrated from and imported; this sentence said "four", "five" and then "six" as
keys were added, and since issue #693 `tools/instructions.test.ts` recomputes it), and the
portfolio's root-scoped `/sw.js` service worker controls `/tanks/` and deletes every
CacheStorage entry it does not own — so an offline feature here needs coordination first.

## Dependency updates

`.github/dependabot.yml` (issue #762) opens update pull requests for npm and for the GitHub
Actions used by the workflows.

**Coverage.** Both ecosystems are checked weekly, on Monday at 06:00 America/Chicago. The npm
entry points at the repository root. Dependabot's npm fetcher reads the root `workspaces`, so
`tools/mutate/package.json` is covered too, and every change lands in the one root
`package-lock.json`.

**Noise limits:**

- A seven-day cooldown (fourteen days for an npm major) before a new release is proposed.
- At most five open update pull requests per ecosystem.
- Routine tooling updates arrive grouped.

| Update class | How it arrives | Review |
| --- | --- | --- |
| devDependency minor or patch | One grouped pull request a week (`tooling-minor-and-patch`) | Human review and required CI; the lowest-risk class, and the first candidate if auto-merge is ever proposed |
| devDependency major | Its own pull request | Human review; may need migration |
| Runtime dependency (`three`, `howler`), any update | Its own pull request, grouped only with its own type package (`three` with `@types/three`), so the types never drift from the library | Human review. `three` is 0.x, so any minor can change rendering, and `visual` must pass |
| `@types/node` | Up to the supported floor major only (22 while `engines` is `^22.13.0 \|\| ^24.0.0`) | Newer majors are ignored: types for a newer Node would let code use APIs the floor lacks. Raise the bound together with the floor |
| GitHub Actions | One grouped pull request for every `actions/*` tag bump | Human review. A major tag usually moves the action's runtime; check its release notes |
| An update that changes generated output | Arrives in its class above, and fails CI until regenerated. A runtime update changes `THIRD-PARTY-NOTICES.md`, whose section headers carry the installed version, so `tools/notices/generate.test.ts` fails | Human. Dependabot cannot run the repository's generators: run `npm run notices` (and any other affected generator) on the update branch and commit the result |

**Lockfile.** `versioning-strategy: increase` raises the `package.json` range and the lockfile
in the same pull request, so the manifest always states the version CI ran. A lockfile-only
drift fix is not automated. Run `npm install`, commit the lockfile, and let `npm ci` in CI
prove it reproduces.

**No auto-merge.** Nothing merges an update pull request. Each one runs the same required
checks as any pull request, and `tools/dependency-updates.test.ts` fails if a workflow gains
a merge or Dependabot auto-merge step, or special-cases the Dependabot actor. A future
auto-merge policy is its own decision and pull request.

**Action references.** First-party `actions/*` are referenced by major tag (`@v7`), which
every workflow uses today and which Dependabot updates in place. A third-party action must be
pinned by full commit SHA, with the version in a trailing comment. The same test enforces
both across every workflow file.
