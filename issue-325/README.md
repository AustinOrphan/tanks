# Issue #325 — a transient match failure keeps the shell

Both frames are the built page at 1280x800 @2dpr through `tools/screens/run.mjs`, state
`screen.startup.match-failed`: boot succeeds, the menu comes up, and `getContext('webgl2')`
is then made to throw so the next match fails.

| | Frame | What it is |
| --- | --- | --- |
| Before | `before.png` | The page REPLACED. Bare DOM with inline styles, the whole HUD destroyed, recovery is `Reload`. |
| After | `after.png` | The game's own `.hud-alert` overlay on the layer stack, recovery is `Back to menu`. |

Owner ruling, 2026-09-11: **overlay for transient, full page for fatal.** An
`UnsupportedRenderError` — the renderer is absent, so every later match fails identically —
still replaces the page at both boundaries. Everything else keeps the shell.

## What "overlay" does and does not mean here

It means the LAYER STACK, not visual stacking. Like every layer in `hud.ts` — the
replace-run confirmation included — opening this one swaps the surface beneath it out. The
capture measures `.hud-panel` **expecting a 0x0 box**, which is why this state reports 3 of
4 elements visible rather than 4 of 4.

An earlier draft of the copy claimed the menu stayed visible behind the alert. It does not,
and the copy no longer says so: what is true is that the shell is never destroyed and the
recovery is one press rather than a page reload.

## The ordering bug this exposed

`classifyStartupFailure` checked the CALL SITE before the CAUSE, so `at === 'match'`
short-circuited: a browser with no WebGL 2 that reached a menu click was told "that match
could not start" and handed back a Main Menu whose every Start would fail the same way.
Cause is now checked first.
