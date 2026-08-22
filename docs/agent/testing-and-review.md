# Testing and review reference

Detailed testing failures and the repository's risk-tiered verification policy.

## Testing conventions, learned the hard way

These are not style preferences. Each one exists because a real defect shipped green.

**Unit files call sim stages directly, so they cannot see composition.** `movement.test.ts`
and friends call `stepMovement` themselves, which means deleting the call from `step()`
leaves them passing. Composition is pinned separately, through `step()` alone, in
`src/sim/step-pipeline.test.ts`. Anything asserting *that a stage runs* or *in what order*
belongs there and must not call the stage directly.

**Presence-only assertions on the event stream are close to worthless.** The stream is
shared: `some(e => e.type === 'fire')` passes on an AI tank's shell even when the player's
event is dropped entirely. Discriminate by `ownerId`, and assert payloads (`pos`, `angle`)
— `particles.ts` draws bursts at exactly `ev.pos`, so a wrong position is a visible defect
that no presence check catches.

**Prove the gap before writing the test.** Apply the mutation, watch the suite pass, then
write the test, then watch the mutation die. A test that never failed proves nothing.

**Sweep classes, state denominators.** Write "32 of 36 (population: all 36 distinct
single-element moves)", never "32 of 36". A count without its population reads as an
exhaustive sweep. Name any class you did *not* sweep. This repo has twice shipped a
survivor hiding in an unstated remainder.

