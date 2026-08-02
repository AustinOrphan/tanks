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
| render | a line of holes in the ground | `render/` — visibly not a wall, and visibly not a shell-stopper |

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

## The one-way ledge

A drop that any tank can cross downhill and none can cross back — **side-dependent, not
entity-dependent**. Enemies use it exactly as the player does; what decides the outcome is
which side you are standing on.

The obvious objection, measured: **the AI has no pathfinding.**
`grep -rlniE "pathfind|navmesh|a-?star|bfs|dijkstra" src/sim` returns nothing, and
`seekMove` is reactive steering — wander plus a distance band relative to the player. An
enemy that chases the player over an irreversible drop cannot deliberately find its way
back.

**That is a level-design constraint, not a blocker, and it has a checkable form.** The risk
only exists where a ledge is the ONLY route into an area. If every region below a ledge has
another way out — the long way round — then no tank of any kind is ever permanently
stranded; it wanders out eventually, and the ledge reads as a shortcut rather than a
trapdoor. So:

> **Every arena's traversal graph must be strongly connected**: from every cell, every
> other cell is reachable, respecting one-way edges.

This is a real upgrade to `structuralFailures`, not a restatement. `reachable()` today is an
undirected 4-neighbour flood fill (`arena-claims.ts`), which assumes every edge works both
ways — precisely the assumption a ledge breaks. It becomes a directed check: a flood fill
FROM the player's cell proves everything is reachable, and a second fill on the reversed
graph proves everything can get back. Both must cover the same set. An arena with a
one-way pocket fails at load with the pocket drawn on the board, exactly as a sealed pocket
does today.

That rule also makes the feature safe for the AI without teaching the AI anything, which is
the right trade: reactive steering stays reactive, and the geometry guarantees it cannot
paint itself into a corner.

**Still needs its own spec and review before building.** Directional collision is a change
to `moveTank`, among the most delicate code in the repo — see the escape-bug and
retroreflecting-seam notes in CLAUDE.md — and the sim is strictly 2D, so "higher" and
"lower" are a render fiction plus a traversal rule. In a top-down view the direction of a
drop has to be unmistakable, or the rule reads as a wall that is broken. Sequenced after the
resolution change and the barrier, both of which it composes with cleanly.

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
