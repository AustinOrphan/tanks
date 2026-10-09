# Level button numbers: before and after

The Levels pane (practice level select), state `screen.levels` (the `MID_CAMPAIGN` save, two
levels unlocked), built `dist/`, Chromium via the repository's screens tooling, device pixel
ratio 2, crop of `.hud-levels`.

| | padding | box | number centre minus button centre (x, y) |
| --- | --- | --- | --- |
| before (`c083f9c5`) | `8px 20px` | 44x44 | +3.41px, 0px |
| after | `0px` | 44x44 | 0px, 0px |

Same figures at 1280x800 and 390x844, for both buttons (4 of 4 readings). Measured with a
Range over each button's text against the button's border box.

- `levels-before.png`: the digits sit right of centre.
- `levels-after.png`: centred.
