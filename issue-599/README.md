# Issue #599 — controller compatibility self-test

Captured with `npm run screens -- --state screen.devtools.controller-selftest` against the
built page, over the `mixed` gamepad fixture (one `mapping: 'standard'` pad with 4 axes and
17 buttons, one unmapped pad with 6 axes and 12 buttons). A headless browser has no
controller and a browser reports no pad until one is actuated, so without the fixture every
capture machine photographs the pane's empty state.

| File | Viewport | What it shows |
| --- | --- | --- |
| `devtools-1280x800.png` | 1280x800 @2 | The developer shell with the Controller Self-Test entry. At this viewport the pane does not overflow. |
| `selftest-1280x800.png` | 1280x800 @2 | The shipped pane: two pads, each with its own mapping and channel counts, a held trigger in gold, an analog trigger at 0.35. |
| `selftest-900x500.png` | 900x500 @1 | The same pane on a viewport it overflows (content 834px in a 500px window). `.hud-selftest-pads` starts at y = +238 -- below the scroll origin, so the heading is reachable. |
| `axis-left-filled-1280x800.png` | 1280x800 @2 | REJECTED first draft, kept for the comparison: axes drawn left-filled, so a resting Axis 2 draws a longer bar than a trigger genuinely held at 0.35. |
