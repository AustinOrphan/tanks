# Backlog

Spikes and deferred work. Each entry says what the question is and what would answer it —
not a plan, just enough that the next person does not re-derive the context.

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
