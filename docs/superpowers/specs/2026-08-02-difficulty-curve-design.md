# A taught difficulty curve: eleven levels, one idea at a time

Approved 2026-08-02. The game currently opens with three tank types at once — brown, grey
and teal — two of them ahead of their own authored `firstMission`. A player who has never
fired a shot meets a tank that banks ricochets at them. This spec replaces that opening
with a ramp, and makes the teaching order a property the build enforces.

Decisions taken with the user: the four existing levels are **renumbered, not rewritten**;
the **full arc is designed now** and built in stretches; `firstMission` becomes an
**enforced load-time rule**; and the opening is **two levels, not three**.

## The governing constraint

There is no tutorial, hint, or instruction text anywhere in the codebase — verified by
searching `src/` for `tutorial|hint|instruction`, which returns nothing. **Levels teach
through geometry alone.** A level therefore teaches its idea only if the geometry makes
that idea *necessary*, or at minimum strongly rewarded. A level where the new mechanic is
merely *possible* teaches nothing, because the player will solve it the old way and never
notice.

This is why the new claim type below exists: "this level requires a bank shot" should be a
checked property, not a hope.

## The arc

| # | new idea | roster | n | board |
|---|---|---|---|---|
| 1 | fire and hit; walls block both ways | 2 brown | 2 | **new** — open room with simple solid cover |
| 2 | shells bounce | 2 brown | 2 | **new** — one brown reachable only by a ricochet |
| 3 | it moves ← **grey** | 1 grey, 1 brown | 2 | **new** — corridors; grey dodges and gives ground |
| 4 | mines, both ways | 1 grey, 2 brown | 3 | **new** — mines matter once something follows you |
| 5 | walls you can break | 2 grey, 1 brown | 3 | **new** — small barrier board |
| 6 | it banks at you ← **teal** | existing **arena-01** | 3 | brown, grey, teal — its bank corridor is this lesson |
| 7 | breaching as the level | existing **arena-02** | 4 | 2 brown, grey, teal — the full destructible barrier |
| 8 | rockets ← **olive** | existing **arena-03** | 5 | 2 olive, 2 brown, grey — shields, flank lanes |
| 9 | rockets under pressure | 2 olive, 2 teal, 1 grey | 5 | **new** — olive commands lanes, teal flushes |
| 10 | space changes the fight | 2 teal, 2 grey, olive, brown | 6 | **new** — first large board |
| 11 | cover stops working ← **green** | existing **arena-04** | 6 | green, grey, brown, 2 teal, olive |

The `n` column is the enemy count, and it is deliberately monotonic: 2, 2, 2, 3, 3, 3, 4,
5, 5, 6, 6. Levels 9 and 10 were slots without rosters in the first draft, which put a dip
at 2 and 3 immediately after level 8's 5 — a difficulty regression two thirds of the way
through the game. Counts are not the whole of difficulty, but a drop of three enemies is
not something the geometry can quietly make up for.

Seven new boards — levels 1-5, 9 and 10 — five of them small. The existing four move
slots untouched.

Mines are taught at 4 rather than earlier because the player's mine is a trap for something
that chases, and browns never chase. Level 4 is also where enemy mines first appear, so the
two halves of the mechanic land together.

## `firstMission` becomes a rule

`firstMission` is authored per tank in `data/tank-defs.json` and **nothing reads it today**.
It is retuned to the arc and enforced at load by `validateArenas`:

| tank | firstMission |
|---|---|
| brown | 1 |
| grey | 3 |
| teal | 6 |
| olive | 8 |
| green | 11 |

Two checks, both in `config/validate.ts`, both O(cells):

1. **Floor.** A level at 1-based index `n` may not contain a tank whose `firstMission > n`.
   A bad edit is a boot failure naming the arena, the cell and the tank.
2. **The debut is real.** For each tank whose `firstMission <= ARENAS.length`, the level at
   that index must actually contain it. Without this the number is fiction — a tank could
   carry `firstMission: 3` and first appear at 9, and the floor rule would be satisfied.

The second check is what makes the table above a complete statement of the teaching order
rather than a set of loose bounds. It is the same discipline `sightlineAfterBreach`'s
all-or-nothing rule already applies to spawn lines.

