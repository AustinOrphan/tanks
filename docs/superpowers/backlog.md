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

**1. Merged walls tile their normal map at the wrong density.** `concreteNormal` is ONE
shared texture with a fixed `repeat=(2,2)` (`render/entities.ts:592`), and `BoxGeometry`'s
per-face UVs are size-independent, so a 6-unit merged run tiles it exactly as a 2-unit box
did — density falls by the merge factor. Confirmed by eye at 8x magnification on arena-02's
4x-merged crossing pillar (faint vertical streaking present only after the change, absent
from an unmerged control at matched scale); **not visible at gameplay zoom in any of the
four before/after level pairs**. The fix is larger than scaling the repeat: the texture is
shared across every wall, so it needs a clone per wall (or per distinct extent).

**2. arena-02's boundary-flush run can be escaped past the ring.** Its rows 12-14 put three
destructible cells against each side boundary, so the escape march's horizontal exit beats
the vertical one and 544 of 160,000 interior-start points (0.02 grid) resolve outside the
ring. **Not reachable at the depths the sim produces**: the shallowest such start is 0.677
units deep against the 0.375-unit shove `world.ts:99` documents, and mine blasts only shrink
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
