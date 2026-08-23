---
status: active
date: 2026-08-02
last-reviewed: 2026-08-23
scope: Tank-width wall/corridor/killability rules for arena authoring, plus a fire-through barrier wall kind and one-way ledges.
implementation-issues: []
implementation-prs: [75]
supersedes: []
superseded-by: []
---
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

## Change 1: `cellSize` 2 -> 2/3 — walls two-thirds of a tank

**Decided 2026-08-02: walls are 0.667 of a tank's width.** `cellSize` becomes `2/3`
(the JSON carries `0.6666666666666666`; the validator requires only a positive number,
and both the sim and the per-level render refit were demonstrated running this value
unchanged — real screenshots, real renderer).

**The 1.0 option stays in the back pocket.** Both were rendered side by side in the real
game before choosing. What switching later would cost: 2/3 is an ODD upscale of the old
grid (3x), so every existing spawn keeps its exact world position and every seeded
baseline — pacifist rate, determinism fingerprints, cover ratios — is preserved, not
re-measured. Moving to 1.0 later is an even ratio and shifts every spawn by half a cell,
which re-baselines everything seeded. Cheap now, dearer the more levels exist.

### The gap taxonomy

**The corridor minimum is 1.3 tank-widths (1.3 world units).** At `cellSize 2/3` that
lands the taxonomy on a clean boundary — every gap is either a slit or a legal corridor,
with no ambiguous band:

| gap | width | vs 1.3 minimum | meaning |
|---|---|---|---|
| 1 cell | 0.667 | under | **slit** — shells (radius 0.1) and blast rays pass; no tank ever does |
| 2 cells | 1.333 | over by 0.033 | **minimum corridor** |
| 3 cells | 2.0 | comfortable | corridor — today's standard width |

An earlier draft set the minimum at 1.5 and had to OUTLAW the 2-cell band as ambiguous
(a tank physically fits 1.333 but the rule forbade it, splitting "where tanks can be"
from "where tanks may be"). 1.3 dissolves that: the 2-cell gap becomes the minimum legal
corridor and the outlawed band disappears. That is the main reason to prefer 1.3.

**Slits are legal authoring, deliberately.** A sub-tank gap is a firing embrasure: shells
cross it, `blastReaches`'s ray crosses it when the angle lines up, tanks never do. The
traversability check must NOT count them passable — that is the point of them.

**The minimum corridor is genuinely tight, and this is the spec's biggest playtest risk.**
A 1.0-diameter tank in a 1.333 corridor has **0.167 clearance per side**, against 0.5 in
today's 2.0 corridors — three times tighter. Enemy tanks steer reactively with no
pathfinding (`seekMove` is a wander heading plus a distance band), so a tank driving a
minimum-width corridor will scrape it constantly, and `wallBlocksStep`'s one-step probe
is what stands between that and a jam. Nothing in this spec proves that feels acceptable.
Author minimum-width corridors sparingly until it has been played, and prefer 3 cells
where a level does not specifically want a squeeze.

### Traversability is clearance, sampled SUB-CELL

The old flood fill walks cell-to-cell and assumes anything open is passable — false the
moment sub-tank gaps exist. It is replaced for tank purposes by a clearance check:

> A point is **free** iff it is at least 0.65 world units (half the 1.3 minimum) from
> every wall AABB. Tank connectivity is flood-filled over free points on a lattice at
> most `cellSize / 2` fine, and a grid cell is traversable iff it contains a free point
> in the player's component.

**The lattice must be finer than the authoring grid, and that is not a detail.** Testing
cell CENTRES fails: in a 1.333 corridor at `cellSize 2/3` the two cell centres sit 0.333
from the walls, under the 0.65 required, so a centre-sampled check rejects every minimum
corridor — the legal band is the middle strip, which straddles the cell boundary. Measured
before writing this rule, not assumed. A half-cell lattice (0.333) samples the gap's exact
centre, where clearance is 0.667 and the check passes by 0.017.

That 0.017 is the whole margin at minimum width, so the lattice may be refined but never
coarsened, and the comparison needs a tolerance no larger than 1e-6 — far below the margin,
far above float noise on `2/3`.

A 2.0 corridor passes comfortably; a 0.667 slit never does. This also closes the hole
flagged earlier: at fine resolutions the old check would validate a board that is
physically impassable.

### Sealed sections are LEGAL — the rule is killability, not connectivity

Decided with the user: fully walled-off regions are acceptable, including large
inaccessible stretches of map (legal, though not the norm). The sealed-pocket rule as a
universal law is REPLACED by:

> **Every enemy must be killable.** For each enemy spawn, at least one must hold:
> (a) it sits in the player's traversable component;
> (b) some player-traversable cell has a direct line or a ricochet path to it, within
>     the PLAYER's bounce budget (`ricochetCount: 1`);
> (c) a mine laid at some player-traversable cell reaches it — `blastReaches` ray
>     within `MINE_BLAST_RADIUS` (2.0);
> (d) destroying destructible walls makes (a), (b) or (c) true.

An enemy in a sealed nest that can only be killed by a bank shot through a slit is not a
defect — it is a level design, and it composes directly with the green sniper: a turret
nest the player must out-angle rather than out-drive. An EMPTY sealed region needs no
check at all. The player's spawn must sit in the traversable component that contains at
least one route to satisfying every enemy's condition — trivially true when (a) holds
for all, checked explicitly otherwise.

The old sealed-pocket failure message survives as a WARNING-grade note in the validator
output for empty sealed regions (they are legal but "not the norm"), so an accidental
pocket is still visible without being fatal.

### Existing boards are upscaled 3x, not redesigned

Each old cell becomes a 3x3 block of new cells covering the identical world span; the
centre sub-cell inherits a spawn letter, the rest floor. Interior wall surfaces land in
exactly the same world position and every spawn keeps its exact coordinates — which is
what makes this migration provable as a no-op: the transform test asserts tile-for-tile
wall coverage identity AND byte-identical seeded baselines. Thinning any specific wall
to 1 cell (0.667) afterwards is a per-level design edit, made deliberately, level by
level.

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
| mine blast | **passes**, and is not destroyed | `blastReaches` (mines.ts) must skip it, exactly as it skips destructibles when the pass-through rule is on |
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

- **The 3x upscale is proven by transform, not by eye**: upscale each shipped arena,
  assert tile-for-tile wall coverage identity, assert every spawn's world position is
  BYTE-identical, and assert a seeded trace hash is unchanged. At an odd upscale all
  three should hold exactly; any drift is a bug in the transform, not a number to re-pin.
- **Clearance-rule negative controls**: a 2.0 corridor passes; a 1.333 corridor passes
  (the minimum — and it FAILS under a cell-centre-sampled check, so this fixture is also
  the regression test for the sampling bug); a route through a 0.667 slit fails with the
  slit named. Each control removed from the validator must un-fail its fixture.
- **Killability negative controls, one per clause**: an enemy killable only by bank shot
  through a slit passes (b); only by mine ray passes (c); only after a breach passes (d);
  a genuinely unkillable enemy fails with all four clauses reported false. A guard is
  worth what its own tests prove, and this rule is four independent clauses.
- **Barrier negative controls, one per system**: a shell crosses a barrier and hits, a
  tank is stopped by one, `lineOfSight` returns true across one, `bankShot` declines to
  bounce off one, and `blastReaches` passes one. Each must fail if its filter is removed.
- **Slit semantics**: a shell (radius 0.1) passes a 0.667 slit; a tank does not; a blast
  ray through a slit kills a tank aligned behind it and spares one off-axis.

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
