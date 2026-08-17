# Plan — Versus spawn separation

Status: adopted 2026-08-17, implemented on branch `versus-spawns`.

Provenance: a scoped follow-up to `docs/superpowers/plans/2026-08-17-versus-modes.md` (PR
4 of the n-player arc, merged as #186). That PR's own text names the mechanism this one
replaces: "Player placement uses the same P1-plus-ring-search machinery every other PR in
this arc reaches" — correct for co-op, where partners are meant to start together, and
wrong for FFA/teams, where it puts every player in one small ring around the single
campaign-authored `P` cell.

---

## The defect

`findCoPlayerSpawnCell` (`src/sim/arena.ts`) is a bounded ring search radiating from P1's
own cell: 8 compass directions, radii `ring * cellsNeeded` for `ring 1..4`, co-locating at
P1's cell as a total fallback. `loadArena` called it for every player beyond the first,
in every mode, because versus modes reused co-op's placement machinery unmodified (the
2026-08-17-versus-modes plan's own words). Measured directly against the pre-fix code, on
the full sweep this PR's evidence covers (5 shipped arenas x 2 versus modes x 3 player
counts = 30 `loadArena` calls): the minimum pairwise spawn distance was **exactly 1.3333
world units on all 30 of 30 scenarios** — `cellsNeeded * cellSize` = 2 cells x 0.6667,
i.e. every co-player landed on the ring search's first successful compass direction,
point-blank from P1.

## Why not authored spawn points

Rejected before implementation, for three reasons stated in the task brief and confirmed
against the tree:

- Authored per-mode spawn letters would need a `config/validate.ts` change (currently
  hard-locked to exactly one `P` per arena) and would move the replay data fingerprint —
  `docs/superpowers/plans/...` and CLAUDE.md's own "the STAMP" section both treat the
  four sim data files' fingerprint as something a versus-only change should not touch.
- It would not generalize to the procedurally generated maps this repo intends to add
  later (CLAUDE.md's "Unbuilt by design" backlog section already names procedural
  generation as future work) — a board with no author has no authored spawn points to
  place.
- A DERIVED ranking, by contrast, works on any board handed to it and is the same
  function a later respawn increment can reuse, which an authored-point scheme is not.

## Design

`src/sim/versus-spawns.ts`, a new pure module. `pickVersusSpawnCell(grid, cols, rows,
cellSize, legend, avoid)` picks ONE well-separated cell, scored in priority order:

1. **Hard filter, where achievable**: no line of sight to any position in `avoid`. If at
   least one open-floor candidate has no LOS to anything already placed, every candidate
   that DOES have LOS is discarded outright. If no candidate qualifies (a cramped or
   heavily-walled board), the filter is skipped and every candidate stays in play —
   a hard filter that can reject every candidate is not usable, so the deliberate
   degradation is to fall through to plain maximin.
2. **Greedy maximin on GEODESIC distance** among the survivors: BFS through open floor,
   4-connected, respecting walls (a destructible wall blocks like a solid one at spawn
   time, since none is broken yet). Not Euclidean, on purpose — two cells either side of
   a wall are far apart in play, and two Euclidean-distant cells down one open lane are
   not safe from each other. This is an APPROXIMATION of the true "farthest cell from
   everything already placed" problem (p-dispersion), not its optimum; measured against a
   brute-force optimum on one small fixture (`versus-spawns.test.ts`), greedy achieves a
   minimum pairwise geodesic distance of 4 against a true optimum of 6 at one anchor cell
   on that fixture (gaps of 1, 1 and 2 were measured across 3 different anchors on the
   same fixture — not exhaustive over all possible anchors, which is named as the
   unswept remainder).
3. Ties broken deterministically on `(row, col)` ascending.

Candidate cells are exactly the open-floor cells `findCoPlayerSpawnCell` already uses
(`grid[row][col] === '.'`) — the same notion of "fits", not a second one. The BFS
walkability test is broader: a former enemy spawn letter is real floor once the game is
running (the letter is a data marker only), so the reachability graph walks through it
even though it is not itself a candidate.

`avoid` is `Vec2[]` (world-space positions), not grid cells — the one piece of forward
generality the brief asked for: "reusable for respawn, via a parameter, not speculative
generality." Initial placement passes the already-chosen spawn positions; a later
increment can pass live opponent positions instead, without a signature change. Wiring an
actual respawn call site, stock/lives, spawn protection or spawn animation is explicitly
out of scope here — see the spike this PR adds to `docs/superpowers/backlog.md`.

**Import graph, checked before writing any code.** The brief flagged a specific cycle
risk: does `versus-spawns.ts` importing `lineOfSight` from `ai/targeting.ts` close a loop
back to `arena.ts` (the one caller)? A forward BFS over every `import` reachable from
`ai/targeting.ts` — 20 files, deliberately treating `import type` the same as a value
import (a strictly larger reachable set than the real one) — never reaches `arena.ts`.
`arena.ts` is imported by exactly one file under `src/sim/`: `sandbox.ts`, a dev tool
outside this chain. No cycle exists, so `lineOfSight` is reused directly rather than
reimplemented — the "second implementation" fallback the brief specified for a blocked
cycle was not needed for this one.

