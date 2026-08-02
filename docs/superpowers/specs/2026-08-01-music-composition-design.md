# Composed music (approved 2026-08-01)

Austin: "I'm probably going to want to orchestrate/compose some concepts or tunes
or whatever for some of these / Perhaps especially music bed."

## Why this exists

The generative bed (PR #64) closed the "no music at all" gap, but its musical
content is *code*: `BASS_HZ`, `DRONE_HZ` and `STEP_SECONDS` are constants inside
`music.ts`, interleaved with the lookahead scheduler. Composing against that means
editing a scheduling module, which is the wrong job for the person writing tunes.

It also sidesteps the licensing bar entirely. `CREDITS.md` forbids AI-generated
audio and unverified-licence samples; music Austin writes himself has no
provenance to verify.

## Approved shape

**Content is JSON, validated at load.** Same machinery as `tank-defs.json` and
`balance.json`: a bad edit is a boot failure naming the exact path, and
`validate.ts`-style negative controls prove the validator itself works. Patterns
diff readably in git and need no tool to edit.

**Composed tracks play where they exist; the generative bed is the fallback.**
Exactly the relationship the synth already has with samples, and for the same
reason: the game is never silent while authoring is half-finished.

## The format

```json
{
  "id": "tension",
  "stepSeconds": 1.5,
  "tracks": [
    { "voice": "bass",  "notes": ["A1","A1","B1","A1","C2","-","G1","-"] },
    { "voice": "drone", "notes": ["A3","-","-","E3","-","-","C4","-"] }
  ]
}
```

- **Note names, not Hz.** `A1`, `C#3`, `Eb2`. Writing 61.74 for a B1 is how the
  current bed reads and it is unreadable to anyone composing. `-` is a rest;
  the previous note is NOT held (a sustain marker can be added later if wanted).
- **`voice`** selects a timbre from a small named set defined in code
  (`bass`, `drone`, `pluck`, …) — the synth stays in TypeScript, only the
  *notes* become data. This keeps the data file about music rather than DSP.
- **Tracks are independent and may differ in length**, so a 4-step bass under a
  7-step drone gives a long non-repeating cycle without authoring one.
- **`stepSeconds`** per track set, not global: tempo is a property of the piece.

## Architecture

- `src/audio/data/music-tracks.json` — the content.
- `src/audio/music-data.ts` — schema validation and note-name → Hz, both pure and
  fully testable headlessly. Note parsing is where an off-by-one octave hides, so
  it gets pinned against known frequencies (A4 = 440, A1 = 55, C4 ≈ 261.63).
- `music.ts` keeps the scheduler and gains a track argument; with no track it
  runs the generated bed exactly as today. The lookahead, stall guard and
  stop-silences-scheduled-notes behaviour are untouched — they are the parts that
  were hard to get right and they are already pinned.

Nothing reaches `src/sim/`: this is presentation, like the rest of `src/audio/`.

## Tooling: `npm run audio`

The visual equivalent already exists (`npm run gallery`); listening has no
counterpart, and iterating on a tune by launching the game is far too slow.

```
npm run audio -- --track tension --seconds 30   # render a composed track
npm run audio -- --sfx explosion                # render one effect
npm run audio -- --sfx all                      # every effect in sequence
```

Renders through a real `OfflineAudioContext` in headless chromium (node has no
Web Audio) and writes a `.wav`. This is a productionised version of the throwaway
script used to produce the first listening samples, and it imports the REAL
modules — a preview that reimplemented the synth would be worthless.

## Testing

- Note parsing pinned against known frequencies, including sharps, flats and
  octave boundaries; junk note names rejected with the path named.
- Validator negative controls: missing `id`, unknown `voice`, non-array `notes`,
  a `stepSeconds` of 0 or negative.
- Track scheduling asserted through the existing fake-context pattern in
  `music.test.ts`: the right note at the right step time, independent track
  lengths advancing separately, and the fallback to the generated bed when no
  track is named.
- The GL harness renders a composed track through `OfflineAudioContext` and
  asserts audible samples, with the existing silence control.

## Explicitly later

Per-context tracks (menu theme, per-level pieces, victory sting) — Austin chose
"composed tracks, bed as fallback" over per-context routing for this pass, so the
selection layer is one track at a time. MIDI import. Sustain/tie markers, velocity
per note, and any form of automation.
