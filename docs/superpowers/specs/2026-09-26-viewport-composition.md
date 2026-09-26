---
status: active
date: 2026-09-26
last-reviewed: 2026-09-26
scope: What the HUD's composition actually is at each viewport in issue #290's emulated matrix
implementation-issues: [985]
implementation-prs: []
supersedes: []
superseded-by: []
---

# Viewport composition: what each surface does at each size

Issue #985's first acceptance criterion asks that *"every matrix viewport has a documented
composition, **not just a screenshot of the desktop layout at a smaller scale**"*. The emphasis is
the criterion's, and it names the failure it is guarding against. A screenshot at each size does not
answer it; what answers it is a record of what **changes** between sizes and what does not.

This is that record, measured rather than described.

## How these numbers were taken

On the built bundle, at each of the nine viewports issue #290 names, opening each surface the way a
player reaches it. For each pane: its box, whether it scrolls (`scrollHeight` against
`clientHeight`), how many of its flex rows are set to wrap and how many of those have actually
broken onto more than one line, and how many controls are visible inside it.

"Wrapped" counts a wrapping row whose visible children occupy more than one distinct top offset —
so it measures the layout as rendered, not as authored.

## The short version

**The interface responds to size in exactly two ways, and mostly only at the small end: rows wrap,
and panes scroll.** Nothing re-composes. Type size, control size and section count are the same on a
320 px phone as on a 2560 px desktop.

There is no `min-width` media query in `hud.css` at all — 0 of them against 5 `max-width` — so there
is no mechanism by which a large screen could be given a different arrangement. A large display gets
the same layout with more empty space around it.

## Main menu

| viewport | pane | scrolls | wrapping rows | wrapped | controls |
| --- | --- | --- | --- | --- | --- |
| 320×568 | 320×568 | no | 1 | **1** | 6 |
| 390×844 | 390×844 | no | 1 | 0 | 6 |
| 844×390 | 844×390 | no | 1 | 0 | 6 |
| 768×1024 | 768×1024 | no | 1 | 0 | 6 |
| 1280×720 | 1280×720 | no | 1 | 0 | 6 |
| 1280×800 | 1280×800 | no | 1 | 0 | 6 |
| 1920×1080 | 1920×1080 | no | 1 | 0 | 6 |
| 2560×1440 | 2560×1440 | no | 1 | 0 | 6 |
| 1280×800 @200% | 640×400 | no | 1 | 0 | 6 |

The menu never scrolls and always holds six controls. **One cell in this table differs from the
other eight**: the utilities row breaks onto a second line at 320 px.

Measured separately and constant across all nine: `--hud-menu-col` 86px, the display title 56px, the
primary button 202×51, a slab button 86×44 — the slab sitting exactly on the `--hud-control-min`
44px floor.

## Settings

| viewport | scrolls | content h | visible h | wrapped rows | controls |
| --- | --- | --- | --- | --- | --- |
| 320×568 | **YES** | 846 | 568 | **2** | 12 |
| 390×844 | no | 844 | 844 | **1** | 12 |
| 844×390 | **YES** | 684 | 390 | 0 | 12 |
| 768×1024 | no | 1024 | 1024 | 0 | 12 |
| 1280×720 | no | 720 | 720 | 0 | 12 |
| 1280×800 | no | 800 | 800 | 0 | 12 |
| 1920×1080 | no | 1080 | 1080 | 0 | 12 |
| 2560×1440 | no | 1440 | 1440 | 0 | 12 |
| 1280×800 @200% | **YES** | 684 | 400 | 0 | 12 |

Five sections, four wrapping rows and twelve controls at every size. It scrolls at the three
viewports under about 600 px tall, and wraps at the two narrowest.

## Customize

| viewport | scrolls | content h | visible h | wrapped rows | controls |
| --- | --- | --- | --- | --- | --- |
| 320×568 | **YES** | 739 | 568 | **2** | 24 |
| 390×844 | no | 844 | 844 | **1** | 24 |
| 844×390 | **YES** | 575 | 390 | 0 | 24 |
| 768×1024 | no | 1024 | 1024 | 0 | 24 |
| 1280×720 | no | 720 | 720 | 0 | 24 |
| 1280×800 | no | 800 | 800 | 0 | 24 |
| 1920×1080 | no | 1080 | 1080 | 0 | 24 |
| 2560×1440 | no | 1440 | 1440 | 0 | 24 |
| 1280×800 @200% | **YES** | 629 | 400 | **1** | 24 |

