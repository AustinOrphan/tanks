# Backlog

Spikes and deferred work. Each entry says what the question is and what would answer it —
not a plan, just enough that the next person does not re-derive the context.

---

## Spike: pathfinding and risk-aversion weights in the movement AI

**Raised 2026-08-02**, while specifying the arena resolution change.

**The question:** should enemy movement gain (a) real pathfinding, and (b) per-profile
risk-aversion weights that make some tanks avoid exposure rather than only avoid bullets?

**Why it is live now.** Three separate findings in one session all point at the same gap:

1. **There is no pathfinding at all.** `grep -rlniE "pathfind|navmesh|a-?star|bfs|dijkstra"
   src/sim` returns nothing. `seekMove` is a wander heading plus a distance band relative to
   the player — purely reactive steering.
2. **The corridor minimum makes that worse.** At the 1.3-tank minimum a tank has 0.167
   clearance per side, three times tighter than today's 2.0 corridors. Reactive steering
   through a maze of minimum-width corridors will scrape and may jam; `wallBlocksStep`'s
   one-step probe is the only thing standing between those.
3. **One-way ledges need it, or need designing around it.** An enemy that chases the player
   over an irreversible drop cannot deliberately come back. The geometry spec's answer is a
   strong-connectivity rule so a ledge is always a shortcut, never a trap — that works, but
   it is a constraint on every future level rather than a capability in the AI.

**Risk aversion is the separate half.** Profiles already carry `aggression`,
`retreatChance`, `preferredDistance` and `minimumDistance`, and `dangerAvoidMove` dodges
bullets and flees armed mines — but nothing weighs *positional* risk. A tank has no notion
that a long open sightline is dangerous, or that a green sniper's bank lanes cover the
ground it is about to cross. That is what would make a "defensive" tank read as defensive
rather than as "a tank that backs up sometimes".

**What would answer it:**

- Measure how often reactive steering actually jams in minimum-width corridors. Build one
  maze board at `cellSize 2/3` with 1.333 corridors, run the seeded pacifist harness, and
  count ticks where an enemy's `desiredMove` is non-zero but its position does not change.
  If that number is small, pathfinding is a polish item; if it is large, it is a blocker on
  maze-like levels and should land before the difficulty curve's later stretches.
- Prototype the cheapest thing that could work: a flow field over the traversable lattice
  the clearance rule already computes (`spec: arena geometry`), regenerated when
  destructibles change. The lattice exists for validation anyway, so the marginal cost may
  be small. Compare against the pacifist metric — the AI's headline number — before and
  after.
- For risk aversion, the smallest real experiment is a single new profile field weighting
  "cells visible to a live enemy" against path length, scored on the same lattice. It
  composes with the existing `seekMove` rather than replacing it.

**Constraint that shapes any answer:** `src/sim/` is pure and deterministic. Any pathfinding
must be a pure function of world state — no caching that survives across `step()` calls
unless it lives in `World` and is cloned correctly, or replays stop being exact functions
of their inputs.

**Not scheduled.** Recorded so it is not rediscovered a fourth time.

---

## Follow-ups from "walls as geometry, not cells"

**Raised 2026-08-02**, by the final review of the arena-resolution branch. All four were
consciously deferred, not missed. None blocks that branch.

**1. Wall normal maps tile at the wrong density — on BOTH families, and the larger effect
is on the unmerged one.** `concreteNormal` (`repeat=(2,2)`) and `timberNormal`
(`repeat=(1,1)`) are single shared textures, and `BoxGeometry`'s per-face UVs are
size-independent, so neither is scaled to the mesh.

- **Destructible (not merged), the bigger change:** cells went 2.000 -> 0.667 units, so
  timber grain went from 2 grooves per unit to 6, a 3x density INCREASE, with a UV restart
  every 0.667 units. Re-measured in review as **visible at 1x**, not only under
  magnification — countable hatching in an unscaled 1280x800 capture of level 2's barrier.
- **Merged solids:** density falls by the merge factor instead; worst anisotropy per arena
  went 2.0:1 before to 6.0:1 / 8.0:1 / 4.0:1 / 6.0:1 (arena-01/02/03/04) after.
- The boundary ring is unaffected — marginally better, 26:1 -> 23:1.

An earlier version of this entry described only the merged half and called it "not visible
at gameplay zoom"; that was measured on the merged pillar alone and does not hold for the
destructible cells. The fix is larger than scaling the repeat: the texture is shared across
every wall, so it needs a clone per wall (or per distinct extent).

**2. arena-02's boundary-flush run can be escaped past the ring.** Its rows 12-14 put three
destructible cells against each side boundary, so the escape march's horizontal exit beats
the vertical one and some interior starts resolve outside the ring. Re-measured with the
population stated (an earlier draft of this entry and the comment in `collision.test.ts`
carried the same numerator against two different denominators, 20,000 and 160,000):
**154 of 159,201** hull centres on a 0.05 grid across the playable rect [0,22]x[0,18].
**Not reachable at the depths the sim produces**: the shallowest such start is **0.720
units** from the nearest legal hull centre, against the 0.375-unit shove `world.ts:99`
documents, and mine blasts only shrink
the region (0 of 633,600 at >=50% destruction). A 57,600-tick probe (4 arenas x 12 seeds x
1200) saw 0 tanks outside, 0 inside a wall, 0 shells escaped — but that samples end-of-tick
only and does not bound mid-`stepMovement` depth across the three
`separateTanks`/`resolveWalls` alternations. What would close it: sample inside that loop.

