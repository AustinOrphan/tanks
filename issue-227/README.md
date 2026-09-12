# Issue #227 — show control settings and prompts only when relevant

Captured with `npm run screens -- --state screen.settings` against the built page, 1280x800
@2, on the capture machine's own capabilities (headless Chromium on Linux: no touchscreen,
`navigator.vibrate` present, no gamepad). Nothing is faked — the difference between the two
pictures is the change, read through the same capability source production uses.

| File | What it shows |
| --- | --- |
| `settings-before.png` | `origin/main`. **Aim: Stick** and **Fire: Tap to fire** offered on a machine with no touchscreen — the defect the issue names. Controller rumble has no control at all, on any device. |
| `settings-after.png` | The two touch controls are gone. **Rumble: On** appears, refused, with the sentence naming what would make it work. Haptics stays because this browser does have `navigator.vibrate`. |

The device combinations that cannot be captured on one machine — phone touch, a connected
rumble pad, a TV controller's prompts — are covered by the matrix in
`src/game/control-relevance.test.ts`, which takes capabilities and a modality as plain
objects and never reads a user-agent string.
