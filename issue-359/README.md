# Issue #359 — normal-speed co-op and VS-bot evidence for sticky target selection

Both recorded with `tools/screens/record.mjs` against a production build of `main` at
`635b545` (which includes #897), with the `aiContact` overlay on.

```
co-op : --flow coop-round   --players 3 --bots 3 --level 3 --seed 20260921
vs    : --flow versus-round --mode ffa --players 4 --bots 4 --level 4 --seed 20260921
both  : --driver autoplay --flag aiContact --seconds 8 --fps 30 --w 800 --h 500 --dpr 1
        --visual software-gl --stop window
```

| file | what it is |
| --- | --- |
| `coop-contact.gif` | campaign co-op, 3 slots, enemy AI committed targets; sim 59.1 ticks/s |
| `coop-labels.png` | two enemies at 3x, reading `#6 c3` and `#8 c57` |
| `vsbot-contact.gif` | 4-player FFA, all bots, bot committed targets; sim 59.5 ticks/s |
| `vsbot-labels.png` | two bots at 3x |

The overlay label is `#<committed target id> c<ticks of commitment remaining>`. In the co-op
still the two enemies carry **different** target ids and very different countdowns -- one with
3 ticks left, one with 57 -- which is the "understandable pressure distribution and target
changes" the criterion asks for, rather than both AIs converging on one player.

**Why 800x500 and not 1280x800.** At the larger size this box delivers 2.7 render fps and the
median frame gap of 367 ms exceeds the page's own 250 ms `MAX_FRAME_DT`, so ~2.9 s of simulated
time is dropped from an 8 s window and the match runs at two thirds speed. At 800x500 nothing
clamps and the simulation holds ~60 ticks/s. `surfaceAtEnd: playing` in both.

**The VS-bot half was impossible before #897.** Versus bots fill player slots, so `stepAi`
skipped them and the overlay drew nothing; `pr-media/issue-359/vsbot-no-overlay.png` is that
non-evidence. #891 gave them a committed opponent through the same `applyCommitment` the
campaign AI uses.
