# Issue #865 — the HUD's typeface arms

`?dev=1&hudFont=atkinson` and `=inter`, against the shipped IBM Plex. Captured from a real
build at 1280×800 dpr 2, top 420 CSS px of the viewport, past the splash, zero page errors in
every arm.

| file | flag | `--hud-font` resolves to |
| --- | --- | --- |
| `shipped.png` | *(absent)* | IBM Plex Sans |
| `atkinson.png` | `hudFont=atkinson` | Atkinson Hyperlegible |
| `inter.png` | `hudFont=inter` | Inter |
| `bogus.png` | `hudFont=comic` | IBM Plex Sans — an unrecognised value rejects to null |

## The load criterion, verified in a browser rather than assumed

The issue asks whether a declared-but-unselected `@font-face` is downloaded, "because it
decides whether every player pays for faces they never see". Every `.woff2` request was
recorded, one fresh browser context per arm so nothing cached by an earlier arm could hide a
request:

| arm | woff2 actually requested | alternates fetched |
| --- | --- | --- |
| shipped | `ibm-plex-sans-latin-wght-normal` | **no** |
| atkinson | `atkinson-hyperlegible-latin-400`, `-700` | yes, and only its own |
| inter | `inter-latin-wght-normal` | yes, and only its own |
| bogus | `ibm-plex-sans-latin-wght-normal` | **no** |

So a shipped page downloads neither alternate. Each arm fetches its own face and not the
other's.

## Two things the captures show that a table cannot

**`bogus.png` is byte-identical to `shipped.png`** — same SHA-256, not merely similar. An
unrecognised flag value is not "close to" the shipped path; it *is* the shipped path, which is
what reject-to-null parsing is supposed to mean.

**`--hud-font-mono` reads `IBM Plex Mono` in all four arms.** Neither alternate ships a
monospace companion, so only the sans moves — which also leaves every mono readout (timers,
stock counts, the diagnostics pane) as a fixed reference when two arms are compared.

## What to look for when ruling on a face

Atkinson Hyperlegible ships **400 and 700 only**; the HUD asks for 100–700, so 100–300 and
500–600 are synthesised by the browser under that arm. Thin HUD text reading oddly there is the
face's own coverage, not a defect in the HUD. Inter and Plex are both variable and cover the
range.
