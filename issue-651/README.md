# Issue #651 — the renderer's own animations answer to the resolved motion policy

Captured with `npm run gallery`, using the `--motion reduced` flag this change adds: the
gallery builds `createEntityViews`/`createParticleSystem` directly rather than through
`renderer.ts`, so it could not photograph the preference at all before.

## The three treatments, side by side

| Clip | Command | What changes |
| --- | --- | --- |
| `mine-fuse-full.gif` / `mine-fuse-reduced-squared.gif` | `--elements fuse --view close --anim` | An accelerating strobe becomes a monotone brightening. |
| `kill-particles-full.gif` / `kill-particles-reduced-one.gif` | `--scene destroyed --anim` | ONE particle appears and fades in place; the debris stops flying and falling. |
| `respawn-spawn-full.gif` / `respawn-spawn-reduced-one.gif` | `--scene respawn --anim` | The tank fades in without swelling; the invincibility ring holds instead of pulsing. This clip opens with a KILL, so it also carries the one-particle burst. |

**Every pair runs the same length.** Frame counts are identical within each pair — 180,
549 and 270 — which is the "keeps the fade and the lifetime, drops the movement" rule made
visible: a calmed effect is not a shorter effect.

| pair | frames | full | reduced |
| --- | --- | --- | --- |
| kill | 180 = 180 | 909 KB | 364 KB |
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

`fuse-a30-full.png` and `fuse-a60-full.png` are from the first round and are byte-identical
to each other -- the full-motion strobe passing through the same brightness at two different
fuse points, which is why one frame of it cannot say how far along the fuse is. The matching
REDUCED stills from that round were deleted rather than kept: they were captured against the
linear ramp and superseded by `ramp-squared-a*.png`, and a superseded frame sitting beside a
current one is read as current.

## Every asset here is current, and that was checked rather than assumed

Every change in this PR is gated on the reduced-motion flag, so full-motion captures should
be stable across all of them. Verified: re-running `--scene destroyed --anim` at the final
commit reproduces `kill-particles-full.gif` BYTE-IDENTICALLY
(`c130f555f62857e3854604040d5fb63c8d0432c73a34c5dccf616e809783a1cf`), several code changes
after it was taken.

The reduced captures were re-taken whenever the treatment under them moved:

| asset | captured against |
| --- | --- |
| `mine-fuse-reduced-squared.gif`, `ramp-squared-a*.png` | the squared ramp (posed gallery -- no particle system, so the particle change cannot touch it) |
| `kill-particles-reduced-one.gif`, `kill-reduced-one-f70.png` | the one-particle burst |
| `respawn-spawn-reduced-one.gif` | the one-particle burst -- this one was RE-TAKEN, because the first capture predated it and the clip opens with a kill |
| `ramp-linear-a*.png`, `kill-reduced-stack-f70.png` | deliberately the superseded state, as the left column of an A/B |

## The reduced burst was a white FLASH, and that is why it draws one particle

The material is additively blended (`THREE.AdditiveBlending`, `particles.ts`). N particles at
the same point and opacity 1 sum past every channel and clip, so a 24-particle burst held in
place is not a dimmer explosion -- it is white.

Measured on the kill moment, decoding frames out of `--scene destroyed --anim`. "Orange" is
`R>150, R-B>60, G<200`; "near-white" is all three channels above 200. The scene's
pre-explosion orange baseline is 5180 px.

| frame | full motion | reduced, 24 coincident | reduced, one particle |
| --- | --- | --- | --- |
| 54 | white 305, orange 260 | white 193, orange 230 | **white 0**, orange 429 |
| 60 | white 470, orange 7316 | white 182, orange 5180 | **white 0**, orange 5372 |
| 70 | white 648, orange 11645 | white 165, orange 5180 | **white 0**, orange 5345 |
| 90 | white 272, orange 18689 | white 134, orange 5180 | **white 0**, orange 5304 |

The 24-stack column sits flat at the baseline for orange and carries a white core that fades.
The one-particle column has no near-white pixel at all and pushes orange slightly ABOVE the
baseline -- the burst is contributing its own colour instead of a saturated flash.

`kill-full-f70.png`, `kill-reduced-stack-f70.png` and `kill-reduced-one-f70.png` are frame 70
from each, the row where the difference is clearest.

**One and not zero.** An event carried by audio and haptics alone is what the accessibility
direction rules out, and `ricochet` has no second visual cue -- no ring, no disappearing wall,
nothing but these particles. A kill would survive on the death-pulse ring and a destroyed
wall on its own disappearance; a ricochet would simply stop existing.
