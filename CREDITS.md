# Audio Credits

**No third-party audio assets are currently committed to this repository.**
`public/audio/` contains only a `.gitkeep` placeholder — there are no `.wav`
files checked in yet.

Because no assets exist, the audio engine (`src/audio/engine.ts`) attempts to
load each manifest key via Howler and every one of them fails. What happens
next differs between sound effects and music, and the difference matters:

- **Sound effects are SYNTHESISED.** `play(key)` finds no Howl and builds the
  sound in `src/audio/synth.ts`: filtered noise bursts, pitched bodies with
  falling envelopes, and short transients, layered per key. This is the live
  path for every effect in the game today. (`engine.ts`'s one-oscillator `beep`
  remains below it as a floor for any context that cannot support the graph.)
- **Music is GENERATED.** `music` is still `null` after its `loaderror`, so
  `startMusic()` falls through to `src/audio/music.ts`: a slow seeded bass pulse
  under a sparse drone, scheduled on the audio clock. Until that existed, music
  was the one thing with no fallback of any kind and the game was simply silent.

Both are authored as code, which is a deliberate consequence of the policy
below: nothing to licence, nothing to verify, and no AI-generated audio.

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