`firstMission` is a **floor, not a schedule**: a tank may appear in any level at or after
its debut. Only the debut itself is pinned.

The player's own entry (`firstMission: 0`) is exempt from both checks — it is in every level.

## The one new claim type

**`bankOnly`** — the named enemy has no direct line of sight from *any* open cell on the
board, so the only shot is a ricochet.

```json
{ "type": "bankOnly", "enemy": [9, 3],
  "why": "Level 2's whole lesson. If any cell could see this brown directly, the level would
          teach nothing: the player would shoot it the old way and never learn to bank." }
```

Verified by the runner in `arena-claims.ts`: sweep every open cell, assert `lineOfSight`
to the enemy is false from all of them, and additionally assert `bankShot` from at least
one of them is non-null — otherwise the level is not merely bank-only but unwinnable.
The failure message names how many cells could see it, and draws the board.

`enemy` is validated as an enemy-spawn cell at load (`enemySpawnCell()`, the same helper
`sightlineAfterBreach` uses), so a claim pointing at floor is a boot failure.

Deliberately not added: a claim for "this level requires cover" or "this level requires
mines". Neither has a crisp geometric statement, and a claim that cannot be checked
precisely is worse than none — it advertises coverage that does not exist.

## Decoupling the test arena from level 1

`ARENAS[0]` currently means two different things: *the first level the player sees* and
*the standard test arena*. Eighteen files reference `ARENA_01`, `ARENAS[0]` or
`createArenaWorld`. Most use the name and are unaffected by renumbering; the positional
uses are the problem.

The AI's headline metric matters most: `ai/pacifist.test.ts` runs 60 seeded games on
`createArenaWorld`, which is `createWorldFor(ARENAS[0])`. If level 1 becomes two stationary
browns, that metric measures nothing — browns barely move and rarely friendly-fire, which
is the entire phenomenon it exists to detect.

**`createArenaWorld` is repointed at `arenaById('arena-01')`.** Same board, now level 6, so
every seeded measurement stays byte-identical and the metric keeps its historical
continuity. Its doc comment already says it means "level 1" for dozens of tests; that
comment is corrected to say it means *that specific board*, which is what those tests
actually depend on.

`ARENAS[0]` keeps its meaning for anything genuinely about *the first level* —
`levels.ts`'s `start`, the level-select. Each of the eighteen files is classified as one or
the other during implementation; the split is the substance of that task, not a detail.

## Testing

- **Validator negative controls**, one per new check, against corrupted copies of the
  shipped file: a tank before its floor, and a `firstMission` naming a level that does not
  contain the tank. The repo's existing validators all carry these.
- **The `bankOnly` runner needs a meta-test**: a fixture declaring `bankOnly` on an enemy
  that IS directly visible must fail, and one on an enemy no shot can reach at all must
  also fail. A guard is worth what its own tests prove.
- **`EXPECTED_CLAIMS`** in `arena-validation.test.ts` gains a row per new arena.
- **Population pins move**: `cell-mapping.test.ts`'s cell and spawn totals, and the
  cover-ratio `EXPECTED` table, both of which are per-arena and grow with the sequence.
- **Renumbering fidelity**: the pacifist suite's free-win rate and the determinism suite
  must be unchanged after the decoupling. That is the check that the renumber cost nothing
  — asserted by running them before and after and comparing the numbers, not by assuming.
- **A playability probe per new level**, matching the one used for arena-04: 40 seeded
  pacifist games reporting free wins, player deaths, timeouts and median time-to-kill. A
  teaching level that a wandering player clears without firing is not teaching.

## Out of scope

New tank kinds; the `OFFENSIVE`/`BERSERKER` behaviour work; any change to the four existing
boards' geometry; level-select or progression UI changes beyond the count growing; in-game
tutorial text. Levels 9 and 10 are specified only as slots — their boards are designed when
that stretch is built, against this arc.

## Residual risk

**Nobody has playtested any of this game.** The curve's pacing is designed against measured
geometry and headless simulation, and the claim that level 1 is "incredibly basic" or that
level 4 teaches mines is a design judgement no test can make. The first stretch should be
played before the later stretches are built, or the whole arc is guesswork compounding.