The same shape as Settings with twice the controls. Note the 200% zoom column wraps a row where
844×390 does not, despite both being short — zoom narrows as well as shortens.

## Records

| viewport | scrolls | content h | visible h | wrapped rows | controls |
| --- | --- | --- | --- | --- | --- |
| 320×568 | **YES** | 636 | 568 | 0 | 3 |
| 390×844 | no | 844 | 844 | 0 | 3 |
| 844×390 | **YES** | 596 | 390 | 0 | 3 |
| 768×1024 | no | 1024 | 1024 | 0 | 3 |
| 1280×720 | no | 720 | 720 | 0 | 3 |
| 1280×800 | no | 800 | 800 | 0 | 3 |
| 1920×1080 | no | 1080 | 1080 | 0 | 3 |
| 2560×1440 | no | 1440 | 1440 | 0 | 3 |
| 1280×800 @200% | **YES** | 596 | 400 | 0 | 3 |

**No wrapping row anywhere**, at any size. Records is a table and a tab strip; it scrolls or it does
not, and nothing rearranges.

## About

| viewport | scrolls | content h | visible h | wrapped rows | controls |
| --- | --- | --- | --- | --- | --- |
| 320×568 | **YES** | 1210 | 568 | **1** | 8 |
| 390×844 | **YES** | 1041 | 844 | 0 | 8 |
| 844×390 | **YES** | 930 | 390 | 0 | 8 |
| 768×1024 | no | 1024 | 1024 | 0 | 8 |
| 1280×720 | **YES** | 930 | 720 | 0 | 8 |
| 1280×800 | **YES** | 930 | 800 | 0 | 8 |
| 1920×1080 | no | 1080 | 1080 | 0 | 8 |
| 2560×1440 | no | 1440 | 1440 | 0 | 8 |
| 1280×800 @200% | **YES** | 930 | 400 | 0 | 8 |

**About scrolls on an ordinary 1280×800 desktop** — 930 px of legal text into 800. Six of the nine
viewports scroll it; only the tablet and the two largest displays fit it whole. This is the surface
whose Back control sits furthest below the fold, measured separately at 632 px down at 320×568.

## Versus Setup

| viewport | scrolls | content h | visible h | wrapped rows | controls |
| --- | --- | --- | --- | --- | --- |
| 320×568 | **YES** | 1848 | 568 | 1 | 28 |
| 390×844 | **YES** | 1708 | 844 | 1 | 28 |
| 844×390 | **YES** | 1455 | 390 | 1 | 28 |
| 768×1024 | **YES** | 1455 | 1024 | 1 | 28 |
| 1280×720 | **YES** | 1455 | 720 | 1 | 28 |
| 1280×800 | **YES** | 1455 | 800 | 1 | 28 |
| 1920×1080 | **YES** | 1455 | 1080 | 1 | 28 |
| 2560×1440 | **YES** | 1455 | 1440 | 1 | 28 |
| 1280×800 @200% | **YES** | 1430 | 400 | 1 | 28 |

**Versus Setup scrolls at every viewport in the matrix, including the largest.** At 2560×1440 it
needs 1,455 px against 1,440 available — it misses fitting by 15 px. It carries 28 controls, more
than any other surface, and its content height is flat at 1,455 from 844×390 upward, so the
overflow above 1,440 is structural rather than a wrapping effect.

## What this says about criterion 1

Wrapping and scrolling are real responses to size, so this is more than the desktop layout shrunk.
But the composition itself does not vary: the same sections, the same control counts, the same type
and control sizes everywhere. The differences between a phone and a 2560 px desktop are which rows
have broken and which panes have a scrollbar.

Whether that meets the criterion is a product judgement and this document does not make it. What the
document supplies is the thing the criterion asked for — the composition, per viewport, in numbers
that can be re-measured.

Two things fall out of it that look like findings rather than description, and both are recorded on
issue #985 rather than resolved here:

- **Versus Setup never fits**, at any supported size.
- **About scrolls on a normal desktop**, and its Back control is the one furthest below the fold.
