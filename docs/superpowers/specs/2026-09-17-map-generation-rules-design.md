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

| board | N | ok | wall | dstr | legal | corr | open | neck | rout | pMin | sprd | pts | sight | bank | rot |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arena-01 | 2 | y | 0.13 | 0.02 | 0.66 | 0.04 | 0.32 | 4.00 | 2.00 | 36.0 | 0.00 | 86 | 0.35 | 0.22 | 0.04 |
| arena-01 | 3 | y | 0.13 | 0.02 | 0.66 | 0.04 | 0.32 | 4.00 | 2.00 | 24.0 | 0.00 | 86 | 0.35 | 0.22 | 0.04 |
| arena-01 | 4 | y | 0.13 | 0.02 | 0.66 | 0.04 | 0.32 | 4.00 | 1.83 | 17.3 | 0.90 | 86 | 0.35 | 0.22 | 0.04 |
| arena-02 | 2 | y | 0.16 | 0.08 | 0.65 | 0.01 | 0.40 | 4.00 | 2.00 | 36.0 | 0.00 | 83 | 0.34 | 0.09 | 0.06 |
| arena-02 | 3 | y | 0.16 | 0.08 | 0.65 | 0.01 | 0.40 | 4.00 | 2.33 | 22.6 | 0.14 | 83 | 0.34 | 0.09 | 0.06 |
| arena-02 | 4 | y | 0.16 | 0.08 | 0.65 | 0.01 | 0.40 | 4.00 | 2.17 | 16.2 | 0.96 | 83 | 0.34 | 0.09 | 0.06 |
| arena-03 | 2 | y | 0.11 | 0.03 | 0.68 | 0.03 | 0.34 | 4.00 | 2.00 | 36.0 | 0.00 | 88 | 0.36 | 0.17 | 0.16 |
| arena-03 | 3 | y | 0.11 | 0.03 | 0.68 | 0.03 | 0.34 | 4.00 | 2.33 | 24.0 | 0.00 | 88 | 0.36 | 0.17 | 0.16 |
| arena-03 | 4 | y | 0.11 | 0.03 | 0.68 | 0.03 | 0.34 | 4.00 | 2.00 | 14.0 | 1.04 | 88 | 0.36 | 0.17 | 0.16 |
| arena-04 | 2 | y | 0.08 | 0.02 | 0.77 | 0.02 | 0.55 | 6.00 | 2.00 | 48.0 | 0.00 | 151 | 0.42 | 0.13 | 0.12 |
| arena-04 | 3 | y | 0.08 | 0.02 | 0.77 | 0.02 | 0.55 | 4.00 | 2.00 | 24.0 | 0.75 | 151 | 0.42 | 0.13 | 0.12 |
| arena-04 | 4 | y | 0.08 | 0.02 | 0.77 | 0.02 | 0.55 | 3.33 | 2.17 | 16.0 | 1.20 | 151 | 0.42 | 0.13 | 0.12 |
| arena-05 | 2 | y | 0.08 | 0.01 | 0.78 | 0.01 | 0.57 | 6.00 | 2.00 | 48.0 | 0.00 | 151 | 0.43 | 0.10 | 0.15 |
| arena-05 | 3 | y | 0.08 | 0.01 | 0.78 | 0.01 | 0.57 | 6.00 | 1.67 | 33.3 | 0.38 | 151 | 0.43 | 0.10 | 0.15 |
| arena-05 | 4 | y | 0.08 | 0.01 | 0.78 | 0.01 | 0.57 | 6.00 | 1.83 | 16.6 | 1.05 | 151 | 0.43 | 0.10 | 0.15 |
| vs-duel-01 | 2 | y | 0.21 | 0.06 | 0.45 | 0.39 | 0.01 | 2.00 | 2.00 | 27.0 | 0.00 | 60 | 0.19 | 0.15 | 0.00 |
| vs-duel-01 | 3 | N | 0.21 | 0.06 | 0.45 | 0.39 | 0.01 | 2.00 | 1.33 | 13.3 | 0.66 | 60 | 0.19 | 0.15 | 0.00 |
| vs-duel-01 | 4 | N | 0.21 | 0.06 | 0.45 | 0.39 | 0.01 | 2.00 | 1.17 | 13.3 | 0.67 | 60 | 0.19 | 0.15 | 0.00 |
| vs-tri-01 | 2 | y | 0.37 | 0.04 | 0.28 | 0.84 | 0.00 | 1.33 | 1.00 | 24.7 | 0.00 | 43 | 0.18 | 0.29 | 0.33 |
| vs-tri-01 | 3 | y | 0.37 | 0.04 | 0.28 | 0.84 | 0.00 | 1.33 | 1.00 | 17.3 | 0.24 | 43 | 0.18 | 0.29 | 0.33 |
| vs-tri-01 | 4 | y | 0.37 | 0.04 | 0.28 | 0.84 | 0.00 | 1.33 | 1.00 | 13.8 | 0.60 | 43 | 0.18 | 0.29 | 0.33 |
| vs-quad-01 | 2 | y | 0.31 | 0.06 | 0.47 | 0.10 | 0.26 | 2.67 | 2.00 | 36.0 | 0.00 | 68 | 0.32 | 0.15 | 0.00 |
| vs-quad-01 | 3 | y | 0.31 | 0.06 | 0.47 | 0.10 | 0.26 | 2.67 | 1.33 | 24.0 | 0.15 | 68 | 0.32 | 0.15 | 0.00 |
| vs-quad-01 | 4 | y | 0.31 | 0.06 | 0.47 | 0.10 | 0.26 | 2.67 | 1.33 | 23.0 | 0.45 | 68 | 0.32 | 0.15 | 0.00 |

