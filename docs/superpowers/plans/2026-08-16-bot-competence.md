# Plan — Walls + whole-map competence, player brain only (PR 2b)

Status: adopted 2026-08-16, implemented on branch `bot-competence`.

Provenance: PR 2b of the bots + AI competence staged plan (`/tmp/bots-competence-plan.md`'s
"PR 2b — Walls + whole-map competence, player brain only"), sequenced after PR 2a (bots
mechanism only, `docs/superpowers/plans/2026-08-16-bots.md`, merged to `main` as #179
before this branch started). Reproduced below as adopted, with one load-bearing premise
in the source plan corrected against what this sim's code actually does (see directive A
part 1 below) rather than assumed from the plan's own prose.

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

## Directive A, part 1 — an intact destructible wall in the only path

**The source plan's premise, corrected.** The plan's own load-bearing-facts section
calls an intact destructible wall a "shoot-through opportunity" and directive A itself
says "shooting it IS a path." Read against `bullets.ts`/`mines.ts` rather than assumed:
a shell never destroys a destructible wall in this sim. `stepBullets`'s wall list
(`world.walls.filter((w) => !w.destroyed)`) treats an intact destructible identically to
solid for collision purposes, and `resolveBulletHits` only ever kills tanks. Only a mine
BLAST destroys a destructible wall (`mines.ts`'s `applyBlast`, gated on
`wallConfigFor(w.kind).destructibleByBlast`). Confirmed with a throwaway probe before
writing any production code: a shell fired straight at a destructible wall for 60 ticks
left `wall.destroyed === false` and the shell itself expired (`bullets alive: 0`).

This does not make directive A's ask incoherent, but it does change what "a valid
decision" can mean: `wallShotPoint` names the DECISION (a clean, plausible shot at an
obstacle that looks breakable) rather than a claim that the shot opens the path, and its
doc comment says so explicitly. Whether the shot ever pays off is a `bullets.ts`
question, out of `player-profile.ts`'s scope by the hard constraint above — surfaced
here rather than silently built on the plan's stated premise, and it is the one
judgment call in this PR that only Austin can make: keep it as a plausible-but-currently-
inert tactic, or treat "shells don't break destructible walls" as a gap worth closing in
`bullets.ts` separately.

**On cost: the evidence is weaker than a clean before/after and should be read that
way.** The re-measured win rate (51/125, 40.8%) sits comfortably above the file's own
`> 0.2` regression guard, but the number it would need to be compared against — the
pre-existing "50/100 (50%)" comment — is not a valid baseline for that comparison: it
was measured at a DIFFERENT population (4 arenas, not 5; arena-05 alone moves the
denominator and adds the hardest arena in the roster, independent of anything this PR
changed). So the honest claim is narrower than "directive A part 1 didn't cost
anything": it is that the new behavior stays well above the guard that would catch a
real regression, not that a same-population before/after was measured. No same-
population comparison was taken because directive A part 1 (destructible-wall shots)
and part 2 (centroid retreat) both landed before any re-measurement was taken, so their
individual costs are not separated in this evidence either.

