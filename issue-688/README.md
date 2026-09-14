# Shell bounce-trail experiment (issue #688)

Captured with `npm run gallery`, branch `feat/shell-bounce-trail-experiment`. It uses Chromium with swiftshader at DPR 1 unless noted. The gallery page builds no audio, so every capture is silent.

## posed-baseline-vs-trail.png

`--elements shelltrail --view game --w 1280 --h 800`, without the flag (top) and with `--shellTrail segments` (bottom), cropped to the subject. The subject has two player tanks, so identity tint applies: slot 1 is cyan and slot 2 is orange.

| row | bounces left | slot 1 shell | slot 2 shell | dashes drawn |
|---|---|---|---|---|
| back | 2 | ricochet | ricochet | 3 |
| middle | 1 | normal | normal | 2 |
| front | 0 | fast (fresh) | normal (bounce spent) | 1 |

- **Shell hue:** the shell hues are the same in both halves. The dashes are one off-white for both owners.
- **Reduced motion:** the same frame with `--motion reduced` is byte-identical to the full-motion one (`cmp` exit 0), because the trail has no motion of its own.

## ricochet-before-after-baseline.png

`--scene ricochet --view game --w 960 --h 600`, cropped. A normal shell fires at tick 10 and ricochets at tick 36.

- **Left:** tick 30 with the flag. One bounce left, 2 dashes.
- **Middle:** tick 42 with the flag. No bounces left, 1 dash. The row is laid behind the new heading, so 6 ticks after the bounce the dash still sits against the wall the shell left, partly hidden by it.
- **Right:** tick 42 without the flag.

The same tick-42 frame with `--motion reduced` still draws the one dash in the same place. It is **not** byte-identical to the full-motion frame (`cmp` exit 1). An ffmpeg difference blend with `bbox=min_val=6` puts every differing pixel in one 6x8 px box at x 405-410, y 265-272, which is the barrel's muzzle, where the moment scene applies the muzzle effect's own reduced-motion treatment. The trail's dash, at about x 625-650, y 300-320, is outside that box.

## ricochet-*-normal-speed.gif

`--scene ricochet --view game --w 640 --h 400 --anim --subdiv 1 --fps 60`, with and without the flag. The flag is the only difference. This is real-time playback: 45 ticks at 60 frames.

## game-desktop-trail-full.png and game-desktop-trail-crop2x.png

`--scene game --w 1280 --h 800 --query 'dev=1&seed=42&invincible=1&shellTrail=segments' --burst 40`: a live campaign match at the game's own camera.

- **The flags.** `invincible=1` is there only because the idle capture player otherwise dies. The first burst, without it, showed the Game Over panel from its fourth frame onward.
- **full:** frame 3 of 40, unscaled.
- **crop2x:** the same frame cropped to 340x280 at (620, 340), then scaled 2x with nearest-neighbour so no dash is invented by filtering.

## game-desktop-baseline-full.png

The same command without `shellTrail`. A separate run with the same seed, so the fight progresses similarly but is not the identical frame.

## overlap-shellring-baseline-trail-top.png

`--elements shellring --w 960 --h 600`: 8 normal shells (one bounce left, 2 dashes each) on a 0.9-unit ring, flying outward, so every row points at the centre.

- **Panels:** baseline and trail at `--view game`, cropped 520x360 at (220, 120); then the trail at `--view top`, cropped 520x480 at (220, 60) and scaled to 360 px tall.
- **Where it breaks:** the inner dashes of neighbouring rows overlap and form an asterisk, where no single row's count can be read.

## game-phone-trail-full.png and game-phone-trail-board.png

`--scene game --w 390 --h 844 --dpr 2 --query 'dev=1&seed=42&invincible=1&shellTrail=segments' --burst 40`: a separate run with the same seed and flags, at a portrait phone size. A live match's frame pacing differs between runs, so this is not the same moment as the desktop frame.

- **full:** frame 3 of 40, saved by the capture at 860x1768 device px.
- **board:** a crop of that frame, 780x500 at (0, 550), not rescaled, so it shows device pixels at DPR 2.
- **What it shows:** at this size a shell body is about 20 device px (about 10 CSS px) and each dash a few CSS px. Two shells flying side by side, right of centre, run their rows into one continuous dotted line.
