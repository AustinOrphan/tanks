---
status: proposed
date: 2026-09-17
scope: A three-tier rule set for generating versus maps -- generative rules, the shipped acceptance filter, and a new measured quality tier calibrated on shipped boards.
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Map generation rules: what makes a board good, and how we would know

Whole-board procedural generation is the one piece of versus mode that was never built.
`docs/superpowers/backlog/spike-versus-mode-rest.md` item 6 has carried it as "not
scheduled" since the map-variants PR landed the middle step -- a seeded subset of an
authored board's destructible cells -- and the directive it sits under is explicit that
authored-with-randomised-subsets comes first and fully generated boards come later.

This document is that "later", taken one step at a time. It does not ship a generator. It
answers the question a generator cannot be written without: **what rule would you tune it
against?**

## The finding that shapes everything else

The repository already has a checkable definition of a versus board that is not broken.
`src/sim/versus-board.ts` measures spawn distinctness, mutual concealment, open floor per
player, and tank-legal egress; `src/sim/versus-spawns.ts` adds clearance;
`src/sim/versus-catalog-rules.ts` sweeps the catalog against both. That machinery is good,
and it was deliberately written against board geometry rather than authored spawn points so
that it would work on a board with no author.

It is also, by its own account, not a fitness function. From that module's doc comment:

> MEASURED, NOT DISCRIMINATING ON SHIPPED DATA: every one of the 5 shipped arenas clears
> this at every N in {2, 3, 4} by more than an order of magnitude [...] 0 of 15 (arena, N)
> combinations fail it.

To make that concrete rather than argumentative, this work built the least designed
generator anyone could still call a rule set -- scatter 2x2 blocks at random, impose
180-degree rotational symmetry, keep the floor connected, reject nothing else -- and ran it
through the shipped acceptance rules.

**It is accepted 10 boards out of 10, at 2, 3 and 4 players.** Here is one of them:

<!-- MEDIA: scatter-seed1.png -->

Nobody would ship that board. Every rule the repository owns says it is fine. That gap is
what this document exists to close, and it is why the proposal has three tiers rather than
one.

## Three tiers, and they must not be collapsed

| Tier | Question | Where it lives | Output |
| --- | --- | --- | --- |
| **Generative** | How is the board built? | the ruleset itself | a grid |
| **Acceptance** | Is it broken? | `src/sim/versus-board.ts`, `versus-spawns.ts` -- shipped, unchanged | pass / fail |
| **Quality** | Which of two working boards is better? | `tools/mapgen/measure.ts` -- new, gates nothing | numbers |

Acceptance stays a filter and is never used as a score. A generator tuned to maximise pass
rate converges on "not broken", which the null ruleset already is. What the sweep does
report per ruleset is the **accept rate and the criterion that refused each board**, because
a ruleset that lands one board in forty is a different proposition from one that lands nine
in ten even when their survivors measure alike.

## The quality tier

`tools/mapgen/measure.ts` computes, for one board at one player count:

**Texture** (cell space): wall and destructible fraction, merged cover pieces, mean
nearest-neighbour cover spacing.

**Mobility** (tank space): the fraction of the board where a tank centre legally fits, and
the share of that which is corridor-or-pocket (2 or fewer of 8 directions clear for 1.5 tank
diameters) against open ground (6 or more).

**Fairness and flow** (tank space, per spawn pair): shortest path and its spread across
pairs; **bottleneck width**; route-disjoint route count; and pairs that are reachable only by
mining through a destructible.

**Sightlines and carom** (shell space, sampled): the mean fraction of sample points in direct
view, and **bank gain** -- of the pairs with no direct shot and within shell reach, the
fraction a single bounce can still hit.

**Symmetry** (cell space): the fraction of cells that disagree with their image under
180-degree rotation, horizontal mirror and vertical mirror.

Two of these deserve their own note.

### Bottleneck width, in the gap taxonomy's own language

Rebuild the tank-legal lattice for a *widening body* and ask, each time, whether every spawn
still reaches every other. The widest body that gets through is the narrowest passage on the
journey. It is exact to the ladder step, it involves no path choice and no cap, and it reads
straight off `2026-08-02-arena-geometry-design.md`'s taxonomy: 1.000 is a tank's own width, a
scrape; 1.333 is the minimum legal corridor at 2 cells; 2.000 is a comfortable 3-cell lane.

### Bank gain, which is this game and not a genre

A normal shell bounces once. Geometry that turns "I cannot see you" into "I can still hit
you" is the thing that makes a Tanks! board a Tanks! board, and no general arena-design rule
covers it. Bank gain is measured by firing a 720-ray fan from every sample point through the
sim's own `reflectSweep` with `NORMAL_BOUNCES`, so a carom counted here is one the game
really offers. Rays are traced to `NORMAL_SPEED * AI_SHOT_LOOKAHEAD` = 9 world units, which
is the horizon the sim's own shot-safety check already reasons over.

## Calibration: what the shipped boards measure

The measures are numbers without a scale. The eight shipped boards are the only ground truth
available, so their spread is the band a generated board is read against.

<!-- CALIBRATION TABLE -->

**What this cannot establish, stated plainly:** eight authored maps are not a sample drawn
from a population of good maps. A band derived from them describes them. A board outside the
band is unlike everything shipped, which is a reason to look at it, not a reason to reject
it.

## Constraints a generator has to satisfy, measured rather than assumed

**A generated board still needs exactly one authored `P`.** Versus placement is geometric --
`pickVersusSpawnCell` derives spawns from the grid, which is why the machinery works on a
board with no author -- but `loadArena` still *seeds* that derivation from the authored `P`
cell. A 33x27 board with no spawn letter at all loads with zero players at 2, 3 and 4, and
`evaluateVersusBoard` then reports `suitable: false` over 0 pairs. So P1's cell is the one
authored spawn decision on a generated board and every other start is a consequence of it.

**Rotational symmetry is what the dedicated boards actually use.** vs-duel-01 and
vs-quad-01 both measure 0.00 rotational asymmetry. No shipped board is mirror-symmetric.

**Three players do not fit a rectangle.** vs-tri-01 measures 0.33 rotational asymmetry --
a third of its cells disagree with their 180-degree image -- because three-fold symmetry and
a rectangular board cannot both be had. This is the concrete form of a question the versus
rulings already raised, and any ruleset has to answer it rather than assume 2 and 4.

**Egress failure is usually not about connectivity.** vs-duel-01 at 3 and 4 players has all
spawns mutually reachable (`spawnsInLargestRegion` 3/3 and 4/4) and still fails `egressOk`,
because one spawn is sealed by destructibles in a pocket 2.24 across against a 2.5 mine kill
radius: leaving the start line costs a life. A generator that reasons only about
connectivity will produce boards that fail for this reason and not understand why.

## Candidate rulesets

<!-- RULESETS -->

## Residuals and what is not settled

<!-- RESIDUALS -->
