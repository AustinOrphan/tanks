# Issue #924 / PR — the life-loss cue was hue alone under reduced motion

`#327`'s third criterion says no state may depend on colour alone. Under reduced motion the
life-loss cue did: the full-screen vignette is cancelled outright, the `scale(1.5)` is removed,
and what was left was a hue change on one digit.

`hud.css` conceded this in a comment for as long as the rule existed, and named the combination
that makes it worst: `.hud-lives` is **not** opted out of the `forced-colors` block, so reduced
motion *plus* forced colours left no cue at all. Two accessibility settings combining to remove
a signal is worse than either alone.

## Greyscale is the proof

| | reduced motion | reduced motion, greyscale |
| --- | --- | --- |
| before | `lives-before.png` | **`lives-before-grey.png`** |
| after | `lives-after.png` | **`lives-after-grey.png`** |

In `lives-before-grey.png` the "life lost" digit is **indistinguishable** from the one at rest —
that is the whole defect, in one frame. In `lives-after-grey.png` the ring is plainly visible.

Measured on the frozen cue, from `getComputedStyle` on the real element:

| | before | after |
| --- | --- | --- |
| `animation-name` | `hud-lives-pulse--still` | `hud-lives-pulse--still` |
| `outline-style` | `none` | **`solid`** |
| `outline-width` | — (nothing drawn) | **`2px`** |
| `outline-color` | — | `rgb(255, 106, 106)` (`currentColor`) |

## Why an outline

- **`font-weight` reflows.** The counter is `display: inline-block`, so a heavier digit is a
  wider one and neighbours shift — movement, reintroduced by the fix for movement.
- **`opacity` blinks.** A flashing cue is the wrong answer to a reduced-motion preference and a
  worse one to photosensitivity.
- **An outline is drawn outside the box**, so nothing moves; it is presence rather than hue, so
  greyscale keeps it; and `currentColor` is repainted by the system under forced colours rather
  than dropped, so that combination keeps it too.

## How these were captured

Each frame is the **shipped stylesheet** on the real `.hud` root, with `.hud--reduced-motion`
applied and the `--still` animation frozen at its 50% step (`animation-play-state: paused` with
a negative delay). Greyscale is a `filter: grayscale(1)` over the strip. The "before" pair was
captured from a production build with the fix reverted.
