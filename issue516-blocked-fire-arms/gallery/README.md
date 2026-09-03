# Blocked-fire cue arms, rendered in the gallery

These are the clips to review. The arena-framed captures in the parent directory
(`visual-*.gif`) do not show the cues legibly and should be ignored.

## Why the earlier clips failed

A refusal cue lives between 0.07 and 0.55 seconds. At the shipped arena camera the tank
is about 40 pixels wide, so a cue changed roughly 400 pixels of a 276,000 pixel frame,
for one or two frames of a 25fps recording. The cue was in the pixels and invisible to a
person watching.

These clips come from the gallery instead (`npm run gallery --scene blocked-fire
--blocked-fire <arm> --view close --anim`). The camera sits on the tank, the timeline is
deterministic, and the clip runs about nine times slower than real time.

## The clips

| file | what it is |
| --- | --- |
| `all-arms-grid.gif` | all four arms and a no-cue control, side by side, one clip |
| `ring.gif` `muzzle.gif` `turret.gif` `pips.gif` | one arm each, full size |
| `none.gif` | no cue, the control the others are measured against |
| `turret-recoil-zoom-5x.png` | the turret arm at its peak offset, 5x, beside the control |

## What the moment stages

The tank's magazine starts full, so the very first shot is already refused. A refusal
still costs the fire cooldown, so holding fire refuses every 24 ticks rather than every
tick, three times across the 60-tick clip. The arena has no walls, so no shell expires
mid-clip and frees a slot for a real shot to slip in among the refusals.

## Measured change against the control

Peak changed pixels in a single frame, and how much of the clip carries visible change:

| arm | peak changed px | share of frame | frames with visible change |
| --- | --- | --- | --- |
| ring | 17,535 | 5.71% | 87 of 180 |
| pips | 7,778 | 2.53% | 177 of 180 |
| muzzle | 6,925 | 2.25% | 33 of 180 |
| turret | 5,091 | 1.66% | 81 of 180 |

Ten to thirty-eight times the arena capture, and sustained rather than a single frame.
Measured at 640x480; the shipped clips here are 480x400, so absolute counts differ while
the ranking does not.

## A note on the turret arm

The turret arm moves the whole turret group, dome and barrel together. The zoom still
shows this. Issue #526 asks for the barrel alone to recoil, on every shot rather than
only on a refusal, which is a different gesture from what these clips show.

Tooling: PR #528. Cue arms: issues #356 and #516.
