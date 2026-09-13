# Issue #247 — the developer diagnostics summary

Every frame is the **built** page at 900x900 @2dpr, captured through `tools/screens/run.mjs`
with `reducedMotion: 'reduce'` and `colorScheme: 'dark'`.

## The two new controls

| | Frame |
| --- | --- |
| Before (`origin/main`) | `devtools-before.png` |
| After | `devtools-after.png` |

`screen.devtools`, whose `measure` list gained both new selectors **before** the before-frame
was taken, so nothing moved between the two captures except the change itself:

| Element | Before | After |
| --- | --- | --- |
| `#hud-devtools-title` | y = 35 | y = 35 |
| `.hud-selftest-open` | y = 258 | y = 258 |
| `.hud-diag-copy` | absent | y = 301 |
| `.hud-diag-pin` | absent | y = 344 |
| `.hud-devtools-back` | y = 344 | y = 430 |

Two rows added at the shell's own 43px pitch, and Back moves down by exactly twice that
(+86). Nothing above the new controls moves. The pane is top-aligned and scrolls (issue
#642), so a longer pane cannot clip its own first screenful.

## The report, in the field

`report-copied.png` is the new `screen.devtools.diagnostics` state: the same pane after a
`click: '.hud-diag-copy'` step, so the picture is of the feature working rather than of two
buttons sitting there.

Taken **from the main menu**, deliberately. That is the no-session report — and it is the only
one that can be photographed deterministically, because a running world's seed is derived from
the wall clock and would differ on every capture. What it shows:

```
## Tanks! session diagnostics

- URL: /?dev=1
- Build: unknown (not a deployed build)
- Developer mode: on
- Session: none simulating (no seed to report)

### In effect without being requested
```

Four things worth reading off it:

- **`Build: unknown (not a deployed build)`** is the honest-build criterion, visible. A local
  `npm run build` has no commit to name, and the report says so in words rather than printing
  an empty field. The deployed build passes its commit through `VITE_BUILD_SHA`, which is a
  `pages.yml` change and is unverified until the first deploy.
- **`Session: none simulating`** rather than a seed of zero. The pane is usually opened from
  the menu, and a zero would read as a real seed.
- **`### In effect without being requested`** is the second half of the requested/effective
  split. `sandboxDisarmed` defaults ON, so it appears on every developer session with no
  request behind it — filing it under "Requested, but not in effect" would have claimed a
  request that was never made, on every report this pane can produce.
- **The field opens on its FIRST line.** An earlier capture caught it scrolled to the middle
  — `select()` leaves a textarea at the end of the selection, so the heading and the URL sat
  above the fold. Found in this picture, not in a test: jsdom lays nothing out, so `scrollTop`
  is 0 there whether or not the fix exists and an assertion on it could not fail.

The blue is the selection. Selecting is the copy path that works where the async Clipboard API
does not — it is origin- and permission-gated and absent on a `file://` page — and the
self-test's Copy Report already relies on the same behaviour.
