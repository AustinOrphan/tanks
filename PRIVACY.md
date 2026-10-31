---
title: Privacy Policy
---

# Privacy Policy

Last updated: 2026-10-31

This policy covers the **Tanks!** browser game (the "game" or "app"), published at
`austinorphan.com/tanks/`.

## Summary

The game collects **no data**. The website that serves it reports page loads to
Cloudflare Web Analytics; see "The website that hosts the game" below.

## Data the game collects

**Nothing.** The game's own code does not send any data over the network &mdash; no
analytics, no telemetry, no API calls. All game data stays on your device.

## Data the game stores

The game saves your progress and settings to your device using the browser's
localStorage. If persistent storage is unavailable, the game stores data in
an in-memory backup that expires when the page is closed.

The stored data is organized into the following keys:

| Key | Contents |
|---|---|
| `tanks.progress.v1` | Highest level cleared in the campaign |
| `tanks.stats.v1` | Lifetime and per-attempt game statistics |
| `tanks.stats.run.v1` | Game statistics for the campaign run in progress |
| `tanks.run.v2` | Active campaign run: current level, remaining lives |
| `tanks.custom.v1` | Chosen tank color and paint customization |
| `tanks.settings.v1` | Player settings: sound mute and volume, touch control scheme and fire mode, device vibration and controller rumble preferences, controller layout (stick preset and rebound buttons, per controller type), motion/flash preference, interface scale, render quality preset, player color palette |
| `tanks.achievements.v1` | Earned achievements |
| `tanks.versus.v1` | Versus match setup: mode, player count, lives, friendly fire, arena, and which player slots are people or computer players (never which controller anyone uses) |

`tanks.settings.v1` replaces an older `tanks.touch.v1` key. The first time you open
this version of the game, any touch control settings saved under the old key are
copied into the new one and the old key is deleted. The game never writes
`tanks.touch.v1` again; a developer session still accepts it when importing a save file
exported by an older version. An older `tanks.run.v1` key, if present, is deleted unread when the
game starts.

The settings key stores your **preferences only**. It never records which
controllers are connected, their identifiers, their slot numbers, or which player is
using which device.

This data is stored entirely in the browser. It never leaves your device and is
not transmitted anywhere.

If your browser cannot save data &mdash; for example in a private window, or with
site storage blocked &mdash; the game still runs, and shows a brief on-screen note
that settings will not be saved for that session.

In Settings, under Data, **Reset stats** sets your lifetime statistics and those of the
campaign run in progress back to zero, and **Reset progress** clears your campaign
progress (the levels unlocked in Level Select) and your earned achievements. Neither
changes your settings or your tank customization. To remove everything the game has
stored, clear this site's data in your browser's settings.

Developer sessions, opened with `?dev=1`, keep their data under separate keys that
start with `tanks.dev.`, unless `prodSave=1` asks for the keys above. With `saveIo=1`
as well, a developer session can export and import all of the keys above except
`tanks.versus.v1` as a single file, from the browser console. That is a development
facility; the game has no button for it.

The data is scoped to the game's origin: it is accessible only to the origin
that serves the game and is unreachable by other sites.

## Audio and visuals

**Sound is synthesized in real time.** The game uses the Web Audio API to generate its
sound effects and music. No audio files are downloaded from the network.

**Graphics are drawn in real time** with WebGL, through the Three.js library. The game
downloads no external images, models or textures; its fonts and icons are served from
the same site as the game.

## The website that hosts the game

The game is served from `austinorphan.com` through Cloudflare. Like any web host,
Cloudflare receives the standard details of every request it serves, such as the IP
address and the browser's user agent.

The site also uses **Cloudflare Web Analytics**. When a browser loads a page, Cloudflare
adds a script (`static.cloudflareinsights.com/beacon.min.js`) that reports the page view
and page-load timing to Cloudflare. The game's own code does not include or call this
script, and blocking it does not affect the game.

According to Cloudflare, Web Analytics does not use cookies or localStorage, does not
fingerprint visitors, and does not track individuals across websites. Those are
Cloudflare's statements about its service, not findings of this project. Cloudflare's
privacy policy governs the data it receives.

## Third-party services

The game's own code has no third-party integrations. It does not use:

- Analytics or tracking services
- Advertising networks
- Social media plugins or buttons
- External APIs, servers, or CDNs
- Cookies

The website that serves the game uses Cloudflare for hosting and Web Analytics, as
described above.

The game does use a few browser APIs that may be worth noting:

- **Gamepad API**: Reads connected game controllers for input. This data stays on the
  device.
- **Web Vibrations API**: Provides haptic feedback on supported devices. No data
  leaves the device.

## Children's privacy

The game is designed for all ages. The game itself collects no personal information
from any user, including children; what the hosting website's Cloudflare services
receive is described above. This policy is published as a matter of good practice,
even though the game itself collects no personal data.

## Changes to this policy

If the game's privacy practices change, this policy will be updated accordingly.

## Contact

For questions about this policy, open an issue on the
[Tanks! GitHub repository](https://github.com/AustinOrphan/tanks).
