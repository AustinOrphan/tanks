# Audio Credits

**No third-party audio assets are currently committed to this repository.**
`public/audio/` contains only a `.gitkeep` placeholder — there are no `.wav`
files checked in yet.

Because no assets exist, the audio engine (`src/audio/engine.ts`) attempts to
load each manifest key via Howler and every one of them fails. What happens
next differs between sound effects and music, and the difference matters:

- **Sound effects fall back.** `play(key)` finds no Howl and calls `beep(key)`,
  a short decaying Web Audio tone (`engine.ts`, the `beep` function). This is
  the live path for every effect in the game today — a procedural tone, not a
  sample.
- **Music does not.** `music` is set to `null` in its `loaderror` handler, and
  `startMusic()` is guarded on `if (music && …)`, so it silently does nothing.
  There is no procedural fallback for the music key. **Today the game plays no
  music at all** — not a synthesised substitute, nothing.

This file previously said every sound you hear is a procedural tone. That is
true of the effects and false of the music.

## Licensing policy for future assets

When real audio assets are sourced and committed, they must be:

- Royalty-free, **CC0 preferred**.
- **No AI-generated audio.**
- **No audio of unclear or unverified licensing.**

Each asset must be recorded in the attribution table below at the time it
is added — including the real source, file, and license. Do not add a row
for a file that has not actually been committed.

## SFX

| Key           | File                     | Source | License |
| ------------- | ------------------------ | ------ | ------- |
|               |                          |        |         |

## Music

| File                  | Source | License |
| --------------------- | ------ | ------- |
|                       |        |         |

_(Tables intentionally empty — no assets have been sourced yet.)_