Two habits that come from the same place. The RECURRING failure is attribution rather than
arithmetic — the figure was really measured, then carried into a sentence it was not
about. (The deployment history also records a plain miscount, four keys where there
were five, which no amount of naming the probe would have caught.) **State the derivation
inline** so the arithmetic is checkable (`skins.ts:142`: "5,832 accents on a 15-step RGB
grid (18 values a channel, 18^3)"). And **when two probes appear in one paragraph, put
each one's population next to its number** — `skins.test.ts:771` does this explicitly,
because an earlier draft there conflated them and quoted a 483,695 hit count from the
909,792-pair probe against the coarser 33,696-pair sweep, claiming more hits than the
sweep had trials. That is catchable by reading alone, but only if the populations are on
the page.

**Counts are a property of the tree at the moment you ran them**, so measure them LAST:
writing a test changes them. `tools/mutate/run.mjs:32` exists because of this — "fails 4
of 12" quietly becoming "fails 5 of 13" when a test is added is `killed` both times, which
is why the manifest carries `expectFailures` rather than an outcome alone. The same
applies to any test total quoted in a PR body.

**Every assertion must be able to fail.** Before adding one, name the production change
that would break it. Watch for tautologies against the fixture: asserting `angle: 0` in a
fixture whose angle is 0 passes even when the field is hardcoded. Decorative assertions are
worse than none — they advertise coverage that does not exist.

**Files no test reads are where defects live forever.** `hud.css` lost a closing brace in
a merge and silently swallowed every rule after it -- the entire losing-a-life vignette was
dead on `main` for as long as the feature existed, and a second merge did the identical
thing to the round banner. Neither `tsc` nor any test could see it, because CSS is not
typechecked and nothing read it. `hud.css.test.ts` now checks brace balance, checks no
block opens inside a plain rule (at-rule aware), and checks the selectors features depend
on are still present. It needs `test.css: true` in `vite.config.ts`: vitest stubs CSS
imports, so `?raw` returns an **empty string** and every assertion passes vacuously --
which is why that guard asserts it loaded something first. Any new stylesheet wants the
same treatment.

**A guard is worth what its own tests prove.** The purity guard reported green for four of
five known-bad imports until it was given a meta-test. Guards need negative controls.

**An assertion can stop meaning what its name says without anyone touching it.** It does
not need to be edited to go blind — its SUBJECT changing underneath it is enough, which
makes this different from the tautology-at-write-time above. Two cases, and the useful
thing about both is that each was caught inside the PR that broke it, which is why either
is recoverable at all:

- `clouds is LIGHT on every hull that has room to be` took the commonest tone in the tile,
  on the stated reasoning that this was the painted one. That reasoning held only while
  clouds was dense — an unstated property of its subject. #139's density swap made the
  HULL the majority tone, so the comparison became `hullL < hullL` and could never hold;
  forcing the production function to darken unconditionally left it GREEN, the exact
  property it exists to guard, inverted. Measured over all 6 shipped hulls at both
  commits: the hull's share goes 0.2791 -> 0.5781, and goes from not being the top tone to
  being it, on every one. Broken and repaired inside #139.
- The metric separating camo from clouds was EDGE HARDNESS, which worked only while clouds
  had a ramped rim. Reverting that generator made both skins hard-edged and the metric
  read 0.0000 for BOTH — it would have had to be asserted as EQUAL to keep passing. Also
  written and replaced inside #139.

The rule: **when you change what a test's subject is, re-run that test's own mutation
against it.** A test written against the old subject is evidence about the old subject
only. `skins.test.ts` records both cases in place, each with the mutation that proves the
repaired form fails.

**A guard blind to one dimension stays green until that dimension moves.** Reversing
`applyPlayerInputs`' loop order (`for (i = n - 1; i >= 0; i--)`, pairing untouched) passed
the WHOLE gate as it then stood: 87 files passed, 1730 passed, 2 skipped, 0 failed. The
neighbouring two-player test `.sort()`s the ownerIds — correct for the question it asks
("did each player get its own shell") and exactly what hid the ordering. It is not
cosmetic: `world.nextId++` is consumed in drive order, so the reversal renumbers every
shell. Pinned unsorted now, in `step-inputs.test.ts`. The golden trace passed too, but for
a reason that does not generalise: the trace drives ONE player, so `n` is 1 on every tick
and reversing a one-element loop is bit-identical. Before trusting a suite as a behaviour
proof, name the dimension it sorts, rounds or aggregates away.

**A green local gate is not necessarily the gate.** Three ways it has lied here:

- **`node_modules` drifting from the lockfile.** A worktree in this repo sat on vite
  5.4.21 / vitest 2.1.9 while `package-lock.json` pinned 8.1.5 / 3.2.7 — versions
  `package.json`'s own `^8.1.5` / `^3.2.7` ranges do not even admit — and one
  `tools/mutate` test failed locally and nowhere else. `npm ci` fixed it. The direction
  was luck: a stale tree can as easily go green on something CI fails. If a local result
  disagrees with CI, check `npx vitest --version` against the lock before debugging the
  code.
- **Most of `tools/` is typechecked by nothing — `tools/mutate/` is now the exception.**
  `tsconfig.json`'s `include` was `["src", "vite.config.ts"]`, while `vite.config.ts` runs
  `tools/**/*.test.ts` — so those tests RUN under `npm test` and `tsc` never read the
  files. A duplicate declaration there passes the gate and surfaces as a bare timeout
  under `npm run test:gl`. Issue #134 extracted `tools/mutate/` into its own workspace
  package and added `tools/mutate/orchestrate.test.ts` to `include`, with `allowJs` +
  `checkJs` on: that one entry point imports all three `.mjs` files DIRECTLY at value
  level (`lib.mjs`, `orchestrate.mjs`, and `run.mjs` at its line ~50), so all four files
  are real, `noImplicitAny`-checked TypeScript input now — not just the `.ts` file.
  Proven active, not assumed: an injected JSDoc type violation fires TS2322 in each of
  the three `.mjs` files. Every OTHER tool (`tools/gl/harness.ts`, `tools/gallery/`,
  `tools/baseline/`, …) is still exactly as unchecked as this bullet used to describe. See
  backlog item 9, under "Customize preview residuals" — that numbering is
  section-relative, so grep the title rather than trusting the number.
- **A zero exit code is not verification.** Separate shell lines do not inherit the
  previous line's failure: a heredoc `python3` that raised and wrote nothing, followed by
  `gh pr edit --body-file`, re-published the UNCHANGED body and printed "edited". Read the
  value back and grep it for the string you expect to be **gone**, not only the one you
  expect to be there.

**A cleanup call at the end of a combined test can erase exactly the state its own
assertion exists to catch.** The #156 review's adversarial mutation made `advanceLevel`
CONJURE a run into existence when none was active — a real defect, since practice and
any non-campaign session must never be able to do that. It passed all 25 of
`run.test.ts`'s tests anyway: the pre-existing test called `advanceLevel`, then
`setLivesRemaining`, then `endRun`, with one assertion at the very end — and `endRun`'s
own no-op-when-no-run guard fires last regardless, writing the shadow back to `null` and
cleaning up the mutation's evidence before the single trailing assertion ever ran. Split
into ISOLATED per-method tests — each on its own fresh store, each checked immediately
after its one call, nothing after it to clean up — and the mutation is caught. The
general form: a test combining several calls with one assertion at the end is blind to
any defect a LATER call's own no-op path happens to undo: `run.test.ts`'s
`describe('createRunStore: no run yet', ...)` block carries the repaired version.

## Merge bar

Classify the complete diff before choosing verification. The tier is a minimum, not a
ceiling. A mixed change inherits the highest tier present, and uncertainty moves the
change up rather than down. Tests or documentation accompanying a production change do
not reduce that production change's tier.

### Low risk

Use for changes that cannot affect executable behavior, build output, tests, deployment,
or agent behavior:

- prose-only documentation and spelling fixes
- comments that do not contain executable examples or directives
- issue templates and narrowly scoped non-runtime metadata
- generated documentation only when its source and generator are unchanged

Minimum evidence:

- inspect the complete diff and verify both the intended change and expected absences
- run directly relevant formatting, documentation, link, or generator-drift checks
- perform a concise self-review of accuracy, stale references, and unsupported claims

Keep low-risk work in the main conversation. Do not create reviewer or implementation
fanout merely to satisfy a process ritual.

### Standard risk

Use for contained changes whose failure is limited to one ordinary subsystem and does not
alter a high-risk contract:

- ordinary game, input, audio, HUD, or UI behavior outside persistence and renderer/WebGL
  infrastructure
- local styling or presentation changes
- focused tests, developer tools, and non-release configuration
- repository instructions and review policy that change agent behavior
- refactors contained within one non-critical subsystem

Minimum evidence:

- run `npm run verify:quick` (typecheck plus the complete unit suite)
- add `npm run verify:build` when production output can change
- inspect the affected subsystem's callers, consumers, and negative cases
- perform a focused self-review; delegate only if a separate bounded question justifies it

Any user-visible result also requires visual evidence, even when the implementation is
otherwise standard risk.

### High risk

Use when a defect could violate a core invariant, corrupt durable state, affect releases,
or cross subsystem boundaries:

- deterministic simulation, AI, collision, balance, arena, or campaign rules
- save/persistence compatibility, campaign/run state, achievements, or imported data
- renderer/WebGL infrastructure and shared render lifecycle
- CI, build, dependency/engine, release, deployment, or GitHub Pages behavior
- shared events, public types, security boundaries, or any cross-cutting change with
  multiple independent consumers

Minimum evidence:

- from a clean candidate worktree, run `npm run verify:full`, the complete core
  non-browser gate; its mutation phase refuses uncommitted changes to manifest targets
- run every affected subsystem-specific check, such as the golden trace for simulation,
  persistence compatibility tests, WebGL/visual checks, or built-output portability
- adversarially review invariants, failure modes, compatibility, and expected absences
- independently reproduce material measurements and claims from primary output

High risk requires strong review, not automatic fanout. Delegate only concrete independent
investigations that benefit from isolated context, large-output containment, or useful
parallelism. The lead agent owns synthesis, adjudicates every finding, and reruns the
evidence it relies on.

### Cross-tier evidence

- Visual evidence and `npm run verify:visual` are mandatory for any user-visible CSS, HUD,
  renderer, animation, skin, authored asset, or layout change. Rendering infrastructure
  remains high risk even when the visible diff looks small.
- Run `npm run verify:build` when changing Vite base/output behavior, `index.html`, public
  assets, the manifest/PWA shell, Pages/release workflows, or artifact paths.
- Simulation behavior needs the golden trace in addition to behavioral tests;
  determinism alone proves only self-consistency.
- Recompute quoted counts and measurements after the final tree changes.

### Delegation

Use the main conversation for quick targeted work, iterative changes, and phases that share
substantial context. Delegate when the question is concrete, bounded, independent, and can
return a reviewable summary without repeated coordination. Good candidates include noisy
logs, an isolated subsystem audit, or independent research that would otherwise flood the
main context.

Do not delegate solely because a tier is high, and do not split coupled work across agents
that must repeatedly exchange the same context. Every delegated task needs an explicit
scope and expected evidence. Any worker that mutates files must use its own worktree; a
read-only investigation may share the checkout. The lead agent verifies returned claims
before using them as merge evidence.
