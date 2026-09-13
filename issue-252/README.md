# Issue #252 — the three developer runtime actions

Both frames are the **built** page at 900x900 @2dpr through `tools/screens/run.mjs`, at a new
`screen.devtools.actions` state.

**Reached with a round running, which is the only place these controls exist.** The steps
continue the saved run and open the pane from the DEV badge rather than from the main menu —
from the menu there is no round to restart and all three are hidden, which is the behaviour
rather than a limitation of the capture.

| | Frame |
| --- | --- |
| Before | `devtools-before.png` |
| After | `devtools-after.png` |

The before frame is the tree this branch started from — issue #247's work, which has since
merged as `a7108dd`. Measured from the two capture reports, same viewport and same state
definition:

| Element | Before | After |
| --- | --- | --- |
| `.hud-devact[data-action="restart-same-seed"]` | absent | y = 387 |
| `.hud-devact[data-action="reroll-seed"]` | absent | y = 430 |
| `.hud-devact[data-action="restart-round"]` | absent | y = 473 |
| `.hud-devtools-back` | y = 430 | y = 559 |

Three rows at the shell's 43px pitch, and Back moves down by exactly three of them (+129).
Nothing above the new controls moves.

Each is measured by its own `data-action` rather than by the shared `.hud-devact` class:
`querySelector` returns the first match, so one class selector would photograph three controls
and report one — and a pane that rendered only the first would measure as correct.

All three carry `.ui-btn--danger`, the same treatment Exit Developer Mode has, because all
three discard the round in progress. Each arms on the first press with its own wording
(`Reroll, losing this round?`) — the two-press confirmation Reset stats and Reset progress
already use, rather than a modal, since the developer is already inside a pane.

## An observation this picture makes, which this PR does not fix

The pane is **translucent over the live board**. That is not new here — `Configuration`,
`Controller Self-Test`, `Copy Diagnostics` and `Pin Current Seed` are equally washed out in
the before frame, and it is a property of opening Developer Tools mid-round rather than from
the menu, where the application ground (#317) is opaque behind it. What this change does is
make it *more* visible, by putting eight controls over the arena where there were five.

Flagged rather than fixed: the pane's backdrop over gameplay belongs to whoever owns that
scrim, and changing it here would be a visual change to five controls this issue does not own.
