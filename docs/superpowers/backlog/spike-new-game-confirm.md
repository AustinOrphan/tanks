---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Spike -- should New Game confirm before abandoning an active run?
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Spike: should New Game confirm before abandoning an active run?

**Raised 2026-08-12**, implementing issues #153/#152 (the campaign-run model,
`docs/superpowers/specs/2026-08-11-campaign-run-model.md`).

**The question:** New Game now explicitly replaces whatever campaign run was active
(`RunStore.startNewRun`) -- level, lives, all of it, gone. Issue #153 says this
"should not happen accidentally as a side effect of menu navigation", which the split
from Level Select already satisfies (New Game is its own dedicated title-screen
button, not an event Level Select can also fire). What it does not settle is whether
a DELIBERATE click on that button, with a run genuinely in progress (lives short of
full, well past level 1), should ask "are you sure?" before discarding it.

**Why it is open rather than decided here:** the pre-existing baseline (before this
PR) had zero confirmation on the equivalent action -- New Game reused Level Select's
own wiring and rebuilt the world immediately on click, same as every other title
button. This PR does not regress that; if anything New Game is now a more deliberate,
single-purpose affordance than it was. Adding a confirm dialog is new UX scope this
PR was not asked to design, and "is losing a life or two and several levels of
progress expensive enough to warrant an extra click" is a product call, not
something the code can answer.

**What would answer it:** an owner decision on whether New Game should confirm when
`RunStore.active()` is non-null with `livesRemaining < LIVES` or `currentLevelId !==
'0'` at click time (a run genuinely in progress, as opposed to one just started and
immediately restarted). If yes, the affordance is small -- a second click state on the
existing button, or a native `confirm()` -- and belongs in `hud.ts` alongside the
button it guards.

**Not scheduled.** Recorded so it is not rediscovered while reviewing this PR's
successors.

---
