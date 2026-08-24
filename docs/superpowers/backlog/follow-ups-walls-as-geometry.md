---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Follow-ups from "walls as geometry, not cells"
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Follow-ups from "walls as geometry, not cells"

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
