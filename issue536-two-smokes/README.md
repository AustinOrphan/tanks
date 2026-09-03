# Both smokes, compared (issue #536, PR #537)

Smoke now plays on **every** shot. A refusal puffs a darker, thicker one. These clips are
the two side by side.

| file | what it shows |
| --- | --- |
| `two-smokes-side-by-side.gif` | both, aligned on their own event -- shot left, refusal right |
| `frames-shot-vs-refusal.png` | four frames of each, as stills |
| `ordinary-shot.gif` | a normal shot: recoil, shell, flash, grey puff |
| `refused-shot.gif` | repeated refusals: recoil, no shell, no flash, dark soot |

The recoil plays in both — that shipped with #526. The shell and the muzzle flash appear
only on the left. What #537 adds is the smoke, and the difference between the two.

## Darker alone did not work

Measured at the shipped arena camera, as mean absolute difference in **levels** over the
bytes the cloud covers. Byte counts measure area and are blind to this.

| | shot vs refusal | shot vs empty arena | refusal vs empty arena |
| --- | --- | --- | --- |
| colour only | 20.34 | 11.13 | **9.20** |
| shipped | 27.54 | 10.60 | **16.94** |

With the refusal differing only in colour, the two puffs sit far apart from each other --
but the refusal was **quieter against the felt than an ordinary shot**. The exceptional
event was the less visible one, because the arena is dark green and black moves toward it.

So darkness is joined by density: near-black at 0.96 peak opacity with linear thinning,
against the shot's grey at 0.72 and a squared curve. Darkness stays the primary signal and
is asserted per channel; density reinforces it rather than standing in for it.

## Worth your eye

The shot's grey puff is deliberately understated -- at 0.72 peak against a shell and a
muzzle flash leaving the barrel in the same instant, it reads as a wisp rather than a
plume. That is a taste call. If firing should feel weightier, the shot's peak is one
constant.
