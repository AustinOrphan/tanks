# Issue #327 / PR #913 — the Customize pane needed two-axis scrolling at 320px

`#327`'s criterion 5 says core menus stay operable at minimum phone widths **without two-axis
scrolling**. At `320x568` — the smallest viewport the required `visual` gate sweeps — the
Customize pane needed both axes, and one of them could not be panned.

`.hud-swatches` had no `flex-wrap`, so six 44px hull swatches at a 12px gap were **324px in a
320px viewport**:

| | before | after |
| --- | ---: | ---: |
| `.hud-swatches` width | 324 | 156 |
| row x / right | −2 / 322 | 82 / 238 |
| swatch rows | **1 (clipped)** | **3 + 3** |
| swatches clipped | **1 left, 1 right** | 0 |
| `.hud-customize` clientW / scrollW | 320 / **322** | 320 / 320 |

`.hud-customize` carries `touch-action: pan-y`, so a touch player could pan down but **not
across** — the two clipped swatches were not reachable by any gesture.

- `customize-320-before.png` — the selected blue swatch is sliced by the left edge, its check
  badge cut off, and the white swatch by the right edge.
- `customize-320-after.png` — all six visible, as two centred rows of three.

Captured through the real `screen.customize` screen state at 320×568 against production builds
of `main` and the fix.

## Even rows, not five and a stranded one

Wrapping alone stopped the overflow but left **5 + 1** — five swatches on the line and the sixth
by itself, which reads as a rendering fault rather than a layout. A second rule caps the row at
three columns on the widths where that happens.

The breakpoint is measured, not chosen. With the cap defeated, on the real build:

| viewport | swatch rows |
| ---: | :--- |
| 322px | 5 + 1 |
| 323px | 5 + 1 |
| **324px** | **6 — one line** |
| 325px | 6 — one line |

A swatch is `--hud-control-min` (44px) at a `--hud-space-4` (12px) gap, so six are
6×44 + 5×12 = **324px** and three are 3×44 + 2×12 = **156px**. `@media (max-width: 323px)` is
therefore exactly "narrower than one line needs": it reaches every width that would strand a
swatch and no width that would not. Verified at 320, 340, 341, 360 and 1280 — only 320 wraps.

**`.hud-accents` is deliberately excluded**, and that is a correction rather than an omission.
The first draft capped it alongside the swatches; measuring showed five accents are
5×44 + 4×12 = **268px**, which already fits a 320px line intact, so the cap was breaking a clean
row of five into 3 + 2 while rescuing nothing. The mutation entry
`customize-accents-wrongly-capped` restores that mistake and is killed.

`.hud-skins` still ends 3 + 3 + 1 at this width. Those are text buttons of varying width rather
than fixed circles, so the column arithmetic above does not describe them; it is not addressed
here.

## Why the gate did not catch it

The `visual` gate's only horizontal check is `document.documentElement.scrollWidth >
window.innerWidth`. Everything the app draws lives inside a `position: fixed` app root under
`html, body { overflow: hidden }`, and Chromium excludes fixed-position boxes from the
document's scrollable overflow — so that expression cannot become true for a menu, whatever
overflows inside it. Measured: with the row 324px wide and two swatches off-screen,
`document.documentElement.scrollWidth` was still 320.

That hole is separate from this fix and is not closed here.
