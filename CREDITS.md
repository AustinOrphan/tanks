# Audio Credits

**No third-party audio assets are currently committed to this repository.**
`public/audio/` contains only a `.gitkeep` placeholder — there are no `.wav`
files checked in yet.

Because no assets exist, the audio engine (`src/audio/engine.ts`) degrades
gracefully for every manifest key: it attempts to load each asset via
Howler, and on load failure (which, today, is all of them) it falls back to
a procedurally-generated Web Audio tone instead. This fallback is the
**live path the game currently uses**, not a rare edge case — every sound
you hear today is a procedural tone, not a sample.

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
