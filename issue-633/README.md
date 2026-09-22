# Issue #633 / PR #911 — what a seventh campaign level does to the level grid

`.hud-levels` is a `display: flex` row. Until PR #911 it had no `flex-wrap`, so it grew until it
was wider than the viewport — and because it is **centred**, it was then clipped at BOTH ends,
not just the right. `.hud-levelselect` is one of only two full-screen panes with no `overflow`
property, so a clipped button is unreachable rather than merely cramped.

Captured at **320×568**, the narrowest width #633 names, driven through the real
`screen.levels` screen state — its own steps, its own storage — against a production build, with
progress forced to `level-05` so every shipped level is unlocked. The extra buttons are cloned
from the last real one. That clone is evidence about the LAYOUT RULE: `campaign.json` still has
five levels and PR #911 does not change it.

| buttons | row width | result |
| ---: | ---: | --- |
| 5 (today) | 260px | fits |
| 6 | 314px | fits, 3px to spare |
| **7** | **368px** | **clipped at both ends** |

- `levels-7-nowrap.png` — seven levels, no `flex-wrap`. Level 1 is sliced by the left edge and
  level 7 by the right. Neither is reachable.
- `levels-7-wrap.png` — seven levels with `flex-wrap: wrap`. Two rows, every button whole.

At today's five levels the row fits, and a row that fits does not wrap, so the change renders
identically: `npm run screens:check` reports 45 states, 0 failing, with no baseline moved.

**These screenshots corrected the PR.** Its first version claimed a *sixth* level would overflow,
from arithmetic that mistook the 30px margins either side of a centred 260px row for padding
constraining it. Six fits with 3px to spare; seven is the threshold.
