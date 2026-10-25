# #925: co-op death toast captures (2026-10-24)

Built `dist` of branch `feat/death-vignette-owner-toast` after the review fixes (commit b006e34f's
tree), Chromium through Playwright 1.62.0 with SwiftShader, 1280x800, AudioContext overridden. Two
player tanks in co-op on Level Select level 4, seed 7, players idle; each frame taken the moment a
"P<n> out" toast appeared.

| file | what |
| --- | --- |
| `color-l4-seed7-death-2.png` | second death: "P2 out" and "P1 out" stacked; the vignette in slot 0's owner color `#3fd0ff`; the wipe reset the arena |
| `grey-l4-seed7-death-2.png` | the same moment with `html{filter:grayscale(1)}` from boot: the tanks and the vignette lose their hue, the toasts stay readable |
| `crop-rail-grey-l4-seed7-death-2.png` | the toast rail from the greyscale frame |
| `crop-strip-versus-ffa-grey-seed7-death-1.png` | versus FFA for comparison (taken before the review fixes, which do not change versus): no toast; the stock strip names the slot by shape and number |

The live region read just after each co-op shot held only the "P<n> out" toasts, with the
announcement line empty.
