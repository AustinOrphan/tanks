# Issue #249 — production-save access and the developer-data reset

Every frame is the **built** page at 900x1000 @2dpr through `tools/screens/run.mjs`.

## The two controls, and the namespace line above them

| | Frame | State |
| --- | --- | --- |
| Before | `devtools-before.png` | `screen.devtools` on `origin/main` |
| After | `devtools-after.png` | `screen.devtools` |

Measured from the two capture reports, same viewport and same state:

| Element | Before | After |
| --- | --- | --- |
| `#hud-devtools-title` | y = 35 | y = 35 |
| `.hud-selftest-open` | y = 258 | y = 258 |
| `.hud-diag-copy` | y = 301 | y = 301 |
| `.hud-diag-pin` | y = 344 | y = 344 |
| `.hud-devtools-back` | y = 430 | y = 564 |

Nothing above the new block moves. Back drops by 134: a namespace line plus two rows.

## The warning, which is the criterion

`production-save-warning.png` is a new `screen.devtools.production-save` state, reached with
`?dev=1&prodSave=1` — the only way to reach it, since the flag is inert without the gate.

| | Namespace line |
| --- | --- |
| developer keys (`devtools-after.png`) | quiet, 0.9 opacity: *"Saving to the developer keys (tanks.dev.). The real save is untouched."* |
| production keys (`production-save-warning.png`) | `--hud-text-danger`, bold: *"Saving to the PRODUCTION keys. Changes here affect the real save."* |

Issue #249's fourth criterion is that namespace status "remains obvious while production data
is active in a dev session". A line that read the same either way would satisfy *states the
namespace* and none of what it is for — so the treatment differs, not only the words, and it
differs by weight as well as colour (issue #327's non-colour rule).

**`Use Production Save` is absent from the production frame**, and that is the behaviour: the
button reloads onto the production keys, and offering it on a session already there would be a
control that reloads onto where it is. `Reset Developer Data` stays, because the developer keys
still exist and are still resettable from a `prodSave` session — which is exactly why the reset
always targets the developer namespace rather than "this session's".
