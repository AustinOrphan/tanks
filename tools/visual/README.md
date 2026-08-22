# Visual verification

Measures what the game actually paints, in a real browser, and fails on the two
classes of defect that have actually shipped here.

```
npm run visual                                    # check dist/ + report/screenshots
npm run visual -- --label after --out visual-out/after
npm run verify:visual                             # build + portability + browser checks
```

Playwright is **not** a dependency of this repo — the package downloads browsers
on install, while only the separate CI `visual` job needs it. That job installs the
version pinned in `.github/workflows/ci.yml` with `--no-save` and caches Chromium.
Local resolution order is `$PLAYWRIGHT_MODULE`, then a `playwright` in `node_modules`,
then a known local install. Match CI's pinned version and install its Chromium browser
before running `npm run verify:visual` locally.

## Why it does not read the canvas directly

The obvious approach does not work, and failed silently for a whole session. An
earlier harness read the canvas with `drawImage()` into a 2D canvas and
`getImageData`. **A WebGL canvas without `preserveDrawingBuffer` reads back all
black that way.** That harness reported "the canvas paints 100% black" while the
screenshots it saved alongside showed the game rendering correctly. Every number
it printed was false.

This reads Playwright's screenshot — the compositor's output, which is what a
player actually sees — and decodes it by handing the PNG back into the page as
an `<img>`, which is same-origin and safe to read. No `preserveDrawingBuffer`,
no PNG library.

## The checks, and why each threshold is where it is

Every threshold sits between a **measured** good value and a **measured** bad
value, taken from the builds either side of the camera-fit fix (`8430e06`). None
is guessed.

| Check | Basis |
|---|---|
| canvas has a live GL context | the failure the old harness *thought* it saw |
| page raised no errors | — |
| something is actually painted | old harness said 0%; real range is 22–52% |
| the frame is not a flat fill | 299–367 distinct colours measured |
| board fills the viewport | per-viewport, see below |
| no detached felt below the board | bottom-strip mean rgb, see below |

**Board width** is per-viewport because the fit binds on a different axis as the
viewport changes shape, and one global threshold does not hold:

| viewport | before | after | floor |
|---|---|---|---|
| 1280x800 | 79.1% | 93.1% | 86% |
| 1920x1080 | 71.3% | 83.8% | 78% |
| 1560x520 | 42.2% | 49.6% | 46% |
| 390x844 phone | 100.0% | 95.4% | **none** |

The phone viewport is deliberately absent: it measures *higher* before the fix
than after, so it does not separate the two and any threshold there would be
decoration.

**Detached felt** is detected by colour, after two structural approaches failed:

- *Row occupancy* cannot see it. The platform's near edge slopes, so its rows
  overlap the sliver's and the two read as one continuous run — measured
  `[[180,729]]` before and `[[158,775]]` after, a single run in both.
- *Row width* cannot see it either. With a tilted camera the platform's near
  edge is its **widest** part, so there is no taper for the sliver to re-widen
  from — this reads ~100% with or without the defect.

What does separate them is that the sliver puts green felt below the lowest grey
platform pixel. Measured mean colour of the board's bottom rows: **(21,42,33)**
with the sliver, **(30,33,38)** without, consistent across all four viewports.

## Validation

The gate is proved in both directions, which is the only thing that makes it
worth having:

```
dist-after (fixed)   exit 0, all checks passed
current main         exit 0, all checks passed
dist-before (broken) exit 1, 7 checks FAILED
```

The 7 failures on the broken build are exactly the two defects that shipped:
board width at 3 viewports, detached felt at 4.

## What it does not do

- It does not add Playwright to ordinary installs or run inside either Node matrix job;
  CI isolates the dependency and browser download in the required `visual` job.
- It only looks at the **title screen**. Nothing here exercises a running game,
  particles, or the win/lose panels.
- Thresholds are calibrated against **one** defect pair. A different visual
  regression may well slip through all six checks.
- Rendering is swiftshader, not a real GPU. Colours and antialiasing may differ
  from what a player on hardware sees.
