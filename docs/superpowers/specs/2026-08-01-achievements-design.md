# Achievements (approved 2026-08-01)

The design feedback: "achievements might be a good idea / and eventually we can tie some of these
customizations to those achievements."

## What this is

A latched list of named feats, evaluated from data the game already collects. The
stats work (PR #56) built nine lifetime counters and a per-run tally fed by the
attributed event stream; `progress.ts` tracks the highest level cleared. Achievements
are an evaluator over those, plus one new store holding *what has been earned*.

## Approved shape

**Scope: cumulative milestones AND per-run feats.** Lifetime thresholds ("100 shell
kills") and single-round feats ("clear a level without dying"). The run tally already
resets per level in `switchTo`, so feats need no new counters — only an evaluation
moment at the win.

**Reset: latched, cleared by Reset progress.** Once earned, an achievement stays
earned even if lifetime stats are zeroed — an achievement is a record of something
that happened, not a view of a counter. Semantically it is progress, so the existing
two-click Reset progress clears it and no third danger button appears on the stats
page. This is the reason the store latches rather than deriving: a derived list would
silently un-earn everything on a stats reset, and could not represent run feats at all.

**Placement: its own page from the main menu**, beside Stats and Customize. Locked
entries stay visible with their criteria — the list is the natural home for unlock
gating later.

**Feedback: a brief HUD toast** naming the achievement, reusing the banner machinery.
Earning something mid-firefight should be visible without pausing anything.

## Architecture

`src/game/achievements.ts`, game layer only, following progress/stats/customization:
one localStorage key (`tanks.achievements.v1`), corrupt data reads as "none earned",
throwing storage degrades to an in-memory shadow, unknown ids in storage are dropped
(a renamed achievement must not resurrect as a ghost row).

- `AchievementDef { id, label, description, earned(ctx) }` — the catalog is data, and
  `earned` is a **pure predicate**, so every entry is testable without a game.
- `AchievementContext { lifetime, run, highestCleared, totalLevels, clearedLevel,
  livesLeft, tracksProgress }`. `clearedLevel` is non-null **only on the frame a win
  lands**, which is what keeps a run feat from re-firing on later frames of the same
  run. `livesLeft` serves Survivor. `tracksProgress` exists because the dev sandbox is
  a one-level set: without it, Campaigner's denominator collapses to 1 and anyone who
  has cleared level 1 latches "clear every level" by opening `?level=sandbox`.
- `store.check(ctx)` evaluates the catalog, latches anything newly true, and **returns
  the newly earned defs** — that return value is the toast queue. Already-earned
  entries never re-return, so the toast cannot repeat.

The sim never sees any of this: achievements read the event-derived tallies the game
layer already keeps, and `src/sim/` imports nothing from here.

## Evaluation points

Two, both in `loop.ts`:

1. **Per frame-events batch**, right after `stats.record` — cumulative milestones can
   land mid-firefight.
2. **At the win**, but *not* directly from `sm.onChange`. The winning `tank-destroyed`
   and the `win` event ride one `step()` batch, and the driver routes it to the state
   machine — which flips synchronously — **before** `onFrameEvents`, where
   `stats.record` runs. Evaluating from the state change therefore reads a run tally
   one kill short: Dead Eye unearnable on a normal clear, Bomb Squad blind to a
   single-mine-kill win, Flawless granted for a mutual kill. So `onChange` only
   **latches** `pendingClear = level + 1`, and the same frame's `onFrameEvents`
   consumes it after `stats.record`. `progress.recordCleared` still happens at the
   state change, so level milestones see the clear; and recording at the win rather
   than at the Next Level click means quitting after a win keeps both.

## The catalog (14)

Cumulative: First Blood (1 shell kill), Marksman (25), Gunslinger (100), Sapper (10
mine kills), Demolition (50 walls), Trick Shot (25 ricochets), Minelayer (50 mines
laid), Hoist by His Own Petard (1 self kill).

Progress: Boots on the Ground (clear a level), Campaigner (clear every level).

Run feats, evaluated at a clear: Flawless (no deaths that run), Dead Eye (every shot
that run was a kill), Bomb Squad (won on mines with no shell kills), Survivor (cleared
with a single life remaining).

## Explicitly later

**Tying customization to achievements.** The design feedback said "eventually". Skins and paint stay
free in this pass. The hook is the store's `earned()` set — a future gate reads it in
the customize pane and refuses locked ids the same way the palette already refuses
off-list ones. Designing that gate (which skins, what criteria, what a locked swatch
looks like) is its own decision and is not made here.

Also later: achievement rarity/percentages, an "N of 14" progress bar beyond a simple
count, per-achievement earned-date stamps.
