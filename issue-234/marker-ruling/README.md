# Issue #234: the FFA identity marker, for the treatment ruling

Rendered from a build of commit `a1c9c9b741e2066415c9e9e159ac56399b3f218c` (merged `main`, after #833). Each image is the HUD
stock strip alone, at 4x device pixels, from the same seeded four-player FFA board
(`?dev=1&mode=ffa&players=4&seed=20260918`).

The strip is cropped out deliberately. The question here is whether four players can be told
apart at a glance, and a full frame makes that a question about screen resolution instead.

## Conditions

`normal` and `greyscale` are as captured. The three dichromacies are simulated in the page
with an SVG `feColorMatrix` carrying the **Machado et al. 2009 severity-1.0** matrices --
the same model the 2026-09-07 palette analysis on this issue used -- applied in linearRGB.

This is a simulation, not a person with colour-vision deficiency looking at a screen.

## Files

`strip-<style>-<condition>.png` for style in `off`, `shape`, `arcs`, `roof` and condition in
`normal`, `greyscale`, `protanopia`, `deuteranopia`, `tritanopia`. Twenty in all.

`strip-off-*` is the shipped strip: hue only, no marker. It is the control and it is where the
problem is visible.

## Full frames

`frame-<style>-<condition>.png` for style in `off`, `shape` and condition in `normal`,
`deuteranopia`, `greyscale`. Arena and HUD together, at 1280x800.

These are the frames the ruling turns on. The STRIP already names each player in text, so the
strip was never colour-only. The ARENA ring is, and `frame-off-deuteranopia.png` is where that
shows: two of the four rings render as the same yellow, so two tanks cannot be told apart at
all. `frame-shape-deuteranopia.png` is the same board, where those two are a square and a
triangle.
