# A controlled four-slot comparison

Produced by the gallery's new posed-scene flag plumbing:

```
npm run gallery -- --elements identity --view game                        # default
npm run gallery -- --elements identity --view game --identityMarker arcs
npm run gallery -- --elements identity --view game --identityMarker shape
```

`four-slots-compared.png` stacks the three, cropped and enlarged: default, arcs, shape.

Deterministic — same camera, same poses, same hues, one frame each. The live-match captures
in this folder could not be compared this way: spawn spread and camera are not controllable
there, and in `game-*.png` the four tanks are piled together at spawn, so most of what looks
like hull occlusion is really tanks occluding each other.

## What it shows

- **Default:** slots 2 and 3 (amber and vermillion) are nearly the same ring. That is the
  ~20 degrees of hue separation `presentation/identity.ts` already records against itself.
- **Arcs:** legible at every slot. Constant radius means constant distance from the hull, so
  nothing is lost where the body is widest.
- **Shape:** circle and square read cleanly. **The diamond is the weakest of the four** — its
  vertices point at the corners where the tank body is widest, so it collapses to a flat line
  under the hull.

The tanks sit at four different body angles on purpose. A marker that spun with its hull
would be visible as such in this still; a row of identically-posed tanks would hide it.
