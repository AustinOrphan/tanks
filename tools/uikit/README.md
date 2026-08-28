# UI kit primitive states

Dark-surface state evidence for the primitives in `src/game/hud.css` and `src/game/ui.ts`,
produced from the **built** bundle in a real browser.

```
npm run build
PLAYWRIGHT_MODULE=$PWD/node_modules/playwright/index.mjs \
  node tools/uikit/primitive-states.mjs dist --out uikit-out
```

Playwright is not a dependency of this repo — see `tools/visual/README.md` for why and for
the resolution order this script shares.

## What it is, and what it is not

A **one-shot evidence producer** for issue #321's closeout, not a gate. Nothing in CI runs
it, it writes no committed baseline, and it is not the durable `screen.*` recipe work —
that, its baselines and the broader screen-state matrix are issue #326's. When #326 lands
something that subsumes this, delete it.

## Why it measures instead of only photographing

A screenshot named `hover` proves nothing about whether a hover rule applied: a state that
silently failed to engage produces a picture identical to `normal`, and a reviewer has to
eyeball the difference to find out. So every capture also records:

- the computed properties that **changed** against that control's own rest reading, and
- whether the state actually **engaged** — `:hover` and `:active` are asked of the element
  itself with `matches()`, and `:focus-visible` is checked by reading `document.activeElement`
  back after a real keyboard focus change.

A state that engaged and moved nothing is reported `unstyled`, which is a finding rather
than a hole. Without the engagement half, "this control has no hover rule" and "the pointer
never landed" produce the identical report line.

`.hud-rotate-btn` is captured deliberately as the positive control: it carries the only
`:hover` rule in `hud.css`, so if the harness ever stops seeing hover, that entry goes
`unstyled` too and the run is not quietly reporting seven false absences.

## Two differences it measures BETWEEN controls

Per-control deltas cannot answer either of these, because both are comparisons:

- `selection-difference` — the selected vs unselected control, which is how "selection is
  legible without colour alone" is checked.
- `hierarchy-difference` — primary vs quiet vs destructive at rest.

## Driving the shipped HUD, and four ways it goes wrong

Captures target controls the shipped HUD renders, never markup written here — evidence
about unconsumed CSS is worse than none. Driving it has sharp edges, all of them found the
hard way:

- **`mouse.down()` then `mouse.up()` in place is a click.** Capturing `pressed` on New Game
  started a game; every later control then reported "not visible". Release with the pointer
  moved off the control.
- **`.hud-action` is Continue/Resume/Play Again**, hidden on a title screen with no run. The
  visible primary is `.hud-new-game`.
- **Each panel has a named `.hud-<panel>-back`.** A generic "first button in the panel"
  selector clicks a level button and leaves the panel open over the menu.
- **`waitForSelector` defaults to `state: 'visible'`**, so waiting on a `--hidden` class
  never resolves. Use `{ state: 'hidden' }`.
- **Scope queries to the open panel.** The versus pane and the controller panel are built at
  mount and merely hidden, so an unscoped `.ui-selectable--on` matches a control that cannot
  be screenshotted — the attribute read succeeds while the capture fails.
