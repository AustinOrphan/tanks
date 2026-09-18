# Issue #773: the role cue as a runtime developer arm

Everything here was rendered from a build of commit `4213fad67e98b27c1c7b694468f7ce85b99788b0`, stamped with it. The arm is
`?dev=1&enemyRole=both`: the muzzle flare for weapon class and the raised deck block for mine
load, the pair #678's comparison found clearest and the owner approved on 2026-09-15.

**This is scripted play and still frames. It is not a playtest, and no physical device was
used.** #357 owns the adopt, revise or reject ruling.

## In real play, level 4 (arena-04), seed 1, the scripted player

Level 4 is the first campaign board carrying every kind the arm describes: green, grey, brown,
two teal and olive. All four frames are the same tick of the same seeded round, so the only
difference between them is what was asked for.

| File | Asked for |
| --- | --- |
| `play-shipped.png` | nothing: the shipped board |
| `play-armed.png` | `enemyRole=both` |
| `play-armed-with-identity-marker.png` | `enemyRole=both&identityMarker=roof` |
| `play-armed-with-pp1roles.png` | `enemyRole=both&pp1Roles=1` |

`play-distance-magnified.png` is the same 300x200 region of the shipped frame above the armed
one, at 3x nearest-neighbour, so the cue can be judged at the size it actually occupies.

**At normal gameplay distance the cue is small.** A tank is roughly 40 to 89 px across at the
shipped camera, and the flare and block are a fraction of that. Whether that is enough is the
judgement #357 has to make; the magnification is there so the judgement is about the cue and
not about screen resolution.

**The identity marker frame is the one to look at for interference.** The roof marker (#630,
#234) and the role cue occupy different surfaces by design: the marker is on the turret crown,
the cue is the muzzle and the deck. The frame shows them together on the same board.

**The pp1Roles frame matters because the arm changes the thing the cue reports.** Under
`?dev=1&pp1Roles=1` Brown, Teal and Green carry `mineCap: 0` while their roster entries still
read 2. The cue is keyed on the tank's own budget, so those decks are clean in that frame --
a cue keyed on the kind would have drawn a mine block on a tank that cannot lay one.

## Non-colour readability

`roster-compare.png` and `roster-compare-greyscale.png` pose all six kinds at the shipped game
camera, shipped above armed, at 2.4x. The greyscale pair is the readability test the cue
exists for: with hue removed the shipped roster is six near-identical silhouettes, and the
armed roster separates by muzzle size and deck block.

The ceiling is unchanged and is stated in `src/presentation/enemy-role.ts`: a still frame can
carry at most four groups, because brown and grey, and teal and green, differ only in
temporal properties. This cue does not close those two pairs and does not claim to.

## A small screen

`small-screen-844x390.png` is the same round at 844x390, a phone in landscape, at device pixel
ratio 1. Not a physical phone: a viewport of that size on a desktop GPU.

## Reduced motion and sound

The cue is static geometry on the tank. It has no animation to reduce and no sound, so a
reduced-motion or muted session renders it exactly as above. That is a property of what the
cue is, not a measurement, and it is stated rather than shown.
