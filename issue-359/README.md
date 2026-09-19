# Issue #359: normal-speed evidence for sticky target selection

Recorded from a build of commit `3a061c0619c94258fd676e2a82f21178d5bc89e5` through the real-time capture recorder, using the
`versus-round` and `campaign-round` flows with the `aiContact` developer overlay on.

Both clips are **normal speed**, and that is a measurement rather than a claim: the recorder
reports the simulation rate it observed, and both ran at **60.0 ticks/s**.

## `coop.mp4` -- the evidence that answers the criterion

`--flow campaign-round --level 4 --players 3 --bots 2 --flag aiContact`, seed 359002.
Three player tanks share the board against the level's enemy AI.

`coop-committed-targets.png` is one frame of it. Each enemy is labelled with the id it is
committed to and its remaining commitment ticks: four enemies read `#7` and one reads `#9`.
That distribution IS the criterion -- most of the pressure on one co-op player, one enemy
holding another -- and the countdowns show the commitment spans running rather than the AI
re-deciding every tick.

## `vsbot.mp4` -- and why it does not answer it

`--flow versus-round --mode ffa --players 4 --bots 4 --flag aiContact`, seed 359001.
A fully autonomous four-player FFA round.

**The overlay draws nothing, because there is nothing for it to draw.** Bots are
player-kind tanks driven through `decidePlayerInput` (`src/sim/ai/player-profile.ts`), which
does not import `target-selection.ts` at all -- `stepAi` skips player-kind tanks outright
(`src/sim/ai/index.ts:32` and `:127`), and `ai-contact.ts:237` skips them too.

So a versus match contains no committed targets. The clip is kept as the evidence of that
fact, not as evidence of sticky targeting.
