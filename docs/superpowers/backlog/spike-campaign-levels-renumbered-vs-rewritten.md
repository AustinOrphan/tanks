---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Spike -- the campaign's levels — the approved arc says "renumbered", the owner says "rewritten"
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Spike: the campaign's levels — the approved arc says "renumbered", the owner says "rewritten"

**Resolved 2026-08-22 by issue #298.**
[Public prototype and campaign direction](specs/2026-08-22-project-direction.md) makes the
eleven-level sequence a non-binding opening-teaching reference, allows current arenas to be
revised, reordered, replaced, or reused, and establishes Public Prototype 1.0 as the
public-repository boundary. The old spec and stretch plan remain preserved with explicit
supersession metadata.

**Raised 2026-08-10.** The prompt for this spike was "the campaign's levels need
rewriting, and there is documentation for it somewhere". Both halves check out, and they
disagree with each other. That disagreement is the spike.

**What the documentation says.** It exists, and it is approved:

- **`docs/superpowers/specs/2026-08-02-difficulty-curve-design.md`** — "A taught difficulty
  curve: eleven levels, one idea at a time", marked *Approved 2026-08-02*. It designs an
  **11-level arc** as a table of (new idea, roster, enemy count, board). Seven boards are
  marked **new**; the four shipped arenas take slots 6, 7, 8 and 11. Its governing
  constraint is that there is no tutorial text anywhere in the tree, so **levels teach
  through geometry alone**. It also records a `bankOnly` claim type that was tried and
  **withdrawn as geometrically impossible**, and measured bot win-rates per roster that it
  explicitly refuses to treat as a difficulty ordering.
- **`docs/superpowers/plans/2026-08-02-difficulty-curve-stretch-1.md`** — the
  implementation plan for **stretch 1 only**: prepend two 2-brown boards and renumber the
  existing four. It carries full JSON grids.

**Neither was executed, and the plan has gone stale.** Verified 2026-08-10, arena count
re-verified 2026-08-11 after PR #145: `src/sim/config/data/arenas.json` holds exactly
`arena-01` .. `arena-05` (5 `"id"` keys, no `arena-00a`/`arena-00b` — arena-05 extends the
shipped sequence rather than adopting the spec's renumbered arc, which deepens rather than
resolves this spike's question). `firstMission` is still only validated as a non-negative integer
(`config/validate.ts:131`) and copied through `config/resolve.ts:79` — the spec's
"enforced load-time rule" does not exist and **nothing reads the field**. And the plan's
boards are specified as `"cols": 9, "rows": 7, "cellSize": 2`, which is pre-#75 geometry:
shipped arenas are 33x27 at `cellSize` 0.667. Its grids cannot be pasted in as written.

**The disagreement, stated plainly.** The spec's decision line is "the four existing levels
are **renumbered, not rewritten**", and its Out of scope section forbids "any change to the
four existing boards' geometry". If the campaign's levels now need *rewriting*, the
approved spec is the thing being overruled. **At the time, nobody should author a board until
that was settled**, because the two readings produce different work: renumbering is additive
and the plan (once re-based onto the current cell size) still describes it, while rewriting
invalidates the four arenas' `notes`, their `claims`, the cover-ratio table in
`arena-validation.test.ts`, and the difficulty scores #98 derived for them.

**What the spike originally required (now answered):**

- **An owner decision on one question: are arena-01..04 kept?** Everything else follows.
  This is not a measurement and no amount of reading settles it.
- **If kept:** re-base the stretch-1 plan onto `cellSize` 0.667 and re-derive its two grids
  at 3x, then run it. Its five pin sites are already enumerated in CLAUDE.md.
- **If rewritten:** the spec needs revising *before* the plan, because its arc assigns
  specific lessons to specific existing boards (teal's bank corridor to arena-01,
  breaching to arena-02, rockets to arena-03, green's crossfire to arena-04). Those four
  rows become vacant and the arc has to say what replaces them.
- **Either way, play the first two levels before building levels 3-5.** The spec's own
  residual risk says so, and this file's audio and arena-04 lines say the same thing about
  their own subjects: the tree carries no recorded playtest judgement about any level.

**Constraint that shapes any answer:** the four shipped arenas are load-validated data with
machine-checked `claims`. Rewriting a board is not editing a grid — it is re-deriving every
claim attached to it, and `sightlineAfterBreach` is **all-or-nothing per arena** (declaring
one commits the arena to declaring one for every enemy spawn). Related: issue #119 asks for
arena-05 and a measured per-level cost. That measurement still prices future arena revisions,
but it no longer blocks the high-level direction recorded by #298.

---
