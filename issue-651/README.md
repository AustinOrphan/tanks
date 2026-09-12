# Issue #651 — the renderer's own animations answer to the motion policy

Captured with `npm run gallery -- --elements fuse --view close`, over the `fuse` element
("a mine burning its whole fuse, for watching the pulse rate climb"). `--motion reduced` is
the flag this change adds: the gallery builds `createEntityViews`/`createParticleSystem`
directly rather than through `renderer.ts`, so it could not photograph the preference at all
before.

| File | What it shows |
| --- | --- |
| `fuse-full.gif` | The shipped strobe over the whole fuse: an accelerating blink, 1.67 Hz mean, peaking at 3.333 Hz where the warning window takes over. |
| `fuse-reduced.gif` | The same fuse as a monotone brightening. No blink; the body gets hotter as expiry approaches. |

## The measurement that makes the case

Single frames at three points in the fuse, by SHA-256:

| age | full motion | reduced |
| --- | --- | --- |
| 30 | `e171294b…` | `0c9525c8…` |
| 60 | **`e171294b…`** | `f8bcf113…` |
| 88 | `4ece859e…` | `896b8b45…` |

**At full motion, age 30 and age 60 are byte-identical** — the strobe passes through the
same brightness twice, so a single frame cannot say how far along the fuse is. A player has
to watch the RATE over time to read it. Under reduced motion all three differ, and they
differ monotonically: the same information, readable from one frame, which is what a
reduced-motion preference is asking for.

Armed-versus-idle is untouched either way — it lives in the base colours, not in the pulse.

## A pose that proves nothing, recorded so it is not repeated

`--elements mine` places `timer: MINE_TIMER` — a *fresh* mine, independent of `--age` — so
every frame of it is identical under either policy, and so is `--mineWarn lance` against it.
Two byte-identical captures there are evidence about the pose, not about the flag. `fuse` is
the element with a burning fuse in it.

## The brightness ramp is nonlinear, and that is measured

`fuse-reduced.gif` is the SQUARED, capped ramp. The first version was linear in fuse
progress, and two measurements say that was wrong. The parameter is a lerp between two reds
that the renderer then tone-maps, and that whole transfer is compressive, so a linear
parameter does not read as a linear brightening.

Captured through `--elements fuse --view close --age <n> --motion reduced`, brightest mine
pixel decoded from the PNG, CIE L* over Rec.709 luminance:

| fuse progress | linear L* | ΔL* | squared+capped L* | ΔL* |
| --- | --- | --- | --- | --- |
| 0.00 | 30.2 | — | 30.2 | — |
| 0.17 | 38.6 | +8.4 | 31.9 | +1.7 |
| 0.33 | 44.4 | +5.8 | 34.8 | +2.9 |
| 0.50 | 49.2 | +4.8 | 39.0 | +4.2 |
| 0.67 | 53.6 | +4.4 | 43.7 | +4.7 |
| 0.83 (window opens) | 57.3 | +3.7 | 49.2 | +5.5 |
| 1.00 (expiry) | ~60 | ~+2.7 | 56.2 | **+7.0** |

Linear DECELERATES -- the biggest jump is the first sixth of the fuse and the smallest is
the last -- which is backwards for something counting down. It also spends about 90% of the
available perceptual range before the fuse-warning window opens, leaving that cue roughly
two just-noticeable differences.

Squared accelerates, and the warning window's own step becomes the largest in the whole
fuse. The ramp stops at 0.5, the mean of the strobe it replaces, and the window ramps from
there exactly as it always did.

**The cost, stated:** the first sixth is +1.7 L*, about one JND, where linear gave +8.4. The
very start of the fuse is less distinguishable than before. That is the trade -- early
progress for a legible imminent-detonation cue.

`ramp-linear-a*.png` and `ramp-squared-a*.png` are the frames those two columns were decoded
from.