`ok` is `evaluateVersusBoard(...).suitable`. `neck` is bottleneck width in world units;
`rout` the route-disjoint lower bound; `pMin` the shortest spawn-pair path; `sprd` its
spread across pairs over the mean; `pts` the sample size behind `sight` and `bank`; `rot`
the fraction of cells disagreeing under 180-degree rotation. Reproduce with
`npx vite-node tools/mapgen/calibrate.mjs`.

Read across the three dedicated VS boards and the five campaign ones and the bands are not
the same shape at all:

| | campaign (5 boards) | dedicated VS (3 boards) |
| --- | --- | --- |
| wall fraction | 0.08 - 0.16 | 0.21 - 0.37 |
| legal area | 0.65 - 0.78 | 0.28 - 0.47 |
| corridor share | 0.01 - 0.04 | 0.10 - 0.84 |
| bottleneck width | 3.33 - 6.00 | 1.33 - 2.67 |
| longest sightline / diagonal | 0.70 - 0.82 | 0.60 - 0.76 |
| rotational asymmetry | 0.04 - 0.16 | 0.00, 0.00, 0.33 |

The versus boards are **tighter, walled, and either exactly rotationally symmetric or not
symmetric at all**. That is a design language, and it is already the answer to "should a
generator target campaign-shaped boards" -- no.

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

Three rulesets were built and swept, plus the null one. They are in
`tools/mapgen/rulesets.mjs`, each a pure `(seed) -> Arena`, and each declares in advance the
measure it expects to move and in which direction -- so the comparison can be read as a
test of the rules rather than a description of whatever came out.

| ruleset | thesis | in one line |
| --- | --- | --- |
| `scatter` | none -- the null | symmetric random 2x2 blocks, connected floor, nothing else |
| `rooms` | template grammar | a 7-cell lattice of 4-cell rooms and 3-cell lanes, each room stamped from a 6-piece vocabulary |
| `topology` | route graph first | a ring of 9 plazas plus chords, carved 3 cells wide out of solid rock |

Neither structured ruleset invents a dimension. `rooms`' 3-cell lane and 4-cell room and
`topology`'s 3-cell corridor are all read off the gap taxonomy: 3 cells is the comfortable
corridor the arena-geometry spec calls today's standard, 4 cells is wide enough for two
tanks to pass inside one room.

### What the sweep found

20 seeds per ruleset, one fixed board size of 33x27, at 2, 3 and 4 players.

