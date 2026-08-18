# Plan — Versus board rules: a checkable suitability definition

Status: adopted 2026-08-17, implemented on branch `versus-board-rules`.

Provenance: a directive that multiplayer maps need their own rules, distinct from
campaign maps, including rules about spawn points. Builds on
`docs/superpowers/plans/2026-08-17-versus-spawns.md` (`pickVersusSpawnCell`, PR #188)
and `docs/superpowers/plans/2026-08-17-versus-stock.md` (respawn wired to the same
function, PR #191). Answers the map-suitability half of item 6 in
`docs/superpowers/backlog.md`'s "Spike: the rest of versus mode -- setup UI and maps":
a future map-selection menu needs a checkable definition of which maps to offer at a
given player count. **No menu is built here** -- see "Stays deferred" below.

---

## Why a new rule set, not an extension of `ArenaClaim`

Campaign boards encode CAMPAIGN intent: `config/validate.ts` hard-locks every arena to
exactly one `P`, and `arena-claims.ts`'s three claim types (`sightlineAfterBreach`,
`lane`, `spawnBlockRobust`) are all statements about a single player facing arranged
enemies. Versus wants close to the opposite -- several mutually-hidden starts and
rough symmetry -- so reusing `ArenaClaim` would be stretching a single-player vocabulary
over a multi-player question it was never shaped for. Nothing is added to
`arenas.json` either: the validator rejects unknown keys, and a new field would move
the replay data fingerprint (the STAMP CLAUDE.md describes) for a change that has
nothing to do with reproducing a replay -- exactly the same reasoning the versus-spawns
PR already gave for not authoring per-mode spawn points.

Instead, `src/sim/versus-board.ts` derives suitability from the arena's own geometry --
the same posture `pickVersusSpawnCell` already takes, and for the same reason: it
works on generated boards later, which have no author to carry a claim.

## Import graph, checked before writing any code

The brief asked specifically whether this module could import `src/sim/config/`
without closing a cycle. It does not need to: none of the three criteria below need a
resolved tank config, an AI profile or campaign identity, only grid characters and the
wall/position output `loadArena` already produces. `versus-board.ts` imports exactly
`arena.ts` (for `Arena`, `loadArena`, `ARENA_DEFS`) and `ai/targeting.ts` (for
`lineOfSight`) -- the identical pair `arena-claims.ts` already imports together, so
this is not a new shape of dependency. Grepping the tree for `versus-board` at the
point this module was written turns up only its own file and its own test -- nothing
under `src/sim/` imports it, so there is no edge back into it for either import to
close into a cycle with.

## The three criteria

All three run the REAL wired machinery, not a re-derivation of it:
`evaluateVersusBoard(arena, playerCount)` calls `loadArena(arena, playerCount, 'ffa')`
-- the exact `pickVersusSpawnCell` sequence `loadArena`'s own versus branch runs at
real game start, against the exact wall geometry (PASS 2a/2b plus the boundary ring)
real gameplay collides and sights against. `'ffa'` rather than `'teams'` is a
deliberate no-op choice: both modes share the identical PASS 1b placement branch and
differ only in whether `tank.team` gets stamped, which this module never reads, so
`'teams'` would produce byte-identical positions and walls at strictly more code to
justify.

1. **Separation** (`distinctSpawns`): the `playerCount` real placements land on
   `playerCount` distinct cells. `spawnCount` is the measured distinct count.
2. **Mutual concealment** (`allPairsConcealed`): of the `C(playerCount, 2)` spawn
   pairs, how many lack mutual line of sight (`concealedPairs`). **The bar is ALL
   pairs, not a fraction** -- chosen from measured shipped data, not taste: every one
   of the 15 (arena, N) combinations below already achieves 0 of its pairs visible
   (`pickVersusSpawnCell`'s own hard LOS filter, described in the versus-spawns plan,
   succeeds on every shipped board), so requiring 100% costs nothing on shipped data
   and gives the strongest guarantee available for free. A fractional threshold would
   not currently reject anything either, since the measured figure is already 0 on
   every combination -- so there was no data-driven reason to pick a weaker bar. The
   directive's own words ("several mutually-hidden starts") also read as "every start
   hidden from every other," not "most."
3. **Room** (`roomOk`): open-floor cells per player (`openFloorCells /
   playerCount`) clears `MIN_OPEN_FLOOR_PER_PLAYER`.

## Deriving `MIN_OPEN_FLOOR_PER_PLAYER`

**18** -- a tenth of the tightest figure measured across every shipped (arena, N)
combination (arena-02 at N=4: 742 open-floor cells / 4 players = 185.50), floored:
185.50 / 10 = 18.55 -> 18. The same "comfortably below the measured floor, so a future
board has headroom before this needs retuning" shape the versus-spawns PR's own
>5-world-unit separation bound already used.

**Not discriminating on shipped data, stated plainly rather than left implied**: every
shipped arena clears this bound by more than an order of magnitude at every N in
{2,3,4} -- 0 of 15 (arena, N) combinations fail it. Shipped arenas are 33x27 or 45x33,
authored for one campaign player plus arranged enemies, never designed to be tight for
2-4 versus starts, so no threshold derived from their own numbers can currently reject
one of them. The bound exists for boards this module has not seen yet -- a future
generated or hand-authored small arena -- and the synthetic fixture below proves it
CAN reject a board.

## The measured table

`versus-board.test.ts`'s shipped-arena sweep re-derives every cell of this table live
against real `loadArena` output (not a snapshot). Denominator: 5 shipped arenas x 3
player counts = 15 (arena, N) verdicts, 10 spawn pairs per arena (`1 + 3 + 6`), 50
pairs total.

| arena | N | spawnCount | distinct | concealedPairs/total | openFloorCells | openFloorPerPlayer | roomOk | suitable |
|---|---|---|---|---|---|---|---|---|
| arena-01 | 2 | 2/2 | yes | 1/1 | 770 | 385.00 | yes | yes |
| arena-01 | 3 | 3/3 | yes | 3/3 | 770 | 256.67 | yes | yes |
| arena-01 | 4 | 4/4 | yes | 6/6 | 770 | 192.50 | yes | yes |
| arena-02 | 2 | 2/2 | yes | 1/1 | 742 | 371.00 | yes | yes |
| arena-02 | 3 | 3/3 | yes | 3/3 | 742 | 247.33 | yes | yes |
| arena-02 | 4 | 4/4 | yes | 6/6 | 742 | 185.50 | yes | yes |
| arena-03 | 2 | 2/2 | yes | 1/1 | 786 | 393.00 | yes | yes |
| arena-03 | 3 | 3/3 | yes | 3/3 | 786 | 262.00 | yes | yes |
| arena-03 | 4 | 4/4 | yes | 6/6 | 786 | 196.50 | yes | yes |
| arena-04 | 2 | 2/2 | yes | 1/1 | 1352 | 676.00 | yes | yes |
| arena-04 | 3 | 3/3 | yes | 3/3 | 1352 | 450.67 | yes | yes |
| arena-04 | 4 | 4/4 | yes | 6/6 | 1352 | 338.00 | yes | yes |
| arena-05 | 2 | 2/2 | yes | 1/1 | 1351 | 675.50 | yes | yes |
| arena-05 | 3 | 3/3 | yes | 3/3 | 1351 | 450.33 | yes | yes |
| arena-05 | 4 | 4/4 | yes | 6/6 | 1351 | 337.75 | yes | yes |

**15 of 15 shipped (arena, N) combinations are suitable.** Stated plainly: NONE of the
three criteria currently rejects a shipped board, on any of the 15 combinations. This
is the honest finding, not a gap to paper over -- the shipped catalog was never
authored to be tight for 2-4 players, so a rule set built from the ground truth of that
catalog alone would have nothing to check itself against. The three synthetic
fixtures below exist specifically to prove each criterion CAN fail, and that
concealment and room are actually wired into `suitable` rather than decorative.

## Synthetic negative controls

Each fixture is a hand-built `Arena` (not validated through `config/validate.ts` --
the same "plain object literal matching the `Arena` shape" idiom `arena.test.ts`'s own
fixtures already use), chosen and measured against real `loadArena` output (a scratch
probe, not hand-derivation) to isolate one criterion: two of the three pass cleanly
while the third fails.

- **Separation** (`Pxxxx`, a single spawn-letter cell and nothing else): zero `.`
  candidates anywhere, so `pickVersusSpawnCell`'s own zero-candidate fallback
  co-locates every co-player at P1's own cell. Measured: `spawnCount` = 1 at every N in
  {2,3,4}. Room ALSO fails on this fixture (0 open-floor cells) -- see the subsumption
  note below for why that is not a coincidence of this one fixture.
- **Concealment** (a 10x10 open room, no interior walls): nothing to hide behind, so
  every spawn pair keeps mutual line of sight regardless of separation. Measured: 99
  open-floor cells (comfortably clears the room bound at every N), 4 distinct cells at
  N=4, but 0 of `totalPairs` concealed at every N in {2,3,4}.
- **Room** (a 7x7 room with a 3x3 grid of single-cell pillars): every pillar breaks a
  straight line without sealing off any region, so separation and concealment hold at
  every N, but total open floor (39 cells) is small enough that the per-player ratio
  crosses the bound: 19.5 at N=2 (passes), 13 at N=3 (fails), 9.75 at N=4 (fails).

## Separation is analytically subsumed by room -- disclosed, not manifested as killed

Given `MIN_OPEN_FLOOR_PER_PLAYER >= 1`, `roomOk` (`openFloorCells / playerCount >=
MIN_OPEN_FLOOR_PER_PLAYER`) already implies `openFloorCells >= playerCount`. Every
open-floor cell `evaluateVersusBoard` ever picks a co-player onto is drawn from that
same `openFloorCells` count (P1 itself is not one, since its cell carries the `P`
letter, not `.`), so whenever `roomOk` holds there are strictly more open-floor
candidates than the `playerCount - 1` co-player picks will ever need to stay distinct
from one another. The converse direction is the one the separation fixture above
demonstrates: `distinctSpawns` false implies `openFloorCells < playerCount - 1`
(roughly), which sits nowhere near a bound 18x the player count -- so `roomOk` is also
false on every fixture these two formulas can construct. This was verified empirically,
not only argued: dropping `distinctSpawns` from the `suitable` conjunction by hand and
re-running `versus-board.test.ts` leaves **all 12 of 12 cases green** -- no fixture in
the file, shipped or synthetic, can tell the difference. It is therefore recorded here
as an EQUIVALENT mutation, not added to `tools/mutate/manifest.json` as `killed`
(asserting it as caught would be exactly the tautology-that-cannot-fail CLAUDE.md's
testing conventions warn about). This is a fact about these two SPECIFIC formulas
(both keyed off the same open-floor cell count), not a general law -- a future room
metric not based on raw floor-cell count could decouple them again, which is part of
why `distinctSpawns`/`spawnCount` stay independently reported in `VersusBoardVerdict`
rather than folded away, and why the manifest still mutation-tests `spawnCount`'s own
computation directly (see below).

## Mutation testing: three killed, one equivalent-and-disclosed

Each entry below was proven by hand first -- the mutation applied, the scoped test
file re-run and watched fail, the file restored and byte-compared -- then re-verified
through the real harness (`npm run mutate -- --only <id>`), then the full manifest was
run.

- `versus-board-drops-concealment-requirement` (drops `allPairsConcealed` from the
  `suitable` conjunction): **killed, 1 of 12** in `versus-board.test.ts` -- the 10x10
  open-room fixture, built specifically to isolate concealment, fails immediately at
  N=2 once the mutation makes an all-visible board read as suitable. The 15-shipped-
  arena sweep does not catch this: `allPairsConcealed` is already true on every shipped
  combination, so the mutation changes nothing there.
- `versus-board-drops-room-requirement` (drops `roomOk`): **killed, 2 of 12** -- the
  7x7 pillar-room fixture (N=3/N=4 measuring room-fail) and the `versusBoardCatalog`
  test built against the same fixture at N=4.
- `versus-board-distinct-count-ignores-duplicates` (`spawnCount = positions.length`
  instead of a `Set`'s size): **killed, 1 of 12** -- the zero-open-floor fixture's
  direct field assertion (`spawnCount` expected 1, the co-located fallback cell, at
  every N) fails once duplicates stop being collapsed. Deliberately mutates the FIELD's
  own computation rather than its participation in `suitable`, since the latter is the
  equivalent mutation described above.
- Dropping `distinctSpawns` from the `suitable` conjunction: **equivalent** (see
  previous section) -- not in the manifest.

## Hash obligation

`BASELINE_HASH` (`a5458ede003c173ccc099b708f4b7d43b7537ca8a7846a87274b6376ccc311a9`) is
unmoved. Nothing in the shipped path calls `versus-board.ts` -- `loadArena` does not
consult its result, and no other production module imports it -- so the golden trace,
which only ever exercises `loadArena`/`step` through the single-player campaign path,
cannot reach code that did not exist before this PR. See the Gate section for the real,
pasted `npm test` output confirming this rather than assuming it.

## Report, don't gatekeep

Nothing in `loadArena` or anywhere else in the shipped path consults
`evaluateVersusBoard`'s result. A board `suitable: false` still loads and plays exactly
as it does today. `versusBoardCatalog()` (default: `ARENA_DEFS` x `{2,3,4}`) is the
function a future map-selection menu would call; wiring that menu is out of scope here.

## Gate

See below for the real, pasted output of `npm test`, `npm run build`, `npm run mutate`
and `npx vitest run tools/baseline/trace.test.ts`.

## Stays deferred, named

A map-selection menu that consults `versusBoardCatalog()` to decide which boards to
offer at a given player count; procedural generation itself (this module's whole
point is that it works on a generated board without change, but none exists yet to
run it against); and every other item `docs/superpowers/backlog.md`'s versus spike
still lists open (spawn animation, a versus setup menu, the rest of map selection).
