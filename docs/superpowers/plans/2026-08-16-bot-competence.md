# Plan — Walls + whole-map competence, player brain only (PR 2b)

Status: adopted 2026-08-16, implemented on branch `bot-competence`.

Provenance: PR 2b of the bots + AI competence staged plan (`/tmp/bots-competence-plan.md`'s
"PR 2b — Walls + whole-map competence, player brain only"), sequenced after PR 2a (bots
mechanism only, `docs/superpowers/plans/2026-08-16-bots.md`, merged to `main` as #179
before this branch started). Reproduced below as adopted, with one load-bearing premise
in the source plan corrected against what this sim's code actually does (see directive A
part 1 below) rather than assumed from the plan's own prose.

**Directive A part 1 shipped, then was stripped.** It was built exactly as the source
plan specifies (below, unedited from the original write-up), a probe then found the
decision doubly inert against this sim's real mechanics, and on adjudicated review the
firing behavior was removed — a bot spending a shell on a wall it can never open is
worse than holding fire, not merely a wasted opportunity. The probe finding itself is
kept: it is this PR's most durable output, more valuable than the feature it disqualified,
and it names the real follow-up (mine-breaching) precisely. See "Directive A, part 1"
below for the full sequence, and "Deviations" for exactly what was removed and why.

---

## The hard constraint, held

Every change stays inside `src/sim/ai/player-profile.ts` (production) and its sibling
`player-profile.test.ts`. `git diff --stat 406f05e..HEAD` touches exactly those two
files — `targeting.ts` and `collision.ts` are untouched, confirmed by an empty diff
against both. The trace-safety argument the source plan states is behavioral first,
structural second: `decideAi`'s dispatcher short-circuits `kind === 'player'` to an inert
decision and `stepAi` never calls `decidePlayerInput` for a player tank — the real step
pipeline reaches neither. `decidePlayerInput`'s only production caller is `loop.ts`'s
autoplay/bot substitution, and `tools/baseline/trace.ts` imports `../../src/sim/arena`
and `../../src/sim/world` only. `BASELINE_HASH` was confirmed unmoved empirically at the
end (see Full gate below), not assumed from the argument alone.

Where player-profile.ts needed a wall raycast, it calls `collision.ts`'s
`raySegmentVsAABB` directly — the same primitive `lineOfSight`/`bankShot` in
`targeting.ts` call — rather than adding a parameter to `lineOfSight` or touching
`targeting.ts` at all. `collision.ts` is shared infrastructure already imported by this
file; `targeting.ts` is not, because its helpers are called by `grey.ts`/`teal.ts`/
`brown.ts`, which ARE in the trace's reachable path via `step → stepAi → decideAi`.

---

## Directive D — `isOpponent` consolidation (done first, zero behavior change)