**3. `loop.test.ts` asserts "an AI fired within N frames".** That window moves whenever AI
RNG timing moves, and it moved twice on this branch (widened 12 -> 30 frames when tank ids
were renumbered). It should assert a specific deterministic event instead of a time bound.

**4. Wall mesh and material count rose 1.6x-4.1x.** arena-02 went 20 -> 81 wall entities, and
`render/entities.ts:568` allocates a `BoxGeometry` AND a material per wall. Destructible
cells are 3x subdivided and never merge, which is deliberate — but nothing has measured the
render cost, and the growth is entirely in the destructible family.

---

## Spike: intensity granularity, and a destination set by the level

**Raised 2026-08-03**, from the item PR #76 (`60bdcfa`) left explicitly open: "the
granularity of the signal itself -- arena-01 has 3 enemies, so intensity still moves in
half-scale jumps as they die; the glide softens the transit, not the destination."

**The question:** should the musical intensity a level reaches — where it starts, where it
ends, and how finely it moves in between — be a function of that level's difficulty,
instead of the same 0..1 kill fraction in every level?

`musicIntensity` (`game/loop.ts:189`) is `destroyed / (total - 1)`, where `total` is
`enemiesAtRoundStart`. Two consequences, both structural rather than a tuning miss:

- **The granularity IS the enemy count.** The step is `1 / (total - 1)`, so a level's
  musical resolution is decided by how many tanks its grid happens to spawn.
- **The destination is 1.0 everywhere.** The last kill of level 1 asks for exactly the
  arrangement the last kill of level 4 asks for. Nothing in the signal knows which level
  it is — though `level` (`loop.ts:319`) is in scope at the call site (`loop.ts:421`) and
  simply is not read.

**Measured at `60bdcfa`.** Population: the 4 shipped arenas × the 24 distinct members
named by an `arena`-context suite in `music-suites.json` — 96 (arena, member) pairs. Each
pair replays the arena's reachable intensity values through the gate rule `layer sounds
iff layer.intensity <= intensity`, and compares the resulting layer sets:

| arena | enemies | reachable intensities | members reaching fewer tiers than authored | members whose first kill changes no layer | members whose last kill changes a layer |
|---|---|---|---|---|---|
| arena-01 | 3 | 0, .5, 1 | 12 of 24 | 0 of 24 | 18 of 24 |
| arena-02 | 4 | 0, .333, .667, 1 | 12 of 24 | 24 of 24 | 18 of 24 |
| arena-03 | 5 | 0, .25, .5, .75, 1 | 6 of 24 | 24 of 24 | 6 of 24 |
| arena-04 | 6 | 0, .2, .4, .6, .8, 1 | 12 of 24 | 24 of 24 | 0 of 24 |

Totals: 42 of 96 pairs reach fewer distinct arrangements than the member authored distinct
gate values — no kill count lands in the missing band. 72 of 96 open with a kill that
moves no layer at all. Every arena tops out at exactly 1.0.

**The last two columns run backwards.** On arena-04 — six enemies, the level with the green
ricochet sniper — the arrangement is already full at 0.8, so the kill that ends the hardest
level is musically silent in 24 of 24 members. On arena-01, three enemies and the first
level anyone plays, the fullest arrangement arrives exactly on the last kill in 18 of 24
(population: the same 24 members). The easiest level gets
the payoff the hardest one does not.

**What would answer it:**

- **Cheapest experiment for the destination half:** an affine remap, `lo(level) +
  (hi(level) - lo(level)) * kills`, with `lo`/`hi` per level. Level 1 need never reach the
  top of the arrangement; level 4 could open above the floor. That is a change to one
  expression plus a data lookup, and the table above is already the metric — recount
  unreachable tiers and check the per-level ordering comes out monotone rather than
  inverted.
- **For the granularity half**, the signal needs a term that is not a kill count. Candidates
  in reach of `loop.ts` without new plumbing: lives remaining, shells in flight, distance
  to the nearest live enemy, elapsed round ticks. A continuous term also removes the
  dependence on `total`, which is what makes resolution an accident of the grid.
- **Then listen.** #76 ends "Nobody has listened to any of this." Still true. Any curve
  chosen here is a guess until someone plays a round with it; the numbers above bound what
  is *possible* to hear, not what sounds right.

**Constraints that shape any answer:**

- **Stays out of `src/sim/`.** Intensity is computed in `game/loop.ts` and pushed into the
  audio engine; the sim never sees it, and a difficulty term must not migrate inward or
  replays stop being exact functions of their inputs.
- **The #76 glide is a rate limiter, not a shaper.** It walks the sounding density toward
  the target over `INTENSITY_GLIDE_SECONDS` (2.0). Changing the destination changes what
  the walk arrives at; it does not change the walk.
- **Respawn is part of this.** `enemiesAtRoundStart` is recomputed in `switchTo`
  (`loop.ts:484`) — per LEVEL, not per round — so losing a life still takes the target from
  1.0 to 0.0. A per-level floor shortens that fall, which is half the appeal.
- **`total <= 1` returns 1.** A one-enemy round sits at the full arrangement start to
  finish. Not reachable in a shipped level (the minimum is 3) but reachable today via
  `?dev=1&level=sandbox&tanks=brown`.
- **If the difficulty term becomes data**, `arenas.json` is the validated home for it and
  `validateArenas` the place a bad edit should fail — not a new parallel table.

**Not scheduled.** Recorded so #76's deferral does not have to be rediscovered from a
commit message.