A DIFFERENT cycle risk was real: `arena.ts` imports `versus-spawns.ts`, so the reverse
import (this module reaching back into `arena.ts`'s private `mergeSolidRuns`, or into
`arena-claims.ts`'s `cellCentre`, which itself imports `arena.ts`) would close a two-node
cycle. `versus-spawns.ts` duplicates `mergeSolidRuns`'s algorithm and the `cellCentre`
formula instead (both already duplicated at least once elsewhere in the tree — the
`cellCentre` formula's own recurrence is named in `arena-claims.ts`'s doc comment). The
brief's "prove the two don't silently diverge" obligation for a blocked-cycle
reimplementation is honoured for `mergeSolidRuns` specifically, since it produces real
collision-relevant geometry: `versus-spawns.test.ts` checks its solid-wall rectangles
against `loadArena`'s own PASS 2a output on all 5 shipped arenas.

## campaign-coop: unchanged execution, restructured source

`loadArena`'s PASS 1b takes a guard-first split on `mode`, the same shape `resolveStatus`
(`world.ts`) already uses for its four-way mode dispatch: `ffa`/`teams` branch off first,
`campaign-coop` falls through to the original ring-search loop. That original loop is
extracted into its own function, `placeCampaignCoPlayers`, rather than left inline in the
`else` branch — not a stylistic choice. Once the `if` above narrows `mode`'s type to the
single remaining literal `'campaign-coop'`, TypeScript's own control-flow analysis turns
the original loop's `if (mode === 'teams') tank.team = teamOf(i);` line into a compile
error (`TS2367`, "no overlap"), even though nothing about its BEHAVIOUR changed — it is
simply unreachable now that `teams` routes elsewhere. A function boundary resets that
narrowing (a fresh parameter is not narrowed by the caller's control flow), which is the
same reason `resolveStatusFfa`/`resolveStatusTeams`/`resolveStatusCoop` are three
separate functions rather than one shared body with a conditional inside it. The loop's
BODY is unchanged from before this PR — only its wrapper moved.

Evidence this is truly unchanged, not merely argued:

- `BASELINE_HASH` (`a5458ede003c173ccc099b708f4b7d43b7537ca8a7846a87274b6376ccc311a9`) —
  unmoved; see the Gate section below for the real command output. The trace drives one
  player and cannot see PASS 1b at all, so this proves the single-player path is
  untouched, not that co-op placement is.
- `arena.test.ts`'s pre-existing pins DO cover multi-player campaign-coop placement
  directly and exactly: exact ring-1-S/ring-1-W positions for P3/P4 on all 5 shipped
  arenas, N=3-matches-N=4's-first-three-slots, and the id-ordering/wall-shift pins. All
  of these still pass unmodified against the extracted function.
- `versus-spawns.test.ts` adds one more angle: campaign-coop's output for a given arena
  and player count is asserted to DIFFER from ffa's for the same arena/count on every
  co-player slot (proving the guard actually routes, not that both branches happen to
  agree).

## Evidence: before and after

Measured with `loadArena(arena, n, mode)` directly, 5 shipped arenas x {ffa, teams} x
{2, 3, 4} players = 30 scenarios, 100 total player pairs (`C(2,2)+C(3,2)+C(4,2) = 1+3+6`
per arena per mode).

| | minimum pairwise Euclidean distance | player pairs with mutual LOS |
|---|---|---|
| BEFORE (ring search) | exactly 1.3333 on 30 of 30 scenarios | not separately measured before this PR (LOS was never checked by the ring search) |
| AFTER (this PR) | ranges 9.0676 - 23.7393 across the 30 scenarios | 0 of 100 |

The full per-scenario AFTER table (arena x mode x N -> minimum distance) is reproduced in
this PR's own evidence; the two extremes are arena-03/ffa/N=4 (9.0676, the tightest) and
arena-04 or arena-05 at N=2 (23.7393, the loosest, since only 2 players leaves the most
room). `versus-spawns.test.ts`'s real-arena describe block re-derives the LOS figure and
a >5-world-unit floor (chosen to sit comfortably above the pre-fix constant of 1.3333 and
comfortably below the measured floor of ~9.07, so a future arena redesign has headroom
before this needs retuning) as live, re-running assertions rather than a frozen snapshot.

## Negative control

A 1x5 open corridor (no cover at all) with 4 players: every cell sees every other cell,
so mutual LOS genuinely cannot be avoided for every pair — the hard filter's own
documented degradation (fall through to plain maximin) is exercised here. The chosen
decision, stated because CLAUDE.md's testing conventions ask for a decision rather than
an implicit default: still return 4 DISTINCT cells (a corridor of exactly 5 cells has just
enough room), never double-book, and stay fully deterministic — the same total, no-throw
posture `findCoPlayerSpawnCell`'s own exhausted-ring fallback already takes, on the
reasoning that `separateTanks` (world.ts) already runs every tick and already handles
worse overlaps than a single-lane crowd. A second, more pathological fixture (every cell
either the P1 letter or solid) exercises the true zero-candidate fallback: co-locate at
`avoid[0]`'s own cell. Not reachable on any shipped arena — every shipped arena ships far
more open floor than 4 players need — so this is a pure robustness guard, named as such.

## Gate

See this PR's own evidence block for the real, pasted output of `npm test`, `npm run
build`, `npm run mutate` and `npx vitest run tools/baseline/trace.test.ts`.

## Stays deferred, named

Versus stock/lives (a Smash-style life counter per player, distinct from campaign-coop's
shared pool), respawn cell selection (wiring `pickVersusSpawnCell` to a live respawn call
site with `avoid` = current opponent positions), spawn protection/invincibility windows,
spawn animation, a versus setup menu (mode/player-count/map selection UI beyond dev
flags), and map selection or procedural generation itself. Recorded as a spike in
`docs/superpowers/backlog.md` rather than a ledger line: each of these needs a product
decision (a stock model, an invincibility duration, menu UX) before a PR could implement
it, which is CLAUDE.md's own test for "spike, not issue."