`nearestEnemy`'s positional scan (`player-profile.ts:126` at the time) and the LOS
target-acquisition loop (`:228`) each hardcoded the same `t.kind === 'player'` /
`!== 'player'` check, both gated on `t.alive`, separately. Both now route through one
`isOpponent(world, subject, other)` whose body is exactly that rule:
`other.kind !== 'player' && other.alive`. `world`/`subject` are unused by today's rule
(TypeScript's `noUnusedParameters` only flags a TRAILING unused parameter, so both stay
in the signature, underscored) — kept because this is the seam a later mode-aware
targeting pass (the arc's PR4) swaps in one place instead of hunting down scattered
`kind` checks.

**Named `subject`, not `self`, on evidence, not by preference.** The first draft used
`self`, matching the plan's own prose (`isOpponent(world, self, other)`). Typechecking
was clean, but `npx vitest run src/sim/purity.test.ts` failed:
`./ai/player-profile.ts: forbidden reference to "self"`. The purity guard's regex
(`/(?<!\.)\bself\s*[.[]/`) exists to deny the `self`/`top`/`parent` DOM/worker-global
escape hatches, and it matches by REGEX, not by scope — a local parameter literally
named `self` that is ever dotted (`self.pos`, in `nearestEnemy`'s body) is a real false
positive there, not a hypothetical one. Renamed to `subject` throughout; confirmed clean.

**Red-first, done as a mutation check rather than a new failing test** (the plan's own
framing: "its own mutation check ... existing tests catch it"). `isOpponent`'s body was
temporarily flipped (`!==` → `===`, admitting only player-kind tanks as "opponents",
i.e. the exact inverse of the rule), before any of directive A's tests existed:

- `npx vitest run src/sim/ai/player-profile.test.ts`: **3 of 8** non-skipped tests in
  the file failed (population: the file's 9 tests minus the 1 always-skipped
  measurement-harness test, at that point in the branch's history).
- Full suite: **3 of 2533** tests failed (population: the entire suite at that commit;
  2531 passed / 2 skipped before the mutation, 2528 passed / 3 failed / 2 skipped
  during it) — all three failures were the same three, in that one file.

Reverted and read back (`git diff --stat` empty) before committing the real predicate.

---

## Directive A, part 1 — an intact destructible wall in the only path (implemented, then stripped)

This section records the full sequence in the order it happened: built per the source
plan, disqualified by a probe, removed on adjudicated review, follow-up named. Nothing
below is hypothetical — every step actually ran.

**Step 1 — implemented per the source plan, as written.** The plan's own
load-bearing-facts section calls an intact destructible wall a "shoot-through
opportunity" and directive A itself says "shooting it IS a path": when the direct line
to the nearest KNOWN opponent (positional, not LOS-gated) crosses exactly one intact
wall and that wall is destructible, aim at and fire on the wall's own surface point.
Built as `wallShotPoint(from, opponent, walls)`: cast `raySegmentVsAABB` from `from`
toward `opponent.pos` against every non-destroyed wall; if EXACTLY one wall is crossed
and its `kind` is `'destructible'`, return that wall's own surface point (the ray's
first entry into its AABB); a second wall on the line (of either kind), or a lone
`'solid'` wall, returns `null`. Wired into `decidePlayerInput` so that when the LOS
target-acquisition loop finds no visible tank, a non-null `wallShotPoint` result fed the
same hold-for-`reactionTime`-then-fire gate a live tank solution does. Red-first, exactly
as the plan asked: a fixture (player at (5,5), enemy at (15,5), one wall spanning
`x∈[9,10], y∈[4,6]`) failed to fire before the code existed (**1 of 1**), the
byte-identical solid-wall negative control already passed (nothing fired yet), and after
implementation the negative control was PROVEN able to fail — not just assumed — by
temporarily dropping the `kind === 'destructible'` gate and watching it go red
(**1 of 1**) before reverting. Full detail of this build, including a test-counting bug
caught and fixed along the way, is preserved in git history (commits `94cc922`,
`62bf6f1`) and is not repeated here since the code it describes no longer ships.

**Step 2 — a probe found the decision doubly inert against this sim's actual
mechanics.** This is the most durable finding in this PR, more valuable than the feature
it disqualified, and it is kept prominent for that reason:

1. **A shell never destroys a destructible wall in this sim.** Read against
   `bullets.ts`/`mines.ts` rather than assumed. `stepBullets`'s wall list
   (`world.walls.filter((w) => !w.destroyed)`) treats an intact destructible identically
   to solid for collision purposes, and `resolveBulletHits` only ever kills tanks. Only a
   mine BLAST destroys a destructible wall (`mines.ts`'s `applyBlast`, gated on
   `wallConfigFor(w.kind).destructibleByBlast`). Confirmed with a throwaway probe: a
   shell fired straight at a destructible wall for 60 ticks left `wall.destroyed ===
   false` and the shell itself expired (`bullets alive: 0`).
2. **Destructible walls are never merged, so a real barrier is usually more than the one
   cell the gate allows.** `arena.ts`'s own comment: "PASS 2b -- destructible walls, one
   per cell, never merged" (CLAUDE.md: "arena-02's centre barrier is authored as adjacent
   blocks"). Solid walls get merged into maximal rectangles (`mergeSolidRuns`);
   destructible walls do not, by design, so a real destructible barrier more than one
   cell thick along the ray's crossing direction is represented as MULTIPLE separate
   `Wall` entries — and `wallShotPoint`'s "exactly one wall on the line" gate returns
   null the moment it meets a second wall. Not a bug (the red-first fixture is
   deliberately a single cell and correctly passed the removed code), but it means the
   gate only ever fired against a single-cell-thick obstruction, not a real multi-cell
   barrier like arena-02's.

Combined: the decision was structurally unlikely to trigger against shipped arena
geometry, AND inert on the rare occasion it did.

**Step 3 — stripped on adjudicated review.** The owner did not answer in the review
window; the coordinator adjudicated on the flagged recommendation: a bot shelling a wall
that shells cannot destroy wastes a `weapon.maxActiveProjectiles` slot, which is WORSE
than holding fire, not merely a missed opportunity — the exact failure mode this file's
own "aimbot ceiling" experiment already measured for a related case ("a wall-blind
target wastes fire on an enemy it cannot hit," win rate 48/100 vs 50/100 unmodified).
`wallShotPoint` was removed entirely (no remaining caller once the firing branch was
gone), along with its positive fixture and the dropped-gate negative-control check. The
`isOpponent` seam, `assessThreats`/centroid retreat, the measured-cost profiling work,
and this discovery record all stayed.

**Step 4 — mine-breaching queued as the follow-up that uses the real mechanic.** The
probe's own findings point at the fix: destructible walls DO come down, just to a mine
blast, not a shell. A future PR that has the player recognize "this destructible wall is
worth mining toward, or worth laying a mine near, to open a path" would use the
mechanic that actually works, rather than one confirmed inert. Not scoped or designed
here — named as the concrete next step this PR's own probe work makes cheap to specify,
not built. `wallShotPoint`'s wall-kind raycast shape (cast a ray, discriminate
`w.kind === 'destructible'` from `'solid'`) is the reusable part; it returns, if it
returns, alongside that increment's real consumer — not resurrected speculatively ahead
of it, per this repo's "a generator nothing calls rots" rule.

---

## Directive A, part 2 — whole-map threat summary, centroid-aware retreat

**Implementation.** `assessThreats(world, subject)` is a single bounded `O(tanks)` pass
(no pairwise term) building `{ nearest, centroid }` — nearest opponent by straight-line
distance (positional, not LOS-gated, the same sense `nearestEnemy` always used) and the
centroid of every opponent's position. `centroid` is defined to equal `nearest.pos`
exactly when there is one opponent, which is what makes every consumer that reads
`centroid` in place of `nearest.pos` behavior-identical in the single-opponent case and
only diverge once a second opponent presses at the same time. Computed ONCE per call in
`decidePlayerInput` (`const threats = assessThreats(world, player)`) and threaded to
`seekLikeMove` and the mine gate today — replacing what were three separate lookups
before this PR (the old standalone `nearestEnemy`, called twice redundantly) with one,
which is also what keeps the whole function `O(tanks+mines+walls)` per tick rather than
adding a second scan. At the time this was first wired, `threats.nearest` also fed the
directive-A-part-1 wall-shot fallback described above; that consumer is gone (see Step 3
there), but `assessThreats` itself is unaffected — `nearest` still has two real
consumers, `centroid` still has one, and both survive the strip untouched.

An earlier draft additionally tracked second-nearest opponent and a bare opponent count
(the plan's own prose lists both as summary contents) but neither ever gained a
consumer — `seekLikeMove`'s retreat branch only needed `nearest`/`centroid`, the (now
removed) wall-shot fallback only needed `nearest`, and the mine gate only needs
`nearest`. Caught by the advisor before landing (a mutation to the second-nearest
tracking would have survived the whole suite, since nothing read it) and cut in a
follow-up commit — see Deviations below. `seekLikeMove`'s retreat branch (`d <
PLAYER_MINIMUM_DISTANCE`) blends away from `threats.centroid ?? nearest.pos` instead of
`nearest.pos` directly; the mine gate still reads `threats.nearest` directly, since a
mine drop is about ONE specific opponent, not the mass — only the "which way is away
from the pressure" question reads the whole-map summary.

**Red-first.** Fixture: player at the origin; one opponent at (0, −2) (inside
`PLAYER_MINIMUM_DISTANCE`, the nearest); a second at (0, 6) (pulls the centroid to
(0, 2), north of the player — the OPPOSITE side from the nearest opponent, so
nearest-only-away and centroid-away point in genuinely different directions by
construction, not a coincidence of the fixture). Seed selection was **not** done by
hand-counting RNG draws — an earlier attempt did exactly that and miscounted (missed
that `createPlayerAiState` itself consumes one `rnd()` call before `decidePlayerInput`
ever runs, shifting every subsequent draw by one), caught before it produced a wrong
seed by having the advisor flag the miscount. Corrected method: scan seeds 1..300
against the CURRENT (pre-`assessThreats`) code, keep one where the retreat draw actually
fires and the resulting `move` matches the hand-computed nearest-only-away direction
exactly (confirms the seed exercises the branch under test, not merely that a draw
happened). Seed 3 selected this way. The test itself also carries a self-check
(`vdist(input.move, wander) > 0.05`, i.e. "the retreat draw fired at all") so a future
change that stops reaching the retreat branch on this seed fails loudly rather than
passing vacuously.

- Before `assessThreats` existed (this fixture was added in the SAME commit as directive
  A part 1's tests, so both were red together): **1 of 1** new centroid-retreat
  assertion failed — the actual `move` matched the OLD nearest-only-away direction, not
  the new centroid-away one (`0.6162` vs `0.7876` on the x component, a genuine
  divergence, not a rounding-level near-miss).
- After implementing `assessThreats` and wiring it into `seekLikeMove`, at the time
  directive A part 1 still shipped: full suite **2534 of 2534** tests passed (2531
  baseline + 3 new: destructible-fire, solid-negative-control, centroid-retreat), 2
  skipped. **After directive A part 1 was later stripped** (its two tests removed with
  it): full suite **2532 of 2532** tests pass (2531 baseline + 1 remaining new:
  centroid-retreat), 2 skipped — 2534 total including skips, matching the Full gate
  section below.

**Directive D compliance, checked (post-strip state).** `grep -n "kind ===\|kind !=="
src/sim/ai/player-profile.ts`: one hit inside `isOpponent`'s own body (`other.kind !==
'player'`, the sanctioned one) and two hits in comments (one quoting that same rule
historically, one referencing `ai/index.ts`'s unrelated `idleDecision` short-circuit).
No `TankKind` literal check exists outside `isOpponent`. (While directive A part 1
shipped, there was also a `Wall['kind']` comparison inside `wallShotPoint` — a different
type from `TankKind` entirely, always outside directive D's scope; it is gone now along
with the function that carried it, not because it was ever a directive D concern.)

---

## Profiling — measured, not assumed negligible

The source plan states the profiling TARGET ("at up to ~4 players + 5 enemies + <100
walls + <10 mines, a linear pass is negligible against `TICK_HZ = 60`") and explicitly
defers the actual timed run to this PR's own verification step. Measured with two
throwaway harnesses (not committed — profiling code has no home inside
`player-profile.ts`'s own scope and the plan does not ask for one):

- **Real driven session**, arena-04 (the largest shipped arena: 7 tanks, 39 walls),
  20,000 ticks through `step()` + `decidePlayerInput` together: 67.45 µs/call including
  `step()`'s own cost. Isolating `decidePlayerInput` alone (same populated world
  snapshot, called repeatedly without advancing, 50,000 calls): **3.465 µs/call**.
- **Synthetic stress scenario at the plan's stated bound** — 4 players + 5 enemies (9
  tanks total), 90 walls, 9 mines, 20,000 calls after a 500-call warmup: **5.234
  µs/call**.

Against the 60 Hz frame budget (16,667 µs/tick): **0.031% of one tick's budget** at the
stress bound. "Negligible" is not asserted from the plan's prose; it is this measured
contrast — the largest observed per-call cost across both scenarios is over three orders
of magnitude below the budget it would have to compete with, and it does not grow with
tank/wall/mine count in a way that threatens that margin at any plausible roster size.

---

## Re-measurement — headline numbers move, thresholds don't

Per this file's own convention ("counts are a property of the tree at the moment you ran
them — measure them LAST"), the pinned population's headline numbers were re-measured
TWICE: once after all three of directive A part 1, part 2 and the isOpponent seam
landed, and again after directive A part 1 was stripped. Neither was assumed unchanged
from the other.

- **With directive A part 1 still active** — 125 games (5 shipped arenas × 25 seeds):
  51 wins (40.8%), 74 losses, 0 timeouts; self-mine deaths 6/74 losses (8.1%);
  fires/game 17.4–48.8; mines/game 1.52–8.00.
- **After directive A part 1 was stripped** — same 125-game population: **51 wins
  (40.8%)** (the overall win/loss split happens to match exactly), 74 losses, 0
  timeouts; self-mine deaths **10/74 losses (13.5%)**; fires/game **13.4–55.8**;
  mines/game **1.44–7.80**. The per-arena breakdown and self-mine share did NOT match
  the prior measurement even though the totals did — this sim is deterministic but
  chaotic, so removing one behavior changes the game from that tick on, not just that
  behavior's own footprint (the same caveat `PLAYER_MINE_CHANCE`'s own comment in
  `player-profile.ts` already documents for a different gate). All numbers stay
  comfortably inside the file's existing (deliberately generous) threshold bounds — no
  threshold changed at either measurement, only the comments describing what was
  observed.
- **60-seed measurement harness** (`describe.skip`, flipped on once, run with
  `--testTimeout=600000` since the default 5 s vitest timeout is far short of a 5
  arenas × 60 seeds × up to 5-simulated-minutes-each run, then flipped back off):
  win rates 45/60, 35/60, 15/60, 18/60, 8/60 per arena; mines/game 1.73–7.15 — taken
  ONLY while directive A part 1 was still active. NOT re-run after the strip (an
  expensive ~150–220 s run, and this number is prose-only documentation in
  `PLAYER_MINE_CHANCE`'s comment, not a pinned assertion); that comment is annotated
  to say so explicitly rather than silently carrying a now-unverified figure.

**A pre-existing staleness, found and fixed while re-measuring, not introduced by this
PR.** The prior comment block claimed "4 shipped arenas × 25 seeds = 100 games," which
was already wrong before this branch started — `ARENAS` has carried 5 entries
(arena-05 shipped earlier) the whole time this branch has existed. Fixed in the same
commit as the first re-measurement, since leaving a self-contradictory population count
next to freshly-measured numbers would be worse than not touching it. The historical
"aimbot ceiling" buff-experiment paragraph (three specific mutation numbers: 48/100,
15/100, 15/100) was deliberately NOT re-run or re-badged as current at either
measurement — it stays annotated as measured on the earlier 100-game, 4-arena
population, since re-running a three-way code-mutation experiment is a separate
exercise from this PR's own directives and doing so silently would have overstated what
was actually checked here.

---

## Trace argument, confirmed empirically

`npx vitest run tools/baseline/trace.test.ts`: 7/7 passed,
`BASELINE_HASH` printed as `324aa9b5d369ec6abc61f73e8e454de67b5fbf365f4b0df2eedf2c01add33bb5`
— matching the pin CLAUDE.md quotes for the 5-arena trace, unmoved. The three-engine
`npm run trace:browser -- --all` check was judged unnecessary here, on the same
categorical argument PR 2a's own plan used: every edit in this PR lives inside
`src/sim/ai/player-profile.ts`, which is outside `trace.ts`'s import graph entirely
(`../../src/sim/arena` and `../../src/sim/world` only) — there is nothing for a second
engine to disagree with the first about.

---

## Full gate — all exit code 0

Run twice: once with directive A part 1 still shipped, again at the final, stripped
state. Numbers below are the FINAL (post-strip) run; both runs were clean.

- `npx tsc --noEmit` — clean.
- `npm test` (`tsc --noEmit && vitest run`) — 112 files passed, 1 skipped; **2532 tests
  passed, 2 skipped, 0 failed** (2534 total; down from 2534 passed/2536 total while
  directive A part 1's two now-removed tests were still in the file).
- `npm run mutate` — 13/13 mutation(s) ran against the shipped manifest: 11 killed, 2
  survives (both pre-existing declared `equivalent mutant`/expected survivors), **0
  mismatches** vs. declared outcome. No manifest entry targets `player-profile.ts`
  (confirmed by grep before editing, so there was no risk of a find/replace going
  ambiguous from a moved line). `git status` clean after the run, confirming restoration.
- `npm run build` (`tsc --noEmit && vite build`) — clean; `npm run portability` against
  the built output — clean (`subpath-portable: dist/index.html + 1 bundle(s) + the PWA
  shell checked`).
- `npx vitest run tools/baseline/trace.test.ts` — 7/7 passed, `BASELINE_HASH` unmoved
  (see above) — confirmed again after the strip, unchanged, since the strip is also
  entirely inside `player-profile.ts`.

---

## Deviations, named once

**Directive A part 1 was built, then removed, on an explicit adjudicated decision — not
a self-caught deviation like the rest of this list.** It is the headline event of this
PR and is documented in full in its own section above (Directive A, part 1), not
repeated here. The remaining items below ARE this-agent-caught deviations from either
the source plan or from the first pass at implementing it.

1. **`self` → `subject` renaming**, forced by `purity.test.ts`'s regex-based guard
   (false positive on a local `self.pos`, not a scope-aware analysis), not a stylistic
   choice.
2. **A pre-existing test-file staleness (4 vs 5 shipped arenas) was fixed in the same
   commit as the required re-measurement**, since it was directly entangled with the
   numbers being corrected — flagged here as a deviation from "only directive A/B's own
   numbers" scope, done because leaving it would have made the corrected comment block
   self-contradictory.
3. **`ThreatSummary.second`/`.opponentCount` were computed, shipped in one commit, and
   removed in a later one.** The plan's own directive A part 2 text lists second-nearest
   and opponent count as summary contents; the actual behavior change (centroid-aware
   retreat) never needed either, and nothing in `player-profile.ts` ever read them —
   caught by the advisor before this work was first reported done, not by any test (a
   mutation to the second-nearest tracking would have survived the whole suite). Fixed
   in a follow-up commit (`5d91dfc`) rather than by amending the commit that introduced
   them, per this repo's standing "always create NEW commits rather than amending" rule.
4. **Commit `94cc922` (directive A part 1's original implementation, since superseded by
   the strip) was transiently red if checked out on its own**, because it was committed
   together with directive A part 2's not-yet-implemented test fixture (both were
   written in one red-first pass before either directive's production code existed).
   `assessThreats` did not exist yet at that commit, so `npx vitest run
   src/sim/ai/player-profile.test.ts` at that exact SHA failed the centroid-retreat
   test. No commit's PRODUCTION code was ever wrong at the point it landed — only a
   test for a not-yet-built later directive was present early, and that whole test (and
   the code it tested) is gone again as of the strip. The clean fix would have been a
   history rewrite (move that one test into `62bf6f1`); not done then and moot now,
   since `94cc922`'s own subject (directive A part 1) no longer exists at the tip of
   the branch. Left in git history rather than rewritten, per this repo's standing rule
   against amending/rebasing already-created commits without an explicit request.
5. **The wall-strip itself needed one more small correction on re-measurement.**
   `PLAYER_MINE_CHANCE`'s comment in `player-profile.ts` initially claimed the 60-seed
   mines-per-game figure was "not re-measured again... since mine-laying cadence is not
   the thing that changed" — written before actually re-measuring the 25-seed pinned
   population, which then showed mines/game DID move (1.52–8.00 → 1.44–7.80) even
   though nothing about mine-laying itself changed, only wall-shooting. Corrected before
   committing: the sim is chaotic-deterministic, so an unrelated behavior change can
   move a downstream number, and the comment now says exactly that instead of the
   (checked and found wrong) original claim.