| ruleset | N | accepted | wall | legal | corr | open | neck | rout | sight | bank | rot |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| scatter | 2 | 20/20 | 0.18 | 0.40 | 0.53 | 0.02 | 1.63 | 1.95 | 0.15 | 0.40 | 0.00 |
| scatter | 3 | 20/20 | 0.18 | 0.40 | 0.53 | 0.02 | 1.50 | 1.83 | 0.15 | 0.40 | 0.00 |
| scatter | 4 | 20/20 | 0.18 | 0.40 | 0.53 | 0.02 | 1.57 | 1.54 | 0.15 | 0.40 | 0.00 |
| rooms | 2 | 20/20 | 0.05 | 0.74 | 0.04 | 0.43 | 3.40 | 2.35 | 0.45 | 0.28 | 0.00 |
| rooms | 3 | 20/20 | 0.05 | 0.74 | 0.04 | 0.43 | 3.07 | 2.45 | 0.45 | 0.28 | 0.00 |
| rooms | 4 | 20/20 | 0.05 | 0.74 | 0.04 | 0.43 | 3.13 | 2.42 | 0.45 | 0.28 | 0.00 |
| topology | 2 | 19/20 | 0.55 | 0.21 | 0.66 | 0.00 | 2.00 | 2.00 | 0.21 | 0.26 | 0.00 |
| topology | 3 | 19/20 | 0.55 | 0.21 | 0.66 | 0.00 | 1.96 | 1.82 | 0.21 | 0.26 | 0.00 |
| topology | 4 | 18/20 | 0.55 | 0.21 | 0.66 | 0.00 | 1.96 | 1.47 | 0.20 | 0.27 | 0.00 |

Every figure after `accepted` is a mean over the accepted boards only.

**The rules separate, and mostly in the predicted direction.** `rooms` raises open ground
from 0.02 to 0.43 and bottleneck width from 1.57 to 3.13, as its lane rule requires;
`topology` takes corridor share to 0.66 and legal area down to 0.21, as carving from solid
rock requires. The knobs are wired.

**One prediction was wrong, and it is the interesting one.** `scatter` was expected to sit
at the floor for bank offer, since no rule in it mentions sightlines. It has the HIGHEST
bank gain of the three, 0.40 against 0.26-0.28, and above every shipped board (0.09-0.29).
Uniform clutter blocks direct fire almost everywhere while leaving every block face
available to bounce off, so it maximises carom by accident. Carom opportunity is therefore
**not** a proxy for a well-designed board, and a generator that optimised for it would
converge on confetti. It belongs in the table as a descriptor, not in a fitness function.

**Only `rooms` lands inside the shipped bands.** `scatter` is outside on sight (0.15 against
a shipped floor of 0.17) and bank (0.40 against a shipped ceiling of 0.29); `topology` is
outside on wall fraction (0.55 against 0.37) and legal area (0.21 against 0.28). That is not
a verdict on which plays better -- nobody has played any of them -- but it is the one
statement the calibration supports: of the three, `rooms` is the family that produces boards
resembling the ones already shipped.

<!-- MEDIA: rooms-seed1.png topology-seed1.png -->

### Individual rules, swept one at a time

Comparing whole rulesets hides which rule inside one is doing the work, so each ruleset also
declares single-knob variants. 20 seeds, 4 players.

| variant | accepted | wall | legal | corr | open | neck | sight | bank |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| scatter blocks=14 | 19/20 | 0.12 | 0.57 | 0.17 | 0.19 | 2.04 | 0.26 | 0.40 |
| scatter blocks=26 | 20/20 | 0.18 | 0.40 | 0.53 | 0.02 | 1.57 | 0.15 | 0.40 |
| scatter blocks=40 | 20/20 | 0.18 | 0.40 | 0.53 | 0.02 | 1.57 | 0.15 | 0.40 |
| rooms fill=0.35 | 6/20 | 0.03 | 0.79 | 0.02 | 0.56 | 4.33 | 0.59 | 0.20 |
| rooms fill=0.62 | 20/20 | 0.05 | 0.74 | 0.04 | 0.43 | 3.13 | 0.45 | 0.28 |
| rooms fill=0.90 | 20/20 | 0.07 | 0.69 | 0.06 | 0.31 | 2.43 | 0.35 | 0.32 |
| topology chords=0 | 12/20 | 0.60 | 0.18 | 0.69 | 0.00 | 2.00 | 0.19 | 0.22 |
| topology chords=3 | 18/20 | 0.55 | 0.21 | 0.66 | 0.00 | 1.96 | 0.20 | 0.27 |
| topology chords=6 | 19/20 | 0.52 | 0.23 | 0.67 | 0.00 | 2.00 | 0.20 | 0.27 |
| topology plaza=4 | 18/20 | 0.24 | 0.49 | 0.21 | 0.15 | 1.96 | 0.18 | 0.24 |

