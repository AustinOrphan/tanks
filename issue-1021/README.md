# Issue #1021 evidence: the `marks` stock arm on a 390px phone

Stills of `?dev=1&stockCue=marks&seed=7` at a 390x844 viewport (device scale 2), Chromium with
swiftshader, a production build of branch `feat/marks-stock-arm-phone-fit`. Each is a four- or
three-player FFA on `arena-01`, one human slot and bots, with the retained versus setup seeded
through storage the way `tools/screens/states.mjs` seeds it, captured about 1.5 s after the
strip appeared (the countdown is on screen).

| File | Configuration | What the strip draws |
| --- | --- | --- |
| `marks-4p-x3-after*.png` | 4 players x 3 stocks | the full-size row (9.9px marks), which fits |
| `marks-4p-x4-after*.png` | 4 players x 4 stocks | the 8px row with a 2px gap |
| `marks-4p-x5-after*.png` | 4 players x 5 stocks | the fallback: one full-size mark and the count |
| `marks-3p-x5-after*.png` | 3 players x 5 stocks | the full-size row, which fits |

`*-strip.png` is the top band of the same frame. In every capture the last entry's right edge is
inside the viewport, and the page reported 0 errors.
