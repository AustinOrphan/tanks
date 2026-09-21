# Issue #891 — versus bots hold a committed opponent

Recorded with `tools/screens/record.mjs` against a production build:

```
--flow versus-round --mode ffa --players 4 --bots 4 --level 4 --seed 20260921
--driver autoplay --flag aiContact --seconds 8 --fps 30 --w 800 --h 500 --dpr 1
--visual software-gl --stop window
```

| file | what it is |
| --- | --- |
| `vsbot-contact-overlay.gif` | 8 s of play with the contact overlay, sim 59.0 ticks/s |
| `vsbot-contact-zoom.png` | one moment at 3x: the green contact line and two labels |

The labels read `#2 c62` and `#3 c62` — the committed opponent's tank id, and the ticks of
commitment left. Before this change the same command drew an empty overlay, because every
tank on a versus board is player-kind and both `stepAi` and the overlay skipped those by
construction.

**800x500 rather than 1280x800**, because at the larger size this box delivers 2.7 render fps
and the median frame gap of 367 ms exceeds the page's own 250 ms `MAX_FRAME_DT`, so ~2.9 s of
simulated time is dropped from an 8 s window and the match runs at two thirds speed. At
800x500 nothing clamps and the simulation holds ~60 ticks/s.

**Measured, not eyeballed.** Overlay-lit pixels (lighter than the felt and green-dominant,
which is what the connector actually renders as once blended) over 4 sampled frames: 52 before
the dev-flag path was stamped, 1,229 after.
