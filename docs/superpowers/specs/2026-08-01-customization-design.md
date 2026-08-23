---
status: completed
date: 2026-08-01
last-reviewed: 2026-08-23
scope: Tank paint shop v1 (curated hull colours) and v2 (procedural skins), render-layer only.
implementation-issues: []
implementation-prs: [59, 61]
supersedes: []
superseded-by: []
---
# Tank customization v1: the paint shop

Approved 2026-08-01. A Customize pane off the main menu: a CURATED palette of hull
colours, applied live to the tank visible behind the menu, persisted like progress and
stats. Render-only -- the sim never knows, so replays, balance and every sim test are
untouched.

## Decisions

- **Curated swatches, never a colour wheel.** brown/grey/teal/olive are enemy
  IDENTITIES; a player painted teal has sabotaged their own readability. Offered:
  blue (default), red, orange, purple, green, white -- all clear of enemy hues.
- **Persistence**: `tanks.custom.v1`, one JSON key, same paranoia as progress/stats
  (unknown or corrupt value reads as the default). `src/game/customization.ts`.
- **Application seam**: the game layer passes the chosen hex into the RENDERER
  (construction option + a live setter); the sim's config colours stay pristine.
  Live repaint reuses the kind-change rebuild machinery in entity views: a colour
  generation counter, bumped by the setter, rebuilds the player's view on the next
  sync -- visible immediately behind the menu.
- **Track shade stays derived** (one good default), no control in v1.
- Reset-to-default is a plain single click: unlike the stats/progress resets it
  destroys nothing a click cannot restore.

## v2: skins (approved 2026-08-01)

Five skins, all procedural, tinted from the CHOSEN hull colour so paint and skin
compose: solid (default, no map), stripes, camo, checker, and flow -- the animated
debut, scrolling slowly. Coverage: hull + turret; tracks stay their solid shade
(grounding, and the least pattern-friendly UVs). Animation speed is a PER-SKIN data
field (user: "we will end up with both [subtle and bold] eventually"), so a fast
variant later is a data entry. Skin ids and labels live in game/customization.ts
beside the palette; texture GENERATION lives in render/skins.ts (it needs THREE).
Stored beside the hull colour in tanks.custom.v1.

## Later (noted with the user, not in this pass)
- **Animations**: idle turret sway, spawn drop-in, victory spin -- render-layer,
  driven from the existing per-frame sync. v3.
- **Emotes** (user, 2026-08-01: "emotes could even be a thing lol"): popup
  billboards over the turret -- the mine-timer label machinery (canvas sprite,
  billboarded) is exactly the rendering path. Wants a keybind + a small set.
- **Loadouts** (gameplay customization): parked until the level set settles; it is a
  balance feature and wants pacifist-suite treatment per loadout.
