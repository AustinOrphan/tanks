# Issue #922: `shape` ships as the FFA identity marker

Rendered from a production build (`npm run build`) of commit
`fef0854485c642e9a7b16bcbc38c241636ede6a4` on `feat/ffa-shape-marker-default`, branched from
`main` at `34b43f4a` (after #1008). Each frame is the first of a 2-second, 2 fps window
recorded with the flow recorder (`tools/screens/record.mjs`) once the round is playing and its
countdown has cleared. All four use the same seed and level, so the board and spawns match.

## Files

| File | Session | URL the recorder built |
| --- | --- | --- |
| `ffa-default.png` | FFA, 4 players, no `identityMarker` | `?dev=1&replay=1&level=1&seed=20260918&mode=ffa&players=4&bots=4&autoplay=1` |
| `ffa-solid.png` | the same, with the reversal value | the same `&identityMarker=solid` |
| `teams-default.png` | teams, 4 players, no `identityMarker` (control) | the same with `mode=teams` |
| `coop-default.png` | co-op campaign, 2 players, no `identityMarker` (control) | `?dev=1&replay=1&level=1&seed=20260918&players=2&bots=2&autoplay=1` (`coop-round` flow) |
| `*-strip.png` | the stock strip of the three versus frames, cropped and scaled 3x (nearest neighbour) | |

## What each shows

- `ffa-default`: every ring is that slot's outline (circle, triangle, square, starburst), and
  the strip draws the same mark ahead of each entry. This is the new default.
- `ffa-solid`: the solid rings and the unmarked strip, which is what every FFA match drew
  before this change.
- `teams-default`: solid rings in team colours and lettered strip entries with no mark,
  unchanged by this change.
- `coop-default`: solid rings, unchanged by this change.

## Commands

```sh
npm run build
node tools/screens/record.mjs --flow versus-round --level 1 --seed 20260918 --driver autoplay \
  --seconds 2 --fps 2 --w 1280 --h 800 --dpr 1 --visual host-gpu --stop window --dist dist \
  --timeout 180000 --out <dir> --report <dir>/report.json --mode ffa --players 4 --bots 4 \
  [--flag identityMarker=solid]
# teams: --mode teams; co-op: --flow coop-round --players 2 --bots 2 (no --mode)
```

## Limitations

- Stills only, as the ruling on #234 accepted. Not normal-speed play and not a playtest.
- The versus frames enter by `?dev=1&mode=ffa`, the developer path the flow recorder drives.
  A production page that starts FFA from the Versus Setup pane is asserted through the real
  wiring in `loop.test.ts`, not captured here.
- Host GPU (Apple M1 Max, ANGLE Metal), headless Chromium, no physical display or device.
- The frames are decoded from the compositor's JPEG screencast, so edges carry JPEG artefacts.
