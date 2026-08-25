---
title: Privacy Policy
---

# Privacy Policy

Last updated: 2026-08-25

This policy covers the **Tanks!** browser game (the "game" or "app"), published at
`austinorphan.com/tanks/`.

## Summary

The game collects **no data**. Nothing leaves your device.

## Data the game collects

**Nothing.** The game does not send any data over the network &mdash; no analytics,
no telemetry, no API calls. All game data stays on your device.

## Data the game stores

The game saves your progress and settings to your device using the browser's
localStorage. If persistent storage is unavailable, the game stores data in
an in-memory backup that expires when the page is closed.

The stored data is organized into the following keys:

| Key | Contents |
|---|---|
| `tanks.progress.v1` | Highest level cleared in the campaign |
| `tanks.stats.v1` | Lifetime and per-attempt game statistics |
| `tanks.run.v2` | Active campaign run: current level, remaining lives |
| `tanks.custom.v1` | Chosen tank color and paint customization |
| `tanks.settings.v1` | Player settings: sound mute and volume, touch control scheme and fire mode, device vibration and controller rumble preferences, motion/flash preference, interface scale |
| `tanks.achievements.v1` | Earned achievements |

`tanks.settings.v1` replaces an older `tanks.touch.v1` key. The first time you open
this version of the game, any touch control settings saved under the old key are
copied into the new one and the old key is deleted. The game never writes
`tanks.touch.v1` again; it is still accepted when importing a save file exported by
an older version.

The settings key stores your **preferences only**. It never records which
controllers are connected, their identifiers, their slot numbers, or which player is
using which device.

This data is stored entirely in the browser. It never leaves your device and is
not transmitted anywhere.

If your browser cannot save data &mdash; for example in a private window, or with
site storage blocked &mdash; the game still runs, and shows a brief on-screen note
that settings will not be saved for that session.

You can export and import all of the keys above as a single file, and you can reset
your settings back to their defaults. Resetting settings does not affect campaign
progress, statistics, or achievements, and resetting progress does not affect
settings.

The data is scoped to the game's origin: it is accessible only to the origin
that serves the game and is unreachable by other sites.

## Audio and visuals

**Sound is SYNTHESISED.** The game builds audio in real time using the Web Audio API.
No audio files are downloaded from the network.

**Graphics are PROGRAMMED.** All visuals are generated in real time via the Canvas API.
No external assets (images, models, textures) are downloaded or included.

## Third-party services

The game has no third-party integrations. It does not use:

- Analytics or tracking services
- Advertising networks
- Social media plugins or buttons
- External APIs, servers, or CDNs
- Cookies

The game does use a few browser APIs that may be worth noting:

- **Gamepad API**: Reads connected game controllers for input. This data stays on the
  device.
- **Web Vibrations API**: Provides haptic feedback on supported devices. No data
  leaves the device.

## Children's privacy

The game is designed for all ages. No personal information is collected from any
user, including children. This policy is provided to comply with best practices
and platform requirements (including the Google Play Developer Policy on app
privacy), even though no personal data is collected.

## Changes to this policy

If the game's privacy practices change, this policy will be updated accordingly.

## Contact

For questions about this policy, open an issue on the
[Tanks! GitHub repository](https://github.com/AustinOrphan/tanks/issues).