Three findings, none of which the ruleset comparison alone would have produced:

1. **`scatter`'s block count is a dead knob above 26.** `blocks=40` is identical to
   `blocks=26` on every column to two decimals. The no-touching rule saturates a 33x27 board
   at around 26 blocks per half, so the parameter stops meaning anything and says so
   nowhere. A rule with a range that does nothing is worth finding before it is written down.
2. **`topology`'s chord count barely moves the board; its plaza radius moves everything.**
   Chords 0 to 6 shift wall fraction 0.60 to 0.52 and leave corridor share, bottleneck and
   sightline flat. Raising the plaza radius from 2 to 4 moves wall fraction 0.60 to 0.24 and
   legal area 0.18 to 0.49. The graph's SHAPE, which was the ruleset's whole thesis, matters
   far less than how much room each node is given.
3. **`rooms`' fill share is the cleanest live knob measured.** Every column moves
   monotonically across 0.35 to 0.90, and the accept rate collapses at the sparse end.

### What the acceptance tier actually refuses

Across the 200 boards the variant sweep draws at 4 players, 28 were refused: **20 by
concealment** and **8 by egress**. `distinctSpawns` and `roomOk` refused none.

So of the four shipped criteria, one does nearly all the work on generated boards, and it
refuses them for being too OPEN -- `rooms fill=0.35` loses 14 of 20 because four spawns on a
sparse board can see each other. That is worth knowing before anyone tunes a generator: the
acceptance tier's live edge is concealment at 3 and 4 players, not connectivity.

## Residuals and what is not settled

**No board here has been played.** Every claim in this document is a static measurement.
The one thing that would settle which ruleset is better is a bot-vs-bot capture at normal
speed on the best board from each, which the versus rulings already accept as satisfying a
playtest criterion.

**Eight boards are not a sample of good boards.** The calibration band describes the eight
maps that exist. A generated board outside it is unlike what has shipped, which is a reason
to look at it and not a reason to reject it.

**`routeCount` is a greedy lower bound, not the true count.** Routes are taken
shortest-first and each one's hull sweep is removed before the next is sought, so a
zig-zagging first route can consume ground a smarter pair of routes would have split. By
Menger's theorem the true figure is the minimum vertex cut. `bottleneckWidth` is the exact
measure and should be read first; making `routeCount` exact would need a max-flow with
vertex splitting, which is not obviously worth it.

**Two measures barely move across the shipped boards** and should not be carried into a
ruleset comparison as if they discriminated: `longestSightlineRelative` spans 0.60-0.82 and
`secondRouteDetour` spans 1.00-1.24 across eight boards that differ enormously in every
other column.

**`openGroundFraction` and `coverSpacing` move with board size.** The probe reaches 1.5 tank
diameters, so every legal point within 1.5 units of the frame loses the directions pointing
at it -- an empty 22x18 board measures 0.68, and the missing third is its own rim. The sweep
holds board size fixed at 33x27 for exactly this reason; a comparison across sizes would put
that drift in the same column as the thing being compared.

**Three-player symmetry is unresolved.** Three-fold rotational symmetry and a rectangular
board are incompatible, which is why vs-tri-01 measures 0.33 rotational asymmetry against
0.00 for the other two dedicated boards. Neither structured ruleset here has an answer; both
impose 180-degree rotation and are therefore fair at 2 and 4 and only approximately fair at
3. What a generator should do at odd player counts is an open design question.

**The quality tier has no weights and deliberately produces no single score.** Collapsing
these columns into one number requires deciding what a good board is, which is a product
decision and not a measurement. The tier is built to inform that decision, not to pre-empt
it.

**The duplicated lattice is a liability.** `tools/mapgen/measure.ts` carries its own copy of
`versus-board.ts`'s private tank-legal lattice, because exporting the original would widen a
shipped sim module's surface for a tool's convenience. It is pinned by a test that compares
the two on all 24 shipped (board, N) combinations, but if the clearance rule there changes,
this copy is wrong until it is changed too.
