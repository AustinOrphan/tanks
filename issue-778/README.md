# Issue #778: the identity marker in the HUD stock strip

Everything here was rendered from a build of commit `a4838d786e0dacdcf3832fe2f9aafb4efabd9998`, stamped with it. The arm is
`?dev=1&mode=ffa&players=N&identityMarker=shape`: each FFA stock-strip entry carries the same
mark that slot wears on the ground, so the pairing can be judged as a pair.

**This is scripted play and still frames. It is not a playtest, and no physical device was
used.** #234 owns the adopt, revise or reject ruling.

Every frame is the same seeded board (`seed=20260918`), captured about 2.6 s after the round
starts so the start countdown has cleared. Arena and HUD are in one frame throughout, which is
the comparison the issue asks for: the strip's mark against that player's ring.

## The slot table

The strip reads the same table the ring does (`src/presentation/identity-marker.ts`), so these
cannot drift apart:

| Slot | Mark |
| --- | --- |
| P1 | circle |
| P2 | triangle |
| P3 | square |
| P4 | starburst |

## The matrix

Three player counts, two widths, three colour conditions. `desktop` is 1280x800, `phone390`
is 390x844, both at device pixel ratio 1.

| File | Players | Width | Condition |
| --- | --- | --- | --- |
| `ffa2-desktop-normal-shape.png` | 2 | desktop | normal |
| `ffa2-desktop-greyscale-shape.png` | 2 | desktop | greyscale |
| `ffa2-desktop-forced-shape.png` | 2 | desktop | forced |
| `ffa2-phone390-normal-shape.png` | 2 | phone390 | normal |
| `ffa2-phone390-greyscale-shape.png` | 2 | phone390 | greyscale |
| `ffa2-phone390-forced-shape.png` | 2 | phone390 | forced |
| `ffa3-desktop-normal-shape.png` | 3 | desktop | normal |
| `ffa3-desktop-greyscale-shape.png` | 3 | desktop | greyscale |
| `ffa3-desktop-forced-shape.png` | 3 | desktop | forced |
| `ffa3-phone390-normal-shape.png` | 3 | phone390 | normal |
| `ffa3-phone390-greyscale-shape.png` | 3 | phone390 | greyscale |
| `ffa3-phone390-forced-shape.png` | 3 | phone390 | forced |
| `ffa4-desktop-normal-shape.png` | 4 | desktop | normal |
| `ffa4-desktop-greyscale-shape.png` | 4 | desktop | greyscale |
| `ffa4-desktop-forced-shape.png` | 4 | desktop | forced |
| `ffa4-phone390-normal-shape.png` | 4 | phone390 | normal |
| `ffa4-phone390-greyscale-shape.png` | 4 | phone390 | greyscale |
| `ffa4-phone390-forced-shape.png` | 4 | phone390 | forced |

## The controls

| File | Asked for |
| --- | --- |
| `ffa4-desktop-normal-off.png` | nothing: the shipped strip, hue only |
| `ffa4-desktop-forced-off.png` | the shipped strip under forced colours |

`ffa4-desktop-forced-off.png` is the frame that states the problem. Under forced colours every
entry is repainted the same white, so the strip says "P1 P2 P3 P4" in one colour and the hue
channel carries nothing at all. `ffa4-desktop-forced-shape.png` is the same board with the arm
on, where the four marks are the only thing separating the players.

`ffa4-desktop-greyscale-shape.png` makes the same point for a greyscale display. No browser
knob emulates one, so the page is desaturated in the page itself with a `grayscale(1)` filter
over the whole frame, arena included, rather than over the strip alone.

## The other two styles

| File | Asked for |
| --- | --- |
| `ffa4-desktop-normal-arcs.png` | `identityMarker=arcs`, the ring broken into slot+1 arcs |
| `ffa4-desktop-normal-roof.png` | `identityMarker=roof`, slot+1 blades |

All three styles draw a glyph, so the pairing holds whichever the owner picks. `arcs` and
`roof` are counts; `shape` is recognition.

## What these frames do not show

- No physical phone. `phone390` is a 390x844 viewport in headless Chromium, not a device.
- Teams mode is deliberately unchanged and is not captured: a teams entry already carries the
  A/B/C letter as its non-colour channel.
- The arena is a WebGL canvas, so forced colours does not repaint it. The ground rings keep
  their hues in the forced-colours frames while the HUD around them does not.
