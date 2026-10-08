# Issue #993 — the Teams results table grouped players by slot parity

The Teams results table summed each slot into `teamOf(slot)` (`slot % 2`) and always drew two
rows, whatever teams versus setup had assigned. Setup lets each slot pick team A, B or C, so any
split other than the default A B A B reported the wrong totals, and a 2v1v1 lost its third side.

Each pair below is the **same match** played on two builds: `main` at `469152f4`, and the fix
branch `fix/teams-results-by-configured-team`. Captured from the built page in headless
Chromium 151 (Playwright 1.62.0), 1280x800, `?dev=1&replay=1&autoplay=1&seed=7`, through the
`screen.ending.versus.teams.played` state with only its stored setup changed. The sim is
unchanged between the builds, and the per-slot figures recovered from each table agree.

## A A B (three players)

| | title | rows |
| --- | --- | --- |
| before (`aab-before.png`) | Team 1 wins | Team 1: 1 kill, **1 death**, 20% · Team 2: 0, 0, 0% |
| after (`aab-after.png`) | Team A wins | Team A: 1 kill, 0 deaths, 20% · Team B: 0, **1 death**, 0% |

Before, the winning side is charged the loser's only death: slot parity puts P1 and P3 together
although P3 was on the other team.

## A A B C (four players, 2v1v1)

| | title | rows |
| --- | --- | --- |
| before (`aabc-before.png`) | Team 1 wins | Team 1: 1, 2, 7% · Team 2: 2, 1, 17% |
| after (`aabc-after.png`) | Team A wins | Team A: 2, 1, 18% · Team B: 0, 1, 0% · **Team C: 1, 1, 10%** |

Before, team C has no row, and both rows mix players from different teams.
