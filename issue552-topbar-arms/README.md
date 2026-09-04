# Topbar content arms (issue #552)

Six arms behind `?dev=1&topbar=<id>`, same scenes and viewports #324's S6 used.

**Start with `all-arms-1280.png`** — every arm on every kind, one sheet.

`campaign/`, `practice/`, `versus/` hold the cropped bar at 360 (the breakpoint) and 1280.

## The arms

| id | what |
| --- | --- |
| `full` | today. The control — adds no class and no rule, so it IS the shipped cascade |
| `spare` | no enemy count, `Level: 1` |
| `enemies-only` | enemy count removed, nothing else |
| `denominator-only` | denominator removed, nothing else |
| `mode-chips` | CAMPAIGN / PRACTICE / VS on every kind |
| `spare-chips` | both together |

`enemies-only` and `denominator-only` exist so the two removals can be judged apart
rather than as a package.

## What the measurements say

Space is almost entirely in the enemy count, not the denominator: at 360, dropping the
denominator saves **12px** of bar (190 -> 178); dropping the enemy count saves **73px**
(190 -> 117).

The enemy count is the **only readout that moves within a level**. Drop it and the bar is
static for the whole board — Lives changes only on death, Level only between boards.

The chips add **4px of height** on campaign and versus (27 -> 31 at 360, 45 -> 49 at 1280)
— which is exactly the height Practice already has. So `mode-chips` makes the bar **stop
changing height between kinds**, which is an argument for it that has nothing to do with
labelling.

Nothing wraps down to 320px; `mode-chips` ends at x=279 of 320.

## A correction

Issue #552 claimed versus wrongly shows `Level: 1/5`, and called it a defect to fix
regardless of the ruling. **That was wrong.** The versus a player can actually reach
(Versus Setup -> Start) runs a one-level synthetic system, so `missions > 1` is already
false and its bar reads `P1 3  P2 3` and nothing else, at every width.

The row that prompted the claim came from `?dev=1&mode=ffa&players=2` — a versus world on
the CAMPAIGN level system, where the ordinal is genuinely true and the win panel says
"Level N cleared!". So nothing is leaking, and #324's "only its authoritative status
fields" already held.

The chip arms still drop versus's level chip, but as a **design** choice — the VS chip
takes the leading slot — not as a fix.
