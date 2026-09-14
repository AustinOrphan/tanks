# Capacity flash bar-row rework (PR #702)

Each composite shows the previous PR head `f4aedcf` (flash just under the topbar at every size) above or beside the rework `26a8b99` (flash in the topbar row in landscape). Chromium 151 with swiftshader, DPR 2, full viewport.

**How the flash was shown.** It is **staged**: its text is set to `shells 5/5` and its animation is replaced by the 12–65% hold state (opacity 1, no transform). The real cue lasts 0.9s and fires only with `?dev=1&blockedFire=hud` and a refused shot. Insets come from DevTools' `Emulation.setSafeAreaInsetsOverride`.

**About the arena.** Each shot is a separate live match, so tank positions, trails and lives differ between the two halves. The large "2" in the 844×390 campaign "after" is the round-start countdown, not a HUD overlay under test.

## Rects, CSS px, `left,top,right,bottom`

The flash is measured by its text range. "chips" are the topbar's shown children, left–right.

| case | before: flash text | after: flash text | chips (same on both builds) |
|---|---|---|---|
| 844x390, no inset, campaign | 367.8,57,476.1,82 | 723.7,13.5,832,38.5 | 18–126.5, 142.5–208.4, 224.4–290.6 |
| 844x390, 59px left + 21px right, campaign | 367.8,57,476.1,82 | 714.7,13.5,823,38.5 | 59–167.5, 183.5–249.4, 265.4–331.6 |
| 844x390, no inset, 4-player teams versus | 367.8,57,476.1,82 | 723.7,13.5,832,38.5 | 18–57.2, 73.2–291.9 |
| 640x400, no inset, campaign | 265.8,43,374.1,68 | 519.7,6.5,628,31.5 | 10–87, 95–139.7, 147.7–192.7 |
| 568x320, no inset, 4-player teams versus | 229.8,43,338.1,68 | 447.7,6.5,556,31.5 | 10–41.3, 49.3–268 |
| 390x844, 59px top, campaign | 140.8,94,249.1,119 | 140.8,94,249.1,119 (unchanged) | 10–87, 95–139.7, 147.7–192.7 |

**Board top edges.** Measured separately with the HUD hidden (the visual gate's clearance pass and a DPR 1 probe):

| viewport | board top (CSS px) |
|---|---|
| 844x390 | 48 |
| 640x400 | 49 |
| 568x320 | 39 |
| 390x844 | 303 |

Every "before" landscape flash starts below its board's top edge. Every "after" landscape flash ends above it.