**Implementation.** `wallShotPoint(from, opponent, walls)`: casts `raySegmentVsAABB`
from `from` toward `opponent.pos` against every non-destroyed wall; if EXACTLY one wall
is crossed and its `kind` is `'destructible'`, returns that wall's own surface point
(the ray's first entry point into its AABB); a second wall on the line (of either kind),
or a lone `'solid'` wall, returns `null`. Wired into `decidePlayerInput`: when the LOS
target-acquisition loop finds no visible tank, `wallShotPoint(player.pos,
threats.nearest, world.walls)` is tried; a non-null result feeds the same
hold-for-`reactionTime`-then-fire gate a live tank solution does, aimed at the wall's
point (no lead term — a wall doesn't move) and jittered by the same `profileAimSpread`.

**Red-first.** Fixture: player at (5,5), one enemy at (15,5), one wall spanning
`x∈[9,10], y∈[4,6]` (crosses the segment at exactly (9,5)) — `kind: 'destructible'` for
the positive case, `kind: 'solid'` for the negative control, byte-identical otherwise.

- Before implementation: the positive fixture (never stepped — `decidePlayerInput`
  called repeatedly on the same static world so "a solution held for N ticks" needs no
  actual movement) never fired across `reactionTicks + 5` calls — **1 of 1** new
  positive-case assertion failed, as expected. The negative-control test **already
  passed** before any production code existed (nothing yet caused a fire on a solid
  wall either) — it exists to catch a wrong, over-eager implementation later, not to be
  red now, exactly as the plan's own wording predicts ("the solid-wall negative control
  CAN fail"). That "can fail" claim was ITSELF checked, not left as an assumption: after
  implementation, `wallShotPoint`'s `kind === 'destructible'` gate was temporarily
  dropped (returning `point` unconditionally, i.e. "fire on any single wall in the way,
  solid or not") and the negative control failed exactly as expected — **1 of 1** —
  before the gate was restored and read back clean (`git diff --stat` empty).
- After the first implementation pass: the positive test still failed, but for a TEST
  bug, not a production one — a loop-index-vs-ticks-held off-by-one (asserting
  `firedAt >= REACTION_TICKS` against a 0-indexed loop counter that fires at index 47
  when 48 ticks have genuinely been held). Confirmed by inspecting the actual fire tick
  (47) against `REACTION_TICKS` (48): the production code fired at the correct tick: the
  test's counting was wrong, not the gate. Fixed the test (counted calls, not loop
  index), re-ran: green.
- Full run after the fix: `src/sim/ai/player-profile.test.ts` — **0 of 11** non-skipped
  tests failing (both directive-A-part-1 tests green; the not-yet-implemented
  directive-A-part-2 test still correctly red at this point, see below).

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
`seekLikeMove`, the directive-A-part-1 wall-shot fallback, and the mine gate — replacing
three separate lookups (the old standalone `nearestEnemy`, called twice redundantly)
with one, which is also what keeps the whole function `O(tanks+mines+walls)` per tick
rather than adding a second scan.

An earlier draft additionally tracked second-nearest opponent and a bare opponent count
(the plan's own prose lists both as summary contents) but neither ever gained a
consumer — `seekLikeMove`'s retreat branch only needed `nearest`/`centroid`, `wallShotPoint`
only needs `nearest`, and the mine gate only needs `nearest`. Caught by the advisor
before landing (a mutation to the second-nearest tracking would have survived the whole
suite, since nothing read it) and cut in a follow-up commit — see Deviations below.
`seekLikeMove`'s retreat branch (`d < PLAYER_MINIMUM_DISTANCE`) now blends away from
`threats.centroid ?? nearest.pos` instead of `nearest.pos` directly; the aim/mine gates
still read `threats.nearest` directly, since a shot or a mine drop is about ONE specific
opponent, not the mass — only the "which way is away from the pressure" question reads
the whole-map summary.

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
- After implementing `assessThreats` and wiring it into `seekLikeMove`: green. Full
  suite: **2534 of 2534** tests pass (2531 baseline + 3 new: destructible-fire,
  solid-negative-control, centroid-retreat), 2 skipped (the two `describe.skip`
  measurement harnesses, `player-profile.test.ts`'s and one elsewhere).

**Directive D compliance, checked.** `grep -n "kind ===" src/sim/ai/player-profile.ts`
after all changes: one hit inside `isOpponent` itself (the sanctioned one), one hit
inside `wallShotPoint` comparing `Wall['kind']` (`'destructible'`) — a different type
entirely from `TankKind`, outside directive D's scope, which is specifically about
opponent/teammate `TankKind` checks — and two hits in comments. No new `TankKind`
literal checks were added outside `isOpponent`.

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
after all three directives landed, not assumed unchanged:

- **125 games** (5 shipped arenas × 25 seeds): **51 wins (40.8%)**, 74 losses, 0
  timeouts; self-mine deaths 6/74 losses (8.1%); fires/game 17.4–48.8; mines/game
  1.52–8.00. All comfortably inside the file's existing (deliberately generous)
  threshold bounds — no threshold changed, only the comments describing what was
  observed.
- **60-seed measurement harness** (`describe.skip`, flipped on once, run with
  `--testTimeout=600000` since the default 5 s vitest timeout is far short of a 5
  arenas × 60 seeds × up to 5-simulated-minutes-each run, then flipped back off):
  win rates 45/60, 35/60, 15/60, 18/60, 8/60 per arena; mines/game 1.73–7.15.

**A pre-existing staleness, found and fixed while re-measuring, not introduced by this
PR.** The prior comment block claimed "4 shipped arenas × 25 seeds = 100 games," which
was already wrong before this branch started — `ARENAS` has carried 5 entries
(arena-05 shipped earlier) the whole time this branch has existed. Fixed in the same
commit as the re-measurement, since leaving a self-contradictory population count next
to freshly-measured numbers would be worse than not touching it. The historical
"aimbot ceiling" buff-experiment paragraph (three specific mutation numbers: 48/100,
15/100, 15/100) was deliberately NOT re-run or re-badged as current — it is now
annotated as measured on the earlier 100-game, 4-arena population, since re-running a
three-way code-mutation experiment is a separate exercise from directive A/B and doing
so silently would have overstated what was actually checked here.

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

- `npx tsc --noEmit` — clean.
- `npm test` (`tsc --noEmit && vitest run`) — 112 files passed, 1 skipped; **2534 tests
  passed, 2 skipped, 0 failed**.
- `npm run mutate` — 13/13 mutation(s) ran against the shipped manifest: 11 killed, 2
  survives (both pre-existing declared `equivalent mutant`/expected survivors), **0
  mismatches** vs. declared outcome. No manifest entry targets `player-profile.ts`
  (confirmed by grep before editing, so there was no risk of a find/replace going
  ambiguous from a moved line). `git status` clean after the run, confirming restoration.
- `npm run build` (`tsc --noEmit && vite build`) — clean; `npm run portability` against
  the built output — clean (`subpath-portable: dist/index.html + 1 bundle(s) + the PWA
  shell checked`).
- `npx vitest run tools/baseline/trace.test.ts` — 7/7 passed, `BASELINE_HASH` unmoved
  (see above).

---

## Deviations from the source plan, named once

1. **Directive A part 1's justification corrected, not just implemented.** The plan's
   "shooting it IS a path" reads as a claim that the shot opens the path; this sim's
   shells never destroy destructible walls (only mine blasts do). The DECISION
   `wallShotPoint` encodes is still built exactly as specified — the plan's own red-first
   fixture only ever asks "does a shot land on the wall's surface," never "does the wall
   come down" — but the doc comments say explicitly what the shot does and does not
   accomplish, rather than silently inheriting the plan's premise.
2. **`self` → `subject` renaming**, forced by `purity.test.ts`'s regex-based guard
   (false positive on a local `self.pos`, not a scope-aware analysis), not a stylistic
   choice.
3. **A pre-existing test-file staleness (4 vs 5 shipped arenas) was fixed in the same
   commit as the required re-measurement**, since it was directly entangled with the
   numbers being corrected — flagged here as a deviation from "only directive A/B's own
   numbers" scope, done because leaving it would have made the corrected comment block
   self-contradictory.
4. **`ThreatSummary.second`/`.opponentCount` were computed, shipped in one commit, and
   removed in a later one.** The plan's own directive A part 2 text lists second-nearest
   and opponent count as summary contents; the actual behavior change (centroid-aware
   retreat) never needed either, and nothing in `player-profile.ts` ever read them —
   caught by the advisor before this work was reported done, not by any test (a
   mutation to the second-nearest tracking would have survived the whole suite). Fixed
   in a follow-up commit (`5d91dfc`) rather than by amending the commit that introduced
   them, per this repo's standing "always create NEW commits rather than amending" rule.
5. **Commit `94cc922` (directive A part 1's implementation) is transiently red if
   checked out on its own**, because it was committed together with directive A part
   2's not-yet-implemented test fixture (both were written in one red-first pass before
   either directive's production code existed). `assessThreats` does not exist yet at
   that commit, so `npx vitest run src/sim/ai/player-profile.test.ts` at that exact SHA
   fails the centroid-retreat test. The tip of the branch is green (confirmed by the
   Full gate above), and no commit's PRODUCTION code is wrong at the point it lands —
   only a test for a not-yet-built later directive is present early. The clean fix is a
   history rewrite (move that one test into `62bf6f1`), which was not done: rewriting
   already-created, non-tip commits (reset/rebase/amend) is exactly what this repo's
   standing git-safety rule reserves for an explicit request, and none was made. Flagged
   here as the documented alternative the advisor named, rather than silently left
   unmentioned.
