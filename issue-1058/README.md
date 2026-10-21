# Issue #1058: the Player colours setting

Settings, then Accessibility, gains a Player colours control that switches between Classic and High
contrast. The choice is stored in `tanks.settings.v1` and read when a match is built.

Captured from the built page of `feat/owner-palette-setting` at `cf582688` in headless Chromium
(Playwright 1.62.0, software GL), 1280x800 unless named, by a throwaway script driving the real
toggle. Two browser profiles were used. The **chosen** profile toggled to High contrast, reloaded,
and then started a four-player Versus match in FFA and in Teams. The **control** profile was fresh,
never opened Settings, and started the same matches.

| file | profile | what it shows |
| --- | --- | --- |
| `settings-high-contrast.png` | seeded | `screen.settings.owner-palette`, the new screens state: the toggle after Quality, reading High contrast |
| `settings-after-reload.png` | chosen | the label still reads "Player colours: High contrast" after a reload |
| `ffa-4p-high-contrast.png` | chosen | FFA, 4 players: chips #63d1fd, #8ffd00, #fdbbc6, #fdfdbb, and rings in the same palette |
| `ffa-4p-classic.png` | control | the same match in Classic: chips #3fd0ff, #ff8a1e, #ff4d2e, #9d3bff |
| `teams-4p-high-contrast.png` | chosen | Teams 2v2: team A #63d1fd, team B #c6fd00 |
| `teams-4p-classic.png` | control | Teams 2v2 in Classic: team A #ff3b3b, team B #fcc0fc |
| `phone-320x568-150pct.png` | chosen | 320x568 at 150% UI scale: the label wraps to two lines, with no sideways scroll |

Chip colours were read from the DOM (`getComputedStyle`), not from pixels. Ring colours in the
stills composite over the felt, so they read lighter than the hex values.
