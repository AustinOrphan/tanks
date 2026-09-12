# Issue #651 — the renderer's own animations answer to the resolved motion policy

Captured with `npm run gallery`, using the `--motion reduced` flag this change adds: the
gallery builds `createEntityViews`/`createParticleSystem` directly rather than through
`renderer.ts`, so it could not photograph the preference at all before.

## The three treatments, side by side

| Clip | Command | What changes |
| --- | --- | --- |
| `mine-fuse-full.gif` / `mine-fuse-reduced-squared.gif` | `--elements fuse --view close --anim` | An accelerating strobe becomes a monotone brightening. |
| `kill-particles-full.gif` / `kill-particles-reduced.gif` | `--scene destroyed --anim` | The burst still appears and fades; the debris stops flying and falling. |
| `respawn-spawn-full.gif` / `respawn-spawn-reduced.gif` | `--scene respawn --anim` | The tank fades in without swelling; the invincibility ring holds instead of pulsing. |

**Every pair runs the same length.** Frame counts are identical within each pair — 180,
549 and 270 — which is the "keeps the fade and the lifetime, drops the movement" rule made
visible: a calmed effect is not a shorter effect.

| pair | frames | full | reduced |
| --- | --- | --- | --- |
| kill | 180 = 180 | 909 KB | 365 KB |
| respawn | 549 = 549 | 296 KB | 129 KB |
| mine fuse | 270 = 270 | 333 KB | 348 KB |

The file sizes are a by-product of GIF inter-frame compression, not a perceptual measure —
but they say plainly that far less moves between frames in the two clips whose treatment is
about movement. The mine fuse is the exception and should be: nothing stopped moving there,
the movement changed shape, so there is no compression win to have.

## The brightness ramp is nonlinear, and that is measured

The first version of the fuse ramp was linear in fuse progress, and two measurements say
that was wrong. The parameter is a lerp between two reds that the renderer then tone-maps,
and that whole transfer is compressive, so a linear parameter does not read as a linear
brightening.

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

`ramp-linear-a<n>.png` and `ramp-squared-a<n>.png` are the frames those two columns were
decoded from, at ages 0/15/30/45/60/75 out of 90.

## A pose that proves nothing, recorded so it is not repeated

`--elements mine` places `timer: MINE_TIMER` — a *fresh* mine, independent of `--age` — so
every frame of it is identical under either policy, and so is `--mineWarn lance` against it.
Two byte-identical captures there are evidence about the pose, not about the flag. `fuse` is
the element with a burning fuse in it.

`fuse-a30-*.png`, `fuse-a60-*.png` and `fuse-a88-reduced.png` are from the first round and
show the full-motion strobe passing through the same brightness at two different fuse points
(a30-full and a60-full are byte-identical).
