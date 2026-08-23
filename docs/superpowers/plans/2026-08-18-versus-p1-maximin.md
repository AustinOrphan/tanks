---
status: completed
date: 2026-08-18
last-reviewed: 2026-08-23
scope: Maximin versus spawn placement for every player, including player one
implementation-issues: []
implementation-prs: [195]
supersedes: []
superseded-by: []
---
# Versus spawns: every player maximin-placed, P1 included

**Status:** implemented. Supersedes the open question left by
`2026-08-17-versus-spawns.md`, which shipped co-player placement only and recorded P1's
placement as undecided.

## The ruling

Versus is symmetric. No player may inherit the campaign author's `P` cell as a
privileged start.

`P` marks where a *campaign* level is meant to be entered from — a property of that
level's design, chosen against its enemy roster and its opening sightlines. Carrying it
into FFA/teams made one player's start a fact about a different mode.

## What changed

`pickVersusSpawnSet` (new, `versus-spawns.ts`) chooses the whole set at once:

1. **Anchor** — an approximate geodesic-diameter endpoint, by the standard double sweep
   (BFS from the earliest candidate to the farthest; BFS again from that). `pickVersusSpawnCell`
   cannot answer this: with an empty `avoid` every candidate scores `Infinity` and its
   tie-breaks hand back the `(row, col)`-earliest open cell, which is a board corner by
   construction and an accident rather than a decision.
2. **Greedy chain** — `pickVersusSpawnCell` once per remaining player. Farthest-point sampling.
3. **Relaxation** — bounded coordinate ascent. Each round re-picks every spawn against
   the other `count − 1` and keeps the new cell only if the whole set's separation
   *strictly* improves. Strictness is the termination argument; `VERSUS_RELAX_ROUNDS = 8`
   is a backstop, and the observed worst case is 4.

`loadArena` **relocates** P1's tank and spawn in PASS 1b rather than creating them there.
That ordering is load-bearing: ids are handed out in PASS 1a, so a versus load numbers its
tanks exactly as a one-player load does and every per-tank RNG stream keyed on `tank.id`
is unmoved. Both records move — `spawns` is what `world.ts` respawns from, so leaving it
on `P` would have put P1 back on the campaign start after its first death while everyone
else respawned symmetrically.

## Two defects the measurement surfaced

Neither was the change being made; both were found by measuring it.

**The geodesic graph treated destructible cells as blocking.** Two spawns separated only
by a wall the level is designed to blow open are not separated. The graph is the *breached*
phase now — the same both-wall-phases discipline `spawnBlockRobust` already applies in
`arena-claims.ts`. Not a cosmetic re-reading: optimising against the intact graph instead
puts arena-02's 4-player spawns 4 breached cell-steps and **2.67 world units** apart, either
side of that level's centre barrier. Against the breached graph the same board gives 25
steps and 13.74 units. The two graphs pick *identical* sets on arena-01, arena-03 and
arena-04 at every count, so the choice bites only where destructibles partition space.

The line-of-sight filter deliberately does **not** follow this rule and stays on intact
geometry: a destructible wall really does block sight at the instant players spawn, and
the opening seconds are what that filter is for. Distance is a question about the whole
round; concealment is a question about spawn time. The consequence is measured and stated
rather than papered over — on 4 of the 15 (arena, count) pairs, exactly one spawn pair
becomes mutually visible once every destructible is gone. **The filter's guarantee is an
at-spawn one, never a match-long one.**

**Geodesic ties fell through to `(row, col)` order.** Distance saturates at `Infinity` for
any cell in a component `avoid` cannot reach, so on a partitioned board every unreachable
cell tied and position decided — picking a cell 2.67 world units from the anchor, straight
through the wall, on arena-02 at 2 players. Euclidean distance is the secondary key;
that case became 27.49. Integer cell-steps tie constantly on connected boards too, so the
key does work everywhere, not only on partitioned ones.

## Measured

All 5 shipped arenas × player counts 2/3/4 — **15 pairs, every (shipped arena, supported
count) there is**, not a sample. Minimum pairwise separation, breached-phase geodesic
(cell steps) and Euclidean (world units):

| | old (P1 on `P`) | greedy chain only | full set |
|---|---|---|---|
| beats old on geodesic | — | 13 of 15 | **15 of 15** |
| beats old on Euclidean | — | — | **15 of 15** |
| regressions | — | **2 of 15** | **0 of 15** |

