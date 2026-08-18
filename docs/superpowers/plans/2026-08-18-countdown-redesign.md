# Plan — round-start countdown redesign: bare number, centred and transient

Status: adopted 2026-08-18, implemented on branch `countdown-redesign`.

Provenance: a design ruling, decided before this branch started. This document
records the ruling and the reasoning behind the two decisions that were not
mechanical translation of it -- why centring the number is safe now when it was
explicitly ruled unsafe for the thing it replaces, and what is deliberately left
unhandled in the grace phase -- plus what the ruling made dead and removed.

## The ruling

1. The countdown never says a word. No "AIM", no "TAKE AIM" -- a bare number only.
2. It is huge, centred, and one value per second (3, 2, 1). Each new value pops in
   and fades out on roughly a one-second cadence: `scale(0.4)`/opacity 0 at 0%,
   `scale(1)`/opacity 1 by 15% and held to 70%, `scale(1.6)`/opacity 0 at 100%.
   Transient by construction -- it does not sit on screen.
3. The topbar phase chip (`.hud-phase`) is deleted outright. Its slot is reserved
   for a future match clock (timed/challenge mode); this change does not add that
   clock, and does not leave a repurposed-but-unused element behind.
4. `RoundPhaseInfo.prominent` and the "teaching banner shows once per page load"
   machinery it drove are dead once every round shows the same countdown, and are
   removed rather than left inert.

## Why centring is safe now, when it was explicitly ruled unsafe before

The banner this replaces (`.hud-banner`, `hud.css`'s old comment block) was
deliberately anchored to the dead space **above** the board, not centred, and the
comment recorded exact measurements for why: centred, it would sit across the
middle of the arena -- over a wall, over a tank -- for the *entire* countdown,
during the one phase whose whole purpose is looking at the board and aiming. That
was a real constraint on a real design: the banner was static chrome for the
full 3 seconds it announced.

The new number is not static chrome. It is transient by the ruling's own
keyframes: full opacity only briefly (15%-70% of each one-second cycle), and
fading toward invisible for the rest. At any moment past the first ~150ms of a
given second, the element is on its way out, not sitting at rest over the board.
That is the entire difference that makes centring correct here where it was
wrong for the banner -- the old objection was about dwell time over the board,
not about position as such, and this design has no dwell time by construction.

`pointer-events: none` carries forward unchanged, and stays exactly as
untestable as it was on the banner, for the same three reasons the old comment
gave (recorded again in `hud.css`, so a future edit does not have to rediscover
them): jsdom applies no stylesheet, so a computed-style check would pass against
an empty cascade; `?raw` returns an empty string under vitest without
`test.css: true` (which this repo does have set, and which `hud.css.test.ts`
itself guards by checking the load succeeded at all); and a real file read would
need `@types/node`, which this project does not carry. If that line is ever
removed, nothing will fail -- it is load-bearing on trust, not on a test.

## Restart mechanics

`setRoundPhase` is called every simulated tick while a round is not `'live'`
(`loop.ts`'s `refreshRoundPhase`, called from `onSimulated`), so most calls repeat
the same `secondsLeft`. The HUD tracks the last value it displayed
(`lastCountShown`) and only restarts the pop animation when the value actually
changes -- restarting on every call would replay the animation dozens of times a
second and never let it finish; never restarting would leave the second and
third numbers static once the class was already applied. The restart itself
follows `signalPlayerDeath`'s existing pattern exactly: remove the class, force
a reflow (`void countEl.offsetWidth`), re-add it -- the same trick this file
already uses for "two events in quick succession must read as two, not one."
`lastCountShown` resets to `null` whenever the countdown hides (`null` info, or
`'live'`), so the next time it shows -- even mid-count, e.g. resuming from pause
at the same second the game was paused on -- reads as a fresh number and pops
again, rather than silently reusing whatever the animation was doing when it was
last visible.

## The grace-phase gap (known, deliberate, not shipped around)

`GRACE_TICKS` is 0, so the `'grace'` phase never actually occurs in play --
`phaseAt` in `src/sim/round.ts` cannot return it at the shipped constant. The
machinery is kept and tested at a positive grace span precisely so turning the
constant back on later does not land on untested code (see `round.ts`'s own
comments on `phaseAt`/`ticksLeftAt`).

`setRoundPhase` stays phase-agnostic on purpose: any phase other than `'live'`
shows the number, unconditionally, with no per-phase styling. That means if
`GRACE_TICKS` is ever switched back on, the player will see a second,
indistinguishable 3-2-1 immediately after the countdown's own -- nothing in this
design tells the two apart. That is a known gap, accepted rather than solved
here: inventing a second look for a phase nothing can currently reach would be
speculative CSS for code no test exercises, exactly the kind of unpinned
addition this codebase's conventions warn against. Whoever turns `GRACE_TICKS`
back on owns giving grace its own cue at that point, with real behaviour to test
against.

## What became dead and was removed

`RoundPhaseInfo.prominent` and the `roundsSeen`/`lastRoundStartTick` tracking in
`loop.ts` that computed it (incremented on a `roundStartTick` change, reset in
`switchTo` so a same-tick fresh world at a new level still counted as a new
round) existed to answer "is this the first round of the page load?" for the
banner-vs-chip choice. A countdown that shows on every round has no such
choice to make, so the field, its computation, and the reset are gone, along
with `loop.test.ts`'s tests that pinned the once-per-page-load behaviour
("makes the FIRST round of the page load prominent", "drops to the quiet chip
on the next round", "counts the next level's opening round, so the teaching
banner does not re-show") and `hud.test.ts`'s prominent-vs-chip tests. The
`.hud-phase` topbar chip markup, its CSS rules, and `hud.ts`'s element query for
it are deleted along with it -- not hidden, not repurposed in place, so the slot
is genuinely free for the match-clock work this ruling explicitly defers.

## Proof obligations

Two `tools/mutate/manifest.json` entries were added against `src/game/hud.ts`:
`hud-count-drop-restart` (deletes the remove+reflow half of the restart trick,
leaving the animation unable to replay past the first second) and
`hud-count-live-shows` (drops the `info.phase === 'live'` arm of the hide guard,
so the number would keep showing into live play). Each new `hud.test.ts`
assertion was checked against its mutation directly, by hand, before the
manifest entries were written: the exact `find`/`replace` text was applied to
`hud.ts`, `npx vitest run src/game/hud.test.ts` was run and showed exactly one
failure -- the new test, for the stated reason -- and the file was reverted and
confirmed byte-identical via `git diff --quiet`. `npm run mutate --only <id>`
then independently reproduced the same result through the harness itself for
both entries: `killed`, 1 of 149 failures each.
