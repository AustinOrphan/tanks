# Issue #230: the `marks` stock arm

Rendered from a build of commit `44d37aabcdaee56c7e9807af4801946df1ea0bf0`. `?dev=1&mode=ffa&players=4&stockCue=marks`, four
players, seed 20260918, captured about 16 s in so at least one stock has actually been lost.

The arm replaces the pip with the slot's own identity outline (#234's `shape`), so one channel
carries both which player an entry belongs to and how many stocks are left. The separate
leading identity marker is suppressed while it runs.

## The strip

| File | Asked for |
| --- | --- |
| `strip-shipped.png` | nothing: the digit |
| `strip-pips-with-marker.png` | `stockCue=pips&identityMarker=shape` -- what prompted this |
| `strip-marks.png` | `stockCue=marks` |
| `strip-marks-greyscale.png` | the same, desaturated in-page |
| `strip-marks-forced.png` | the same, forced colours |
| `strip-marks-deuteranopia.png` | the same, Machado 2009 at severity 1.0 |
| `strip-marks-teams.png` | teams, where the arm falls back to plain pips |

`strip-pips-with-marker.png` is the frame that prompted the arm: the entry states its identity
three times, and slot 1's hollow LOST pip is the same circle as its leading identity mark.

`strip-marks-forced.png` is the one that argues for it. Every entry is repainted the same
white, and the arm still carries everything: shape says which player, fill says held against
spent.

## Width, which is the arm's open question

Measured in a 390x844 viewport, four players:

| Arm | 3 stocks | 5 stocks |
| --- | --- | --- |
| shipped digit | 243px, fits | 243px, fits |
| `marks` | 264px, fits | **359px, overflows by 21px** |
| `pips` | 345px, overflows | **449px, overflows by 111px** |

`marks` is 81px narrower than `pips` because it drops both the leading marker and the digit,
and it is the only unit-based arm that fits a phone at three stocks. **Neither fits at five.**
That is #835, which owns the layout fix for the family.
