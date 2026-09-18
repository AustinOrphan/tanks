# Issue #720: the pp1Roles evidence package's normal-speed captures

Four captures, two matched pairs, made by `npm run capture` at commit `18ee6d1e77a9b98c8f9285be6904f59ef663c446` from a build
stamped with it. Each clip's own `capture.json` is beside it, and a still from frame 60.
The package that reads them is `docs/research/pp1-roles-evidence.md`.

| File | Level (arena) | Arm | Clip | Round | Ended |
| --- | --- | --- | --- | --- | --- |
| `campaign-round.pp1roles-off.mp4` | 1 (arena-01) | shipped | 150 frames, 5.0 s | 302 ticks | Level Cleared |
| `campaign-round.pp1roles-on.mp4` | 1 (arena-01) | pp1Roles=1 | 165 frames, 5.5 s | 332 ticks | Level Cleared |
| `campaign-roster.pp1roles-off.mp4` | 4 (arena-04) | shipped | 1518 frames, 50.6 s | 3039 ticks | Level Failed |
| `campaign-roster.pp1roles-on.mp4` | 4 (arena-04) | pp1Roles=1 | 557 frames, 18.6 s | 1116 ticks | Level Failed |

Level 1 holds Brown, Grey and Teal; level 4 is the first board holding every kind the arm
touches. Within a pair the only difference is the flag. Eleven assertions pass on every
capture, including that the simulation held 59.96 to 60.02 ticks per wall-clock second, that
no frame crossed the game's catch-up clamp, that the round was still playing at the cut, and
that the page named the commit being captured.

Scripted player, not human play. #358 owns the representative sample and the ruling.
