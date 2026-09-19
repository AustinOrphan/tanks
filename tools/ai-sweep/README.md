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

## Scope

The corpus is `generateScenario` from `src/sim/scenarios.ts` — the same generator the
repository's on-demand scenario sweep uses. Not every seed produces bots, so the run reports
`seedsWithBots` beside the seed count; quote that as the population rather than the number of
seeds requested.
