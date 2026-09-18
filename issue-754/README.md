# Issue #754, PR 2: the Controller Layout pane

Captured with `npm run screens` from the built output of branch `feat/controller-layout-settings` at
`4c76175`. Viewport 1280x800 CSS px at devicePixelRatio 2 (2560x1600 PNGs), reduced motion, the
`mixed` fake-gamepad fixture: one `mapping: 'standard'` pad and one unmapped pad.

| File | State | What it shows |
| --- | --- | --- |
| `controller-layout.png` | `screen.settings.controller-layout` | The pane over the standard pad: profile name, Sticks preset, the five action rows naming the button each reads, Reset to Recommended (disabled: nothing stored), Back. |
| `settings.png` | `screen.settings` | Settings with the new Controller Layout entry beside Controllers in the Controls section. |

## Measured (CSS px, from the capture report)

- `#hud-layout-title` at y = 35: the pane's first child is on screen, not above the scroll origin.
- `.hud-layout-preset` 171x44; `.hud-layout-reset` 180x44.
- `.hud-layout-bindings` 172x252: five 44px rows and four 8px gaps (5x44 + 4x8 = 252).
- The empty-state explanation is hidden (`waitHidden: '.hud-layout-empty'` passed), so the pane
  read the standard pad rather than showing its no-controller text.

## Notes

- The first capture of this pane (at `1fa9c1a`) drew each action row as wide as its own label.
  The rows now share one width, the widest row's; `controller-layout.png` is the capture after that.
- Rumble reads refused in `settings.png` because the fake pads report no rumble actuator. That is
  #227's existing behaviour, unchanged here.
- Not captured: a capture in progress, a swap message, or Southpaw. Those states are driven by a
  live controller press; they are covered by the unit and route tests rather than by a still.

# Issue #754, PR 3: the settings key's privacy sentence

Captured with `npm run screens` from the built output of branch `feat/controller-layout-presets` at
`9625bcae`. Viewport 1280x2400 CSS px at devicePixelRatio 1, so the whole privacy table is in frame.
3 of 3 measured elements visible, 0 page errors.

| File | State | What it shows |
| --- | --- | --- |
| `legal-privacy.png` | `screen.about.document` | The Legal pane with the privacy policy open. The `tanks.settings.v1` row now names the controller layout (stick preset and rebound buttons, per controller type) and the render quality preset; the longer sentence wraps to three lines inside its cell and the table keeps its shape. |
