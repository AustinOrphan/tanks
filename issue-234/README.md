# Issue #234 — identity marker, normal-speed 4-player FFA

Recorded with `tools/screens/record.mjs` (the real-time producer from #815) against a production
build, both arms from the same seed:

```
--flow versus-round --mode ffa --players 4 --bots 4 --level 4 --seed 20260921
--driver autoplay --seconds 8 --fps 30 --w 800 --h 500 --dpr 1 --visual software-gl --stop window
```

The shape arm adds `--flag identityMarker=shape`, which the page receives as
`&identityMarker=shape`. Nothing else differs.

| file | what it is |
| --- | --- |
| `identity-marker-control.gif` | shipped solid ring, 8 s, sim 58.6 ticks/s |
| `identity-marker-shape.gif` | `shape` marker, 8 s, sim 57.6 ticks/s |
| `identity-marker-strip.png` | the HUD stock strip, shipped above, `shape` below |
| `identity-marker-zoom.png` | one tank at 3x, shipped left, `shape` right |

**Why 800x500 and not 1280x800.** At 1280x800 this box delivers 2.7 render fps and the median
frame gap is 367 ms, past the page's own 250 ms `MAX_FRAME_DT` catch-up clamp — 23 frames clamped
and 2,883 ms of simulated time dropped in an 8 s window, so the simulation ran at 39.7 ticks/s and
the recording would have been slow motion presented as normal speed. At 800x500 nothing clamps,
no simulated time is lost, and the sim holds ~60 ticks/s. The capture is sparse (about 5.7 render
fps), but it is sparse sampling of real-time play rather than a slowed-down game.

**The two arms are separate runs and are not tick-aligned.** The zoom stills come from frame 0 of
each, which is not the same simulated tick, so the tank sits in a slightly different place in the
two halves. They show the treatment, not a moment-matched comparison.
