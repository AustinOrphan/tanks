# Barrel recoil on every shot (issue #526, PR #530)

The gun kicks when it cycles. A refusal is that same kick arriving with no shell and no
muzzle flash, so it reads as an absence rather than as a symbol to learn.

| file | what it shows |
| --- | --- |
| `normal-shot.gif` | an ordinary shot: recoil, shell, muzzle burst |
| `refusal.gif` | the shell cap refusing, repeatedly: the same recoil, nothing leaving the barrel |
| `dome-stays-still.png` | at rest, recoiled, and a difference mask of what actually moved |
| `muzzle-travel-6x.png` | the muzzle end at rest and at peak recoil, 6x |

## The ruling this implements

The owner ranked the `turret` arm first among issue #516's five, and ruled two changes:
the barrel alone should move rather than the whole turret group, and the motion should
play on every shell fired rather than only on a refusal.

`dome-stays-still.png` is the evidence for the first. The mask is black everywhere except
the muzzle end of the tube: the dome, hull and tracks do not move at all. The changed
region measures 58 x 62 pixels at this framing.

## Measured

Framebuffer bytes changed, out of 1,600,000, against negative controls with the recoil's
event gate severed:

| | live | control |
| --- | --- | --- |
| refusal | 391 | 0 |
| normal shot | 322 | 27 |
| whole turret group (the regression the ceiling catches) | 1330 | — |

Clips rendered with `npm run gallery --scene blocked-fire` and `--scene fire`, close view,
about nine times slower than real time.
