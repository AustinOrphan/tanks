# Arena geometry: tank-width walls and fire-through barriers

Approved 2026-08-02. Two changes to what an arena is made of, both driven by the same
observation: **every wall in the game is exactly twice as wide as a tank.**

| | size |
|---|---|
| tank diameter | 1.0 |
| wall thickness | 2.0 (one grid cell) |
| one-cell gap | 2.0 — two tank-widths of clearance |

The wall *is* the grid cell, and the grid cell was sized so tanks could drive through it.
That is why boards read as blocky rooms rather than mazes.

**This spec blocks the difficulty curve.** `docs/superpowers/plans/2026-08-02-difficulty-curve-stretch-1.md`
is superseded: it authors two 9x7 boards at `cellSize: 2`, which would be re-authored
immediately after this lands. New levels are authored once, at the final resolution.

## Change 1: `cellSize` 2 -> 1

A wall becomes 1.0 — exactly tank width. Arenas are authored at twice the resolution in
each axis, so today's 11x9 boards become 22x18 covering the identical play area.

**A corridor still needs 2 cells.** At `cellSize 1` a one-cell gap is 1.0 against a
1.0-diameter tank: zero clearance, which collision resolution will jam on. The authoring
rule is walls at 1 cell, passages at 2 or more. That is the whole point — wall thickness
and passage width stop being the same number.

### The migration is mechanical, but it is NOT a no-op

Each old cell becomes a 2x2 block of new cells covering the same world span, so interior
wall surfaces land in exactly the same place. Two things still move, both measured:

1. **Spawns shift by (0.5, 0.5).** An old cell `c` at `cellSize 2` spans `[2c, 2c+2]` with
   centre `2c+1`. The new cells `2c` and `2c+1` at `cellSize 1` have centres `2c+0.5` and
   `2c+1.5` — the old centre is the *boundary* between them. No even upscale can preserve a
   cell centre. (An odd one can: 3x at `cellSize 0.667` puts a centre exactly on `2c+1`, but
   yields walls two-thirds of a tank wide, which is thinner than asked for. Rejected.)
2. **The boundary ring halves in thickness**, since it is one `cellSize` thick. Only its
   inner face is reachable by tanks or shells, so this is invisible in play — but it does
   mean a naive volume comparison of old and new wall sets reports a difference, which is
   expected and not a defect.

**Consequence: every seeded baseline is re-measured, not preserved.** The pacifist suite's
free-win rate, the determinism fingerprints, and each arena's cover ratio all move because
tanks start half a unit away from where they used to. This is the real cost of the change
and must be reported as a before/after table, not quietly re-pinned. The pacifist metric is
a threshold (<= 5% free wins), so a re-baseline is legitimate; a *silent* re-pin is not.

### Existing boards are upscaled, not redesigned

All four ship as 2x upscales of their current grids, preserving their designs exactly.
Thinning individual walls to 1 cell is a per-level design decision made afterwards, level by
level, not a bulk transform. Separating the two is what keeps the resolution change
reviewable: one commit that changes no geometry but the spawn offset, then deliberate
design edits on top.

The upscale must not duplicate spawn letters — one tank per spawn. A spawn cell maps to its
top-left sub-cell, with the other three as floor.

## Change 2: a fire-through barrier

A third `WallKind` alongside `solid` and `destructible`:

**`barrier` — blocks tanks, passes shells, cannot be destroyed.**

Rendered as **a line of holes in the ground**, as in the Wii game — not a rail. The visual
matters more than it looks: a hole plainly lets a shell fly over it, whereas a rail invites
"why did my shell not hit that?" Spikes or razor wire read the same way and are
interchangeable art for identical mechanics.

You can always shoot across it and never drive across it, which makes "I can hit it but I
cannot reach it" a real situation the game currently cannot express. It is also the most
legible thing to teach early: a wall that stops you but not your shell says something a
solid block cannot.

Walls are already a catalog family (`walls.ts`, `createCatalog`), so the definition is
additive. The semantics live in four places, and getting each right is the substance:

