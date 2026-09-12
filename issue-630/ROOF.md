# Roof blades, the third identity candidate

```
npm run gallery -- --elements identity --view game --identityMarker roof
?dev=1&players=4&identityMarker=roof
```

| file | what |
| --- | --- |
| `four-styles-compared.png` | default · arcs · shape · roof, same four tanks, same camera |
| `roof-blade-count.png` | the count close up: 1, 2, 3, 4 blades |
| `shapes-top-down.png` | circle · triangle · square · **starburst** (was a diamond) |
| `renderorder-bug.png` | left: the bug. right: the same tank top-down, proving the geometry was fine |
| `game-*.png` | the full frames |

## What the numbers say

White pixels per turret disc, left to right: **376 · 319 · 258 · 196** — even steps of about
60 px, one blade's worth each. That monotonic fall is the test that the count actually draws;
it is how the bug below was found and how the fix was confirmed.

## The bug in `renderorder-bug.png`

Both decals are transparent with `depthWrite: false`, so nothing separates them and Three.js
falls back to sorting transparent objects by centroid distance. Two coplanar decals 2 mm apart
at a 51° camera are inside that sort's precision — it resolved one way for three tanks and the
other way for the fourth, dropping the dark blades UNDER the light keyline.

The left frame is what that looked like: a clean white disc with no count on it. The right
frame is the same tank top-down, where all three blades are crisp — which is what proved the
geometry and the rendering were both fine and sent the search to draw order. Fixed with an
explicit `renderOrder`.

Two earlier diagnoses were wrong and are worth recording: "slot 3 renders no blades" came from
counting white pixels per disc, which actually measures blade count MINUS each tank's own
barrel occlusion, and the barrel's overlap varies with yaw. "`polygonOffsetFactor` flips with
the depth slope" was plausible and changed nothing.

## Why slot 4 stopped being a diamond

The diamond was a square turned 45°, so it was the only slot whose distinctness depended
entirely on the counter-rotation working — and in a capture its vertices point where the hull
is widest, so the outline collapsed to a flat line. The starburst is topologically different
rather than a rotation, and its teeth project outward past the hull silhouette.

Its first build used valleys at 18% of the band and rendered as a smooth hexagon: at this size
a shallow waviness in an outline is not a star. The valleys now pinch to the inner edge, so the
mark separates into six real teeth.
