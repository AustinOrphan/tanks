# Issue #274 — a dropped map choice is replaced and named

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
