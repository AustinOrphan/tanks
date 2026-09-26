---
status: proposed
date: 2026-09-17
scope: A three-tier rule set for generating versus maps -- generative rules, the shipped acceptance filter, and a new measured quality tier calibrated on shipped boards.
implementation-issues: [819, 820, 821, 822]
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

![A 33x27 board from the null ruleset: 2x2 blocks scattered uniformly across the whole board with no lanes, rooms or structure](https://raw.githubusercontent.com/AustinOrphan/tanks/pr-media/map-generation-rules/scatter-seed1.png)

*`scatter`, seed 1, at 4 players. Rotationally symmetric, floor fully connected, every spawn
mutually concealed, 10 of 10 accepted. Also confetti.*

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
| longest sightline / diagonal | 0.70 - 0.82 | 0.60 - 0.75 |
| rotational asymmetry | 0.04 - 0.16 | 0.00, 0.00, 0.33 |

The versus boards are **tighter, walled, and either exactly rotationally symmetric or not
symmetric at all**. That is a design language, and it is already the answer to "should a
generator target campaign-shaped boards" -- no.

**What this cannot establish, stated plainly:** eight authored maps are not a sample drawn
from a population of good maps. A band derived from them describes them. A board outside the
band is unlike everything shipped, which is a reason to look at it, not a reason to reject
it.

## Constraints a generator has to satisfy, measured rather than assumed

**A generated board needs a `P`, and it does not matter where.** The authored spawn letter is
a TRIGGER, not a seed. A 33x27 board with no spawn letter loads with zero players at 2, 3 and
4, and `evaluateVersusBoard` then reports `suitable: false` over 0 pairs -- so the letter has
to be there. But its POSITION is ignored: the same board with `P` at cell (4, 2) and at cell
(30, 25) produces byte-identical player positions at every player count, because versus
placement derives every spawn from the geometry. `versus-spawns.ts` says so in as many words:
"In versus the authored `P` is now ignored entirely for placement." The campaign path is the
contrast -- there the same two boards start the player 17 world units apart.

An earlier draft of this document had this backwards, calling P1's cell "the one authored
spawn decision" that every other start follows from. It was corrected by an adversarial review
of the rule sets, which checked the claim rather than accepting it. The correction makes
generation EASIER, not harder: a generator has to emit a spawn letter somewhere legal and owes
the placement no thought at all.

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

## What the genre knows

Six parallel surveys were run, each on a different lens, each required to say for every rule
whether it was a measured result, a convention verified by looking at real maps, or designer
folklore repeated in talks. They returned **112 rules over 92 sources**. The full results are
not reproduced here; what follows is what survives contact with this game.

| lens | what it covered | rules |
| --- | --- | --- |
| tank-lineage | Wii Play Tanks!, Battle City, Atari Combat, Kee Games Tank, open-source remakes | 19 |
| arena-fps-flow | Quake 1/3, Doom, UT, Halo deathmatch canon | 18 |
| grid-topdown | Bomberman family, Battle City, grid board-game arenas | 17 |
| pcg-techniques | BSP, cellular automata, WFC, agent digging, template stamping, ASP | 19 |
| competitive-symmetry-spawns | symmetry groups, spawn placement, team and odd-count cases | 19 |
| pcg-evaluation-metrics | expressive range, Liapis map-sketch metrics, visibility and graph metrics | 20 |

### Where independent lenses converged

**The opening-shot rule must exclude the one-bounce line, not just the direct one.** Five of
the six lenses state it independently -- `no-opening-line-between-spawns`,
`spawn-no-opening-shot`, `no-one-bounce-spawn-to-spawn-line`,
`no-firing-solution-between-spawns-at-t0`, `spawn-first-shot-safety`. The shipped
`allPairsConcealed` checks line of sight only, which is the right rule for a game whose
shells travel straight, and this game's do not.

**This was measured rather than assumed, and the answer is reassuring.** `openingShots` in
`tools/mapgen/measure.ts` counts ordered spawn pairs with no direct line but a live
one-bounce firing solution. The count is **zero** across all **24 shipped (board, N)
combinations** and all **176 accepted (ruleset, seed, N) combinations** drawn from 60 distinct
generated boards -- 3 rulesets x 20 seeds, evaluated at 2, 3 and 4 players, with 4 of the 180
refused by the acceptance tier. The measure is not dead: its control hands it a stub between
two points and gets a bank line, then removes the stub and gets a direct line instead.

**Two things this does NOT establish, and the second is the important one.** A board accepted
at three player counts is three combinations of one board, so the denominator counts boards
repeatedly and is not 176 independent samples. And every board in that population had already
passed `allPairsConcealed`, which forbids a direct spawn-to-spawn line -- so `spawnDirectPairs`
is forced to 0 throughout and `bankOnly` is the only free variable. What the zero shows is that
on these geometries the direct-line rule happens to exclude the one-bounce line as well. It is
not evidence that bank lines between spawns are rare in general.

**Validate the board twice, with destructibles solid and with them gone.** Four lenses state
this. `versus-board.ts` already gates egress on the destructible-free layout, and the quality
tier reports `mineGatedPairs` from the intact one.

**Symmetry: rotate, do not reflect.** A mirror gives one player's cover to the other hand, so
a right-handed approach becomes a left-handed one. The shipped boards already agree --
vs-duel-01 and vs-quad-01 measure 0.00 rotational asymmetry and no shipped board is mirror
symmetric. The honest caveat from the `pcg-techniques` lens is that **nobody has measured
mirror against rotational on any outcome in any game**; the two sources that address it most
directly disagree with each other.

### The one place the genre is actively misleading

Every grid ancestor makes destructible walls the MAJORITY of blocking mass. Battle City's
median destructible share is **66% of tank-blocking mass across all 35 stages**, measured from
a 6502 disassembly; a Bomberman open-source clone measures 47.3% destructible against 14.8%
solid over 16 maps.

Copying that here would be a mistake, and the reason is the cost model. Those games give
every player a free, fast, infinitely repeatable destroyer. This game gives 2 mines, a 3
second fuse, a blast radius of 2 that also kills the owner, and shells that break nothing. It
inherits the Wii Tanks cost model, where cork is a minority embedded in wood and the game's
own strategy guide says removing it usually is not necessary.

The shipped boards already follow the cost model rather than the genre:

| board | wall cells | destructible | share of wall mass |
| --- | --- | --- | --- |
| vs-tri-01 | 168 | 19 | 11.3% |
| arena-05 | 126 | 18 | 14.3% |
| arena-01 | 117 | 18 | 15.4% |
| vs-quad-01 | 279 | 54 | 19.4% |
| arena-04 | 126 | 27 | 21.4% |
| arena-03 | 99 | 27 | 27.3% |
| vs-duel-01 | 117 | 34 | 29.1% |
| arena-02 | 144 | 72 | 50.0% |

Range 11.3% to 50.0%, median 21.4% over 8 boards. The `grid-topdown` lens derives a cap of
**30% of wall mass** from the cost model; **7 of the 8 shipped boards are at or under it**,
and the exception is arena-02, the board whose whole design is mining through a central
barrier. A researched rule and eight authored maps agreeing, with the one exception being
deliberate, is about as much corroboration as this kind of rule gets.

### Rules the research supplies that this repository does not yet have

Ordered by how cheaply they could be adopted, all computable on the existing measures. Items
3 to 6 are issue #822:

1. **One-bounce opening shot** -- measured, currently zero everywhere. Insurance.
2. ~~**Longest sightline cap at 70% of the board diagonal**~~ (`longest-sightline-cap`,
   measured from Quake and Halo practice). **REJECTED 2026-09-25, issue #819 — do not adopt
   this, and do not re-derive it from the same literature.** The survey result and the
   measurement that refutes it are recorded in full under "The sightline cap, and why it was
   rejected" below. A generator gets no sightline ratio rule; a flight-time floor was weighed
   as the replacement and also declined, so it is a rejected alternative rather than the
   successor.
3. **Dead-end budget** -- `no-leaf-rooms`, `navigability-degree-profile` (dead ends at or
   below 2.5% of navigable positions), `cycle-richness-no-dead-ends`. Not currently measured
   at all; `corridorAreaFraction` is a blunt proxy.
4. **Gap taxonomy budget** -- at least 60% of navigable positions in a 3-cell corridor or
   wider. Directly measurable from the existing lattice and not currently computed.
5. **Expressive range analysis** -- rank the RULESET, not the board, by how much of a
   two-axis behavioural space its output occupies. This is the right frame for the sweep
   tables above, which currently report means and hide the spread.
6. **Bot jam filter** -- reject a minimum-width corridor that is also an articulation point.
   This game's bots steer reactively with no pathfinding, so it is more relevant here than in
   the games the rule came from.

### The sightline cap, and why it was rejected

**Ruled 2026-09-25 on issue #819: reject the cap, and record why.** Kept here rather than only
on the issue, because the failure mode being guarded against is a future survey of the same
literature re-adopting the same rule. Three alternatives were weighed and declined: adopting
the 70% cap as surveyed, replacing it with a flight-time floor, and watching a bot-vs-bot
capture before deciding. **The flight-time floor is a rejected alternative, not the
successor** -- a generator gets no sightline rule at all until something new is decided.

Measured over all 8 shipped boards with `npx vite-node tools/mapgen/calibrate.mjs --json`,
which reports `longestSightlineRelative`. Flight time is `longestSightline` divided by the
shipped shell speeds in `src/sim/config/data/balance.json` (normal 6, fast 12, ricochet 4
units/s), and the multiplier is against a 250 ms reaction:

| board | longest sightline | / diagonal | flight at fast | x 250 ms |
| --- | ---: | ---: | ---: | ---: |
| arena-03 | 23.32 | 0.8205 | 1.94 s | 7.77x |
| arena-04 | 29.73 | 0.7992 | 2.48 s | 9.91x |
| arena-05 | 29.12 | 0.7828 | 2.43 s | 9.71x |
| vs-tri-01 | 16.00 | 0.7522 | 1.33 s | 5.33x |
| arena-02 | 20.40 | 0.7175 | 1.70 s | 6.80x |
| arena-01 | 20.00 | 0.7036 | 1.67 s | 6.67x |
| vs-duel-01 | 16.00 | 0.7016 | 1.33 s | 5.33x |
| vs-quad-01 | 17.09 | 0.6012 | 1.42 s | 5.70x |

**Two numbers this document previously carried were wrong, and are corrected above.**
vs-tri-01's ratio is **0.7522**, not the 0.76 that appeared both in the rule text and in the
campaign/VS band table -- so the dedicated-VS band is 0.60 to 0.75. And **seven of the eight
boards exceed 0.70, not five**: arena-01 at 0.7036 and vs-duel-01 at 0.7016 both clear it, and
were previously read as compliant because the table rounded them to 0.70. A cap applied to the
measured value rather than to a two-decimal rendering of it fails all but vs-quad-01.

Three measured reasons the cap does not transfer:

1. **Its own rationale does not survive.** The rule guards against being shot from beyond
   awareness. Here the awareness window is 1.33 to 2.48 s of *fully visible* travel at the
   fastest shell -- roughly **5.3x to 9.9x** a 250 ms reaction -- on a board with no fog and no
   vertical dimension, so the shell is on screen for the whole flight.
2. **The ratio inverts the ordering it is meant to rank.** vs-tri-01 (0.7522) gives the player
   1.33 s; arena-04 (0.7992) gives 2.48 s. The board the cap calls worse gives nearly twice as
   long to react.
3. **Identical exposure earns different verdicts.** vs-duel-01 and vs-tri-01 have the *same*
   16.00-unit longest sightline, and the cap separates them -- 0.7016 against 0.7522 -- purely
   because the boards differ in size. The quantity is wrong, not just the threshold.

**What is still genuinely open is aesthetic, and flight time cannot answer it:** whether long
lines make a board feel like a shooting gallery. The bot-vs-bot capture #819 originally asked
for remains the way to judge that; this rejection only removes a static rule that measurement
contradicts.

**A trap for whoever re-checks this:** `calibrate.mjs`'s printed `sight` column is
`openSightFraction` (0.35, 0.36, 0.42...), not the ratio. Reading it looks like a refutation of
the table above. Use `--json` and `longestSightlineRelative`.

### What the research could not establish

These are quoted rather than paraphrased, because the absences are as useful as the findings.

**Nobody has written down how to design maps for bouncing projectiles.** From the
`grid-topdown` lens: "No talk, paper, postmortem or guide in this sweep discusses building
geometry for bouncing projectiles. Every bank-shot rule here is derived by me from the
mechanics in the brief, and the metric's target band is a guess with no validation." The
carom measures in this document are therefore unanchored to any outside practice, and the
shipped-board range of 0.09 to 0.29 is the only scale they have.

**No metric in the quality literature has been validated against human play.** From the
`pcg-evaluation-metrics` lens: the StarCraft map-space paper defers it explicitly, both
Liapis papers measured only that a genetic algorithm converges on their own fitness
functions, and the one paper that measured anything through play used bots at 15% and 85%
scripted skill. The honest status of the whole quality tier -- theirs and the one proposed
here -- is published and computable, not validated.

**No source anywhere gives a numeric area-per-player rule.** The best available is
categorical: Quake 3 deathmatch maps "designed for up to 16 players" against tournament maps
"for duels between 2". No rule here sets board size from player count, and
`MIN_OPEN_FLOOR_PER_PLAYER` remains a figure derived from this repository's own boards.

**Three-player FFA arena layout: nothing found.** Nor anything on 2v1v1 spawn placement, in
Halo Multi-Team, The Finals, or Unreal Tournament multi-team mods. The `competitive-symmetry`
lens labels its own 2v1v1 rule an invented convention and says the absence "is a signal that
this is unexplored territory rather than a gap in my searching". vs-tri-01's 0.33 rotational
asymmetry is this repository facing the same wall.

**Wii Play Tanks! board data could not be obtained.** Primary sources are behind a Cloudflare
challenge or return HTTP 402; the remakes load levels from external files not in their
repositories. Every statement about Wii cover arrangement is eyeballed from 28 screenshots.
The Battle City numbers, by contrast, come from a 6502 disassembly and are measured.

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

**`rooms` is the family that moves TOWARD the shipped bands, and no tested setting reaches
them.** `scatter` is outside on sight (0.15 against a shipped floor of 0.17) and bank (0.40
against a shipped ceiling of 0.29); `topology` is outside on wall fraction (0.55 against 0.37)
and legal area (0.21 against 0.28). `rooms` is inside on legal area, bottleneck and carom --
but at its default fill share its wall fraction is 0.05 against a shipped floor of 0.08, and
the picture below shows why: the vocabulary pieces are small against the 4-cell room they sit
in, so the board reads as scattered pieces rather than as rooms.

Raising the fill share moves it the right way on every column at once (0.90 gives wall 0.07,
legal 0.69, open 0.31, neck 2.43, sight 0.35) and still does not reach the shipped wall-
fraction floor. So the claim the data supports is about DIRECTION, not arrival: of the three
families, `rooms` is the one whose measures approach the shipped bands as its knob rises, and
closing the remaining gap needs a vocabulary designed against the room size rather than the
prototype's. That is issue #821's job. None of this is a verdict on which plays better --
nobody has played any of them.

![A board from the rooms ruleset: small cover pieces stamped into a sparse lattice, with wide continuous lanes between them](https://raw.githubusercontent.com/AustinOrphan/tanks/pr-media/map-generation-rules/rooms-seed1.png)

*`rooms`, seed 1, at 4 players, at the default fill share of 0.62. The lattice reads as
scattered pieces rather than as rooms, because the vocabulary pieces are small against the
4-cell room -- visible here and confirmed by the wall fraction of 0.05 against a shipped
floor of 0.08. The fill share is the knob, and it is live.*

![A board from the topology ruleset: a ring of open plazas joined by wide lanes carved out of large solid masses](https://raw.githubusercontent.com/AustinOrphan/tanks/pr-media/map-generation-rules/topology-seed1.png)

*`topology`, seed 1, at 4 players. Legible and exactly symmetric, but at 0.55 wall fraction
it is half again as walled as the most walled shipped board, and the plazas are barely wider
than the lanes joining them.*

![vs-quad-01, a shipped versus board: four corner spawns, 180-degree rotational symmetry, destructible blocks in the interior](https://raw.githubusercontent.com/AustinOrphan/tanks/pr-media/map-generation-rules/vs-quad-01.png)

*vs-quad-01 at 4 players, for scale -- an authored board drawn by the same renderer, from the
same merged wall geometry the game collides against. Grey is solid, brown destructible, rings
are the spawns `loadArena` really picked.*

### A fourth ruleset, from a design ruling

A ruling given while this document was in review: **deliberate pathways should be created
rather than left to emerge, and longer straights and L shapes should be encouraged.**

Both halves have independent support in the survey, which is why they were implemented and
measured rather than only recorded. Pathways-first is `loop-skeleton-first` (arena-fps-flow,
graded measured) and `carve-the-spawn-circuit-first` (pcg-techniques): lay the circulation
loop on the tank layer *before* placing any wall and protect those cells. Long straights and
Ls is `cover-as-offset-bars-with-long-flat-faces` (tank-lineage), which reports Wii Tanks and
Battle City cover as axis-aligned runs of 3-8 tank widths, one cell thick, offset between
rows -- and `reflector-faces-for-bank-shots`, since a bank shot needs a flat unbroken face to
come off and a board of 2x2 blocks offers almost none.

`runs` implements both literally: carve a protected 3-cell circuit plus one spur, then place
cover as one-cell-thick runs of 4 to 8 cells with an L-bend on roughly half of them.

| ruleset | wall | legal | corr | open | neck | rout | long | sight | bank |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| shipped band (8 boards) | 0.08-0.37 | 0.28-0.78 | 0.01-0.84 | 0.01-0.57 | 1.33-6.00 | 1.00-2.33 | 0.60-0.82 | 0.17-0.43 | 0.09-0.29 |
| scatter (null) | 0.18 | 0.40 | 0.53 | 0.02 | 1.57 | 1.54 | -- | **0.15** | **0.40** |
| rooms | **0.05** | 0.74 | 0.04 | 0.43 | 3.13 | 2.42 | -- | **0.45** | 0.28 |
| topology | **0.55** | **0.21** | 0.66 | 0.00 | 1.96 | 1.47 | -- | 0.20 | 0.27 |
| **runs** | 0.14 | 0.50 | 0.19 | 0.16 | 2.26 | 1.65 | 0.71 | 0.23 | 0.23 |
| **runs**, longer bars | 0.13 | 0.55 | 0.12 | 0.23 | 2.46 | 1.78 | 0.72 | 0.27 | 0.19 |

Bold marks a figure outside the shipped band. **`runs` is the only ruleset of the four that
lands inside every band**, and the variant with 6-12 cell runs does too. The ruling is
therefore supported by the measurement and not only by taste.

![A board from the runs ruleset with longer bars: one-cell-thick walls in long straight runs and L-bends, with open approach lanes between them](https://raw.githubusercontent.com/AustinOrphan/tanks/pr-media/map-generation-rules/runs-p32-long.png)

*`runs` with 6-12 cell runs, 4 players. The L-bends are the visible difference from every
other ruleset here, and they are what a flat face long enough to bank off looks like on a
grid.*

**Two honest qualifications.**

The piece-count knob is **dead above about 16 pieces**: 16, 24 and 32 produce identical
figures in every column, because the one-cell gap between pieces plus the protected circuit
plus the connectivity check saturate the half-board before the request is met. That is the
same saturation `scatter`'s block count showed, found the same way, and it means density is
not the lever here -- run LENGTH is.

The **pathway is not yet legible**. The carved circuit is protected from pieces, but the rest
of the interior is open too, so the drawn route does not read as a route -- it reads as more
open floor. Making a pathway legible needs the non-pathway space to be denser than the
pathway, and the density knob is exactly the one that saturates. That is unresolved and is
carried into issue #821.

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

## What this proposes

**1. Keep the three tiers separate, permanently.** Acceptance stays a pass/fail filter in
`src/sim/`, gating what may be offered. Quality stays a tool in `tools/`, gating nothing. The
moment a quality measure becomes a gate, a generator can be tuned against it and the measure
stops describing the board and starts describing the generator.

**2. Pursue `runs` -- long bars, L-bends and carved pathways -- and not the other three**
(issue #821). It is the only one of the four landing inside every shipped band, and the one
whose shapes a player would recognise as authored. `rooms` is the runner-up and the family to
borrow the room/lane lattice from. `scatter` is outside the band on two measures and is the
baseline anyway; `topology` is half again as walled as the most walled shipped board. This is
a statement about where to spend the next effort, not a verdict about play -- nobody has
played any of them.

**3. Do not put carom in a fitness function.** The null ruleset maximises bank gain by
accident, at 0.40 against a shipped ceiling of 0.29. Optimising for it converges on confetti.
Report it; do not reward it.

**4. Fix the destructible budget by the cost model, not the genre.** Cap destructibles at
about 30% of wall mass. Seven of eight shipped boards already comply, and the ancestors that
disagree all give their players a free repeatable destroyer that this game does not.

**5. Both open questions are now settled**, and neither answer is the one that needed waiting
for. **#819: the 70%-of-diagonal sightline cap is REJECTED** -- see "The sightline cap, and why
it was rejected" above; a generator gets no sightline ratio rule, and the flight-time floor
weighed as its replacement was declined too. **#820: a generated 3-player board takes
approximate symmetry with a measured tolerance** -- not an inscribed C3 region, and not
skipping N=3.

That ruling commits work this document did not contain. **The C3 measure now exists**
(`rotationalAsymmetry` and the `asymmetryC3` board measure, `tools/mapgen/measure.ts`), because
`asymmetryRotational` could not answer it: that is a **180-degree** measure taking no player
count, and it returns the same value at N=2, 3 and 4. The new one is generalised over the order
of the rotation so it can be controlled -- at two turns over the whole rectangle it reproduces
`asymmetryRotational` exactly on all 8 shipped boards, which is what makes its 3-turn figures
worth reading. It samples the **inscribed disc**, because a rectangle has no 120-degree rotation
onto itself: over the whole shape the count is dominated by cells rotating off the board, and a
uniform 11x11 board -- symmetric under every rotation -- scores 0.132 there against 0 on the disc.

### What it measured, and why nothing is gated on it

**No shipped board is approximately 3-fold symmetric.** Best is arena-03 at **0.2218**; vs-tri-01,
the only board offered at three players, is the second **worst** at 0.4489. A tolerance derived
from this set would have to be >= 0.22 simply to admit the best board, which is an absence of a
tolerance rather than one. The set cannot supply the number because it contains no examples of
the thing being tolerated.

| board | C3 (disc) | `pathSpread` at N=3 |
| --- | ---: | ---: |
| arena-03 | 0.2218 | **0.000** |
| arena-05 | 0.2242 | 0.38 |
| arena-04 | 0.2532 | **0.75** |
| arena-01 | 0.3224 | **0.000** |
| arena-02 | 0.3449 | 0.14 |
| vs-quad-01 | 0.4159 | 0.15 |
| vs-tri-01 | 0.4489 | 0.24 |
| vs-duel-01 | 0.4986 | 0.66 |

**And it does not track three-player fairness**, which is the finding that matters. arena-01 and
arena-03 reach `pathSpread` **0.000** -- every spawn pair equally far apart, the fairest outcome
available -- while scoring 0.322 and 0.222 on symmetry; arena-04 pairs the second-best symmetry
score with the worst spread in the set. A threshold on cell symmetry would order boards unlike
the property it is meant to protect, which is precisely the objection that rejected the
70%-of-diagonal sightline cap above.

So `asymmetryC3` is **reported and not budgeted**. Which quantity the tolerance belongs on --
fairness/exposure, where `pathSpread` already discriminates across a shipped range of 0.00 to
0.75, or cell symmetry, where the number would have to come from first principles or from play --
is the open question on issue #820, and it changes what a generator is built to hit.

**6. Then playtest.** Every claim here is static. A bot-vs-bot capture at normal speed on the
best board from each ruleset is the cheapest thing that would turn any of this into evidence
about play, and the versus rulings already accept one as satisfying a playtest criterion.

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
