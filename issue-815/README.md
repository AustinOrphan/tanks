# Issue #815, the flow producer's proving pair

The matched baseline/`pp1Roles` pair issue #720 needs, produced by `npm run capture` through
the shared pipeline at commit `c9b96cd26b98c78baefe7f265825fe2f3b5490a7`, from a build stamped with that same commit
(`VITE_BUILD_SHA=c9b96cd26b98c78baefe7f265825fe2f3b5490a7 npm run build`). Each capture's own `capture.json` is beside it.

| File | Recipe | Frames | Round |
| --- | --- | --- | --- |
| `pp1roles-off.mp4` | `flow.campaign-round.pp1roles-off` | 150 at 30 fps | 5.02 s, 302 simulated ticks |
| `pp1roles-on.mp4` | `flow.campaign-round.pp1roles-on` | 165 at 30 fps | 5.52 s, 332 simulated ticks |

Both are campaign level 1 (`arena-01`), seed 1, the scripted player, 1280x800 at DPR 1, on the
host GPU. The manifests differ in exactly one recorded field, `variant.flags.pp1Roles`. Each
clip runs from the end of the round-start countdown to the last frame before the level-cleared
panel; the whole fight is in frame.

## What the manifests assert

Eleven assertions pass on both. The ones that carry the timing claim:

- `flow-simulation-rate`: 59.98 and 60.03 simulated ticks per wall-clock second.
- `flow-no-clamped-frames`: no animation frame crossed the game's 250 ms catch-up clamp, so
  simulated time kept pace with the clock.
- `flow-still-playing`: the round was playing at every sample and at the cut.
- `flow-build-identity`: the page named `c9b96cd26b98c78baefe7f265825fe2f3b5490a7`, the commit captured.
- `flow-delivered-rate`: 98.5 and 98.6 compositor frames per second, against the recipe's
  floor of 45. Zero held frames in either clip, so every output frame is a distinct render.

## What these are not

Scripted-player captures, not human play. #358 owns the representative sample and the
adopt/revise/reject ruling; this pair proves the capability and gives #720 its matched
artifact. The arm's effect on the world is not observable from the page (issue #797), so the
flag's evidence here is that the page accepted it, recorded in each manifest's diagnostics.

The two PNGs are frame 90 of each clip, for readers who cannot play the MP4 inline.