The chain alone regresses on arena-01 and arena-03 at 3 players (29 breached cell-steps
against 34 and 32), which is why the relaxation pass is load-bearing rather than polish;
it also improves on the chain alone on 8 of 15.

Worst case over the whole sweep, the figure now pinned exactly in `versus-spawns.test.ts`:
Euclidean floor **9.0738… → 11.6619…**, at arena-03 / ffa / N=4. So the ruling moved the
worst case, not just the average.

`BASELINE_HASH` is unmoved at `a5458ede…` — the golden trace drives campaign-coop only,
which does not reach this branch.

Cost: a versus `loadArena` goes to 25–53 ms at N=4 (5–9 ms at N=2), paid once per match
load. The dominant term is the LOS filter, ~2400 `lineOfSight` calls per pick.

## A criterion got weaker, and it should be recorded

`pickVersusSpawnCell`'s LOS filter actively *searches* for concealment, so
`evaluateVersusBoard`'s `allPairsConcealed` fails only when no concealed pair exists
anywhere on the board. While P1 was pinned the filter only had freedom over the other
slots and could be defeated; with every slot free it almost never is.

Re-measured after the change: **0 unsuitable first draws in 1500 shipped-arena draws**
(arena-01 and arena-03, 250 seeds each at removal fractions 0.85 / 0.90 / 0.95 — all well
above the production 0.4), where the old placement had failures at 0.7.

Two consequences:

- `versus-variants.ts`'s retry path is now close to unreachable on shipped boards. The
  machinery stays — the exhaustion fixture at fraction 1.0 still genuinely fails — but
  `versus-variants.test.ts`'s retry test had to move to a **synthetic** fixture, because
  no shipped board plus seed can express its premise any more. That fixture is two
  destructible cells: one mid-room where it genuinely occludes, one jammed in the far
  corner where it occludes nothing. Fraction 0.5 removes exactly one, so the draw decides
  which survives. 23 of the 40 seeds 1..40 give an unsuitable first draw.
- The removal-fraction sweep recorded in `2026-08-17-versus-map-variants.md` is **stale**:
  it was measured under the old placement. `DESTRUCTIBLE_REMOVAL_FRACTION` is unchanged
  at 0.4 and is now more conservative than that sweep implied. Retuning it is a separate
  decision and deliberately not bundled here.

## Assertions that had to be repaired, not re-expected

Three, and all three are the documented "a test's *subject* changed underneath it" failure
mode rather than arithmetic drift.

- `versus-spawns.test.ts`'s `coopPos[0] === ffaPos[0]` pinned P1 sitting on `P` in both
  modes. Its own comment named the exact decision that would invert it. **Inverted, not
  deleted** — it is now the most direct statement of the ruling that exists.
- `versus-respawn.test.ts`'s two N=2 tests each guard with
  `expect(expected).not.toEqual(spawns[0].pos)`, so the fixture can tell "the picker ran"
  from "we fell back to the authored spawn". That guard **started failing**, correctly: at
  N=2 the set is {A, B} with B maximally far from A, so with P2 sitting still at B, the
  safest cell given one opponent at B is A — exactly where P1 spawned. Repaired by driving
  the survivor off its spawn first, which makes the tests strictly better: the pick now
  has to be a function of where the opponent *is*, not where it started.
- `versus-spawns.test.ts` quoted a separation floor of `~9.07` in a test name while
  asserting only `> 5`. The change moved the floor **up**, so the one-sided assertion
  could not notice the prose going stale. The number now sits in an assertion of its own
  that fails in either direction.

## Residuals

- **The 4 of 15 breached-phase visible pairs** above. Closing it would mean running the
  LOS filter on both wall phases, which is a much stricter criterion and unmeasured.
- **`versus-variants.ts`'s retry path is near-dead on shipped boards.** Worth revisiting
  whether the concealment criterion should be strengthened now that placement satisfies it
  so easily, rather than leaving a bounded retry that almost never fires.
- **The removal-fraction sweep is stale** (above).
- **Anchor choice is approximate.** The double sweep is a diameter heuristic on a general
  graph, not an exact one. The relaxation makes the set insensitive to it in practice on
  every shipped board, but that is measured, not proved.
