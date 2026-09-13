# Issue #642 — the last two panes that centred their own scroll axis

`justify-content: center` on an `overflow-y: auto` flex column puts the overflow **above**
the scrollable area, where no scrollbar reaches it. `.hud-about` came off that shape under
#117 and `.hud-versus-setup` under #274; `.hud-settings` and `.hud-devtools` were the two
left, and are what this change fixes.

Every frame is the **built** page at `dpr 2`, captured through `tools/screens/run.mjs` with
`reducedMotion: 'reduce'` and `colorScheme: 'dark'`. Before and after are the same state and
the same viewport, one rebuild apart.

## The clip, at a viewport where each pane overflows

| Pane | Viewport | Before | After |
| --- | --- | --- | --- |
| Settings | 844x390 | `settings-before-844x390.png` | `settings-after-844x390.png` |
| Developer Tools | 568x280 | `devtools-before-568x280.png` | `devtools-after-568x280.png` |

The number is the y of each pane's first child — its `<h1>` — read from the capture report:

| Pane | Before | After |
| --- | --- | --- |
| `#hud-settings-title` at 844x390 | **y = -64** | y = +35 |
| `#hud-devtools-title` at 568x280 | **y = -19** | y = +35 |

A negative y is the whole heading box sitting above the scroll origin. In
`settings-before-844x390.png` the pane simply opens on **AUDIO**; the word "Settings" is not
on the screen and no scroll gesture brings it back. In `devtools-before-568x280.png` the
"Developer Tools" heading is cut through its middle by the top edge.

844x390 is a handset in landscape — an ordinary viewport, not a contrived one. **568x280 is
not**: Developer Tools' content is only 318 CSS px tall, so no current handset clips it and
the defect there is latent rather than reachable. It is fixed at the latent stage on purpose:
that pane is the one the developer shell grows registry-generated controls into, and About
shipped this defect for as long as it did precisely because nobody re-measured a pane that
grew.

## What changes on a viewport where neither pane overflows

| Pane | Viewport | Before | After |
| --- | --- | --- | --- |
| Settings | 1280x800 | `settings-before-1280x800.png` | `settings-after-1280x800.png` |
| Developer Tools | 1280x800 | `devtools-before-1280x800.png` | `devtools-after-1280x800.png` |

This is a real, visible change and not a no-op: both panes move from vertically centred to
top-aligned, which on a 1280x800 desktop leaves empty space below them.

| Element at 1280x800 | Before | After |
| --- | --- | --- |
| `#hud-settings-title` | y = 141 | y = 35 |
| `.hud-reset-progress` | y = 546 | y = 440 |
| `#hud-devtools-title` | y = 241 | y = 35 |
| `.hud-devtools-back` | y = 549 | y = 344 |

`about-precedent-1280x800.png` is why that is the accepted shape rather than a regression:
`.hud-about` has been `flex-start` since #117 and already renders exactly this way on the
same viewport — content at the top, empty space below, `.hud-about-line` measured at y = 113.
`.hud-selftest` (#599) and `.hud-devcfg` (#246) were both written `flex-start` from the
start. The two panes here are joining four siblings, not departing from them.

Settings also gains `padding: var(--hud-space-5)` in the same change, which is why its
heading lands at +35 rather than at 0: centring gave the pane its inset for free, and
top-aligned without padding the heading butts the viewport edge. `--hud-space-5` is the inset
`.hud-about`, `.hud-devtools` and `.hud-selftest` already use. Both lines moved between the
two captures, so neither number above attributes to one of them alone.
