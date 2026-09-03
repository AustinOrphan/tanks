# Blocked-fire comparison arms (issue #516)

Evidence for the seventeen `?dev=1&blockedFire=<name>` values. Nothing here is adopted;
the decision is #356's.

## Audio — listen to these

Rendered offline through the real synth by `npm run audio -- --arms <cue|all>`, which
reads the same voice table the game plays from, so a clip cannot drift from what a match
sounds like. Gains are scaled the way `engine.ts` scales them rather than replaced, so the
quiet arms are quiet here by the same ratio: `thunk-soft` peaks at 0.304 of `clunk`,
matching its 0.3 multiplier.

| File | Cue | What it is |
| --- | --- | --- |
| `audio-all-arms.wav` | all five, in order | baseline, click, clunk, thunk-soft, pitch-empty, 0.9 s apart. `haptic-audio` and `ring-audio` are absent because they play the baseline voice, so rendering them would repeat the same sound |
| `blocked-audio.wav` | `audio` | the shipped refusal cue, the baseline to beat |
| `blocked-click.wav` | `click` | 12 ms of high-passed noise, no oscillator |
| `blocked-clunk.wav` | `clunk` | the baseline at half rate: every frequency halved, every duration doubled |
| `blocked-thunk-soft.wav` | `thunk-soft` | that same clunk at 30% gain, testing whether restraint reads as intentional |
| `blocked-pitch-empty.wav` | `pitch-empty` | the cannon at 0.55 rate, so the refusal is the same action failing |

The four haptic arms have no file: vibration cannot be rendered. `haptic-tap` is one
10 ms pulse, `haptic-double` is 10/10/10, `haptic-long` a single 45 ms buzz, and
`haptic-rise` a 6/18/12/18/24 ramp, against the shipped 8/24/8 baseline.

## Visual — read the caveat first

Filmed in the sandbox rig (`?dev=1&level=sandbox&shellCount=1`), where the player spawns
at a fixed cell so every arm is shot from the same camera. The player fires until the
on-screen counter reads `5/5`, then fires once more; that refused shot is what these show,
about 0.4 s before each clip ends.

**These clips under-sell the cues.** At the shipped camera the tank is about 40 px wide,
the arms live 0.07 s to 0.55 s, and 25 fps video compression smears them further. Measured
against the baseline clip, a cue moves 400 to 500 pixels of a 276,000 pixel frame even at
4x zoom. Judge these in a real match, not here; the files exist so the moment can be
stepped through frame by frame.

| File | Cue |
| --- | --- |
| `visual-off.gif` | no cue: the shot simply does not happen |
| `visual-ring.gif` | `ring`, tank-local, 0.18 s |
| `visual-muzzle.gif` | `muzzle`, the shot's own light at the barrel, 0.07 s |
| `visual-turret.gif` | `turret`, recoil stutter in two decaying bumps, 0.16 s |
| `visual-pips.gif` | `pips`, capacity strip on the felt, 0.55 s |
| `visual-hud.gif` | `hud`, transient capacity line under the topbar |
| `visual-*-zoom4x.gif` | the same moment at 4x, nearest-neighbour, for the two subtlest arms |

The controlled proof that the arms are distinct is not these clips: it is the GL harness
check `every #516 visual arm reaches the framebuffer, and none looks like another`, which
renders one fixed world per arm and compares framebuffers.
