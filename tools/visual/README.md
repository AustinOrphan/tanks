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

## Topbar clearance (issue #687)

A second pass, after the board checks, asks a layout question rather than a pixel one. The
verdict is `clearance.mjs`, which has its own unit tests and mutation entries. `verify.mjs`
only supplies the rects.

- **Toast rail:** it must start at or below the topbar's rendered bottom edge.
- **Shell-capacity flash:** its text is staged at the roster cap, `shells 5/5`, and held
  visible. It must not overlap a topbar chip or the drawn board, and must stay inside the
  safe area. The chips are read before and after it shows and must not move, because a
  flash that takes room in the bar is the permanent counter issue #356 rules out.
- **The board** is read the way the board checks read it, from a screenshot with the HUD
  hidden, then divided by the device pixel ratio. That check exists because of
  issue #702: in landscape the board starts under the bar (top 48 under a 52px bar at
  844x390), so a flash that only cleared the bar was drawn on the arena.

| viewport | inset case | why it is in the matrix |
|---|---|---|
| 320x568, 390x844 | 59px top | the two breakpoints `hud.css` retunes the topbar at; the top inset grows the bar, which is what discriminates the topbar-height half |
| 844x390 | 59px left, 21px right | a phone in landscape, where the board starts under the bar |
| 1280x800@200% | 59px left, 21px right | browser zoom: a 640x400 CSS viewport at DPR 2, landscape |
| 1920x1080-tv | 59px left, 21px right | DPR 2, standing in for a TV |

Each also runs with no inset. Landscape shapes get side insets, because a phone held
sideways reports its notch as a left or right inset. Those do not grow the bar; they check
that the flash's right-hand placement stays clear of the housing. Headless Chromium reports
every `env(safe-area-inset-*)` as 0, so the insets come from DevTools'
`Emulation.setSafeAreaInsetsOverride`. The verdict fails, rather than passes, if the topbar's
padding shows that the override never landed.

It also fails, rather than passes, a match whose topbar never showed, a flash with no box,
and a board the screenshot did not find. It checks the Main Menu too, where the bar is
hidden and the rail has to clear the top inset on its own.

Proved in both directions, against builds of `origin/main` at `86e3fa9` and of this change:

```
before (top: 64px / top: 56px)   exit 1: 5 of 10 clearance cases FAILED -- all 5 with the inset
after  (topbar grid row)         exit 0: 10 of 10 clearance cases pass
```

The no-inset column passed on the old build too. The inset is what makes this discriminate.

The board and chip checks were added by issue #702 and proved the same way, the current
`verify.mjs` against a build of the first placement (`f4aedcf`, flash just under the bar at
every size) and of the bar-row placement:

```
before (flash under the bar)   exit 1: 5 of 10 FAILED -- 844x390 and 1280x800@200% with no inset
                                        too, flash 56-83 and 42-69 over board tops 48 and 49
after  (landscape bar row)     exit 0: 10 of 10 pass -- landscape flash at y 6-40, above boards
                                        starting at 48, 49 and 133
```

One of the 5 before failures (1920x1080-tv with side insets) is the safe-area check alone: the
portrait placement's box spans the full row width, so it reaches under a side inset even where
its centred text does not. No portrait case gets a side inset, so the after build never meets
that shape.

## Menu hit targets (issues #686, #710)

`--check` also sweeps every player-facing menu surface for the 44 CSS px hit-target floor.
The sweep has three parts:

- **Surfaces** — `tools/visual/hit-sweep.mjs` decides these. It takes the screen-state
  catalogue, minus developer panes, the no-script page, the match failure overlay, the played
  endings and the states that declare no menu. It adds the Controllers pane and Settings with
  Reset stats armed. The branded startup failure pages ARE swept: each draws one focused
  Reload button, and the driver applies the catalogue's `webgl` mode to reach them.
- **Viewports** — each surface is read at 320x568, 390x844, 1280x800 and 1280x800 at 200%,
  one fresh context per reading.
- **Driving** — `tools/screens/steps.mjs` runs each state's steps, the same runner
  `npm run screens` uses.

The verdict is `hit-targets.mjs`. A reading fails on any of these:

- a control under 44 px in either dimension, measured ACROSS on the part of it that is on
  screen and DOWN on its whole box (issue #932) — clipping at the screen edge is permanent
  where clipping below the fold is answered by scrolling;
- two controls on the same layer that overlap;
- a control that cannot be scrolled to;
- a container that scrolls sideways (issue #932);
- a page that scrolls horizontally;
- a state that never reached its surface, or one whose sideways reading is missing.

The check prints one summary line, then only the failing lines. The report's `hitTargets`
array holds every reading.

Which surfaces are swept is unit-tested and has mutation entries (`hit-sweep-*`). The in-page
collectors are not executed by any Vitest run — jsdom reports 0 for every layout property they
read — so they COLLECT and do not judge: both exemptions that make the sideways reading usable
live in `hit-targets.mjs`, where a unit test and a mutation entry can reach them. What is left
in `hit-sweep.test.ts` is the wiring, which is what failed before.

**`overflow.page` cannot fire in this layout, and is kept anyway.** It reads
`documentElement.scrollWidth > innerWidth`; everything the app draws is inside a
`position: fixed` app root under `html, body { overflow: hidden }`, and Chromium leaves
fixed-position boxes out of the document's scrollable overflow. Measured across all 128
readings with issue #913's defect restored: 0. The per-container reading beside it is what
answers the question for the layout as it actually is, and `overflow.page` stays because it
becomes the right question again the moment the app root stops being fixed.

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
