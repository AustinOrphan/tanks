# Issue #630 — two identity-marker candidates, in the real game

Captured with `npm run gallery -- --scene game --query 'dev=1&players=4&seed=42[&identityMarker=…]'`
— the actual page at the actual camera, not a mockup. Same seed for all three, so the only
difference is the flag.

| file | flag |
| --- | --- |
| `game-default.png` / `closeup-default.png` | none — today's solid ring, hue only |
| `game-arcs.png` / `closeup-arcs.png` | `identityMarker=arcs` |
| `game-shape.png` / `closeup-shape.png` | `identityMarker=shape` |

## What the real render shows that a flat mockup did not

**The hull partly occludes its own marker.** The camera is angled, not overhead, and the ring
sits on the ground at radius 0.65–0.80 around a tank of radius 0.5. Arcs hold up well because
they stay at constant radius the whole way round. The polygon **edges tuck under the hull**
while only the vertices project, so triangle-vs-square is harder to separate in play than it
was in the top-down comparison — which had recommended shape.

That is the finding, and it is the reason both are in the tree rather than one: this is a
question about a moving board at a fixed camera, and it was never going to be settled by an
SVG.
