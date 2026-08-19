# Testing and review reference

Detailed testing failures and the review policy preserved from the original project instructions. Issue #212 will replace the universal review fanout with an explicit risk-tier model.

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

Nothing reaches `main` without comprehensive adversarial review: reviewers fan out per
subsystem and must prove each finding with a command and its real output, then an
independent pass adjudicates every claim. Re-measure headline numbers yourself rather than
relaying an agent's self-report.

Review agents that *mutate* files each need their own worktree, or they overwrite each
other's experiments and every result becomes noise.
