# Issue #274 — the versus map row

Two changes have landed under this issue. The map cards are below; the dropped-choice
notice that came first is at the bottom of this file.

## The map cards

Every frame is the **built** page at 1280x800 @2dpr, captured through `tools/screens/run.mjs`.

| | Frame | State |
| --- | --- | --- |
| Before | `before-map-row.png` | `screen.versus-setup` on this PR's base branch |
| After | `after-map-row.png` | `screen.versus-setup` |
| After, a board chosen | `after-selected.png` | `screen.versus-setup.selected`, added here |
| After, 3 players and Teams | `after-teams-3p.png` | `screen.versus-setup.teams` |

Before: one pill per board, each a display name and nothing else. After: a card per board
carrying a schematic of its actual grid, the counts and modes it supports, and the catalog's
own one-sentence intent — with Random last, saying how many boards it will draw from.

The preview is drawn from `arenas.json` at runtime into a `<canvas>`; **no preview asset
ships**, which is how #274's "relative-base Pages paths resolve every preview asset"
criterion is met. Solid cover is grey and merged into runs, breakable cover is gold and one
box per cell, which is `loadArena`'s own distinction.

`after-teams-3p.png` is the filter working and visible: Pinwheel (two-only) is gone and
Keystone (three) is in its place, and Random's line still reads 6.

**The pane grew.** `.hud-versus-start` sits at y = 1240 where it sat at y = 793 before the
cards, measured in the capture reports at 1280x800. The pane already overflowed an 800px
viewport; it now takes about a screen and a half. The same change also fixed
`.hud-versus-setup`'s `justify-content: center`, without which the seven cards pushed the
Mode and Players rows **above** the scroll origin, unreachable (issue #642's mechanism).

## The dropped-choice notice (earlier work under the same issue)


Captured from `npm run screens -- --state screen.versus-setup.map-replaced`, the catalogue
state added alongside the fix. Built page at 1280x800 @2dpr, driven through: open Versus
Setup, choose **Pinwheel**, click **3** players.

- `map-replaced-note.png` — the Map row and the notice.
- `map-replaced.png` — the full pane.

Pinwheel (`vs-duel-01`) is offered at two players and nowhere else (#271). Before the fix the
pane rebuilt the row without it, kept carrying it in `versusConfigState`, and `Start` threw
`map 'vs-duel-01' does not support N=3 mode=ffa` out of its own click handler with nothing
catching it — so the button appeared to do nothing at all. There is no "before" frame for
that state, because nothing was drawn: the defect was the absence of this notice.

Pinwheel rather than Keystone in the recipe is deliberate. Its two-player restriction is
structural — a dedicated duel board — whereas Keystone's was a curation ruling that #627 has
already reversed once. A capture anchored to a ruling goes stale the next time one moves.
