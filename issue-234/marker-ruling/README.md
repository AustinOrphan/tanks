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
