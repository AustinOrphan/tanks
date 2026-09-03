# The smoke arm, against the arms already there (issue #356, PR #534)

A grey puff drifting off the muzzle on a refused shot: the gun cycled, and what
came out was smoke instead of a shell.

**Every clip here already shows the barrel recoil.** Issue #526 made that unconditional,
so what each arm adds is what these clips are for — the comparison is *recoil alone*
(`none.gif`) against *recoil plus each arm*.

| file | what it shows |
| --- | --- |
| `all-arms-with-smoke.gif` | all four arms and the recoil-only control, side by side |
| `smoke.gif` | the new arm, full size |
| `smoke-over-time.png` | the puff at t=3, 20, 45 and 80, beside the muzzle flash at t=3 |
| `none.gif` | recoil only — what a refusal looks like today |
| `muzzle.gif` `ring.gif` `pips.gif` | the three arms currently selectable |

## What separates smoke from the others

`ring` and `pips` annotate the tank with a status readout. `muzzle` puts light exactly
where a real discharge would be. Smoke is the only candidate that reads as a physical
consequence of the shot that did not happen.

It is also the longest-lived: visible in 177 of 180 frames, against the muzzle flash's 36.
A flash is an event; a puff is an aftermath.

## Measured

Peak changed pixels in a single frame, against the recoil-only control at this framing:

| arm | peak | frames with visible change |
| --- | --- | --- |
| ring | 12,257 | 87 of 180 |
| pips | 5,427 | 177 of 180 |
| muzzle | 4,622 | 36 of 180 |
| smoke | 3,293 | 177 of 180 |

In the GL harness, at the shipped camera, `muzzle/smoke` is the tightest pair on the board
at 319 differing bytes — expected, since they are the only two arms drawn in the same
place. It clears the 150 floor, and it is the number that would catch a retune letting
smoke read as a grey flash.

## One caveat worth your eye

Against this arena's dark green felt, any mid-grey reads bright, so at low opacity the
plume can look closer to steam than to gun smoke. A darker grey would read more literally
but sit much closer to the felt in value. Legibility won; it is a taste call and a
one-constant change if you want it the other way.