| system | barrier behaviour | where |
|---|---|---|
| tank collision | **blocks** | `collision.ts`, unchanged — it already uses every wall |
| shell collision | **passes** | `bullets.ts` must exclude it |
| line of sight | **passes** | `ai/targeting.ts:50` filters `!w.destroyed` with no kind test |
| bank shots | **not a reflector** | `bankShot` must not bounce off it |
| mine blast | **passes**, and is not destroyed | it is indestructible by definition |
| render | drawn low | `render/` — a rail, visibly not a wall |

`lineOfSight` passing through a barrier is load-bearing and has a consequence worth stating:
the universal no-spawn-sightline rule and every `sightlineAfterBreach` claim will see
*through* barriers. That is correct — an enemy really can shoot you through one — but it
means a barrier is never cover for a spawn, and any board using one near a spawn must be
re-checked. `arena-claims.ts` needs no change: it calls the same `lineOfSight`, so it
inherits the right answer for free.

**`bankShot` must not treat a barrier as a reflector.** Missing this is the subtle failure:
shells would visually pass through while the AI computed ricochets off a surface that
does not reflect, producing shots that miss for no visible reason.

## Testing

- **The upscale is proven by transform, not by eye**: a test that upscales each shipped
  arena and asserts interior wall coverage is identical tile-for-tile, and that the only
  spawn difference is the uniform (0.5, 0.5) offset. That test is what makes "the migration
  changed no geometry" a checked claim.
- **Before/after baseline table** for the pacifist free-win rate, per-arena cover ratios and
  a seeded trace hash, reported in the PR. Numbers move; the point is that they move
  *predictably* and are re-pinned deliberately.
- **Barrier negative controls, one per system**: a fixture where a shell crosses a barrier
  and hits, a tank is stopped by one, `lineOfSight` returns true across one, and `bankShot`
  declines to bounce off one. Each must fail if its filter is removed — a guard is worth
  what its own tests prove, and this feature is four independent filters.
- **A corridor-width guard**: at `cellSize 1` a one-cell passage is impassable. A test
  asserting every shipped arena's open regions remain reachable already exists
  (`structuralFailures`); it must be checked that flood-fill connectivity is *not* enough
  here, since it walks cells without regard to tank width. If it is not enough, that gap is
  reported rather than papered over.

## Considered and deferred: the one-way ledge

A drop a tank can cross downhill but not back. Deferred, not rejected — it is a good idea
that needs one design decision this spec should not make in passing, because of what was
measured while considering it:

**The AI has no pathfinding.** `grep -rlniE "pathfind|navmesh|a-?star|bfs|dijkstra" src/sim`
returns nothing; `seekMove` is reactive steering — wander plus a distance band relative to
the player. An enemy that chases the player over a one-way ledge can never come back. That
fails in both directions: the enemy strands itself out of the fight and the level goes
trivial, or it strands itself somewhere it can still shoot the player but cannot be reached
and the level goes unwinnable. No test catches this; it is emergent from reactive steering
meeting irreversible geometry.

**The sim is strictly 2D** — there is no elevation in world state. High and low would be a
render fiction plus a traversal rule, which is workable, but in a top-down view the
DIRECTION of a drop has to be unmistakable or the rule reads as a wall that is broken.

**The resolution, if it is built:** make ledges impassable to ENEMIES entirely — they treat
one as solid — and one-way for the player. The stranding problem disappears, no AI change is
needed, and the feature becomes sharper than a gate: a player-only escape hatch. Drop down
to break contact and the pursuit has to go the long way round. Directional collision is
still a change to `moveTank`, which is among the most delicate code in the repo (see the
escape-bug and retroreflecting-seam notes in CLAUDE.md), so it wants its own spec and its
own review rather than riding along with the resolution change.

## Out of scope

Re-designing any existing board's layout beyond the mechanical upscale; the difficulty
curve's new levels (they follow this); destructible barriers; barriers that block sightlines
(a "window" was considered and rejected — players expect a shot to land where they can see).

## Residual risk

The corridor-width point above is the one I am least sure of: `structuralFailures` checks
cell connectivity, not whether a tank of diameter 1.0 can actually traverse it. At
`cellSize 2` every passage was 2.0 and the question never arose. At `cellSize 1` it is
possible to author a board that validates clean and is physically impassable. If the
existing guard does not catch it, this spec has created a new class of silent defect and a
width-aware reachability check is required before any new level is authored.
