# Issue #327 / PR #913 — the Customize pane needed two-axis scrolling at 320px

`#327`'s criterion 5 says core menus stay operable at minimum phone widths **without two-axis
scrolling**. At `320x568` — the smallest viewport the required `visual` gate sweeps — the
Customize pane needed both axes, and one of them could not be panned.

`.hud-swatches` had no `flex-wrap`, so six 44px hull swatches at a 12px gap were **324px in a
320px viewport**:

| | before | after |
| --- | ---: | ---: |
| `.hud-swatches` width | 324 | 320 |
| row x / right | −2 / 322 | 0 / 320 |
| swatches clipped | **1 left, 1 right** | 0 |
| `.hud-customize` clientW / scrollW | 320 / **322** | 320 / 320 |

`.hud-customize` carries `touch-action: pan-y`, so a touch player could pan down but **not
across** — the two clipped swatches were not reachable by any gesture.

- `customize-320-before.png` — the selected blue swatch is sliced by the left edge, its check
  badge cut off, and the white swatch by the right edge.
- `customize-320-after.png` — all six visible, the sixth wrapped to a centred second row.

Captured through the real `screen.customize` screen state at 320×568 against production builds
of `main` and the fix.

## Why the gate did not catch it

The `visual` gate's only horizontal check is `document.documentElement.scrollWidth >
window.innerWidth`. Everything the app draws lives inside a `position: fixed` app root under
`html, body { overflow: hidden }`, and Chromium excludes fixed-position boxes from the
document's scrollable overflow — so that expression cannot become true for a menu, whatever
overflows inside it. Measured: with the row 324px wide and two swatches off-screen,
`document.documentElement.scrollWidth` was still 320.

That hole is separate from this fix and is not closed here.
