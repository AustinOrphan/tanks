# Contextual gameplay HUD status (issue #324, step S6)

Five per-kind setters collapse into one `setStatus` projection. Practice gains its own
identity; campaign and versus must not move.

Start with `topbars-before-after.png` — all three kinds, before and after, at 1280.

| | |
| --- | --- |
| `before/` | the topbar strip on clean main, per kind per viewport |
| `after/` | the same shots on the branch |

Captured from the BUILT app through Playwright, driving the real page the way a player
reaches each kind — New Game for campaign, Main Menu -> Practice -> level for practice,
`?dev=1&mode=ffa&players=2&bots=2` for versus — plus a Main Menu shot proving the bar
stays hidden there.

## Measured with `cmp`, not eyeballed

- campaign topbar, before vs after: **unchanged at all five widths**
- versus topbar, before vs after: **unchanged at all five widths**
- practice vs campaign, BEFORE: **identical at all five widths** — that was the gap
- practice vs campaign, AFTER: **distinct at all five widths** — that is the fix

Readouts confirm the contract:

```
campaign   ["Lives: 3","Enemies: 3","Level: 1/5"]
practice   ["Practice","Lives: 3","Enemies: 3","Level: 1/5"]
versus     ["Level: 1/5","P1 3P2 3"]
main menu  topbarHidden: true
```

## The gap not closed

Safe-area insets. Headless Chromium exposes no supported way to set
`env(safe-area-inset-*)`, so the notch case is not in these captures. The two mutation
entries guarding the safe-area padding (`hud-topbar-safe-area-dropped`,
`hud-narrow-block-overrides-padding`) are untouched by this change and still pass, but
that is a CSS guard rather than a rendered frame.
