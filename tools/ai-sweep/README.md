# AI tunable sweep

Measures what an AI tunable does to target selection, over seeded deterministic scenarios
(issue #359).

```sh
npm run ai:sweep -- --values 0.5,1,1.5,2,3 --seeds 1-40 --ticks 1800
```

## Why it patches a file

`decideCommitment` reads `configFor(tank.kind)`. `configFor` returns from a catalog that
`src/sim/config/roster.ts` resolves **once at module load** from validated JSON. There is no
override seam, and `CLAUDE.md` forbids adding parallel configuration plumbing or a runtime
flag to `src/sim/` — the sim is pure and its config is validated data.

So the sweep edits `src/sim/config/data/ai-profiles.json`, measures, and restores it. This is
the shape `npm run gallery -- --sweep` already uses for render constants, and it keeps the
same two safety rules:

- it refuses to start if that file has uncommitted changes, so an interrupted run cannot be
  confused with your own edits;
- it restores in a `finally` and then re-checks `git status`, printing a loud `WARNING: left
  modified` if the restore did not take.

Each value is measured in a **fresh process**, because a patched file re-imported in the same
process would read the cached module and measure the shipped value under every label.

## How it refuses to mislead you

Three independent checks, because the failure mode here is publishing a confident comparison
that is really an artefact:

1. **The patch is counted.** Every profile must be rewritten, or the run aborts naming how
   many of how many it changed.
2. **The child reads the value back** out of its own resolved config and returns it. If that
   disagrees with what was asked for, the run aborts — the numbers from that process are
   about the wrong configuration.
3. **The verdict**, printed before the table is worth believing:
   - `no-signal` — too few `switched-on-expiry` events for the parameter to have acted on.
     Identical rows say *nothing* here. Widen `--seeds` or `--ticks`.
   - `dead-knob` — there was signal and the rows are still identical. Do not report this as
     "the parameter does not matter"; check that the measure watches the path the patch
     changes.
   - `ok` — signal, and the rows differ.

   Only `switched-on-expiry` counts toward signal. `target-lost` retargets are forced by the
   issue's rule 5 and happen at any commitment time, so a run full of deaths can look busy
   while telling you nothing about the window.

## What it measures

Per value, over all seeds:

| field | what it is |
| --- | --- |
| `changesPer1kTicks` | target changes per 1000 AI-ticks, so runs of different length compare |
| `switchesOnExpiry` | the only retarget the threshold actually chooses |
| `spanTicks` | how long one opponent was held, as a distribution — the direct measure of stickiness |
| `pressure` | largest share of live bots aimed at one opponent, averaged over ticks |

`spanTicks` deliberately leaves each tank's final, open hold uncounted: the run ended, the
target was not dropped, and counting it would bias every row downward — most of all the short
commitment times it would flatter.

The full result is written to `tmp/ai-sweep.json` (already gitignored; override with `--out`).

## Per profile, not per board (issue #908)

A pooled row cannot answer "what would it do if these two tanks differed", which is the
question a per-profile commitment window is about. With `--profile`, seven profiles hold while
one moves, and the pooled row divides that one profile's change by the whole board's AI-ticks.
Measured over seeds 1-40 at 1800 ticks, the five reachable profiles own between 12.4% and
26.6% of the measurable AI-ticks, so the pooled row understates a single-profile change roughly
four- to eight-fold.

So every value also prints a table per AI profile, each divided by its own denominator:

| field | what it is |
| --- | --- |
| `aiTicks` | that profile's own share of the measurement — the denominator, and the population |
| `switchesOnExpiryPer1kTicks` | expiry switches over that profile's ticks, not the run's |
| `spanTicks` | held spans of that profile's tanks only |
| `sharedTarget` | how much company the profile keeps on its target |

`sharedTarget` is the per-profile analogue of `pressure`, and deliberately a different shape.
The board-level `pressure` counts target-less bots in its denominator, because "nobody has a
target" is low pressure for the board. A per-profile sample cannot: a bot with no target is not
sharing one, and scoring it 0 would let a profile that loses sight of everyone read as the most
considerate. So target-less ticks are absent from `sharedTarget` and present in `aiTicks` —
which makes `sharedTarget.n` below a profile's `aiTicks` the measure of how often it had nothing
to aim at. Its floor is `1/bots`, never 0: a bot always shares its target with itself.

Kinds fold onto profiles before the arithmetic, never after it: `teal` and `yellow` both carry
`MOBILE_MINE_LAYER`, and the median of a union is not the median of two medians.

## What a seed set cannot tell you

The run reports coverage before the tables, and keeps two different reasons apart because they
call for opposite responses:

- **No tank kind carries the profile.** `ai-profiles.json` authors eight profiles;
  `tank-defs.json` maps five of them to a kind. `OFFENSIVE_ASSAULT`, `OFFENSIVE_ELITE` and
  `BERSERKER_ROCKET` are carried by nothing, so no seed set reaches them and their
  `targetCommitmentTime` is unfalsifiable until some kind adopts one. Widening `--seeds` cannot
  help.
- **A kind carries it and these seeds did not produce one.** Widen `--seeds`.

Do not read five printed rows as five-of-five coverage.

## How a single-profile patch is verified

Each child reads **every** profile's resolved `targetCommitmentTime` back out of its own
config, and the parent asserts the whole map: the named profile moved to the swept value, and
the others still read what the file shipped (`readProfileField` supplies those). Both halves
matter — a patch that leaked into a neighbour is exactly what would make a reported personality
difference really a global rebalance.

`readProfileField` is deliberately stricter than `patchField`: it reads the profile's own field
at depth 1, never a nested object's copy of the same name, because `configFor` resolves the
profile's own value and that is the one a read-back has to compare.

## Scope

The corpus is `generateScenario` from `src/sim/scenarios.ts` — the same generator the
repository's on-demand scenario sweep uses. Not every seed produces bots, so the run reports
`seedsWithBots` beside the seed count; quote that as the population rather than the number of
seeds requested.

Half the generated scenarios are versus, where every tank fills a player slot and so is
excluded from the measurement by `kind !== 'player'`. Over seeds 1-40 that was 17 of 40 seeds,
and those same 17 contributed 0 AI-ticks — the correspondence was exact. Versus-bot commitment
comes from `BOT_TARGET_COMMITMENT_SECONDS` in `src/sim/ai/bot-difficulty.ts` instead, and this
sweep does not touch it.
