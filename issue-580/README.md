# Issue #580 — identity ring blend mode

Four-player FFA, captured from the built renderer at `dev=1&seed=42`, one isolated worktree per variant.
Slot 0 is an idle human in its spawn corner (the Versus menu disables Start with no human slot).

| File | Variant |
| --- | --- |
| `1-additive-shipped.png` | `AdditiveBlending` 0.85, shipped palette — what ships. P2 and P3 both read as warm gold. |
| `2-alpha-shipped.png` | `NormalBlending` 0.85, shipped palette — the change. Blue, violet, orange, gold. |
| `3-hybrid-shipped.png` | Alpha body plus additive rim — rejected; the rim reintroduces whitening. |
| `4-additive-c1.png` | `AdditiveBlending` with a candidate replacement palette — three rings wash to near-white. |
| `0-composited-ring-colours.png` | The four ring colours as actually composited over the felt `#2f6d4f`. Top row additive 0.85 (shipped), bottom row alpha 0.85 (the change), P1-P4 left to right. Computed, not sampled. |
