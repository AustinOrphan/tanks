# Credits

## Audio

**No third-party audio assets are currently committed to this repository.**
`public/audio/` contains only a `.gitkeep` placeholder — there are no `.wav`
files checked in yet.

Because no assets exist, the manifest (`src/audio/manifest.ts`) declares none, and
the engine asks for nothing. It used to declare all ten anyway and let every request
404 — measured against the deployed site, that cost 10 round trips and 93,790 bytes
per load, uncached, to rediscover each time that the files were still missing.

What the game plays is unchanged by that, because the synthesised path was already
the live one; the difference between effects and music still matters:

- **Sound effects are SYNTHESISED.** `play(key)` finds no Howl — now because none
  was ever requested, previously because its load had failed — and builds the
  sound in `src/audio/synth.ts`: filtered noise bursts, pitched bodies with
  falling envelopes, and short transients, layered per key. This is the live
  path for every effect in the game today. (`engine.ts`'s one-oscillator `beep`
  remains below it as a floor for any context that cannot support the graph.)
- **Music is GENERATED.** `music` is `null` because the manifest declares no loop
  (previously, because its `loaderror` had fired), so `startMusic()` falls through
  to `src/audio/music.ts`: a slow seeded bass pulse
  under a sparse drone, scheduled on the audio clock. Until that existed, music
  was the one thing with no fallback of any kind and the game was simply silent.

Both are authored as code, which is a deliberate consequence of the policy
below: nothing to licence, nothing to verify, and no AI-generated audio.

## Licensing policy for future audio assets

When real audio assets are sourced and committed, they must be dropped into
`public/audio/` and re-declared in `AUDIO_MANIFEST` — `AUTHORED_LAYOUT` in the same
file already spells out the expected filenames, and assigning it to `AUDIO_MANIFEST`
is the whole of the switch. They must be:

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

## Typefaces

IBM Plex Sans and IBM Plex Mono are the HUD's typefaces. Inter and Atkinson Hyperlegible ship
in the build too, but a page loads them only under the developer arms `?dev=1&hudFont=inter`
and `?dev=1&hudFont=atkinson`. The copyright line of each:

- **IBM Plex Sans:** Copyright 2019 IBM Corp. All rights reserved.
- **IBM Plex Mono:** Copyright 2017 IBM Corp. All rights reserved.
- **Atkinson Hyperlegible:** Copyright 2020 Braille Institute of America, Inc.
- **Inter:** Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

All four are released under the SIL Open Font License 1.1. Each license text is kept in full
beside the font files in `src/game/fonts/` (`OFL.txt`, `OFL-ibm-plex-mono.txt`,
`OFL-atkinson-hyperlegible.txt` and `OFL-inter.txt`) and reproduced in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
